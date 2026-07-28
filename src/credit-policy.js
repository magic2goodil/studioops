import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import readline from "node:readline";

const DEFAULT_CODEX_BINS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export const DEFAULT_CREDIT_POLICY = Object.freeze({
  enabled: false,
  refreshIntervalMs: 5 * 60 * 1000,
  snapshotMaxAgeMs: 15 * 60 * 1000,
  probeTimeoutMs: 20 * 1000,
  reserveCredits: 5,
  failClosedTiers: ["critical", "frontier"],
  tierBudgets: {
    mechanical: { estimatedCredits: 2, minRemainingPercent: 2 },
    economy: { estimatedCredits: 8, minRemainingPercent: 5 },
    balanced: { estimatedCredits: 15, minRemainingPercent: 10 },
    critical: { estimatedCredits: 30, minRemainingPercent: 20 },
    frontier: { estimatedCredits: 40, minRemainingPercent: 35 },
  },
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

function mergedCreditPolicy(input = {}) {
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
  };
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

function boundedText(value, max = 500) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
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
    bucketId: String(bucket.limitId || "codex"),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: Math.max(
      0,
      ...windows.map((window) => Number(window.resetsAt || 0)).filter(Number.isFinite),
    ) || null,
    reached,
    reachedType: String(bucket.rateLimitReachedType || ""),
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
    let stderr = "";

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

    child.stderr.on("data", (chunk) => {
      stderr = boundedText(`${stderr}${chunk}`, 500);
    });
    child.on("error", (error) => {
      finish({
        status: "unknown",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        reason: `Codex account probe could not start: ${boundedText(error.message)}`,
      });
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish({
          status: "unknown",
          source: "codex-app-server",
          observedAt: new Date().toISOString(),
          reason: `Codex account probe exited before returning limits (${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}).`,
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
          reason: `Codex account probe failed: ${boundedText(message.error.message)}`,
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

export function assessCreditAdmission(snapshot, execution = {}, input = {}) {
  const policy = mergedCreditPolicy(input);
  const tier = String(execution.modelTier || "unclassified").trim() || "unclassified";
  const budget = {
    estimatedCredits: 0,
    minRemainingPercent: 0,
    ...(policy.tierBudgets[tier] || {}),
  };
  const estimatedCredits = Math.max(0, Number(budget.estimatedCredits || 0));
  const minRemainingPercent = Math.max(0, Number(budget.minRemainingPercent || 0));
  const base = {
    enabled: Boolean(policy.enabled),
    tier,
    model: String(execution.model || ""),
    estimatedCredits,
    minRemainingPercent,
    snapshotStatus: snapshot?.status || "unknown",
  };

  if (!policy.enabled) return { ...base, allowed: true, code: "disabled" };

  const observedMs = Date.parse(snapshot?.observedAt || "");
  const stale = !Number.isFinite(observedMs)
    || Date.now() - observedMs > Number(policy.snapshotMaxAgeMs);
  if (!snapshot || snapshot.status !== "available" || stale) {
    const failClosed = policy.failClosedTiers.includes(tier);
    return {
      ...base,
      allowed: !failClosed,
      code: failClosed ? "credit_snapshot_unknown" : "credit_snapshot_unknown_allowed",
      reason: snapshot?.reason || (stale ? "Credit snapshot is stale." : "Credit snapshot is unavailable."),
    };
  }

  if (snapshot.credits?.unlimited) {
    return { ...base, allowed: true, code: "unlimited", remainingPercent: snapshot.remainingPercent };
  }
  if (snapshot.reached) {
    return {
      ...base,
      allowed: false,
      code: "rate_limit_reached",
      remainingPercent: snapshot.remainingPercent,
      reason: snapshot.reachedType || "Codex reports that the active usage limit has been reached.",
    };
  }
  if (
    snapshot.remainingPercent !== null
    && snapshot.remainingPercent < minRemainingPercent
  ) {
    return {
      ...base,
      allowed: false,
      code: "insufficient_quota_headroom",
      remainingPercent: snapshot.remainingPercent,
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
      remainingPercent: snapshot.remainingPercent,
      requiredCredits,
      reason: `The configured estimate and reserve require ${requiredCredits} credits.`,
    };
  }

  return {
    ...base,
    allowed: true,
    code: balance === null ? "included_quota_available" : "credit_headroom_available",
    remainingPercent: snapshot.remainingPercent,
    requiredCredits,
  };
}

export function clearCreditSnapshotCache() {
  cachedSnapshot = null;
}
