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
    assert.deepEqual(state.meta.creditObservedExhaustion, { ...prior, latestBlockingObservedAt: mixed.observedAt });
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

test("legacy refusal provenance survives until recovery; a new episode retains its own classification", () => {
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
  assert.deepEqual(state.meta.creditObservedExhaustion, { ...prior, latestBlockingObservedAt: refusal.observedAt });
  assert.equal(assess(refusal, { knownExhaustion: state.meta.creditObservedExhaustion }).code, "prior_exhaustion_unverified");
  const healthy = snapshot({ ordinaryUsageAllowed: true, reachedType: null, usedPercent: 20 });
  healthy.observedAt = "2026-11-12T03:00:30.000Z";
  updateCreditExhaustionState(state, healthy, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(state.meta.creditObservedExhaustion.clearedByFreshSnapshotAt, healthy.observedAt);
  refusal.observedAt = "2026-11-12T03:00:40.000Z";
  updateCreditExhaustionState(state, refusal, { policy, now: evaluation.evaluatedAt });
  assert.equal(state.meta.creditObservedExhaustion.classificationVersion, 2);
  assert.equal(assess(refusal, { knownExhaustion: state.meta.creditObservedExhaustion }).code, "rate_limit_reached");
});

test("latest blocking evidence fences delayed recovery without replacing refusal provenance", () => {
  const times = [0, 1, 2, 3].map(minute => `2026-11-12T03:0${minute}:00.000Z`);
  const now = "2026-11-12T03:04:00.000Z";
  const hardBlocks = [
    { active: true, reasonCode: "rate_limit_reached", observedAt: times[0] },
    { active: true, reasonCode: "rate_limit_reached", observedAt: times[0], classificationVersion: 2 },
    { active: true, reasonCode: "spend_control_reached", observedAt: times[0], classificationVersion: 2 },
  ];
  const blockingSnapshots = [snapshot(), snapshot({ ordinaryUsageAllowed: null, usedPercent: 20, reachedType: null })];
  assert.deepEqual(blockingSnapshots.map(value => creditExhaustionObservation(value).reasonCode),
    ["overage_eligibility_unverified", "included_usage_permission_unknown"]);
  const healthy = snapshot({ ordinaryUsageAllowed: true, usedPercent: 20, reachedType: null });
  for (const original of hardBlocks) {
    for (const blocking of blockingSnapshots) {
      const state = { meta: { creditObservedExhaustion: structuredClone(original) } };
      updateCreditExhaustionState(state, { ...blocking, observedAt: times[2] }, { policy, now });
      const marker = { ...original, latestBlockingObservedAt: times[2] };
      assert.deepEqual(state.meta.creditObservedExhaustion, marker);
      const assessment = value => assess(value, { evaluatedAt: now, knownExhaustion: state.meta.creditObservedExhaustion });
      // Stale/equal replays, including another classified hard refusal, cannot
      // replace the original cause or lower the latest blocking timestamp.
      for (const observedAt of [times[0], times[1], times[2]]) {
        for (const replay of [...blockingSnapshots, snapshot({ spendControlReached: true })]) {
          updateCreditExhaustionState(state, { ...replay, observedAt }, { policy, now });
          assert.deepEqual(state.meta.creditObservedExhaustion, marker);
        }
      }
      for (const observedAt of [times[1], times[2]]) {
        const incoming = { ...healthy, observedAt };
        assert.equal(assessment(incoming).allowed, false);
        assert.equal(assessment(incoming).fallbackUsed, false);
        assert.equal(assessment(incoming).code, original.classificationVersion ? original.reasonCode : "prior_exhaustion_unverified");
        updateCreditExhaustionState(state, incoming, { policy, now });
        assert.deepEqual(state.meta.creditObservedExhaustion, marker);
        assert.equal(assessment(incoming).allowed, false);
      }
      const laterHealthy = { ...healthy, observedAt: times[3] };
      assert.equal(assessment(laterHealthy).allowed, true);
      updateCreditExhaustionState(state, laterHealthy, { policy, now });
      const cleared = { ...marker, active: false, clearedByFreshSnapshotAt: times[3] };
      assert.deepEqual(state.meta.creditObservedExhaustion, cleared);
      assert.equal(assessment(laterHealthy).allowed, true);
      for (const observedAt of [times[2]]) {
        updateCreditExhaustionState(state, { ...blocking, observedAt }, { policy, now });
        assert.deepEqual(state.meta.creditObservedExhaustion, cleared);
      }
    }
  }
});

test("denial tied with prior clearance blocks fallback and same-time healthy evidence", () => {
  const state = {};
  const now = "2026-11-12T03:04:00.000Z";
  const hard = snapshot({ reachedType: "workspace_owner_usage_limit_reached" });
  const healthy = { ...snapshot({ ordinaryUsageAllowed: true, usedPercent: 20, reachedType: null }),
    observedAt: "2026-11-12T03:02:00.000Z" };
  updateCreditExhaustionState(state, hard, { policy, now });
  updateCreditExhaustionState(state, healthy, { policy, now });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  updateCreditExhaustionState(state, { ...hard, observedAt: healthy.observedAt }, { policy, now });
  const marker = structuredClone(state.meta.creditObservedExhaustion);
  assert.equal(marker.active, true);
  assert.equal(marker.observedAt, healthy.observedAt);
  const assessment = value => assess(value, { evaluatedAt: now, knownExhaustion: state.meta.creditObservedExhaustion });
  for (const incoming of [{ status: "unknown", observedAt: "2026-11-12T03:03:00.000Z" }, healthy]) {
    assert.equal(assessment(incoming).allowed, false);
    assert.equal(assessment(incoming).fallbackUsed, false);
    updateCreditExhaustionState(state, incoming, { policy, now });
    assert.deepEqual(state.meta.creditObservedExhaustion, marker);
  }
  const later = { ...healthy, observedAt: "2026-11-12T03:03:00.000Z" };
  updateCreditExhaustionState(state, later, { policy, now });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(assessment(later).allowed, true);
});

test("newer hard refusals advance the barrier while preserving the first hard cause", () => {
  const state = {};
  const original = snapshot({ reachedType: "workspace_owner_usage_limit_reached" });
  updateCreditExhaustionState(state, original);
  const provenance = structuredClone(state.meta.creditObservedExhaustion);
  const newer = { ...snapshot({ spendControlReached: true }), observedAt: "2026-11-12T03:02:00.000Z" };
  updateCreditExhaustionState(state, newer);
  assert.deepEqual(state.meta.creditObservedExhaustion, { ...provenance, latestBlockingObservedAt: newer.observedAt });
});
