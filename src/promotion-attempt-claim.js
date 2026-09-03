import { createHash, randomUUID } from "node:crypto";
import { assertCandidateEnvelope, canonicalJson } from "./candidate-manifest.js";

const CLAIM_SCHEMA_VERSION = "studioops.promotion-attempt-claim.v1";
const RECEIPT_SCHEMA_VERSION = "studioops.promotion-validation-recovery.v1";
const RETRY_AUTHORIZATION_SCHEMA_VERSION = "studioops.promotion-retry-authorization.v1";
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MODES = new Set(["create", "retry"]);

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

export function validPromotionRetryAuthorization(task, candidate, source, policyDigest) {
  try {
    assertCandidateEnvelope(candidate);
    const authorization = retryAuthorization(task);
    return Boolean(
      authorization
      && task?.status === "approved_for_main"
      && Number(task?.promotionValidationAttempts) === 1
      && authorization.candidateId === candidate.id
      && authorization.manifestDigest === candidate.manifestDigest
      && authorization.integrationSha === candidate.manifest.integration.sha
      && authorization.policyDigest === digest(policyDigest, "promotion validation policy digest")
      && DIGEST_PATTERN.test(authorization.firstEvidenceDigest)
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
  return { receipt, receiptDigest: sha256(receipt) };
}

function candidateContext(state, input, versionOverride = null) {
  const projectId = requiredString(input.projectId, "projectId", 160);
  const candidateId = requiredString(input.candidateId, "candidateId", 160);
  const attemptMode = mode(input.mode);
  const policyDigest = digest(input.policyDigest, "promotion validation policy digest");
  const candidate = (state.candidates || []).find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown promotion candidate: ${candidateId}.`);
  assertCandidateEnvelope(candidate);
  if (candidate.projectId !== projectId) throw new Error("Promotion candidate project binding changed.");
  if (candidate.invalidation || candidate.status === "invalidated") {
    throw new Error(`Promotion candidate ${candidateId} is invalidated.`);
  }
  if (candidate.status !== "qa_passed") {
    throw new Error(`Promotion candidate ${candidateId} is no longer QA-passed.`);
  }

  const tasksById = new Map((state.tasks || []).map((task) => [task.id, task]));
  const tasks = candidate.manifest.sources.map((source) => {
    const task = tasksById.get(source.taskId);
    if (!task) throw new Error(`Candidate source task ${source.taskId} is missing.`);
    if (
      task.projectId !== projectId
      || task.status !== "approved_for_main"
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
    const authorization = attemptMode === "retry" ? retryAuthorization(task) : null;
    return {
      task,
      source,
      binding: {
        taskId: source.taskId,
        candidateId: task.candidateId,
        qaBundleId: task.qaBundleId,
        reviewSubjectSha: String(task.reviewSubjectSha).toLowerCase(),
        reviewSubjectCycle: Number(task.reviewSubjectCycle),
        stateVersion,
        retryAuthorization: authorization,
      },
    };
  });
  const { receipt, receiptDigest } = receiptBinding(candidate, policyDigest);
  const binding = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    projectId,
    candidateId,
    mode: attemptMode,
    policyDigest,
    manifestDigest: candidate.manifestDigest,
    qaBundleId: candidate.qaBundleId,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    receiptDigest,
    tasks: tasks.map(({ binding: item }) => item),
  };
  return {
    projectId,
    candidateId,
    mode: attemptMode,
    policyDigest,
    candidate,
    tasks,
    binding,
    bindingDigest: sha256(binding),
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
}

export function claimPromotionAttemptInState(state, input = {}) {
  const { nowMs, now } = time(input);
  const leaseTtlMs = ttl(input);
  const context = candidateContext(state, input);
  const claims = claimStore(state);
  const existing = claims[context.candidateId];
  if (active(existing, nowMs)) return { acquired: false, claim: structuredClone(existing) };
  if (existing?.status === "terminal" && existing.mode === context.mode && existing.bindingDigest === context.bindingDigest) {
    return { acquired: false, claim: structuredClone(existing) };
  }
  const factory = input.claimIdFactory || randomUUID;
  const claimId = requiredString(factory(context, existing), "promotion claim ID", 160);
  const claim = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claimId,
    fence: Math.max(0, Number(existing?.fence || 0)) + 1,
    status: "active",
    projectId: context.projectId,
    candidateId: context.candidateId,
    mode: context.mode,
    attempt: context.mode === "retry" ? 2 : 1,
    policyDigest: context.policyDigest,
    bindingDigest: context.bindingDigest,
    expectedTaskStateVersions: context.expectedTaskStateVersions,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: new Date(nowMs + leaseTtlMs).toISOString(),
  };
  claims[context.candidateId] = claim;
  return { acquired: true, claim: structuredClone(claim), receipt: context.receipt ? structuredClone(context.receipt) : null };
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
  if (!active(current, nowMs)) throw new Error("Promotion attempt claim is expired.");
  if (current.bindingDigest !== claim.bindingDigest || current.bindingDigest !== context.bindingDigest) {
    throw new Error("Promotion attempt claim binding changed.");
  }
  if (canonicalJson(current.expectedTaskStateVersions) !== canonicalJson(context.expectedTaskStateVersions)) {
    throw new Error("Promotion attempt task stateVersion changed.");
  }
  for (const [taskId, expected] of Object.entries(current.expectedTaskStateVersions || {})) {
    if (Number(expected) !== Number(claim.expectedTaskStateVersions?.[taskId])) {
      throw new Error("Promotion attempt claim carries stale task versions.");
    }
  }
  return { claim: current, context };
}

export function renewPromotionAttemptClaimInState(state, claim, input = {}) {
  const { nowMs, now } = time(input);
  const leaseTtlMs = ttl(input);
  const checked = assertPromotionAttemptClaimInState(state, claim, { ...input, nowMs });
  checked.claim.renewedAt = now;
  checked.claim.expiresAt = new Date(nowMs + leaseTtlMs).toISOString();
  return structuredClone(checked.claim);
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
  ].every((field) => existing?.[field] === expected[field]);
}

export function recordPromotionRecoveryReceiptInState(state, claim, input = {}) {
  const checked = assertPromotionAttemptClaimInState(state, claim, input);
  if (checked.context.mode !== "retry") throw new Error("Promotion recovery receipts are only valid for retry attempts.");
  const results = validationResults(input);
  const expected = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    candidateId: checked.context.candidate.id,
    manifestDigest: checked.context.candidate.manifestDigest,
    integrationBranch: checked.context.candidate.manifest.integration.branch,
    integrationSha: checked.context.candidate.manifest.integration.sha,
    policyDigest: checked.context.policyDigest,
    validationResultDigest: sha256(results),
  };
  const existing = checked.context.candidate.promotionValidationRecoveryReceipt;
  if (existing) {
    if (!sameReceipt(existing, expected)) throw new Error("Promotion recovery receipt is append-only and does not match this validation result.");
    return { reused: true, receipt: structuredClone(existing), claim: structuredClone(checked.claim) };
  }

  const { now } = time(input);
  const receipt = { ...expected, validatedAt: now };
  checked.context.candidate.promotionValidationRecoveryReceipt = receipt;
  checked.context.candidate.updatedAt = now;
  const nextVersions = {};
  for (const { task, source } of checked.context.tasks) {
    const nextVersion = positiveStateVersion(task.stateVersion, source.taskId) + 1;
    task.stateVersion = nextVersion;
    nextVersions[source.taskId] = nextVersion;
  }
  const rebound = candidateContext(state, {
    projectId: checked.context.projectId,
    candidateId: checked.context.candidateId,
    mode: checked.context.mode,
    policyDigest: checked.context.policyDigest,
  }, nextVersions);
  checked.claim.bindingDigest = rebound.bindingDigest;
  checked.claim.expectedTaskStateVersions = rebound.expectedTaskStateVersions;
  return { reused: false, receipt: structuredClone(receipt), claim: structuredClone(checked.claim) };
}

export function terminalPromotionAttemptClaimInState(state, claim, input = {}) {
  const { now } = time(input);
  const checked = assertPromotionAttemptClaimInState(state, claim, input);
  checked.claim.status = "terminal";
  checked.claim.outcome = requiredString(input.outcome || "completed", "promotion attempt outcome", 80);
  checked.claim.terminalAt = now;
  return structuredClone(checked.claim);
}
