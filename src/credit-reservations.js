import { sanitizedCreditAdmission, validPrepaidCreditLedger } from "./credit-admission-evidence.js";
export { sanitizedCreditAdmission } from "./credit-admission-evidence.js";
import { createHash } from "node:crypto";
import { failureWorkIdentity, normalizeFailureProvider } from "./failure-containment.js";
import { freshHealthyCreditEvidence, creditExhaustionObservation, creditExhaustionBarrierMs } from "./credit-policy.js";

const TIERS = new Set(["mechanical", "economy", "balanced", "critical", "frontier"]);
const digest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

const emptyPrepaidLedger = () => ({ schemaVersion: 1, committedEstimatedCredits: 0, claimCount: 0, lastClaimedAt: "" });

export function updateCreditExhaustionState(state, snapshot, { policy = {}, now = new Date().toISOString() } = {}) {
  const observation = creditExhaustionObservation(snapshot, now, policy);
  const prior = state.meta?.creditObservedExhaustion;
  if (observation) {
    const latestEvidenceAt = Math.max(creditExhaustionBarrierMs(prior),
      Date.parse(prior?.clearedByFreshSnapshotAt || "") || 0);
    // Replays cannot regress ordering or change an active block's provenance.
    // A denial tied with prior clearance is a conflict: fail closed again.
    const observedMs = Date.parse(observation.observedAt);
    if (prior && (observedMs < latestEvidenceAt || (prior.active && observedMs === latestEvidenceAt))) return;
    // Retain the original hard refusal (including unclassified legacy cause),
    // while recording every newer block as a separate recovery barrier.
    const unresolved = ["overage_eligibility_unverified", "included_usage_permission_unknown"];
    state.meta ||= {};
    const next = prior?.active && !unresolved.includes(prior.reasonCode)
      ? { ...prior, latestBlockingObservedAt: observation.observedAt }
      : observation;
    if (prior?.clearanceFundingMode === "prepaid") {
      next.clearanceFundingMode = "prepaid";
      next.clearedByFreshSnapshotAt = prior.clearedByFreshSnapshotAt;
    }
    state.meta.creditObservedExhaustion = next;
    return;
  }
  const evidence = freshHealthyCreditEvidence(snapshot, policy, { evaluatedAt: now });
  const observed = Date.parse(evidence.snapshotObservedAt || "");
  const barrier = Math.max(creditExhaustionBarrierMs(prior), Date.parse(prior?.clearedByFreshSnapshotAt || "") || 0);
  if (evidence.healthyCapacity && evidence.fundingMode === "prepaid") {
    if (prior && (observed < barrier || (prior.active && observed === barrier))) return;
    // Prepaid funding does not prove included recovery. Retain that provenance
    // even on a first observation, so later transport fallback cannot spend
    // outside the explicit prepaid allowance.
    state.meta ||= {};
    state.meta.creditObservedExhaustion = { ...(prior || creditExhaustionObservation(snapshot, now)),
      active: false, clearanceFundingMode: "prepaid", clearedByFreshSnapshotAt: evidence.snapshotObservedAt };
    return;
  }
  if (!prior?.active && prior?.clearanceFundingMode !== "prepaid") return;
  if (prior.clearanceFundingMode === "prepaid" && !(evidence.verifiedIncludedCapacity && observed > barrier)) return;
  if (evidence.healthyCapacity
    && Date.parse(evidence.snapshotObservedAt || "") > creditExhaustionBarrierMs(prior)) {
    state.meta.creditObservedExhaustion = { ...prior, active: false, clearedByFreshSnapshotAt: evidence.snapshotObservedAt };
    delete state.meta.creditObservedExhaustion.clearanceFundingMode;
  }
}


function workIdentity(task, action) {
  const candidate = task.candidateIdentity || {};
  return failureWorkIdentity({
    taskId: task.id, action: action.type || action.actionType,
    provider: "codex", reasonCode: "execution_failed",
    candidate: { treeSha: candidate.treeSha || "", commitSha: candidate.commitSha || task.reviewSubjectSha || "", baseSha: candidate.baseSha || "" },
  });
}

/** Only verified repairs, not transport/rule/cycle labels, advance this lineage. */
export function creditFallbackAttemptKey(task, action, incidents = []) {
  const work = workIdentity(task, action);
  const verified = [];
  for (const incident of incidents) {
    if (incident.taskId !== task.id) continue;
    let identity;
    try { identity = failureWorkIdentity({ ...incident.fingerprint, reasonCode: "execution_failed" }); }
    catch { continue; }
    if (identity.action !== work.action || normalizeFailureProvider(identity.provider) !== "codex"
      || (work.source && identity.source && work.source !== identity.source)) continue;
    for (const event of incident.history || []) {
      if (event.type === "evidence_verified" && /^sha256:[a-f0-9]{64}$/.test(event.evidenceDigest || "")
        && Number.isFinite(Date.parse(event.recordedAt || ""))) {
        verified.push({ at: event.recordedAt, evidence: event.evidenceDigest });
      }
    }
  }
  verified.sort((a, b) => a.at.localeCompare(b.at) || a.evidence.localeCompare(b.evidence));
  return digest({ taskId: task.id, action: work.action, role: action.role || "builder", source: work.source,
    verifiedRecovery: verified.at(-1) || null });
}

const emptyBucket = () => ({ ownedRuns: 0, ownedTokens: 0, selectedRuns: 0, selectedTokens: 0, entries: [] });

/** One historical scan per sweep; only eligible queue ownership is reserved. */
export function createCreditReservationPlan(state, eligibleRun = () => true, incidents = [], prepaidEligibleRun = eligibleRun) {
  const plan = { buckets: new Map(), attempts: new Map(), incidentsByTask: new Map(), invalid: 0, nextIndex: 0 };
  const present = Object.hasOwn(state.meta || {}, "prepaidCreditLedger");
  const ledger = present ? state.meta.prepaidCreditLedger : emptyPrepaidLedger();
  plan.prepaid = { valid: validPrepaidCreditLedger(ledger), committedCredits: ledger?.committedEstimatedCredits,
    claimCount: ledger?.claimCount, selectedCredits: 0, selectedRuns: 0, entries: [] };
  const sequences = new Set();
  let retainedClaimCredits = 0;
  for (const incident of incidents || []) {
    const rows = plan.incidentsByTask.get(incident.taskId) || [];
    rows.push(incident); plan.incidentsByTask.set(incident.taskId, rows);
  }
  for (const [index, run] of (state.runs || []).entries()) {
    const evidence = run.creditAdmission || {};
    const actual = run.creditClaimAdmission || evidence;
    if (run.creditClaimAdmission?.fundingMode === "prepaid") {
      const sequence = actual.prepaidClaimSequence;
      if (!present || run.status === "queued" || !actual.allowed || !Number.isSafeInteger(sequence) || sequence < 1
        || sequence > ledger?.claimCount || sequences.has(sequence)
        || typeof actual.estimatedCredits !== "number" || !positive(actual.estimatedCredits)
        || !Number.isFinite(Date.parse(run.startedAt || ""))) plan.prepaid.valid = false;
      sequences.add(sequence);
      retainedClaimCredits += actual.estimatedCredits || 0;
    }
    const prepaidOwner = run.creditClaimAdmission?.allowed ? run.creditClaimAdmission : evidence;
    if (prepaidOwner.fundingMode === "prepaid"
      && (run.status === "running" || (run.status === "queued" && prepaidEligibleRun(run)))) {
      if (typeof prepaidOwner.estimatedCredits !== "number" || !positive(prepaidOwner.estimatedCredits)) plan.prepaid.valid = false;
      plan.prepaid.entries.push({ runId: run.id, taskId: run.taskId, index, running: run.status === "running",
        credits: prepaidOwner.estimatedCredits });
    }
    if (evidence.fallbackUsed !== true && actual.fallbackUsed !== true) continue;
    const attemptKey = actual.fallbackAttemptKey;
    if (actual.fallbackUsed && attemptKey && run.startedAt && run.attemptConsumed !== false) {
      plan.attempts.set(attemptKey, (plan.attempts.get(attemptKey) || 0) + 1);
    }
    if (run.creditClaimAdmission?.allowed && run.creditClaimAdmission.fallbackUsed === false) continue;
    const owns = run.status === "running" || (run.status === "queued" && eligibleRun(run));
    if (!owns) continue;
    const effective = run.creditClaimAdmission?.fallbackUsed ? run.creditClaimAdmission : evidence;
    if (!TIERS.has(effective.tier) || !positive(effective.estimatedTokensPerRun)) { plan.invalid += 1; continue; }
    const bucket = plan.buckets.get(effective.tier) || emptyBucket();
    const entry = { runId: run.id, taskId: run.taskId, index, running: run.status === "running",
      tokens: Number(effective.estimatedTokensPerRun) };
    bucket.entries.push(entry);
    bucket.ownedRuns += 1;
    bucket.ownedTokens += entry.tokens;
    plan.buckets.set(effective.tier, bucket);
  }
  if (retainedClaimCredits > plan.prepaid.committedCredits) plan.prepaid.valid = false;
  plan.nextIndex = (state.runs || []).length;
  return plan;
}

function prepaidCounters(plan, input) {
  const prepaid = plan.prepaid;
  const own = prepaid.entries.find(entry => entry.runId === input.claimRunId);
  const cutoff = own?.index ?? input.claimIndex ?? plan.nextIndex;
  const entries = prepaid.entries.filter(entry => !input.claimRunId || (entry.runId !== input.claimRunId
    && (entry.running || entry.index <= cutoff)));
  const queuedCredits = entries.filter(entry => !entry.running).reduce((sum, entry) => sum + entry.credits, 0);
  return { activeRuns: entries.length, selectedRuns: prepaid.selectedRuns,
    reservedRuns: entries.length + prepaid.selectedRuns, committedEstimatedCredits: prepaid.committedCredits,
    queuedEstimatedCredits: queuedCredits, selectedEstimatedCredits: prepaid.selectedCredits,
    reservedEstimatedCredits: prepaid.committedCredits + queuedCredits + prepaid.selectedCredits,
    prepaidClaimCount: prepaid.claimCount };
}

function assessPrepaidReservation(admission, plan, input) {
  const observedCounters = prepaidCounters(plan, input);
  const evidence = { ...admission, decision: admission.allowed ? "allowed" : "blocked", observedCounters,
    reservationBinding: { schemaVersion: 1, taskId: input.taskId || "", runId: input.claimRunId || "",
      policyVersion: admission.policyVersion, ruleId: admission.ruleId } };
  let code = "";
  if (!plan.prepaid.valid) code = "prepaid_ledger_invalid";
  else if (observedCounters.reservedRuns >= admission.maxConcurrentRuns) code = "prepaid_concurrency_exhausted";
  else if (observedCounters.reservedEstimatedCredits + admission.estimatedCredits > admission.prepaidCreditLimit) code = "prepaid_allowance_exhausted";
  return sanitizedCreditAdmission(code && admission.allowed ? { ...evidence, allowed: false, decision: "blocked", code, reasonCode: code } : evidence);
}

function observedCounters(plan, admission, input) {
  const bucket = plan.buckets.get(admission.tier) || emptyBucket();
  let activeRuns = bucket.ownedRuns, activeEstimatedTokens = bucket.ownedTokens;
  if (input.claimRunId) {
    const own = bucket.entries.find(entry => entry.runId === input.claimRunId);
    const cutoff = own?.index ?? input.claimIndex ?? plan.nextIndex;
    for (const entry of bucket.entries) {
      if (entry.runId === input.claimRunId || (!entry.running && entry.index > cutoff)) {
        activeRuns -= 1; activeEstimatedTokens -= entry.tokens;
      }
    }
  }
  const attemptsConsumed = plan.attempts.get(input.attemptKey) || 0;
  return { activeRuns, selectedRuns: bucket.selectedRuns, reservedRuns: activeRuns + bucket.selectedRuns,
    activeEstimatedTokens, selectedEstimatedTokens: bucket.selectedTokens,
    reservedEstimatedTokens: activeEstimatedTokens + bucket.selectedTokens, attemptsConsumed };
}

/** Tier/rule decisions remain in assessCreditAdmission; this enforces ownership. */
export function assessCreditReservation(admission, plan, input = {}) {
  if (admission.fundingMode === "prepaid") return assessPrepaidReservation(admission, plan, input);
  if (!admission.fallbackUsed) return admission;
  const observed = observedCounters(plan, admission, input);
  const evidence = { ...admission, decision: admission.allowed ? "allowed" : "blocked",
    fallbackAttemptKey: input.attemptKey, observedCounters: observed,
    reservationBinding: { schemaVersion: 1, taskId: input.taskId || "", runId: input.claimRunId || "",
      policyVersion: admission.policyVersion, ruleId: admission.ruleId },
    retryEvidence: input.retryEvidence || { attempted: false, attemptCount: 0 } };
  if (!admission.allowed) return sanitizedCreditAdmission(evidence);
  let code = "";
  if (plan.invalid) code = "fallback_reservation_invalid";
  else if (observed.attemptsConsumed >= admission.maxAttempts) code = "fallback_attempt_budget_exhausted";
  else if (observed.reservedRuns >= admission.maxConcurrentRuns) code = "fallback_concurrency_exhausted";
  else if (observed.reservedEstimatedTokens + admission.estimatedTokensPerRun > admission.maxInFlightEstimatedTokens) {
    code = "fallback_token_reservation_exhausted";
  }
  return sanitizedCreditAdmission(code ? { ...evidence, allowed: false, decision: "blocked", code, reasonCode: code,
    reason: "Configured bounded credit admission has no remaining reservation for this work." } : evidence);
}

export function reserveCreditSelection(plan, admission) {
  if (admission?.fundingMode === "prepaid" && admission.allowed) {
    plan.prepaid.selectedRuns += 1; plan.prepaid.selectedCredits += admission.estimatedCredits;
    return;
  }
  if (!admission?.fallbackUsed || !admission.allowed) return;
  const bucket = plan.buckets.get(admission.tier) || emptyBucket();
  bucket.selectedRuns += 1;
  bucket.selectedTokens += admission.estimatedTokensPerRun;
  plan.buckets.set(admission.tier, bucket);
}

export function releaseQueuedCreditReservation(plan, runId) {
  plan.prepaid.entries = plan.prepaid.entries.filter(entry => entry.runId !== runId || entry.running);
  for (const bucket of plan.buckets.values()) {
    const entry = bucket.entries.find(item => item.runId === runId && !item.running);
    if (!entry) continue;
    bucket.entries = bucket.entries.filter(item => item !== entry);
    bucket.ownedRuns -= 1; bucket.ownedTokens -= entry.tokens;
  }
}

export function recordCreditClaim(plan, run, admission) {
  releaseQueuedCreditReservation(plan, run.id);
  if (admission?.fundingMode === "prepaid" && admission.allowed) {
    plan.prepaid.committedCredits += admission.estimatedCredits;
    plan.prepaid.claimCount += 1;
    plan.prepaid.entries.push({ runId: run.id, taskId: run.taskId, index: plan.nextIndex++, running: true,
      credits: admission.estimatedCredits });
    return;
  }
  if (!admission?.fallbackUsed || !admission.allowed) return;
  const bucket = plan.buckets.get(admission.tier) || emptyBucket();
  bucket.entries.push({ runId: run.id, taskId: run.taskId, index: plan.nextIndex++, running: true,
    tokens: admission.estimatedTokensPerRun });
  bucket.ownedRuns += 1; bucket.ownedTokens += admission.estimatedTokensPerRun;
  plan.buckets.set(admission.tier, bucket);
  plan.attempts.set(admission.fallbackAttemptKey, (plan.attempts.get(admission.fallbackAttemptKey) || 0) + 1);
}

/** Actual claim only: the shared provisional planner must never call this. */
export function commitPrepaidCreditClaimInState(state, run, admission, now) {
  if (admission?.fundingMode !== "prepaid") return admission;
  const present = Object.hasOwn(state.meta || {}, "prepaidCreditLedger");
  const previous = present ? state.meta.prepaidCreditLedger : emptyPrepaidLedger();
  const total = previous?.committedEstimatedCredits + admission.estimatedCredits;
  if (!admission.allowed || run.status !== "queued" || run.creditClaimAdmission?.fundingMode === "prepaid" || !validPrepaidCreditLedger(previous)
    || admission.observedCounters?.committedEstimatedCredits !== previous.committedEstimatedCredits
    || admission.observedCounters?.prepaidClaimCount !== previous.claimCount
    || !Number.isFinite(total) || total <= previous.committedEstimatedCredits || total > admission.prepaidCreditLimit
    || !Number.isSafeInteger(previous.claimCount + 1) || !Number.isFinite(Date.parse(now))) {
    throw new Error("Prepaid claim no longer matches the bounded cumulative ledger.");
  }
  const ledger = { schemaVersion: 1, committedEstimatedCredits: total,
    claimCount: previous.claimCount + 1, lastClaimedAt: now };
  state.meta ||= {};
  state.meta.prepaidCreditLedger = ledger;
  return sanitizedCreditAdmission({ ...admission, prepaidClaimSequence: ledger.claimCount,
    prepaidCommittedCreditsAfterClaim: total });
}
