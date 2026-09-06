import { constants, openSync, fstatSync, readSync, closeSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  hostedRcCanonicalJson, hostedRcDigest, normalizeHostedRcBinding, rcDigest, rcEnum, assertHostedRcKeyIndependence,
  rcFail, rcId, rcObject, rcOrigin, rcRepository, rcSha, rcTime, verifyHostedRcProof,
} from "./hosted-rc-evidence.js";
import {
  assertHostedRcEvidence, createReleaseQualificationAuthority, normalizeReleaseDecisionObservation,
  normalizeReleaseQaPolicy, releaseQualificationInputs, normalizeReleaseReviewStages, RELEASE_QA_POLICY_V2,
} from "./release-qualification.js";
import { observeHostedRc } from "./hosted-rc-transport.js";
import { assertCandidateEnvelope } from "./candidate-manifest.js";
import { buildHostedOwnerQaPacket } from "./owner-qa-packet.js";
import { missionControlConfigRoot } from "./runtime-paths.js";
import {
  appendHostedRcEvidence, getReleaseQaPolicy, invalidateReleaseQualification,
  readHostedQaCoordinates, recordHostedRcOwnerPacket, recordReleaseQaPolicy, recordReleaseQualification,
  reviewStagesForTask, reviewStagesForProject, currentReviewCandidateCycle, latestCurrentReviewForStage, reviewMatchesCurrentCandidate,
} from "./store.js";

export const HOSTED_QA_TRUST_FILE = "hosted-qa-trust.json";
const absolutePath = (v) => typeof v === "string" && path.isAbsolute(v) && path.normalize(v) === v
  && !v.includes("\0") && v.length <= 1024 ? v : rcFail("deployment_mismatch");
export function normalizeHostedProductionTarget(value) {
  return rcObject(value, { projectId: rcId, repository: rcRepository,
    sourceSha: rcSha, artifactDigest: rcDigest, provenanceDigest: rcDigest, runtimeDigest: rcDigest, runtimeRoot: absolutePath });
}

/** Policy.environmentContractDigest authenticates this complete readiness contract.
 * The independent observer attests that these concrete backup/rollback artifacts
 * were verified, through the same environmentContractDigest in its live response. */
export function normalizeHostedDeploymentReadiness(value) {
  return rcObject(value, {
    schemaVersion: rcEnum("studioops.hosted-deployment-readiness.v1"),
    target: normalizeHostedProductionTarget,
    backup: (v) => rcObject(v, { id: rcId, artifactDigest: rcDigest, evidenceDigest: rcDigest,
      verifiedAt: rcTime, expiresAt: rcTime }),
    rollback: (v) => rcObject(v, { sourceSha: rcSha, artifactDigest: rcDigest,
      provenanceDigest: rcDigest, runtimeDigest: rcDigest, evidenceDigest: rcDigest,
      verifiedAt: rcTime, expiresAt: rcTime }),
    dataTransferMode: rcEnum("none"),
  });
}

function equal(a, b, code) { if (hostedRcCanonicalJson(a) !== hostedRcCanonicalJson(b)) rcFail(code); }
function readPrivateJson(filename) {
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1
      || stat.size > 65536) rcFail("authority_required");
    const buffer = Buffer.alloc(65537);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 65536) rcFail("payload_too_large");
    const content = buffer.subarray(0, bytes).toString("utf8");
    return JSON.parse(content);
  } catch (error) { rcFail(error.code === "ENOENT" ? "authority_required" : "evidence_malformed"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function loadTrust(projectId, candidateId) {
  let root;
  try { root = realpathSync(missionControlConfigRoot()); } catch { rcFail("authority_required"); }
  const filename = path.join(root, HOSTED_QA_TRUST_FILE);
  const config = readPrivateJson(filename);
  if (config.schemaVersion !== "studioops.hosted-qa-trust.v1") rcFail("authority_required");
  const trust = config.projects?.[projectId];
  const deployment = trust?.deployments?.[candidateId];
  if (!trust || !deployment) rcFail("authority_required");
  assertHostedRcKeyIndependence(trust);
  // No keys, policy, expected identities, network allowlists or callbacks are
  // accepted from imported evidence or CLI options.
  return { filename, digest: hostedRcDigest(config), trust, deployment };
}

function currentReviews(coordinates, trust) {
  return coordinates.reviews.map((row) => {
    const actorId = trust.reviewActors?.[row.actorId || row.author];
    if (!actorId) rcFail("review_changed");
    return { id: row.id, taskId: row.taskId, actorId, role: row.stageKey, cycle: row.candidateCycle,
      subjectSha: row.subjectSha, outcome: row.invalidatedAt || row.invalidation ? "revoked" : row.outcome,
      evidenceDigest: hostedRcDigest(row) };
  });
}

function currentStageContract(coordinates) {
  const {project, candidate, tasks, currentReviews: live} = coordinates;
  const sources = candidate.manifest.sources;
  if (!Array.isArray(tasks) || !Array.isArray(live) || tasks.length !== sources.length
    || new Set(tasks.map(t => t.id)).size !== tasks.length || live.length > 128
    || new Set(live.map(r => r.id)).size !== live.length) rcFail("review_changed");
  const known = reviewStagesForProject(project);
  if (known.length > 32 || new Set(known.map(s => s.key)).size !== known.length) rcFail("review_changed");
  const mapped = sources.map(source => {
    const task = tasks.find(t => t.id === source.taskId);
    if (!task || task.projectId !== project.id || task.reviewSubjectSha !== source.headSha
      || currentReviewCandidateCycle(task) !== source.candidateCycle || task.candidateId !== candidate.id) rcFail("review_changed");
    const required = reviewStagesForTask(project, task).filter(s => s.required !== false);
    const rows = coordinates.reviews.filter(r => r.taskId === task.id);
    const keys = [...new Set([...required.map(s => s.key), ...rows.map(r => r.stageKey)])];
    return {taskId:task.id, stages:keys.map(key => {
      const stage = known.find(s => s.key === key);
      if (!stage) rcFail("review_changed");
      const row = rows.find(r => r.stageKey === key);
      const latest = latestCurrentReviewForStage({reviews:live}, task, stage);
      if (!row || !latest || latest.id !== row.id || hostedRcDigest(latest) !== hostedRcDigest(row)
        || rows.filter(r => r.stageKey === key).length !== 1) rcFail("review_changed");
      // Equal-time replacements have no authoritative ordering in the public
      // workflow selector. Fail closed rather than choosing the old manifest ID.
      if (live.some(r => r.id !== row.id && r.stageKey === key && r.createdAt === row.createdAt
        && r.taskId === task.id && reviewMatchesCurrentCandidate(task,r))) rcFail("review_changed");
      if (!required.some(s => s.key === key) && row.outcome !== "skipped") rcFail("review_changed");
      return {stageId:key, workflowRequired:required.some(s => s.key === key), disposition:row.outcome === "skipped" ? "not_applicable" : "required",
        dispositionDigest:row.outcome === "skipped" ? hostedRcDigest(row) : null};
    })};
  });
  return normalizeReleaseReviewStages({schemaVersion:"studioops.release-review-stages.v1",tasks:mapped});
}

function contextFor(prepared, coordinates, decisionOverride = null) {
  const { trust, deployment } = prepared;
  const { project, candidate, reviews } = coordinates;
  if (!project || !candidate || !reviews) rcFail("authority_required");
  assertCandidateEnvelope(candidate);
  const currentTrust = loadTrust(project.id, candidate.id);
  if (currentTrust.digest !== prepared.digest) rcFail("policy_mismatch");
  const storedPolicy = project.hostedRc?.policies.at(-1);
  if (!storedPolicy || project.hostedRc.activePolicyDigest !== hostedRcDigest(storedPolicy.policy)) rcFail("policy_mismatch");
  const policy = normalizeReleaseQaPolicy(storedPolicy.policy);
  const binding = normalizeHostedRcBinding(deployment.binding);
  equal(binding.projectId, project.id, "project_mismatch");
  equal(binding.candidateId, candidate.id, "candidate_mismatch");
  equal(binding.repository, rcRepository(project.repoUrl), "repository_mismatch");
  equal(binding.manifestDigest, candidate.manifestDigest, "candidate_mismatch");
  equal(binding.integrationSha, candidate.manifest.integration.sha, "source_mismatch");
  equal(binding.sourceSha, binding.integrationSha, "source_mismatch");
  const readiness = normalizeHostedDeploymentReadiness(deployment.readiness);
  equal(hostedRcDigest(readiness), policy.environmentContractDigest, "runtime_mismatch");
  const target = readiness.target;
  for (const field of ["projectId", "repository", "sourceSha", "artifactDigest", "provenanceDigest"]) {
    equal(target[field], binding[field], "artifact_mismatch");
  }
  equal(target.runtimeDigest, policy.runtime.runtimeDigest, "runtime_mismatch");
  if (prepared.productionTarget) equal(target, normalizeHostedProductionTarget(prepared.productionTarget), "artifact_mismatch");
  const now = new Date().toISOString();
  for (const item of [readiness.backup, readiness.rollback]) {
    if (Date.parse(item.verifiedAt) > Date.parse(now) || Date.parse(item.expiresAt) <= Date.parse(now)
      || Date.parse(now) - Date.parse(item.verifiedAt) > policy.maxEvidenceAgeMs) rcFail("evidence_stale");
  }
  const packet = candidate.hostedRc?.packets?.at(-1)?.packet;
  const decision = decisionOverride || candidate.hostedRc?.qualifications.at(-1)?.decisionObservation || null;
  return {
    ...trust, ...deployment, binding, policy, policyProof: storedPolicy.proof, now,
    observation: prepared.observation, decision, readiness,
    ownerPacketDigest: packet?.packetDigest || "",
    decisionDigest: candidate.qaDecision ? hostedRcDigest(candidate.qaDecision) : "",
    revocationGeneration: candidate.hostedRc?.generation || 0,
    revoked: Boolean(candidate.invalidation || candidate.qaRevocationIntent || candidate.qaRevocationSettlement),
    reviewSubjects: candidate.manifest.sources.map((s) => ({ taskId: s.taskId, subjectSha: s.headSha, cycle: s.candidateCycle })),
    currentReviews: currentReviews(coordinates, trust),
    currentReviewStages: currentStageContract(coordinates),
  };
}

function makeAuthority(prepared, decisionOverride = null) {
  const resolve = (coordinates) => contextFor(prepared, coordinates, decisionOverride);
  const base = createReleaseQualificationAuthority(resolve);
  return Object.freeze({ ...base,
    ownerPacket(input, coordinates) {
      const context = resolve(coordinates);
      const verified = assertHostedRcEvidence(input, context);
      const inputs = releaseQualificationInputs({ binding: context.binding, evidenceDigest: verified.evidenceDigest,
        policyDigest: verified.policyDigest, revocationGeneration: context.revocationGeneration, reviews: context.currentReviews,
        ...(context.policy.schemaVersion === RELEASE_QA_POLICY_V2 ? {reviewStages:context.policy.reviewStages} : {}) });
      return buildHostedOwnerQaPacket(coordinates.candidate, inputs, context.readiness, verified.evidence);
    },
    decisionObservation(coordinates) { return structuredClone(resolve(coordinates).decision); },
    hostedObservation() { return structuredClone(prepared.observation); },
  });
}

async function prepare(projectId, candidateId, productionTarget = null) {
  rcId(projectId); rcId(candidateId);
  const prepared = { ...loadTrust(projectId, candidateId), productionTarget: productionTarget ? structuredClone(productionTarget) : null };
  const coordinates = await readHostedQaCoordinates(projectId, candidateId);
  const policy = coordinates.project.hostedRc?.policies.at(-1)?.policy;
  if (!policy) rcFail("authority_required");
  const context = contextFor(prepared, coordinates);
  verifyHostedRcProof("policy", context.policy, context.policyProof, context.policyKeys, "untrusted_policy");
  prepared.observation = await observeHostedRc({ origin: rcOrigin(prepared.deployment.origin), policy: context.policy,
    productionOrigins: context.productionOrigins, observerKeys: context.observerKeys,
    certificateAuthorityPem: context.certificateAuthorityPem });
  return prepared;
}

/** Approved composition port. The returned closure is process-local executable
 * authority, never a serializable receipt or a caller-supplied approval callback. */
export async function prepareHostedQaAdmission({ projectId, candidateId, productionTarget = null }) {
  const prepared = await prepare(projectId, candidateId, productionTarget);
  const authority = makeAuthority(prepared);
  const coordinates = await readHostedQaCoordinates(projectId, candidateId);
  const saved = coordinates.candidate.hostedRc?.qualifications.at(-1);
  if (!saved?.decisionObservation) rcFail("qualification_missing");
  const input = coordinates.candidate.hostedRc.evidence.find((e) => e.digest === saved.qualification.evidenceDigest);
  if (!input) rcFail("evidence_missing");
  const assertCurrent = (current) => {
    const candidate = current.candidate;
    const receipt = candidate.hostedRc?.qualifications.at(-1);
    equal(receipt?.digest, saved.digest, "revoked");
    const currentInput = candidate.hostedRc.evidence.find((e) => e.digest === input.digest);
    equal(currentInput, input, "candidate_mismatch");
    equal(candidate.hostedRc.packets?.at(-1)?.packet,
      authority.ownerPacket(currentInput, current), "candidate_mismatch");
    if (candidate.qaDecision?.outcome !== "passed") rcFail("owner_decision_missing");
    return authority.qualify(currentInput, current);
  };
  const qualification = assertCurrent(coordinates);
  return Object.freeze({ authority, input: structuredClone(input), qualification,
    contractDigest: prepared.digest, assertCurrent,
    assertRollback(actual) {
      const { sourceSha, artifactDigest, provenanceDigest, runtimeDigest } = prepared.deployment.readiness.rollback;
      equal(actual, { sourceSha, artifactDigest, provenanceDigest, runtimeDigest }, "artifact_mismatch");
    },
  });
}

export function hostedQaCoordinatesFromState(state, candidateId) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) rcFail("candidate_mismatch");
  const ids = new Set(candidate.manifest.sources.flatMap((s) => s.reviews.map((r) => r.id)));
  return { candidate, project: state.projects.find((p) => p.id === candidate.projectId),
    tasks: state.tasks.filter((t) => candidate.manifest.sources.some((s) => s.taskId === t.id)),
    currentReviews: state.reviews.filter((r) => candidate.manifest.sources.some((s) => s.taskId === r.taskId
      && s.headSha === r.subjectSha && s.candidateCycle === r.candidateCycle)),
    reviews: state.reviews.filter((r) => ids.has(r.id)), record: candidate.hostedRc || null };
}

/** Imported files are bounded signed statements. They never supply trust config. */
export async function runHostedQaCommand({ action, projectId, candidateId, file }) {
  if (action === "status") {
    const coordinates = await readHostedQaCoordinates(projectId, candidateId);
    return hostedQaStatus({...coordinates,includeReviewStages:true});
  }
  const imported = file ? readPrivateJson(file) : null;
  if (action === "policy") {
    const prepared = loadTrust(projectId, candidateId);
    const authority = createReleaseQualificationAuthority(() => prepared.trust);
    const current = await getReleaseQaPolicy(projectId);
    return recordReleaseQaPolicy({ projectId, expectedVersion: current.version,
      policy: imported?.policy, proof: imported?.proof }, authority);
  }
  if (action === "revoke") {
    const prepared = loadTrust(projectId, candidateId);
    const authority = createReleaseQualificationAuthority(() => ({ ...prepared.trust, now: new Date().toISOString() }));
    const current = await readHostedQaCoordinates(projectId, candidateId);
    return invalidateReleaseQualification({ projectId, candidateId, expectedVersion: current.candidate.hostedRc?.version || 0,
      payload: imported?.payload, proof: imported?.proof }, authority);
  }
  if (action === "verify") {
    const admission = await prepareHostedQaAdmission({ projectId, candidateId });
    return { status: "qualified", qualification: admission.qualification };
  }
  const prepared = await prepare(projectId, candidateId);
  const authority = makeAuthority(prepared, action === "decide" ? imported : null);
  let coordinates = await readHostedQaCoordinates(projectId, candidateId);
  if (action === "collect") {
    const result = await appendHostedRcEvidence({ projectId, candidateId, expectedVersion: coordinates.candidate.hostedRc?.version || 0,
      evidence: imported?.evidence, proof: imported?.proof }, authority);
    coordinates = await readHostedQaCoordinates(projectId, candidateId);
    const packet = await recordHostedRcOwnerPacket({ projectId, candidateId, expectedVersion: coordinates.candidate.hostedRc.version,
      evidenceDigest: result.evidenceDigest }, authority);
    return { ...result, ...packet, status: "collecting" };
  }
  if (action === "decide") {
    const decision = normalizeReleaseDecisionObservation(imported?.payload);
    return recordReleaseQualification({ projectId, candidateId, expectedVersion: coordinates.candidate.hostedRc.version,
      evidenceDigest: decision.evidenceDigest }, authority);
  }
  rcFail("evidence_malformed");
}

/** Bounded display only. A fresh prepareHostedQaAdmission remains mandatory. */
export function hostedQaStatus({ project, candidate, reviews = [], tasks = [], currentReviews = reviews, includeReviewStages = false }, nowMs = Date.now()) {
  const record = candidate?.hostedRc;
  const evidence = record?.evidence.at(-1)?.evidence;
  const receipt = record?.qualifications.at(-1)?.qualification;
  let currentStages = null;
  try {
    const sources = candidate.manifest.sources;
    const ids = new Set(sources.flatMap(s => s.reviews.map(r => r.id)));
    currentStages = currentStageContract({project,candidate,tasks:tasks.filter(t => sources.some(s => s.taskId === t.id)),
      reviews:reviews.filter(r => ids.has(r.id)),currentReviews:currentReviews.filter(r => sources.some(s =>
        s.taskId === r.taskId && s.headSha === r.subjectSha && s.candidateCycle === r.candidateCycle))});
  } catch { /* Diagnostic absence never supplies authority. */ }
  let status = "collecting", reason = "owner_decision_missing";
  if (!project?.hostedRc?.activePolicyDigest || !evidence) { status = "setup_missing"; reason = "evidence_missing"; }
  else if (candidate.invalidation || candidate.qaRevocationIntent || candidate.qaRevocationSettlement
    || (record.generation && (!receipt || receipt.revocationGeneration !== record.generation))) { status = "revoked"; reason = "revoked"; }
  else if (candidate.qaDecision?.outcome === "failed" || evidence.result !== "passed") { status = "failed"; reason = "scenario_failed"; }
  else if (evidence.policyDigest !== project.hostedRc.activePolicyDigest || Date.parse(evidence.expiresAt) <= nowMs
    || (receipt && Date.parse(receipt.expiresAt) <= nowMs)) { status = "stale"; reason = "evidence_stale"; }
  else if (receipt) {
    const signed = record.qualifications.at(-1).decisionObservation?.payload;
    let changed = !signed || !candidate.qaDecision || (signed.reviews || []).some((r) => {
      const row = reviews.find((v) => v.id === r.id);
      return !row || hostedRcDigest(row) !== r.evidenceDigest;
    }) || signed.decisionDigest !== hostedRcDigest(candidate.qaDecision)
      || signed.ownerPacketDigest !== record.packets?.at(-1)?.packet.packetDigest;
    const priorStages = record.packets?.at(-1)?.packet.inputs.reviewStages;
    if (!currentStages || (priorStages && hostedRcDigest(priorStages) !== hostedRcDigest(currentStages))) changed = true;
    status = changed ? "stale" : "qualified"; reason = changed ? "review_changed" : "qualified";
  }
  return { status, reason, ...(includeReviewStages ? {reviewStages:currentStages} : {}), origin: evidence?.environment.origin || "", distributionId: evidence?.native?.distributionId || "",
    evidenceDigest: record?.evidence.at(-1)?.digest || "", inputsDigest: record?.packets?.at(-1)?.packet.inputsDigest || "",
    ownerPacketDigest: record?.packets?.at(-1)?.packet.packetDigest || "", authority: "display_only",
    recovery: status === "setup_missing" ? "Configure the approved hosted deployment and collect signed evidence."
      : status === "qualified" ? "Re-observe the exact origin before promotion or activation."
        : "Collect current evidence and independent reviews; obtain the exact signed owner decision." };
}
