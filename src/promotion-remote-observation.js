import { createHash } from "node:crypto";
import { canonicalJson } from "./candidate-manifest.js";
import { redactSecrets } from "./github-app-auth.js";
import { boundedHeadTail } from "./promotion-validation-evidence.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
  registerIsolatedTestAdapter,
} from "./test-authority-realm.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REPOSITORY_SEGMENT_PATTERN = "[A-Za-z0-9_.-]+";
const PROMOTION_GITHUB_API_ROUTES = Object.freeze({
  list: Object.freeze({
    method: "GET",
    pathname: new RegExp(
      `^/repos/(?<owner>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/(?<name>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/pulls$`,
    ),
    query: new Set(["state", "base", "head", "per_page", "sort", "direction"]),
  }),
  "get-merged-recovery": Object.freeze({
    method: "GET",
    pathname: new RegExp(
      `^/repos/(?<owner>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/(?<name>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/pulls/(?<number>[1-9][0-9]*)$`,
    ),
    query: new Set(),
  }),
  create: Object.freeze({
    method: "POST",
    pathname: new RegExp(
      `^/repos/(?<owner>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/(?<name>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/pulls$`,
    ),
    query: new Set(),
  }),
  close: Object.freeze({
    method: "PATCH",
    pathname: new RegExp(
      `^/repos/(?<owner>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/(?<name>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/pulls/(?<number>[1-9][0-9]*)$`,
    ),
    query: new Set(),
  }),
  comment: Object.freeze({
    method: "POST",
    pathname: new RegExp(
      `^/repos/(?<owner>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/(?<name>${GITHUB_REPOSITORY_SEGMENT_PATTERN})/issues/(?<number>[1-9][0-9]*)/comments$`,
    ),
    query: new Set(),
  }),
});
const MAX_OUTPUT_CHARS = 4_000;
const OBSERVATION_SCHEMA_VERSION = "studioops.promotion-remote-observation.v1";
const MERGED_RECOVERY_OBSERVATION_SCHEMA_VERSION = "studioops.merged-promotion-recovery-observation.v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const trustedFetch = typeof globalThis.fetch === "function"
  ? globalThis.fetch.bind(globalThis)
  : null;
const testAuthorityRegistration = consumeIsolatedTestAuthority((capability) => ({ capability }));

// Only this module can place entries in the map, and the production placement
// path is reached only after a real GitHub list request and exact identity
// comparison. Persisted JSON and structured clones cannot reproduce the seal.
const verifiedPromotionRemoteObservations = new WeakMap();
const verifiedMergedPromotionRecoveryObservations = new WeakMap();

function truncate(value, limit = MAX_OUTPUT_CHARS) {
  return boundedHeadTail(String(value || "").trim(), limit);
}

function normalizeSecrets(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(String).filter(Boolean))];
}

function normalizedPromotionGitHubApiRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Promotion GitHub API request is required.");
  }
  const operation = String(request.operation || "");
  const route = PROMOTION_GITHUB_API_ROUTES[operation];
  if (!route) throw new Error("Promotion GitHub API operation is not allowed.");
  if (request.method !== route.method) {
    throw new Error(`Promotion GitHub API ${operation} requires ${route.method}.`);
  }
  const pathname = typeof request.pathname === "string" ? request.pathname : "";
  if (
    !pathname
    || pathname.trim() !== pathname
    || !pathname.startsWith("/")
    || pathname.startsWith("//")
    || pathname.includes("\\")
    || pathname.includes("?")
    || pathname.includes("#")
  ) {
    throw new Error("Promotion GitHub API pathname must be an exact relative API path.");
  }
  let url;
  try {
    url = new URL(pathname, `${GITHUB_API_BASE}/`);
  } catch {
    throw new Error("Promotion GitHub API pathname must be an exact relative API path.");
  }
  if (
    url.origin !== GITHUB_API_BASE
    || url.protocol !== "https:"
    || url.hostname !== "api.github.com"
    || url.port
    || url.username
    || url.password
    || url.pathname !== pathname
    || url.search
    || url.hash
  ) {
    throw new Error("Promotion GitHub API request must remain on exact https://api.github.com.");
  }
  const match = route.pathname.exec(pathname);
  if (!match) throw new Error("Promotion GitHub API route is not allowed for this operation.");
  const owner = match.groups?.owner || "";
  const name = match.groups?.name || "";
  if (
    [owner, name].some((segment) => segment === "." || segment === "..")
    || name.toLowerCase().endsWith(".git")
  ) {
    throw new Error("Promotion GitHub API repository path is not canonical.");
  }
  const repository = `${owner}/${name}`;
  if (request.repository !== repository) {
    throw new Error("Promotion GitHub API repository binding changed.");
  }
  if (match.groups?.number && Number(request.number) !== Number(match.groups.number)) {
    throw new Error("Promotion GitHub API pull request number binding changed.");
  }
  if (route.method === "GET" && request.body !== undefined) {
    throw new Error("Promotion GitHub API read operations do not accept a request body.");
  }
  const query = request.query ?? {};
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Promotion GitHub API query must be an object.");
  }
  for (const [key, value] of Object.entries(query)) {
    if (!route.query.has(key)) {
      throw new Error(`Promotion GitHub API query parameter ${key} is not allowed.`);
    }
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return { method: route.method, url };
}

function requiredString(value, label, max = 4_096) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return normalized;
}

function requiredDigest(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function requiredGitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full Git SHA.`);
  return normalized;
}

function canonicalGitHubRepository(value) {
  const raw = requiredString(value, "promotion repository URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Promotion requires an exact canonical HTTPS GitHub repository URL.");
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
    throw new Error("Promotion requires an exact canonical HTTPS GitHub repository URL.");
  }
  const url = `https://github.com/${segments[0]}/${segments[1]}`;
  if (raw !== url) throw new Error("Promotion requires an exact canonical HTTPS GitHub repository URL.");
  return { url, repository: `${segments[0]}/${segments[1]}` };
}

function normalizedCandidate(candidate, label, projectId) {
  if (!candidate || typeof candidate !== "object") throw new Error(`${label} is required.`);
  const id = requiredString(candidate.id, `${label} ID`, 256);
  const manifestDigest = requiredDigest(candidate.manifestDigest, `${label} manifest digest`);
  const integrationSha = requiredGitSha(candidate.manifest?.integration?.sha, `${label} integration SHA`);
  const integrationBranch = requiredString(
    candidate.manifest?.integration?.branch,
    `${label} integration branch`,
    1_024,
  );
  const baseBranch = requiredString(candidate.manifest?.base?.branch, `${label} base branch`, 1_024);
  if (candidate.projectId && String(candidate.projectId) !== projectId) {
    throw new Error(`${label} project binding changed.`);
  }
  return { id, manifestDigest, integrationSha, integrationBranch, baseBranch };
}

function normalizedClaim(claim, projectId, subject) {
  if (!claim || typeof claim !== "object") throw new Error("Promotion remote observation requires a fenced claim.");
  const claimId = requiredString(claim.claimId, "promotion claim ID", 256);
  const fence = Number(claim.fence);
  if (!Number.isSafeInteger(fence) || fence < 1) throw new Error("Promotion claim fence must be positive.");
  const bindingDigest = requiredDigest(claim.bindingDigest, "promotion claim binding digest");
  if (String(claim.projectId || "") !== projectId) throw new Error("Promotion claim project binding changed.");
  if (String(claim.candidateId || "") !== subject.id) throw new Error("Promotion claim candidate binding changed.");
  if (
    claim.qaDecision?.candidateId !== subject.id
    || claim.qaDecision?.manifestDigest !== subject.manifestDigest
    || String(claim.qaDecision?.integrationSha || "").toLowerCase() !== subject.integrationSha
  ) {
    throw new Error("Promotion claim immutable candidate binding changed.");
  }
  return { claimId, fence, bindingDigest, mode: String(claim.mode || "") };
}

function legacyCandidateFields(candidate) {
  return {
    candidate: `Candidate: ${candidate.id}`,
    manifest: `Manifest: ${candidate.manifestDigest}`,
    integrationSha: `Integration SHA: ${candidate.integrationSha}`,
  };
}

function normalizedAuthority(input = {}) {
  const projectId = requiredString(input.projectId, "promotion project ID", 256);
  const repositoryAuthority = canonicalGitHubRepository(input.repoUrl);
  const remoteCandidate = normalizedCandidate(input.candidate, "promotion remote candidate", projectId);
  const subjectCandidate = normalizedCandidate(
    input.subjectCandidate || input.candidate,
    "promotion claim subject candidate",
    projectId,
  );
  const claim = normalizedClaim(input.claim, projectId, subjectCandidate);
  const targetBranch = requiredString(input.targetBranch, "promotion target branch", 1_024);
  const promotionBranch = requiredString(input.promotionBranch, "promotion head branch", 1_024);
  const headSha = requiredGitSha(input.headSha, "promotion head SHA");
  if (targetBranch !== remoteCandidate.baseBranch) {
    throw new Error("Promotion target branch does not match the remote candidate base branch.");
  }
  if (headSha !== remoteCandidate.integrationSha) {
    throw new Error("Promotion head SHA does not match the remote candidate integration SHA.");
  }
  let legacyMergedReconciliationPrUrl = "";
  if (claim.mode === "reconcile") {
    const promotion = input.candidate?.promotion;
    if (
      promotion
      && promotion.branch === promotionBranch
      && String(promotion.commitSha || "").toLowerCase() === headSha
      && String(promotion.manifestDigest || "").toLowerCase() === remoteCandidate.manifestDigest
      && Number.isFinite(Date.parse(promotion.readyAt || ""))
    ) {
      legacyMergedReconciliationPrUrl = canonicalPromotionPullRequestUrl(
        promotion.prUrl,
        repositoryAuthority.repository,
      ).url;
    }
  }
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    projectId,
    repositoryUrl: repositoryAuthority.url,
    repository: repositoryAuthority.repository,
    subjectCandidateId: subjectCandidate.id,
    subjectManifestDigest: subjectCandidate.manifestDigest,
    subjectIntegrationSha: subjectCandidate.integrationSha,
    candidateId: remoteCandidate.id,
    manifestDigest: remoteCandidate.manifestDigest,
    integrationBranch: remoteCandidate.integrationBranch,
    integrationSha: remoteCandidate.integrationSha,
    baseRefName: targetBranch,
    headRefName: promotionBranch,
    headRefOid: headSha,
    candidateMarker: `<!-- studioops-candidate:${remoteCandidate.id}:${remoteCandidate.manifestDigest} -->`,
    claimMarker: `<!-- studioops-claim:${claim.claimId}:${claim.fence} -->`,
    legacyCandidateFields: legacyCandidateFields(remoteCandidate),
    legacyMergedReconciliationPrUrl,
    claimId: claim.claimId,
    claimFence: claim.fence,
    claimBindingDigest: claim.bindingDigest,
  };
}

function canonicalPromotionPullRequestUrl(value, repository) {
  const raw = requiredString(value, "promotion pull request URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Promotion recovery requires an exact canonical GitHub pull request URL.");
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
    || segments.length !== 4
    || segments[2] !== "pull"
    || !/^[1-9][0-9]*$/.test(segments[3])
    || `${segments[0]}/${segments[1]}`.toLowerCase() !== repository.toLowerCase()
    || raw !== `https://github.com/${segments[0]}/${segments[1]}/pull/${segments[3]}`
  ) {
    throw new Error("Promotion recovery requires an exact canonical GitHub pull request URL.");
  }
  return { url: raw, number: Number(segments[3]) };
}

function normalizedRecoveryTaskBindings(tasks, candidate, projectId) {
  if (!Array.isArray(tasks)) throw new Error("Promotion recovery requires exact source-task bindings.");
  const sources = new Map((candidate.manifest?.sources || []).map((source) => [String(source.taskId), source]));
  const integrationSha = String(candidate.manifest?.integration?.sha || "").toLowerCase();
  if (tasks.length !== sources.size) throw new Error("Promotion recovery source-task membership changed.");
  const bindings = tasks.map((task) => {
    const id = requiredString(task?.id, "promotion recovery task ID", 256);
    const source = sources.get(id);
    const stateVersion = Number(task?.stateVersion);
    if (
      !source
      || task.projectId !== projectId
      || task.candidateId !== candidate.id
      || task.qaBundleId !== candidate.qaBundleId
      || String(task.candidateManifestDigest || "").toLowerCase() !== candidate.manifestDigest
      || String(task.integrationCommit || "").toLowerCase() !== integrationSha
      || String(task.reviewSubjectSha || "").toLowerCase() !== String(source.headSha || "").toLowerCase()
      || Number(task.reviewSubjectCycle) !== Number(source.candidateCycle)
      || !Number.isSafeInteger(stateVersion)
      || stateVersion < 1
    ) {
      throw new Error(`Promotion recovery task ${id} no longer has the exact immutable candidate binding.`);
    }
    return {
      id,
      stateVersion,
      status: String(task.status || ""),
      assignedAgentRole: String(task.assignedAgentRole || ""),
      promotionStatus: String(task.promotionStatus || ""),
      promotionPrUrl: String(task.promotionPrUrl || ""),
      promotionBranch: String(task.promotionBranch || ""),
      projectId: task.projectId,
      candidateId: task.candidateId,
      qaBundleId: task.qaBundleId,
      candidateManifestDigest: String(task.candidateManifestDigest || "").toLowerCase(),
      integrationCommit: String(task.integrationCommit || "").toLowerCase(),
      reviewSubjectSha: String(task.reviewSubjectSha || "").toLowerCase(),
      reviewSubjectCycle: Number(task.reviewSubjectCycle),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindings.map((binding) => binding.id)).size !== sources.size) {
    throw new Error("Promotion recovery source-task membership is not unique.");
  }
  return bindings;
}

function normalizedRecoveryBundleBinding(bundle, candidate) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Promotion recovery requires the exact release QA bundle.");
  }
  const expectedTaskIds = candidate.manifest.sources.map((source) => String(source.taskId)).sort();
  const promotedTaskIds = Array.isArray(bundle.promotedTaskIds)
    ? bundle.promotedTaskIds.map(String).sort()
    : [];
  if (
    bundle.id !== candidate.qaBundleId
    || bundle.projectId !== candidate.projectId
    || bundle.candidateId !== candidate.id
    || bundle.manifestDigest !== candidate.manifestDigest
    || bundle.integrationCommit !== candidate.manifest.integration.sha
    || bundle.status !== "release_candidate_ready"
    || bundle.promotionPrUrl !== candidate.promotion?.prUrl
    || bundle.promotionBranch !== candidate.promotion?.branch
    || bundle.promotionCommit !== candidate.promotion?.commitSha
    || JSON.stringify(promotedTaskIds) !== JSON.stringify(expectedTaskIds)
  ) {
    throw new Error("Promotion recovery QA bundle no longer mirrors the persisted release handoff.");
  }
  return {
    id: bundle.id,
    status: bundle.status,
    candidateId: bundle.candidateId,
    manifestDigest: bundle.manifestDigest,
    integrationCommit: bundle.integrationCommit,
    promotionPrUrl: bundle.promotionPrUrl,
    promotionBranch: bundle.promotionBranch,
    promotionCommit: bundle.promotionCommit,
    promotedTaskIds,
    packetDigest: String(bundle.packetDigest || ""),
    promotionReadyAt: String(bundle.promotionReadyAt || ""),
  };
}

function normalizedRecoveryHandoffClaim(claim, candidate) {
  if (!claim) return null;
  const fence = Number(claim.fence);
  if (
    claim.status !== "terminal"
    || !["pr_ready", "pr_merged_detected"].includes(claim.outcome)
    || !["create", "retry"].includes(claim.mode)
    || claim.projectId !== candidate.projectId
    || claim.candidateId !== candidate.id
    || claim.qaDecision?.candidateId !== candidate.id
    || claim.qaDecision?.manifestDigest !== candidate.manifestDigest
    || String(claim.qaDecision?.integrationSha || "").toLowerCase()
      !== String(candidate.manifest?.integration?.sha || "").toLowerCase()
    || !Number.isSafeInteger(fence)
    || fence < 1
  ) {
    throw new Error("Promotion recovery historical handoff claim is incompatible.");
  }
  return {
    claimId: requiredString(claim.claimId, "promotion recovery historical claim ID", 256),
    fence,
    bindingDigest: requiredDigest(claim.bindingDigest, "promotion recovery historical claim binding digest"),
    mode: claim.mode,
    outcome: claim.outcome,
    completedAt: String(claim.completedAt || ""),
  };
}

function normalizedRecoveryProvenance(input, candidate, bundleBinding) {
  const promotionReadyAt = new Date(requiredString(
    candidate.promotion?.readyAt,
    "promotion recovery ready time",
  )).toISOString();
  if (
    !bundleBinding.promotionReadyAt
    || new Date(bundleBinding.promotionReadyAt).toISOString() !== promotionReadyAt
  ) {
    throw new Error("Promotion recovery bundle does not bind the exact promotion-ready time.");
  }
  const events = Array.isArray(input.events) ? input.events : [];
  const tasksById = new Map((input.tasks || []).map((task) => [String(task?.id || ""), task]));
  const staleTasks = [];
  for (const source of candidate.manifest?.sources || []) {
    const task = tasksById.get(String(source.taskId));
    if (
      !task
      || task.status !== "needs_changes"
      || task.assignedAgentRole !== "builder"
      || task.promotionStatus !== "validation_failed"
      || task.promotionPrUrl !== candidate.promotion?.prUrl
      || task.promotionBranch !== candidate.promotion?.branch
    ) continue;
    const failureRecordedAt = new Date(requiredString(
      task.promotionUpdatedAt,
      `promotion recovery task ${task.id} failure time`,
    )).toISOString();
    if (Date.parse(failureRecordedAt) <= Date.parse(promotionReadyAt)) {
      throw new Error(`Promotion recovery task ${task.id} failure did not follow its release handoff.`);
    }
    if (
      task.promotionCommit !== candidate.manifest.integration.sha
      || task.promotionValidation?.status !== "validation_failed"
      || !Array.isArray(task.promotionValidation?.commands)
      || !task.promotionValidation.commands.some((command) => command?.ok === false)
    ) {
      throw new Error(`Promotion recovery task ${task.id} lacks exact failed-validation evidence.`);
    }
    const readyEvents = events.filter((event) => (
      event?.type === "promotion_pr_ready"
      && event.taskId === task.id
      && new Date(event.createdAt).toISOString() === promotionReadyAt
    ));
    const failureEvents = events.filter((event) => (
      event?.type === "promotion_validation_failed"
      && event.taskId === task.id
      && new Date(event.createdAt).toISOString() === failureRecordedAt
    ));
    if (readyEvents.length !== 1 || failureEvents.length !== 1) {
      throw new Error(`Promotion recovery task ${task.id} lacks unique append-only ready/failure chronology.`);
    }
    staleTasks.push({
      taskId: task.id,
      promotionReadyAt,
      failureRecordedAt,
      validationDigest: `sha256:${createHash("sha256")
        .update(canonicalJson(task.promotionValidation))
        .digest("hex")}`,
      readyEventId: requiredString(readyEvents[0].id, `promotion recovery task ${task.id} ready event ID`, 256),
      failureEventId: requiredString(failureEvents[0].id, `promotion recovery task ${task.id} failure event ID`, 256),
    });
  }
  if (!staleTasks.length) {
    throw new Error("Promotion recovery requires a stale post-handoff validation result with durable chronology.");
  }
  return {
    promotionReadyAt,
    handoffClaim: normalizedRecoveryHandoffClaim(input.handoffClaim, candidate),
    staleTasks: staleTasks.sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

function normalizedMergedRecoveryAuthority(input = {}) {
  const projectId = requiredString(input.projectId, "promotion project ID", 256);
  const repositoryAuthority = canonicalGitHubRepository(input.repoUrl);
  const candidate = normalizedCandidate(input.candidate, "promotion recovery candidate", projectId);
  const promotion = input.candidate?.promotion;
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) {
    throw new Error("Promotion recovery requires the persisted release-candidate handoff.");
  }
  const targetBranch = requiredString(input.targetBranch, "promotion target branch", 1_024);
  const promotionBranch = requiredString(input.promotionBranch, "promotion head branch", 1_024);
  const headSha = requiredGitSha(input.headSha, "promotion head SHA");
  const promotionPr = canonicalPromotionPullRequestUrl(promotion.prUrl, repositoryAuthority.repository);
  if (
    targetBranch !== candidate.baseBranch
    || promotionBranch !== String(promotion.branch || "")
    || headSha !== candidate.integrationSha
    || headSha !== String(promotion.commitSha || "").toLowerCase()
    || candidate.manifestDigest !== String(promotion.manifestDigest || "").toLowerCase()
    || !Number.isFinite(Date.parse(promotion.readyAt || ""))
  ) {
    throw new Error("Promotion recovery handoff does not match the immutable candidate.");
  }
  const taskBindings = normalizedRecoveryTaskBindings(input.tasks, input.candidate, projectId);
  const bundleBinding = normalizedRecoveryBundleBinding(input.bundle, input.candidate);
  const recoveryProvenance = normalizedRecoveryProvenance(input, input.candidate, bundleBinding);
  return {
    schemaVersion: MERGED_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    projectId,
    repositoryUrl: repositoryAuthority.url,
    repository: repositoryAuthority.repository,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.integrationBranch,
    integrationSha: candidate.integrationSha,
    baseRefName: targetBranch,
    headRefName: promotionBranch,
    headRefOid: headSha,
    promotionPrUrl: promotionPr.url,
    promotionPrNumber: promotionPr.number,
    candidateMarker: `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
    legacyCandidateFields: legacyCandidateFields(candidate),
    taskBindings,
    bundleBinding,
    recoveryProvenance,
  };
}

/** Build the exact local snapshot that a merge-recovery observation seals. */
export function mergedPromotionRecoveryAuthorityForState(state, candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Promotion recovery candidate is required.");
  }
  const project = (state?.projects || []).find((item) => item.id === candidate.projectId);
  const bundle = (state?.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  const tasksById = new Map((state?.tasks || []).map((task) => [task.id, task]));
  const tasks = (candidate.manifest?.sources || []).map((source) => tasksById.get(source.taskId));
  if (!project || !bundle || tasks.some((task) => !task)) {
    throw new Error("Promotion recovery local authority is incomplete.");
  }
  return {
    projectId: project.id,
    repoUrl: project.repoUrl,
    targetBranch: candidate.manifest?.base?.branch,
    promotionBranch: candidate.promotion?.branch,
    headSha: candidate.manifest?.integration?.sha,
    candidate,
    tasks,
    bundle,
    events: state?.events || [],
    handoffClaim: state?.meta?.promotionAttemptClaims?.[candidate.id] || null,
  };
}

function normalizedPromotionPr(item, repository) {
  return {
    number: Number(item?.number),
    url: String(item?.html_url || item?.url || "").trim(),
    state: String(item?.merged_at || item?.mergedAt ? "MERGED" : item?.state || "").toUpperCase(),
    mergedAt: String(item?.merged_at || item?.mergedAt || ""),
    mergeCommit: String(item?.merge_commit_sha || item?.mergeCommit?.oid || item?.mergeCommit || "").trim().toLowerCase(),
    baseRefName: String(item?.base?.ref || item?.baseRefName || ""),
    headRefName: String(item?.head?.ref || item?.headRefName || ""),
    headRefOid: String(item?.head?.sha || item?.headRefOid || "").toLowerCase(),
    headRepository: String(item?.head?.repo?.full_name || item?.headRepository?.nameWithOwner || item?.headRepository || ""),
    body: String(item?.body || ""),
    repository,
  };
}

function exactPromotionPrIdentity(item, authority) {
  let parsed;
  try {
    parsed = new URL(item.url);
  } catch {
    return false;
  }
  const expectedPath = `/${authority.repository}/pull/${item.number}`.toLowerCase();
  const exactCoordinates = Number.isSafeInteger(item.number)
    && item.number > 0
    && parsed.protocol === "https:"
    && parsed.hostname.toLowerCase() === "github.com"
    && !parsed.port
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && parsed.pathname.replace(/\/$/, "").toLowerCase() === expectedPath
    && item.repository.toLowerCase() === authority.repository.toLowerCase()
    && item.baseRefName === authority.baseRefName
    && item.headRefName === authority.headRefName
    && item.headRefOid === authority.headRefOid
    && item.headRepository.toLowerCase() === authority.repository.toLowerCase()
    && ["OPEN", "CLOSED", "MERGED"].includes(item.state);
  if (!exactCoordinates) return false;
  // The candidate marker is the durable remote identity. A claim marker is
  // additive audit evidence, but retries and reconciliation deliberately use
  // later fenced claims than the one that created the PR.
  const modernClaimIdentity = item.body.includes(authority.candidateMarker);
  const legacyMergedIdentity = Boolean(
    authority.legacyMergedReconciliationPrUrl
    && item.state === "MERGED"
    && item.url === authority.legacyMergedReconciliationPrUrl
    && exactMergedRecoveryBody(item.body, authority),
  );
  return modernClaimIdentity || legacyMergedIdentity;
}

function exactMergedRecoveryBody(body, authority) {
  const lines = String(body || "").split(/\r?\n/).map((line) => line.trim());
  const exactField = (prefix, value) => {
    const matching = lines.filter((line) => line.startsWith(prefix));
    return matching.length === 1 && matching[0] === value;
  };
  const candidateMarkers = lines.filter((line) => line.startsWith("<!-- studioops-candidate:"));
  return lines.includes("## Immutable StudioOps candidate")
    && exactField("Candidate:", authority.legacyCandidateFields.candidate)
    && exactField("Manifest:", authority.legacyCandidateFields.manifest)
    && exactField("Integration SHA:", authority.legacyCandidateFields.integrationSha)
    && (!candidateMarkers.length || (
      candidateMarkers.length === 1
      && candidateMarkers[0] === authority.candidateMarker
    ));
}

function exactMergedRecoveryPrIdentity(item, authority) {
  let parsed;
  try {
    parsed = new URL(item.url);
  } catch {
    return false;
  }
  return item.number === authority.promotionPrNumber
    && item.url === authority.promotionPrUrl
    && parsed.protocol === "https:"
    && parsed.hostname.toLowerCase() === "github.com"
    && !parsed.port
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && item.repository.toLowerCase() === authority.repository.toLowerCase()
    && item.baseRefName === authority.baseRefName
    && item.headRefName === authority.headRefName
    && item.headRefOid === authority.headRefOid
    && item.headRepository.toLowerCase() === authority.repository.toLowerCase()
    && item.state === "MERGED"
    && GIT_SHA_PATTERN.test(item.mergeCommit)
    && Number.isFinite(Date.parse(item.mergedAt || ""))
    && authority.recoveryProvenance.staleTasks.every((task) => (
      Date.parse(task.failureRecordedAt) > Date.parse(item.mergedAt)
    ))
    && exactMergedRecoveryBody(item.body, authority);
}

function observedAt(input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error("Promotion remote observation time must be finite.");
  return new Date(nowMs).toISOString();
}

function bindVerifiedObservation(authority, pr, input = {}, testCapability = null) {
  if (testCapability) assertCurrentIsolatedTestAuthority(testCapability);
  const observation = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    observedAt: observedAt(input),
    projectId: authority.projectId,
    repositoryUrl: authority.repositoryUrl,
    repository: authority.repository,
    subjectCandidateId: authority.subjectCandidateId,
    subjectManifestDigest: authority.subjectManifestDigest,
    subjectIntegrationSha: authority.subjectIntegrationSha,
    candidateId: authority.candidateId,
    manifestDigest: authority.manifestDigest,
    integrationSha: authority.integrationSha,
    baseRefName: authority.baseRefName,
    headRefName: authority.headRefName,
    headRefOid: authority.headRefOid,
    claimId: authority.claimId,
    claimFence: authority.claimFence,
    claimBindingDigest: authority.claimBindingDigest,
    pr: {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      repository: pr.repository,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      headRepository: pr.headRepository,
      candidateMarker: authority.candidateMarker,
      claimMarker: pr.body.includes(authority.claimMarker) ? authority.claimMarker : "",
      mergeCommit: pr.mergeCommit,
      mergedAt: pr.mergedAt,
    },
  };
  verifiedPromotionRemoteObservations.set(observation, {
    authority: canonicalJson(authority),
    observation: canonicalJson(observation),
    testCapability,
  });
  return observation;
}

function bindVerifiedMergedRecoveryObservation(authority, pr, input = {}, testCapability = null) {
  if (testCapability) assertCurrentIsolatedTestAuthority(testCapability);
  const observation = {
    schemaVersion: MERGED_RECOVERY_OBSERVATION_SCHEMA_VERSION,
    observedAt: observedAt(input),
    projectId: authority.projectId,
    repositoryUrl: authority.repositoryUrl,
    repository: authority.repository,
    candidateId: authority.candidateId,
    manifestDigest: authority.manifestDigest,
    integrationSha: authority.integrationSha,
    baseRefName: authority.baseRefName,
    headRefName: authority.headRefName,
    headRefOid: authority.headRefOid,
    taskBindings: authority.taskBindings,
    bundleBinding: authority.bundleBinding,
    recoveryProvenance: authority.recoveryProvenance,
    pr: {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      repository: pr.repository,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      headRepository: pr.headRepository,
      mergeCommit: pr.mergeCommit,
      mergedAt: new Date(pr.mergedAt).toISOString(),
    },
  };
  verifiedMergedPromotionRecoveryObservations.set(observation, {
    authority: canonicalJson(authority),
    observation: canonicalJson(observation),
    testCapability,
  });
  return observation;
}

function testGitHubApiRunner(options = {}) {
  const adapter = options.testGitHubApi;
  if (!adapter) return null;
  const runner = isolatedTestAdapterRun(adapter, "promotion-github-api");
  if (!testAuthorityRegistration || !runner) {
    throw new Error("Promotion test GitHub API adapter was rejected outside its isolated test capability.");
  }
  return runner;
}

export async function promotionGitHubApiRequest(request, options = {}) {
  let normalizedRequest;
  try {
    normalizedRequest = normalizedPromotionGitHubApiRequest(request);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      output: truncate(redactSecrets(error.message, normalizeSecrets(options.secrets))),
    };
  }
  const execute = async () => {
    if (!trustedFetch) {
      return { ok: false, status: 0, payload: null, output: "Trusted GitHub HTTP transport is unavailable." };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(request.timeoutMs || 60_000));
    try {
      const headers = {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "studioops-promotion",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      };
      if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
      const response = await trustedFetch(normalizedRequest.url, {
        method: normalizedRequest.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "error",
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = null;
      }
      return {
        ok: response.ok,
        status: response.status,
        payload,
        output: response.ok
          ? ""
          : truncate(payload?.message || responseText || `GitHub API returned HTTP ${response.status}.`),
      };
    } catch (error) {
      return { ok: false, status: 0, payload: null, output: truncate(error.message) };
    } finally {
      clearTimeout(timeout);
    }
  };
  const runner = testGitHubApiRunner(options);
  const result = runner ? await runner({ ...request, execute }) : await execute();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, status: 0, payload: null, output: "GitHub API adapter returned an invalid result." };
  }
  return {
    ok: result.ok === true,
    status: Number(result.status || 0),
    payload: result.payload ?? null,
    output: truncate(redactSecrets(result.output || "", normalizeSecrets(options.secrets))),
  };
}

/**
 * Perform the authoritative GitHub read and seal the single exact PR result.
 * No exported API can seal an arbitrary production observation.
 */
export async function inspectPromotionRemotePullRequest(input, options = {}) {
  let authority;
  try {
    authority = normalizedAuthority(input);
  } catch (error) {
    return { status: "unavailable", reason: error.message };
  }
  const [owner, name] = authority.repository.split("/");
  const response = await promotionGitHubApiRequest({
    operation: "list",
    method: "GET",
    pathname: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
    query: {
      state: "all",
      base: authority.baseRefName,
      head: `${owner}:${authority.headRefName}`,
      per_page: 100,
      sort: "created",
      direction: "desc",
    },
    repository: authority.repository,
    baseRefName: authority.baseRefName,
    headRefName: authority.headRefName,
    headRefOid: authority.headRefOid,
  }, options);
  if (!response.ok) {
    return { status: "unavailable", reason: truncate(response.output || "GitHub PR query failed.") };
  }
  try {
    if (!Array.isArray(response.payload)) {
      return { status: "unavailable", reason: "GitHub PR query did not return an array." };
    }
    if (!response.payload.length) return { status: "missing", repository: authority.repository };
    const observed = response.payload.map((item) => normalizedPromotionPr(item, authority.repository));
    const exact = observed.filter((item) => exactPromotionPrIdentity(item, authority));
    if (exact.length === 1 && observed.length === 1) {
      return {
        status: "exact",
        repository: authority.repository,
        pr: exact[0],
        remoteObservation: bindVerifiedObservation(authority, exact[0], options),
      };
    }
    return {
      status: exact.length > 1 || (exact.length === 1 && observed.length > 1)
        ? "ambiguous"
        : "wrong_identity",
      repository: authority.repository,
      reason: exact.length > 1
        ? "Multiple exact promotion pull requests were observed."
        : "Observed pull request identity did not exactly match the immutable candidate.",
    };
  } catch (error) {
    return {
      status: "unavailable",
      repository: authority.repository,
      reason: `GitHub PR query returned invalid data: ${error.message}`,
    };
  }
}

/**
 * Re-observe an already-persisted release handoff by its exact PR URL. This is
 * intentionally merge-only and claimless: it can remove stale local release
 * authority after GitHub has already made the code live, but it cannot open,
 * update, close, or merge a pull request.
 */
export async function inspectMergedPromotionRecovery(input, options = {}) {
  let authority;
  try {
    authority = normalizedMergedRecoveryAuthority(input);
  } catch (error) {
    return { status: "unavailable", reason: error.message };
  }
  const [owner, name] = authority.repository.split("/");
  const response = await promotionGitHubApiRequest({
    operation: "get-merged-recovery",
    method: "GET",
    pathname: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${authority.promotionPrNumber}`,
    repository: authority.repository,
    number: authority.promotionPrNumber,
  }, options);
  if (!response.ok) {
    return { status: "unavailable", reason: truncate(response.output || "GitHub PR query failed.") };
  }
  try {
    const observed = normalizedPromotionPr(response.payload, authority.repository);
    if (!exactMergedRecoveryPrIdentity(observed, authority)) {
      return {
        status: observed.state === "MERGED" ? "wrong_identity" : "not_merged",
        repository: authority.repository,
        reason: observed.state === "MERGED"
          ? "Merged pull request identity did not exactly match the persisted immutable candidate."
          : "The exact persisted release-candidate pull request is not merged.",
      };
    }
    return {
      status: "exact_merged",
      repository: authority.repository,
      pr: observed,
      remoteObservation: bindVerifiedMergedRecoveryObservation(authority, observed, options),
    };
  } catch (error) {
    return {
      status: "unavailable",
      repository: authority.repository,
      reason: `GitHub PR query returned invalid data: ${error.message}`,
    };
  }
}

/** Assert a sealed observation and, optionally, its exact state-changing fields. */
export function assertPromotionRemoteObservation(input, observation, expected = {}) {
  const authority = normalizedAuthority(input);
  const attested = observation && verifiedPromotionRemoteObservations.get(observation);
  if (attested?.testCapability) assertCurrentIsolatedTestAuthority(attested.testCapability);
  if (
    !attested
    || attested.authority !== canonicalJson(authority)
    || attested.observation !== canonicalJson(observation)
    || observation.schemaVersion !== OBSERVATION_SCHEMA_VERSION
    || !Number.isFinite(Date.parse(observation.observedAt || ""))
  ) {
    throw new Error("Promotion remote observation is not an exact attested GitHub result.");
  }
  const pr = observation.pr || {};
  const expectedState = expected.state ? String(expected.state).toUpperCase() : "";
  const expectedPrUrl = String(expected.prUrl || "");
  const expectedNumber = expected.prNumber === undefined ? 0 : Number(expected.prNumber);
  const expectedMergeCommit = String(expected.mergeCommit || "").toLowerCase();
  const expectedMergedAt = expected.mergedAt
    ? new Date(expected.mergedAt).toISOString()
    : "";
  const observedMergedAt = pr.mergedAt
    ? new Date(pr.mergedAt).toISOString()
    : "";
  if (
    (expectedState && pr.state !== expectedState)
    || (expectedPrUrl && pr.url !== expectedPrUrl)
    || (expectedNumber && pr.number !== expectedNumber)
    || (expectedMergeCommit && pr.mergeCommit !== expectedMergeCommit)
    || (expectedMergedAt && observedMergedAt !== expectedMergedAt)
    || (pr.state === "MERGED" && (
      !GIT_SHA_PATTERN.test(pr.mergeCommit)
      || !Number.isFinite(Date.parse(pr.mergedAt || ""))
    ))
  ) {
    throw new Error("Promotion remote observation does not match the expected pull request outcome.");
  }
  return observation;
}

/** Assert a merge-only recovery observation minted by an exact GitHub read. */
export function assertMergedPromotionRecoveryObservation(input, observation) {
  const authority = normalizedMergedRecoveryAuthority(input);
  const attested = observation && verifiedMergedPromotionRecoveryObservations.get(observation);
  if (attested?.testCapability) assertCurrentIsolatedTestAuthority(attested.testCapability);
  if (
    !attested
    || attested.authority !== canonicalJson(authority)
    || attested.observation !== canonicalJson(observation)
    || observation.schemaVersion !== MERGED_RECOVERY_OBSERVATION_SCHEMA_VERSION
    || !Number.isFinite(Date.parse(observation.observedAt || ""))
    || !exactMergedRecoveryPrIdentity({
      ...observation.pr,
      body: [
        "## Immutable StudioOps candidate",
        authority.legacyCandidateFields.candidate,
        authority.legacyCandidateFields.manifest,
        authority.legacyCandidateFields.integrationSha,
        authority.candidateMarker,
      ].join("\n"),
    }, authority)
  ) {
    throw new Error("Merged promotion recovery observation is not an exact attested GitHub result.");
  }
  return observation;
}

/**
 * Register the test-only harness while the canonical module graph is loading in
 * a verified hermetic test root. Production callers cannot obtain the private
 * capability, and changing process.env after import does not enable this path.
 */
export function registerPromotionRemoteObservationTestHarness(capability) {
  assertCurrentIsolatedTestAuthority(capability);
  if (!testAuthorityRegistration || capability !== testAuthorityRegistration.capability) {
    throw new Error("Promotion remote observation test harness requires boot-time isolated authority.");
  }
  return Object.freeze({
    createGitHubApi(run) {
      return registerIsolatedTestAdapter(capability, "promotion-github-api", run);
    },
    createPromotionRemoteTestObservation(input, prInput, options = {}) {
      assertCurrentIsolatedTestAuthority(capability);
      const authority = normalizedAuthority(input);
      const pr = normalizedPromotionPr(prInput, authority.repository);
      if (!exactPromotionPrIdentity(pr, authority)) {
        throw new Error("Promotion remote test observation must exactly match its authority.");
      }
      return bindVerifiedObservation(authority, pr, options, capability);
    },
    createMergedPromotionRecoveryTestObservation(input, prInput, options = {}) {
      assertCurrentIsolatedTestAuthority(capability);
      const authority = normalizedMergedRecoveryAuthority(input);
      const pr = normalizedPromotionPr(prInput, authority.repository);
      if (!exactMergedRecoveryPrIdentity(pr, authority)) {
        throw new Error("Merged promotion recovery test observation must exactly match its authority.");
      }
      return bindVerifiedMergedRecoveryObservation(authority, pr, options, capability);
    },
  });
}
