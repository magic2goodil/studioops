import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCreditAdmission,
  CREDIT_FALLBACK_POLICY_VERSION,
  DEFAULT_DEGRADED_TELEMETRY_FALLBACK,
  normalizeCreditPolicy,
  normalizeCreditSnapshot,
} from "../src/credit-policy.js";

function availableSnapshot(overrides = {}) {
  return {
    status: "available",
    source: "codex-app-server",
    observedAt: "2026-08-16T12:00:00.000Z",
    usedPercent: 25,
    remainingPercent: 75,
    reached: false,
    credits: {
      available: false,
      unlimited: false,
      balance: null,
    },
    ...overrides,
  };
}

const creditPolicy = {
  enabled: true,
  reserveCredits: 5,
  failClosedTiers: ["critical", "frontier"],
  tierBudgets: {
    economy: { estimatedCredits: 8, minRemainingPercent: 5 },
    critical: { estimatedCredits: 30, minRemainingPercent: 20 },
    frontier: { estimatedCredits: 40, minRemainingPercent: 35 },
  },
};

const evaluation = { evaluatedAt: "2026-08-16T12:05:00.000Z" };

test("Codex rate-limit responses are reduced to a sanitized admission snapshot", () => {
  const snapshot = normalizeCreditSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 22,
          windowDurationMins: 10080,
          resetsAt: 1785850510,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "85.5",
        },
        rateLimitReachedType: null,
      },
    },
  }, { observedAt: "2026-07-28T12:00:00.000Z" });

  assert.deepEqual(snapshot, {
    status: "available",
    source: "codex-app-server",
    observedAt: "2026-07-28T12:00:00.000Z",
    bucketId: "codex",
    usedPercent: 22,
    remainingPercent: 78,
    resetsAt: 1785850510,
    reached: false,
    reachedType: "",
    credits: {
      available: true,
      unlimited: false,
      balance: 85.5,
    },
  });
  assert.equal(JSON.stringify(snapshot).includes("email"), false);
});

test("legacy fail-closed tiers normalize while ordinary degraded work is bounded", () => {
  const unknown = {
    status: "unknown",
    source: "sanitized-test-probe",
    observedAt: "2026-08-16T12:04:00.000Z",
    reason: "Account service unavailable.",
  };
  const economy = assessCreditAdmission(
    unknown,
    { modelTier: "economy", model: "gpt-5.6-luna" },
    creditPolicy,
    evaluation,
  );
  const critical = assessCreditAdmission(
    unknown,
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
    evaluation,
  );

  assert.equal(economy.allowed, true);
  assert.equal(economy.code, "credit_snapshot_unknown_bounded");
  assert.equal(economy.mode, "bounded");
  assert.equal(economy.ruleId, "economy-bounded-v1");
  assert.equal(economy.maxConcurrentRuns, 2);
  assert.equal(economy.maxAttempts, 1);
  assert.equal(economy.estimatedTokensPerRun, 80_000);
  assert.equal(economy.maxInFlightEstimatedTokens, 160_000);
  assert.equal(economy.snapshotAgeMs, 60_000);
  assert.equal(critical.allowed, false);
  assert.equal(critical.code, "credit_snapshot_unknown");
  assert.equal(critical.ruleId, "legacy-critical-fail-closed-v1");
});

test("the canonical defaults fail frontier closed and bound ordinary critical work", () => {
  const policy = normalizeCreditPolicy({ enabled: true });
  const unknown = {
    status: "unknown",
    source: "codex-app-server",
    observedAt: "2026-08-16T12:00:00.000Z",
    reason: "No current snapshot.",
  };
  const critical = assessCreditAdmission(
    unknown,
    { modelTier: "critical", model: "model-names-are-not-policy" },
    policy,
    evaluation,
  );
  const frontier = assessCreditAdmission(
    unknown,
    { modelTier: "frontier", model: "any-other-model" },
    policy,
    evaluation,
  );

  assert.equal(policy.degradedTelemetryFallback.policyVersion, CREDIT_FALLBACK_POLICY_VERSION);
  assert.deepEqual(
    policy.degradedTelemetryFallback,
    DEFAULT_DEGRADED_TELEMETRY_FALLBACK,
  );
  assert.equal(critical.allowed, true);
  assert.equal(critical.mode, "bounded");
  assert.equal(critical.maxConcurrentRuns, 1);
  assert.equal(critical.maxAttempts, 1);
  assert.equal(critical.estimatedTokensPerRun, 120_000);
  assert.equal(critical.maxInFlightEstimatedTokens, 120_000);
  assert.equal(frontier.allowed, false);
  assert.equal(frontier.mode, "fail_closed");
  assert.equal(frontier.code, "credit_snapshot_unknown");
});

test("explicit configured labels fail closed without consulting a model ID", () => {
  const policy = {
    enabled: true,
    degradedTelemetryFallback: {
      ...DEFAULT_DEGRADED_TELEMETRY_FALLBACK,
      explicitFailClosedLabels: ["expensive-customer-work"],
    },
  };
  const admission = assessCreditAdmission(
    { status: "unknown", source: "probe", reason: "offline" },
    {
      modelTier: "economy",
      model: "arbitrary-model-id",
      labels: ["EXPENSIVE-CUSTOMER-WORK"],
    },
    policy,
    evaluation,
  );

  assert.equal(admission.allowed, false);
  assert.equal(admission.explicitFailClosedMatch, true);
  assert.equal(admission.reasonCode, "explicit_fail_closed_label");
  assert.equal(admission.mode, "fail_closed");
});

test("malformed, missing, unsupported, and unclassified fallback rules fail closed", () => {
  const cases = [
    {
      name: "unsupported version",
      tier: "critical",
      fallback: { policyVersion: 2, rules: DEFAULT_DEGRADED_TELEMETRY_FALLBACK.rules },
      code: "unsupported_fallback_policy_version",
    },
    {
      name: "missing rule",
      tier: "critical",
      fallback: { policyVersion: 1, rules: {} },
      code: "missing_fallback_rule",
    },
    {
      name: "zero limit",
      tier: "critical",
      fallback: {
        policyVersion: 1,
        rules: {
          critical: {
            ruleId: "bad-zero",
            mode: "bounded",
            maxConcurrentRuns: 0,
            maxAttempts: 1,
            estimatedTokensPerRun: 1,
            maxInFlightEstimatedTokens: 1,
          },
        },
      },
      code: "invalid_fallback_rule_limits",
    },
    {
      name: "unbounded limit",
      tier: "critical",
      fallback: {
        policyVersion: 1,
        rules: {
          critical: {
            ruleId: "bad-infinity",
            mode: "bounded",
            maxConcurrentRuns: 1,
            maxAttempts: 1,
            estimatedTokensPerRun: 1,
            maxInFlightEstimatedTokens: Infinity,
          },
        },
      },
      code: "invalid_fallback_rule_limits",
    },
    {
      name: "unclassified tier",
      tier: "experimental",
      fallback: DEFAULT_DEGRADED_TELEMETRY_FALLBACK,
      code: "unclassified_credit_risk_tier",
    },
  ];

  for (const item of cases) {
    const admission = assessCreditAdmission(
      { status: "unknown", reason: "No snapshot." },
      { modelTier: item.tier },
      { enabled: true, degradedTelemetryFallback: item.fallback },
      evaluation,
    );
    assert.equal(admission.allowed, false, item.name);
    assert.equal(admission.code, item.code, item.name);
    assert.equal(admission.mode, "fail_closed", item.name);
  }
});

test("snapshot classification and evidence are deterministic, distinct, and sanitized", () => {
  const policy = normalizeCreditPolicy({ enabled: true, snapshotMaxAgeMs: 60_000 });
  const execution = {
    modelTier: "critical",
    model: "must-not-be-copied",
    accountIdentity: "private@example.com",
    token: "secret-token",
  };
  const stale = assessCreditAdmission(
    availableSnapshot({
      observedAt: "2026-08-16T12:03:00.000Z",
      reason: "token=secret-token for private@example.com",
      privateProviderPayload: { token: "raw-secret" },
    }),
    execution,
    policy,
    evaluation,
  );
  const recovered = assessCreditAdmission(
    availableSnapshot({ recovered: true, observedAt: "2026-08-16T12:04:30.000Z" }),
    execution,
    policy,
    evaluation,
  );
  const disabled = assessCreditAdmission(
    availableSnapshot(),
    execution,
    { ...policy, enabled: false },
    evaluation,
  );

  assert.equal(stale.snapshotStatus, "stale");
  assert.equal(stale.snapshotAgeMs, 120_000);
  assert.equal(stale.code, "credit_snapshot_stale_bounded");
  assert.equal(recovered.snapshotStatus, "recovered");
  assert.equal(recovered.fallbackUsed, false);
  assert.equal(recovered.code, "included_quota_available");
  assert.equal(disabled.snapshotStatus, "disabled");
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.code, "disabled");
  assert.equal(stale.evaluatedAt, evaluation.evaluatedAt);
  assert.equal(stale.snapshotReason, "token=[redacted] for [redacted-email]");
  const evidence = JSON.stringify(stale);
  assert.doesNotMatch(evidence, /must-not-be-copied|private@example\.com|secret-token|raw-secret/);
});

test("evaluation time is also accepted on the policy adapter input for compatibility", () => {
  const admission = assessCreditAdmission(
    availableSnapshot({ observedAt: "2026-08-16T12:04:00.000Z" }),
    { modelTier: "economy" },
    { enabled: true, nowMs: Date.parse(evaluation.evaluatedAt) },
  );

  assert.equal(admission.evaluatedAt, evaluation.evaluatedAt);
  assert.equal(admission.snapshotAgeMs, 60_000);
  assert.equal(admission.snapshotStatus, "available");
});

test("quota and purchased-credit reserves gate a tier without downgrading it", () => {
  const lowQuota = assessCreditAdmission(
    availableSnapshot({ remainingPercent: 12 }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
    evaluation,
  );
  const lowBalance = assessCreditAdmission(
    availableSnapshot({
      credits: { available: true, unlimited: false, balance: 20 },
    }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
    evaluation,
  );
  const enough = assessCreditAdmission(
    availableSnapshot({
      credits: { available: true, unlimited: false, balance: 100 },
    }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
    evaluation,
  );

  assert.equal(lowQuota.allowed, false);
  assert.equal(lowQuota.code, "insufficient_quota_headroom");
  assert.equal(lowQuota.tier, "critical");
  assert.equal(lowBalance.allowed, false);
  assert.equal(lowBalance.code, "insufficient_credit_balance");
  assert.equal(lowBalance.requiredCredits, 35);
  assert.equal(enough.allowed, true);
  assert.equal(enough.code, "credit_headroom_available");
});

test("a reached rate limit blocks all metered tiers while unlimited access remains available", () => {
  const reached = assessCreditAdmission(
    availableSnapshot({ reached: true, reachedType: "usage_limit" }),
    { modelTier: "economy", model: "gpt-5.6-luna" },
    creditPolicy,
    evaluation,
  );
  const unlimited = assessCreditAdmission(
    availableSnapshot({
      reached: false,
      credits: { available: false, unlimited: true, balance: null },
    }),
    { modelTier: "frontier", model: "gpt-5.6-sol" },
    creditPolicy,
    evaluation,
  );

  assert.equal(reached.allowed, false);
  assert.equal(reached.code, "rate_limit_reached");
  assert.equal(unlimited.allowed, true);
  assert.equal(unlimited.code, "unlimited");
});
