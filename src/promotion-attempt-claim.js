import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { assertCandidateEnvelope, canonicalJson } from "./candidate-manifest.js";
import {
  assertCurrentOwnerQaPacket,
  assertOwnerQaPacket,
  assertReconciliationOwnerQaPacket,
  LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION,
} from "./owner-qa-packet.js";
import { qaRevocationAllowsPromotion } from "./qa-revocation-records.js";

const CLAIM_SCHEMA_VERSION = "studioops.promotion-attempt-claim.v4";
const PROJECT_POLICY_SCHEMA_VERSION = "studioops.promotion-project-policy.v1";
const ATTEMPT_SERIES_SCHEMA_VERSION = "studioops.promotion-attempt-series.v2";
const RECEIPT_SCHEMA_VERSION = "studioops.promotion-validation-recovery.v1";
const RETRY_AUTHORIZATION_SCHEMA_VERSION = "studioops.promotion-retry-authorization.v1";
const RECONCILIATION_REPLACEMENT_SCHEMA_VERSION = "studioops.promotion-reconciliation-replacement.v2";
const TERMINAL_RESULT_SCHEMA_VERSION = "studioops.promotion-terminal-result.v1";
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_OPERATIONAL_ATTEMPTS = 3;
const OPERATIONAL_RETRY_BASE_MS = 60 * 1_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MODES = new Set(["create", "retry", "reconcile"]);
const RECONCILIATION_TASK_STATUSES = new Set([
  "user_review",
  "promotion_blocked",
  "merged",
  "deployed",
  "done",
]);
const AUTO_RECOVERABLE_PROMOTION_STATUSES = new Set([
  "auth_failed",
  "candidate_verification_unavailable",
  "evidence_failed",
  "pr_failed",
  "push_failed",
  "remote_policy_invalid",
  "validation_missing",
  "validation_sandbox_unavailable",
  "claim_circuit_open",
]);
const REPLAYABLE_TERMINAL_OUTCOMES = new Set([
  "auth_failed",
  "candidate_verification_unavailable",
  "claim_expired",
  "evidence_failed",
  "pr_failed",
  "push_failed",
  "validation_sandbox_unavailable",
]);
const PROMOTION_DEPENDENCY_COMPLETE_STATUSES = new Set([
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

// Mutation authority must be unforgeable by callers that can reproduce the
// public shape of a claim result. Keep the capability module-private and bind
// it to the exact object returned by a mutating helper. The canonical snapshots
// also make later mutation of either the returned value or persisted claim
// fail closed when the database writer consumes the attestation.
const promotionClaimTransitionAttestations = new WeakMap();

function persistedClaimSnapshot(state, candidateId) {
  const claims = state?.meta?.promotionAttemptClaims;
  const present = Boolean(
    claims
    && typeof claims === "object"
    && Object.prototype.hasOwnProperty.call(claims, candidateId),
  );
  return {
    present,
    value: present ? structuredClone(claims[candidateId]) : null,
  };
}

function suppliedClaimSnapshot(value) {
  return {
    present: value !== undefined,
    value: value === undefined ? null : structuredClone(value),
  };
}

function canonicalClaimSnapshot(snapshot) {
  return canonicalJson({
    present: snapshot.present,
    value: snapshot.value,
  });
}

function attestPromotionClaimTransition(result, candidateId, before, state) {
  if (!result || typeof result !== "object") {
    throw new Error("Promotion claim transition result must be an object.");
  }
  promotionClaimTransitionAttestations.set(result, {
    candidateId,
    before: canonicalClaimSnapshot(before),
    after: canonicalClaimSnapshot(persistedClaimSnapshot(state, candidateId)),
    result: canonicalJson(result),
  });
  return result;
}

/**
 * Prove that a claim transition was produced by this module and still exactly
 * matches both the caller's pre-write claim and the claim now held in state.
 * No public capability-minting API exists; only the mutating helpers below can
 * create the WeakMap entry consumed here.
 */
export function assertPromotionAttemptClaimTransitionAttestation(
  result,
  candidateId,
  previousClaim,
  state,
) {
  if (!result || typeof result !== "object") {
    throw new Error("Promotion claim transition attestation requires the helper's returned object.");
  }
  const attestation = promotionClaimTransitionAttestations.get(result);
  if (!attestation) {
    throw new Error("Promotion claim transition result has no private helper attestation.");
  }
  if (candidateId !== attestation.candidateId) {
    throw new Error("Promotion claim transition candidate binding changed.");
  }
  if (canonicalJson(result) !== attestation.result) {
    throw new Error("Promotion claim transition returned object changed after attestation.");
  }
  if (canonicalClaimSnapshot(suppliedClaimSnapshot(previousClaim)) !== attestation.before) {
    throw new Error("Promotion claim transition pre-claim value does not match its attestation.");
  }
  if (canonicalClaimSnapshot(persistedClaimSnapshot(state, candidateId)) !== attestation.after) {
    throw new Error("Promotion claim transition persisted post-claim value changed after attestation.");
  }
  return true;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function requiredString(value, label, max = 512) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return normalized;
}

function digest(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function mode(value) {
  const normalized = requiredString(value, "promotion attempt mode", 16);
  if (!MODES.has(normalized)) throw new Error(`Unsupported promotion attempt mode: ${normalized}.`);
  return normalized;
}

function time(input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite.");
  return { nowMs, now: new Date(nowMs).toISOString() };
}

function ttl(input = {}) {
  const value = Number(input.ttlMs ?? DEFAULT_TTL_MS);
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new Error(`ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}.`);
  }
  return value;
}

function positiveStateVersion(value, taskId) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Task ${taskId} must have a positive stateVersion.`);
  }
  return version;
}

function nonnegativeAttemptEpoch(value, taskId) {
  const epoch = Number(value || 0);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`Task ${taskId} must have a non-negative automationAttemptEpoch.`);
  }
  return epoch;
}

function gitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a full Git SHA.`);
  }
  return normalized;
}

function isoTime(value, label) {
  const normalized = requiredString(value, label);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function canonicalGitHubRepository(value, label) {
  const raw = requiredString(value, label, 4_096);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a canonical HTTPS GitHub repository URL.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || segments.length !== 2
    || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))
    || segments.some((segment) => segment === "." || segment === "..")
    || segments[1].toLowerCase().endsWith(".git")
  ) {
    throw new Error(`${label} must be a canonical HTTPS GitHub repository URL.`);
  }
  const url = `https://github.com/${segments[0]}/${segments[1]}`;
  if (raw !== url) throw new Error(`${label} must be a canonical HTTPS GitHub repository URL.`);
  return { url, repository: `${segments[0]}/${segments[1]}` };
}

function canonicalGitHubPullRequest(value, label) {
  const raw = requiredString(value, label, 4_096);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an exact canonical GitHub pull request URL.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const number = Number(segments[3]);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || segments.length !== 4
    || segments[2] !== "pull"
    || segments.slice(0, 2).some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))
    || segments.slice(0, 2).some((segment) => segment === "." || segment === "..")
    || segments[1].toLowerCase().endsWith(".git")
    || !Number.isSafeInteger(number)
    || number < 1
    || String(number) !== segments[3]
  ) {
    throw new Error(`${label} must be an exact canonical GitHub pull request URL.`);
  }
  const repository = `${segments[0]}/${segments[1]}`;
  const url = `https://github.com/${repository}/pull/${number}`;
  if (raw !== url) throw new Error(`${label} must be an exact canonical GitHub pull request URL.`);
  return { url, repository, number };
}

function githubPullRequestUrl(value, label) {
  return canonicalGitHubPullRequest(value, label).url;
}

function normalizedCandidateQaDecision(candidate, options = {}) {
  const decision = candidate?.qaDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`Promotion candidate ${candidate?.id || "(missing)"} has no authoritative QA decision.`);
  }
  const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  const taskIds = (Array.isArray(decision.taskIds)
    ? decision.taskIds
    : String(decision.taskIds || "").split(/\n|,/))
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
  const packet = assertOwnerQaPacket(candidate.qaPacket, candidate);
  const ownerQaPacketDigest = decision.ownerQaPacketDigest || (
    options.reconciliation === true
    && packet.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION
      ? packet.packetDigest
      : ""
  );
  const normalized = {
    outcome: requiredString(decision.outcome, "candidate QA outcome", 32),
    candidateId: requiredString(decision.candidateId, "candidate QA candidate ID", 160),
    manifestDigest: digest(decision.manifestDigest, "candidate QA manifest digest"),
    integrationSha: gitSha(decision.integrationSha, "candidate QA integration SHA"),
    ownerQaPacketDigest: digest(ownerQaPacketDigest, "candidate owner QA packet digest"),
    taskIds,
    author: requiredString(decision.author, "candidate QA author", 160),
    repositoryVerifiedAt: isoTime(decision.repositoryVerifiedAt, "candidate QA repository verification time"),
    decidedAt: isoTime(decision.decidedAt, "candidate QA decision time"),
  };
  if (
    normalized.outcome !== "passed"
    || normalized.candidateId !== candidate.id
    || normalized.manifestDigest !== candidate.manifestDigest
    || normalized.integrationSha !== candidate.manifest.integration.sha
    || normalized.ownerQaPacketDigest !== packet.packetDigest
    || canonicalJson(normalized.taskIds) !== canonicalJson(expectedTaskIds)
  ) {
    throw new Error(`Promotion candidate ${candidate.id} no longer has an authoritative QA decision.`);
  }
  return normalized;
}

function normalizedPromotionHandoff(candidate) {
  const promotion = candidate?.promotion;
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) {
    throw new Error(`Promotion candidate ${candidate?.id || "(missing)"} has no authoritative promotion handoff.`);
  }
  const normalized = {
    branch: normalizedBranchName(promotion.branch),
    prUrl: githubPullRequestUrl(promotion.prUrl, "candidate promotion PR URL"),
    commitSha: gitSha(promotion.commitSha, "candidate promotion commit SHA"),
    manifestDigest: digest(promotion.manifestDigest, "candidate promotion manifest digest"),
    readyAt: isoTime(promotion.readyAt, "candidate promotion ready time"),
  };
  if (
    normalized.commitSha !== candidate.manifest.integration.sha
    || normalized.manifestDigest !== candidate.manifestDigest
  ) {
    throw new Error(`Promotion candidate ${candidate.id} has a mismatched promotion handoff.`);
  }
  return normalized;
}

function normalizedObservedPromotionPr(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observed replacement promotion PR state is required.");
  }
  const number = Number(value.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Observed replacement promotion PR number is invalid.");
  }
  const pullRequest = canonicalGitHubPullRequest(value.url, "observed replacement promotion PR URL");
  if (pullRequest.number !== number) {
    throw new Error("Observed replacement promotion PR number does not match its canonical URL.");
  }
  return {
    number,
    url: pullRequest.url,
    state: requiredString(value.state, "observed replacement promotion PR state", 16).toUpperCase(),
    mergedAt: isoTime(value.mergedAt, "observed replacement promotion merge time"),
    mergeCommit: gitSha(value.mergeCommit, "observed replacement promotion merge commit"),
    baseRefName: normalizedBranchName(value.baseRefName),
    headRefName: normalizedBranchName(value.headRefName),
    headRefOid: gitSha(value.headRefOid, "observed replacement promotion head SHA"),
    headRepository: requiredString(value.headRepository, "observed replacement head repository", 512).toLowerCase(),
    repository: requiredString(value.repository, "observed replacement repository", 512).toLowerCase(),
    candidateMarker: requiredString(value.candidateMarker, "observed replacement candidate marker", 1_024),
  };
}

function normalizedReconciliationReplacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Promotion reconciliation replacement binding is required.");
  }
  const promotion = value.promotion;
  const promotionMerge = value.promotionMerge;
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) {
    throw new Error("Promotion reconciliation replacement promotion identity is required.");
  }
  if (!promotionMerge || typeof promotionMerge !== "object" || Array.isArray(promotionMerge)) {
    throw new Error("Promotion reconciliation replacement merge identity is required.");
  }
  const normalized = {
    schemaVersion: RECONCILIATION_REPLACEMENT_SCHEMA_VERSION,
    candidateId: requiredString(value.candidateId || value.id, "replacement candidate ID", 160),
    manifestDigest: digest(value.manifestDigest, "replacement manifest digest"),
    integrationBranch: requiredString(value.integrationBranch, "replacement integration branch", 512),
    integrationSha: gitSha(value.integrationSha, "replacement integration SHA"),
    qaDecision: value.qaDecision && typeof value.qaDecision === "object"
      ? {
          outcome: requiredString(value.qaDecision.outcome, "replacement QA outcome", 32),
          candidateId: requiredString(value.qaDecision.candidateId, "replacement QA candidate ID", 160),
          manifestDigest: digest(value.qaDecision.manifestDigest, "replacement QA manifest digest"),
          integrationSha: gitSha(value.qaDecision.integrationSha, "replacement QA integration SHA"),
          ownerQaPacketDigest: digest(
            value.qaDecision.ownerQaPacketDigest,
            "replacement owner QA packet digest",
          ),
          taskIds: (Array.isArray(value.qaDecision.taskIds)
            ? value.qaDecision.taskIds
            : String(value.qaDecision.taskIds || "").split(/\n|,/))
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean)
            .sort(),
          author: requiredString(value.qaDecision.author, "replacement QA author", 160),
          repositoryVerifiedAt: isoTime(value.qaDecision.repositoryVerifiedAt, "replacement QA repository verification time"),
          decidedAt: isoTime(value.qaDecision.decidedAt, "replacement QA decision time"),
        }
      : null,
    promotion: {
      branch: normalizedBranchName(promotion.branch),
      prUrl: githubPullRequestUrl(promotion.prUrl, "replacement promotion PR URL"),
      commitSha: gitSha(promotion.commitSha, "replacement promotion commit SHA"),
      manifestDigest: digest(promotion.manifestDigest, "replacement promotion manifest digest"),
      readyAt: isoTime(promotion.readyAt, "replacement promotion ready time"),
    },
    promotionMerge: {
      mergeCommit: gitSha(promotionMerge.mergeCommit, "replacement merge commit"),
      mergedAt: isoTime(promotionMerge.mergedAt, "replacement merge time"),
      reconciledAt: isoTime(promotionMerge.reconciledAt, "replacement reconciliation time"),
      reconciledByCandidateId: String(promotionMerge.reconciledByCandidateId || ""),
      reconciledByManifestDigest: String(promotionMerge.reconciledByManifestDigest || "").toLowerCase(),
    },
    observedPromotionPr: normalizedObservedPromotionPr(value.observedPromotionPr),
  };
  if (
    !normalized.qaDecision
    || normalized.qaDecision.outcome !== "passed"
    || normalized.qaDecision.candidateId !== normalized.candidateId
    || normalized.qaDecision.manifestDigest !== normalized.manifestDigest
    || normalized.qaDecision.integrationSha !== normalized.integrationSha
    || normalized.promotion.commitSha !== normalized.integrationSha
    || normalized.promotion.manifestDigest !== normalized.manifestDigest
    || normalized.observedPromotionPr.state !== "MERGED"
    || normalized.observedPromotionPr.url !== normalized.promotion.prUrl
    || normalized.observedPromotionPr.mergeCommit !== normalized.promotionMerge.mergeCommit
    || normalized.observedPromotionPr.mergedAt !== normalized.promotionMerge.mergedAt
    || normalized.observedPromotionPr.headRefName !== normalized.promotion.branch
    || normalized.observedPromotionPr.headRefOid !== normalized.integrationSha
  ) {
    throw new Error("Promotion reconciliation replacement identity is internally inconsistent.");
  }
  return normalized;
}

function authoritativeReconciliationReplacement(state, projectId, expected) {
  const project = (state.projects || []).find((item) => item.id === projectId);
  if (!project) throw new Error(`Replacement promotion project ${projectId} no longer exists.`);
  const candidate = (state.candidates || []).find((item) => item.id === expected.candidateId);
  if (!candidate) throw new Error(`Replacement promotion candidate ${expected.candidateId} no longer exists.`);
  assertCandidateEnvelope(candidate);
  if (candidate.projectId !== projectId || candidate.status !== "merged" || candidate.invalidation) {
    throw new Error(`Replacement promotion candidate ${expected.candidateId} is no longer an authoritative merged candidate.`);
  }
  const qaDecision = normalizedCandidateQaDecision(candidate, { reconciliation: true });
  if (Array.isArray(state.tasks) && Array.isArray(state.qaBundles)) {
    assertReconciliationOwnerQaPacket(
      state,
      candidate,
      state.qaBundles.find((bundle) => bundle.id === candidate.qaBundleId),
    );
  }
  const current = normalizedReconciliationReplacement({
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    qaDecision,
    promotion: candidate.promotion,
    promotionMerge: candidate.promotionMerge,
    observedPromotionPr: expected.observedPromotionPr,
  });
  const projectRepository = canonicalGitHubRepository(
    project.repoUrl,
    `replacement promotion project ${projectId} repository URL`,
  ).repository.toLowerCase();
  const promotionPullRequest = canonicalGitHubPullRequest(
    current.promotion.prUrl,
    "replacement promotion PR URL",
  );
  const projectPolicy = promotionProjectPolicyBinding(project);
  const candidateBaseBranch = normalizedBranchName(candidate.manifest.base.branch);
  const expectedCandidateMarker = `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`;
  if (
    projectPolicy.targetBranch !== candidateBaseBranch
    || promotionPullRequest.repository.toLowerCase() !== projectRepository
    || current.observedPromotionPr.number !== promotionPullRequest.number
    || current.observedPromotionPr.repository !== projectRepository
    || current.observedPromotionPr.headRepository !== projectRepository
    || current.observedPromotionPr.baseRefName !== candidateBaseBranch
    || current.observedPromotionPr.headRefName !== current.promotion.branch
    || current.observedPromotionPr.headRefOid !== current.integrationSha
    || current.observedPromotionPr.candidateMarker !== expectedCandidateMarker
  ) {
    throw new Error("Replacement promotion PR observation does not match the authoritative project and candidate identity.");
  }
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`Replacement promotion candidate ${expected.candidateId} changed after observation.`);
  }
  return current;
}

function normalizedTerminalPromotionResult(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Merged promotion claims require an exact terminal result binding.");
  }
  const normalized = {
    schemaVersion: TERMINAL_RESULT_SCHEMA_VERSION,
    candidateId: requiredString(value.candidateId, "terminal promotion candidate ID", 160),
    manifestDigest: digest(value.manifestDigest, "terminal promotion manifest digest"),
    prUrl: githubPullRequestUrl(value.prUrl, "terminal promotion PR URL"),
    mergeCommit: gitSha(value.mergeCommit, "terminal promotion merge commit"),
    mergedAt: isoTime(value.mergedAt, "terminal promotion merge time"),
  };
  const replacement = context?.claim?.reconciliationReplacement || null;
  const expectedPromotion = replacement?.promotion || context?.promotionHandoff;
  const expectedMerge = replacement?.promotionMerge || null;
  if (
    normalized.candidateId !== context.candidateId
    || normalized.manifestDigest !== context.candidate.manifestDigest
    || normalized.prUrl !== expectedPromotion?.prUrl
    || (expectedMerge && (
      normalized.mergeCommit !== expectedMerge.mergeCommit
      || normalized.mergedAt !== expectedMerge.mergedAt
    ))
  ) {
    throw new Error("Terminal promotion result does not match the fenced candidate handoff.");
  }
  return normalized;
}

function booleanOption(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizedBranchName(value) {
  return requiredString(value, "promotion target branch", 512)
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

/**
 * Build the exact project policy callers must pass as `projectPolicy` to every
 * claim, renewal, assertion, receipt, and terminal operation. The helper
 * accepts either a persisted project (`promotion.enabled/targetBranch`) or an
 * already-planned promotion object (`enabled/targetBranch`).
 */
export function promotionProjectPolicyBinding(project = {}) {
  const rawRepoPath = requiredString(project.repoPath, "promotion project repoPath", 4_096);
  const rawRepoUrl = String(project.repoUrl || "").trim();
  if (rawRepoUrl.length > 4_096) throw new Error("promotion project repoUrl exceeds 4096 characters.");
  const directEnabled = Object.prototype.hasOwnProperty.call(project, "enabled");
  const directTarget = Object.prototype.hasOwnProperty.call(project, "targetBranch");
  return {
    schemaVersion: PROJECT_POLICY_SCHEMA_VERSION,
    repoPath: path.resolve(rawRepoPath),
    repoUrl: rawRepoUrl,
    enabled: booleanOption(
      directEnabled ? project.enabled : project.promotion?.enabled,
      true,
    ),
    targetBranch: normalizedBranchName(
      directTarget
        ? project.targetBranch
        : project.promotion?.targetBranch || project.defaultBranch || "main",
    ),
  };
}

function projectPolicyContext(state, projectId, input) {
  const project = (state.projects || []).find((item) => item.id === projectId);
  if (!project) throw new Error(`Promotion project ${projectId} no longer exists.`);
  if (!input?.projectPolicy) throw new Error("Promotion project policy binding is required.");
  const expected = promotionProjectPolicyBinding(input.projectPolicy);
  const current = promotionProjectPolicyBinding(project);
  const expectedDigest = sha256(expected);
  const currentDigest = sha256(current);
  if (expectedDigest !== currentDigest) {
    throw new Error("Promotion project policy changed.");
  }
  return { projectPolicy: current, projectPolicyDigest: currentDigest };
}

function retryAuthorization(task) {
  const authorization = task?.promotionRetryAuthorization;
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return null;
  const authorizedBy = String(authorization.authorizedBy || authorization.author || "").trim();
  const authorizedAt = String(authorization.authorizedAt || authorization.recordedAt || "").trim();
  const authorizedAtMs = Date.parse(authorizedAt);
  if (!authorizedBy || authorizedBy.length > 160 || !Number.isFinite(authorizedAtMs)) return null;
  if (authorization.schemaVersion !== RETRY_AUTHORIZATION_SCHEMA_VERSION) return null;
  if (authorization.independentResult !== "validation_failed") return null;
  if (!DIGEST_PATTERN.test(String(authorization.firstEvidenceDigest || "").toLowerCase())) return null;
  return {
    schemaVersion: authorization.schemaVersion,
    candidateId: String(authorization.candidateId || "").trim(),
    manifestDigest: String(authorization.manifestDigest || "").trim().toLowerCase(),
    integrationSha: String(authorization.integrationSha || "").trim().toLowerCase(),
    policyDigest: String(authorization.policyDigest || "").trim().toLowerCase(),
    firstEvidenceDigest: String(authorization.firstEvidenceDigest || "").trim().toLowerCase(),
    independentResult: authorization.independentResult,
    authorizedBy,
    authorizedAt: new Date(authorizedAtMs).toISOString(),
  };
}

function persistedFirstFailureEvidence(task, candidate, policyDigest) {
  const validation = task?.promotionValidation;
  const evidence = validation?.evidence;
  if (
    !validation
    || typeof validation !== "object"
    || Array.isArray(validation)
    || validation.status !== "validation_failed"
    || !evidence
    || typeof evidence !== "object"
    || Array.isArray(evidence)
    || task.promotionValidationCandidateId !== candidate.id
    || evidence.candidateId !== candidate.id
    || evidence.manifestDigest !== candidate.manifestDigest
    || evidence.integrationSha !== candidate.manifest.integration.sha
    || evidence.policyDigest !== policyDigest
    || evidence.attempt !== 1
    || !DIGEST_PATTERN.test(String(evidence.digest || ""))
  ) {
    return null;
  }
  return evidence;
}

export function validPromotionRetryAuthorization(task, candidate, source, policyDigest) {
  try {
    assertCandidateEnvelope(candidate);
    const authorization = retryAuthorization(task);
    const expectedPolicyDigest = digest(policyDigest, "promotion validation policy digest");
    const evidence = persistedFirstFailureEvidence(task, candidate, expectedPolicyDigest);
    return Boolean(
      authorization
      && evidence
      && task?.status === "approved_for_main"
      && Number(task?.promotionValidationAttempts) === 1
      && authorization.candidateId === candidate.id
      && authorization.manifestDigest === candidate.manifestDigest
      && authorization.integrationSha === candidate.manifest.integration.sha
      && authorization.policyDigest === expectedPolicyDigest
      && authorization.firstEvidenceDigest === evidence.digest
      && source?.taskId === task.id
      && task.candidateId === candidate.id
      && task.qaBundleId === candidate.qaBundleId
      && String(task.reviewSubjectSha || "").toLowerCase() === source.headSha
      && Number(task.reviewSubjectCycle) === Number(source.candidateCycle)
    );
  } catch {
    return false;
  }
}

function normalizedReceiptEvidence(value, candidate, policyDigest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Candidate ${candidate.id} has a recovery receipt without private validation evidence.`);
  }
  const bytes = Number(value.bytes);
  const attempt = Number(value.attempt);
  const commandCount = Number(value.commandCount);
  const createdAtMs = Date.parse(value.createdAt || "");
  if (
    !String(value.path || "").trim()
    || !DIGEST_PATTERN.test(String(value.digest || ""))
    || !Number.isSafeInteger(bytes)
    || bytes < 1
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || !Number.isSafeInteger(commandCount)
    || commandCount < 1
    || !Number.isFinite(createdAtMs)
    || value.candidateId !== candidate.id
    || value.manifestDigest !== candidate.manifestDigest
    || value.integrationSha !== candidate.manifest.integration.sha
    || value.policyDigest !== policyDigest
  ) {
    throw new Error(`Candidate ${candidate.id} has mismatched private validation evidence in its recovery receipt.`);
  }
  return {
    path: String(value.path).trim(),
    digest: String(value.digest).toLowerCase(),
    bytes,
    createdAt: new Date(createdAtMs).toISOString(),
    candidateId: value.candidateId,
    manifestDigest: value.manifestDigest,
    integrationSha: value.integrationSha,
    attempt,
    policyDigest: value.policyDigest,
    commandCount,
  };
}

function receiptBinding(candidate, policyDigest) {
  const receipt = candidate.promotionValidationRecoveryReceipt;
  if (!receipt) return { receipt: null, receiptDigest: "" };
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.candidateId !== candidate.id
    || receipt.manifestDigest !== candidate.manifestDigest
    || receipt.integrationBranch !== candidate.manifest.integration.branch
    || receipt.integrationSha !== candidate.manifest.integration.sha
    || receipt.policyDigest !== policyDigest
    || !DIGEST_PATTERN.test(String(receipt.validationResultDigest || ""))
    || !Number.isFinite(Date.parse(receipt.validatedAt || ""))
  ) {
    throw new Error(`Candidate ${candidate.id} has a mismatched promotion recovery receipt.`);
  }
  const validationEvidence = normalizedReceiptEvidence(receipt.validationEvidence, candidate, policyDigest);
  const normalized = { ...receipt, validationEvidence };
  return { receipt: normalized, receiptDigest: sha256(normalized) };
}

export function validPromotionRecoveryReceipt(candidate, policyDigest) {
  try {
    assertCandidateEnvelope(candidate);
    return Boolean(receiptBinding(candidate, digest(policyDigest, "promotion validation policy digest")).receipt);
  } catch {
    return false;
  }
}

function taskStatusAllowsPromotionClaim(task, attemptMode) {
  if (attemptMode === "reconcile") return RECONCILIATION_TASK_STATUSES.has(task.status);
  if (task.status === "approved_for_main") return true;
  return attemptMode === "create"
    && task.status === "promotion_blocked"
    && AUTO_RECOVERABLE_PROMOTION_STATUSES.has(String(task.promotionStatus || ""));
}

function taskAssignmentAllowsPromotionClaim(task, attemptMode) {
  if (attemptMode !== "reconcile") return task.assignedAgentRole === "promotion-worker";
  if (task.status === "user_review") return task.assignedAgentRole === "owner";
  if (task.status === "promotion_blocked") {
    return ["owner", "promotion-worker"].includes(task.assignedAgentRole);
  }
  return true;
}

function promotionDependencyBindings(state, candidate, task, projectId) {
  const sourceTaskIds = new Set(candidate.manifest.sources.map((source) => source.taskId));
  const tasksById = new Map((state.tasks || []).map((item) => [item.id, item]));
  const dependencyIds = [...new Set((task.dependsOnTaskIds || []).map(String).map((item) => item.trim()).filter(Boolean))].sort();
  return dependencyIds.map((dependencyId) => {
    if (dependencyId === task.id) throw new Error(`Promotion task ${task.id} cannot depend on itself.`);
    const dependency = tasksById.get(dependencyId);
    if (!dependency || dependency.projectId !== projectId) {
      throw new Error(`Promotion dependency ${dependencyId} for ${task.id} is missing or belongs to another project.`);
    }
    const internal = sourceTaskIds.has(dependencyId);
    if (!internal && !PROMOTION_DEPENDENCY_COMPLETE_STATUSES.has(dependency.status)) {
      throw new Error(`Promotion dependency ${dependencyId} for ${task.id} is not complete.`);
    }
    return {
      taskId: dependency.id,
      internal,
      status: String(dependency.status || ""),
      stateVersion: positiveStateVersion(dependency.stateVersion, dependency.id),
    };
  });
}

function assertNoCandidateDependencyCycle(candidate, taskBindings) {
  const sourceTaskIds = new Set(candidate.manifest.sources.map((source) => source.taskId));
  const byId = new Map(taskBindings.map((item) => [item.task.id, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new Error("Promotion candidate task dependencies contain a cycle.");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId) || []) {
      if (sourceTaskIds.has(dependency.taskId)) visit(dependency.taskId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of sourceTaskIds) visit(taskId);
}

function candidateContext(state, input, versionOverride = null) {
  const projectId = requiredString(input.projectId, "projectId", 160);
  const candidateId = requiredString(input.candidateId, "candidateId", 160);
  const attemptMode = mode(input.mode);
  const policyDigest = digest(input.policyDigest, "promotion validation policy digest");
  const { projectPolicy, projectPolicyDigest } = projectPolicyContext(state, projectId, input);
  const candidate = (state.candidates || []).find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown promotion candidate: ${candidateId}.`);
  assertCandidateEnvelope(candidate);
  if (candidate.projectId !== projectId) throw new Error("Promotion candidate project binding changed.");
  if (candidate.invalidation || candidate.status === "invalidated") {
    throw new Error(`Promotion candidate ${candidateId} is invalidated.`);
  }
  if (!qaRevocationAllowsPromotion(candidate)) {
    throw new Error(`Promotion candidate ${candidateId} has a pending owner QA revocation intent.`);
  }
  const qaDecision = normalizedCandidateQaDecision(candidate, { reconciliation: attemptMode === "reconcile" });
  const candidateBundle = (state.qaBundles || []).find((bundle) => bundle.id === candidate.qaBundleId);
  const ownerQaPacket = attemptMode === "reconcile"
    ? assertReconciliationOwnerQaPacket(state, candidate, candidateBundle)
    : assertCurrentOwnerQaPacket(state, candidate, candidateBundle);
  if (qaDecision.ownerQaPacketDigest !== ownerQaPacket.packetDigest) {
    throw new Error(`Promotion candidate ${candidate.id} owner QA packet binding changed.`);
  }
  const requiredCandidateStatus = attemptMode === "reconcile" ? "release_candidate_ready" : "qa_passed";
  if (candidate.status !== requiredCandidateStatus) {
    throw new Error(
      attemptMode === "reconcile"
        ? `Promotion candidate ${candidateId} is no longer release-candidate ready.`
        : `Promotion candidate ${candidateId} is no longer QA-passed.`,
    );
  }

  const tasksById = new Map((state.tasks || []).map((task) => [task.id, task]));
  const promotionHandoff = attemptMode === "reconcile" ? normalizedPromotionHandoff(candidate) : null;
  if (promotionHandoff) {
    const projectRepository = canonicalGitHubRepository(
      projectPolicy.repoUrl,
      `promotion project ${projectId} repository URL`,
    ).repository.toLowerCase();
    const promotionRepository = canonicalGitHubPullRequest(
      promotionHandoff.prUrl,
      "candidate promotion PR URL",
    ).repository.toLowerCase();
    if (promotionRepository !== projectRepository) {
      throw new Error(`Promotion candidate ${candidate.id} pull request belongs to a different repository.`);
    }
  }
  const tasks = candidate.manifest.sources.map((source) => {
    const task = tasksById.get(source.taskId);
    if (!task) throw new Error(`Candidate source task ${source.taskId} is missing.`);
    if (
      task.projectId !== projectId
      || !taskStatusAllowsPromotionClaim(task, attemptMode)
      || !taskAssignmentAllowsPromotionClaim(task, attemptMode)
      || task.candidateId !== candidate.id
      || task.qaBundleId !== candidate.qaBundleId
      || String(task.reviewSubjectSha || "").toLowerCase() !== source.headSha
      || Number(task.reviewSubjectCycle) !== Number(source.candidateCycle)
    ) {
      throw new Error(`Candidate source task ${source.taskId} no longer matches the promotion candidate.`);
    }
    if (attemptMode === "retry" && !validPromotionRetryAuthorization(task, candidate, source, policyDigest)) {
      throw new Error(`Candidate source task ${source.taskId} lacks an exact promotion retry authorization.`);
    }
    const stateVersion = versionOverride?.[source.taskId]
      ?? positiveStateVersion(task.stateVersion, source.taskId);
    const automationAttemptEpoch = nonnegativeAttemptEpoch(task.automationAttemptEpoch, source.taskId);
    const authorization = attemptMode === "retry" ? retryAuthorization(task) : null;
    const dependencies = promotionDependencyBindings(state, candidate, task, projectId);
    const promotionMirror = attemptMode === "reconcile" ? {
      promotionStatus: requiredString(task.promotionStatus, `task ${task.id} promotion status`, 80),
      branch: normalizedBranchName(task.promotionBranch),
      prUrl: githubPullRequestUrl(task.promotionPrUrl, `task ${task.id} promotion PR URL`),
      commitSha: gitSha(task.promotionCommit, `task ${task.id} promotion commit SHA`),
    } : null;
    if (promotionMirror && (
      promotionMirror.branch !== promotionHandoff.branch
      || promotionMirror.prUrl !== promotionHandoff.prUrl
      || promotionMirror.commitSha !== promotionHandoff.commitSha
    )) {
      throw new Error(`Candidate source task ${source.taskId} has a mismatched promotion handoff mirror.`);
    }
    return {
      task,
      source,
      dependencies,
      binding: {
        taskId: source.taskId,
        status: task.status,
        assignedAgentRole: task.assignedAgentRole,
        candidateId: task.candidateId,
        qaBundleId: task.qaBundleId,
        reviewSubjectSha: String(task.reviewSubjectSha).toLowerCase(),
        reviewSubjectCycle: Number(task.reviewSubjectCycle),
        stateVersion,
        automationAttemptEpoch,
        retryAuthorization: authorization,
        dependencies,
        promotionMirror,
      },
    };
  });
  assertNoCandidateDependencyCycle(candidate, tasks);
  const { receipt, receiptDigest } = receiptBinding(candidate, policyDigest);
  const binding = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    projectId,
    candidateId,
    mode: attemptMode,
    policyDigest,
    projectPolicy,
    projectPolicyDigest,
    manifestDigest: candidate.manifestDigest,
    qaBundleId: candidate.qaBundleId,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    ownerQaPacketDigest: ownerQaPacket.packetDigest,
    qaDecision,
    promotionHandoff,
    receiptDigest,
    tasks: tasks.map(({ binding: item }) => item),
  };
  const attemptSeriesBinding = {
    schemaVersion: ATTEMPT_SERIES_SCHEMA_VERSION,
    projectId,
    candidateId,
    policyDigest,
    projectPolicyDigest,
    manifestDigest: candidate.manifestDigest,
    qaBundleId: candidate.qaBundleId,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    ownerQaPacketDigest: ownerQaPacket.packetDigest,
    qaDecision,
    tasks: tasks.map(({ binding: item }) => ({
      taskId: item.taskId,
      candidateId: item.candidateId,
      qaBundleId: item.qaBundleId,
      reviewSubjectSha: item.reviewSubjectSha,
      reviewSubjectCycle: item.reviewSubjectCycle,
      automationAttemptEpoch: item.automationAttemptEpoch,
      dependencies: item.dependencies.map((dependency) => ({
        taskId: dependency.taskId,
        internal: dependency.internal,
      })),
    })),
  };
  return {
    projectId,
    candidateId,
    mode: attemptMode,
    policyDigest,
    projectPolicy,
    projectPolicyDigest,
    candidate,
    qaDecision,
    ownerQaPacketDigest: ownerQaPacket.packetDigest,
    promotionHandoff,
    tasks,
    binding,
    bindingDigest: sha256(binding),
    attemptSeriesDigest: sha256(attemptSeriesBinding),
    expectedTaskStateVersions: Object.fromEntries(tasks.map(({ source, binding: item }) => [source.taskId, item.stateVersion])),
    receipt,
  };
}

function claimStore(state) {
  state.meta = state.meta || {};
  state.meta.promotionAttemptClaims = state.meta.promotionAttemptClaims || {};
  return state.meta.promotionAttemptClaims;
}

function active(claim, nowMs) {
  return claim?.status === "active" && Number.isFinite(Date.parse(claim.expiresAt || ""))
    && Date.parse(claim.expiresAt) > nowMs;
}

function claimIdentity(input, context) {
  if (input.projectId !== undefined && String(input.projectId) !== context.projectId) throw new Error("Promotion claim project binding changed.");
  if (input.candidateId !== undefined && String(input.candidateId) !== context.candidateId) throw new Error("Promotion claim candidate binding changed.");
  if (input.mode !== undefined && String(input.mode) !== context.mode) throw new Error("Promotion claim mode changed.");
  if (input.policyDigest !== undefined && String(input.policyDigest).toLowerCase() !== context.policyDigest) throw new Error("Promotion validation policy changed.");
  if (input.projectPolicy && sha256(promotionProjectPolicyBinding(input.projectPolicy)) !== context.projectPolicyDigest) {
    throw new Error("Promotion project policy changed.");
  }
}

function positiveOperationalAttempt(value) {
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
}

function circuitMetadata(claim, reasonCode, now = "") {
  return {
    shouldOpen: true,
    reasonCode,
    attemptsConsumed: positiveOperationalAttempt(claim?.operationalAttempt),
    maxAttempts: MAX_OPERATIONAL_ATTEMPTS,
    attemptSeriesDigest: String(claim?.attemptSeriesDigest || ""),
    lastOutcome: String(claim?.outcome || ""),
    retryNotBefore: "",
    detectedAt: now,
  };
}

function unsupportedClaimResult(existing, now) {
  return {
    acquired: false,
    reason: "claim_schema_unsupported",
    claim: structuredClone(existing),
    circuit: circuitMetadata(existing, "promotion_claim_schema_unsupported", now),
  };
}

function exhaustedClaimResult(existing, now, reasonCode = "promotion_attempt_budget_exhausted") {
  const circuit = existing.circuit || circuitMetadata(existing, reasonCode, now);
  return {
    acquired: false,
    reason: "attempt_budget_exhausted",
    claim: structuredClone(existing),
    circuit: structuredClone(circuit),
  };
}

function validationRetryTransition(existing, context) {
  return existing?.status === "terminal"
    && existing.outcome === "validation_failed"
    && existing.mode === "create"
    && context.mode === "retry";
}

export function claimPromotionAttemptInState(state, input = {}) {
  const { nowMs, now } = time(input);
  const leaseTtlMs = ttl(input);
  const context = candidateContext(state, input);
  const before = persistedClaimSnapshot(state, context.candidateId);
  const attest = (result) => attestPromotionClaimTransition(
    result,
    context.candidateId,
    before,
    state,
  );
  const claims = claimStore(state);
  const existing = claims[context.candidateId];
  if (existing && existing.schemaVersion !== CLAIM_SCHEMA_VERSION) {
    return attest(unsupportedClaimResult(existing, now));
  }
  if (active(existing, nowMs)) {
    return attest({ acquired: false, reason: "active", claim: structuredClone(existing) });
  }

  const sameAttemptSeries = existing?.attemptSeriesDigest === context.attemptSeriesDigest;
  const existingOperationalAttempt = sameAttemptSeries
    ? positiveOperationalAttempt(existing?.operationalAttempt)
    : 0;
  const reconciliation = context.mode === "reconcile";
  if (existing?.status === "active" && sameAttemptSeries && !reconciliation) {
    const exhausted = existingOperationalAttempt >= MAX_OPERATIONAL_ATTEMPTS;
    existing.status = "terminal";
    existing.outcome = "claim_expired";
    existing.terminalAt = now;
    existing.retryNotBefore = exhausted
      ? ""
      : new Date(nowMs + (OPERATIONAL_RETRY_BASE_MS * (2 ** (existingOperationalAttempt - 1)))).toISOString();
    existing.attemptsExhausted = exhausted;
    existing.circuit = exhausted
      ? circuitMetadata(existing, "promotion_attempt_budget_exhausted", now)
      : null;
    if (exhausted) return attest(exhaustedClaimResult(existing, now));
    return attest({
      acquired: false,
      reason: "retry_deferred",
      retryNotBefore: existing.retryNotBefore,
      claim: structuredClone(existing),
    });
  }
  if (existing?.status === "terminal" && sameAttemptSeries && !reconciliation) {
    if (existing.attemptsExhausted || existingOperationalAttempt >= MAX_OPERATIONAL_ATTEMPTS) {
      existing.attemptsExhausted = true;
      existing.retryNotBefore = "";
      existing.circuit = existing.circuit
        || circuitMetadata(existing, "promotion_attempt_budget_exhausted", now);
      return attest(exhaustedClaimResult(existing, now));
    }
    if (REPLAYABLE_TERMINAL_OUTCOMES.has(existing.outcome)) {
      const retryAt = Date.parse(existing.retryNotBefore || "");
      if (!Number.isFinite(retryAt)) {
        existing.attemptsExhausted = true;
        existing.circuit = circuitMetadata(existing, "promotion_retry_metadata_invalid", now);
        return attest(exhaustedClaimResult(existing, now, "promotion_retry_metadata_invalid"));
      }
      if (retryAt > nowMs) {
        return attest({
          acquired: false,
          reason: "retry_deferred",
          retryNotBefore: existing.retryNotBefore,
          claim: structuredClone(existing),
        });
      }
    } else if (!validationRetryTransition(existing, context)) {
      return attest({ acquired: false, reason: "terminal", claim: structuredClone(existing) });
    }
  }
  const factory = input.claimIdFactory || randomUUID;
  const claimId = requiredString(factory(context, existing), "promotion claim ID", 160);
  const continuesValidationRetry = sameAttemptSeries && validationRetryTransition(existing, context);
  const operationalAttempt = reconciliation
    ? existingOperationalAttempt
    : sameAttemptSeries
      ? continuesValidationRetry
        ? Math.max(1, existingOperationalAttempt)
        : existingOperationalAttempt + 1
      : 1;
  const claim = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claimId,
    fence: Math.max(0, Number(existing?.fence || 0)) + 1,
    status: "active",
    projectId: context.projectId,
    candidateId: context.candidateId,
    mode: context.mode,
    attempt: context.mode === "reconcile" ? 0 : context.mode === "retry" ? 2 : 1,
    operationalAttempt,
    maxOperationalAttempts: MAX_OPERATIONAL_ATTEMPTS,
    policyDigest: context.policyDigest,
    projectPolicy: context.projectPolicy,
    projectPolicyDigest: context.projectPolicyDigest,
    qaDecision: context.qaDecision,
    ownerQaPacketDigest: context.ownerQaPacketDigest,
    promotionHandoff: context.promotionHandoff,
    bindingDigest: context.bindingDigest,
    attemptSeriesDigest: context.attemptSeriesDigest,
    expectedTaskStateVersions: context.expectedTaskStateVersions,
    retryNotBefore: "",
    attemptsExhausted: false,
    circuit: null,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: new Date(nowMs + leaseTtlMs).toISOString(),
  };
  claims[context.candidateId] = claim;
  return attest({
    acquired: true,
    claim: structuredClone(claim),
    receipt: context.receipt ? structuredClone(context.receipt) : null,
  });
}

/**
 * Remove an unsupported legacy claim only after the durable task-level circuit
 * publication has been completed. The unsupported observation and this
 * deletion are both bound to module-private WeakMap attestations, so a generic
 * state mutator cannot authorize deletion with a caller-constructed Boolean or
 * lookalike result object.
 */
export function removeUnsupportedPromotionClaimAfterCircuitInState(
  state,
  candidateId,
  claimResult,
  input = {},
) {
  const id = requiredString(candidateId, "promotion claim circuit candidate ID", 160);
  const before = persistedClaimSnapshot(state, id);
  if (!before.present) {
    throw new Error(`Promotion attempt claim ${id} is missing before circuit publication.`);
  }
  const previousClaim = before.value;
  const circuit = claimResult?.circuit;
  if (
    previousClaim?.schemaVersion === CLAIM_SCHEMA_VERSION
    || claimResult?.acquired !== false
    || claimResult?.reason !== "claim_schema_unsupported"
    || canonicalJson(claimResult.claim) !== canonicalJson(previousClaim)
    || circuit?.shouldOpen !== true
    || circuit.reasonCode !== "promotion_claim_schema_unsupported"
  ) {
    throw new Error(`Promotion attempt claim ${id} removal requires the exact unsupported-claim observation.`);
  }
  // This proves claimResult is the exact object returned by
  // claimPromotionAttemptInState for the still-persisted legacy claim.
  assertPromotionAttemptClaimTransitionAttestation(claimResult, id, previousClaim, state);

  const openedAt = isoTime(input.circuitOpenedAt, "promotion claim circuit opened time");
  if (openedAt !== input.circuitOpenedAt) {
    throw new Error("Promotion claim circuit opened time must be a canonical ISO timestamp.");
  }
  const candidate = (state.candidates || []).find((item) => item.id === id);
  if (!candidate || candidate.invalidation || !(candidate.manifest?.sources || []).length) {
    throw new Error(`Promotion attempt claim ${id} circuit publication has no active candidate.`);
  }
  for (const source of candidate.manifest.sources) {
    const task = (state.tasks || []).find((item) => item.id === source.taskId);
    const taskCircuit = task?.automationCircuit;
    const blocker = task?.automationBlocker;
    const exactEvent = (state.events || []).some((event) => (
      event.type === "promotion_circuit_opened"
      && event.projectId === candidate.projectId
      && event.taskId === source.taskId
      && event.createdAt === openedAt
    ));
    if (
      !task
      || task.projectId !== candidate.projectId
      || task.candidateId !== candidate.id
      || task.qaBundleId !== candidate.qaBundleId
      || task.status !== "blocked"
      || task.assignedAgentRole !== "owner"
      || task.promotionStatus !== "claim_circuit_open"
      || task.promotionUpdatedAt !== openedAt
      || task.updatedAt !== openedAt
      || taskCircuit?.state !== "open"
      || taskCircuit.scope !== "task"
      || taskCircuit.reasonCode !== circuit.reasonCode
      || Number(taskCircuit.attemptsConsumed) !== Number(circuit.attemptsConsumed)
      || Number(taskCircuit.maxAttempts) !== Number(circuit.maxAttempts)
      || taskCircuit.openedAt !== openedAt
      || taskCircuit.snapshot?.status !== "promotion_blocked"
      || taskCircuit.snapshot?.assignedAgentRole !== "promotion-worker"
      || taskCircuit.resumeAction !== `studioops circuit-reset --task ${task.id} --expected-opened-at ${openedAt} --reason verified`
      || blocker?.type !== "circuit"
      || blocker.reason !== circuit.reasonCode
      || blocker.resumeStatus !== "promotion_blocked"
      || Number(blocker.attempts) !== Number(circuit.attemptsConsumed)
      || !exactEvent
    ) {
      throw new Error(`Promotion attempt claim ${id} removal requires an exact durable circuit publication for task ${source.taskId}.`);
    }
  }

  delete state.meta.promotionAttemptClaims[id];
  return attestPromotionClaimTransition({
    published: true,
    circuitOpenedAt: openedAt,
    removedUnsupportedClaim: true,
  }, id, before, state);
}

export function assertPromotionAttemptClaimInState(state, claim, input = {}) {
  if (!claim || typeof claim !== "object") throw new Error("Promotion attempt claim is required.");
  const { nowMs } = time(input);
  const context = candidateContext(state, {
    ...input,
    projectId: input.projectId ?? claim.projectId,
    candidateId: input.candidateId ?? claim.candidateId,
    mode: input.mode ?? claim.mode,
    policyDigest: input.policyDigest ?? claim.policyDigest,
    projectPolicy: input.projectPolicy ?? claim.projectPolicy,
  });
  claimIdentity(input, context);
  const current = state.meta?.promotionAttemptClaims?.[context.candidateId];
  if (
    !current
    || current.status !== "active"
    || current.claimId !== claim.claimId
    || Number(current.fence) !== Number(claim.fence)
  ) {
    throw new Error("Promotion attempt claim token or fence is stale.");
  }
  if (current.schemaVersion !== CLAIM_SCHEMA_VERSION || claim.schemaVersion !== CLAIM_SCHEMA_VERSION) {
    throw new Error("Promotion attempt claim schema is unsupported.");
  }
  if (!active(current, nowMs)) throw new Error("Promotion attempt claim is expired.");
  if (current.bindingDigest !== claim.bindingDigest || current.bindingDigest !== context.bindingDigest) {
    throw new Error("Promotion attempt claim binding changed.");
  }
  if (
    canonicalJson(current.qaDecision) !== canonicalJson(context.qaDecision)
    || canonicalJson(claim.qaDecision) !== canonicalJson(context.qaDecision)
    || current.ownerQaPacketDigest !== context.ownerQaPacketDigest
    || claim.ownerQaPacketDigest !== context.ownerQaPacketDigest
    || canonicalJson(current.promotionHandoff || null) !== canonicalJson(context.promotionHandoff || null)
    || canonicalJson(claim.promotionHandoff || null) !== canonicalJson(context.promotionHandoff || null)
  ) {
    throw new Error("Promotion attempt QA decision or handoff binding changed.");
  }
  if (
    current.projectPolicyDigest !== context.projectPolicyDigest
    || claim.projectPolicyDigest !== context.projectPolicyDigest
    || current.attemptSeriesDigest !== context.attemptSeriesDigest
    || claim.attemptSeriesDigest !== context.attemptSeriesDigest
  ) {
    throw new Error("Promotion attempt project policy or attempt series changed.");
  }
  if (canonicalJson(current.expectedTaskStateVersions) !== canonicalJson(context.expectedTaskStateVersions)) {
    throw new Error("Promotion attempt task stateVersion changed.");
  }
  for (const [taskId, expected] of Object.entries(current.expectedTaskStateVersions || {})) {
    if (Number(expected) !== Number(claim.expectedTaskStateVersions?.[taskId])) {
      throw new Error("Promotion attempt claim carries stale task versions.");
    }
  }
  const currentReplacement = current.reconciliationReplacement || null;
  const observedReplacement = claim.reconciliationReplacement || null;
  if (Boolean(currentReplacement) !== Boolean(observedReplacement)) {
    throw new Error("Promotion reconciliation replacement binding changed.");
  }
  if (currentReplacement) {
    if (current.mode !== "reconcile" || claim.mode !== "reconcile") {
      throw new Error("Only reconciliation claims may bind a replacement candidate.");
    }
    const normalizedCurrent = normalizedReconciliationReplacement(currentReplacement);
    const normalizedObserved = normalizedReconciliationReplacement(observedReplacement);
    const replacementDigest = sha256(normalizedCurrent);
    if (
      canonicalJson(normalizedCurrent) !== canonicalJson(normalizedObserved)
      || current.reconciliationReplacementDigest !== replacementDigest
      || claim.reconciliationReplacementDigest !== replacementDigest
    ) {
      throw new Error("Promotion reconciliation replacement identity changed.");
    }
    authoritativeReconciliationReplacement(state, context.projectId, normalizedCurrent);
  }
  return { claim: current, context };
}

export function bindPromotionReconciliationReplacementInState(state, claim, input = {}) {
  const candidateId = claim?.candidateId;
  const before = persistedClaimSnapshot(state, candidateId);
  const checked = assertPromotionAttemptClaimInState(state, claim, input);
  if (checked.claim.mode !== "reconcile") {
    throw new Error("Only an active reconciliation claim may bind a replacement candidate.");
  }
  const expected = normalizedReconciliationReplacement(input.replacement);
  const authoritative = authoritativeReconciliationReplacement(state, checked.context.projectId, expected);
  const replacementDigest = sha256(authoritative);
  if (
    checked.claim.reconciliationReplacement
    && (
      checked.claim.reconciliationReplacementDigest !== replacementDigest
      || canonicalJson(checked.claim.reconciliationReplacement) !== canonicalJson(authoritative)
    )
  ) {
    throw new Error("Promotion reconciliation replacement binding is append-only.");
  }
  checked.claim.reconciliationReplacement = authoritative;
  checked.claim.reconciliationReplacementDigest = replacementDigest;
  return attestPromotionClaimTransition(
    structuredClone(checked.claim),
    checked.context.candidateId,
    before,
    state,
  );
}

export function assertTerminalMergedPromotionClaimForTask(claim, task, candidate, context = {}) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw new Error("A terminal merged promotion claim is required.");
  }
  assertCandidateEnvelope(candidate);
  if (
    claim.schemaVersion !== CLAIM_SCHEMA_VERSION
    || claim.status !== "terminal"
    || claim.outcome !== "merged"
    || claim.mode !== "reconcile"
    || claim.projectId !== candidate.projectId
    || claim.candidateId !== candidate.id
    || !task
    || task.projectId !== candidate.projectId
    || Number(claim.expectedTaskStateVersions?.[task.id]) !== positiveStateVersion(task.stateVersion, task.id)
  ) {
    throw new Error("Terminal merged promotion claim identity is incomplete or stale.");
  }
  digest(claim.policyDigest, "terminal claim policy digest");
  digest(claim.bindingDigest, "terminal claim binding digest");
  digest(claim.attemptSeriesDigest, "terminal claim attempt-series digest");
  const projectPolicy = promotionProjectPolicyBinding(claim.projectPolicy);
  if (claim.projectPolicyDigest !== sha256(projectPolicy)) {
    throw new Error("Terminal merged promotion claim project policy digest is invalid.");
  }
  const qaDecision = normalizedCandidateQaDecision(candidate, { reconciliation: true });
  const promotionHandoff = normalizedPromotionHandoff(candidate);
  if (
    canonicalJson(claim.qaDecision) !== canonicalJson(qaDecision)
    || claim.ownerQaPacketDigest !== qaDecision.ownerQaPacketDigest
    || canonicalJson(claim.promotionHandoff) !== canonicalJson(promotionHandoff)
  ) {
    throw new Error("Terminal merged promotion claim QA or promotion handoff changed.");
  }
  const replacement = claim.reconciliationReplacement
    ? normalizedReconciliationReplacement(claim.reconciliationReplacement)
    : null;
  if (replacement) {
    const authoritative = authoritativeReconciliationReplacement(
      {
        candidates: context.candidates || [],
        // The claim's project policy has already been normalized and its
        // digest verified above. Reconstitute the minimum authoritative
        // project record here so lifecycle validation does not depend on an
        // unfenced ambient project object.
        projects: [{ id: candidate.projectId, ...projectPolicy }],
      },
      candidate.projectId,
      replacement,
    );
    if (
      claim.reconciliationReplacementDigest !== sha256(authoritative)
      || canonicalJson(authoritative) !== canonicalJson(replacement)
    ) {
      throw new Error("Terminal merged promotion claim replacement digest is invalid.");
    }
  } else if (claim.reconciliationReplacementDigest) {
    throw new Error("Terminal merged promotion claim has an orphaned replacement digest.");
  }
  const terminalResult = normalizedTerminalPromotionResult(claim.terminalResult, {
    candidateId: candidate.id,
    candidate,
    promotionHandoff,
    claim: { ...claim, reconciliationReplacement: replacement },
  });
  if (
    claim.terminalResult?.schemaVersion !== TERMINAL_RESULT_SCHEMA_VERSION
    || claim.terminalResultDigest !== sha256(terminalResult)
    || canonicalJson(claim.terminalResult) !== canonicalJson(terminalResult)
  ) {
    throw new Error("Terminal merged promotion result digest is invalid.");
  }
  return { claim, terminalResult, replacement };
}

export function renewPromotionAttemptClaimInState(state, claim, input = {}) {
  const { nowMs, now } = time(input);
  const leaseTtlMs = ttl(input);
  const before = persistedClaimSnapshot(state, claim?.candidateId);
  const checked = assertPromotionAttemptClaimInState(state, claim, { ...input, nowMs });
  checked.claim.renewedAt = now;
  checked.claim.expiresAt = new Date(nowMs + leaseTtlMs).toISOString();
  return attestPromotionClaimTransition(
    structuredClone(checked.claim),
    checked.context.candidateId,
    before,
    state,
  );
}

function validationResults(input = {}) {
  const results = input.validationResults || input.validation || [];
  if (!Array.isArray(results) || !results.length) throw new Error("Promotion recovery receipt requires validation results.");
  return results.map((result, index) => {
    const passed = result?.ok === true || result?.status === "passed";
    if (!passed) throw new Error(`Promotion validation result ${index + 1} did not pass.`);
    return {
      command: requiredString(result.command, `validation command ${index + 1}`, 1_000),
      outputDigest: digest(result.outputDigest, `validation output digest ${index + 1}`),
    };
  });
}

function sameReceipt(existing, expected) {
  return [
    "schemaVersion",
    "candidateId",
    "manifestDigest",
    "integrationBranch",
    "integrationSha",
    "policyDigest",
    "validationResultDigest",
  ].every((field) => existing?.[field] === expected[field])
    && canonicalJson(existing?.validationEvidence || null) === canonicalJson(expected.validationEvidence);
}

export function recordPromotionRecoveryReceiptInState(state, claim, input = {}) {
  const before = persistedClaimSnapshot(state, claim?.candidateId);
  const checked = assertPromotionAttemptClaimInState(state, claim, input);
  const results = validationResults(input);
  const validationEvidence = normalizedReceiptEvidence(
    input.validationEvidence,
    checked.context.candidate,
    checked.context.policyDigest,
  );
  const expected = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    candidateId: checked.context.candidate.id,
    manifestDigest: checked.context.candidate.manifestDigest,
    integrationBranch: checked.context.candidate.manifest.integration.branch,
    integrationSha: checked.context.candidate.manifest.integration.sha,
    policyDigest: checked.context.policyDigest,
    validationResultDigest: sha256(results),
    validationEvidence,
  };
  const existing = checked.context.candidate.promotionValidationRecoveryReceipt;
  if (existing) {
    if (!sameReceipt(existing, expected)) throw new Error("Promotion recovery receipt is append-only and does not match this validation result.");
    return attestPromotionClaimTransition({
      reused: true,
      receipt: structuredClone(existing),
      claim: structuredClone(checked.claim),
    }, checked.context.candidateId, before, state);
  }

  const { now } = time(input);
  const receipt = { ...expected, validatedAt: now };
  checked.context.candidate.promotionValidationRecoveryReceipt = receipt;
  checked.context.candidate.updatedAt = now;
  const nextVersions = {};
  for (const { task, source } of checked.context.tasks) {
    const previousVersion = positiveStateVersion(task.stateVersion, source.taskId);
    if (input.advanceTaskVersion) {
      input.advanceTaskVersion({ task, source, candidate: checked.context.candidate, previousVersion, now });
    } else {
      task.stateVersion = previousVersion + 1;
      task.updatedAt = now;
    }
    const nextVersion = positiveStateVersion(task.stateVersion, source.taskId);
    if (nextVersion !== previousVersion + 1) {
      throw new Error(`Promotion recovery receipt must advance task ${source.taskId} by exactly one stateVersion.`);
    }
    nextVersions[source.taskId] = nextVersion;
  }
  const rebound = candidateContext(state, {
    projectId: checked.context.projectId,
    candidateId: checked.context.candidateId,
    mode: checked.context.mode,
    policyDigest: checked.context.policyDigest,
    projectPolicy: checked.context.projectPolicy,
  }, nextVersions);
  checked.claim.bindingDigest = rebound.bindingDigest;
  checked.claim.projectPolicy = rebound.projectPolicy;
  checked.claim.projectPolicyDigest = rebound.projectPolicyDigest;
  checked.claim.qaDecision = rebound.qaDecision;
  checked.claim.ownerQaPacketDigest = rebound.ownerQaPacketDigest;
  checked.claim.promotionHandoff = rebound.promotionHandoff;
  checked.claim.attemptSeriesDigest = rebound.attemptSeriesDigest;
  checked.claim.expectedTaskStateVersions = rebound.expectedTaskStateVersions;
  return attestPromotionClaimTransition({
    reused: false,
    receipt: structuredClone(receipt),
    claim: structuredClone(checked.claim),
  }, checked.context.candidateId, before, state);
}

export function terminalPromotionAttemptClaimInState(state, claim, input = {}) {
  const { nowMs, now } = time(input);
  const before = persistedClaimSnapshot(state, claim?.candidateId);
  const checked = assertPromotionAttemptClaimInState(state, claim, input);
  checked.claim.status = "terminal";
  checked.claim.outcome = requiredString(input.outcome || "completed", "promotion attempt outcome", 80);
  if (checked.claim.outcome === "merged") {
    const terminalResult = normalizedTerminalPromotionResult(input.terminalResult, {
      ...checked.context,
      claim: checked.claim,
    });
    checked.claim.terminalResult = terminalResult;
    checked.claim.terminalResultDigest = sha256(terminalResult);
  } else {
    checked.claim.terminalResult = null;
    checked.claim.terminalResultDigest = "";
  }
  checked.claim.terminalAt = now;
  if (checked.claim.mode === "reconcile") {
    checked.claim.retryNotBefore = "";
    checked.claim.attemptsExhausted = false;
    checked.claim.circuit = null;
  } else if (REPLAYABLE_TERMINAL_OUTCOMES.has(checked.claim.outcome)) {
    const attempts = positiveOperationalAttempt(checked.claim.operationalAttempt);
    const exhausted = attempts >= MAX_OPERATIONAL_ATTEMPTS;
    checked.claim.attemptsExhausted = exhausted;
    checked.claim.retryNotBefore = exhausted
      ? ""
      : new Date(nowMs + (OPERATIONAL_RETRY_BASE_MS * (2 ** (attempts - 1)))).toISOString();
    checked.claim.circuit = exhausted
      ? circuitMetadata(checked.claim, "promotion_attempt_budget_exhausted", now)
      : null;
  } else {
    checked.claim.retryNotBefore = "";
    checked.claim.attemptsExhausted = false;
    checked.claim.circuit = null;
  }
  return attestPromotionClaimTransition(
    structuredClone(checked.claim),
    checked.context.candidateId,
    before,
    state,
  );
}
