import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  cleanupGitHubAppAuth,
  githubAppAuthSecrets,
  prepareGitHubAppAuth,
  redactSecrets,
} from "./github-app-auth.js";
import {
  assertCandidateEnvelope,
  invalidateCandidate,
  normalizeGitSha,
} from "./candidate-manifest.js";
import {
  assertCurrentOwnerQaPacket,
  assertOwnerQaPacket,
  assertReconciliationOwnerQaPacket,
  LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION,
} from "./owner-qa-packet.js";
import { qaRevocationAllowsPromotion } from "./qa-revocation-records.js";
import {
  applyPromotionLifecycleTransitionInState,
  mutateState,
  readState,
  reconcilePendingQaRevocations,
  workflowSnapshotForTask,
} from "./store.js";
import {
  mutateCandidatePromotionState,
  mutatePromotionAttemptClaimState,
  recoverMergedPromotionAdmissionState,
} from "./state-database.js";
import { defaultStudioOpsWorkspaceRoot } from "./runtime-paths.js";
import {
  assertPromotionAttemptClaimInState,
  bindPromotionReconciliationReplacementInState,
  claimPromotionAttemptInState,
  promotionProjectPolicyBinding,
  recordPromotionRecoveryReceiptInState,
  removeUnsupportedPromotionClaimAfterCircuitInState,
  renewPromotionAttemptClaimInState,
  terminalPromotionAttemptClaimInState,
  validPromotionRecoveryReceipt,
  validPromotionRetryAuthorization,
} from "./promotion-attempt-claim.js";
import {
  boundedHeadTail,
  persistPromotionValidationEvidence,
  promotionValidationPolicyDigest,
  redactPromotionValidationText,
  verifyPromotionValidationEvidence,
} from "./promotion-validation-evidence.js";
import {
  cleanupProjectValidationSandbox,
  DEFAULT_PROJECT_VALIDATION_PATH,
  prepareProjectValidationSandbox,
  prepareProjectValidationDependencies,
  installPreparedProjectValidationDependencies,
  PROJECT_VALIDATION_SANDBOX_ISOLATION,
  PROJECT_VALIDATION_SANDBOX_POLICY_ID,
  runProjectValidationCommand,
  verifyProjectValidationSandbox,
} from "./project-validation-sandbox.js";
import {
  inspectMergedPromotionRecovery,
  inspectPromotionRemotePullRequest,
  mergedPromotionRecoveryAuthorityForState,
  promotionGitHubApiRequest as githubApiRequest,
} from "./promotion-remote-observation.js";
import { inspectPromotionMergeAncestry } from "./promotion-ancestry-observation.js";
import { isolatedTestAdapterRun } from "./test-authority-realm.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_PROMOTION_WORKSPACE_ROOT = defaultStudioOpsWorkspaceRoot("promotion");
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_PROMOTION_VALIDATION_ATTEMPTS = 2;
const PROMOTION_ATTEMPT_TTL_MS = 30 * 60_000;
const MAX_VALIDATION_SUMMARIES = 20;
const MAX_VALIDATION_COMMAND_CHARS = 500;
const MAX_VALIDATION_OUTPUT_CHARS = 2_000;
const PROMOTION_VALIDATION_ENVIRONMENT_POLICY_VERSION = "promotion-project-environment-v3-disposable-seatbelt";
const PROMOTION_VALIDATION_TOOLCHAIN_SCHEMA_VERSION = "studioops.promotion-validation-toolchain.v4";
const PROMOTION_RECONCILIATION_VALIDATION_POLICY_SCHEMA_VERSION = "studioops.promotion-reconciliation-validation-policy.v1";
const PROMOTION_VALIDATION_SYSTEM_TOOL_ROOTS = Object.freeze([
  "/System",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/lib",
  "/usr/local/share",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/lib",
  "/opt/homebrew/share",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/Applications/Xcode.app/Contents",
  "/Library/Developer/CommandLineTools",
  "/Library/Apple/usr/libexec/oah",
]);
const PROMOTION_DEPENDENCY_COMPLETE_STATUSES = new Set([
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);
let trustedGitValidated = false;

function nextId(items, prefix) {
  const max = (items || [])
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function addUniqueComment(state, taskId, author, body, createdAt) {
  const exists = (state.comments || []).some((comment) => (
    comment.taskId === taskId && comment.author === author && comment.body === body
  ));
  if (exists) return false;
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId,
    author,
    body,
    createdAt,
  });
  return true;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanOption(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function truncateOutput(value, limit = MAX_OUTPUT_CHARS) {
  return boundedHeadTail(String(value || "").trim(), limit);
}

function normalizeBranchName(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

function safeRefSegment(value) {
  return String(value || "task").replace(/[^A-Za-z0-9._-]/g, "-");
}

function workspaceSegment(value) {
  return safeRefSegment(value)
    .toLowerCase()
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 72) || "workspace";
}

function resolveWorkspaceRoot(value) {
  const raw = String(value || DEFAULT_PROMOTION_WORKSPACE_ROOT);
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSecrets(...values) {
  const secrets = [];
  for (const value of values) {
    if (Array.isArray(value)) secrets.push(...value);
    else if (value) secrets.push(value);
  }
  return [...new Set(secrets.map(String).filter(Boolean))];
}

function contentDigest(value) {
  return `sha256:${createHash("sha256").update(String(value ?? "")).digest("hex")}`;
}

function redactCommandOutput(value, options = {}) {
  return redactSecrets(value, normalizeSecrets(options.secrets));
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...(options.env || {}) },
      timeout: Number(options.timeoutMs || COMMAND_TIMEOUT_MS),
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = redactCommandOutput(result.stdout || "", options);
    const stderr = redactCommandOutput(result.stderr || "", options);
    return {
      ok: true,
      stdout,
      stderr,
      output: `${stdout}${stderr}`.trim(),
    };
  } catch (error) {
    const stdout = redactCommandOutput(error.stdout || "", options);
    const stderr = redactCommandOutput(error.stderr || "", options);
    const message = redactCommandOutput(error.message || "", options);
    const output = `${stdout}${stderr || message}`.trim();
    const result = {
      ok: false,
      stdout,
      stderr,
      output,
      error,
    };
    if (options.allowFailure) return result;
    const wrapped = new Error(output || error.message);
    wrapped.result = result;
    throw wrapped;
  }
}

function trustedGitEnvironment(options = {}) {
  const auth = options.gitAuthEnv || {};
  const isolatedTestRoot = process.env.NODE_ENV === "test"
    && process.env.STUDIOOPS_TEST_ISOLATION === "1"
    && path.isAbsolute(String(process.env.STUDIOOPS_TEST_ROOT || ""))
    ? String(process.env.STUDIOOPS_TEST_ROOT)
    : "";
  const env = {
    PATH: TRUSTED_GIT_PATH,
    HOME: "/",
    TMPDIR: isolatedTestRoot || "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (path.isAbsolute(String(auth.GIT_ASKPASS || ""))) env.GIT_ASKPASS = String(auth.GIT_ASKPASS);
  if (auth.MISSION_CONTROL_GITHUB_TOKEN) {
    env.MISSION_CONTROL_GITHUB_TOKEN = String(auth.MISSION_CONTROL_GITHUB_TOKEN);
  }
  if (auth.MISSION_CONTROL_GIT_USERNAME) {
    env.MISSION_CONTROL_GIT_USERNAME = String(auth.MISSION_CONTROL_GIT_USERNAME);
  }
  return env;
}

function validateTrustedGitExecutable() {
  if (trustedGitValidated) return;
  const resolved = realpathSync(TRUSTED_GIT_EXECUTABLE);
  const info = lstatSync(resolved);
  if (
    resolved !== TRUSTED_GIT_EXECUTABLE
    || !info.isFile()
    || Number(info.uid) !== 0
    || (Number(info.mode) & 0o022) !== 0
  ) {
    throw new Error("Promotion requires the root-owned, non-writable system /usr/bin/git executable.");
  }
  trustedGitValidated = true;
}

function testGitRunner(options = {}) {
  const adapter = options.testGitRunner;
  if (!adapter) return null;
  const runner = isolatedTestAdapterRun(adapter, "promotion-git");
  if (!runner) {
    throw new Error("Promotion test Git runner was rejected outside its isolated test capability.");
  }
  return runner;
}

async function git(repoPath, args, options = {}) {
  validateTrustedGitExecutable();
  const trustedArgs = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "core.attributesFile=/dev/null",
    ...args,
  ];
  const execute = (effectiveArgs = trustedArgs) => runCommand(TRUSTED_GIT_EXECUTABLE, effectiveArgs, {
    cwd: repoPath,
    timeoutMs: options.timeoutMs,
    allowFailure: options.allowFailure,
    secrets: options.secrets,
    env: trustedGitEnvironment(options),
  });
  const runner = testGitRunner(options);
  return runner
    ? await runner({ executable: TRUSTED_GIT_EXECUTABLE, repoPath, args: trustedArgs, execute })
    : execute();
}

function prNumberFromUrl(value) {
  const match = String(value || "").match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  return match ? match[1] : "";
}

function githubRepositorySlug(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
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
    return "";
  }
  const canonical = `https://github.com/${segments[0]}/${segments[1]}`;
  return raw === canonical ? `${segments[0]}/${segments[1]}` : "";
}

function promotionCandidateMarker(projectPlan) {
  return `<!-- studioops-candidate:${projectPlan.candidate.id}:${projectPlan.candidate.manifestDigest} -->`;
}

function promotionClaimMarker(projectPlan) {
  const claim = projectPlan.promotionClaim;
  return claim?.claimId && Number.isSafeInteger(Number(claim.fence))
    ? `<!-- studioops-claim:${claim.claimId}:${claim.fence} -->`
    : "";
}

async function inspectExactPromotionPullRequest(repoPath, projectPlan, branch, commit, options = {}) {
  return inspectPromotionRemotePullRequest({
    projectId: projectPlan.projectId,
    repoUrl: projectPlan.repoUrl,
    targetBranch: projectPlan.targetBranch,
    promotionBranch: branch,
    headSha: commit,
    candidate: projectPlan.candidate,
    subjectCandidate: projectPlan.promotionSubjectCandidate || projectPlan.candidate,
    claim: projectPlan.promotionClaim,
  }, options);
}

async function closeStalePromotionPullRequest(projectResult, options = {}) {
  const observed = projectResult?.observedPromotionPr;
  if (!projectResult?.promotionPrCreated || !observed?.number) {
    return { attempted: false, closed: false, output: "No PR created by this exact claim required cleanup." };
  }
  const inspected = await inspectExactPromotionPullRequest(
    projectResult.sourceRepoPath || projectResult.repoPath,
    projectResult,
    projectResult.promotionBranch,
    projectResult.commit,
    options,
  );
  if (
    inspected.status !== "exact"
    || inspected.pr.number !== observed.number
    || inspected.pr.url !== observed.url
    || inspected.pr.state !== "OPEN"
    || !inspected.pr.body.includes(promotionClaimMarker(projectResult))
  ) {
    return { attempted: false, closed: false, output: "The stale PR no longer has the exact open identity created by this claim." };
  }
  const [owner, name] = inspected.repository.split("/");
  const closed = await githubApiRequest({
    operation: "close",
    method: "PATCH",
    pathname: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${observed.number}`,
    body: { state: "closed" },
    repository: inspected.repository,
    number: observed.number,
  }, {
    githubToken: options.githubToken,
    testGitHubApi: options.testGitHubApi,
    secrets: options.secrets,
  });
  let comment = null;
  if (closed.ok) {
    comment = await githubApiRequest({
      operation: "comment",
      method: "POST",
      pathname: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${observed.number}/comments`,
      body: {
        body: "StudioOps closed this release-candidate PR because its fenced immutable-candidate claim became stale before the release artifact could be recorded.",
      },
      repository: inspected.repository,
      number: observed.number,
    }, {
      githubToken: options.githubToken,
      testGitHubApi: options.testGitHubApi,
      secrets: options.secrets,
    });
  }
  const verified = closed.ok
    ? await inspectExactPromotionPullRequest(
        projectResult.sourceRepoPath || projectResult.repoPath,
        projectResult,
        projectResult.promotionBranch,
        projectResult.commit,
        options,
      )
    : null;
  return {
    attempted: true,
    closed: Boolean(
      closed.ok
      && verified?.status === "exact"
      && verified.pr.number === observed.number
      && verified.pr.state === "CLOSED"
    ),
    output: truncateOutput([
      closed.output || (closed.ok ? "Closed stale release-candidate PR." : "Failed to close stale release-candidate PR."),
      comment && !comment.ok ? `Cleanup comment failed: ${comment.output}` : "",
    ].filter(Boolean).join("\n")),
  };
}

function sourceLabel(task) {
  return task.prUrl || task.branchName || "unlinked PR";
}

function isGitHubRepoUrl(value) {
  return Boolean(githubRepositorySlug(value));
}

function promotionAuthEnabled(projectPlan, input = {}) {
  if (!isGitHubRepoUrl(projectPlan.repoUrl)) return false;
  return booleanOption(
    input.githubAppAuth ?? process.env.MISSION_CONTROL_PROMOTION_GITHUB_APP_AUTH,
    true,
  );
}

async function preparePromotionAuth(projectPlan, input = {}) {
  if (!promotionAuthEnabled(projectPlan, input)) return null;
  const role = input.githubAppRole || input.githubAppAuthRole || "promotion-worker";
  return prepareGitHubAppAuth(
    {
      id: `promotion_${projectPlan.projectId || projectPlan.projectKey || "project"}`,
      role,
      project: {
        id: projectPlan.projectId,
        key: projectPlan.projectKey,
        name: projectPlan.projectName,
        repoPath: projectPlan.repoPath,
        repoUrl: projectPlan.repoUrl,
      },
    },
    {
      ...input,
      githubAppDefaultRole: input.githubAppDefaultRole || "builder",
    },
  );
}

async function safeRemoveWorkspace(workspacePath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, workspacePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove unsafe promotion workspace path: ${workspacePath}`);
  }
  await rm(workspacePath, { recursive: true, force: true });
}

function promotionGitOptions(options = {}, overrides = {}) {
  return {
    gitAuthEnv: options.gitAuthEnv,
    testGitRunner: options.testGitRunner,
    secrets: options.secrets,
    ...overrides,
  };
}

async function copyGitConfigValue(sourceRepoPath, workspacePath, key, options = {}) {
  const value = await git(
    sourceRepoPath,
    ["config", "--local", "--no-includes", "--get", key],
    promotionGitOptions(options, { allowFailure: true }),
  );
  if (!value.ok || !value.output.trim()) return;
  await git(workspacePath, ["config", "--local", key, value.output.trim()], promotionGitOptions(options));
}

async function copyGitIdentity(sourceRepoPath, workspacePath, options = {}) {
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.name", options);
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.email", options);
  const name = await git(
    workspacePath,
    ["config", "--local", "--no-includes", "--get", "user.name"],
    promotionGitOptions(options, { allowFailure: true }),
  );
  const email = await git(
    workspacePath,
    ["config", "--local", "--no-includes", "--get", "user.email"],
    promotionGitOptions(options, { allowFailure: true }),
  );
  if (!name.ok || !name.output.trim()) {
    await git(workspacePath, ["config", "--local", "user.name", "StudioOps Automation"], promotionGitOptions(options));
  }
  if (!email.ok || !email.output.trim()) {
    await git(workspacePath, ["config", "--local", "user.email", "studioops@localhost"], promotionGitOptions(options));
  }
}

function promotionRemotePolicyError(message) {
  const error = new Error(message);
  error.code = "PROMOTION_REMOTE_POLICY";
  return error;
}

async function promotionRemotePolicy(repoPath, projectPlan, options = {}) {
  const expectedRepository = githubRepositorySlug(projectPlan.repoUrl).toLowerCase();
  if (!expectedRepository) {
    throw promotionRemotePolicyError("Promotion requires a configured canonical GitHub repository URL before any workspace or remote side effect.");
  }
  const fetch = await git(
    repoPath,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"],
    promotionGitOptions(options, { allowFailure: true }),
  );
  const push = await git(
    repoPath,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.pushurl"],
    promotionGitOptions(options, { allowFailure: true }),
  );
  const fetchUrls = fetch.ok ? fetch.output.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  const explicitPushUrls = push.ok ? push.output.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  if (fetchUrls.length !== 1) {
    throw promotionRemotePolicyError("Promotion requires exactly one configured origin fetch URL.");
  }
  if (explicitPushUrls.length > 1) {
    throw promotionRemotePolicyError("Promotion refuses an origin with multiple push URLs.");
  }
  const pushUrls = explicitPushUrls.length ? explicitPushUrls : fetchUrls;
  for (const [label, url] of [["fetch", fetchUrls[0]], ["push", pushUrls[0]]]) {
    const observedRepository = githubRepositorySlug(url).toLowerCase();
    if (!observedRepository || observedRepository !== expectedRepository) {
      throw promotionRemotePolicyError(
        `Promotion ${label} remote does not match configured repository ${expectedRepository}.`,
      );
    }
  }
  return {
    repository: expectedRepository,
    fetchUrl: fetchUrls[0],
    pushUrl: pushUrls[0],
    transportUrl: `https://github.com/${expectedRepository}`,
  };
}

async function configureWorkspaceOrigin(workspacePath, remotePolicy, options = {}) {
  const gitOptions = promotionGitOptions(options);
  await git(workspacePath, ["remote", "set-url", "origin", remotePolicy.transportUrl], gitOptions);
  await git(workspacePath, ["config", "--local", "--unset-all", "remote.origin.pushurl"], {
    ...gitOptions,
    allowFailure: true,
  });
}

async function preparePromotionWorkspace(sourceRepoPath, projectPlan, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(
    options.promotionWorkspaceRoot
      || options.workspaceRoot
      || process.env.STUDIOOPS_PROMOTION_WORKSPACE_ROOT
      || process.env.MISSION_CONTROL_PROMOTION_WORKSPACE_ROOT,
  );
  if (pathContains(sourceRepoPath, workspaceRoot)) {
    throw new Error(`Promotion workspace root must be outside the registered project repoPath: ${workspaceRoot}`);
  }

  const remotePolicy = await promotionRemotePolicy(sourceRepoPath, projectPlan, options);

  const projectSegment = workspaceSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const branchSegment = workspaceSegment(projectPlan.targetBranch || "main");
  const workspaceParent = path.join(workspaceRoot, projectSegment);

  await mkdir(workspaceParent, { recursive: true });
  const workspacePath = await mkdtemp(path.join(workspaceParent, `${branchSegment}-`));

  try {
    await git(undefined, [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-tags",
      "--",
      sourceRepoPath,
      workspacePath,
    ], {
      ...promotionGitOptions(options),
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    });
    await configureWorkspaceOrigin(workspacePath, remotePolicy, options);
    await copyGitIdentity(sourceRepoPath, workspacePath, options);
    return {
      executionRepoPath: workspacePath,
      workspacePath,
      workspaceRoot,
      strategy: "isolated_clone",
      remotePolicy,
    };
  } catch (error) {
    await safeRemoveWorkspace(workspacePath, workspaceRoot);
    throw error;
  }
}

async function prepareTargetBranch(repoPath, projectPlan, options = {}) {
  const targetBranch = normalizeBranchName(projectPlan.targetBranch || projectPlan.defaultBranch || "main");
  await git(repoPath, ["check-ref-format", "--branch", targetBranch]);
  const fetch = await git(repoPath, ["fetch", "origin", `refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`], { ...options, allowFailure: true });
  if (!fetch.ok) {
    throw new Error(`Could not fetch target branch origin/${targetBranch}: ${truncateOutput(fetch.output)}`);
  }
  await git(repoPath, ["checkout", "-B", targetBranch, `refs/remotes/origin/${targetBranch}`], options);
  return targetBranch;
}

async function branchHead(repoPath, ref, options = {}) {
  const result = await git(repoPath, ["rev-parse", "--verify", ref], { ...options, allowFailure: true });
  return result.ok ? result.output.trim() : "";
}

async function verifyPromotionCandidateRepositoryState(repoPath, candidate, options = {}) {
  assertCandidateEnvelope(candidate);
  const refs = [
    {
      kind: "base",
      label: candidate.manifest.base.branch,
      ref: `refs/heads/${candidate.manifest.base.branch}`,
      expectedSha: candidate.manifest.base.sha,
    },
    {
      kind: "integration",
      label: candidate.manifest.integration.branch,
      ref: `refs/heads/${candidate.manifest.integration.branch}`,
      expectedSha: candidate.manifest.integration.sha,
    },
    ...candidate.manifest.sources.map((source) => ({
      kind: "source",
      label: source.taskId,
      ref: source.sourceRef,
      expectedSha: source.headSha,
    })),
  ];
  const uniqueRefs = [...new Set(refs.map((item) => item.ref))];
  const observed = await git(
    repoPath,
    ["ls-remote", "--refs", "origin", ...uniqueRefs],
    { ...options, timeoutMs: 60_000, allowFailure: true },
  );
  if (!observed.ok) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Candidate refs could not be verified: ${truncateOutput(observed.output)}`,
      expected: "",
      observed: "",
      observations: [],
    };
  }
  const observedByRef = new Map();
  for (const line of observed.stdout.split("\n")) {
    const [rawSha, ref] = line.trim().split(/\s+/);
    if (!rawSha || !ref) continue;
    try {
      observedByRef.set(ref, normalizeGitSha(rawSha, `observed SHA for ${ref}`));
    } catch {
      return {
        ok: false,
        status: "unavailable",
        reason: `Candidate refs returned an invalid SHA for ${ref}.`,
        expected: "",
        observed: rawSha,
        observations: [],
      };
    }
  }
  const observations = refs.map((item) => ({
    ...item,
    observedSha: observedByRef.get(item.ref) || "",
  }));
  const drift = observations.find((item) => item.observedSha !== item.expectedSha);
  if (drift) {
    return {
      ok: false,
      status: "drift",
      reason: `Candidate ${drift.kind} ref drift for ${drift.label}.`,
      expected: drift.expectedSha,
      observed: drift.observedSha || "missing",
      observations,
    };
  }
  return {
    ok: true,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    observations,
  };
}

async function fetchTaskSource(repoPath, task, options = {}) {
  const localRef = `refs/mission-control/promotions/${safeRefSegment(task.id)}`;
  const branchName = normalizeBranchName(task.branchName);
  const errors = [];

  if (branchName) {
    const branchFormat = await git(repoPath, ["check-ref-format", "--branch", branchName], { allowFailure: true });
    if (branchFormat.ok) {
      const branchFetch = await git(repoPath, ["fetch", "origin", `refs/heads/${branchName}:${localRef}`], { ...options, allowFailure: true });
      if (branchFetch.ok) {
        return { ok: true, ref: localRef, label: branchName, fetchOutput: branchFetch.output };
      }
      errors.push(`branch ${branchName}: ${branchFetch.output}`);
    } else {
      errors.push(`branch ${branchName}: invalid branch name`);
    }
  }

  const prNumber = prNumberFromUrl(task.prUrl);
  if (prNumber) {
    const prFetch = await git(repoPath, ["fetch", "origin", `refs/pull/${prNumber}/head:${localRef}`], { ...options, allowFailure: true });
    if (prFetch.ok) {
      return { ok: true, ref: localRef, label: `pull/${prNumber}`, fetchOutput: prFetch.output };
    }
    errors.push(`PR ${prNumber}: ${prFetch.output}`);
  }

  return {
    ok: false,
    error: errors.length ? errors.join("\n") : "Task needs a branch name or GitHub PR URL before promotion can fetch a source ref.",
  };
}

async function conflictFiles(repoPath) {
  const result = await git(repoPath, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
  return result.output ? result.output.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

async function mergeTaskSource(repoPath, task, options = {}) {
  const source = await fetchTaskSource(repoPath, task, options);
  if (!source.ok) {
    return {
      taskId: task.id,
      title: task.title,
      status: "blocked",
      source: sourceLabel(task),
      output: truncateOutput(source.error),
    };
  }

  const merge = await git(repoPath, ["merge", "--no-ff", "--no-edit", source.ref], { allowFailure: true });
  if (merge.ok) {
    return {
      taskId: task.id,
      title: task.title,
      status: "merged",
      source: source.label,
      output: truncateOutput(merge.output),
    };
  }

  const conflicts = await conflictFiles(repoPath);
  await git(repoPath, ["merge", "--abort"], { allowFailure: true });
  return {
    taskId: task.id,
    title: task.title,
    status: "conflict",
    source: source.label,
    conflicts,
    output: truncateOutput(merge.output),
  };
}

async function runValidationCommands(sandbox, commands, options, context) {
  const completeResults = [];
  const dependencyInstall = await installPreparedProjectValidationDependencies(sandbox, options);
  if (dependencyInstall.applicable) {
    completeResults.push({
      command: "[offline dependency installation]",
      ok: dependencyInstall.ok,
      output: redactPromotionValidationText(redactCommandOutput(dependencyInstall.output, options)),
    });
    if (!dependencyInstall.ok) {
      // Preserve the failed install as validation evidence and do not run
      // product commands against a partial node_modules tree.
      commands = [];
    }
  }
  for (const command of commands) {
    if (options.beforeValidationCommand) await options.beforeValidationCommand();
    const result = await runProjectValidationCommand(sandbox, command, {
      timeoutMs: Number(options.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
    });
    completeResults.push({
      command: redactPromotionValidationText(redactCommandOutput(command, options)),
      ok: result.ok,
      output: redactPromotionValidationText(redactCommandOutput(result.output, options)),
    });
    if (!result.ok) break;
  }
  if (completeResults.every((item) => item.ok)) {
    try {
      await verifyProjectValidationSandbox(sandbox);
    } catch (error) {
      completeResults.push({
        command: "[verify exact disposable validation checkout]",
        ok: false,
        output: redactPromotionValidationText(redactCommandOutput(error.message, options)),
      });
    }
  }
  let evidence;
  try {
    evidence = await persistPromotionValidationEvidence({
      root: options.validationEvidenceRoot,
      candidateId: context.candidate.id,
      manifestDigest: context.candidate.manifestDigest,
      integrationSha: context.candidate.manifest.integration.sha,
      attempt: context.attempt,
      policyDigest: context.policyDigest,
      commands: completeResults,
    });
  } catch (error) {
    error.evidenceCauseCode = error.code || "";
    error.code = "PROMOTION_VALIDATION_EVIDENCE_FAILED";
    throw error;
  }

  const boundedResults = completeResults.map((result) => ({
    command: truncateOutput(result.command, MAX_VALIDATION_COMMAND_CHARS),
    ok: result.ok,
    output: truncateOutput(result.output, MAX_VALIDATION_OUTPUT_CHARS),
    outputDigest: contentDigest(result.output),
  }));
  const summaries = boundedResults.length <= MAX_VALIDATION_SUMMARIES
    ? boundedResults
    : [
        ...boundedResults.slice(0, MAX_VALIDATION_SUMMARIES - 1),
        boundedResults.at(-1),
      ];
  return {
    summaries,
    receiptResults: boundedResults.map(({ command, ok, outputDigest }) => ({ command, ok, outputDigest })),
    evidence,
    failed: boundedResults.find((item) => !item.ok) || null,
    omittedSummaryCount: Math.max(0, boundedResults.length - summaries.length),
  };
}

function projectMatches(project, options = {}) {
  const projectFilter = normalizeList(options.project || options.projects);
  if (!projectFilter.length) return true;
  return projectFilter.includes(project.id) || projectFilter.includes(project.key);
}

function taskMatches(task, options = {}) {
  const taskFilter = normalizeList(options.task || options.tasks || options.taskId);
  if (!taskFilter.length) return true;
  return taskFilter.includes(task.id);
}

function promotionConfig(project = {}) {
  return project.promotion || {};
}

function promotionEnabled(project = {}) {
  return booleanOption(promotionConfig(project).enabled, true);
}

function promotionTargetBranch(project = {}) {
  return normalizeBranchName(promotionConfig(project).targetBranch || project.defaultBranch || "main");
}

function promotionValidationCommands(project = {}) {
  return normalizeList(promotionConfig(project).validationCommands || project.validationCommands);
}

function selectedPromotionValidationPath(input = {}) {
  if (Object.hasOwn(input, "validationPath")) return { value: input.validationPath, source: "validationPath" };
  if (input.env && Object.hasOwn(input.env, "PATH")) return { value: input.env.PATH, source: "env.PATH" };
  if (Object.hasOwn(input, "path")) return { value: input.path, source: "path" };
  if (process.env.MISSION_CONTROL_PROMOTION_PATH) {
    return { value: process.env.MISSION_CONTROL_PROMOTION_PATH, source: "MISSION_CONTROL_PROMOTION_PATH" };
  }
  return { value: DEFAULT_PROJECT_VALIDATION_PATH, source: "default" };
}

function filesystemPathProvenance(value, expectedType) {
  const requestedPath = path.resolve(String(value || ""));
  try {
    const resolvedPath = realpathSync(requestedPath);
    const info = lstatSync(resolvedPath);
    const expected = expectedType === "directory" ? info.isDirectory() : info.isFile();
    if (!expected) return { path: requestedPath, type: expectedType, available: false };
    return {
      path: resolvedPath,
      type: expectedType,
      available: true,
      device: Number(info.dev),
      inode: Number(info.ino),
      mode: Number(info.mode & 0o7777),
      uid: Number(info.uid),
      gid: Number(info.gid),
      ...(expectedType === "file" ? {
        bytes: Number(info.size),
        digest: `sha256:${createHash("sha256").update(readFileSync(resolvedPath)).digest("hex")}`,
      } : {}),
    };
  } catch {
    return { path: requestedPath, type: expectedType, available: false };
  }
}

function pathIsWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function approvedPromotionValidationToolRoots() {
  return [...new Set(PROMOTION_VALIDATION_SYSTEM_TOOL_ROOTS.flatMap((entry) => {
    try {
      return [realpathSync(entry)];
    } catch {
      return [];
    }
  }))];
}

function validationCommandTokenCandidates(commands) {
  const candidates = new Set();
  for (const command of normalizeList(commands)) {
    const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()<>]+/g) || [];
    for (const rawToken of tokens) {
      let token = rawToken.trim();
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1);
      }
      token = token.replace(/^!+/, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) token = token.slice(token.indexOf("=") + 1);
      if (token && !token.startsWith("-")) candidates.add(token);
    }
  }
  return [...candidates].sort();
}

function resolvedValidationCommandExecutables(commands, pathEntries, approvedRoots) {
  const resolved = [];
  for (const token of validationCommandTokenCandidates(commands)) {
    const requestedPaths = path.isAbsolute(token)
      ? [token]
      : /^[A-Za-z0-9_.+-]+$/.test(token)
        ? pathEntries.map((entry) => path.join(entry, token))
        : [];
    for (const requestedPath of requestedPaths) {
      const provenance = filesystemPathProvenance(requestedPath, "file");
      if (!provenance.available) continue;
      const info = lstatSync(provenance.path);
      if ((Number(info.mode) & 0o111) === 0) continue;
      if ((Number(info.mode) & 0o022) !== 0) {
        const error = new Error(`Unsafe writable promotion validation executable: ${provenance.path}.`);
        error.code = "PROJECT_VALIDATION_INPUT_INVALID";
        throw error;
      }
      if (!approvedRoots.some((root) => pathIsWithin(root, provenance.path))) {
        const error = new Error(`Unsafe promotion validation executable: ${provenance.path}.`);
        error.code = "PROJECT_VALIDATION_INPUT_INVALID";
        throw error;
      }
      resolved.push({ command: token, ...provenance });
      break;
    }
  }
  return resolved;
}

function normalizedPromotionValidationToolchain(validationPath, executables = {}, commands = []) {
  const rawPath = String(validationPath ?? "");
  const rawEntries = rawPath.split(path.delimiter);
  if (!rawPath || rawEntries.some((entry) => !entry.trim() || !path.isAbsolute(entry.trim()))) {
    const error = new Error("Promotion validation PATH entries must be non-empty absolute directories.");
    error.code = "PROJECT_VALIDATION_INPUT_INVALID";
    throw error;
  }
  const requestedEntries = rawEntries
    .map((entry) => filesystemPathProvenance(entry.trim(), "directory"));
  const unavailable = requestedEntries.find((entry) => !entry.available);
  if (unavailable) {
    const error = new Error(`Promotion validation PATH entry is not an existing directory: ${unavailable.path}.`);
    error.code = "PROJECT_VALIDATION_INPUT_INVALID";
    throw error;
  }
  const pathRoots = [...new Map(requestedEntries.map((entry) => [entry.path, entry])).values()];
  const pathEntries = pathRoots.map((entry) => entry.path);
  const approvedRoots = approvedPromotionValidationToolRoots();
  const unsafeRoot = pathRoots.find((entry) => !approvedRoots.some((root) => pathIsWithin(root, entry.path)));
  if (unsafeRoot) {
    const error = new Error(`Unsafe promotion validation PATH entry: ${unsafeRoot.path}.`);
    error.code = "PROJECT_VALIDATION_INPUT_INVALID";
    throw error;
  }
  return {
    schemaVersion: PROMOTION_VALIDATION_TOOLCHAIN_SCHEMA_VERSION,
    path: pathEntries.join(path.delimiter),
    pathEntries,
    pathRoots,
    commandExecutables: resolvedValidationCommandExecutables(commands, pathEntries, approvedRoots),
    sandboxPolicyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    processPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
    trustedExecutables: {
      sandbox: filesystemPathProvenance(executables.sandbox || "/usr/bin/sandbox-exec", "file"),
      shell: filesystemPathProvenance("/bin/bash", "file"),
      git: filesystemPathProvenance(TRUSTED_GIT_EXECUTABLE, "file"),
      verifier: filesystemPathProvenance(executables.verifier || process.execPath, "file"),
    },
  };
}

function normalizedPromotionReconciliationValidationPolicy(commands = []) {
  return {
    schemaVersion: PROMOTION_RECONCILIATION_VALIDATION_POLICY_SCHEMA_VERSION,
    mode: "reconcile",
    validationExecution: "disabled",
    executableResolution: "disabled",
    declaredCommandsDigest: contentDigest(JSON.stringify(normalizeList(commands))),
    path: "",
    pathEntries: [],
    pathRoots: [],
    commandExecutables: [],
    trustedExecutables: {},
  };
}

function promotionValidationEnvironmentPolicyVersion(toolchain) {
  return `${PROMOTION_VALIDATION_ENVIRONMENT_POLICY_VERSION}:${contentDigest(JSON.stringify(toolchain))}`;
}

function promotionBranchName(projectPlan) {
  const project = safeRefSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const candidateDigest = String(projectPlan.candidate?.manifestDigest || "")
    .replace(/^sha256:/, "")
    .slice(0, 16);
  return `qa/promotion-${project}-${candidateDigest || "candidate"}`;
}

function candidateHasTrustedQaPass(candidate, allowedStatuses = ["qa_passed"], state = null) {
  let ownerQaPacket;
  try {
    assertCandidateEnvelope(candidate);
    if (state) {
      const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
      try {
        ownerQaPacket = assertCurrentOwnerQaPacket(state, candidate, bundle);
      } catch {
        ownerQaPacket = assertReconciliationOwnerQaPacket(state, candidate, bundle);
      }
    } else {
      ownerQaPacket = assertOwnerQaPacket(candidate.qaPacket, candidate);
    }
  } catch {
    return false;
  }
  const decision = candidate.qaDecision;
  const decisionPacketDigest = decision?.ownerQaPacketDigest || (
    ownerQaPacket.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION
    && ["release_candidate_ready", "merged"].includes(candidate.status)
      ? ownerQaPacket.packetDigest
      : ""
  );
  if (
    !allowedStatuses.includes(candidate.status)
    || candidate.invalidation
    || !qaRevocationAllowsPromotion(candidate)
    || decision?.outcome !== "passed"
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || decision.integrationSha !== candidate.manifest.integration.sha
    || decisionPacketDigest !== ownerQaPacket.packetDigest
    || !String(decision.author || "").trim()
    || !Number.isFinite(Date.parse(decision.repositoryVerifiedAt || ""))
    || !Number.isFinite(Date.parse(decision.decidedAt || ""))
  ) {
    return false;
  }
  const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  const decidedTaskIds = normalizeList(decision.taskIds).sort();
  return JSON.stringify(expectedTaskIds) === JSON.stringify(decidedTaskIds);
}

function candidateHasValidQaPass(candidate, state = null) {
  return candidateHasTrustedQaPass(candidate, ["qa_passed"], state);
}

function candidateHasValidPromotionHandoff(candidate, state = null) {
  if (!candidateHasTrustedQaPass(candidate, ["release_candidate_ready"], state)) return false;
  const promotion = candidate.promotion;
  return Boolean(
    promotion
    && /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(promotion.prUrl || ""))
    && String(promotion.branch || "").trim()
    && promotion.commitSha === candidate.manifest.integration.sha
    && promotion.manifestDigest === candidate.manifestDigest
  );
}

function candidateNeedsPromotionReconciliation(candidate, state = null) {
  return candidateHasValidPromotionHandoff(candidate, state);
}

const PROMOTABLE_TASK_STATUSES = new Set([
  "user_review",
  "approved_for_main",
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
  "dependency_acquisition_failed",
  "claim_circuit_open",
]);

function promotionValidationAttemptsForCandidate(task, candidate) {
  if (task?.promotionValidationCandidateId === candidate.id) {
    const attempts = Number(task.promotionValidationAttempts || 0);
    return Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  }
  return 0;
}

function taskCanRetryPromotionValidation(task, candidate, source, policyDigest) {
  const attempts = promotionValidationAttemptsForCandidate(task, candidate);
  return Boolean(
    validPromotionRetryAuthorization(task, candidate, source, policyDigest)
    && attempts > 0
    && attempts < MAX_PROMOTION_VALIDATION_ATTEMPTS
  );
}

function candidateTasksRemainPromotable(candidate, tasksById, policyDigest) {
  const reusableValidation = validPromotionRecoveryReceipt(candidate, policyDigest);
  return candidate.manifest.sources.every((source) => {
    const task = tasksById.get(source.taskId);
    if (!task) return false;
    if (
      candidate.status === "qa_passed"
      && ["approved_for_main", "promotion_blocked"].includes(task.status)
      && task.assignedAgentRole !== "promotion-worker"
    ) return false;
    if (candidate.status === "release_candidate_ready") {
      if (task.status === "user_review" && task.assignedAgentRole !== "owner") return false;
      if (
        task.status === "promotion_blocked"
        && !["owner", "promotion-worker"].includes(task.assignedAgentRole)
      ) return false;
    }
    const attempts = promotionValidationAttemptsForCandidate(task, candidate);
    if (candidate.status === "qa_passed" && attempts > 0) {
      if (taskCanRetryPromotionValidation(task, candidate, source, policyDigest)) return true;
      if (!reusableValidation) return false;
    }
    if (
      candidate.status === "qa_passed"
      && task.status === "promotion_blocked"
      && !AUTO_RECOVERABLE_PROMOTION_STATUSES.has(String(task.promotionStatus || ""))
    ) return false;
    return PROMOTABLE_TASK_STATUSES.has(task.status);
  });
}

function candidateUsesPromotionValidationRetry(candidate, tasksById, policyDigest) {
  return candidate.manifest.sources.some((source) => (
    taskCanRetryPromotionValidation(tasksById.get(source.taskId), candidate, source, policyDigest)
  ));
}

function candidateHasTrustedMerge(candidate, state = null) {
  if (!candidateHasTrustedQaPass(candidate, ["merged"], state)) return false;
  const promotion = candidate.promotion;
  const merge = candidate.promotionMerge;
  return Boolean(
    promotion
    && /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(promotion.prUrl || ""))
    && promotion.commitSha === candidate.manifest.integration.sha
    && promotion.manifestDigest === candidate.manifestDigest
    && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(String(merge?.mergeCommit || ""))
    && Number.isFinite(Date.parse(merge?.mergedAt || ""))
    && Number.isFinite(Date.parse(merge?.reconciledAt || ""))
  );
}

function hasUnmetPromotionDependency(task, tasksById, selectedIds, completedIds) {
  for (const dependencyId of task.dependsOnTaskIds || []) {
    if (selectedIds.has(dependencyId) && !completedIds.has(dependencyId)) return true;
    if (!selectedIds.has(dependencyId)) {
      const dependency = tasksById.get(dependencyId);
      if (!dependency || !PROMOTION_DEPENDENCY_COMPLETE_STATUSES.has(dependency.status)) return true;
    }
  }
  return false;
}

function orderPromotionTasks(projectTasks, candidates) {
  const tasksById = new Map(projectTasks.map((task) => [task.id, task]));
  const selectedIds = new Set(candidates.map((task) => task.id));
  const pending = [...candidates];
  const ordered = [];
  const blocked = [];
  const completedIds = new Set();

  while (pending.length) {
    const nextIndex = pending.findIndex((task) => !hasUnmetPromotionDependency(task, tasksById, selectedIds, completedIds));
    if (nextIndex === -1) break;
    const [task] = pending.splice(nextIndex, 1);
    ordered.push(task);
    completedIds.add(task.id);
  }

  for (const task of pending) {
    blocked.push({
      taskId: task.id,
      title: task.title,
      status: "dependency_blocked",
      source: sourceLabel(task),
      output: "Promotion dependency is not merged yet, or the dependency relationship forms a cycle.",
    });
  }

  return { ordered, blocked };
}

export function planPromotions(state, input = {}) {
  const projectPlans = (state.projects || [])
    .filter((project) => projectMatches(project, input))
    .flatMap((project) => {
      const candidateFilter = normalizeList(input.candidate || input.candidates || input.candidateId);
      const taskFilter = normalizeList(input.task || input.tasks || input.taskId);
      const projectCandidates = (state.candidates || [])
        .filter((candidate) => candidate.projectId === project.id)
        .filter((candidate) => (
          candidateHasValidQaPass(candidate, state)
          || candidateNeedsPromotionReconciliation(candidate, state)
        ))
        .filter((candidate) => !candidateFilter.length || candidateFilter.includes(candidate.id))
        .filter((candidate) => !taskFilter.length || candidate.manifest?.sources?.some((source) => taskFilter.includes(source.taskId)));
      if (!projectCandidates.length) return [];
      const projectTasks = new Map(
        (state.tasks || [])
          .filter((task) => task.projectId === project.id)
          .map((task) => [task.id, task]),
      );
      const taskPlans = (candidate) => candidate.manifest.sources.map((source) => {
        const task = projectTasks.get(source.taskId);
        const dependencyBindings = [...new Set(normalizeList(task?.dependsOnTaskIds))]
          .sort()
          .map((dependencyId) => {
            const dependency = projectTasks.get(dependencyId);
            return dependency ? {
              taskId: dependency.id,
              projectId: dependency.projectId,
              status: String(dependency.status || ""),
              stateVersion: Number(dependency.stateVersion || 1),
            } : {
              taskId: dependencyId,
              projectId: "",
              status: "missing",
              stateVersion: 0,
            };
          });
        return {
          id: source.taskId,
          title: task?.title || source.taskId,
          status: task?.status || "",
          branchName: task?.branchName || "",
          prUrl: task?.prUrl || "",
          dependsOnTaskIds: task?.dependsOnTaskIds || [],
          dependencyBindings,
          sourceRef: source.sourceRef,
          headSha: source.headSha,
          stateVersion: Number(task?.stateVersion || 1),
          automationAttemptEpoch: Number(task?.automationAttemptEpoch || 0),
          promotionValidationAttempts: promotionValidationAttemptsForCandidate(task, candidate),
          promotionRetryAuthorization: task?.promotionRetryAuthorization || null,
        };
      });
      const validationCommands = promotionValidationCommands(project);
      const validationTimeoutMs = Number(input.validationTimeoutMs || VALIDATION_TIMEOUT_MS);
      const validationPathSelection = selectedPromotionValidationPath(input);
      let resolvedExecutionToolchain = null;
      const validationToolchainForCandidate = (candidate) => {
        if (candidate.status === "release_candidate_ready") {
          return normalizedPromotionReconciliationValidationPolicy(validationCommands);
        }
        resolvedExecutionToolchain ||= normalizedPromotionValidationToolchain(validationPathSelection.value, {
          sandbox: input.validationSandboxExecutable || "/usr/bin/sandbox-exec",
          verifier: process.execPath,
        }, validationCommands);
        return resolvedExecutionToolchain;
      };
      let projectPolicy;
      try {
        projectPolicy = promotionProjectPolicyBinding(project);
      } catch (error) {
        return projectCandidates.map((candidate) => {
          const validationToolchain = validationToolchainForCandidate(candidate);
          return {
            projectId: project.id,
            projectKey: project.key,
            projectName: project.name,
            repoPath: project.repoPath || "",
            repoUrl: project.repoUrl || "",
            defaultBranch: project.defaultBranch || "main",
            targetBranch: candidate.manifest.base.branch,
            enabled: false,
            skipReason: `promotion project policy is invalid: ${error.message}`,
            validationCommands,
            validationTimeoutMs,
            validationPath: validationToolchain.path,
            validationPathSource: validationPathSelection.source,
            validationToolchain,
            validationPolicyDigest: "",
            projectPolicy: null,
            projectPolicyDigest: "",
            mode: candidate.status === "release_candidate_ready" ? "reconcile" : "create",
            candidate,
            mergedCandidates: [],
            tasks: taskPlans(candidate),
            blockedTasks: [],
          };
        });
      }
      const projectPolicyDigest = contentDigest(JSON.stringify(projectPolicy));
      return projectCandidates
        .map((candidate) => {
          const validationToolchain = validationToolchainForCandidate(candidate);
          const validationPolicyDigest = promotionValidationPolicyDigest({
            commands: validationCommands,
            timeoutMs: validationTimeoutMs,
            environmentPolicyVersion: promotionValidationEnvironmentPolicyVersion(validationToolchain),
            projectPolicyDigest,
            sandboxPolicyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
            validationStrategy: "disposable_full_clone",
            networkPolicy: "deny_all",
          });
          return { candidate, validationToolchain, validationPolicyDigest };
        })
        .filter(({ candidate, validationPolicyDigest }) => (
          candidateTasksRemainPromotable(candidate, projectTasks, validationPolicyDigest)
        ))
        .map(({ candidate, validationToolchain, validationPolicyDigest }) => {
          const candidateTaskPlans = taskPlans(candidate);
          const ordered = orderPromotionTasks([...projectTasks.values()], candidateTaskPlans);
          const dependencyBlocked = ordered.blocked.length > 0;
          const dependencyOutput = dependencyBlocked
            ? `Atomic candidate ${candidate.id} is waiting for complete, acyclic promotion dependencies: ${ordered.blocked.map((item) => item.taskId).join(", ")}.`
            : "";
          return {
          projectId: project.id,
          projectKey: project.key,
          projectName: project.name,
          repoPath: project.repoPath || "",
          repoUrl: project.repoUrl || "",
          defaultBranch: project.defaultBranch || "main",
          targetBranch: candidate.manifest.base.branch,
          enabled: (
            promotionEnabled(project)
            && promotionTargetBranch(project) === candidate.manifest.base.branch
          ),
          skipReason: !promotionEnabled(project)
            ? "promotion is disabled for this project."
            : promotionTargetBranch(project) !== candidate.manifest.base.branch
              ? `promotion target ${promotionTargetBranch(project)} does not match candidate base ${candidate.manifest.base.branch}; rebuild the candidate against the intended target.`
              : "",
          validationCommands,
          validationTimeoutMs,
          validationPath: validationToolchain.path,
          validationPathSource: validationPathSelection.source,
          validationToolchain,
          validationPolicyDigest,
          projectPolicy,
          projectPolicyDigest,
          mode: candidate.status === "release_candidate_ready"
            ? "reconcile"
            : candidateUsesPromotionValidationRetry(candidate, projectTasks, validationPolicyDigest)
              ? "retry"
              : "create",
          candidate,
          mergedCandidates: (state.candidates || [])
            .filter((item) => item.projectId === project.id)
            .filter((item) => item.id !== candidate.id)
            .filter((item) => candidateHasTrustedMerge(item, state))
            .map((item) => ({
              id: item.id,
              projectId: item.projectId,
              manifestDigest: item.manifestDigest,
              qaDecision: {
                outcome: item.qaDecision.outcome,
                candidateId: item.qaDecision.candidateId,
                manifestDigest: item.qaDecision.manifestDigest,
                integrationSha: item.qaDecision.integrationSha,
                ownerQaPacketDigest: item.qaDecision.ownerQaPacketDigest || item.qaPacket?.packetDigest || "",
                taskIds: normalizeList(item.qaDecision.taskIds).sort(),
                author: item.qaDecision.author,
                repositoryVerifiedAt: item.qaDecision.repositoryVerifiedAt,
                decidedAt: item.qaDecision.decidedAt,
              },
              manifest: {
                base: item.manifest.base,
                integration: item.manifest.integration,
                sources: item.manifest.sources,
              },
              promotion: {
                branch: item.promotion.branch,
                prUrl: item.promotion.prUrl,
                commitSha: item.promotion.commitSha,
                manifestDigest: item.promotion.manifestDigest,
                readyAt: item.promotion.readyAt,
              },
              promotionMerge: {
                mergeCommit: item.promotionMerge.mergeCommit,
                mergedAt: item.promotionMerge.mergedAt,
                reconciledAt: item.promotionMerge.reconciledAt,
                reconciledByCandidateId: item.promotionMerge.reconciledByCandidateId || "",
                reconciledByManifestDigest: item.promotionMerge.reconciledByManifestDigest || "",
              },
            })),
          dependencyBlocked,
          dependencyOutput,
          tasks: dependencyBlocked ? [] : ordered.ordered,
          blockedTasks: dependencyBlocked
            ? candidateTaskPlans.map((task) => ({
                taskId: task.id,
                title: task.title,
                status: "dependency_blocked",
                source: sourceLabel(task),
                output: dependencyOutput,
              }))
            : [],
          };
        });
    });

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    projects: projectPlans,
    taskCount: projectPlans.reduce((count, project) => count + project.tasks.length + project.blockedTasks.length, 0),
  };
}

function authoritativePromotionPolicyDigest(state, projectPlan) {
  const project = (state.projects || []).find((item) => item.id === projectPlan.projectId);
  if (!project) throw new Error(`Promotion project ${projectPlan.projectId} no longer exists.`);
  const projectPolicy = promotionProjectPolicyBinding(project);
  const projectPolicyDigest = contentDigest(JSON.stringify(projectPolicy));
  return promotionValidationPolicyDigest({
    commands: promotionValidationCommands(project),
    timeoutMs: Number(projectPlan.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
    environmentPolicyVersion: promotionValidationEnvironmentPolicyVersion(projectPlan.validationToolchain),
    projectPolicyDigest,
    sandboxPolicyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    validationStrategy: "disposable_full_clone",
    networkPolicy: "deny_all",
  });
}

function promotionClaimInput(projectPlan, input = {}, overrides = {}, state = null) {
  const policyDigest = state
    ? authoritativePromotionPolicyDigest(state, projectPlan)
    : projectPlan.validationPolicyDigest;
  if (policyDigest !== projectPlan.validationPolicyDigest) {
    throw new Error("Promotion validation policy changed after planning.");
  }
  return {
    projectId: projectPlan.projectId,
    candidateId: projectPlan.candidate.id,
    mode: projectPlan.mode,
    policyDigest,
    projectPolicy: projectPlan.projectPolicy,
    ttlMs: Number(input.promotionAttemptTtlMs || PROMOTION_ATTEMPT_TTL_MS),
    claimIdFactory: input.promotionClaimIdFactory,
    ...(input.nowMs === undefined ? {} : { nowMs: Number(input.nowMs) }),
    ...overrides,
  };
}

async function claimProjectPromotionAttempt(projectPlan, input = {}) {
  return mutatePromotionAttemptClaimState(projectPlan.candidate.id, (state) => claimPromotionAttemptInState(
    state,
    promotionClaimInput(projectPlan, input, {}, state),
  ), { operationName: "promotion.claim_attempt" });
}

async function renewProjectPromotionAttempt(projectPlan, claim, input = {}) {
  return mutatePromotionAttemptClaimState(projectPlan.candidate.id, (state) => renewPromotionAttemptClaimInState(
    state,
    claim,
    promotionClaimInput(projectPlan, input, {}, state),
  ), { operationName: "promotion.renew_attempt" });
}

async function assertProjectPromotionAttempt(projectPlan, claim, input = {}) {
  const state = await readState();
  try {
    return assertPromotionAttemptClaimInState(
      state,
      claim,
      promotionClaimInput(projectPlan, input, {}, state),
    );
  } catch (error) {
    error.code = "PROMOTION_ATTEMPT_STALE";
    throw error;
  }
}

async function recordProjectPromotionRecoveryReceipt(projectPlan, claim, validationResults, validationEvidence, input = {}) {
  return mutateCandidatePromotionState(projectPlan.candidate.id, claim, (state) => recordPromotionRecoveryReceiptInState(
    state,
    claim,
    {
      ...promotionClaimInput(projectPlan, input, {}, state),
      validationResults,
      validationEvidence,
      advanceTaskVersion: ({ task, source, candidate, previousVersion, now }) => {
        applyPromotionLifecycleTransitionInState(state, {
          action: "record_promotion_validation_evidence",
          taskId: task.id,
          expectedStateVersion: previousVersion,
          actorContext: {
            actorId: "studioops-promotion-worker",
            actorType: "system",
            role: "promotion-worker",
            trusted: true,
          },
          evidence: {
            targetStatus: task.status,
            candidateCycle: source.candidateCycle,
            subjectSha: source.headSha,
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
            promotionClaimId: claim.claimId,
            promotionClaimFence: claim.fence,
            validationEvidenceDigest: validationEvidence?.digest || "",
          },
        }, { now });
      },
    },
  ), { operationName: "promotion.record_recovery_receipt" });
}

async function bindProjectPromotionReconciliationReplacement(projectPlan, claim, replacement, input = {}) {
  return mutatePromotionAttemptClaimState(projectPlan.candidate.id, (state) => bindPromotionReconciliationReplacementInState(
    state,
    claim,
    {
      ...promotionClaimInput(projectPlan, input, {}, state),
      replacement,
    },
  ), { operationName: "promotion.bind_reconciliation_replacement" });
}

function allTaskResults(tasks, status, output) {
  return tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    status,
    source: sourceLabel(task),
    output: truncateOutput(output),
  }));
}

function integrityFailure(message, expected = "", observed = "") {
  const error = new Error(message);
  error.code = "CANDIDATE_INTEGRITY";
  error.expected = expected;
  error.observed = observed;
  return error;
}

async function checkoutExactCandidate(repoPath, projectPlan, options = {}) {
  const candidate = projectPlan.candidate;
  assertCandidateEnvelope(candidate);
  const manifest = candidate.manifest;
  if (projectPlan.targetBranch !== manifest.base.branch) {
    throw integrityFailure(
      `Promotion target ${projectPlan.targetBranch} does not match candidate base ${manifest.base.branch}.`,
      manifest.base.branch,
      projectPlan.targetBranch,
    );
  }
  const repositoryVerification = await verifyPromotionCandidateRepositoryState(repoPath, candidate, options);
  if (!repositoryVerification.ok) {
    if (repositoryVerification.status === "drift") {
      throw integrityFailure(
        repositoryVerification.reason,
        repositoryVerification.expected,
        repositoryVerification.observed,
      );
    }
    throw new Error(repositoryVerification.reason);
  }
  const targetBranch = await prepareTargetBranch(repoPath, projectPlan, options);
  const observedBase = await branchHead(repoPath, `refs/remotes/origin/${targetBranch}`, options);
  if (observedBase !== manifest.base.sha) {
    throw integrityFailure(
      `Candidate base drift: expected ${manifest.base.sha}, observed ${observedBase || "missing"}.`,
      manifest.base.sha,
      observedBase,
    );
  }

  const candidateRef = `refs/studioops/candidates/${safeRefSegment(candidate.id)}/integration`;
  const candidateFetch = await git(
    repoPath,
    ["fetch", "origin", `${manifest.integration.branch}:${candidateRef}`],
    { ...options, allowFailure: true },
  );
  if (!candidateFetch.ok) {
    throw new Error(`Could not fetch candidate branch ${manifest.integration.branch}: ${truncateOutput(candidateFetch.output)}`);
  }
  const observedIntegration = await branchHead(repoPath, candidateRef, options);
  if (observedIntegration !== manifest.integration.sha) {
    throw integrityFailure(
      `Candidate branch drift: expected ${manifest.integration.sha}, observed ${observedIntegration || "missing"}.`,
      manifest.integration.sha,
      observedIntegration,
    );
  }

  for (const source of manifest.sources) {
    const localRef = `refs/studioops/candidates/${safeRefSegment(candidate.id)}/sources/${safeRefSegment(source.taskId)}`;
    const fetched = await git(
      repoPath,
      ["fetch", "origin", `${source.sourceRef}:${localRef}`],
      { ...options, allowFailure: true },
    );
    if (!fetched.ok) throw new Error(`Could not verify source ${source.taskId}: ${truncateOutput(fetched.output)}`);
    const observed = await branchHead(repoPath, localRef, options);
    if (observed !== source.headSha) {
      throw integrityFailure(
        `Candidate source drift for ${source.taskId}: expected ${source.headSha}, observed ${observed || "missing"}.`,
        source.headSha,
        observed,
      );
    }
  }

  const ancestry = await git(
    repoPath,
    ["merge-base", "--is-ancestor", manifest.base.sha, manifest.integration.sha],
    { ...options, allowFailure: true },
  );
  if (!ancestry.ok) throw integrityFailure("Candidate integration commit does not descend from its recorded base.");
  await git(repoPath, ["checkout", "--detach", manifest.integration.sha], options);
  return manifest.integration.sha;
}

function reconciliationTaskResults(projectPlan, status, output) {
  return allTaskResults(projectPlan.tasks, status, output);
}

async function reconcileSupersededCandidate(repoPath, projectPlan, result, options = {}) {
  const candidate = projectPlan.candidate;
  const gitOptions = promotionGitOptions(options);
  const fetched = await git(
    repoPath,
    ["fetch", "origin", `refs/heads/${projectPlan.targetBranch}:refs/remotes/origin/${projectPlan.targetBranch}`],
    { ...gitOptions, allowFailure: true },
  );
  if (!fetched.ok) {
    result.status = "reconciliation_unavailable";
    result.output = `Protected promotion target could not be fetched while checking for a superseding merge; reconciliation will retry without changing task state.\n${truncateOutput(fetched.output)}`;
    result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
    return result;
  }
  const targetHead = await branchHead(
    repoPath,
    `refs/remotes/origin/${projectPlan.targetBranch}`,
    gitOptions,
  );

  for (const replacement of projectPlan.mergedCandidates || []) {
    if (replacement.manifest.base.branch !== projectPlan.targetBranch) continue;
    const candidateIncluded = await git(
      repoPath,
      ["merge-base", "--is-ancestor", candidate.manifest.integration.sha, replacement.manifest.integration.sha],
      { ...gitOptions, allowFailure: true },
    );
    if (!candidateIncluded.ok) continue;
    const sourceChecks = await Promise.all(candidate.manifest.sources.map((source) => git(
      repoPath,
      ["merge-base", "--is-ancestor", source.headSha, replacement.manifest.integration.sha],
      { ...gitOptions, allowFailure: true },
    )));
    if (sourceChecks.some((check) => !check.ok)) continue;
    const replacementIncluded = await git(
      repoPath,
      ["merge-base", "--is-ancestor", replacement.manifest.integration.sha, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    const mergeIncluded = await git(
      repoPath,
      ["merge-base", "--is-ancestor", replacement.promotionMerge.mergeCommit, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    if (!replacementIncluded.ok || !mergeIncluded.ok) continue;

    const replacementPlan = {
      ...projectPlan,
      candidate: replacement,
      promotionSubjectCandidate: candidate,
    };
    const replacementInspection = await inspectExactPromotionPullRequest(
      repoPath,
      replacementPlan,
      replacement.promotion.branch,
      replacement.manifest.integration.sha,
      options,
    );
    if (replacementInspection.status === "unavailable") {
      result.status = "reconciliation_unavailable";
      result.output = `Superseding promotion PR could not be authoritatively inspected; reconciliation will retry without changing task state.\n${replacementInspection.reason || "GitHub observation unavailable."}`;
      result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
      return result;
    }
    const replacementPr = replacementInspection.pr;
    if (
      replacementInspection.status !== "exact"
      || replacementPr.url !== replacement.promotion.prUrl
      || replacementPr.state !== "MERGED"
      || replacementPr.mergeCommit !== replacement.promotionMerge.mergeCommit
      || replacementPr.mergedAt !== replacement.promotionMerge.mergedAt
    ) {
      continue;
    }
    const replacementBinding = {
      candidateId: replacement.id,
      manifestDigest: replacement.manifestDigest,
      integrationBranch: replacement.manifest.integration.branch,
      integrationSha: replacement.manifest.integration.sha,
      qaDecision: replacement.qaDecision,
      promotion: replacement.promotion,
      promotionMerge: replacement.promotionMerge,
      observedPromotionPr: {
        ...replacementPr,
        candidateMarker: promotionCandidateMarker(replacementPlan),
      },
    };
    if (options.beforeReconciliationReplacementBinding) {
      await options.beforeReconciliationReplacementBinding({ replacement: replacementBinding });
    }
    if (!options.bindReconciliationReplacement) {
      throw new Error("Promotion reconciliation replacement claim binder is unavailable.");
    }
    const boundClaim = await options.bindReconciliationReplacement(replacementBinding);
    projectPlan.promotionClaim = boundClaim;
    replacementPlan.promotionClaim = boundClaim;
    result.promotionClaim = boundClaim;
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    // The replacement binding changes the claim digest. Re-observe the exact
    // merged PR after that fence is durable so the result seal binds both the
    // authoritative replacement and the final claim identity.
    const boundReplacementInspection = await inspectExactPromotionPullRequest(
      repoPath,
      replacementPlan,
      replacement.promotion.branch,
      replacement.manifest.integration.sha,
      options,
    );
    if (
      boundReplacementInspection.status !== "exact"
      || boundReplacementInspection.pr.url !== replacement.promotion.prUrl
      || boundReplacementInspection.pr.state !== "MERGED"
      || boundReplacementInspection.pr.mergeCommit !== replacement.promotionMerge.mergeCommit
      || boundReplacementInspection.pr.mergedAt !== replacement.promotionMerge.mergedAt
    ) {
      result.status = "reconciliation_unavailable";
      result.output = "Superseding promotion PR changed after the fenced replacement binding; reconciliation will retry without changing task state.";
      result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
      return result;
    }

    const promotionMergeAncestryObservation = await inspectPromotionMergeAncestry({
      repoPath,
      projectId: projectPlan.projectId,
      repoUrl: projectPlan.repoUrl,
      targetBranch: projectPlan.targetBranch,
      promotionBranch: replacement.promotion.branch,
      subjectCandidate: candidate,
      remoteCandidate: replacement,
      claim: boundClaim,
      prUrl: replacement.promotion.prUrl,
      mergeCommit: replacement.promotionMerge.mergeCommit,
      mergedAt: replacement.promotionMerge.mergedAt,
      remoteObservation: boundReplacementInspection.remoteObservation,
    }, options);

    result.status = "merged";
    result.prUrl = replacement.promotion.prUrl;
    result.mergeCommit = replacement.promotionMerge.mergeCommit;
    result.mergedAt = replacement.promotionMerge.mergedAt;
    result.reconciledByCandidateId = replacement.id;
    result.reconciledByManifestDigest = replacement.manifestDigest;
    result.reconciliationReplacement = boundClaim.reconciliationReplacement;
    result.reconciliationReplacementDigest = boundClaim.reconciliationReplacementDigest;
    result.promotionRemoteObservation = boundReplacementInspection.remoteObservation;
    result.promotionMergeAncestryObservation = promotionMergeAncestryObservation;
    result.promotionTargetHead = promotionMergeAncestryObservation.targetHead;
    result.output = `Verified exact candidate ${candidate.id} was incorporated by merged candidate ${replacement.id} and is reachable from protected target ${projectPlan.targetBranch} at ${targetHead}.`;
    result.tasks = reconciliationTaskResults(projectPlan, "merged", result.output);
    return result;
  }
  return null;
}

async function reconcilePromotionProject(projectPlan, options = {}) {
  const candidate = projectPlan.candidate;
  const promotion = candidate.promotion || {};
  const result = {
    ...projectPlan,
    tasks: [],
    status: "reconciliation_unavailable",
    output: "",
    commit: candidate.manifest.integration.sha,
    validation: [],
    promotionBranch: promotion.branch || "",
    prUrl: promotion.prUrl || "",
    mergeCommit: "",
    mergedAt: "",
    sourceRepoPath: projectPlan.repoPath || "",
    workspacePath: "",
    workspaceStrategy: "reconciliation",
  };

  if (!projectPlan.enabled) {
    result.status = "promotion_invalid";
    result.output = projectPlan.skipReason;
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }
  if (!path.isAbsolute(projectPlan.repoPath || "")) {
    result.status = "promotion_invalid";
    result.output = "Project repoPath must be an absolute local path before promotion reconciliation can run.";
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }
  if (!candidateHasValidPromotionHandoff(candidate)) {
    result.status = "promotion_invalid";
    result.output = "Persisted promotion handoff is not bound to the exact immutable candidate.";
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }

  let workspace = null;
  try {
    workspace = await preparePromotionWorkspace(projectPlan.repoPath, projectPlan, options);
    result.workspacePath = workspace.workspacePath;
    result.workspaceStrategy = "reconciliation_isolated_clone";
    const repoPath = workspace.executionRepoPath;
    const gitOptions = promotionGitOptions(options);
    await promotionRemotePolicy(repoPath, projectPlan, options);
    if (options.renewPromotionClaim) {
      const renewed = await options.renewPromotionClaim();
      projectPlan.promotionClaim = renewed;
      result.promotionClaim = renewed;
    }
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    const inspection = await inspectExactPromotionPullRequest(
      repoPath,
      projectPlan,
      promotion.branch,
      candidate.manifest.integration.sha,
      options,
    );
    if (inspection.status === "unavailable") {
      result.output = `Promotion PR could not be authoritatively inspected; reconciliation will retry without changing task state.\n${inspection.reason || "GitHub observation unavailable."}`;
      result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
      return result;
    }
    if (inspection.status !== "exact" || inspection.pr.url !== promotion.prUrl) {
      result.status = "promotion_invalid";
      result.output = `Promotion PR identity no longer exactly matches the configured repository, immutable candidate marker, base, head branch, and head SHA (${inspection.reason || inspection.status}).`;
      result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
      return result;
    }
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    const pr = inspection.pr;
    const expectedSha = candidate.manifest.integration.sha;
    if (pr.state === "OPEN") {
      result.status = "pending";
      result.output = "Release-candidate PR remains open for the owner; no workflow state changed.";
      result.tasks = reconciliationTaskResults(projectPlan, "pending", result.output);
      return result;
    }
    if (pr.state !== "MERGED") {
      const superseded = await reconcileSupersededCandidate(repoPath, projectPlan, result, options);
      if (options.assertPromotionClaim) await options.assertPromotionClaim();
      if (superseded) return superseded;
      result.status = "promotion_closed";
      result.output = "Release-candidate PR was closed without merging. Owner action is required before promotion can continue.";
      result.tasks = reconciliationTaskResults(projectPlan, "promotion_closed", result.output);
      return result;
    }

    const mergeCommit = pr.mergeCommit;
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(mergeCommit) || !Number.isFinite(Date.parse(pr.mergedAt || ""))) {
      result.status = "promotion_invalid";
      result.output = "Merged promotion PR is missing an immutable merge commit or merged timestamp.";
      result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
      return result;
    }

    const fetched = await git(
      repoPath,
      ["fetch", "origin", `refs/heads/${projectPlan.targetBranch}:refs/remotes/origin/${projectPlan.targetBranch}`],
      { ...gitOptions, allowFailure: true },
    );
    if (!fetched.ok) {
      result.output = `Merged promotion target could not be fetched; reconciliation will retry without changing task state.\n${truncateOutput(fetched.output)}`;
      result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
      return result;
    }
    const targetHead = await branchHead(repoPath, `refs/remotes/origin/${projectPlan.targetBranch}`, gitOptions);
    const candidateReachable = await git(
      repoPath,
      ["merge-base", "--is-ancestor", expectedSha, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    const mergeReachable = await git(
      repoPath,
      ["merge-base", "--is-ancestor", mergeCommit, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    if (!candidateReachable.ok || !mergeReachable.ok) {
      result.status = "promotion_invalid";
      result.output = `Protected target ${projectPlan.targetBranch} at ${targetHead || "missing"} does not contain the exact candidate and recorded merge commit.`;
      result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
      return result;
    }
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    const promotionMergeAncestryObservation = await inspectPromotionMergeAncestry({
      repoPath,
      projectId: projectPlan.projectId,
      repoUrl: projectPlan.repoUrl,
      targetBranch: projectPlan.targetBranch,
      promotionBranch: promotion.branch,
      subjectCandidate: candidate,
      remoteCandidate: candidate,
      claim: projectPlan.promotionClaim,
      prUrl: promotion.prUrl,
      mergeCommit,
      mergedAt: pr.mergedAt,
      remoteObservation: inspection.remoteObservation,
    }, options);

    result.status = "merged";
    result.mergeCommit = mergeCommit;
    result.mergedAt = pr.mergedAt;
    result.promotionRemoteObservation = inspection.remoteObservation;
    result.promotionMergeAncestryObservation = promotionMergeAncestryObservation;
    result.promotionTargetHead = promotionMergeAncestryObservation.targetHead;
    result.output = `Verified ${promotion.prUrl} merged the exact candidate into ${projectPlan.targetBranch} at ${mergeCommit}.`;
    result.tasks = reconciliationTaskResults(projectPlan, "merged", result.output);
    return result;
  } catch (error) {
    result.status = error.code === "PROMOTION_REMOTE_POLICY" ? "promotion_invalid" : "reconciliation_unavailable";
    result.output = truncateOutput(redactPromotionValidationText(error.message));
    result.tasks = reconciliationTaskResults(projectPlan, result.status, result.output);
    return result;
  } finally {
    if (workspace?.workspacePath) {
      try {
        await safeRemoveWorkspace(workspace.workspacePath, workspace.workspaceRoot);
      } catch (error) {
        result.output = [result.output, `Cleanup warning: ${error.message}`].filter(Boolean).join("\n");
      }
    }
  }
}

async function promoteProject(projectPlan, options = {}) {
  const repoPath = String(projectPlan.repoPath || "").trim();
  const result = {
    ...projectPlan,
    tasks: [...(projectPlan.blockedTasks || [])],
    status: "skipped",
    output: "",
    commit: "",
    validation: [],
    validationEvidence: null,
    validationAttempt: Number(projectPlan.promotionClaim?.attempt || (projectPlan.mode === "retry" ? 2 : 1)),
    promotionBranch: "",
    prUrl: "",
    sourceRepoPath: repoPath,
    workspacePath: "",
    workspaceStrategy: "",
    validationSandboxPolicy: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    validationWorkspaceStrategy: "disposable_full_clone",
    validationNetworkPolicy: "deny_all",
    validationProcessPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
  };

  if (!projectPlan.tasks.length && !projectPlan.blockedTasks?.length) {
    result.status = "no_tasks";
    return result;
  }

  if (projectPlan.dependencyBlocked) {
    result.status = "dependency_blocked";
    result.output = projectPlan.dependencyOutput || "Promotion dependencies are not complete.";
    return result;
  }

  if (!projectPlan.enabled) {
    result.status = "skipped";
    result.output = projectPlan.skipReason;
    result.tasks.push(...allTaskResults(projectPlan.tasks, "skipped", projectPlan.skipReason));
    return result;
  }

  if (!path.isAbsolute(repoPath)) {
    result.status = "blocked";
    result.output = "Project repoPath must be an absolute local path before promotion can run.";
    result.tasks.push(...allTaskResults(projectPlan.tasks, "blocked", result.output));
    return result;
  }

  const validationCommands = normalizeList(projectPlan.validationCommands);
  if (!validationCommands.length) {
    result.status = "validation_missing";
    result.output = "No project validationCommands are configured. Promotion to main was not attempted.";
    result.tasks.push(...allTaskResults(projectPlan.tasks, "validation_missing", result.output));
    return result;
  }

  let workspace = null;
  let validationSandbox = null;
  try {
    workspace = await preparePromotionWorkspace(repoPath, projectPlan, options);
    result.workspacePath = workspace.workspacePath;
    result.workspaceStrategy = workspace.strategy;
    const executionRepoPath = workspace.executionRepoPath;
    const gitOptions = promotionGitOptions(options);

    await checkoutExactCandidate(executionRepoPath, projectPlan, gitOptions);
    if (options.renewPromotionClaim) {
      const renewed = await options.renewPromotionClaim();
      projectPlan.promotionClaim = renewed;
      result.promotionClaim = renewed;
    }
    const candidateTasks = allTaskResults(projectPlan.tasks, "candidate_verified", "Exact candidate identity verified.");
    result.tasks.push(...candidateTasks);

    let validationReceiptResults = [];
    const reusableRecoveryReceipt = projectPlan.promotionRecoveryReceipt || null;
    if (reusableRecoveryReceipt) {
      const verifiedEvidence = await verifyPromotionValidationEvidence(
        reusableRecoveryReceipt.validationEvidence,
        { root: options.validationEvidenceRoot },
      );
      result.validationEvidence = {
        ...reusableRecoveryReceipt.validationEvidence,
        path: verifiedEvidence.path,
        digest: verifiedEvidence.digest,
        bytes: verifiedEvidence.bytes,
      };
      result.validationAttempt = Number(reusableRecoveryReceipt.validationEvidence.attempt);
      result.validation = [{
        command: "[exact promotion recovery receipt]",
        ok: true,
        output: `Reused ${reusableRecoveryReceipt.validationResultDigest}.`,
        outputDigest: reusableRecoveryReceipt.validationResultDigest,
      }];
    } else {
      validationSandbox = await prepareProjectValidationSandbox({
        sourceRepoPath: executionRepoPath,
        workspaceRoot: workspace.workspaceRoot,
        expectedHeadSha: projectPlan.candidate.manifest.integration.sha,
        validationPath: projectPlan.validationPath,
        sandboxExecutable: options.validationSandboxExecutable,
        cloneTimeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
      });
      result.validationDependencyCache = await prepareProjectValidationDependencies(validationSandbox, {
        dependencyAcquisitionTimeoutMs: options.validationDependencyAcquisitionTimeoutMs,
        dependencyAcquisitionMaxCaptureBytes: options.validationDependencyAcquisitionMaxCaptureBytes,
      });
      result.validationSandboxPolicy = validationSandbox.policyId;
      result.validationWorkspaceStrategy = validationSandbox.strategy;
      result.validationNetworkPolicy = validationSandbox.networkPolicy;
      result.validationProcessPolicy = validationSandbox.processPolicy;
      const observedToolchain = normalizedPromotionValidationToolchain(validationSandbox.environment?.PATH, {
        sandbox: validationSandbox.executable,
        verifier: validationSandbox.verifierExecutable,
      }, validationCommands);
      if (!isDeepStrictEqual(observedToolchain, projectPlan.validationToolchain)) {
        const error = new Error("Prepared validation sandbox toolchain changed after promotion planning.");
        error.code = "PROJECT_VALIDATION_POLICY_DRIFT";
        throw error;
      }
      const validationRun = await runValidationCommands(
        validationSandbox,
        validationCommands,
        options,
        {
          candidate: projectPlan.candidate,
          attempt: result.validationAttempt,
          policyDigest: projectPlan.validationPolicyDigest,
        },
      );
      result.validation = validationRun.summaries;
      result.validationEvidence = validationRun.evidence;
      result.validationOmittedSummaryCount = validationRun.omittedSummaryCount;
      validationReceiptResults = validationRun.receiptResults;
    }
    const failedValidation = result.validation.find((item) => !item.ok);
    if (failedValidation) {
      result.status = "validation_failed";
      result.output = `Validation failed: ${failedValidation.command}`;
      for (const task of candidateTasks) task.status = "validation_failed";
      return result;
    }

    const prePushVerification = await verifyPromotionCandidateRepositoryState(
      executionRepoPath,
      projectPlan.candidate,
      gitOptions,
    );
    if (!prePushVerification.ok) {
      if (prePushVerification.status === "drift") {
        throw integrityFailure(
          prePushVerification.reason,
          prePushVerification.expected,
          prePushVerification.observed,
        );
      }
      throw new Error(prePushVerification.reason);
    }

    const commit = await branchHead(executionRepoPath, "HEAD", gitOptions);
    result.commit = commit;
    if (commit !== projectPlan.candidate.manifest.integration.sha) {
      result.status = "blocked";
      result.output = `Promotion checkout drift: expected ${projectPlan.candidate.manifest.integration.sha}, observed ${commit || "missing"}.`;
      for (const task of candidateTasks) task.status = "blocked";
      return result;
    }

    if (!reusableRecoveryReceipt) {
      const recorded = await options.recordRecoveryReceipt(validationReceiptResults, result.validationEvidence);
      projectPlan.promotionClaim = recorded.claim;
      projectPlan.promotionRecoveryReceipt = recorded.receipt;
      projectPlan.candidate.promotionValidationRecoveryReceipt = recorded.receipt;
      result.promotionClaim = recorded.claim;
      result.promotionRecoveryReceipt = recorded.receipt;
    }
    if (options.beforePromotionPush) await options.beforePromotionPush();
    if (options.assertPromotionClaim) await options.assertPromotionClaim();
    await promotionRemotePolicy(executionRepoPath, projectPlan, options);

    result.promotionBranch = promotionBranchName(projectPlan);
    const push = await git(executionRepoPath, ["push", "origin", `HEAD:refs/heads/${result.promotionBranch}`], { ...gitOptions, allowFailure: true });
    if (!push.ok) {
      result.status = "push_failed";
      result.output = `Non-force push to release-candidate branch ${result.promotionBranch} failed.\n${truncateOutput(push.output)}`;
      for (const task of candidateTasks) task.status = "push_failed";
      return result;
    }

    const prePrVerification = await verifyPromotionCandidateRepositoryState(
      executionRepoPath,
      projectPlan.candidate,
      gitOptions,
    );
    if (!prePrVerification.ok) {
      if (prePrVerification.status === "drift") {
        throw integrityFailure(
          prePrVerification.reason,
          prePrVerification.expected,
          prePrVerification.observed,
        );
      }
      throw new Error(prePrVerification.reason);
    }
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    const initialPrInspection = await inspectExactPromotionPullRequest(
      executionRepoPath,
      projectPlan,
      result.promotionBranch,
      commit,
      options,
    );
    if (!["exact", "missing"].includes(initialPrInspection.status)) {
      result.status = "pr_failed";
      result.output = `Release-candidate PR identity could not be established before creation: ${initialPrInspection.reason || initialPrInspection.status}.`;
      for (const task of candidateTasks) task.status = result.status;
      return result;
    }
    let prOutput = "";
    let observedInspection = initialPrInspection;
    if (initialPrInspection.status === "missing") {
      if (options.assertPromotionClaim) await options.assertPromotionClaim();
      const taskList = projectPlan.tasks
        .map((task) => `- ${task.id}: ${task.title}${task.prUrl ? ` (${task.prUrl})` : ""} at ${task.headSha}`)
        .join("\n");
      const repository = initialPrInspection.repository;
      const candidateMarker = promotionCandidateMarker(projectPlan);
      const claimMarker = promotionClaimMarker(projectPlan);
      const [owner, name] = repository.split("/");
      const prBody = `${candidateMarker}\n${claimMarker}\n## Immutable StudioOps candidate\n\nCandidate: ${projectPlan.candidate.id}\nManifest: ${projectPlan.candidate.manifestDigest}\nIntegration SHA: ${projectPlan.candidate.manifest.integration.sha}\n\n## QA-approved tasks\n\n${taskList}\n\nValidation passed against the exact candidate in StudioOps. Production deployment remains release/tag gated.`;
      const pr = await githubApiRequest({
        operation: "create",
        method: "POST",
        pathname: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        body: {
          base: projectPlan.targetBranch,
          head: result.promotionBranch,
          title: `QA-approved release candidate: ${projectPlan.projectName || projectPlan.projectKey}`,
          body: prBody,
        },
        repository,
        baseRefName: projectPlan.targetBranch,
        headRefName: result.promotionBranch,
        headRefOid: commit,
        candidateMarker,
        claimMarker,
      }, {
        githubToken: options.githubToken,
        testGitHubApi: options.testGitHubApi,
        secrets: options.secrets,
      });
      prOutput = pr.output || "";
      observedInspection = await inspectExactPromotionPullRequest(
        executionRepoPath,
        projectPlan,
        result.promotionBranch,
        commit,
        options,
      );
      if (observedInspection.status !== "exact") {
        result.status = "pr_failed";
        result.output = [
          `Release-candidate PR could not be authoritatively re-observed after create returned ${pr.ok ? "success" : "failure"}: ${observedInspection.reason || observedInspection.status}.`,
          truncateOutput(prOutput),
        ].filter(Boolean).join("\n");
        for (const task of candidateTasks) task.status = result.status;
        return result;
      }
    }

    const observedPr = observedInspection.pr;
    result.repository = observedInspection.repository;
    result.observedPromotionPr = observedPr;
    result.promotionRemoteObservation = observedInspection.remoteObservation;
    result.prUrl = observedPr.url;
    result.promotionPrExact = true;
    result.promotionPrCreated = initialPrInspection.status === "missing"
      && observedPr.body.includes(promotionClaimMarker(projectPlan));
    if (options.assertPromotionClaim) await options.assertPromotionClaim();
    result.status = observedPr.state === "MERGED"
      ? "pr_merged_detected"
      : observedPr.state === "CLOSED"
        ? "pr_closed"
        : "pr_ready";
    result.output = result.status === "pr_closed"
      ? "The exact deterministic release-candidate PR was closed without merging. StudioOps will not reopen or replace a human-closed release gate automatically."
      : truncateOutput(prOutput || `Observed exact release-candidate PR ${observedPr.url}.`);
    for (const task of candidateTasks) task.status = result.status;
    return result;
  } catch (error) {
    const failureStatus = error.code === "PROMOTION_VALIDATION_EVIDENCE_FAILED"
      ? "evidence_failed"
      : error.code === "PROMOTION_REMOTE_POLICY"
        ? "remote_policy_invalid"
      : error.code === "PROJECT_VALIDATION_DEPENDENCY_ACQUISITION_FAILED"
        ? "dependency_acquisition_failed"
      : String(error.code || "").startsWith("PROJECT_VALIDATION_")
        ? "validation_sandbox_unavailable"
      : error.code === "CANDIDATE_INTEGRITY"
        ? "blocked"
        : "candidate_verification_unavailable";
    result.status = failureStatus;
    result.output = truncateOutput(error.message);
    if (error.code === "CANDIDATE_INTEGRITY") {
      result.candidateInvalidation = {
        reason: error.message,
        expected: error.expected || "",
        observed: error.observed || "",
      };
    }
    if (result.tasks.length) {
      for (const task of result.tasks) {
        task.status = failureStatus;
        task.output = truncateOutput(error.message);
      }
    } else {
      result.tasks = allTaskResults(projectPlan.tasks, failureStatus, error.message);
    }
    return result;
  } finally {
    if (validationSandbox) {
      try {
        await cleanupProjectValidationSandbox(validationSandbox);
      } catch (error) {
        result.output = [result.output, `Validation-sandbox cleanup warning: ${error.message}`].filter(Boolean).join("\n");
      }
    }
    if (workspace?.workspacePath) {
      try {
        await safeRemoveWorkspace(workspace.workspacePath, workspace.workspaceRoot);
      } catch (error) {
        result.output = [result.output, `Cleanup warning: ${error.message}`].filter(Boolean).join("\n");
      }
    }
  }
}

function authFailureProjectResult(projectPlan, error) {
  const output = `GitHub App auth failed for promotion: ${error.message}`;
  const reconciliation = projectPlan.mode === "reconcile";
  const status = reconciliation ? "reconciliation_unavailable" : "auth_failed";
  return {
    ...projectPlan,
    tasks: allTaskResults(projectPlan.tasks, status, output),
    status,
    output: truncateOutput(output),
    commit: "",
    validation: [],
    sourceRepoPath: projectPlan.repoPath || "",
    workspacePath: "",
    workspaceStrategy: "",
  };
}

function validationSummary(result) {
  if (!result.validation?.length) return "";
  return result.validation
    .map((item) => `- ${item.command}: ${item.ok ? "passed" : "failed"}${item.output ? `\n${item.output}` : ""}`)
    .join("\n");
}

function validationEvidenceSummary(result) {
  const evidence = result.validationEvidence;
  if (!evidence?.path || !evidence?.digest) return "";
  return `\n\nPrivate validation evidence: ${evidence.path}\nDigest: ${evidence.digest}`;
}

function branchWebUrl(projectResult) {
  const raw = String(projectResult.repoUrl || "").trim();
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  const match = sshMatch || httpsMatch;
  if (!match) return "";
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}/tree/${projectResult.targetBranch.split("/").map(encodeURIComponent).join("/")}`;
}

function workspaceSummary(result) {
  if (!result.workspacePath) return "";
  const strategy = result.workspaceStrategy ? ` (${result.workspaceStrategy})` : "";
  return `\n\nWorkspace: ${result.workspacePath}${strategy}`;
}

function commentForTask(projectResult, taskResult) {
  const targetLine = branchWebUrl(projectResult)
    ? `\n\nTarget branch: ${branchWebUrl(projectResult)}`
    : `\n\nTarget branch: ${projectResult.targetBranch}`;
  const workspaceLine = workspaceSummary(projectResult);

  if (["pr_ready", "pr_merged_detected"].includes(taskResult.status)) {
    if (taskResult.status === "pr_merged_detected") {
      return `Detected that the exact QA-approved release-candidate PR is already merged. StudioOps persisted the immutable handoff and will reconcile protected-main reachability next.\n\nPR: ${projectResult.prUrl}${targetLine}${workspaceLine}\n\nValidation evidence was reverified:\n${validationSummary(projectResult)}${validationEvidenceSummary(projectResult)}`;
    }
    return `QA-approved release-candidate PR is ready for ${projectResult.targetBranch} at ${projectResult.commit}.${projectResult.prUrl ? `\n\nPR: ${projectResult.prUrl}` : ""}${targetLine}${workspaceLine}\n\nValidation passed:\n${validationSummary(projectResult)}${validationEvidenceSummary(projectResult)}`;
  }

  if (taskResult.status === "conflict") {
    const files = taskResult.conflicts?.length ? taskResult.conflicts.map((file) => `- ${file}`).join("\n") : "- Git did not report conflicted file names.";
    return `Promotion blocked: merging ${taskResult.source} into ${projectResult.targetBranch} produced conflicts. No changes were pushed.${workspaceLine}\n\nConflicts:\n${files}`;
  }

  if (taskResult.status === "validation_failed") {
    return `Promotion validation failed after merging ${taskResult.source} into ${projectResult.targetBranch}. No changes were pushed.${targetLine}${workspaceLine}\n\nValidation:\n${validationSummary(projectResult)}${validationEvidenceSummary(projectResult)}`;
  }

  if (taskResult.status === "evidence_failed") {
    return `Promotion stopped before push because its private validation evidence could not be persisted and verified.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "auth_failed") {
    return `Promotion authentication is unavailable. The exact QA candidate and its release authority were preserved for automatic recovery after credentials are repaired.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "dependency_acquisition_failed") {
    return `Promotion stopped because lockfile-bound dependency acquisition failed before isolated validation. No validation command, push, or PR action was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "validation_sandbox_unavailable") {
    return `Promotion stopped before repository code ran because the fail-closed validation sandbox was unavailable. No validation command, push, or PR action was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "candidate_verification_unavailable") {
    return `Promotion could not authoritatively verify the candidate repository or disposable workspace. The immutable QA candidate was preserved for bounded automatic retry.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "remote_policy_invalid") {
    return `Promotion stopped before any remote write because the registered origin did not exactly match the configured GitHub repository. The candidate is preserved for owner remediation.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "push_failed") {
    return `Promotion could not update ${projectResult.targetBranch} with ${taskResult.source}. No force push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "pr_failed") {
    return `Release-candidate branch ${projectResult.promotionBranch || ""} was pushed, but its pull request could not be created.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "pr_closed") {
    return `The exact release-candidate PR was closed without merging. StudioOps preserved the QA candidate and stopped automatic promotion until the owner decides whether to reopen that gate.\n\nPR: ${projectResult.prUrl || "unavailable"}${workspaceLine}`;
  }

  if (taskResult.status === "dependency_blocked") {
    return `Promotion waiting: ${taskResult.output}`;
  }

  if (taskResult.status === "merged") {
    const warning = taskResult.validationWarning
      ? "\n\nWarning: a validation retry finished after GitHub merged this PR. Its failed evidence remains preserved for operator review; the merge record reports remote truth and does not convert that validation result into a pass."
      : "";
    return `Verified release-candidate merge for immutable candidate ${projectResult.candidate.id}.\n\nPR: ${projectResult.prUrl}\nMerge commit: ${projectResult.mergeCommit}\nTarget: ${projectResult.targetBranch}${warning}`;
  }

  if (["promotion_closed", "promotion_invalid"].includes(taskResult.status)) {
    return `Promotion reconciliation requires owner action. No review was restarted and no replacement PR was created.\n\n${taskResult.output || projectResult.output}`;
  }

  return `Promotion skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No promotion was attempted."}${workspaceLine}`;
}

function promotionCircuitPatch(task, projectResult, taskResult, now, circuit) {
  const snapshot = workflowSnapshotForTask(task, {
    status: "promotion_blocked",
    assignedAgentRole: "promotion-worker",
  });
  const reasonCode = String(circuit?.reasonCode || "promotion_attempt_budget_exhausted");
  const attemptsConsumed = Number(circuit?.attemptsConsumed || 0);
  const maxAttempts = Number(circuit?.maxAttempts || 0);
  return {
    status: "blocked",
    assignedAgentRole: "owner",
    reviewerThreadId: "",
    retryNotBefore: "",
    lastAutomationFailure: `${taskResult.status}: ${projectResult.output || "promotion failed"}`,
    automationCircuit: {
      state: "open",
      scope: "task",
      reasonCode,
      normalizedReason: "Bounded automatic promotion recovery was exhausted.",
      failureFingerprint: `${task.id}:${circuit?.attemptSeriesDigest || projectResult.candidate?.id || "unknown"}`,
      attemptsConsumed,
      maxAttempts,
      recoveryCount: Math.max(0, attemptsConsumed - 1),
      snapshot,
      openedAt: now,
      nextCheapProbe: "Verify the preserved promotion failure and exact candidate without executing repository code.",
      resumeAction: `studioops circuit-reset --task ${task.id} --expected-opened-at ${now} --reason verified`,
      remediation: "Repair the promotion dependency or validation sandbox, then explicitly reset this circuit.",
    },
    automationBlocker: {
      type: "circuit",
      reason: reasonCode,
      resumeStatus: "promotion_blocked",
      attempts: attemptsConsumed,
      retryAt: "",
    },
  };
}

function taskPatchForPromotion(projectResult, taskResult, now, task, candidate) {
  const priorValidationAttempts = promotionValidationAttemptsForCandidate(task, candidate);
  const validationAttempt = Number(projectResult.validationAttempt || 0);
  const validationWasRecorded = Array.isArray(projectResult.validation) && projectResult.validation.length > 0;
  const promotionValidationAttempts = validationWasRecorded
    ? Math.max(priorValidationAttempts, validationAttempt)
    : priorValidationAttempts;
  const firstFailureAuthorization = (
    taskResult.status === "validation_failed"
    && validationAttempt === 1
    && projectResult.validationEvidence?.digest
  ) ? {
      schemaVersion: "studioops.promotion-retry-authorization.v1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      policyDigest: projectResult.validationPolicyDigest,
      firstEvidenceDigest: projectResult.validationEvidence.digest,
      independentResult: "validation_failed",
      authorizedBy: "studioops-promotion-worker",
      authorizedAt: now,
    } : null;
  const patch = {
    promotionEvidence: {
      schemaVersion: "studioops.promotion-outcome-evidence.v1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      outcome: taskResult.status,
      claimId: String(projectResult.promotionClaim?.claimId || ""),
      claimFence: Number(projectResult.promotionClaim?.fence || 0),
      recordedAt: now,
    },
    promotionStatus: taskResult.status,
    promotionTargetBranch: projectResult.targetBranch,
    promotionUpdatedAt: now,
    promotionWorkspacePath: projectResult.workspacePath || "",
    promotionWorkspaceStrategy: projectResult.workspaceStrategy || "",
    promotionValidationSandboxPolicy: projectResult.validationSandboxPolicy || "",
    promotionValidationWorkspaceStrategy: projectResult.validationWorkspaceStrategy || "",
    promotionValidationNetworkPolicy: projectResult.validationNetworkPolicy || "",
    promotionValidationProcessPolicy: projectResult.validationProcessPolicy || null,
    promotionValidation: {
      status: projectResult.status,
      commands: projectResult.validation || [],
      evidence: projectResult.validationEvidence || null,
      omittedSummaryCount: Number(projectResult.validationOmittedSummaryCount || 0),
    },
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts,
    promotionRetryAuthorization: firstFailureAuthorization || task.promotionRetryAuthorization || null,
    promotionConflictFiles: taskResult.conflicts || [],
    promotionOperationalAttempt: Number(projectResult.promotionClaim?.operationalAttempt || 0),
    retryNotBefore: "",
    lastAutomationFailure: "",
    automationBlocker: null,
  };

  if (["pr_ready", "pr_merged_detected"].includes(taskResult.status)) {
    return {
      ...patch,
      status: "user_review",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
      promotionCommit: projectResult.commit || "",
      promotionBranch: projectResult.promotionBranch || "",
      promotionPrUrl: projectResult.prUrl || "",
    };
  }

  if (["validation_missing", "remote_policy_invalid"].includes(taskResult.status)) {
    const configurationCircuit = {
      reasonCode: taskResult.status === "validation_missing"
        ? "promotion_validation_commands_missing"
        : "promotion_remote_policy_invalid",
      attemptsConsumed: Number(projectResult.promotionClaim?.operationalAttempt || 1),
      maxAttempts: Number(projectResult.promotionClaim?.maxOperationalAttempts || 3),
      attemptSeriesDigest: projectResult.promotionClaim?.attemptSeriesDigest || "",
    };
    return {
      ...patch,
      ...promotionCircuitPatch(task, projectResult, taskResult, now, configurationCircuit),
    };
  }

  if (["evidence_failed", "auth_failed", "candidate_verification_unavailable", "validation_sandbox_unavailable", "dependency_acquisition_failed", "push_failed", "pr_failed"].includes(taskResult.status)) {
    if (projectResult.promotionClaim?.circuit?.shouldOpen) {
      return {
        ...patch,
        ...promotionCircuitPatch(task, projectResult, taskResult, now, projectResult.promotionClaim.circuit),
      };
    }
    return {
      ...patch,
      status: "promotion_blocked",
      assignedAgentRole: "promotion-worker",
      reviewerThreadId: "",
      retryNotBefore: projectResult.promotionClaim?.retryNotBefore || "",
      lastAutomationFailure: `${taskResult.status}: ${projectResult.output || "promotion failed"}`,
      promotionBranch: projectResult.promotionBranch || "",
    };
  }

  if (taskResult.status === "pr_closed") {
    return {
      ...patch,
      status: "promotion_blocked",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
      promotionBranch: projectResult.promotionBranch || "",
      promotionPrUrl: projectResult.prUrl || "",
    };
  }

  if (taskResult.status === "validation_failed") {
    const retryAuthorized = promotionValidationAttempts < MAX_PROMOTION_VALIDATION_ATTEMPTS
      && Boolean(firstFailureAuthorization || task.promotionRetryAuthorization);
    return {
      ...patch,
      status: retryAuthorized ? "approved_for_main" : "needs_changes",
      assignedAgentRole: retryAuthorized ? "promotion-worker" : "builder",
      reviewerThreadId: "",
    };
  }

  if (["conflict", "blocked"].includes(taskResult.status)) {
    return {
      ...patch,
      status: "needs_changes",
      assignedAgentRole: "builder",
      reviewerThreadId: "",
    };
  }

  if (["promotion_closed", "promotion_invalid"].includes(taskResult.status)) {
    const terminalStatus = ["merged", "deployed", "done"].includes(task.status);
    return {
      ...patch,
      status: terminalStatus ? task.status : "promotion_blocked",
      assignedAgentRole: terminalStatus ? task.assignedAgentRole || "" : "owner",
      reviewerThreadId: terminalStatus ? task.reviewerThreadId || "" : "",
      promotionPrUrl: projectResult.prUrl || "",
    };
  }

  if (taskResult.status === "dependency_blocked") {
    return {
      ...patch,
      status: "approved_for_main",
      assignedAgentRole: "promotion-worker",
      reviewerThreadId: "",
    };
  }

  return {
    ...patch,
    status: "approved_for_main",
    assignedAgentRole: "promotion-worker",
    reviewerThreadId: "",
  };
}

async function recordProjectResult(projectResult) {
  if (projectResult.status === "merged") {
    // GitHub may omit fractional seconds. Canonicalize once before binding the
    // terminal claim and writing each durable merge mirror so they cannot
    // disagree solely because equivalent ISO timestamps use different forms.
    projectResult.mergedAt = new Date(projectResult.mergedAt).toISOString();
  }
  return mutateCandidatePromotionState(projectResult.candidate?.id, projectResult.promotionClaim, async (state) => {
    const now = new Date().toISOString();
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.qaBundles = state.qaBundles || [];
    state.candidates = state.candidates || [];
    try {
      const project = (state.projects || []).find((item) => item.id === projectResult.projectId);
      if (!project) throw new Error(`Promotion project ${projectResult.projectId} no longer exists.`);
      const currentProjectPolicyDigest = contentDigest(JSON.stringify(promotionProjectPolicyBinding(project)));
      if (currentProjectPolicyDigest !== projectResult.projectPolicyDigest) {
        throw new Error("Promotion project policy changed before result recording.");
      }
      if (authoritativePromotionPolicyDigest(state, projectResult) !== projectResult.validationPolicyDigest) {
        throw new Error("Promotion validation policy changed before result recording.");
      }
      if (projectResult.reconciledByCandidateId) {
        const replacement = projectResult.promotionClaim?.reconciliationReplacement;
        if (
          !replacement
          || projectResult.reconciliationReplacementDigest
            !== projectResult.promotionClaim.reconciliationReplacementDigest
          || !isDeepStrictEqual(projectResult.reconciliationReplacement, replacement)
          || projectResult.reconciledByCandidateId !== replacement.candidateId
          || projectResult.reconciledByManifestDigest !== replacement.manifestDigest
          || projectResult.prUrl !== replacement.promotion.prUrl
          || projectResult.mergeCommit !== replacement.promotionMerge.mergeCommit
          || new Date(projectResult.mergedAt).toISOString() !== replacement.promotionMerge.mergedAt
        ) {
          throw new Error("Superseding promotion result changed after its fenced claim binding.");
        }
      }
      if (projectResult.promotionClaim) {
        projectResult.promotionClaim = terminalPromotionAttemptClaimInState(state, projectResult.promotionClaim, {
          projectId: projectResult.projectId,
          candidateId: projectResult.candidate?.id,
          mode: projectResult.mode,
          policyDigest: projectResult.validationPolicyDigest,
          projectPolicy: projectResult.projectPolicy,
          outcome: projectResult.status,
          ...(projectResult.status === "merged" ? {
            terminalResult: {
              candidateId: projectResult.candidate?.id,
              manifestDigest: projectResult.candidate?.manifestDigest,
              prUrl: projectResult.prUrl,
              mergeCommit: projectResult.mergeCommit,
              mergedAt: projectResult.mergedAt,
            },
          } : {}),
        });
      }
    } catch (error) {
      error.code = "PROMOTION_ATTEMPT_STALE";
      throw error;
    }
    const candidate = state.candidates.find((item) => item.id === projectResult.candidate?.id);
    if (!candidate) throw new Error(`Promotion result has no persisted candidate: ${projectResult.candidate?.id || "missing"}`);
    assertCandidateEnvelope(candidate);
    const boundedValidationFailure = (
      projectResult.status === "validation_failed"
      && Number(projectResult.validationAttempt || 0) >= MAX_PROMOTION_VALIDATION_ATTEMPTS
    ) ? {
      reason: "Promotion validation exhausted its bounded retry; builder changes require a new immutable QA candidate.",
      expected: candidate.manifest.integration.sha,
      observed: projectResult.validationEvidence?.digest || "validation_failed",
    } : null;
    const candidateInvalidation = projectResult.candidateInvalidation || boundedValidationFailure;
    if (candidateInvalidation) {
      invalidateCandidate(candidate, candidateInvalidation);
      const invalidatedBundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
      if (invalidatedBundle) {
        invalidatedBundle.status = "invalidated";
        invalidatedBundle.updatedAt = now;
      }
    }
    let promotedCount = 0;
    let mergedCount = 0;
    const promotedTaskIds = new Set();
    const mergedTaskIds = new Set();

    for (const taskResult of projectResult.tasks || []) {
      const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
      if (!task) continue;
      if (["pending", "reconciliation_unavailable"].includes(taskResult.status)) continue;
      if (taskResult.status === "merged") {
        const source = candidate.manifest.sources.find((item) => item.taskId === task.id);
        const terminalStatus = ["merged", "deployed", "done"].includes(task.status);
        if (terminalStatus && (task.candidateId !== candidate.id || task.reviewSubjectSha !== source?.headSha)) {
          throw new Error(`Terminal task ${task.id} does not match reconciled candidate ${candidate.id}.`);
        }
        applyPromotionLifecycleTransitionInState(state, {
          action: "record_merge",
          taskId: task.id,
          expectedStateVersion: task.stateVersion,
          actorContext: {
            actorId: "studioops-promotion-worker",
            actorType: "worker",
            role: "promotion-worker",
            trusted: true,
          },
          evidence: {
            targetStatus: terminalStatus ? task.status : "merged",
            candidateCycle: source?.candidateCycle,
            subjectSha: source?.headSha,
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
            integrationSha: candidate.manifest.integration.sha,
            mergeCommit: projectResult.mergeCommit,
            mergedAt: projectResult.mergedAt,
            prUrl: projectResult.prUrl,
            promotionClaimId: projectResult.promotionClaim?.claimId,
            promotionClaimFence: projectResult.promotionClaim?.fence,
            promotionClaimOutcome: projectResult.promotionClaim?.outcome,
          },
        }, { now });
        task.assignedAgentRole = "";
        task.reviewerThreadId = "";
        const recoveredValidationWarning = task.promotionRecovery?.validationFailure?.preserved === true
          ? structuredClone(task.promotionRecovery.validationFailure)
          : null;
        if (recoveredValidationWarning) taskResult.validationWarning = recoveredValidationWarning;
        task.promotionStatus = recoveredValidationWarning
          ? "merged_with_validation_warning"
          : "merged";
        task.promotionUpdatedAt = now;
        task.promotionEvidence = {
          schemaVersion: "studioops.promotion-outcome-evidence.v1",
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          outcome: "merged",
          claimId: String(projectResult.promotionClaim?.claimId || ""),
          claimFence: Number(projectResult.promotionClaim?.fence || 0),
          prUrl: projectResult.prUrl,
          mergeCommit: projectResult.mergeCommit,
          mergedAt: projectResult.mergedAt,
          recordedAt: now,
          ...(recoveredValidationWarning ? {
            validationWarning: recoveredValidationWarning,
          } : {}),
        };
        task.mergeEvidence = {
          id: `promotion:${candidate.id}:${task.id}`,
          subjectSha: source?.headSha || task.reviewSubjectSha || "",
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          integrationSha: candidate.manifest.integration.sha,
          mergeCommit: projectResult.mergeCommit,
          url: projectResult.prUrl,
          reconciledByCandidateId: projectResult.reconciledByCandidateId || "",
          reconciledByManifestDigest: projectResult.reconciledByManifestDigest || "",
          recordedAt: now,
        };
        task.updatedAt = now;
        mergedCount += 1;
        mergedTaskIds.add(task.id);
      } else {
        const patch = taskPatchForPromotion(projectResult, taskResult, now, task, candidate);
        const source = candidate.manifest.sources.find((item) => item.taskId === task.id);
        const opensCircuit = patch.status === "blocked" && patch.automationCircuit?.state === "open";
        applyPromotionLifecycleTransitionInState(state, {
          action: opensCircuit ? "open_promotion_circuit" : "record_promotion_outcome",
          taskId: task.id,
          expectedStateVersion: task.stateVersion,
          actorContext: {
            actorId: "studioops-promotion-worker",
            actorType: "system",
            role: "promotion-worker",
            trusted: true,
          },
          evidence: {
            targetStatus: patch.status,
            candidateCycle: source?.candidateCycle,
            subjectSha: source?.headSha,
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
            promotionOutcome: taskResult.status,
            promotionClaimId: projectResult.promotionClaim?.claimId || "",
            promotionClaimFence: projectResult.promotionClaim?.fence || 0,
            ...(opensCircuit ? {
              promotionCircuitReason: patch.automationCircuit.reasonCode || "promotion_configuration_invalid",
            } : {}),
          },
        }, { now });
        Object.assign(task, patch);
        task.updatedAt = now;
      }
      if (["pr_ready", "pr_merged_detected"].includes(taskResult.status)) {
        promotedCount += 1;
        promotedTaskIds.add(task.id);
      }
      const commentAdded = addUniqueComment(
        state,
        task.id,
        "StudioOps Promotion",
        commentForTask(projectResult, taskResult),
        now,
      );
      if (commentAdded) {
        state.events.push({
          id: nextId(state.events, "event"),
          type: `promotion_${taskResult.status}`,
          projectId: task.projectId,
          taskId: task.id,
          message: `${task.title}: promotion ${taskResult.status}`,
          createdAt: now,
        });
      }
    }

    if (promotedCount > 0) {
      const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
      const actualTaskIds = [...promotedTaskIds].sort();
      if (JSON.stringify(actualTaskIds) !== JSON.stringify(expectedTaskIds)) {
        throw new Error(`Promotion result does not exactly match candidate ${candidate.id}.`);
      }
      const bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
      if (bundle) {
        bundle.status = "release_candidate_ready";
        bundle.promotionBranch = projectResult.promotionBranch || "";
        bundle.promotionPrUrl = projectResult.prUrl || "";
        bundle.promotionCommit = projectResult.commit || "";
        bundle.promotedTaskIds = expectedTaskIds;
        bundle.promotionReadyAt = now;
        bundle.promotionNotifiedAt = "";
        bundle.notificationStatus = "";
        bundle.notificationAttempts = 0;
        bundle.notificationRetryNotBefore = "";
        bundle.updatedAt = now;
      }
      candidate.status = "release_candidate_ready";
      candidate.promotion = {
        branch: projectResult.promotionBranch || "",
        prUrl: projectResult.prUrl || "",
        commitSha: projectResult.commit || "",
        manifestDigest: candidate.manifestDigest,
        readyAt: now,
      };
      candidate.updatedAt = now;
      state.events.push({
        id: nextId(state.events, "event"),
        type: "release_candidate_ready",
        projectId: projectResult.projectId,
        taskId: "",
        message: `${projectResult.projectName || projectResult.projectKey}: release-candidate PR ready with ${promotedCount} QA-approved task(s).`,
        createdAt: now,
      });
    }
    if (mergedCount > 0) {
      const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
      const actualTaskIds = [...mergedTaskIds].sort();
      if (JSON.stringify(actualTaskIds) !== JSON.stringify(expectedTaskIds)) {
        throw new Error(`Merged promotion result does not exactly match candidate ${candidate.id}.`);
      }
      const bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
      if (bundle) {
        bundle.status = "merged";
        bundle.promotionMergedAt = projectResult.mergedAt || now;
        bundle.promotionMergeCommit = projectResult.mergeCommit || "";
        bundle.updatedAt = now;
      }
      candidate.status = "merged";
      candidate.promotionMerge = {
        mergeCommit: projectResult.mergeCommit || "",
        mergedAt: projectResult.mergedAt || now,
        reconciledAt: now,
        reconciledByCandidateId: projectResult.reconciledByCandidateId || "",
        reconciledByManifestDigest: projectResult.reconciledByManifestDigest || "",
      };
      candidate.updatedAt = now;
      state.events.push({
        id: nextId(state.events, "event"),
        type: "release_candidate_merged",
        projectId: projectResult.projectId,
        taskId: "",
        message: `${projectResult.projectName || projectResult.projectKey}: verified release-candidate merge for ${mergedCount} task(s).`,
        createdAt: now,
      });
    }
    return projectResult.promotionClaim;
  }, {
    operationName: "promotion.record_result",
    promotionRemoteObservation: projectResult.promotionRemoteObservation || null,
    promotionMergeAncestryObservation: projectResult.promotionMergeAncestryObservation || null,
  });
}

async function recordPromotionClaimCircuit(projectPlan, claimResult) {
  const observedClaim = claimResult?.claim;
  const circuit = claimResult?.circuit;
  return mutatePromotionAttemptClaimState(projectPlan.candidate.id, (state) => {
    const now = new Date().toISOString();
    const project = (state.projects || []).find((item) => item.id === projectPlan.projectId);
    if (!project) return { published: false, reason: "project_missing" };
    const currentProjectPolicy = promotionProjectPolicyBinding(project);
    if (contentDigest(JSON.stringify(currentProjectPolicy)) !== projectPlan.projectPolicyDigest) {
      return { published: false, reason: "project_policy_drift" };
    }
    let currentValidationPolicyDigest;
    try {
      currentValidationPolicyDigest = authoritativePromotionPolicyDigest(state, projectPlan);
    } catch {
      return { published: false, reason: "validation_policy_unavailable" };
    }
    if (currentValidationPolicyDigest !== projectPlan.validationPolicyDigest) {
      return { published: false, reason: "validation_policy_drift" };
    }
    const candidate = (state.candidates || []).find((item) => item.id === projectPlan.candidate.id);
    if (
      !candidate
      || candidate.status !== projectPlan.candidate.status
      || candidate.manifestDigest !== projectPlan.candidate.manifestDigest
      || !isDeepStrictEqual(candidate.qaDecision, projectPlan.candidate.qaDecision)
      || !isDeepStrictEqual(candidate.promotion || null, projectPlan.candidate.promotion || null)
      || candidate.invalidation
    ) {
      return { published: false, reason: "candidate_drift" };
    }
    const currentClaim = state.meta?.promotionAttemptClaims?.[candidate.id];
    if (!currentClaim || !isDeepStrictEqual(currentClaim, observedClaim)) {
      return { published: false, reason: "claim_drift" };
    }
    if (
      (observedClaim.policyDigest && observedClaim.policyDigest !== projectPlan.validationPolicyDigest)
      || (observedClaim.projectPolicyDigest && observedClaim.projectPolicyDigest !== projectPlan.projectPolicyDigest)
    ) {
      return { published: false, reason: "claim_policy_drift" };
    }
    const plannedTasks = new Map(projectPlan.tasks.map((task) => [task.id, task]));
    for (const source of candidate.manifest.sources) {
      const task = (state.tasks || []).find((item) => item.id === source.taskId);
      const planned = plannedTasks.get(source.taskId);
      if (
        !task
        || !planned
        || Number(task.stateVersion) !== Number(planned.stateVersion)
        || Number(task.automationAttemptEpoch || 0) !== Number(planned.automationAttemptEpoch || 0)
        || task.status !== planned.status
        || !isDeepStrictEqual(
          normalizeList(task.dependsOnTaskIds).sort(),
          normalizeList(planned.dependsOnTaskIds).sort(),
        )
        || !isDeepStrictEqual(
          [...new Set(normalizeList(task.dependsOnTaskIds))].sort().map((dependencyId) => {
            const dependency = (state.tasks || []).find((item) => item.id === dependencyId);
            return dependency ? {
              taskId: dependency.id,
              projectId: dependency.projectId,
              status: String(dependency.status || ""),
              stateVersion: Number(dependency.stateVersion || 1),
            } : {
              taskId: dependencyId,
              projectId: "",
              status: "missing",
              stateVersion: 0,
            };
          }),
          planned.dependencyBindings || [],
        )
        || task.candidateId !== candidate.id
        || task.qaBundleId !== candidate.qaBundleId
        || String(task.reviewSubjectSha || "").toLowerCase() !== source.headSha
        || Number(task.reviewSubjectCycle) !== Number(source.candidateCycle)
      ) {
        return { published: false, reason: `task_drift:${source.taskId}` };
      }
    }
    for (const source of candidate.manifest.sources) {
      const task = (state.tasks || []).find((item) => item.id === source.taskId);
      const taskResult = { status: "claim_circuit_open", output: circuit.reasonCode || "promotion claim circuit" };
      const projectResult = {
        ...projectPlan,
        status: "claim_circuit_open",
        output: circuit.reasonCode || "Promotion claim circuit opened.",
        promotionClaim: { ...projectPlan.promotionClaim, circuit },
      };
      const circuitPatch = promotionCircuitPatch(task, projectResult, taskResult, now, circuit);
      applyPromotionLifecycleTransitionInState(state, {
        action: "open_promotion_circuit",
        taskId: task.id,
        expectedStateVersion: task.stateVersion,
        actorContext: {
          actorId: "studioops-promotion-worker",
          actorType: "system",
          role: "promotion-worker",
          trusted: true,
        },
        evidence: {
          targetStatus: "blocked",
          candidateCycle: source.candidateCycle,
          subjectSha: source.headSha,
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          promotionClaimId: observedClaim.claimId || "",
          promotionClaimFence: observedClaim.fence || 0,
          promotionCircuitReason: circuit.reasonCode || "",
        },
      }, { now });
      Object.assign(task, {
        promotionStatus: "claim_circuit_open",
        promotionUpdatedAt: now,
        ...circuitPatch,
      });
      task.updatedAt = now;
      addUniqueComment(
        state,
        task.id,
        "StudioOps Promotion",
        `Automatic promotion stopped after its bounded attempt budget was exhausted. The exact QA candidate is preserved. ${task.automationCircuit.resumeAction}`,
        now,
      );
      state.events = state.events || [];
      state.events.push({
        id: nextId(state.events, "event"),
        type: "promotion_circuit_opened",
        projectId: task.projectId,
        taskId: task.id,
        message: `${task.title}: bounded promotion recovery circuit opened`,
        createdAt: now,
      });
    }
    if (circuit?.reasonCode === "promotion_claim_schema_unsupported") {
      return removeUnsupportedPromotionClaimAfterCircuitInState(
        state,
        candidate.id,
        claimResult,
        { circuitOpenedAt: now },
      );
    }
    return { published: true, circuitOpenedAt: now };
  }, {
    operationName: "promotion.open_claim_circuit",
  });
}

function candidateHasStrandedMergedAdmission(state, candidate) {
  if (
    candidate?.status !== "release_candidate_ready"
    || candidate.invalidation
    || candidate.promotionMerge
    || !candidate.promotion
  ) return false;
  const tasksById = new Map((state.tasks || []).map((task) => [task.id, task]));
  return candidate.manifest.sources.some((source) => {
    const task = tasksById.get(source.taskId);
    return Boolean(
      task
      && task.status === "needs_changes"
      && task.assignedAgentRole === "builder"
      && task.promotionStatus === "validation_failed"
      && task.candidateId === candidate.id
      && task.qaBundleId === candidate.qaBundleId
      && task.promotionPrUrl === candidate.promotion.prUrl
      && task.promotionBranch === candidate.promotion.branch,
    );
  });
}

/**
 * Heal the known crash/race window where a merged release PR was followed by
 * a stale validation-failure write. The first read only restores safe claimed
 * reconciliation admission; ordinary v4 claim and merge reconciliation still
 * own the terminal state change.
 */
export async function reconcileMergedPromotionAdmissions(input = {}) {
  const state = await readState();
  const candidateFilter = normalizeList(input.candidate || input.candidates || input.candidateId);
  const taskFilter = normalizeList(input.task || input.tasks || input.taskId);
  const projectsById = new Map((state.projects || []).map((project) => [project.id, project]));
  const candidates = (state.candidates || [])
    .filter((candidate) => candidateHasStrandedMergedAdmission(state, candidate))
    .filter((candidate) => !candidateFilter.length || candidateFilter.includes(candidate.id))
    .filter((candidate) => (
      !taskFilter.length
      || candidate.manifest.sources.some((source) => taskFilter.includes(source.taskId))
    ))
    .filter((candidate) => {
      const project = projectsById.get(candidate.projectId);
      return project && projectMatches(project, input);
    });
  const recoveries = [];
  for (const candidate of candidates) {
    const project = projectsById.get(candidate.projectId);
    const authPlan = {
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      repoPath: project.repoPath,
      repoUrl: project.repoUrl,
    };
    let authContext = null;
    try {
      authContext = await preparePromotionAuth(authPlan, input);
      const authority = mergedPromotionRecoveryAuthorityForState(state, candidate);
      const inspection = await inspectMergedPromotionRecovery(authority, {
        githubToken: authContext?.token || input.githubToken || "",
        testGitHubApi: input.testGitHubApi,
        secrets: normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext)),
        nowMs: input.nowMs,
      });
      if (inspection.status !== "exact_merged") {
        recoveries.push({
          candidateId: candidate.id,
          projectId: candidate.projectId,
          status: inspection.status,
          reason: truncateOutput(inspection.reason || "Merged release PR was not exactly verified."),
        });
        continue;
      }
      const recovered = await recoverMergedPromotionAdmissionState(
        candidate.id,
        inspection.remoteObservation,
      );
      recoveries.push({
        candidateId: candidate.id,
        projectId: candidate.projectId,
        status: recovered.repaired ? "recovered" : "already_safe",
        taskIds: recovered.taskIds || [],
        prUrl: inspection.pr.url,
        mergeCommit: inspection.pr.mergeCommit,
        mergedAt: inspection.pr.mergedAt,
      });
    } catch (error) {
      recoveries.push({
        candidateId: candidate.id,
        projectId: candidate.projectId,
        status: "unavailable",
        reason: truncateOutput(redactSecrets(error.message, normalizeSecrets(
          input.secrets,
          githubAppAuthSecrets(authContext),
        ))),
      });
    } finally {
      await cleanupGitHubAppAuth(authContext);
    }
  }
  return recoveries;
}

export async function runPromotion(input = {}) {
  const qaRevocations = input.dryRun || input.plan
    ? []
    : await reconcilePendingQaRevocations(input, input.qaRevocationTestDependencies || null);
  const mergedAdmissionRecoveries = input.dryRun || input.plan
    ? []
    : await reconcileMergedPromotionAdmissions(input);
  const state = await readState();
  const plan = planPromotions(state, input);

  if (input.dryRun || input.plan) {
    return plan;
  }

  const results = [];
  for (const plannedProject of plan.projects) {
    if (!plannedProject.tasks.length && !plannedProject.blockedTasks.length) continue;
    let projectPlan = plannedProject;
    if (!projectPlan.enabled || projectPlan.dependencyBlocked) {
      results.push(await promoteProject(projectPlan, input));
      continue;
    }
    let claimed;
    try {
      claimed = await claimProjectPromotionAttempt(projectPlan, input);
    } catch (error) {
      results.push({
        ...projectPlan,
        status: "claim_unavailable",
        output: truncateOutput(`Promotion claim rejected authoritative state drift: ${error.message}`),
        tasks: allTaskResults(projectPlan.tasks, "claim_unavailable", error.message),
        validation: [],
        validationEvidence: null,
      });
      continue;
    }
    if (!claimed.acquired) {
      if (["attempt_budget_exhausted", "claim_schema_unsupported"].includes(claimed.reason)) {
        if (input.beforePromotionCircuitPublication) {
          await input.beforePromotionCircuitPublication({
            projectPlan,
            claim: claimed.claim,
            circuit: claimed.circuit,
          });
        }
        const published = await recordPromotionClaimCircuit(projectPlan, claimed);
        if (!published.published) {
          const output = `Promotion circuit observation became stale before publication (${published.reason}); newer workflow state was preserved.`;
          results.push({
            ...projectPlan,
            status: "claim_stale",
            output,
            tasks: allTaskResults(projectPlan.tasks, "claim_stale", output),
            validation: [],
            validationEvidence: null,
            promotionClaim: claimed.claim,
          });
          continue;
        }
      }
      const status = claimed.reason === "retry_deferred"
        ? "claim_retry_deferred"
        : ["attempt_budget_exhausted", "claim_schema_unsupported"].includes(claimed.reason)
          ? "claim_circuit_open"
          : claimed.reason === "terminal"
            ? "claim_terminal"
            : "claim_busy";
      const output = claimed.reason === "retry_deferred"
        ? `Automatic promotion retry is deferred until ${claimed.retryNotBefore}.`
        : status === "claim_circuit_open"
          ? `Automatic promotion is stopped by ${claimed.circuit?.reasonCode || "a bounded recovery circuit"}.`
          : claimed.reason === "terminal"
            ? "This exact promotion attempt already reached a non-replayable terminal outcome."
            : "Another fenced promotion attempt already owns this immutable candidate.";
      results.push({
        ...projectPlan,
        status,
        output,
        tasks: allTaskResults(projectPlan.tasks, status, output),
        validation: [],
        validationEvidence: null,
        retryNotBefore: claimed.retryNotBefore || "",
        promotionClaim: claimed.claim,
      });
      continue;
    }
    projectPlan = {
      ...projectPlan,
      promotionClaim: claimed.claim,
      promotionRecoveryReceipt: claimed.receipt || null,
    };
    try {
      await assertProjectPromotionAttempt(projectPlan, projectPlan.promotionClaim, input);
    } catch (error) {
      results.push({
        ...projectPlan,
        status: "claim_unavailable",
        output: truncateOutput(`Promotion authority changed before authentication: ${error.message}`),
        tasks: allTaskResults(projectPlan.tasks, "claim_unavailable", error.message),
        validation: [],
        validationEvidence: null,
      });
      continue;
    }
    let authContext = null;
    let result = null;
    let promotionOptions = input;
    try {
      authContext = await preparePromotionAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      promotionOptions = {
        ...input,
        env: { ...(input.env || {}) },
        githubToken: authContext?.token || "",
        gitAuthEnv: authContext ? {
          GIT_ASKPASS: authContext.askpassPath,
          MISSION_CONTROL_GITHUB_TOKEN: authContext.token,
          MISSION_CONTROL_GIT_USERNAME: "x-access-token",
        } : {},
        secrets,
        beforeValidationCommand: projectPlan.promotionClaim
          ? async () => {
              const renewed = await renewProjectPromotionAttempt(projectPlan, projectPlan.promotionClaim, input);
              projectPlan.promotionClaim = renewed;
              return renewed;
            }
          : null,
        renewPromotionClaim: projectPlan.promotionClaim
          ? async () => {
              const renewed = await renewProjectPromotionAttempt(projectPlan, projectPlan.promotionClaim, input);
              projectPlan.promotionClaim = renewed;
              return renewed;
            }
          : null,
        assertPromotionClaim: projectPlan.promotionClaim
          ? async () => assertProjectPromotionAttempt(projectPlan, projectPlan.promotionClaim, input)
          : null,
        recordRecoveryReceipt: projectPlan.promotionClaim
          ? async (validationResults, validationEvidence) => {
              const recorded = await recordProjectPromotionRecoveryReceipt(
                projectPlan,
                projectPlan.promotionClaim,
                validationResults,
                validationEvidence,
                input,
              );
              projectPlan.promotionClaim = recorded.claim;
              projectPlan.promotionRecoveryReceipt = recorded.receipt;
              return recorded;
            }
          : null,
        bindReconciliationReplacement: projectPlan.promotionClaim
          ? async (replacement) => {
              const bound = await bindProjectPromotionReconciliationReplacement(
                projectPlan,
                projectPlan.promotionClaim,
                replacement,
                input,
              );
              projectPlan.promotionClaim = bound;
              return bound;
            }
          : null,
      };
      result = projectPlan.mode === "reconcile"
        ? await reconcilePromotionProject(projectPlan, promotionOptions)
        : await promoteProject(projectPlan, promotionOptions);
    } catch (error) {
      result = authFailureProjectResult(projectPlan, error);
    }
    try {
      try {
        await recordProjectResult(result);
      } catch (error) {
        if (error.code !== "PROMOTION_ATTEMPT_STALE") throw error;
        const cleanup = await closeStalePromotionPullRequest(result, promotionOptions);
        result.status = "stale_result_discarded";
        result.stalePromotionPrCleanup = cleanup;
        result.output = truncateOutput([
          `Promotion result was discarded without overwriting newer state: ${error.message}`,
          cleanup.attempted
            ? cleanup.closed
              ? "The exact stale release-candidate PR was closed."
              : `StudioOps could not close the exact stale release-candidate PR: ${cleanup.output}`
            : "No external release-candidate PR required cleanup.",
        ].join("\n"));
        result.tasks = allTaskResults(projectPlan.tasks, "stale_result_discarded", result.output);
      }
    } finally {
      await cleanupGitHubAppAuth(authContext);
    }
    results.push(result);
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: false,
    qaRevocations,
    mergedAdmissionRecoveries,
    projects: results,
    taskCount: results.reduce((count, project) => count + (project.tasks || []).length, 0),
  };
}

export function formatPromotionReport(report) {
  const lines = [
    `StudioOps promotion sweep (${report.generatedAt})${report.dryRun ? " DRY RUN" : ""}`,
    `Projects: ${(report.projects || []).length}  Tasks: ${report.taskCount || 0}`,
    "",
  ];

  if (!report.projects?.length) {
    lines.push("No projects matched.");
    return lines.join("\n");
  }

  for (const project of report.projects) {
    lines.push(`[${project.projectKey}] ${project.projectName || project.projectKey}`);
    lines.push(`  Target branch: ${project.targetBranch || "(not configured)"}`);
    if (project.workspacePath) {
      const strategy = project.workspaceStrategy ? ` (${project.workspaceStrategy})` : "";
      lines.push(`  Workspace: ${project.workspacePath}${strategy}`);
    }
    if (!project.enabled) lines.push(`  Skipped: ${project.skipReason || project.output || "not enabled"}`);
    else if (project.status) lines.push(`  Status: ${project.status}`);
    if (project.output) lines.push(`  Note: ${project.output}`);
    for (const task of project.tasks || []) {
      const taskId = task.taskId || task.id;
      lines.push(`  - ${taskId}: ${task.status || "pending"} ${task.title || ""}`.trimEnd());
      if (task.conflicts?.length) lines.push(`    Conflicts: ${task.conflicts.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
