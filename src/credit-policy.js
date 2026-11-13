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
  // Opt-in, cumulative estimated-credit allowance; never an automatic top-up.
  prepaid: Object.freeze({ enabled: false }),
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
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const REACHED_TYPES = new Set([
  "rate_limit_reached", "workspace_owner_credits_depleted", "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached",
]);
const EXHAUSTION_CODES = new Set([
  "rate_limit_reached", "insufficient_credit_balance", "spend_control_reached",
  "overage_eligibility_unverified", "included_usage_permission_unknown",
]);

function snapshotBlocker(snapshot, prepaidQualified = false) {
  if (snapshot?.spendControlReached === true) return "spend_control_reached";
  // Legacy reached records remain blocking, but percentages and the generic
  // backend included-limit signal are not evidence of a provider refusal.
  if (snapshot?.reached === true || (REACHED_TYPES.has(snapshot?.reachedType)
    && snapshot.reachedType !== "rate_limit_reached")) return "rate_limit_reached";
  if (prepaidQualified) return "";
  const remaining = finiteNumber(snapshot?.remainingPercent);
  if (snapshot?.ordinaryUsageAllowed === false || (remaining !== null && remaining <= 0)
    || snapshot?.reachedType === "rate_limit_reached" || snapshot?.reachedType === "unclassified") {
    return "overage_eligibility_unverified";
  }
  if (snapshot?.classificationVersion === 2 && (snapshot.ordinaryUsageAllowed !== true
    || snapshot.spendControlReached !== false)) return "included_usage_permission_unknown";
  if (snapshot?.credits?.available === true && snapshot.credits.unlimited !== true
    && finiteNumber(snapshot.credits.balance) !== null && finiteNumber(snapshot.credits.balance) <= 0) {
    return "insufficient_credit_balance";
  }
  return "";
}

function blockerReason(code) {
  return {
    rate_limit_reached: "Codex reports that the active usage limit has been reached.",
    spend_control_reached: "The backend reports an active spend-control block.",
    overage_eligibility_unverified: "Included usage is unavailable or exhausted. Paid overage eligibility and an approved spending budget are not established.",
    included_usage_permission_unknown: "Included-usage permission or spend-control status is unavailable; admission remains closed.",
    insufficient_credit_balance: "The observed credit balance is exhausted.",
  }[code];
}

function creditCapacity(snapshot) {
  const remaining = finiteNumber(snapshot?.remainingPercent);
  const remainingPercent = remaining !== null && remaining >= 0 && remaining <= 100 ? remaining : null;
  const balance = snapshot?.credits?.available === true ? finiteNumber(snapshot.credits.balance) : null;
  const unlimited = snapshot?.credits?.unlimited === true;
  const exhausted = Boolean(snapshotBlocker(snapshot));
  return { remainingPercent, balance, unlimited, exhausted,
    measured: remainingPercent !== null || balance !== null || unlimited };
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
    prepaid: { ...(policy.prepaid || {}), enabled: policy.prepaid?.enabled === true },
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
      classificationVersion: 2,
      ordinaryUsageAllowed: typeof result?.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
      spendControlReached: null,
      overageEligibility: "unverified",
    };
  }

  const windows = [bucket.primary, bucket.secondary].filter(Boolean);
  const usedPercents = windows
    .map((window) => finiteNumber(window.usedPercent))
    .filter((value) => value !== null);
  const usedPercent = usedPercents.length ? Math.max(...usedPercents) : null;
  const credits = bucket.credits || null;
  const balance = finiteNumber(credits?.balance);
  const reachedType = bucket.rateLimitReachedType == null || bucket.rateLimitReachedType === ""
    ? "" : (REACHED_TYPES.has(bucket.rateLimitReachedType) ? bucket.rateLimitReachedType : "unclassified");
  const reached = REACHED_TYPES.has(reachedType) && reachedType !== "rate_limit_reached";
  const bucketIdentity = Object.hasOwn(bucket, "limitId")
    ? (typeof bucket.limitId === "string" ? bucket.limitId : "")
    : (buckets.codex === bucket ? "codex" : "");

  return {
    status: reached || usedPercent !== null || (credits?.hasCredits === true && balance !== null)
      || credits?.unlimited === true ? "available" : "unknown",
    source: "codex-app-server",
    observedAt,
    bucketId: sanitizedBucketId(bucketIdentity),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: Math.max(
      0,
      ...windows.map((window) => Number(window.resetsAt || 0)).filter(Number.isFinite),
    ) || null,
    reached,
    classificationVersion: 2,
    reachedType,
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
    spendControlReached: typeof bucket.spendControlReached === "boolean" ? bucket.spendControlReached : null,
    overageEligibility: "unverified",
    credits: {
      available: credits?.hasCredits === true,
      unlimited: typeof credits?.unlimited === "boolean" ? credits.unlimited : null,
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
  const capacity = creditCapacity(snapshot);
  const stale = rawStatus === "stale"
    || (
      ["available", "recovered"].includes(rawStatus)
      && (
        snapshotAgeMs === null || observedMs > evaluatedMs
        || snapshotAgeMs > Number(policy.snapshotMaxAgeMs)
      )
    );
  const recovered = !stale && capacity.measured && ["available", "recovered"].includes(rawStatus) && (
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
        : rawStatus === "available" && capacity.measured
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

/** Explicit prepaid evidence is independent of included-usage permission. */
function prepaidFundingEvidence(snapshot, policy, evaluation = {}) {
  const configured = policy.prepaid || {};
  const maxEstimatedCredits = finiteNumber(configured.maxEstimatedCredits);
  const maxConcurrentRuns = finiteNumber(configured.maxConcurrentRuns);
  const reserve = finiteNumber(policy.reserveCredits);
  const balance = finiteNumber(snapshot?.credits?.balance);
  const maxAge = finiteNumber(policy.snapshotMaxAgeMs);
  const evidence = sanitizedSnapshotEvidence(snapshot, policy, evaluation);
  const qualified = policy.enabled === true && configured.enabled === true
    && typeof configured.maxEstimatedCredits === "number" && maxEstimatedCredits !== null && maxEstimatedCredits > 0
    && typeof configured.maxConcurrentRuns === "number" && Number.isSafeInteger(maxConcurrentRuns) && maxConcurrentRuns > 0
    && reserve !== null && reserve >= 0 && maxAge !== null && maxAge > 0
    && snapshot?.classificationVersion === 2 && snapshot.bucketId === "codex"
    && CREDIT_SNAPSHOT_SOURCES.has(snapshot.source)
    && ["available", "recovered"].includes(evidence.snapshotStatus)
    && snapshot.reached === false && ["", "rate_limit_reached"].includes(snapshot.reachedType)
    && snapshot.spendControlReached === false
    && snapshot.credits?.available === true && snapshot.credits.unlimited === false
    && balance !== null && balance > reserve;
  return { qualified, maxEstimatedCredits, maxConcurrentRuns,
    prepaidCreditLimit: qualified ? Math.min(maxEstimatedCredits, balance - reserve) : null };
}

/** Shared dated proof for clearance; a status label alone is never capacity. */
export function freshHealthyCreditEvidence(snapshot, input = {}, evaluation = {}) {
  const policy = mergedCreditPolicy(input);
  const evidence = sanitizedSnapshotEvidence(snapshot, policy, evaluation);
  const capacity = creditCapacity(snapshot);
  const prepaid = prepaidFundingEvidence(snapshot, policy, evaluation);
  const healthyCapacity = capacity.measured && (!capacity.exhausted || prepaid.qualified)
    && ["available", "recovered"].includes(evidence.snapshotStatus);
  return { ...evidence, fundingMode: capacity.exhausted && prepaid.qualified ? "prepaid" : "included",
    healthyCapacity, verifiedIncludedCapacity: healthyCapacity && !capacity.exhausted
      && snapshot?.classificationVersion === 2 && snapshot.bucketId === "codex" && CREDIT_SNAPSHOT_SOURCES.has(snapshot.source)
      && snapshot.ordinaryUsageAllowed === true && snapshot.spendControlReached === false };
}

/** Recovery must follow every retained block, not just its original cause. */
export function creditExhaustionBarrierMs(observation) {
  return Math.max(Date.parse(observation?.observedAt || "") || 0,
    Date.parse(observation?.latestBlockingObservedAt || "") || 0);
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
  const { healthyCapacity, verifiedIncludedCapacity, fundingMode: _healthyFundingMode, ...snapshotEvidence } = freshHealthyCreditEvidence(snapshot, policy, evaluationInput);
  const budget = {
    estimatedCredits: 0,
    minRemainingPercent: 0,
    ...(policy.tierBudgets[tier] || {}),
  };
  const estimatedCredits = Math.max(0, Number(budget.estimatedCredits || 0));
  const minRemainingPercent = Math.max(0, Number(budget.minRemainingPercent || 0));
  const { remainingPercent, balance, unlimited } = creditCapacity(snapshot);
  const prepaid = prepaidFundingEvidence(snapshot, policy, evaluationInput);
  const base = {
    enabled: Boolean(policy.enabled),
    tier,
    riskTier: tier,
    estimatedCredits,
    minRemainingPercent,
    remainingPercent,
    policyVersion: fallbackRule.policyVersion,
    ruleId: fallbackRule.ruleId,
    explicitFailClosedMatch: fallbackRule.explicitFailClosedMatch,
    maxConcurrentRuns: fallbackRule.maxConcurrentRuns,
    maxAttempts: fallbackRule.maxAttempts,
    estimatedTokensPerRun: fallbackRule.estimatedTokensPerRun,
    maxInFlightEstimatedTokens: fallbackRule.maxInFlightEstimatedTokens,
    ...snapshotEvidence,
  };

  const prior = evaluationInput.knownExhaustion;
  let prepaidProvenanceRequired = false;
  if (prior?.clearanceFundingMode === "prepaid") {
    const barrier = Math.max(creditExhaustionBarrierMs(prior), Date.parse(prior.clearedByFreshSnapshotAt || "") || 0);
    const observed = Date.parse(snapshotEvidence.snapshotObservedAt || "");
    const includedRecovery = verifiedIncludedCapacity && observed > barrier;
    prepaidProvenanceRequired = !includedRecovery;
    if (!(prepaid.qualified && observed >= barrier) && !includedRecovery) {
      const code = snapshotBlocker(snapshot) || "prepaid_funding_unverified";
      return { ...base, allowed: false, code, reasonCode: code, mode: "prepaid", fundingMode: "prepaid", fallbackUsed: false,
        reason: "Known included exhaustion was funded by prepaid admission; fresh qualifying funding remains required." };
    }
  }
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

  const obsoleteObservation = prior?.active === false
    && Date.parse(prior.clearedByFreshSnapshotAt || "") > Date.parse(snapshotEvidence.snapshotObservedAt || "");
  if (obsoleteObservation) {
    // A delayed observer cannot resurrect an exhaustion record superseded by
    // dated fresh evidence. Its older payload is stale, not live quota proof.
    return { ...base, ...fallbackDecision("stale", fallbackRule),
      snapshotStatus: "stale", fallbackUsed: true };
  }
  const priorValid = prior?.active === true
    && EXHAUSTION_CODES.has(prior.reasonCode)
    && Number.isFinite(Date.parse(prior.observedAt || ""));
  const newerFresh = healthyCapacity
    && Date.parse(snapshotEvidence.snapshotObservedAt || "") > creditExhaustionBarrierMs(prior);
  if (priorValid && !newerFresh) {
    const code = prior.reasonCode === "rate_limit_reached" && !prior.classificationVersion
      ? "prior_exhaustion_unverified" : prior.reasonCode;
    return { ...base, allowed: false, code, mode: "normal",
      reasonCode: code, fallbackUsed: false, remainingPercent,
      reason: "Previously observed exhaustion requires newer explicit healthy evidence; legacy records do not distinguish included limits from provider refusal." };
  }
  // Observed exhaustion cannot become permission merely because its telemetry
  // later ages or a caller cannot refresh it. Only a new healthy snapshot may
  // replace that evidence.
  const blocker = snapshotBlocker(snapshot, prepaid.qualified);
  if (blocker) {
    return { ...base, allowed: false, code: blocker, mode: "normal",
      reasonCode: blocker, fallbackUsed: false, remainingPercent,
      reason: blockerReason(blocker) };
  }
  if (["unknown", "stale"].includes(snapshotEvidence.snapshotStatus)) {
    const decision = fallbackDecision(snapshotEvidence.snapshotStatus, fallbackRule);
    return {
      ...base,
      ...decision,
      fallbackUsed: true,
    };
  }

  if (prepaid.qualified && (prepaidProvenanceRequired || snapshotBlocker(snapshot))) {
    const validEstimate = finiteNumber(budget.estimatedCredits) !== null && estimatedCredits > 0;
    const allowed = tier !== "unclassified" && validEstimate && estimatedCredits <= prepaid.prepaidCreditLimit;
    const code = allowed ? "authorized_prepaid_available" : "prepaid_estimate_exceeds_allowance";
    return { ...base, allowed, code, reasonCode: code, mode: "prepaid", fundingMode: "prepaid",
      fallbackUsed: false, policyVersion: 1, ruleId: "authorized-prepaid-v1",
      maxEstimatedCredits: prepaid.maxEstimatedCredits, prepaidCreditLimit: prepaid.prepaidCreditLimit,
      maxConcurrentRuns: prepaid.maxConcurrentRuns,
      reason: "Explicit cumulative prepaid estimate allowance; account-wide reservation and atomic claim remain required." };
  }

  if (unlimited) {
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

/** Dated control evidence only: no account identity, balance, or raw payload. */
export function creditExhaustionObservation(snapshot, checkedAt = new Date().toISOString(), policy = {}) {
  const prepaid = prepaidFundingEvidence(snapshot, mergedCreditPolicy(policy), { evaluatedAt: checkedAt });
  const reasonCode = snapshotBlocker(snapshot, prepaid.qualified);
  if (!reasonCode) return null;
  const observedAt = Number.isFinite(Date.parse(snapshot.observedAt || "")) ? new Date(snapshot.observedAt).toISOString() : checkedAt;
  // Classification belongs to the source observation, not this persistence
  // adapter. Replaying a legacy snapshot cannot manufacture provider proof.
  return { active: true, reasonCode, observedAt,
    ...(snapshot.classificationVersion === 2 ? { classificationVersion: 2 } : {}) };
}

export function clearCreditSnapshotCache() {
  cachedSnapshot = null;
}
