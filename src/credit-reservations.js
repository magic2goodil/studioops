import { sanitizedCreditAdmission } from "./credit-admission-evidence.js";
export { sanitizedCreditAdmission } from "./credit-admission-evidence.js";
import { createHash } from "node:crypto";
import { failureWorkIdentity, normalizeFailureProvider } from "./failure-containment.js";
import { freshHealthyCreditEvidence, creditExhaustionObservation, creditExhaustionBarrierMs } from "./credit-policy.js";

const TIERS = new Set(["mechanical", "economy", "balanced", "critical", "frontier"]);
const digest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function updateCreditExhaustionState(state, snapshot, { policy = {}, now = new Date().toISOString() } = {}) {
  const observation = creditExhaustionObservation(snapshot, now);
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
    state.meta.creditObservedExhaustion = prior?.active && !unresolved.includes(prior.reasonCode)
      ? { ...prior, latestBlockingObservedAt: observation.observedAt }
      : observation;
    return;
  }
  if (!prior?.active) return;
  const evidence = freshHealthyCreditEvidence(snapshot, policy, { evaluatedAt: now });
  if (evidence.healthyCapacity
    && Date.parse(evidence.snapshotObservedAt || "") > creditExhaustionBarrierMs(prior)) {
    state.meta.creditObservedExhaustion = { ...prior, active: false, clearedByFreshSnapshotAt: evidence.snapshotObservedAt };
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
export function createCreditReservationPlan(state, eligibleRun = () => true, incidents = []) {
  const plan = { buckets: new Map(), attempts: new Map(), incidentsByTask: new Map(), invalid: 0, nextIndex: 0 };
  for (const incident of incidents || []) {
    const rows = plan.incidentsByTask.get(incident.taskId) || [];
    rows.push(incident); plan.incidentsByTask.set(incident.taskId, rows);
  }
  for (const [index, run] of (state.runs || []).entries()) {
    const evidence = run.creditAdmission || {};
    const actual = run.creditClaimAdmission || evidence;
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
  plan.nextIndex = (state.runs || []).length;
  return plan;
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
  if (!admission?.fallbackUsed || !admission.allowed) return;
  const bucket = plan.buckets.get(admission.tier) || emptyBucket();
  bucket.selectedRuns += 1;
  bucket.selectedTokens += admission.estimatedTokensPerRun;
  plan.buckets.set(admission.tier, bucket);
}

export function releaseQueuedCreditReservation(plan, runId) {
  for (const bucket of plan.buckets.values()) {
    const entry = bucket.entries.find(item => item.runId === runId && !item.running);
    if (!entry) continue;
    bucket.entries = bucket.entries.filter(item => item !== entry);
    bucket.ownedRuns -= 1; bucket.ownedTokens -= entry.tokens;
  }
}

export function recordCreditClaim(plan, run, admission) {
  releaseQueuedCreditReservation(plan, run.id);
  if (!admission?.fallbackUsed || !admission.allowed) return;
  const bucket = plan.buckets.get(admission.tier) || emptyBucket();
  bucket.entries.push({ runId: run.id, taskId: run.taskId, index: plan.nextIndex++, running: true,
    tokens: admission.estimatedTokensPerRun });
  bucket.ownedRuns += 1; bucket.ownedTokens += admission.estimatedTokensPerRun;
  plan.buckets.set(admission.tier, bucket);
  plan.attempts.set(admission.fallbackAttemptKey, (plan.attempts.get(admission.fallbackAttemptKey) || 0) + 1);
}
