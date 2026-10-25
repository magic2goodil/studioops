import {
  HostedRcContractError, hostedRcCanonicalJson, hostedRcDigest, normalizeHostedRcBinding,
  normalizeHostedRcEvidence, normalizeHostedRcObservation, normalizeHostedRcRuntime,
  rcArray, rcDigest, rcEnum, rcFail, rcId, rcInteger, rcNullable, rcObject, rcOrigin, rcSha, rcTime,
  verifyHostedRcProof, assertHostedRcKeyIndependence,
} from "./hosted-rc-evidence.js";

export const RELEASE_QA_POLICY_VERSION = "studioops.release-qa-policy.v1";
export const RELEASE_QUALIFICATION_VERSION = "studioops.release-qualification.v1";
export const RELEASE_QA_POLICY_V2 = "studioops.release-qa-policy.v2";
export const RELEASE_QUALIFICATION_V2 = "studioops.release-qualification.v2";
export const RELEASE_REVIEW_STAGES_VERSION = "studioops.release-review-stages.v1";
const positive = (v) => rcInteger(v) > 0 ? v : rcFail();
const stageId = (v) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v) ? v : rcFail();
export function normalizeReleaseReviewStages(value) {
  const result = rcObject(value, { schemaVersion: rcEnum(RELEASE_REVIEW_STAGES_VERSION),
    tasks: rcArray((task) => rcObject(task, {taskId: rcId, stages: rcArray((stage) => rcObject(stage, {
      stageId, workflowRequired: (v) => typeof v === "boolean" ? v : rcFail(), disposition: rcEnum("required", "not_applicable"), dispositionDigest: rcNullable(rcDigest),
    }), 32)}), 32) });
  if (!result.tasks.length || result.tasks.reduce((n,t) => n + t.stages.length,0) > 128
    || new Set(result.tasks.map(t => t.taskId)).size !== result.tasks.length) rcFail();
  for (const task of result.tasks) {
    if (new Set(task.stages.map(s => s.stageId)).size !== task.stages.length
      || ["backend", "lead"].some(id => !task.stages.some(s => s.stageId === id && s.disposition === "required" && s.workflowRequired))) rcFail();
    for (const stage of task.stages) if ((stage.disposition === "required") !== (stage.dispositionDigest === null)
      || (!stage.workflowRequired && stage.disposition !== "not_applicable")) rcFail();
    task.stages.sort((a,b) => a.stageId < b.stageId ? -1 : a.stageId > b.stageId ? 1 : 0);
  }
  result.tasks.sort((a,b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  return result;
}

export function normalizeReleaseQaPolicy(value) {
  hostedRcCanonicalJson(value);
  const v2 = value?.schemaVersion === RELEASE_QA_POLICY_V2;
  const policy = rcObject(value, {
    schemaVersion: rcEnum(RELEASE_QA_POLICY_VERSION, RELEASE_QA_POLICY_V2), projectId: rcId, revision: positive,
    applicability: rcEnum("web", "service", "native", "non_deployable", "unknown"),
    applicabilityReview: rcNullable((v) => rcObject(v, { actorId: rcId, reasonId: rcId })),
    allowedOrigins: rcArray(rcOrigin, 16), allowedPrivateOrigins: rcArray(rcOrigin, 16),
    allowedDistributionIds: rcArray(rcId, 16), approvedDataSourceId: rcId,
    approvedSnapshotModes: rcArray(rcEnum("production_copy", "masked_copy", "representative"), 3),
    environmentContractDigest: rcDigest, runtime: normalizeHostedRcRuntime,
    requiredDevices: rcArray((v) => rcObject(v, { id: rcId, kind: rcEnum("physical", "simulated") }), 16),
    requiredScenarios: rcArray(rcId, 32),
    ...(v2 ? {reviewStages: normalizeReleaseReviewStages} : {requiredReviewRoles: rcArray(rcEnum("backend", "frontend", "lead"), 3)}),
    maxEvidenceAgeMs: positive, maxSnapshotAgeMs: positive, maxObservationAgeMs: positive,
    isolationPolicyDigest: rcDigest,
  });
  if (policy.maxEvidenceAgeMs > 30 * 86400000 || policy.maxSnapshotAgeMs > 30 * 86400000
    || policy.maxObservationAgeMs > 300000 || (!v2 && (!policy.requiredReviewRoles.includes("lead") || !policy.requiredReviewRoles.includes("backend"))) || !policy.requiredDevices.length
    || !policy.requiredScenarios.length || !policy.approvedSnapshotModes.length
    || policy.allowedPrivateOrigins.some((origin) => !policy.allowedOrigins.includes(origin))) rcFail();
  return policy;
}
const reviewForVersion = (v2) => (v) => rcObject(v, { id: rcId, taskId: rcId, actorId: rcId,
  role: v2 ? stageId : rcEnum("backend", "frontend", "lead"), cycle: positive, subjectSha: rcSha,
  outcome: v2 ? rcEnum("approved", "failed", "revoked", "skipped") : rcEnum("approved", "failed", "revoked"), evidenceDigest: rcDigest });
const review = reviewForVersion(false);
export function normalizeReleaseDecisionObservation(v) {
  const v2 = v?.schemaVersion === "studioops.release-decision-observation.v2";
  const result = rcObject(v, { schemaVersion: rcEnum("studioops.release-decision-observation.v1", "studioops.release-decision-observation.v2"),
    binding: normalizeHostedRcBinding, inputsDigest: rcDigest, evidenceDigest: rcDigest, policyDigest: rcDigest,
    ownerPacketDigest: rcDigest, decisionDigest: rcDigest, actorId: rcId,
    outcome: rcEnum("approved", "failed", "revoked"), revocationGeneration: rcInteger,
    reviews: rcArray(reviewForVersion(v2), v2 ? 128 : 32), decidedAt: rcTime });
  hostedRcCanonicalJson(result);
  return result;
}
export function normalizeReleaseQualification(v) {
  return rcObject(v, { schemaVersion: rcEnum(RELEASE_QUALIFICATION_VERSION, RELEASE_QUALIFICATION_V2), binding: normalizeHostedRcBinding,
    evidenceDigest: rcDigest, policyDigest: rcDigest, inputsDigest: rcDigest, observationDigest: rcDigest,
    ownerPacketDigest: rcDigest, decisionDigest: rcDigest, reviewsDigest: rcDigest,
    revocationGeneration: rcInteger, qualifiedAt: rcTime, expiresAt: rcTime });
}
function equal(a, b, code) { if (hostedRcCanonicalJson(a) !== hostedRcCanonicalJson(b)) rcFail(code); }
function compareBinding(a, b) {
  for (const field of ["projectId", "repository", "sourceSha", "integrationSha", "artifactDigest", "provenanceDigest",
    "candidateId", "manifestDigest", "ownershipDigest", "fullRegressionDigest"]) {
    const code = ({ projectId: "project_mismatch", repository: "repository_mismatch", sourceSha: "source_mismatch",
      integrationSha: "source_mismatch", artifactDigest: "artifact_mismatch", provenanceDigest: "artifact_mismatch" })[field] || "candidate_mismatch";
    equal(a[field], b[field], code);
  }
}
function fresh(at, now, age, code) {
  const time = Date.parse(at);
  if (time > now || now - time > age) rcFail(code);
}

/** Immutable packet INPUTS. The final receipt is intentionally absent, avoiding a decision/packet hash cycle. */
function assertStageCoverage(stages, reviews) {
  const expected = stages.tasks.flatMap(t => t.stages.map(s => ({...s, taskId:t.taskId})));
  if (expected.length !== reviews.length) rcFail("review_changed");
  for (const item of expected) {
    const matches = reviews.filter(r => r.taskId === item.taskId && r.role === item.stageId);
    if (matches.length !== 1) rcFail("review_changed");
    const row = matches[0];
    if (item.disposition === "not_applicable") {
      if (row.outcome !== "skipped" || row.evidenceDigest !== item.dispositionDigest) rcFail("review_changed");
    } else if (row.outcome === "skipped") rcFail("review_changed");
  }
}

function assertCurrentReviewStages(policy, context) {
  const v2 = policy.schemaVersion === RELEASE_QA_POLICY_V2;
  if (!v2 && !context.currentReviewStages) return;
  const stages = normalizeReleaseReviewStages(context.currentReviewStages);
  const subjects = rcArray((v) => rcObject(v, {taskId:rcId,subjectSha:rcSha,cycle:positive}),32)(context.reviewSubjects);
  equal(stages.tasks.map(t => t.taskId).sort(),subjects.map(s => s.taskId).sort(),"review_changed");
  if (v2) equal(policy.reviewStages,stages,"review_changed");
  else if (stages.tasks.some(t => t.stages.some(s => s.disposition !== "required" || !["backend","frontend","lead"].includes(s.stageId)))) rcFail("review_changed");
  assertStageCoverage(stages,rcArray(reviewForVersion(v2),v2 ? 128 : 32)(context.currentReviews));
}

export function releaseQualificationInputs({ binding, evidenceDigest, policyDigest, revocationGeneration, reviews, reviewStages }) {
  const v2 = reviewStages !== undefined;
  const rows = rcArray(reviewForVersion(v2), v2 ? 128 : 32)(reviews);
  const stages = v2 ? normalizeReleaseReviewStages(reviewStages) : null;
  if (stages) assertStageCoverage(stages, rows);
  const result = { schemaVersion: v2 ? "studioops.release-qualification-inputs.v2" : "studioops.release-qualification-inputs.v1",
    binding: normalizeHostedRcBinding(binding), evidenceDigest: rcDigest(evidenceDigest), policyDigest: rcDigest(policyDigest),
    revocationGeneration: rcInteger(revocationGeneration), reviews: rows, ...(v2 ? {reviewStages: stages} : {}) };
  hostedRcCanonicalJson(result);
  return result;
}

/**
 * All fields of context are supplied by an approved IO adapter, never copied from a request body.
 * Key allowlists authenticate producer/policy/independent observation channels. Expected bindings,
 * clock, live reviews and revocation generation come from current authoritative state.
 * A signed envelope alone cannot replace a separate current hosted identity/isolation observation.
 */
export function assertHostedRcEvidence(input, context) {
  assertHostedRcKeyIndependence(context);
  if (!input?.evidence) rcFail("evidence_missing");
  if (!context) rcFail("authority_required");
  const evidence = normalizeHostedRcEvidence(input.evidence);
  const policy = normalizeReleaseQaPolicy(context.policy);
  assertCurrentReviewStages(policy,context);
  const policyDigest = hostedRcDigest(policy);
  const binding = normalizeHostedRcBinding(context.binding);
  const now = Date.parse(rcTime(context.now));
  verifyHostedRcProof("policy", policy, context.policyProof, context.policyKeys, "untrusted_policy");
  if (["unknown", "non_deployable"].includes(policy.applicability)) rcFail("applicability_unknown");
  equal(policy.projectId, binding.projectId, "project_mismatch");
  equal(evidence.policyDigest, policyDigest, "policy_mismatch");
  compareBinding(evidence.binding, binding);
  verifyHostedRcProof("evidence", evidence, input.proof, context.producerKeys, "untrusted_producer");
  equal(evidence.producer.keyId, input.proof.keyId, "untrusted_producer");
  if (!context.approvedProducerIds?.includes(evidence.producer.id)) rcFail("untrusted_producer");
  fresh(evidence.capturedAt, now, policy.maxEvidenceAgeMs, "evidence_stale");
  if (Date.parse(evidence.expiresAt) <= now || Date.parse(evidence.expiresAt) <= Date.parse(evidence.capturedAt)
    || Date.parse(evidence.expiresAt) - Date.parse(evidence.capturedAt) > policy.maxEvidenceAgeMs) rcFail("evidence_stale");
  if (evidence.result !== "passed" || !evidence.evidenceDigests.length) rcFail("scenario_failed");
  const productionOrigins = rcArray(rcOrigin, 16)(context.productionOrigins);
  if (!policy.allowedOrigins.includes(evidence.environment.origin)
    || productionOrigins.includes(evidence.environment.origin)) rcFail("deployment_mismatch");
  equal(evidence.environment.deploymentId, context.deploymentId, "deployment_mismatch");
  equal(evidence.environment.environmentId, context.environmentId, "deployment_mismatch");
  equal(evidence.environment.contractDigest, policy.environmentContractDigest, "runtime_mismatch");
  equal(evidence.environment.runtime, policy.runtime, "runtime_mismatch");
  const snapshot = evidence.snapshot;
  if (snapshot.sourceId !== policy.approvedDataSourceId || !policy.approvedSnapshotModes.includes(snapshot.mode)) rcFail("snapshot_mismatch");
  equal(snapshot.fingerprint, context.snapshotFingerprint, "snapshot_mismatch");
  equal(snapshot.authorizationId, context.snapshotAuthorizationId, "snapshot_mismatch");
  fresh(snapshot.createdAt, now, policy.maxSnapshotAgeMs, "snapshot_stale");
  if (Date.parse(snapshot.restoredAt) < Date.parse(snapshot.createdAt)
    || Date.parse(snapshot.restoredAt) > Date.parse(evidence.capturedAt)
    || Date.parse(snapshot.retentionExpiresAt) <= now) rcFail("snapshot_stale");
  if (evidence.migration.result !== "passed") rcFail("migration_failed");
  equal(evidence.migration.planDigest, context.migrationPlanDigest, "migration_failed");
  for (const [name, control] of Object.entries(evidence.isolation)) {
    const allowed = ["secrets", "sessions", "writableContent"].includes(name) ? ["isolated"] : ["disabled", "sandbox"];
    if (!allowed.includes(control.mode)) rcFail("unsafe_isolation");
  }
  for (const item of evidence.scenarios) {
    if (item.result !== "passed" || item.authentication !== "normal") rcFail("scenario_failed");
  }
  for (const device of policy.requiredDevices) for (const id of policy.requiredScenarios) {
    if (!evidence.scenarios.some((v) => v.id === id && v.deviceId === device.id && v.deviceKind === device.kind)) rcFail("device_missing");
  }
  if (policy.applicability === "native") {
    if (!evidence.native || !policy.allowedDistributionIds.includes(evidence.native.distributionId)
      || evidence.native.backendOrigin !== evidence.environment.origin
      || evidence.native.backendArtifactDigest !== binding.artifactDigest
      || evidence.native.buildDigest !== context.nativeBuildDigest) rcFail("native_backend_mismatch");
  } else if (evidence.native !== null) rcFail("native_backend_mismatch");
  if (!context.observation?.payload) rcFail("untrusted_observation");
  const observation = normalizeHostedRcObservation(context.observation.payload);
  verifyHostedRcProof("observation", observation, context.observation?.proof, context.observerKeys);
  if (!context.approvedObserverIds?.includes(observation.observerId)
    || observation.observerId === evidence.producer.id || context.observation.proof.keyId === input.proof.keyId) rcFail("untrusted_observation");
  compareBinding(observation.binding, binding);
  equal(observation.evidenceDigest, hostedRcDigest(evidence), "candidate_mismatch");
  equal(observation.policyDigest, policyDigest, "policy_mismatch");
  fresh(observation.observedAt, now, policy.maxObservationAgeMs, "observation_stale");
  if (Date.parse(observation.observedAt) < Date.parse(evidence.capturedAt)) rcFail("observation_stale");
  for (const name of ["origin", "deploymentId", "environmentId"]) equal(observation[name], evidence.environment[name], "deployment_mismatch");
  if (observation.resolvedAddressClass === "private" && !policy.allowedPrivateOrigins.includes(observation.origin)) rcFail("deployment_mismatch");
  equal(observation.runtimeDigest, hostedRcDigest(evidence.environment.runtime), "runtime_mismatch");
  equal(observation.environmentContractDigest, evidence.environment.contractDigest, "runtime_mismatch");
  equal(observation.snapshotFingerprint, snapshot.fingerprint, "snapshot_mismatch");
  equal(observation.snapshotAuthorizationId, snapshot.authorizationId, "snapshot_mismatch");
  equal(observation.migrationDigest, hostedRcDigest(evidence.migration), "migration_failed");
  equal(observation.isolationDigest, hostedRcDigest(evidence.isolation), "unsafe_isolation");
  equal(observation.scenariosDigest, hostedRcDigest(evidence.scenarios), "scenario_failed");
  equal(observation.nativeDigest, hostedRcDigest(evidence.native), "native_backend_mismatch");
  return { evidence, policy, policyDigest, observation, evidenceDigest: hostedRcDigest(evidence) };
}

export function assertReleaseQualification(input, context) {
  const verified = assertHostedRcEvidence(input, context);
  const { evidence, policy, policyDigest, observation, evidenceDigest } = verified;
  if (!context.decision?.payload) rcFail("owner_decision_missing");
  const decision = normalizeReleaseDecisionObservation(context.decision.payload);
  verifyHostedRcProof("decision", decision, context.decision.proof, context.actorKeys, "untrusted_decision");
  if (!context.approvedOwnerIds?.includes(decision.actorId)) rcFail("untrusted_decision");
  const v2Decision = decision.schemaVersion === "studioops.release-decision-observation.v2";
  if (v2Decision !== (policy.schemaVersion === RELEASE_QA_POLICY_V2)) rcFail("policy_mismatch");
  compareBinding(decision.binding, evidence.binding);
  equal(decision.evidenceDigest, evidenceDigest, "candidate_mismatch");
  equal(decision.policyDigest, policyDigest, "policy_mismatch");
  equal(decision.ownerPacketDigest, context.ownerPacketDigest, "owner_decision_missing");
  equal(decision.decisionDigest, context.decisionDigest, "owner_decision_missing");
  if (decision.outcome !== "approved" || context.revoked === true) rcFail("revoked");
  equal(decision.revocationGeneration, rcInteger(context.revocationGeneration), "revoked");
  const v2 = policy.schemaVersion === RELEASE_QA_POLICY_V2;
  const reviews = rcArray(reviewForVersion(v2), v2 ? 128 : 32)(context.currentReviews);
  equal(decision.reviews, reviews, "review_changed");
  const subjects = rcArray((v) => rcObject(v, { taskId: rcId, subjectSha: rcSha, cycle: positive }), 32)(context.reviewSubjects);
  if (!subjects.length || new Set(subjects.map((s) => s.taskId)).size !== subjects.length) rcFail("review_changed");
  for (const item of reviews) {
    const subject = subjects.find((s) => s.taskId === item.taskId);
    if (!subject || !["approved", ...(v2 ? ["skipped"] : [])].includes(item.outcome) || item.subjectSha !== subject.subjectSha
      || item.cycle !== subject.cycle || [evidence.producer.id, decision.actorId].includes(item.actorId)) rcFail("review_changed");
  }
  if (new Set(reviews.map((r) => r.id)).size !== reviews.length) rcFail("review_changed");
  for (const subject of subjects) {
    const sourceReviews = reviews.filter((r) => r.taskId === subject.taskId && r.outcome === "approved");
    if (new Set(sourceReviews.map((r) => r.actorId)).size !== sourceReviews.length
      || (v2 ? ["backend", "lead"] : policy.requiredReviewRoles).some((role) => !sourceReviews.some((r) => r.role === role))) rcFail("review_changed");
  }
  const inputs = releaseQualificationInputs({ binding: evidence.binding, evidenceDigest, policyDigest,
    revocationGeneration: context.revocationGeneration, reviews, ...(v2 ? {reviewStages:policy.reviewStages} : {}) });
  equal(decision.inputsDigest, hostedRcDigest(inputs), "candidate_mismatch");
  if (Date.parse(decision.decidedAt) < Date.parse(evidence.capturedAt) || Date.parse(decision.decidedAt) > Date.parse(context.now)) rcFail("untrusted_decision");
  return normalizeReleaseQualification({ schemaVersion: v2 ? RELEASE_QUALIFICATION_V2 : RELEASE_QUALIFICATION_VERSION, binding: evidence.binding,
    evidenceDigest, policyDigest, inputsDigest: decision.inputsDigest, observationDigest: hostedRcDigest(observation),
    ownerPacketDigest: decision.ownerPacketDigest, decisionDigest: decision.decisionDigest,
    reviewsDigest: hostedRcDigest(reviews), revocationGeneration: context.revocationGeneration,
    qualifiedAt: rcTime(context.now), expiresAt: new Date(Math.min(Date.parse(evidence.expiresAt),
      Date.parse(observation.observedAt) + policy.maxObservationAgeMs, Date.parse(evidence.snapshot.createdAt) + policy.maxSnapshotAgeMs,
      Date.parse(evidence.snapshot.retentionExpiresAt))).toISOString() });
}
export function evaluateReleaseQualification(input, context) {
  try { return { eligible: true, reasons: ["qualified"], qualification: assertReleaseQualification(input, context) }; }
  catch (error) { return { eligible: false, reasons: [error instanceof HostedRcContractError ? error.code : "evidence_malformed"], qualification: null }; }
}

/** A closure owned by the trusted adapter/composition root. Request JSON cannot provide executable authority. */
export function createReleaseQualificationAuthority(resolveCurrentContext) {
  if (typeof resolveCurrentContext !== "function") rcFail("authority_required");
  return Object.freeze({
    verifyEvidence(input, coordinates) {
      return assertHostedRcEvidence(input, resolveCurrentContext(coordinates));
    },
    qualify(input, coordinates) {
      const context = resolveCurrentContext(coordinates);
      // Bind adapter review attestations to the exact persisted review rows read
      // inside the fenced transaction. Actor IDs are authenticated adapter IDs.
      if (!coordinates.candidate || !Array.isArray(coordinates.reviews)) rcFail("review_changed");
      equal(context.revocationGeneration, coordinates.record?.generation || 0, "revoked");
      const subjects = (coordinates.candidate.manifest.sources || []).map((s) => ({ taskId: s.taskId, subjectSha: s.headSha, cycle: s.candidateCycle }));
      equal(rcArray((v) => rcObject(v, { taskId: rcId, subjectSha: rcSha, cycle: positive }), 32)(context.reviewSubjects),
        rcArray((v) => rcObject(v, { taskId: rcId, subjectSha: rcSha, cycle: positive }), 32)(subjects), "review_changed");
      const v2 = context.policy?.schemaVersion === RELEASE_QA_POLICY_V2;
      const reviews = rcArray(reviewForVersion(v2), v2 ? 128 : 32)(context.currentReviews);
      if (reviews.length !== coordinates.reviews.length) rcFail("review_changed");
      for (const item of reviews) {
        const row = coordinates.reviews.find((r) => r.id === item.id);
        if (!row || row.taskId !== item.taskId || !(["approved", ...(v2 ? ["skipped"] : [])].includes(row.outcome)) || row.invalidatedAt || row.invalidation
          || row.outcome !== item.outcome || row.subjectSha !== item.subjectSha || row.candidateCycle !== item.cycle
          || row.stageKey !== item.role || hostedRcDigest(row) !== item.evidenceDigest) rcFail("review_changed");
      }
      return assertReleaseQualification(input, context);
    },
    verifyPolicy(input, coordinates) {
      const context = resolveCurrentContext(coordinates);
      const policy = normalizeReleaseQaPolicy(input.policy);
      verifyHostedRcProof("policy", policy, input.proof, context.policyKeys, "untrusted_policy");
      equal(policy.projectId, coordinates.project.id, "project_mismatch");
      return policy;
    },
    verifyRevocation(input, coordinates) {
      const context = resolveCurrentContext(coordinates);
      const payload = rcObject(input.payload, { id: rcId, projectId: rcId, candidateId: rcId,
        generation: positive, reason: rcEnum("owner_revoked", "policy_changed", "review_changed", "evidence_revoked", "environment_changed"),
        actorId: rcId, observedAt: rcTime });
      verifyHostedRcProof("revocation", payload, input.proof, context.actorKeys, "untrusted_decision");
      if (!context.approvedOwnerIds?.includes(payload.actorId)) rcFail("untrusted_decision");
      equal(payload.projectId, coordinates.project.id, "project_mismatch");
      equal(payload.candidateId, coordinates.candidate.id, "candidate_mismatch");
      fresh(payload.observedAt, Date.parse(rcTime(context.now)), 300000, "observation_stale");
      return payload;
    },
    normalizePolicy: normalizeReleaseQaPolicy,
    digest: hostedRcDigest,
  });
}

/** Applicability assessment is separate from a hosted qualification receipt. Unknown never passes. */
export function evaluateReleaseQaApplicability(value, context) {
  try {
    const policy = normalizeReleaseQaPolicy(value);
    verifyHostedRcProof("policy", policy, context.policyProof, context.policyKeys, "untrusted_policy");
    equal(policy.projectId, context.projectId, "project_mismatch");
    if (policy.applicability === "unknown") rcFail("applicability_unknown");
    if (policy.applicability === "non_deployable") {
      if (context.projectKind !== "non_deployable" || !policy.applicabilityReview
        || !context.approvedOwnerIds?.includes(policy.applicabilityReview.actorId)) rcFail("applicability_unknown");
      equal(policy.applicabilityReview, context.applicabilityReview, "applicability_unknown");
      return { applicable: false, reasons: ["not_applicable"] };
    }
    equal(policy.applicability, context.projectKind, "applicability_unknown");
    return { applicable: true, reasons: [] };
  } catch (error) {
    return { applicable: null, reasons: [error instanceof HostedRcContractError ? error.code : "evidence_malformed"] };
  }
}
