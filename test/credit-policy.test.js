import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCreditAdmission,
  normalizeCreditSnapshot,
} from "../src/credit-policy.js";

function availableSnapshot(overrides = {}) {
  return {
    status: "available",
    source: "codex-app-server",
    observedAt: new Date().toISOString(),
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

test("unknown account data allows economy work but fails closed for critical tiers", () => {
  const unknown = {
    status: "unknown",
    observedAt: new Date().toISOString(),
    reason: "Account service unavailable.",
  };
  const economy = assessCreditAdmission(
    unknown,
    { modelTier: "economy", model: "gpt-5.6-luna" },
    creditPolicy,
  );
  const critical = assessCreditAdmission(
    unknown,
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
  );

  assert.equal(economy.allowed, true);
  assert.equal(economy.code, "credit_snapshot_unknown_allowed");
  assert.equal(critical.allowed, false);
  assert.equal(critical.code, "credit_snapshot_unknown");
});

test("quota and purchased-credit reserves gate a tier without downgrading it", () => {
  const lowQuota = assessCreditAdmission(
    availableSnapshot({ remainingPercent: 12 }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
  );
  const lowBalance = assessCreditAdmission(
    availableSnapshot({
      credits: { available: true, unlimited: false, balance: 20 },
    }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
  );
  const enough = assessCreditAdmission(
    availableSnapshot({
      credits: { available: true, unlimited: false, balance: 100 },
    }),
    { modelTier: "critical", model: "gpt-5.6-sol" },
    creditPolicy,
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
  );
  const unlimited = assessCreditAdmission(
    availableSnapshot({
      reached: false,
      credits: { available: false, unlimited: true, balance: null },
    }),
    { modelTier: "frontier", model: "gpt-5.6-sol" },
    creditPolicy,
  );

  assert.equal(reached.allowed, false);
  assert.equal(reached.code, "rate_limit_reached");
  assert.equal(unlimited.allowed, true);
  assert.equal(unlimited.code, "unlimited");
});
