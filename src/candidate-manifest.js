import { createHash } from "node:crypto";

export const CANDIDATE_MANIFEST_SCHEMA_VERSION = "studioops.candidate-manifest.v1";
const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMPLETE_REVIEW_OUTCOMES = new Set(["approved", "skipped"]);

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function normalizeGitSha(value, label = "Git SHA") {
  const normalized = requiredString(value, label).toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full Git object SHA.`);
  return normalized;
}

function normalizeDigest(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function normalizeCycle(value, label = "candidate cycle") {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return normalized;
}

function normalizeIsoTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return parsed.toISOString();
}

function normalizeBranch(value, label) {
  const branch = requiredString(value, label);
  if (
    branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch === "@"
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch)
    || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`${label} is not a safe Git branch name.`);
  }
  return branch;
}

function normalizeSourceRef(value) {
  const sourceRef = requiredString(value, "source ref");
  if (/^refs\/pull\/[1-9]\d*\/head$/.test(sourceRef)) return sourceRef;
  if (!sourceRef.startsWith("refs/heads/")) {
    throw new Error("Source ref must be a fully qualified branch or pull-request head ref.");
  }
  return `refs/heads/${normalizeBranch(sourceRef.slice("refs/heads/".length), "source branch")}`;
}

function normalizePreviewUrl(value) {
  const previewUrl = requiredString(value, "preview URL");
  let parsed;
  try {
    parsed = new URL(previewUrl);
  } catch {
    throw new Error("Preview URL must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Preview URL must be an absolute HTTP(S) URL without credentials, query parameters, or fragments.");
  }
  return previewUrl;
}

function isPrimaryLeadReview(review) {
  const stage = String(review.stageKey || "").toLowerCase();
  const role = String(review.role || "").toLowerCase();
  return stage === "lead" || role === "primary-lead-reviewer" || role === "lead-reviewer";
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
  return items;
}

function stringList(value, label) {
  const items = Array.isArray(value) ? value : [];
  const normalized = items.map((item) => requiredString(item, label));
  return [...new Set(normalized)].sort();
}

function normalizeOpaqueActorId(value) {
  const actorId = requiredString(value, "partial-candidate actor ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(actorId)) {
    throw new Error("Partial-candidate actor ID must be a non-sensitive opaque identifier.");
  }
  return actorId;
}

function normalizeReasonCode(value) {
  const reasonCode = requiredString(value, "partial-candidate reason code");
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(reasonCode)) {
    throw new Error("Partial-candidate reason code must be a bounded machine-readable code.");
  }
  return reasonCode;
}

function normalizeReview(input, source) {
  const review = {
    id: requiredString(input?.id, "review ID"),
    stageKey: requiredString(input?.stageKey, "review stage"),
    role: requiredString(input?.role, "review role"),
    outcome: requiredString(input?.outcome, "review outcome"),
    subjectSha: normalizeGitSha(input?.subjectSha, "review subject SHA"),
    candidateCycle: normalizeCycle(input?.candidateCycle, "review candidate cycle"),
    reviewedAt: normalizeIsoTimestamp(input?.reviewedAt || input?.createdAt, "review time"),
  };
  if (!COMPLETE_REVIEW_OUTCOMES.has(review.outcome)) {
    throw new Error(`Review ${review.id} is not complete: ${review.outcome}`);
  }
  if (review.outcome !== "approved" && isPrimaryLeadReview(review)) {
    throw new Error(`Primary lead review ${review.id} must be approved.`);
  }
  if (review.subjectSha !== source.headSha) {
    throw new Error(`Review ${review.id} does not apply to source ${source.taskId}.`);
  }
  if (review.candidateCycle !== source.candidateCycle) {
    throw new Error(`Review ${review.id} has the wrong candidate cycle for source ${source.taskId}.`);
  }
  return review;
}

function normalizeSource(input) {
  const source = {
    taskId: requiredString(input?.taskId, "source task ID"),
    sourceRef: normalizeSourceRef(input?.sourceRef),
    headSha: normalizeGitSha(input?.headSha, "source head SHA"),
    candidateCycle: normalizeCycle(input?.candidateCycle, "source candidate cycle"),
    reviews: [],
  };
  source.reviews = uniqueBy(
    (Array.isArray(input?.reviews) ? input.reviews : [])
      .map((review) => normalizeReview(review, source))
      .sort((a, b) => a.id.localeCompare(b.id)),
    "id",
    "review ID",
  );
  if (!source.reviews.length) throw new Error(`Source ${source.taskId} has no complete review evidence.`);
  if (!source.reviews.some((review) => isPrimaryLeadReview(review) && review.outcome === "approved")) {
    throw new Error(`Source ${source.taskId} has no approved primary lead review.`);
  }
  return source;
}

function normalizeCheck(input, integrationSha) {
  const check = {
    id: requiredString(input?.id, "check ID"),
    kind: requiredString(input?.kind, "check kind"),
    name: requiredString(input?.name, "check name"),
    outcome: requiredString(input?.outcome, "check outcome"),
    subjectSha: normalizeGitSha(input?.subjectSha, "check subject SHA"),
    evidenceDigest: normalizeDigest(input?.evidenceDigest, "check evidence digest"),
  };
  if (check.outcome !== "passed") throw new Error(`Check ${check.id} did not pass.`);
  if (check.subjectSha !== integrationSha) {
    throw new Error(`Check ${check.id} is not bound to the integration SHA.`);
  }
  return check;
}

function normalizePreviewAttestation(input, integrationSha) {
  const attestation = {
    kind: requiredString(input?.kind, "preview attestation kind"),
    key: requiredString(input?.key, "preview attestation key"),
    observedSha: normalizeGitSha(input?.observedSha, "preview attestation SHA"),
  };
  if (!["header", "json"].includes(attestation.kind)) {
    throw new Error(`Unsupported preview attestation kind: ${attestation.kind}`);
  }
  if (attestation.observedSha !== integrationSha) {
    throw new Error("Preview attestation must resolve to the integration SHA.");
  }
  return attestation;
}

function normalizeAssembly(input, sourceTaskIds) {
  const mode = requiredString(input?.mode || "atomic", "assembly mode");
  if (!["atomic", "authorized_partial"].includes(mode)) {
    throw new Error(`Unsupported candidate assembly mode: ${mode}`);
  }
  const requestedTaskIds = stringList(input?.requestedTaskIds, "requested task ID");
  const includedTaskIds = stringList(input?.includedTaskIds, "included task ID");
  const excludedTaskIds = stringList(input?.excludedTaskIds, "excluded task ID");
  if (JSON.stringify(includedTaskIds) !== JSON.stringify([...sourceTaskIds].sort())) {
    throw new Error("Candidate sources must exactly match included task IDs.");
  }
  const requested = new Set(requestedTaskIds);
  if (!requestedTaskIds.length || includedTaskIds.some((id) => !requested.has(id))) {
    throw new Error("Included tasks must be a non-empty subset of requested tasks.");
  }
  const expectedExcluded = requestedTaskIds.filter((id) => !includedTaskIds.includes(id));
  if (JSON.stringify(excludedTaskIds) !== JSON.stringify(expectedExcluded)) {
    throw new Error("Excluded task IDs must be the requested tasks not included in the candidate.");
  }
  if (mode === "atomic") {
    if (excludedTaskIds.length) throw new Error("Atomic candidates cannot exclude requested tasks.");
    return { mode, requestedTaskIds, includedTaskIds, excludedTaskIds, authorization: null };
  }
  if (!excludedTaskIds.length) throw new Error("Partial candidates must exclude at least one requested task.");
  return {
    mode,
    requestedTaskIds,
    includedTaskIds,
    excludedTaskIds,
    authorization: {
      actorId: normalizeOpaqueActorId(input?.authorization?.actorId),
      reasonCode: normalizeReasonCode(input?.authorization?.reasonCode),
    },
  };
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function manifestDigest(manifest) {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

export function buildCandidateManifest(input = {}) {
  const sources = uniqueBy(
    (Array.isArray(input.sources) ? input.sources : [])
      .map(normalizeSource)
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    "taskId",
    "source task ID",
  );
  if (!sources.length) throw new Error("Candidate manifest requires at least one source.");
  uniqueBy(
    sources.flatMap((source) => source.reviews),
    "id",
    "candidate review ID",
  );
  const baseSha = normalizeGitSha(input.base?.sha, "base SHA");
  const integrationSha = normalizeGitSha(input.integration?.sha, "integration SHA");
  const checks = uniqueBy(
    (Array.isArray(input.checks) ? input.checks : [])
      .map((check) => normalizeCheck(check, integrationSha))
      .sort((a, b) => a.id.localeCompare(b.id)),
    "id",
    "check ID",
  );
  if (!checks.length) throw new Error("Candidate manifest requires check evidence.");
  const preview = {
    url: normalizePreviewUrl(input.preview?.url),
    status: requiredString(input.preview?.status, "preview status"),
    commitSha: normalizeGitSha(input.preview?.commitSha, "preview commit SHA"),
    verifiedAt: normalizeIsoTimestamp(input.preview?.verifiedAt, "preview verification time"),
    attestation: normalizePreviewAttestation(input.preview?.attestation, integrationSha),
  };
  if (preview.status !== "healthy") throw new Error("Candidate preview must be healthy.");
  if (preview.commitSha !== integrationSha) {
    throw new Error("Candidate preview must be verified at the integration SHA.");
  }
  return {
    schemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    candidateId: requiredString(input.candidateId, "candidate ID"),
    projectId: requiredString(input.projectId, "project ID"),
    base: {
      branch: normalizeBranch(input.base?.branch, "base branch"),
      sha: baseSha,
    },
    sources,
    integration: {
      branch: normalizeBranch(input.integration?.branch, "integration branch"),
      sha: integrationSha,
    },
    checks,
    preview,
    assembly: normalizeAssembly(input.assembly, new Set(sources.map((source) => source.taskId))),
  };
}

export function createCandidateEnvelope(input = {}) {
  const manifest = buildCandidateManifest(input.manifest || input);
  const now = normalizeIsoTimestamp(input.createdAt || new Date().toISOString(), "candidate creation time");
  return {
    id: manifest.candidateId,
    projectId: manifest.projectId,
    qaBundleId: String(input.qaBundleId || "").trim(),
    status: "frozen",
    manifest,
    manifestDigest: manifestDigest(manifest),
    createdAt: now,
    updatedAt: now,
    invalidation: null,
    qaDecision: null,
    promotion: null,
    promotionMerge: null,
  };
}

export function assertCandidateEnvelope(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("Candidate is required.");
  if (candidate.id !== candidate.manifest?.candidateId) throw new Error("Candidate identity does not match its manifest.");
  if (candidate.projectId !== candidate.manifest?.projectId) throw new Error("Candidate project does not match its manifest.");
  const normalized = buildCandidateManifest(candidate.manifest);
  if (canonicalJson(candidate.manifest) !== canonicalJson(normalized)) {
    throw new Error(`Candidate ${candidate.id} manifest contains unsupported or non-canonical fields.`);
  }
  const expected = manifestDigest(normalized);
  if (candidate.manifestDigest !== expected) throw new Error(`Candidate ${candidate.id} manifest digest mismatch.`);
  return candidate;
}

export function invalidateCandidate(candidate, input = {}) {
  assertCandidateEnvelope(candidate);
  if (candidate.invalidation) return candidate;
  const now = normalizeIsoTimestamp(input.invalidatedAt || new Date().toISOString(), "candidate invalidation time");
  candidate.status = "invalidated";
  candidate.invalidation = {
    reason: requiredString(input.reason, "candidate invalidation reason"),
    observedAt: now,
    expected: String(input.expected || "").trim(),
    observed: String(input.observed || "").trim(),
  };
  candidate.updatedAt = now;
  return candidate;
}
