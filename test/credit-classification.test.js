import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreditSnapshot, assessCreditAdmission, creditExhaustionObservation, freshHealthyCreditEvidence } from "../src/credit-policy.js";
import { updateCreditExhaustionState } from "../src/credit-reservations.js";

const observedAt = "2026-11-12T03:00:00.000Z";
const evaluation = { evaluatedAt: "2026-11-12T03:01:00.000Z" };
const policy = { enabled: true };
function snapshot({ ordinaryUsageAllowed = false, spendControlReached = false,
  usedPercent = 100, reachedType = "rate_limit_reached", credits = { hasCredits: true, balance: "100", unlimited: false } } = {}) {
  return normalizeCreditSnapshot({ ordinaryUsageAllowed, rateLimits: {
    limitId: "codex", primary: { usedPercent }, rateLimitReachedType: reachedType,
    spendControlReached, credits,
  } }, { observedAt });
}
const assess = (value, extra = {}) => assessCreditAdmission(value, { modelTier: "balanced" }, policy, { ...evaluation, ...extra });

test("included exhaustion never becomes provider refusal or permission to spend", () => {
  for (const ordinaryUsageAllowed of [false, null, true]) {
    for (const spendControlReached of [false, null]) {
      for (const reachedType of [null, "rate_limit_reached"]) {
        for (const credits of [{ hasCredits: true, balance: "100" }, { hasCredits: true, balance: "0" }, null, { hasCredits: false }, { unlimited: true }]) {
          const value = snapshot({ ordinaryUsageAllowed, spendControlReached, reachedType, credits });
          assert.equal(value.reached, false);
          assert.equal(value.ordinaryUsageAllowed, ordinaryUsageAllowed);
          assert.equal(value.spendControlReached, spendControlReached);
          assert.equal(value.overageEligibility, "unverified");
          assert.equal(assess(value).allowed, false);
          assert.equal(assess(value).code, "overage_eligibility_unverified");
          assert.equal(assess(value).fallbackUsed, false);
          assert.equal(creditExhaustionObservation(value).reasonCode, "overage_eligibility_unverified");
          assert.equal(freshHealthyCreditEvidence(value, policy, evaluation).healthyCapacity, false);
        }
      }
    }
  }
});

test("explicit account blocks and spend controls stay hard blocked with credits", () => {
  for (const reachedType of ["workspace_owner_credits_depleted", "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]) {
    const value = snapshot({ reachedType });
    assert.equal(value.reachedType, reachedType);
    assert.equal(value.reached, true);
    assert.equal(assess(value).code, "rate_limit_reached");
    assert.equal(assess(value).allowed, false);
  }
  for (const ordinaryUsageAllowed of [false, null, true]) {
    const value = snapshot({ ordinaryUsageAllowed, spendControlReached: true });
    assert.equal(assess(value).code, "spend_control_reached");
    assert.equal(assess(value).allowed, false);
    assert.equal(creditExhaustionObservation(value).reasonCode, "spend_control_reached");
  }
});

test("explicit included permission and spend status govern healthy normalized evidence", () => {
  for (const ordinaryUsageAllowed of [false, null, true]) {
    for (const spendControlReached of [false, null, true]) {
      const value = snapshot({ ordinaryUsageAllowed, spendControlReached, usedPercent: 20, reachedType: null });
      const healthy = ordinaryUsageAllowed === true && spendControlReached === false;
      assert.equal(assess(value).allowed, healthy);
      assert.equal(freshHealthyCreditEvidence(value, policy, evaluation).healthyCapacity, healthy);
    }
  }
});

test("unresolved telemetry persists conservatively and cannot clear or replace historical blocks", () => {
  const mixed = snapshot();
  for (const prior of [
    { active: true, reasonCode: "rate_limit_reached", observedAt: "2026-11-12T02:59:00.000Z" },
    { active: true, reasonCode: "spend_control_reached", observedAt: "2026-11-12T02:59:00.000Z", classificationVersion: 2 },
  ]) {
    const state = { meta: { creditObservedExhaustion: structuredClone(prior) } };
    updateCreditExhaustionState(state, mixed, { policy, now: evaluation.evaluatedAt });
    assert.deepEqual(state.meta.creditObservedExhaustion, prior);
    assert.equal(assess(mixed, { knownExhaustion: prior }).allowed, false);
    assert.equal(assess(mixed, { knownExhaustion: prior }).code,
      prior.classificationVersion ? "spend_control_reached" : "prior_exhaustion_unverified");
  }
  const state = {};
  updateCreditExhaustionState(state, mixed, { policy, now: evaluation.evaluatedAt });
  const prior = structuredClone(state.meta.creditObservedExhaustion);
  const staleEvaluation = { evaluatedAt: "2026-11-13T03:00:00.000Z", knownExhaustion: prior };
  assert.equal(assess(mixed, staleEvaluation).allowed, false);
  assert.equal(assess({ status: "unknown" }, staleEvaluation).code, "overage_eligibility_unverified");
  const ambiguous = snapshot({ ordinaryUsageAllowed: null, usedPercent: 20, reachedType: null });
  ambiguous.observedAt = "2026-11-12T03:00:30.000Z";
  updateCreditExhaustionState(state, ambiguous, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.active, true);
  const healthy = snapshot({ ordinaryUsageAllowed: true, usedPercent: 20, reachedType: null });
  healthy.observedAt = "2026-11-12T03:00:45.000Z";
  updateCreditExhaustionState(state, healthy, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(state.meta.creditObservedExhaustion.clearedByFreshSnapshotAt, healthy.observedAt);
});

test("transport-only missing telemetry retains bounded fallback, not paid overage permission", () => {
  const value = assess({ status: "unknown" });
  assert.equal(value.allowed, true);
  assert.equal(value.mode, "bounded");
  assert.equal(value.maxConcurrentRuns, 1);
  assert.equal(value.maxAttempts, 1);
  assert.equal(value.maxInFlightEstimatedTokens, 100_000);
});

test("successful no-bucket responses preserve permission and fail closed through persistence", () => {
  for (const ordinaryUsageAllowed of [false, null, true]) {
    const value = normalizeCreditSnapshot({ ordinaryUsageAllowed, rateLimits: null, rateLimitsByLimitId: {} }, { observedAt });
    assert.equal(value.classificationVersion, 2);
    assert.equal(value.ordinaryUsageAllowed, ordinaryUsageAllowed);
    assert.equal(value.spendControlReached, null);
    assert.equal(assess(value).allowed, false);
    assert.equal(assess(value).fallbackUsed, false);
    assert.equal(freshHealthyCreditEvidence(value, policy, evaluation).healthyCapacity, false);
    const code = ordinaryUsageAllowed === false ? "overage_eligibility_unverified" : "included_usage_permission_unknown";
    assert.equal(assess(value).code, code);
    const state = {};
    updateCreditExhaustionState(state, value, { policy, now: evaluation.evaluatedAt });
    assert.equal(state.meta.creditObservedExhaustion.reasonCode, code);
    assert.equal(state.meta.creditObservedExhaustion.classificationVersion, 2);
    assert.equal(assess({ status: "unknown" }, { knownExhaustion: state.meta.creditObservedExhaustion }).allowed, false);
  }
  // Only transport failures omit successful-response classification.
  assert.equal(assess({ status: "unknown", source: "codex-app-server", observedAt }).mode, "bounded");
});

test("legacy replay cannot upgrade historical provenance; fresh classified evidence can", () => {
  const prior = { active: true, reasonCode: "rate_limit_reached", observedAt };
  const state = { meta: { creditObservedExhaustion: structuredClone(prior) } };
  for (const at of ["2026-11-12T02:59:00.000Z", observedAt, "2026-11-12T03:00:10.000Z"]) {
    const legacy = { status: "available", reached: true, remainingPercent: 0, observedAt: at };
    assert.equal(creditExhaustionObservation(legacy).classificationVersion, undefined);
    updateCreditExhaustionState(state, legacy, { policy, now: evaluation.evaluatedAt });
    assert.equal(state.meta.creditObservedExhaustion.classificationVersion, undefined);
    assert.equal(state.meta.creditObservedExhaustion.active, true);
    assert.equal(assess(legacy, { knownExhaustion: state.meta.creditObservedExhaustion }).code, "prior_exhaustion_unverified");
    if (at <= observedAt) assert.deepEqual(state.meta.creditObservedExhaustion, prior);
  }
  const refusal = snapshot({ reachedType: "workspace_owner_usage_limit_reached" });
  refusal.observedAt = "2026-11-12T03:00:20.000Z";
  updateCreditExhaustionState(state, refusal, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.classificationVersion, 2);
  assert.equal(assess(refusal, { knownExhaustion: state.meta.creditObservedExhaustion }).code, "rate_limit_reached");
  const healthy = snapshot({ ordinaryUsageAllowed: true, reachedType: null, usedPercent: 20 });
  healthy.observedAt = "2026-11-12T03:00:30.000Z";
  updateCreditExhaustionState(state, healthy, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(state.meta.creditObservedExhaustion.clearedByFreshSnapshotAt, healthy.observedAt);
});
