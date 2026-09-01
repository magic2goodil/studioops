import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import readline from "node:readline";

const DEFAULT_CODEX_BINS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export const CREDIT_FALLBACK_POLICY_VERSION = 1;
export const CREDIT_RISK_TIERS = Object.freeze([
  "mechanical",
  "economy",
  "balanced",
  "critical",
  "frontier",
]);

const CREDIT_SNAPSHOT_SOURCES = new Set(["codex-app-server", "studioops"]);
const CREDIT_BUCKET_IDS = new Set(["codex"]);
const FALLBACK_RULE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_FALLBACK_RULE_ID_LENGTH = 100;

export const DEFAULT_DEGRADED_TELEMETRY_FALLBACK = Object.freeze({
  policyVersion: CREDIT_FALLBACK_POLICY_VERSION,
  explicitFailClosedLabels: ["credit-fail-closed"],
  rules: Object.freeze({
    mechanical: Object.freeze({
      ruleId: "mechanical-bounded-v1",
      mode: "bounded",
      maxConcurrentRuns: 2,
      maxAttempts: 1,
      estimatedTokensPerRun: 40_000,
      maxInFlightEstimatedTokens: 80_000,
    }),
    economy: Object.freeze({
      ruleId: "economy-bounded-v1",
      mode: "bounded",
      maxConcurrentRuns: 2,
      maxAttempts: 1,
      estimatedTokensPerRun: 80_000,
      maxInFlightEstimatedTokens: 160_000,
    }),
    balanced: Object.freeze({
      ruleId: "balanced-bounded-v1",
      mode: "bounded",
      maxConcurrentRuns: 1,
      maxAttempts: 1,
      estimatedTokensPerRun: 100_000,
      maxInFlightEstimatedTokens: 100_000,
    }),
    critical: Object.freeze({
      ruleId: "critical-bounded-v1",
      mode: "bounded",
      maxConcurrentRuns: 1,
      maxAttempts: 1,
      estimatedTokensPerRun: 120_000,
      maxInFlightEstimatedTokens: 120_000,
    }),
    frontier: Object.freeze({
      ruleId: "frontier-fail-closed-v1",
      mode: "fail_closed",
    }),
  }),
});

export const DEFAULT_CREDIT_POLICY = Object.freeze({
  enabled: false,
  refreshIntervalMs: 5 * 60 * 1000,
  snapshotMaxAgeMs: 15 * 60 * 1000,
  probeTimeoutMs: 20 * 1000,
  reserveCredits: 5,
  // Deprecated compatibility input. Canonical fallback policy lives in
  // degradedTelemetryFallback and defaults ordinary critical work to bounded.
  failClosedTiers: ["frontier"],
  tierBudgets: {
    mechanical: { estimatedCredits: 2, minRemainingPercent: 2 },
    economy: { estimatedCredits: 8, minRemainingPercent: 5 },
    balanced: { estimatedCredits: 15, minRemainingPercent: 5 },
    critical: { estimatedCredits: 30, minRemainingPercent: 5 },
    frontier: { estimatedCredits: 40, minRemainingPercent: 35 },
  },
  degradedTelemetryFallback: DEFAULT_DEGRADED_TELEMETRY_FALLBACK,
});

let cachedSnapshot = null;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [...fallback];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function cloneFallbackRule(rule = {}) {
  return {
    ruleId: String(rule.ruleId || "").trim(),
    mode: String(rule.mode || "").trim().toLowerCase(),
    ...(Object.prototype.hasOwnProperty.call(rule, "maxConcurrentRuns")
      ? { maxConcurrentRuns: Number(rule.maxConcurrentRuns) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rule, "maxAttempts")
      ? { maxAttempts: Number(rule.maxAttempts) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rule, "estimatedTokensPerRun")
      ? { estimatedTokensPerRun: Number(rule.estimatedTokensPerRun) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rule, "maxInFlightEstimatedTokens")
      ? { maxInFlightEstimatedTokens: Number(rule.maxInFlightEstimatedTokens) }
      : {}),
  };
}

function defaultFallbackRules() {
  return Object.fromEntries(CREDIT_RISK_TIERS.map((tier) => [
    tier,
    cloneFallbackRule(DEFAULT_DEGRADED_TELEMETRY_FALLBACK.rules[tier]),
  ]));
}

function normalizeFallbackContract(input = {}) {
  const hasCanonical = input?.degradedTelemetryFallback !== undefined;
  if (hasCanonical) {
    const configured = input.degradedTelemetryFallback;
    const rules = configured && typeof configured === "object" && configured.rules
      && typeof configured.rules === "object"
      ? Object.fromEntries(Object.entries(configured.rules).map(([tier, rule]) => [
          String(tier).trim().toLowerCase(),
          rule && typeof rule === "object" ? cloneFallbackRule(rule) : {},
        ]))
      : {};
    return {
      policyVersion: Number(configured?.policyVersion),
      explicitFailClosedLabels: normalizedList(configured?.explicitFailClosedLabels)
        .map((label) => label.toLowerCase()),
      rules,
    };
  }

  const rules = defaultFallbackRules();
  if (Object.prototype.hasOwnProperty.call(input || {}, "failClosedTiers")) {
    const legacyFailClosedTiers = normalizedList(input.failClosedTiers)
      .map((tier) => tier.toLowerCase());
    for (const tier of legacyFailClosedTiers) {
      if (!CREDIT_RISK_TIERS.includes(tier)) continue;
      rules[tier] = {
        ruleId: `legacy-${tier}-fail-closed-v1`,
        mode: "fail_closed",
      };
    }
  }
  return {
    policyVersion: CREDIT_FALLBACK_POLICY_VERSION,
    explicitFailClosedLabels: [...DEFAULT_DEGRADED_TELEMETRY_FALLBACK.explicitFailClosedLabels],
    rules,
  };
}

export function normalizeCreditPolicy(input = {}) {
  const policy = {
    ...DEFAULT_CREDIT_POLICY,
    ...(input || {}),
  };
  return {
    ...policy,
    failClosedTiers: normalizedList(policy.failClosedTiers, DEFAULT_CREDIT_POLICY.failClosedTiers),
    tierBudgets: {
      ...DEFAULT_CREDIT_POLICY.tierBudgets,
      ...(policy.tierBudgets || {}),
    },
    degradedTelemetryFallback: normalizeFallbackContract(input),
  };
}

function mergedCreditPolicy(input = {}) {
  return normalizeCreditPolicy(input);
}

function resolveCodexBin(input = {}) {
  const explicit = String(
    input.codexBin
    || process.env.MISSION_CONTROL_CODEX_BIN
    || process.env.CODEX_BIN
    || "",
  ).trim();
  if (explicit) return explicit;
  return DEFAULT_CODEX_BINS.find((candidate) => existsSync(candidate)) || "codex";
}

function normalizedFallbackRuleId(value) {
  const ruleId = String(value ?? "").trim();
  if (
    !ruleId
    || ruleId.length > MAX_FALLBACK_RULE_ID_LENGTH
    || !FALLBACK_RULE_ID_PATTERN.test(ruleId)
  ) return "";
  return ruleId;
}

function sanitizedSnapshotSource(value) {
  const source = String(value ?? "").trim().toLowerCase();
  return CREDIT_SNAPSHOT_SOURCES.has(source) ? source : "unclassified";
}

function sanitizedBucketId(value) {
  const bucketId = String(value ?? "").trim().toLowerCase();
  return CREDIT_BUCKET_IDS.has(bucketId) ? bucketId : "unclassified";
}

export function normalizeCreditSnapshot(result, input = {}) {
  const observedAt = input.observedAt || new Date().toISOString();
  const buckets = result?.rateLimitsByLimitId || {};
  const bucket = buckets.codex || result?.rateLimits || Object.values(buckets)[0] || null;
  if (!bucket) {
    return {
      status: "unknown",
      source: "codex-app-server",
      observedAt,
      reason: "Codex did not return a rate-limit bucket.",
    };
  }

  const windows = [bucket.primary, bucket.secondary].filter(Boolean);
  const usedPercents = windows
    .map((window) => finiteNumber(window.usedPercent))
    .filter((value) => value !== null);
  const usedPercent = usedPercents.length ? Math.max(...usedPercents) : null;
  const credits = bucket.credits || null;
  const balance = finiteNumber(credits?.balance);
  const reached = Boolean(bucket.rateLimitReachedType)
    || (usedPercent !== null && usedPercent >= 100);

  return {
    status: "available",
    source: "codex-app-server",
    observedAt,
    bucketId: sanitizedBucketId(bucket.limitId || "codex"),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: Math.max(
      0,
      ...windows.map((window) => Number(window.resetsAt || 0)).filter(Number.isFinite),
    ) || null,
    reached,
    reachedType: bucket.rateLimitReachedType ? "rate_limit_reached" : "",
    credits: {
      available: credits?.hasCredits === true,
      unlimited: credits?.unlimited === true,
      balance: credits?.hasCredits === true ? balance : null,
    },
  };
}

export async function requestCodexCreditSnapshot(input = {}) {
  const codexBin = resolveCodexBin(input);
  const timeoutMs = Math.max(1_000, Number(input.probeTimeoutMs || DEFAULT_CREDIT_POLICY.probeTimeoutMs));

  return new Promise((resolve) => {
    const child = spawn(codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;

    const finish = (snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill("SIGTERM");
      resolve(snapshot);
    };

    const timeout = setTimeout(() => {
      finish({
        status: "unknown",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        reason: `Codex account probe timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stderr.resume();
    child.on("error", () => {
      finish({
        status: "unknown",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        reason: "Codex account probe could not start.",
      });
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish({
          status: "unknown",
          source: "codex-app-server",
          observedAt: new Date().toISOString(),
          reason: `Codex account probe exited before returning limits (${Number.isSafeInteger(code) ? code : "unknown"}).`,
        });
      }
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0 && message.result) {
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 1, params: {} })}\n`);
        return;
      }
      if (message.id !== 1) return;
      if (message.error) {
        finish({
          status: "unknown",
          source: "codex-app-server",
          observedAt: new Date().toISOString(),
          reason: "Codex account probe failed.",
        });
        return;
      }
      finish(normalizeCreditSnapshot(message.result));
    });

    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "studioops_credit_controller",
          title: "StudioOps Credit Controller",
          version: "0.1.0",
        },
      },
    })}\n`);
  });
}

export async function getCodexCreditSnapshot(input = {}) {
  const policy = mergedCreditPolicy(input);
  if (!policy.enabled) {
    return {
      status: "disabled",
      source: "studioops",
      observedAt: new Date().toISOString(),
      reason: "Credit-aware admission is disabled.",
    };
  }
  const nowMs = Number(input.nowMs || Date.now());
  const observedMs = Date.parse(cachedSnapshot?.observedAt || "");
  if (
    cachedSnapshot
    && Number.isFinite(observedMs)
    && nowMs - observedMs < Number(policy.refreshIntervalMs)
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = await requestCodexCreditSnapshot(policy);
  return cachedSnapshot;
}

function positiveFinite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function fallbackRuleAssessment(policy, tier, execution = {}) {
  const fallback = policy.degradedTelemetryFallback || {};
  const policyVersion = Number(fallback.policyVersion);
  const labels = normalizedList(
    execution.labels || execution.taskLabels || execution.policyLabels,
  ).map((label) => label.toLowerCase());
  const configuredLabels = new Set(normalizedList(fallback.explicitFailClosedLabels)
    .map((label) => label.toLowerCase()));
  const explicitFailClosedMatch = labels.some((label) => configuredLabels.has(label));
  const configuredRule = fallback.rules?.[tier];
  const rule = configuredRule && typeof configuredRule === "object"
    ? cloneFallbackRule(configuredRule)
    : null;
  const configuredRuleId = String(rule?.ruleId ?? "").trim();
  const ruleId = normalizedFallbackRuleId(configuredRuleId);
  const limits = {
    maxConcurrentRuns: rule?.mode === "bounded" ? positiveSafeInteger(rule.maxConcurrentRuns) : null,
    maxAttempts: rule?.mode === "bounded" ? positiveSafeInteger(rule.maxAttempts) : null,
    estimatedTokensPerRun: rule?.mode === "bounded" ? positiveFinite(rule.estimatedTokensPerRun) : null,
    maxInFlightEstimatedTokens: rule?.mode === "bounded"
      ? positiveFinite(rule.maxInFlightEstimatedTokens)
      : null,
  };
  let invalidReasonCode = "";
  if (policyVersion !== CREDIT_FALLBACK_POLICY_VERSION) {
    invalidReasonCode = "unsupported_fallback_policy_version";
  } else if (!CREDIT_RISK_TIERS.includes(tier)) {
    invalidReasonCode = "unclassified_credit_risk_tier";
  } else if (!rule) {
    invalidReasonCode = "missing_fallback_rule";
  } else if (!configuredRuleId) {
    invalidReasonCode = "missing_fallback_rule_id";
  } else if (!ruleId) {
    invalidReasonCode = "invalid_fallback_rule_id";
  } else if (!new Set(["bounded", "fail_closed"]).has(rule.mode)) {
    invalidReasonCode = "unsupported_fallback_rule_mode";
  } else if (
    rule.mode === "bounded"
    && Object.values(limits).some((value) => value === null)
  ) {
    invalidReasonCode = "invalid_fallback_rule_limits";
  } else if (
    rule.mode === "bounded"
    && limits.maxInFlightEstimatedTokens < limits.estimatedTokensPerRun
  ) {
    invalidReasonCode = "invalid_fallback_aggregate_limit";
  }
  return {
    policyVersion: Number.isFinite(policyVersion) ? policyVersion : null,
    ruleId,
    ruleMode: rule?.mode || "fail_closed",
    explicitFailClosedMatch,
    invalidReasonCode,
    ...limits,
  };
}

function evaluationTimestamp(evaluation = {}) {
  const candidate = evaluation.evaluatedAt
    ?? evaluation.evaluationTime
    ?? evaluation.nowMs
    ?? Date.now();
  const parsed = candidate instanceof Date ? candidate.getTime() : (
    typeof candidate === "number" ? candidate : Date.parse(String(candidate))
  );
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sanitizedSnapshotEvidence(snapshot, policy, evaluation = {}) {
  const evaluatedMs = evaluationTimestamp(evaluation);
  const observedMs = Date.parse(String(snapshot?.observedAt || ""));
  const observedAt = Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : "";
  const snapshotAgeMs = Number.isFinite(observedMs)
    ? Math.max(0, evaluatedMs - observedMs)
    : null;
  const rawStatus = String(snapshot?.status || "unknown").trim().toLowerCase();
  const stale = rawStatus === "stale"
    || (
      ["available", "recovered"].includes(rawStatus)
      && (
        snapshotAgeMs === null
        || snapshotAgeMs > Number(policy.snapshotMaxAgeMs)
      )
    );
  const recovered = !stale && (
    rawStatus === "recovered"
    || (rawStatus === "available" && snapshot?.recovered === true)
    || evaluation.recovered === true
  );
  const status = !policy.enabled
    ? "disabled"
    : stale
      ? "stale"
      : recovered
        ? "recovered"
        : rawStatus === "available"
          ? "available"
          : "unknown";
  const defaultReason = status === "disabled"
    ? "Credit-aware admission is disabled."
    : status === "stale"
      ? "Credit snapshot is stale."
      : status === "unknown"
        ? "Credit snapshot is unavailable."
        : "";
  return {
    evaluatedAt: new Date(evaluatedMs).toISOString(),
    snapshotStatus: status,
    snapshotSource: sanitizedSnapshotSource(snapshot?.source),
    snapshotObservedAt: observedAt,
    snapshotAgeMs,
    snapshotReason: defaultReason,
  };
}

function fallbackDecision(snapshotStatus, rule) {
  if (rule.invalidReasonCode) {
    return {
      allowed: false,
      code: rule.invalidReasonCode,
      mode: "fail_closed",
      reasonCode: rule.invalidReasonCode,
      reason: `Degraded-telemetry admission failed closed: ${rule.invalidReasonCode}.`,
    };
  }
  if (rule.explicitFailClosedMatch) {
    return {
      allowed: false,
      code: snapshotStatus === "stale" ? "credit_snapshot_stale" : "credit_snapshot_unknown",
      mode: "fail_closed",
      reasonCode: "explicit_fail_closed_label",
      reason: "A configured label requires credit admission to fail closed.",
    };
  }
  if (rule.ruleMode === "fail_closed") {
    return {
      allowed: false,
      code: snapshotStatus === "stale" ? "credit_snapshot_stale" : "credit_snapshot_unknown",
      mode: "fail_closed",
      reasonCode: "configured_fail_closed_rule",
      reason: "The configured risk-tier rule requires credit admission to fail closed.",
    };
  }
  return {
    allowed: true,
    code: snapshotStatus === "stale"
      ? "credit_snapshot_stale_bounded"
      : "credit_snapshot_unknown_bounded",
    mode: "bounded",
    reasonCode: "configured_bounded_fallback",
    reason: "Current credit telemetry is unavailable; bounded fallback admission applies.",
  };
}

export function assessCreditAdmission(snapshot, execution = {}, input = {}, evaluation = {}) {
  const policy = mergedCreditPolicy(input);
  const requestedTier = String(execution.modelTier || "").trim().toLowerCase();
  const tier = CREDIT_RISK_TIERS.includes(requestedTier) ? requestedTier : "unclassified";
  const fallbackRule = fallbackRuleAssessment(policy, tier, execution);
  const evaluationInput = Object.keys(evaluation || {}).length ? evaluation : {
    evaluatedAt: input.evaluatedAt,
    evaluationTime: input.evaluationTime,
    nowMs: input.nowMs,
    recovered: input.recovered,
  };
  const snapshotEvidence = sanitizedSnapshotEvidence(snapshot, policy, evaluationInput);
  const budget = {
    estimatedCredits: 0,
    minRemainingPercent: 0,
    ...(policy.tierBudgets[tier] || {}),
  };
  const estimatedCredits = Math.max(0, Number(budget.estimatedCredits || 0));
  const minRemainingPercent = Math.max(0, Number(budget.minRemainingPercent || 0));
  const remainingPercent = finiteNumber(snapshot?.remainingPercent);
  const base = {
    enabled: Boolean(policy.enabled),
    tier,
    riskTier: tier,
    estimatedCredits,
    minRemainingPercent,
    policyVersion: fallbackRule.policyVersion,
    ruleId: fallbackRule.ruleId,
    explicitFailClosedMatch: fallbackRule.explicitFailClosedMatch,
    maxConcurrentRuns: fallbackRule.maxConcurrentRuns,
    maxAttempts: fallbackRule.maxAttempts,
    estimatedTokensPerRun: fallbackRule.estimatedTokensPerRun,
    maxInFlightEstimatedTokens: fallbackRule.maxInFlightEstimatedTokens,
    ...snapshotEvidence,
  };

  if (!policy.enabled) {
    return {
      ...base,
      allowed: true,
      code: "disabled",
      mode: "disabled",
      reasonCode: "credit_admission_disabled",
      fallbackUsed: false,
    };
  }

  if (["unknown", "stale"].includes(snapshotEvidence.snapshotStatus)) {
    const decision = fallbackDecision(snapshotEvidence.snapshotStatus, fallbackRule);
    return {
      ...base,
      ...decision,
      fallbackUsed: true,
    };
  }

  if (snapshot.credits?.unlimited) {
    return {
      ...base,
      allowed: true,
      code: "unlimited",
      mode: "normal",
      reasonCode: "unlimited_credit_access",
      fallbackUsed: false,
      remainingPercent,
    };
  }
  if (snapshot.reached) {
    return {
      ...base,
      allowed: false,
      code: "rate_limit_reached",
      mode: "normal",
      reasonCode: "rate_limit_reached",
      fallbackUsed: false,
      remainingPercent,
      reason: "Codex reports that the active usage limit has been reached.",
    };
  }
  if (
    remainingPercent !== null
    && remainingPercent < minRemainingPercent
  ) {
    return {
      ...base,
      allowed: false,
      code: "insufficient_quota_headroom",
      mode: "normal",
      reasonCode: "insufficient_quota_headroom",
      fallbackUsed: false,
      remainingPercent,
      reason: `The ${tier} tier requires at least ${minRemainingPercent}% quota headroom.`,
    };
  }

  const balance = snapshot.credits?.available ? finiteNumber(snapshot.credits.balance) : null;
  const requiredCredits = estimatedCredits + Math.max(0, Number(policy.reserveCredits || 0));
  if (balance !== null && balance < requiredCredits) {
    return {
      ...base,
      allowed: false,
      code: "insufficient_credit_balance",
      mode: "normal",
      reasonCode: "insufficient_credit_balance",
      fallbackUsed: false,
      remainingPercent,
      requiredCredits,
      reason: `The configured estimate and reserve require ${requiredCredits} credits.`,
    };
  }

  return {
    ...base,
    allowed: true,
    code: balance === null ? "included_quota_available" : "credit_headroom_available",
    mode: "normal",
    reasonCode: balance === null ? "included_quota_available" : "credit_headroom_available",
    fallbackUsed: false,
    remainingPercent,
    requiredCredits,
  };
}

export function clearCreditSnapshotCache() {
  cachedSnapshot = null;
}
