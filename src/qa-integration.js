import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  branchWebUrl,
  integrationBranchName,
  integrationBranchSafetyError,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "./integration-policy.js";
import {
  cleanupGitHubAppAuth,
  githubAppAuthEnv,
  githubAppAuthSecrets,
  prepareGitHubAppAuth,
  redactSecrets,
} from "./github-app-auth.js";
import {
  candidateReviewEvidenceForTask,
  mutateState,
  readState,
} from "./store.js";
import { buildOwnerQaPacket, candidateCompletenessGate } from "./owner-qa-packet.js";
import { enqueueOwnerQaNotificationsInState } from "./notifier.js";
import {
  canonicalJson,
  createCandidateEnvelope,
  invalidateCandidate,
  normalizeGitSha,
} from "./candidate-manifest.js";
import {
  createCandidateRepositoryTestGitRunner,
  equivalentGitHubOriginSlug,
  verifyCandidateRepositoryState,
} from "./candidate-repository.js";
import { defaultStudioOpsWorkspaceRoot } from "./runtime-paths.js";
import {
  cleanupProjectValidationSandbox,
  DEFAULT_PROJECT_VALIDATION_PATH,
  prepareProjectValidationSandbox,
  prepareProjectValidationDependencies,
  installPreparedProjectValidationDependencies,
  PROJECT_VALIDATION_SANDBOX_POLICY_ID,
  runProjectValidationCommand,
  verifyProjectValidationSandbox,
} from "./project-validation-sandbox.js";
import { redactPromotionValidationText } from "./promotion-validation-evidence.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
  registerIsolatedTestAdapter,
} from "./test-authority-realm.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_QA_RETRY_DELAY_MS = 15 * 60_000;
const QA_ATTEMPT_TTL_MS = 30 * 60_000;
const DEFAULT_PREVIEW_HEALTH_ATTEMPTS = 90;
const MAX_PREVIEW_HEALTH_ATTEMPTS = 120;
const DEFAULT_PREVIEW_HEALTH_RETRY_DELAY_MS = 1_000;
const DEFAULT_QA_WORKSPACE_ROOT = defaultStudioOpsWorkspaceRoot("qa");
const DEFAULT_QA_INTEGRATION_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const QA_OUTER_TEST_VALIDATION_PATH_ROOTS = [
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
  "/private/var/db/timezone",
];
const QA_ATTEMPT_CLAIM_SCHEMA_VERSION = "studioops.qa-integration-attempt-claim.v1";

let trustedGitValidation = null;
const qaIntegrationTestAuthority = consumeIsolatedTestAuthority((capability) => capability);

function requireQaIntegrationTestAuthority() {
  if (!qaIntegrationTestAuthority) {
    throw new Error("QA integration test authority is unavailable.");
  }
  assertCurrentIsolatedTestAuthority(qaIntegrationTestAuthority);
  return qaIntegrationTestAuthority;
}

function childEnv(options = {}) {
  return {
    ...process.env,
    PATH: options.path || process.env.MISSION_CONTROL_QA_INTEGRATION_PATH || DEFAULT_QA_INTEGRATION_PATH,
    ...(options.env || {}),
  };
}

const PROJECT_COMMAND_CREDENTIAL_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_TERMINAL_PROMPT",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

function projectCommandEnv(options = {}) {
  const env = childEnv(options);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      PROJECT_COMMAND_CREDENTIAL_KEYS.has(upper)
      || upper.startsWith("MISSION_CONTROL_GITHUB_")
      || upper === "MISSION_CONTROL_GIT_USERNAME"
      || upper.startsWith("STUDIOOPS_GITHUB_")
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)
      || /^GH_(?:ENTERPRISE_)?TOKEN$/.test(upper)
      || /^GITHUB_(?:APP|AUTH|INSTALLATION|PRIVATE_KEY|TOKEN)/.test(upper)
    ) {
      delete env[key];
    }
  }
  return env;
}

function nextId(items, prefix) {
  const max = (items || [])
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.slice(`${prefix}_`.length)))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateOutput(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]`;
}

function normalizeSecrets(...values) {
  const secrets = [];
  for (const value of values) {
    if (Array.isArray(value)) secrets.push(...value);
    else if (value) secrets.push(value);
  }
  return [...new Set(secrets.map(String).filter(Boolean))];
}

function redactCommandOutput(value, options = {}) {
  return redactSecrets(value, normalizeSecrets(options.secrets));
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
  const raw = String(value || DEFAULT_QA_WORKSPACE_ROOT);
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function prNumberFromUrl(value) {
  const match = String(value || "").match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  return match ? match[1] : "";
}

function protectedBranchPushRejected(result) {
  const output = String(result?.output || "").toLowerCase();
  return [
    "gh006: protected branch update failed",
    "gh013: repository rule violations found",
    "protected branch hook declined",
    "changes must be made through a pull request",
    "must be made through a pull request",
    "cannot push to protected branch",
    "protected branch",
  ].some((pattern) => output.includes(pattern));
}

function integrationCandidateBranchName(projectPlan, commit) {
  const configured = normalizeBranchName(
    qaIntegrationConfig(projectPlan).protectedBranchCandidatePrefix
      || qaIntegrationConfig(projectPlan).candidateBranchPrefix
      || "studioops/qa-candidate",
  ).replace(/\/+$/, "");
  const projectSegment = workspaceSegment(projectPlan.projectKey || projectPlan.projectId);
  return `${configured}/${projectSegment}-${String(commit || "").slice(0, 12)}`;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(String(result.stdout || result.output || "").trim() || "null");
  } catch {
    throw new Error(`${label} returned invalid JSON: ${truncateOutput(result.output)}`);
  }
}

function integrationPrCheckState(pr) {
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const failedConclusions = new Set([
    "ACTION_REQUIRED",
    "CANCELLED",
    "ERROR",
    "FAILURE",
    "STALE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
  ]);
  const failed = checks.filter((check) => failedConclusions.has(String(check.conclusion || check.state || "").toUpperCase()));
  const pending = checks.filter((check) => {
    const conclusion = String(check.conclusion || check.state || "").toUpperCase();
    const status = String(check.status || "").toUpperCase();
    return !failedConclusions.has(conclusion)
      && (["", "EXPECTED", "PENDING"].includes(conclusion) || (status && status !== "COMPLETED"));
  });
  const state = failed.length ? "failed" : pending.length || !checks.length ? "pending" : "passed";
  return {
    state,
    total: checks.length,
    passed: checks.length - failed.length - pending.length,
    pending: pending.length,
    failed: failed.length,
    checks: checks.map((check) => ({
      name: check.name || check.context || check.workflowName || "unnamed check",
      status: check.status || "",
      conclusion: check.conclusion || check.state || "",
      detailsUrl: check.detailsUrl || check.targetUrl || "",
    })),
  };
}

function integrationPrBlocker(pr, checkState) {
  const state = String(pr?.state || "").toUpperCase();
  const reviewDecision = String(pr?.reviewDecision || "").toUpperCase();
  if (state === "MERGED") return "";
  if (state === "CLOSED") return "The integration PR was closed without merging. Reopen it or authorize a new validated candidate.";
  if (checkState.state === "failed") {
    return `${checkState.failed} reported integration check(s) failed. Inspect the PR checks, update the source PR, and rerun QA integration after review.`;
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "The integration PR has requested changes. Resolve the review findings without bypassing the protected-branch policy.";
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return "The integration PR is waiting for its required human review.";
  }
  if (checkState.state === "pending") {
    return checkState.total
      ? `${checkState.pending} integration check(s) are still pending.`
      : "The integration PR is waiting for the repository to report required checks.";
  }
  return "All reported checks passed; the protected branch still requires the pull request to be merged by an authorized human.";
}

function integrationPrStatus(pr, checkState) {
  const state = String(pr?.state || "").toUpperCase();
  const reviewDecision = String(pr?.reviewDecision || "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "pr_closed";
  if (checkState.state === "failed") return "checks_failed";
  if (reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  return "pr_waiting";
}

function exactIntegrationPrIdentity(pr, projectPlan, candidateBranch, repository) {
  const number = Number(pr?.number || 0);
  let parsed;
  try {
    parsed = new URL(String(pr?.url || ""));
  } catch {
    return false;
  }
  return Number.isSafeInteger(number)
    && number > 0
    && parsed.protocol === "https:"
    && parsed.hostname.toLowerCase() === "github.com"
    && parsed.pathname.replace(/\/$/, "").toLowerCase() === `/${repository}/pull/${number}`.toLowerCase()
    && String(pr?.baseRefName || "") === String(projectPlan.integrationBranch || "")
    && String(pr?.headRefName || "") === String(candidateBranch || "")
    && String(pr?.headRepository?.nameWithOwner || "").toLowerCase() === repository.toLowerCase();
}

async function findIntegrationPr(repoPath, projectPlan, candidateBranch, options = {}) {
  const repository = githubRepositorySlug(projectPlan.repoUrl);
  if (!repository) throw qaRemotePolicyError("QA integration requires an exact GitHub owner/repository URL for PR inspection.");
  const result = await runCommand("gh", [
    "pr",
    "list",
    "--repo",
    repository,
    "--base",
    projectPlan.integrationBranch,
    "--head",
    candidateBranch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    "number,url,state,headRefName,headRefOid,headRepository,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit",
  ], {
    cwd: repoPath,
    env: options.env,
    secrets: options.secrets,
    timeoutMs: 60_000,
    allowFailure: true,
  });
  if (!result.ok) {
    throw new Error(`Could not inspect the integration pull request: ${truncateOutput(result.output)}`);
  }
  const prs = parseJsonOutput(result, "gh pr list");
  if (!Array.isArray(prs)) throw new Error("gh pr list did not return a pull request list.");
  return prs.filter((pr) => exactIntegrationPrIdentity(pr, projectPlan, candidateBranch, repository)).sort((a, b) => {
    const rank = (pr) => ({ OPEN: 0, MERGED: 1, CLOSED: 2 }[String(pr.state || "").toUpperCase()] ?? 3);
    return rank(a) - rank(b) || Number(b.number || 0) - Number(a.number || 0);
  })[0] || null;
}

async function createIntegrationPr(repoPath, projectPlan, candidateBranch, commit, options = {}) {
  const repository = githubRepositorySlug(projectPlan.repoUrl);
  await guardQaExternalMutation(repoPath, projectPlan, options, "create_integration_pr");
  const taskList = projectPlan.tasks
    .map((task) => `- ${task.id}: ${task.title}${task.prUrl ? ` (${task.prUrl})` : ""} at ${task.expectedHeadSha}`)
    .join("\n");
  const result = await runCommand("gh", [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    projectPlan.integrationBranch,
    "--head",
    candidateBranch,
    "--title",
    `StudioOps QA integration: ${projectPlan.projectName || projectPlan.projectKey}`,
    "--body",
    `## Validated StudioOps QA candidate\n\nCandidate commit: ${commit}\nTarget QA branch: ${projectPlan.integrationBranch}\n\n## Included tasks\n\n${taskList}\n\nStudioOps will track this PR but will not bypass required reviews, checks, or branch policy. Production deployment is not authorized by this PR.`,
  ], {
    cwd: repoPath,
    env: options.env,
    secrets: options.secrets,
    timeoutMs: 60_000,
    allowFailure: true,
  });
  if (!result.ok) {
    throw new Error(`Candidate branch was pushed, but its integration pull request could not be created: ${truncateOutput(result.output)}`);
  }
}

async function ensureIntegrationPr(repoPath, projectPlan, candidateBranch, commit, options = {}) {
  let pr = await findIntegrationPr(repoPath, projectPlan, candidateBranch, options);
  if (!pr) {
    await createIntegrationPr(repoPath, projectPlan, candidateBranch, commit, options);
    pr = await findIntegrationPr(repoPath, projectPlan, candidateBranch, options);
  }
  if (!pr) throw new Error("The integration pull request could not be found after creation.");
  if (String(pr.headRefOid || "").toLowerCase() !== String(commit || "").toLowerCase()) {
    const error = new Error(
      `Integration PR head drift: expected ${commit}, observed ${pr.headRefOid || "missing"}. StudioOps will not mutate this pull request.`,
    );
    error.code = "QA_CANDIDATE_DRIFT";
    throw error;
  }
  const checkState = integrationPrCheckState(pr);
  return {
    ...pr,
    checkState,
    blocker: integrationPrBlocker(pr, checkState),
    workflowStatus: integrationPrStatus(pr, checkState),
  };
}

async function closeIntegrationPr(repoPath, projectPlan, pr, reason, options = {}) {
  const prNumber = Number(pr?.number || 0);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    return {
      ok: false,
      output: "The obsolete integration PR has no valid number, so StudioOps could not close it safely.",
    };
  }
  const repository = githubRepositorySlug(projectPlan.repoUrl);
  if (!exactIntegrationPrIdentity(pr, projectPlan, pr.headRefName, repository)) {
    return {
      ok: false,
      output: "The obsolete integration PR identity does not exactly match the configured GitHub repository.",
    };
  }
  await guardQaExternalMutation(repoPath, projectPlan, options, "close_integration_pr");
  const close = await runCommand("gh", [
    "pr",
    "close",
    String(prNumber),
    "--repo",
    repository,
    "--comment",
    reason,
  ], {
    cwd: repoPath,
    env: options.env,
    secrets: options.secrets,
    timeoutMs: 60_000,
    allowFailure: true,
  });
  if (!close.ok) {
    return {
      ok: false,
      output: `Could not close obsolete integration PR ${pr.url || `#${prNumber}`}: ${truncateOutput(close.output)}`,
    };
  }
  const verified = await findIntegrationPr(repoPath, projectPlan, pr.headRefName, options);
  if (
    !verified
    || Number(verified.number || 0) !== prNumber
    || String(verified.state || "").toUpperCase() !== "CLOSED"
  ) {
    return {
      ok: false,
      output: `Integration PR ${pr.url || `#${prNumber}`} did not report CLOSED after the supersession request. StudioOps will not publish a competing candidate.`,
    };
  }
  return {
    ok: true,
    pr: verified,
    output: truncateOutput(close.output),
  };
}

function sourceLabel(task) {
  return task.prUrl || task.branchName || "unlinked PR";
}

function booleanOption(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function qaIntegrationConfig(projectPlan) {
  return projectPlan.qaIntegration || {};
}

function localQaPreviewConfig(projectPlan) {
  const config = projectPlan.localQaPreview
    || qaIntegrationConfig(projectPlan).localPreview
    || qaIntegrationConfig(projectPlan).localQaPreview
    || {};
  const enabled = booleanOption(config.enabled, false);
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    checkoutPath: resolveWorkspaceRoot(config.checkoutPath || config.path || projectPlan.repoPath),
    branch: normalizeBranchName(projectPlan.candidateBranch || config.branch || projectPlan.integrationBranch),
    createIfMissing: booleanOption(config.createIfMissing, false),
    stashDirty: booleanOption(config.stashDirty, false),
    postUpdateCommands: normalizeList(config.postUpdateCommands || config.commands),
    restartLaunchAgents: normalizeList(config.restartLaunchAgents || config.agents),
    launchAgentPlists: config.launchAgentPlists || {},
    previewUrl: String(config.previewUrl || config.url || "").trim(),
    healthCheckUrl: String(config.healthCheckUrl || config.healthUrl || config.previewUrl || config.url || "").trim(),
    identityHeader: String(config.identityHeader || "x-studioops-commit").trim().toLowerCase(),
    identityJsonField: String(config.identityJsonField || "commitSha").trim(),
  };
}

function localPreviewFailed(preview) {
  return [
    "blocked",
    "post_update_failed",
    "restart_failed",
    "health_check_failed",
    "identity_check_missing",
    "identity_mismatch",
  ].includes(preview?.status);
}

function syncDefaultBranchEnabled(projectPlan) {
  const config = qaIntegrationConfig(projectPlan);
  return booleanOption(
    config.syncDefaultBranchIntoIntegration ?? config.syncDefaultBranch,
    false,
  );
}

function isGitHubRepoUrl(value) {
  return Boolean(githubRepositorySlug(value));
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

function qaIntegrationAuthEnabled(projectPlan, input = {}) {
  return booleanOption(
    input.githubAppAuth ?? process.env.MISSION_CONTROL_QA_GITHUB_APP_AUTH,
    isGitHubRepoUrl(projectPlan.repoUrl),
  );
}

async function prepareQaIntegrationAuth(projectPlan, input = {}) {
  if (!qaIntegrationAuthEnabled(projectPlan, input)) return null;
  const role = input.githubAppRole || input.githubAppAuthRole || "qa-integration-worker";
  return prepareGitHubAppAuth(
    {
      id: `qa_${projectPlan.projectId || projectPlan.projectKey || "project"}`,
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

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.replaceEnv
        ? { ...(options.env || {}) }
        : options.projectCommand
          ? projectCommandEnv(options)
          : childEnv(options),
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
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
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

async function validateTrustedGitExecutable() {
  if (!trustedGitValidation) {
    trustedGitValidation = (async () => {
      const resolved = await realpath(TRUSTED_GIT_EXECUTABLE).catch(() => "");
      if (resolved !== TRUSTED_GIT_EXECUTABLE) {
        throw new Error("QA integration requires the system /usr/bin/git executable.");
      }
      const info = await lstat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error("The QA integration Git executable has unsafe ownership or permissions.");
      }
      return resolved;
    })().catch((error) => {
      trustedGitValidation = null;
      throw error;
    });
  }
  return trustedGitValidation;
}

function testGitRunner(options = {}) {
  const adapter = options.testGitRunner;
  if (!adapter) return null;
  const runner = isolatedTestAdapterRun(adapter, "candidate-repository-git");
  if (!runner) {
    throw new Error("QA integration test Git runner was rejected outside its isolated test capability.");
  }
  return runner;
}

export function createQaTestGitRunner(remotePath, repositoryUrl = "https://github.com/example/demo") {
  requireQaIntegrationTestAuthority();
  return createCandidateRepositoryTestGitRunner(remotePath, repositoryUrl);
}

function withQaTestAdapters(input = {}) {
  if (process.env.NODE_ENV !== "test" || process.env.STUDIOOPS_TEST_ISOLATION !== "1") return input;
  const adapted = { ...input };
  const remotePath = String(process.env.STUDIOOPS_QA_TEST_REMOTE_PATH || "");
  if (!adapted.testGitRunner && remotePath) {
    adapted.testGitRunner = createQaTestGitRunner(
      remotePath,
      String(process.env.STUDIOOPS_QA_TEST_REPOSITORY_URL || "https://github.com/example/demo"),
    );
  }
  if (remotePath && adapted.githubAppAuth === undefined) adapted.githubAppAuth = false;
  if (
    !adapted.projectValidationSandboxAdapter
    && process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX === PROJECT_VALIDATION_SANDBOX_POLICY_ID
  ) {
    adapted.projectValidationSandboxAdapter = createQaOuterSandboxTestAdapter();
  }
  return adapted;
}

function git(repoPath, args, options = {}) {
  const trustedArgs = [
    "--no-replace-objects",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "push.gpgSign=false",
    ...args,
  ];
  const execute = async (effectiveArgs = trustedArgs) => {
    await validateTrustedGitExecutable();
    return runCommand(TRUSTED_GIT_EXECUTABLE, effectiveArgs, {
      cwd: repoPath || "/",
      timeoutMs: options.timeoutMs,
      allowFailure: options.allowFailure,
      secrets: options.secrets,
      replaceEnv: true,
      env: trustedGitEnvironment(options),
    });
  };
  const runner = testGitRunner(options);
  return runner
    ? runner({ executable: TRUSTED_GIT_EXECUTABLE, repoPath, args: trustedArgs, execute })
    : execute();
}

function qaGitOptions(options = {}, overrides = {}) {
  return {
    gitAuthEnv: options.gitAuthEnv,
    testGitRunner: options.testGitRunner,
    secrets: options.secrets,
    ...overrides,
  };
}

function qaRemotePolicyError(message) {
  const error = new Error(message);
  error.code = "QA_REMOTE_POLICY";
  return error;
}

async function qaRemotePolicy(repoPath, projectPlan, options = {}) {
  const localInspectionOptions = { ...options, gitAuthEnv: undefined };
  const configuredUrl = String(projectPlan.repoUrl || "").trim();
  const expectedRepository = githubRepositorySlug(configuredUrl).toLowerCase();
  if (!expectedRepository) {
    throw qaRemotePolicyError(
      "QA integration requires a configured canonical GitHub repository URL before any workspace or remote side effect.",
    );
  }
  const fetch = await git(
    repoPath,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"],
    qaGitOptions(localInspectionOptions, { allowFailure: true }),
  );
  const push = await git(
    repoPath,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.pushurl"],
    qaGitOptions(localInspectionOptions, { allowFailure: true }),
  );
  const localKeys = await git(
    repoPath,
    ["config", "--local", "--no-includes", "--name-only", "--list"],
    qaGitOptions(localInspectionOptions, { allowFailure: true }),
  );
  if (!fetch.ok && Number(fetch.error?.code) !== 1) {
    throw qaRemotePolicyError(
      `QA integration could not safely inspect the origin fetch URL: ${truncateOutput(fetch.output)}`,
    );
  }
  if (!push.ok && Number(push.error?.code) !== 1) {
    throw qaRemotePolicyError(
      `QA integration could not safely inspect the origin push URL: ${truncateOutput(push.output)}`,
    );
  }
  if (!localKeys.ok) throw qaRemotePolicyError("QA integration could not safely inspect local Git configuration.");
  const unsafeKey = localKeys.stdout.split("\n").map((item) => item.trim().toLowerCase()).find((key) => (
    key.startsWith("include.")
    || (key.startsWith("url.") && (key.endsWith(".insteadof") || key.endsWith(".pushinsteadof")))
    || /^remote\.origin\.(?:mirror|proxy|uploadpack|receivepack|vcs)$/.test(key)
    || key === "http.proxy"
    || key.startsWith("http.")
    || key.startsWith("https.")
    || key.startsWith("credential.")
    || key === "core.gitproxy"
    || key === "core.sshcommand"
    || key === "core.worktree"
    || key === "core.askpass"
    || key === "core.alternaterefscommand"
    || key === "core.editor"
    || key === "core.excludesfile"
    || key === "core.hookspath"
    || key === "core.pager"
    || key.startsWith("filter.")
    || key.startsWith("diff.")
    || (key.startsWith("merge.") && key.endsWith(".driver"))
    || key.startsWith("gpg.")
    || key === "commit.gpgsign"
    || key === "tag.gpgsign"
    || key.startsWith("push.")
    || key === "remote.origin.pushoption"
  ));
  if (unsafeKey) {
    throw qaRemotePolicyError(`QA integration refuses unsafe local Git configuration key ${unsafeKey}.`);
  }
  const fetchUrls = fetch.ok ? fetch.stdout.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  const explicitPushUrls = push.ok ? push.stdout.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  if (fetchUrls.length !== 1) {
    throw qaRemotePolicyError("QA integration requires exactly one configured origin fetch URL.");
  }
  if (explicitPushUrls.length > 1) {
    throw qaRemotePolicyError("QA integration refuses an origin with multiple push URLs.");
  }
  const pushUrls = explicitPushUrls.length ? explicitPushUrls : fetchUrls;
  for (const [label, url] of [["fetch", fetchUrls[0]], ["push", pushUrls[0]]]) {
    if (equivalentGitHubOriginSlug(url) !== expectedRepository) {
      throw qaRemotePolicyError(
        `QA integration ${label} remote does not match configured repository ${expectedRepository}.`,
      );
    }
  }
  return {
    repository: expectedRepository,
    transportUrl: configuredUrl,
  };
}

function validationSandboxAdapter(options = {}) {
  const adapter = options.projectValidationSandboxAdapter;
  if (!adapter) {
    return {
      prepare: prepareProjectValidationSandbox,
      run: runProjectValidationCommand,
      verify: verifyProjectValidationSandbox,
      prepareDependencies: prepareProjectValidationDependencies,
      installDependencies: installPreparedProjectValidationDependencies,
      cleanup: cleanupProjectValidationSandbox,
    };
  }
  const resolve = isolatedTestAdapterRun(adapter, "qa-outer-validation-sandbox");
  const resolved = resolve ? resolve() : null;
  if (
    !resolved
    || [resolved.prepare, resolved.run, resolved.verify, resolved.cleanup]
      .some((item) => typeof item !== "function")
  ) {
    throw new Error("QA project-validation adapter was rejected outside its isolated test capability.");
  }
  return resolved;
}

function outerValidationEnvironment(homePath, validationPath) {
  return {
    PATH: validationPath,
    HOME: homePath,
    TMPDIR: path.join(homePath, "tmp"),
    XDG_CONFIG_HOME: path.join(homePath, ".config"),
    XDG_CACHE_HOME: path.join(homePath, ".cache"),
    GH_CONFIG_DIR: path.join(homePath, ".config", "gh"),
    npm_config_cache: path.join(homePath, ".npm-cache"),
    npm_config_userconfig: path.join(homePath, ".npmrc"),
    npm_config_globalconfig: path.join(homePath, ".npm-globalrc"),
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C",
    LC_ALL: "C",
    OPENSSL_CONF: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    STUDIOOPS_PROJECT_VALIDATION_SANDBOX: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
  };
}

async function assertSafeOuterTestValidationPath(validationPath, sourceRepoPath) {
  const approvedRoots = await Promise.all(
    QA_OUTER_TEST_VALIDATION_PATH_ROOTS.map((entry) => realpath(entry).catch(() => "")),
  );
  for (const entry of String(validationPath || "").split(":")) {
    if (!path.isAbsolute(entry)) {
      const error = new Error(`Unsafe validation PATH entry: ${entry || "<empty>"}.`);
      error.code = "PROJECT_VALIDATION_INPUT_INVALID";
      throw error;
    }
    const toolRoot = await realpath(entry).catch(() => "");
    if (!toolRoot) {
      const error = new Error(`Unsafe validation PATH entry: ${entry} does not resolve to an existing directory.`);
      error.code = "PROJECT_VALIDATION_INPUT_INVALID";
      throw error;
    }
    const toolRootInfo = await lstat(toolRoot);
    const approved = approvedRoots.some((approvedRoot) => (
      approvedRoot && pathContains(approvedRoot, toolRoot)
    ));
    if (
      !toolRootInfo.isDirectory()
      || pathContains(sourceRepoPath, toolRoot)
      || pathContains(os.homedir(), toolRoot)
      || !approved
    ) {
      const error = new Error(`Unsafe validation PATH entry: ${toolRoot}.`);
      error.code = "PROJECT_VALIDATION_INPUT_INVALID";
      throw error;
    }
  }
}

async function runOuterValidationCommand(sandbox, command, options = {}) {
  try {
    const result = await execFileAsync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", String(command || "")],
      {
        cwd: sandbox.repoPath,
        env: sandbox.environment,
        timeout: Number(options.timeoutMs || VALIDATION_TIMEOUT_MS),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return {
      ok: true,
      code: 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error?.code) ? error.code : null,
      signal: error?.signal || "",
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      output: `${error?.stdout || ""}${error?.stderr || error?.message || ""}`.trim(),
    };
  }
}

/**
 * Release tests execute inside one verified outer Seatbelt sandbox. This
 * capability adapter preserves the disposable exact-SHA checkout and
 * synthetic environment without attempting unsupported nested sandbox-exec.
 */
export function createQaOuterSandboxTestAdapter() {
  const testAuthority = requireQaIntegrationTestAuthority();
  if (
    process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX !== PROJECT_VALIDATION_SANDBOX_POLICY_ID
  ) {
    throw new Error("The QA outer-sandbox adapter requires an isolated test already inside the verified project sandbox.");
  }
  const implementation = Object.freeze({
    async prepare(input = {}) {
      const sourceRepoPath = path.resolve(String(input.sourceRepoPath || ""));
      const workspaceRoot = path.resolve(String(input.workspaceRoot || ""));
      const expectedHeadSha = String(input.expectedHeadSha || "").trim().toLowerCase();
      const validationPath = String(input.validationPath || DEFAULT_PROJECT_VALIDATION_PATH);
      if (
        !path.isAbsolute(String(input.sourceRepoPath || ""))
        || !path.isAbsolute(String(input.workspaceRoot || ""))
        || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(expectedHeadSha)
        || pathContains(sourceRepoPath, workspaceRoot)
      ) {
        const error = new Error("Outer-sandbox validation requires safe absolute paths and an exact commit SHA.");
        error.code = "PROJECT_VALIDATION_INPUT_INVALID";
        throw error;
      }
      await assertSafeOuterTestValidationPath(validationPath, sourceRepoPath);
      await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const rootPath = await mkdtemp(path.join(workspaceRoot, "validation-sandbox-"));
      let prepared = false;
      try {
        const repoPath = path.join(rootPath, "repo");
        const homePath = path.join(rootPath, "home");
        await mkdir(homePath, { recursive: true, mode: 0o700 });
        await Promise.all([
          mkdir(path.join(homePath, "tmp"), { recursive: true, mode: 0o700 }),
          mkdir(path.join(homePath, ".config", "gh"), { recursive: true, mode: 0o700 }),
          mkdir(path.join(homePath, ".cache"), { recursive: true, mode: 0o700 }),
          mkdir(path.join(homePath, ".npm-cache"), { recursive: true, mode: 0o700 }),
          writeFile(path.join(homePath, ".npmrc"), "", { mode: 0o600 }),
          writeFile(path.join(homePath, ".npm-globalrc"), "", { mode: 0o600 }),
        ]);
        const gitOptions = qaGitOptions(input);
        await git(undefined, [
          "clone",
          "--no-local",
          "--no-hardlinks",
          "--no-tags",
          "--no-checkout",
          "--",
          sourceRepoPath,
          repoPath,
        ], gitOptions);
        await git(repoPath, ["checkout", "--detach", expectedHeadSha], gitOptions);
        await git(repoPath, ["remote", "remove", "origin"], gitOptions);
        try {
          await lstat(path.join(repoPath, ".git", "objects", "info", "alternates"));
          const error = new Error("Outer-sandbox validation clone unexpectedly shares a Git object store.");
          error.code = "PROJECT_VALIDATION_CLONE_UNSAFE";
          throw error;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const head = await git(repoPath, ["rev-parse", "--verify", "HEAD"], gitOptions);
        if (head.stdout.trim().toLowerCase() !== expectedHeadSha) {
          const error = new Error("Outer-sandbox validation clone identity mismatch.");
          error.code = "PROJECT_VALIDATION_CLONE_UNSAFE";
          throw error;
        }
        prepared = true;
        return {
          rootPath,
          repoPath,
          homePath,
          environment: outerValidationEnvironment(
            homePath,
            validationPath,
          ),
          policyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
          strategy: "outer_verified_sandbox_disposable_full_clone",
          networkPolicy: "deny_all",
          processPolicy: "outer_sandbox_inherited",
          expectedHeadSha,
          testGitRunner: input.testGitRunner,
        };
      } finally {
        if (!prepared) await rm(rootPath, { recursive: true, force: true });
      }
    },
    run: runOuterValidationCommand,
    async verify(sandbox) {
      const gitOptions = { testGitRunner: sandbox.testGitRunner };
      const head = await git(sandbox.repoPath, [
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--verify",
        "HEAD",
      ], gitOptions);
      const clean = await git(sandbox.repoPath, [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "core.attributesFile=/dev/null",
        "diff",
        "--quiet",
        "HEAD",
        "--",
      ], { ...gitOptions, allowFailure: true });
      if (head.stdout.trim().toLowerCase() !== sandbox.expectedHeadSha || !clean.ok) {
        const error = new Error("Repository validation changed the exact candidate checkout; its result cannot be trusted.");
        error.code = "PROJECT_VALIDATION_IDENTITY_DRIFT";
        throw error;
      }
      return {
        head: sandbox.expectedHeadSha,
        policyId: sandbox.policyId,
        strategy: sandbox.strategy,
        networkPolicy: sandbox.networkPolicy,
        processPolicy: sandbox.processPolicy,
      };
    },
    async cleanup(sandbox) {
      const rootPath = path.resolve(String(sandbox?.rootPath || ""));
      if (!rootPath || rootPath === path.parse(rootPath).root || !path.basename(rootPath).startsWith("validation-sandbox-")) {
        const error = new Error(`Refusing to remove unsafe outer validation sandbox path: ${rootPath}.`);
        error.code = "PROJECT_VALIDATION_CLEANUP_UNSAFE";
        throw error;
      }
      await rm(rootPath, { recursive: true, force: true });
    },
  });
  return registerIsolatedTestAdapter(
    testAuthority,
    "qa-outer-validation-sandbox",
    () => implementation,
  );
}

async function safeRemoveWorkspace(workspacePath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, workspacePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove unsafe QA workspace path: ${workspacePath}`);
  }
  await rm(workspacePath, { recursive: true, force: true });
}

async function copyGitConfigValue(sourceRepoPath, workspacePath, key, options = {}) {
  const value = await git(
    sourceRepoPath,
    ["config", "--local", "--no-includes", "--get", key],
    qaGitOptions(options, { allowFailure: true }),
  );
  if (!value.ok || !value.stdout.trim()) return;
  await git(workspacePath, ["config", "--local", key, value.stdout.trim()], qaGitOptions(options));
}

async function copyGitIdentity(sourceRepoPath, workspacePath, options = {}) {
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.name", options);
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.email", options);
  const name = await git(
    workspacePath,
    ["config", "--local", "--no-includes", "--get", "user.name"],
    qaGitOptions(options, { allowFailure: true }),
  );
  const email = await git(
    workspacePath,
    ["config", "--local", "--no-includes", "--get", "user.email"],
    qaGitOptions(options, { allowFailure: true }),
  );
  if (!name.ok || !name.stdout.trim()) {
    await git(workspacePath, ["config", "--local", "user.name", "StudioOps Automation"], qaGitOptions(options));
  }
  if (!email.ok || !email.stdout.trim()) {
    await git(workspacePath, ["config", "--local", "user.email", "studioops@localhost"], qaGitOptions(options));
  }
}

async function configureWorkspaceOrigin(workspacePath, remotePolicy, options = {}) {
  const gitOptions = qaGitOptions(options);
  await git(workspacePath, ["remote", "set-url", "origin", remotePolicy.transportUrl], gitOptions);
  await git(workspacePath, ["config", "--local", "--unset-all", "remote.origin.pushurl"], {
    ...gitOptions,
    allowFailure: true,
  });
}

async function seedLocalBranchFromSourceClone(workspacePath, branchName, options = {}) {
  if (!branchName || await localBranchExists(workspacePath, branchName, options)) return;
  const clonedSourceRef = `refs/remotes/origin/${branchName}`;
  const sourceBranch = await git(
    workspacePath,
    ["rev-parse", "--verify", clonedSourceRef],
    qaGitOptions(options, { allowFailure: true }),
  );
  if (!sourceBranch.ok) return;
  await git(
    workspacePath,
    ["branch", branchName, clonedSourceRef],
    qaGitOptions(options, { allowFailure: true }),
  );
}

async function prepareQaWorkspace(sourceRepoPath, projectPlan, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(
    options.qaWorkspaceRoot
      || options.workspaceRoot
      || process.env.STUDIOOPS_QA_WORKSPACE_ROOT
      || process.env.MISSION_CONTROL_QA_WORKSPACE_ROOT,
  );
  if (pathContains(sourceRepoPath, workspaceRoot)) {
    throw new Error(`QA workspace root must be outside the registered project repoPath: ${workspaceRoot}`);
  }

  const remotePolicy = await qaRemotePolicy(sourceRepoPath, projectPlan, options);

  const projectSegment = workspaceSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const branchSegment = workspaceSegment(projectPlan.integrationBranch || "qa");
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
      remotePolicy.transportUrl,
      workspacePath,
    ], {
      ...qaGitOptions(options),
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    });
    await seedLocalBranchFromSourceClone(workspacePath, projectPlan.integrationBranch, options);
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

async function localBranchExists(repoPath, branchName, options = {}) {
  const result = await git(
    repoPath,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    qaGitOptions(options, { allowFailure: true }),
  );
  return result.ok;
}

async function remoteBranchExists(repoPath, branchName, options = {}) {
  const fetchResult = await git(repoPath, ["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`], { ...options, allowFailure: true });
  if (fetchResult.ok) return true;
  const result = await git(
    repoPath,
    ["rev-parse", "--verify", `refs/remotes/origin/${branchName}`],
    qaGitOptions(options, { allowFailure: true }),
  );
  return result.ok;
}

async function remoteRefHead(repoPath, ref, options = {}) {
  const result = await git(repoPath, ["ls-remote", "origin", ref], { ...options, allowFailure: true });
  if (!result.ok) return { ok: false, head: "", output: truncateOutput(result.output) };
  const line = String(result.stdout || "").split("\n").find(Boolean) || "";
  return {
    ok: true,
    head: line.trim().split(/\s+/)[0] || "",
    output: "",
  };
}

async function remoteTaskHead(repoPath, task, options = {}) {
  const branchName = normalizeBranchName(task.branchName);
  if (branchName) return remoteRefHead(repoPath, `refs/heads/${branchName}`, options);
  const prNumber = prNumberFromUrl(task.prUrl);
  if (prNumber) return remoteRefHead(repoPath, `refs/pull/${prNumber}/head`, options);
  return { ok: false, head: "", output: "Task has no branch or GitHub PR ref." };
}

function taskSourceRef(task) {
  const branchName = normalizeBranchName(task.branchName);
  if (branchName) return `refs/heads/${branchName}`;
  const prNumber = prNumberFromUrl(task.prUrl);
  return prNumber ? `refs/pull/${prNumber}/head` : "";
}

async function prepareIntegrationBranch(repoPath, project, branchName, options = {}) {
  await git(repoPath, ["check-ref-format", "--branch", branchName], qaGitOptions(options));

  const hasLocalBranch = await localBranchExists(repoPath, branchName, options);
  const hasRemoteBranch = await remoteBranchExists(repoPath, branchName, options);

  if (hasLocalBranch) {
    await git(repoPath, ["checkout", branchName], qaGitOptions(options));
    if (hasRemoteBranch) {
      const fastForward = await git(
        repoPath,
        ["merge", "--ff-only", `refs/remotes/origin/${branchName}`],
        qaGitOptions(options, { allowFailure: true }),
      );
      if (!fastForward.ok) {
        throw new Error(`Local integration branch ${branchName} cannot fast-forward to origin/${branchName}. Resolve or push local branch work before running QA integration.`);
      }
    }
    return hasRemoteBranch ? "updated_local_branch" : "using_local_branch";
  }

  if (hasRemoteBranch) {
    await git(
      repoPath,
      ["checkout", "-b", branchName, `refs/remotes/origin/${branchName}`],
      qaGitOptions(options),
    );
    return "checked_out_remote_branch";
  }

  const baseBranch = normalizeBranchName(project.defaultBranch || "main");
  const baseFetch = await git(repoPath, ["fetch", "origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { ...options, allowFailure: true });
  if (!baseFetch.ok) {
    throw new Error(`Could not fetch default branch origin/${baseBranch} to create ${branchName}: ${baseFetch.output}`);
  }
  await git(
    repoPath,
    ["checkout", "-b", branchName, `refs/remotes/origin/${baseBranch}`],
    qaGitOptions(options),
  );
  return "created_branch";
}

async function currentBranchName(repoPath, options = {}) {
  const branch = await git(
    repoPath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    qaGitOptions(options, { allowFailure: true }),
  );
  return branch.ok ? normalizeBranchName(branch.stdout) : "";
}

async function resetPreparedIntegrationBranch(repoPath, branchName, preparedHead, options = {}) {
  if (!preparedHead) return { ok: true, output: "" };

  const currentBranch = await currentBranchName(repoPath, options);
  if (currentBranch !== branchName) {
    return {
      ok: false,
      output: `Refusing to reset ${branchName}: current checkout is ${currentBranch || "detached HEAD"}.`,
    };
  }

  return git(
    repoPath,
    ["reset", "--keep", preparedHead],
    qaGitOptions(options, { allowFailure: true }),
  );
}

async function fetchTaskSource(repoPath, task, options = {}) {
  const localRef = `refs/mission-control/tasks/${safeRefSegment(task.id)}`;
  const branchName = normalizeBranchName(task.branchName);
  const errors = [];

  if (branchName) {
    const branchFormat = await git(
      repoPath,
      ["check-ref-format", "--branch", branchName],
      qaGitOptions(options, { allowFailure: true }),
    );
    if (branchFormat.ok) {
      const branchFetch = await git(repoPath, ["fetch", "origin", `refs/heads/${branchName}:${localRef}`], { ...options, allowFailure: true });
      if (branchFetch.ok) {
        return {
          ok: true,
          ref: localRef,
          sourceRef: `refs/heads/${branchName}`,
          headSha: await branchHead(repoPath, localRef, options),
          label: branchName,
          fetchOutput: branchFetch.output,
        };
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
      return {
        ok: true,
        ref: localRef,
        sourceRef: `refs/pull/${prNumber}/head`,
        headSha: await branchHead(repoPath, localRef, options),
        label: `pull/${prNumber}`,
        fetchOutput: prFetch.output,
      };
    }
    errors.push(`PR ${prNumber}: ${prFetch.output}`);
  }

  return {
    ok: false,
    error: errors.length ? errors.join("\n") : "Task needs a branch name or GitHub PR URL before QA integration can fetch a source ref.",
  };
}

async function conflictFiles(repoPath, options = {}) {
  const result = await git(
    repoPath,
    ["diff", "--name-only", "--diff-filter=U"],
    qaGitOptions(options, { allowFailure: true }),
  );
  return result.stdout ? result.stdout.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

async function branchHead(repoPath, ref, options = {}) {
  const result = await git(repoPath, ["rev-parse", "--verify", ref], { ...options, allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

async function mergeDefaultBranchIntoIntegration(repoPath, projectPlan, options = {}) {
  const baseBranch = normalizeBranchName(projectPlan.defaultBranch || "main");
  const fetch = await git(repoPath, ["fetch", "origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { ...options, allowFailure: true });
  if (!fetch.ok) {
    return {
      ok: false,
      status: "blocked",
      output: `Could not fetch default branch origin/${baseBranch}: ${truncateOutput(fetch.output)}`,
    };
  }

  const before = await branchHead(repoPath, "HEAD", options);
  const remoteDefaultRef = `refs/remotes/origin/${baseBranch}`;
  const ancestor = await git(repoPath, ["merge-base", "--is-ancestor", remoteDefaultRef, "HEAD"], { ...options, allowFailure: true });
  if (ancestor.ok) {
    return {
      ok: true,
      status: "unchanged",
      changed: false,
      output: `Integration branch already contains origin/${baseBranch}.`,
    };
  }

  const merge = await git(repoPath, ["merge", "--no-ff", "--no-edit", remoteDefaultRef], { ...options, allowFailure: true });
  if (!merge.ok) {
    const conflicts = await conflictFiles(repoPath, options);
    await git(repoPath, ["merge", "--abort"], { ...options, allowFailure: true });
    return {
      ok: false,
      status: "conflict",
      conflicts,
      output: truncateOutput(merge.output),
    };
  }

  const after = await branchHead(repoPath, "HEAD", options);
  return {
    ok: true,
    status: "merged",
    changed: before && after && before !== after,
    output: truncateOutput(merge.output || `Merged origin/${baseBranch}.`),
  };
}

function unsafePreviewPathReason(value) {
  if (!value || !path.isAbsolute(value)) return "Local QA preview checkoutPath must be an absolute path.";
  const parsed = path.parse(value);
  const normalized = path.resolve(value);
  const unsafe = new Set([
    parsed.root,
    path.join(parsed.root, "Users"),
    path.join(parsed.root, "tmp"),
    path.join(parsed.root, "var"),
    path.join(parsed.root, "opt"),
    path.join(parsed.root, "home"),
  ]);
  return unsafe.has(normalized) ? `Local QA preview checkoutPath is too broad: ${normalized}` : "";
}

async function ensureLocalQaPreviewCheckout(projectPlan, preview, options = {}) {
  const checkoutPath = preview.checkoutPath;
  const pathReason = unsafePreviewPathReason(checkoutPath);
  if (pathReason) return { ok: false, output: pathReason };

  const workTree = await git(checkoutPath, ["rev-parse", "--show-toplevel"], { ...options, allowFailure: true });
  if (workTree.ok) return { ok: true, created: false };
  if (!preview.createIfMissing) {
    return {
      ok: false,
      output: `Local QA preview checkout does not exist or is not a Git work tree: ${checkoutPath}`,
    };
  }

  const remotePolicy = await qaRemotePolicy(projectPlan.repoPath, projectPlan, options);
  await mkdir(path.dirname(checkoutPath), { recursive: true });
  const clone = await git(undefined, [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--no-tags",
    "--",
    remotePolicy.transportUrl,
    checkoutPath,
  ], {
    ...qaGitOptions(options),
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    allowFailure: true,
  });
  if (!clone.ok) {
    return {
      ok: false,
      output: `Could not create local QA preview checkout: ${truncateOutput(clone.output)}`,
    };
  }

  await configureWorkspaceOrigin(checkoutPath, remotePolicy, options);
  return { ok: true, created: true };
}

async function readLimitedResponseBody(response, maxBytes = 64 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Health response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function previewIdentityFromResponse(response, preview) {
  const headerValue = String(response.headers.get(preview.identityHeader) || "").trim();
  if (headerValue) {
    return {
      kind: "header",
      key: preview.identityHeader,
      observedSha: normalizeGitSha(headerValue, "preview identity header"),
    };
  }
  const body = await readLimitedResponseBody(response);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Health response must provide ${preview.identityHeader} or JSON field ${preview.identityJsonField}.`,
    );
  }
  return {
    kind: "json",
    key: preview.identityJsonField,
    observedSha: normalizeGitSha(parsed?.[preview.identityJsonField], "preview identity JSON field"),
  };
}

async function syncLocalQaPreview(projectPlan, options = {}) {
  const preview = localQaPreviewConfig(projectPlan);
  const result = {
    enabled: preview.enabled,
    status: preview.enabled ? "skipped" : "disabled",
    checkoutPath: preview.checkoutPath || "",
    branch: preview.branch || "",
    before: "",
    after: "",
    stashed: false,
    created: false,
    output: "",
    commands: [],
    restartResults: [],
    previewUrl: preview.previewUrl || "",
    healthCheckUrl: preview.healthCheckUrl || "",
    attestation: null,
  };
  if (!preview.enabled) return result;
  if (!preview.branch) {
    result.status = "blocked";
    result.output = "Local QA preview branch is not configured.";
    return result;
  }

  const gitOptions = qaGitOptions(options);
  await qaRemotePolicy(projectPlan.repoPath, projectPlan, options);
  const ensured = await ensureLocalQaPreviewCheckout(projectPlan, preview, gitOptions);
  result.created = Boolean(ensured.created);
  if (!ensured.ok) {
    result.status = "blocked";
    result.output = ensured.output;
    return result;
  }
  await qaRemotePolicy(preview.checkoutPath, projectPlan, options);

  const dirty = await git(preview.checkoutPath, ["status", "--porcelain"], { ...gitOptions, allowFailure: true });
  if (!dirty.ok) {
    result.status = "blocked";
    result.output = `Could not inspect local QA preview checkout: ${truncateOutput(dirty.output)}`;
    return result;
  }
  if (dirty.stdout.trim()) {
    if (!preview.stashDirty) {
      result.status = "blocked";
      result.output = "Local QA preview checkout has uncommitted changes. Enable localQaPreview.stashDirty or clean the checkout before syncing.";
      return result;
    }
    const stash = await git(preview.checkoutPath, ["stash", "push", "-u", "-m", `StudioOps local QA preview sync ${new Date().toISOString()}`], { ...gitOptions, allowFailure: true });
    if (!stash.ok) {
      result.status = "blocked";
      result.output = `Could not stash local QA preview changes: ${truncateOutput(stash.output)}`;
      return result;
    }
    result.stashed = true;
  }

  const fetchResult = await git(preview.checkoutPath, ["fetch", "origin", `refs/heads/${preview.branch}:refs/remotes/origin/${preview.branch}`], { ...gitOptions, allowFailure: true });
  if (!fetchResult.ok) {
    result.status = "blocked";
    result.output = `Could not fetch local QA preview branch origin/${preview.branch}: ${truncateOutput(fetchResult.output)}`;
    return result;
  }

  const currentBranch = await currentBranchName(preview.checkoutPath, gitOptions);
  if (currentBranch !== preview.branch) {
    const hasLocal = await localBranchExists(preview.checkoutPath, preview.branch, gitOptions);
    const checkoutArgs = hasLocal
      ? ["checkout", preview.branch]
      : ["checkout", "-b", preview.branch, `refs/remotes/origin/${preview.branch}`];
    const checkout = await git(preview.checkoutPath, checkoutArgs, { ...gitOptions, allowFailure: true });
    if (!checkout.ok) {
      result.status = "blocked";
      result.output = `Could not check out local QA preview branch ${preview.branch}: ${truncateOutput(checkout.output)}`;
      return result;
    }
  }

  result.before = await branchHead(preview.checkoutPath, "HEAD", gitOptions);
  const fastForward = await git(preview.checkoutPath, ["merge", "--ff-only", `refs/remotes/origin/${preview.branch}`], { ...gitOptions, allowFailure: true });
  if (!fastForward.ok) {
    result.status = "blocked";
    result.output = `Local QA preview checkout cannot fast-forward to origin/${preview.branch}: ${truncateOutput(fastForward.output)}`;
    return result;
  }
  result.after = await branchHead(preview.checkoutPath, "HEAD", gitOptions);

  for (const command of preview.postUpdateCommands) {
    const commandResult = await runCommand("sh", ["-lc", command], {
      cwd: preview.checkoutPath,
      env: options.env,
      projectCommand: true,
      secrets: options.secrets,
      timeoutMs: Number(options.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
      allowFailure: true,
    });
    const item = {
      command,
      ok: commandResult.ok,
      output: truncateOutput(commandResult.output),
    };
    result.commands.push(item);
    if (!item.ok) {
      result.status = "post_update_failed";
      result.output = `Local QA preview post-update command failed: ${command}`;
      return result;
    }
  }

  const uid = String(os.userInfo().uid);
  for (const label of preview.restartLaunchAgents) {
    let loaded = await runCommand("launchctl", ["print", `gui/${uid}/${label}`], {
      allowFailure: true,
      timeoutMs: 15_000,
      ...gitOptions,
    });
    if (!loaded.ok) {
      const configuredPlist = preview.launchAgentPlists?.[label];
      const plistPath = resolveWorkspaceRoot(configuredPlist || path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`));
      const plistExists = await access(plistPath).then(() => true).catch(() => false);
      if (plistExists) {
        const bootstrap = await runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
          allowFailure: true,
          timeoutMs: 15_000,
          ...gitOptions,
        });
        loaded = await runCommand("launchctl", ["print", `gui/${uid}/${label}`], {
          allowFailure: true,
          timeoutMs: 15_000,
          ...gitOptions,
        });
        if (!bootstrap.ok && !loaded.ok) {
          result.restartResults.push({
            label,
            status: "bootstrap_failed",
            output: truncateOutput(bootstrap.output || loaded.output),
          });
          continue;
        }
      } else {
        result.restartResults.push({
          label,
          status: "not_loaded",
          output: `LaunchAgent is not loaded and no plist exists at ${plistPath}.`,
        });
        continue;
      }
    }
    const restart = await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
      allowFailure: true,
      timeoutMs: 15_000,
      ...gitOptions,
    });
    result.restartResults.push({
      label,
      status: restart.ok ? "restarted" : "failed",
      output: truncateOutput(restart.output),
    });
  }

  if (result.restartResults.some((item) => item.status !== "restarted")) {
    result.status = "restart_failed";
    result.output = "Local QA preview could not restart every configured LaunchAgent.";
    return result;
  }

  if (!preview.healthCheckUrl) {
    result.status = "identity_check_missing";
    result.output = "Local QA preview requires a healthCheckUrl that attests the running commit.";
    return result;
  }
  let healthError = "";
  let attestation = null;
  const requestedHealthAttempts = Number(
    options.previewHealthAttempts ?? DEFAULT_PREVIEW_HEALTH_ATTEMPTS,
  );
  const healthAttempts = Math.min(
    MAX_PREVIEW_HEALTH_ATTEMPTS,
    Math.max(
      1,
      Number.isFinite(requestedHealthAttempts)
        ? Math.floor(requestedHealthAttempts)
        : DEFAULT_PREVIEW_HEALTH_ATTEMPTS,
    ),
  );
  const requestedRetryDelayMs = Number(
    options.previewHealthRetryDelayMs ?? DEFAULT_PREVIEW_HEALTH_RETRY_DELAY_MS,
  );
  const retryDelayMs = Math.min(
    5_000,
    Math.max(10, Number.isFinite(requestedRetryDelayMs) ? Math.floor(requestedRetryDelayMs) : 1_000),
  );
  for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
    try {
      const response = await fetch(preview.healthCheckUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        healthError = `HTTP ${response.status}`;
      } else {
        const observed = await previewIdentityFromResponse(response, preview);
        if (observed.observedSha === result.after) {
          attestation = observed;
          break;
        }
        healthError = `expected ${result.after}, observed ${observed.observedSha}`;
      }
    } catch (error) {
      healthError = error.message;
    }
    if (attempt < healthAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  if (!attestation) {
    result.status = healthError.startsWith("expected ") ? "identity_mismatch" : "health_check_failed";
    result.output = `Local QA preview identity check failed at ${preview.healthCheckUrl}: ${healthError}`;
    return result;
  }
  result.attestation = attestation;

  result.status = result.before && result.after && result.before !== result.after ? "updated" : "current";
  result.output = result.status === "updated"
    ? `Local QA preview updated to ${result.after}.`
    : "Local QA preview already current.";
  return result;
}

async function mergeTaskSource(repoPath, task, options = {}) {
  if (task.reviewEvidenceError || !task.expectedHeadSha) {
    return {
      taskId: task.id,
      title: task.title,
      status: "review_evidence_invalid",
      source: sourceLabel(task),
      output: task.reviewEvidenceError || "Task has no reviewed source SHA.",
    };
  }
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
  if (source.headSha !== task.expectedHeadSha) {
    return {
      taskId: task.id,
      title: task.title,
      status: "source_drift",
      source: source.label,
      sourceRef: source.sourceRef,
      headSha: source.headSha,
      expectedHeadSha: task.expectedHeadSha,
      output: `Source drift detected: reviewed ${task.expectedHeadSha}, observed ${source.headSha}.`,
    };
  }

  const merge = await git(
    repoPath,
    ["merge", "--no-ff", "--no-edit", source.ref],
    qaGitOptions(options, { allowFailure: true }),
  );
  if (merge.ok) {
    return {
      taskId: task.id,
      title: task.title,
      status: "merged",
      source: source.label,
      sourceRef: source.sourceRef,
      headSha: source.headSha,
      candidateCycle: task.candidateCycle,
      reviews: task.reviews,
      output: truncateOutput(merge.output),
    };
  }

  const conflicts = await conflictFiles(repoPath, options);
  await git(repoPath, ["merge", "--abort"], qaGitOptions(options, { allowFailure: true }));
  return {
    taskId: task.id,
    title: task.title,
    status: "conflict",
    source: source.label,
    conflicts,
    output: truncateOutput(merge.output),
  };
}

async function runValidationCommands(sandbox, commands, options) {
  const sandboxOperations = validationSandboxAdapter(options);
  const results = [];
  if (sandboxOperations.prepareDependencies) {
    const dependencyCache = await sandboxOperations.prepareDependencies(sandbox, {
      dependencyAcquisitionTimeoutMs: options.validationDependencyAcquisitionTimeoutMs,
      dependencyAcquisitionMaxCaptureBytes: options.validationDependencyAcquisitionMaxCaptureBytes,
    });
    if (dependencyCache?.applicable && sandboxOperations.installDependencies) {
      const install = await sandboxOperations.installDependencies(sandbox, {
        validationTimeoutMs: options.validationTimeoutMs,
      });
      results.push({ command: "[offline dependency installation]", ok: install.ok, output: truncateOutput(install.output) });
      if (!install.ok) return results;
    }
  }
  for (const command of commands) {
    if (options.renewQaClaim) await options.renewQaClaim();
    const result = await sandboxOperations.run(sandbox, command, {
      timeoutMs: Number(options.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
    });
    results.push({
      command,
      ok: result.ok,
      output: truncateOutput(redactPromotionValidationText(
        redactCommandOutput(result.output, options),
      )),
    });
    if (!result.ok) break;
  }
  return results;
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

function partialCandidateRequest(input = {}) {
  const includedTaskIds = [
    ...new Set(normalizeList(
      input.partialTasks
      || input["partial-tasks"]
      || input.includedTaskIds
      || input["included-task-ids"],
    )),
  ].sort();
  if (!includedTaskIds.length) return null;
  const actorId = String(
    input.partialActorId
    || input["partial-actor-id"]
    || input.partialAuthor
    || input["partial-author"]
    || "",
  ).trim();
  const reasonCode = String(
    input.partialReasonCode
    || input["partial-reason-code"]
    || input.partialReason
    || input["partial-reason"]
    || "",
  ).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(actorId)) {
    throw new Error("Authorized partial QA assembly requires a non-sensitive --partial-actor-id.");
  }
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(reasonCode)) {
    throw new Error("Authorized partial QA assembly requires a bounded --partial-reason-code.");
  }
  return {
    includedTaskIds,
    authorization: { actorId, reasonCode },
  };
}

function retryWindowElapsed(task, nowMs) {
  const retryAt = Date.parse(task.integrationRetryNotBefore || "");
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

function jsonValue(value, fallback) {
  return JSON.parse(JSON.stringify(value === undefined ? fallback : value));
}

function qaProjectPolicyBinding(project = {}) {
  return {
    id: String(project.id || ""),
    repoPath: String(project.repoPath || ""),
    repoUrl: String(project.repoUrl || ""),
    defaultBranch: String(project.defaultBranch || "main"),
    trustLeadApprovals: trustLeadApprovalsEnabled(project),
    integrationBranch: integrationBranchName(project),
    eligible: projectUsesTrustLeadQa(project),
    integrationSafetyError: integrationBranchSafetyError(project),
    reviewPolicy: jsonValue(project.reviewPolicy, {}),
    qaIntegration: jsonValue(project.qaIntegration, {}),
    localQaPreview: jsonValue(project.localQaPreview, null),
    validationCommands: normalizeList(project.validationCommands),
  };
}

function qaTaskAuthorityBinding(state, task) {
  const evidence = candidateReviewEvidenceForTask(state, task);
  return {
    id: String(task.id || ""),
    projectId: String(task.projectId || ""),
    stateVersion: Number(task.stateVersion || 0),
    status: String(task.status || ""),
    branchName: String(task.branchName || ""),
    prUrl: String(task.prUrl || ""),
    reviewCycle: Number(task.reviewCycle || 0),
    reviewSubjectSha: String(task.reviewSubjectSha || ""),
    reviewSubjectCycle: Number(task.reviewSubjectCycle || 0),
    candidateIdentity: jsonValue(task.candidateIdentity, null),
    integrationStatus: String(task.integrationStatus || ""),
    integrationCandidateBranch: String(task.integrationCandidateBranch || ""),
    integrationCandidateCommit: String(task.integrationCandidateCommit || ""),
    integrationPrUrl: String(task.integrationPrUrl || ""),
    integrationPrNumber: Number(task.integrationPrNumber || 0),
    integrationPrState: String(task.integrationPrState || ""),
    integrationPrHeadSha: String(task.integrationPrHeadSha || ""),
    integrationSourceHeadSha: String(task.integrationSourceHeadSha || ""),
    integrationSourceCandidateCycle: Number(task.integrationSourceCandidateCycle || 0),
    reviewEvidence: evidence.ok
      ? {
          ok: true,
          subjectSha: evidence.subjectSha,
          candidateCycle: Number(evidence.candidateCycle || 0),
          reviews: jsonValue(evidence.reviews, []),
        }
      : { ok: false, error: String(evidence.error || "") },
  };
}

function qaAuthorityBinding(state, projectPlan) {
  const project = (state.projects || []).find((item) => item.id === projectPlan.projectId);
  if (!project) throw new Error(`QA project ${projectPlan.projectId} no longer exists.`);
  const taskIds = (projectPlan.tasks || []).map((task) => task.id).sort();
  const tasks = taskIds.map((taskId) => {
    const task = (state.tasks || []).find((item) => item.id === taskId);
    if (!task || task.projectId !== projectPlan.projectId) {
      throw new Error(`QA task ${taskId} no longer belongs to project ${projectPlan.projectId}.`);
    }
    return qaTaskAuthorityBinding(state, task);
  });
  return {
    schemaVersion: QA_ATTEMPT_CLAIM_SCHEMA_VERSION,
    project: qaProjectPolicyBinding(project),
    eligibleQaReviewTaskIds: (state.tasks || [])
      .filter((task) => task.projectId === projectPlan.projectId && task.status === "qa_review")
      .map((task) => task.id)
      .sort(),
    plan: {
      integrationBranch: String(projectPlan.integrationBranch || ""),
      syncDefaultBranchIntoIntegration: Boolean(projectPlan.syncDefaultBranchIntoIntegration),
      validationCommands: normalizeList(projectPlan.validationCommands),
      taskIds,
      assembly: jsonValue(projectPlan.assembly, null),
      deferredTaskCount: Number(projectPlan.deferredTaskCount || 0),
    },
    tasks,
  };
}

function qaAuthorityDigest(state, projectPlan) {
  return `sha256:${createHash("sha256").update(canonicalJson(
    qaAuthorityBinding(state, projectPlan),
  )).digest("hex")}`;
}

function qaAttemptNow(input = {}) {
  const nowMs = Number(input.qaAttemptNowMs ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error("qaAttemptNowMs must be finite.");
  return { nowMs, now: new Date(nowMs).toISOString() };
}

function qaAttemptClaims(state) {
  state.meta = state.meta || {};
  state.meta.qaIntegrationAttemptClaims = state.meta.qaIntegrationAttemptClaims || {};
  return state.meta.qaIntegrationAttemptClaims;
}

function assertQaAuthorityInState(state, projectPlan) {
  const observedDigest = qaAuthorityDigest(state, projectPlan);
  if (!projectPlan.qaAuthorityDigest || observedDigest !== projectPlan.qaAuthorityDigest) {
    const error = new Error("QA project policy, task state, review evidence, or candidate plan changed after planning.");
    error.code = "QA_ATTEMPT_STALE";
    throw error;
  }
  return observedDigest;
}

async function claimQaAttempt(projectPlan, input = {}) {
  return mutateState((state) => {
    const authorityDigest = assertQaAuthorityInState(state, projectPlan);
    const claims = qaAttemptClaims(state);
    const previous = claims[projectPlan.projectId] || null;
    const { nowMs, now } = qaAttemptNow(input);
    if (
      previous?.status === "active"
      && Number.isFinite(Date.parse(previous.expiresAt || ""))
      && Date.parse(previous.expiresAt) > nowMs
    ) {
      return {
        acquired: false,
        claim: jsonValue(previous, null),
        reason: `QA project ${projectPlan.projectId} already has an active fenced attempt.`,
      };
    }
    const ttlMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Number(input.qaAttemptTtlMs || QA_ATTEMPT_TTL_MS)));
    const claim = {
      schemaVersion: QA_ATTEMPT_CLAIM_SCHEMA_VERSION,
      claimId: typeof input.qaClaimIdFactory === "function" ? input.qaClaimIdFactory() : randomUUID(),
      projectId: projectPlan.projectId,
      fence: Math.max(0, Number(previous?.fence || 0)) + 1,
      status: "active",
      authorityDigest,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    };
    claims[projectPlan.projectId] = claim;
    return { acquired: true, claim: jsonValue(claim, null), reason: "" };
  }, { operationName: "qa_integration.claim_attempt" });
}

function assertExactQaClaimInState(state, projectPlan, claim, input = {}) {
  const current = state.meta?.qaIntegrationAttemptClaims?.[projectPlan.projectId];
  const { nowMs } = qaAttemptNow(input);
  if (
    !claim
    || !current
    || current.schemaVersion !== QA_ATTEMPT_CLAIM_SCHEMA_VERSION
    || current.status !== "active"
    || current.claimId !== claim.claimId
    || Number(current.fence) !== Number(claim.fence)
    || current.authorityDigest !== claim.authorityDigest
    || Date.parse(current.expiresAt || "") <= nowMs
  ) {
    const error = new Error("The exact QA integration attempt claim is missing, replaced, terminal, or expired.");
    error.code = "QA_ATTEMPT_STALE";
    throw error;
  }
  const authorityDigest = assertQaAuthorityInState(state, projectPlan);
  if (authorityDigest !== current.authorityDigest) {
    const error = new Error("QA integration authority no longer matches its fenced attempt.");
    error.code = "QA_ATTEMPT_STALE";
    throw error;
  }
  return current;
}

async function renewQaAttempt(projectPlan, claim, input = {}) {
  return mutateState((state) => {
    const current = assertExactQaClaimInState(state, projectPlan, claim, input);
    const { nowMs, now } = qaAttemptNow(input);
    const ttlMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Number(input.qaAttemptTtlMs || QA_ATTEMPT_TTL_MS)));
    current.renewedAt = now;
    current.expiresAt = new Date(nowMs + ttlMs).toISOString();
    return jsonValue(current, null);
  }, { operationName: "qa_integration.renew_attempt" });
}

async function assertQaAttempt(projectPlan, claim, input = {}) {
  const state = await readState();
  return assertExactQaClaimInState(state, projectPlan, claim, input);
}

export function planQaIntegrations(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const partialRequest = partialCandidateRequest(input);
  const explicitTaskFilter = normalizeList(input.task || input.tasks || input.taskId);
  if (partialRequest) {
    const knownTaskIds = new Set((state.tasks || []).map((task) => task.id));
    const unknownTaskId = partialRequest.includedTaskIds.find((taskId) => !knownTaskIds.has(taskId));
    if (unknownTaskId) throw new Error(`Unknown partial-candidate task: ${unknownTaskId}`);
  }
  const projectPlans = (state.projects || [])
    .filter((project) => projectMatches(project, input))
    .map((project) => {
      const integrationBranch = integrationBranchName(project);
      const safetyError = integrationBranchSafetyError(project);
      const trustEnabled = trustLeadApprovalsEnabled(project);
      const eligibleTasks = (state.tasks || [])
        .filter((task) => task.projectId === project.id)
        .filter((task) => task.status === "qa_review")
        .filter((task) => {
          if (task.integrationStatus !== "ready") return true;
          return input.force && explicitTaskFilter.includes(task.id);
        });
      const taskScoped = eligibleTasks.filter((task) => taskMatches(task, input));
      if (
        !partialRequest
        && explicitTaskFilter.length
        && taskScoped.length
        && taskScoped.length !== eligibleTasks.length
      ) {
        throw new Error(
          "Selecting fewer than all eligible QA tasks requires explicit partial-candidate authorization.",
        );
      }
      const requestedTasks = partialRequest ? eligibleTasks : taskScoped;
      const includedTasks = partialRequest
        ? eligibleTasks.filter((task) => partialRequest.includedTaskIds.includes(task.id))
        : taskScoped;
      if (partialRequest && includedTasks.length && includedTasks.length === eligibleTasks.length) {
        throw new Error("Authorized partial QA assembly must exclude at least one requested task.");
      }
      const candidateReady = input.force || includedTasks.every((task) => retryWindowElapsed(task, nowMs));
      const tasks = candidateReady ? includedTasks : [];
      const assembly = partialRequest && includedTasks.length
        ? {
            mode: "authorized_partial",
            requestedTaskIds: eligibleTasks.map((task) => task.id).sort(),
            includedTaskIds: includedTasks.map((task) => task.id).sort(),
            excludedTaskIds: requestedTasks
              .filter((task) => !partialRequest.includedTaskIds.includes(task.id))
              .map((task) => task.id)
              .sort(),
            authorization: partialRequest.authorization,
          }
        : {
            mode: "atomic",
            requestedTaskIds: tasks.map((task) => task.id).sort(),
            includedTaskIds: tasks.map((task) => task.id).sort(),
            excludedTaskIds: [],
          };
      return {
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
        repoPath: project.repoPath || "",
        repoUrl: project.repoUrl || "",
        defaultBranch: project.defaultBranch || "main",
        qaIntegration: project.qaIntegration || {},
        localQaPreview: project.localQaPreview || null,
        syncDefaultBranchIntoIntegration: syncDefaultBranchEnabled(project),
        trustLeadApprovals: trustEnabled,
        eligible: projectUsesTrustLeadQa(project),
        skipReason: trustEnabled ? safetyError : "trustLeadApprovals is disabled.",
        integrationBranch,
        integrationBranchUrl: branchWebUrl(project, integrationBranch),
        validationCommands: normalizeList(project.validationCommands),
        deferredTaskCount: candidateReady ? 0 : includedTasks.length,
        assembly,
        tasks: tasks.map((task) => {
          const reviewEvidence = candidateReviewEvidenceForTask(state, task);
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            branchName: task.branchName || "",
            prUrl: task.prUrl || "",
            integrationStatus: task.integrationStatus || "",
            integrationRetryNotBefore: task.integrationRetryNotBefore || "",
            expectedHeadSha: reviewEvidence.subjectSha || "",
            candidateCycle: reviewEvidence.candidateCycle || 0,
            reviews: reviewEvidence.reviews || [],
            reviewEvidenceError: reviewEvidence.ok ? "" : reviewEvidence.error,
            integrationCandidateBranch: task.integrationCandidateBranch || "",
            integrationCandidateCommit: task.integrationCandidateCommit || "",
            integrationPrUrl: task.integrationPrUrl || "",
            integrationPrNumber: task.integrationPrNumber || 0,
            integrationCheckState: task.integrationCheckState || null,
            integrationBlocker: task.integrationBlocker || "",
            integrationValidation: task.integrationValidation || null,
            integrationSourceHeadSha: task.integrationSourceHeadSha || "",
            integrationSourceCandidateCycle: Number(task.integrationSourceCandidateCycle || 0),
          };
        }),
      };
    });

  for (const projectPlan of projectPlans) {
    projectPlan.qaAuthorityDigest = qaAuthorityDigest(state, projectPlan);
  }

  if (partialRequest) {
    const eligibleIncludedTaskIds = new Set(
      projectPlans.flatMap((project) => project.assembly.includedTaskIds),
    );
    const unavailableTaskId = partialRequest.includedTaskIds.find(
      (taskId) => !eligibleIncludedTaskIds.has(taskId),
    );
    if (unavailableTaskId) {
      throw new Error(
        `Partial-candidate task ${unavailableTaskId} is not an eligible qa_review task in the selected project scope.`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    projects: projectPlans,
    taskCount: projectPlans.reduce((count, project) => count + project.tasks.length, 0),
  };
}

export function projectPlanHasWork(projectPlan) {
  if (projectPlan.tasks.length) return true;
  if (projectPlan.deferredTaskCount > 0) return false;
  return Boolean(
    projectPlan.syncDefaultBranchIntoIntegration
    || localQaPreviewConfig(projectPlan).enabled
  );
}

function allTaskResults(tasks, status, output) {
  return tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    status,
    source: sourceLabel(task),
    sourceRef: taskSourceRef(task),
    headSha: task.expectedHeadSha || "",
    candidateCycle: task.candidateCycle || 0,
    reviews: task.reviews || [],
    output: truncateOutput(output),
  }));
}

function appendOutput(existing, addition) {
  const current = String(existing || "").trim();
  const next = String(addition || "").trim();
  if (!current) return truncateOutput(next);
  if (!next) return truncateOutput(current);
  return truncateOutput(`${current}\n${next}`);
}

async function guardQaExternalMutation(repoPath, projectPlan, options = {}, operation = "external_mutation") {
  if (options.beforeQaExternalMutation) {
    await options.beforeQaExternalMutation({
      operation,
      projectId: projectPlan.projectId,
      repoPath,
    });
  }
  if (!options.renewQaClaim || !options.assertQaClaim) {
    const error = new Error("A live exact QA attempt claim is required before external mutation.");
    error.code = "QA_ATTEMPT_STALE";
    throw error;
  }
  await options.renewQaClaim();
  await options.assertQaClaim();
  const sourceRepoPath = String(options.sourceRepoPath || projectPlan.repoPath || "");
  if (sourceRepoPath) await qaRemotePolicy(sourceRepoPath, projectPlan, options);
  if (repoPath && path.resolve(repoPath) !== path.resolve(sourceRepoPath)) {
    await qaRemotePolicy(repoPath, projectPlan, options);
  }
}

function pendingProtectedHandoff(projectPlan) {
  if (!projectPlan.tasks.length) return null;
  const handoffTasks = projectPlan.tasks.filter((task) => (
    task.integrationCandidateBranch
    && task.integrationCandidateCommit
    && task.integrationPrUrl
  ));
  if (!handoffTasks.length) return null;
  const handoffKeys = new Set(handoffTasks.map((task) => (
    `${task.integrationCandidateBranch}\n${task.integrationCandidateCommit}\n${task.integrationPrUrl}`
  )));
  if (handoffKeys.size !== 1) {
    return {
      error: "Multiple unresolved protected-branch integration handoffs exist for this project. Resolve or invalidate them before assembling another QA candidate.",
      tasks: projectPlan.tasks,
      deferredTasks: [],
    };
  }
  const first = handoffTasks[0];
  let commit = "";
  try {
    commit = normalizeGitSha(first.integrationCandidateCommit, "protected QA handoff commit");
  } catch {
    return {
      error: "The unresolved protected-branch handoff has an invalid candidate commit identity. StudioOps will not inspect or delete its branch.",
      tasks: projectPlan.tasks,
      deferredTasks: [],
    };
  }
  const expectedBranch = integrationCandidateBranchName(projectPlan, commit);
  if (first.integrationCandidateBranch !== expectedBranch) {
    return {
      error: `The unresolved protected-branch handoff branch does not match its exact candidate identity (expected ${expectedBranch}). StudioOps will not inspect or delete it.`,
      tasks: projectPlan.tasks,
      deferredTasks: [],
    };
  }
  return {
    branch: first.integrationCandidateBranch,
    commit,
    prUrl: first.integrationPrUrl,
    tasks: handoffTasks,
    deferredTasks: projectPlan.tasks.filter((task) => !handoffTasks.includes(task)),
  };
}

async function verifyMergedIntegrationTarget(repoPath, projectPlan, pr, options = {}) {
  const mergeCommit = String(pr?.mergeCommit?.oid || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(mergeCommit)) {
    return {
      ok: false,
      blocker: "The integration PR is marked merged, but GitHub did not report a full merge commit SHA. StudioOps cannot attest the protected target.",
    };
  }
  const targetBranch = normalizeBranchName(projectPlan.integrationBranch);
  const fetch = await git(
    repoPath,
    ["fetch", "origin", `refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`],
    { ...options, allowFailure: true },
  );
  if (!fetch.ok) {
    return {
      ok: false,
      blocker: `The integration PR is merged, but StudioOps could not fetch protected target ${targetBranch}: ${truncateOutput(fetch.output)}`,
    };
  }
  const targetCommit = await branchHead(repoPath, `refs/remotes/origin/${targetBranch}`, options);
  const mergeCommitExists = await git(
    repoPath,
    ["cat-file", "-e", `${mergeCommit}^{commit}`],
    { ...options, allowFailure: true },
  );
  const mergeIsReachable = mergeCommitExists.ok
    ? await git(
        repoPath,
        ["merge-base", "--is-ancestor", mergeCommit, targetCommit],
        { ...options, allowFailure: true },
      )
    : { ok: false };
  if (!targetCommit || !mergeIsReachable.ok) {
    return {
      ok: false,
      blocker: `Merged integration commit ${mergeCommit} is not reachable from protected target ${targetBranch} at ${targetCommit || "missing"}. StudioOps will not reconstruct or repush the candidate.`,
    };
  }
  return {
    ok: true,
    mergeCommit,
    targetCommit,
  };
}

async function inspectPendingProtectedHandoff(repoPath, projectPlan, handoff, options = {}) {
  for (const task of projectPlan.tasks) {
    const source = await remoteTaskHead(repoPath, task, options);
    if (!source.ok) {
      return {
        status: "candidate_drift",
        blocker: `Could not verify the reviewed source for ${task.id}: ${source.output}`,
      };
    }
    if (source.head !== task.expectedHeadSha) {
      return {
        status: "candidate_drift",
        blocker: `Reviewed source drift for ${task.id}: expected ${task.expectedHeadSha}, observed ${source.head || "missing"}. A new review is required before rebuilding the QA candidate.`,
      };
    }
  }

  const pr = await findIntegrationPr(repoPath, projectPlan, handoff.branch, options);
  if (!pr) {
    return {
      status: "candidate_drift",
      blocker: `The recorded integration PR ${handoff.prUrl} could not be found for candidate branch ${handoff.branch}.`,
    };
  }
  const checkState = integrationPrCheckState(pr);
  const inspectedPr = {
    ...pr,
    checkState,
    blocker: integrationPrBlocker(pr, checkState),
    workflowStatus: integrationPrStatus(pr, checkState),
  };
  const recordedPrNumber = Number(prNumberFromUrl(handoff.prUrl) || 0);
  if (
    (recordedPrNumber && recordedPrNumber !== Number(inspectedPr.number || 0))
    || (inspectedPr.url && inspectedPr.url !== handoff.prUrl)
  ) {
    return {
      status: "candidate_drift",
      blocker: `Recorded integration PR ${handoff.prUrl} does not match the candidate branch PR ${inspectedPr.url || `#${inspectedPr.number || "unknown"}`}.`,
      pr: inspectedPr,
    };
  }
  if (inspectedPr.headRefOid !== handoff.commit) {
    return {
      status: "candidate_drift",
      blocker: `Integration PR head drift: expected ${handoff.commit}, observed ${inspectedPr.headRefOid || "missing"}. StudioOps will not overwrite the PR branch.`,
      pr: inspectedPr,
    };
  }

  const remoteCandidate = await remoteRefHead(repoPath, `refs/heads/${handoff.branch}`, options);
  if (!remoteCandidate.ok) {
    return {
      status: "candidate_drift",
      blocker: `Could not inspect candidate branch ${handoff.branch}: ${remoteCandidate.output}`,
      pr: inspectedPr,
    };
  }
  if (remoteCandidate.head && remoteCandidate.head !== handoff.commit) {
    return {
      status: "candidate_drift",
      blocker: `Candidate branch drift: expected ${handoff.commit}, observed ${remoteCandidate.head}. StudioOps will not overwrite the changed remote head.`,
      pr: inspectedPr,
    };
  }
  if (inspectedPr.workflowStatus !== "merged" && !remoteCandidate.head) {
    return {
      status: "candidate_drift",
      blocker: `Open integration PR candidate branch ${handoff.branch} is missing. StudioOps will not recreate it without rebuilding and review.`,
      pr: inspectedPr,
    };
  }
  const changedSources = projectPlan.tasks.filter((task) => (
    task.integrationSourceHeadSha
    && task.expectedHeadSha
    && task.integrationSourceHeadSha !== task.expectedHeadSha
  ));
  const missingSourceSnapshots = projectPlan.tasks.filter((task) => !task.integrationSourceHeadSha);
  if (inspectedPr.workflowStatus !== "merged" && changedSources.length) {
    if (missingSourceSnapshots.length) {
      return {
        status: "candidate_drift",
        blocker: `Newly reviewed source evidence is available, but the previous handoff lacks immutable source snapshots for ${missingSourceSnapshots.map((task) => task.id).join(", ")}. StudioOps will not replace the open PR without auditable evidence.`,
        pr: inspectedPr,
      };
    }
    const changedSummary = changedSources
      .map((task) => `${task.id} ${task.integrationSourceHeadSha} -> ${task.expectedHeadSha}`)
      .join(", ");
    const reason = `StudioOps is superseding this immutable QA candidate because newly reviewed source evidence replaced the prior handoff: ${changedSummary}. The old candidate remains recorded on each affected task.`;
    const closed = String(inspectedPr.state || "").toUpperCase() === "CLOSED"
      ? { ok: true, pr: inspectedPr, output: "" }
      : await closeIntegrationPr(repoPath, projectPlan, inspectedPr, reason, options);
    if (!closed.ok) {
      return {
        status: "candidate_supersession_failed",
        blocker: `${closed.output} No replacement candidate was published.`,
        pr: inspectedPr,
      };
    }
    let cleanup = { ok: true, output: "" };
    if (remoteCandidate.head) {
      await guardQaExternalMutation(repoPath, projectPlan, options, "delete_superseded_candidate_branch");
      cleanup = await git(repoPath, ["push", "origin", `:refs/heads/${handoff.branch}`], {
        ...options,
        allowFailure: true,
      });
    }
    return {
      status: "superseded",
      blocker: "",
      pr: {
        ...inspectedPr,
        state: "CLOSED",
      },
      supersededHandoff: {
        candidateBranch: handoff.branch,
        candidateCommit: handoff.commit,
        prUrl: handoff.prUrl,
        prNumber: Number(inspectedPr.number || 0),
        prState: "CLOSED",
        workflowStatus: inspectedPr.workflowStatus,
        checkState: inspectedPr.checkState,
        reviewDecision: inspectedPr.reviewDecision || "",
        blocker: inspectedPr.blocker || "",
        taskIds: projectPlan.tasks.map((task) => task.id),
        sources: projectPlan.tasks.map((task) => ({
          taskId: task.id,
          headSha: task.integrationSourceHeadSha,
          candidateCycle: task.integrationSourceCandidateCycle || 0,
          replacementHeadSha: task.expectedHeadSha,
          replacementCandidateCycle: task.candidateCycle || 0,
        })),
        reason,
        cleanup: cleanup.ok
          ? remoteCandidate.head
            ? `Removed superseded integration-candidate branch ${handoff.branch}.`
            : `Superseded integration-candidate branch ${handoff.branch} was already removed.`
          : `Cleanup warning: superseded integration-candidate branch ${handoff.branch} could not be removed: ${truncateOutput(cleanup.output)}`,
      },
    };
  }
  if (inspectedPr.workflowStatus !== "merged") {
    return {
      status: inspectedPr.workflowStatus,
      blocker: inspectedPr.blocker,
      pr: inspectedPr,
    };
  }

  const target = await verifyMergedIntegrationTarget(repoPath, projectPlan, inspectedPr, options);
  if (!target.ok) {
    return {
      status: "candidate_drift",
      blocker: target.blocker,
      pr: inspectedPr,
    };
  }
  let cleanup = { ok: true, output: "" };
  if (remoteCandidate.head) {
    await guardQaExternalMutation(repoPath, projectPlan, options, "delete_merged_candidate_branch");
    cleanup = await git(repoPath, ["push", "origin", `:refs/heads/${handoff.branch}`], {
      ...options,
      allowFailure: true,
    });
  }
  return {
    status: "merged",
    blocker: "",
    pr: inspectedPr,
    mergeCommit: target.mergeCommit,
    targetCommit: target.targetCommit,
    cleanup: cleanup.ok
      ? remoteCandidate.head
        ? `Removed merged integration-candidate branch ${handoff.branch}.`
        : `Merged integration-candidate branch ${handoff.branch} was already removed.`
      : `Cleanup warning: merged integration-candidate branch ${handoff.branch} could not be removed: ${truncateOutput(cleanup.output)}`,
  };
}

async function integrateProject(projectPlan, options = {}) {
  const candidatePlan = {
    ...projectPlan,
    tasks: [...projectPlan.tasks],
    integrationBranch: projectPlan.integrationBranch,
    candidateBranch: "",
    integrationBranchUrl: projectPlan.integrationBranchUrl,
  };
  const requestedTasks = [...candidatePlan.tasks];
  const requestedAssembly = candidatePlan.assembly;
  const pendingHandoff = pendingProtectedHandoff(candidatePlan);
  if (pendingHandoff?.tasks?.length && !pendingHandoff.error) {
    const includedTaskIds = pendingHandoff.tasks.map((task) => task.id).sort();
    candidatePlan.tasks = pendingHandoff.tasks;
    candidatePlan.assembly = {
      mode: "atomic",
      requestedTaskIds: includedTaskIds,
      includedTaskIds,
      excludedTaskIds: [],
    };
    candidatePlan.deferredTaskIds = pendingHandoff.deferredTasks.map((task) => task.id).sort();
  }
  const assemblingCandidate = candidatePlan.tasks.length > 0;
  const candidateId = assemblingCandidate ? `candidate_${randomUUID()}` : "";
  const project = {
    id: candidatePlan.projectId,
    key: candidatePlan.projectKey,
    name: candidatePlan.projectName,
    repoPath: candidatePlan.repoPath,
    repoUrl: candidatePlan.repoUrl,
    defaultBranch: candidatePlan.defaultBranch,
    integrationBranch: candidatePlan.integrationBranch,
  };
  const repoPath = String(project.repoPath || "").trim();
  const result = {
    ...candidatePlan,
    candidateId,
    tasks: [],
    status: "skipped",
    output: "",
    commit: "",
    validation: [],
    sourceRepoPath: repoPath,
    workspacePath: "",
    workspaceStrategy: "",
    defaultBranchSync: null,
    localQaPreview: null,
    baseSha: "",
    candidate: null,
    protectedBranchFallback: false,
    integrationCandidateBranch: "",
    integrationCandidateCommit: "",
    integrationPr: null,
    integrationCheckState: null,
    integrationBlocker: "",
    integrationCandidateCleanup: "",
    integrationMergeCommit: "",
    supersededHandoff: null,
    deferredTaskIds: candidatePlan.deferredTaskIds || [],
  };
  const shouldSyncDefaultBranch = syncDefaultBranchEnabled(candidatePlan);
  const shouldSyncLocalPreview = localQaPreviewConfig(candidatePlan).enabled;

  if (!candidatePlan.tasks.length && !shouldSyncDefaultBranch && !shouldSyncLocalPreview) {
    result.status = "no_tasks";
    return result;
  }

  if (pendingHandoff?.error) {
    result.status = "blocked";
    result.output = pendingHandoff.error;
    result.integrationBlocker = pendingHandoff.error;
    result.tasks = allTaskResults(candidatePlan.tasks, "blocked", pendingHandoff.error);
    return result;
  }

  if (!path.isAbsolute(repoPath)) {
    result.status = "blocked";
    result.output = "Project repoPath must be an absolute local path before QA integration can run.";
    result.tasks = candidatePlan.tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: "blocked",
      source: sourceLabel(task),
      output: result.output,
    }));
    return result;
  }

  let mergedHandoff = null;
  if (pendingHandoff) {
    await qaRemotePolicy(repoPath, candidatePlan, options);
    const inspected = await inspectPendingProtectedHandoff(repoPath, candidatePlan, pendingHandoff, options);
    if (inspected.status === "superseded") {
      candidatePlan.tasks = requestedTasks;
      candidatePlan.assembly = requestedAssembly;
      candidatePlan.deferredTaskIds = [];
      result.assembly = requestedAssembly;
      result.deferredTaskIds = [];
      result.supersededHandoff = inspected.supersededHandoff;
      result.output = [
        `Superseded protected QA handoff ${pendingHandoff.prUrl} at ${pendingHandoff.commit}.`,
        inspected.supersededHandoff.cleanup,
      ].filter(Boolean).join("\n");
    } else {
      result.protectedBranchFallback = true;
      result.integrationCandidateBranch = pendingHandoff.branch;
      result.integrationCandidateCommit = pendingHandoff.commit;
      result.commit = pendingHandoff.commit;
      result.integrationPr = inspected.pr || {
        url: pendingHandoff.prUrl,
        number: candidatePlan.tasks[0].integrationPrNumber || 0,
      };
      result.integrationCheckState = inspected.pr?.checkState || candidatePlan.tasks[0].integrationCheckState || null;
      result.integrationBlocker = inspected.blocker || "";
      result.integrationCandidateCleanup = inspected.cleanup || "";
      result.integrationMergeCommit = inspected.mergeCommit || "";
    }
    if (!["merged", "superseded"].includes(inspected.status)) {
      result.status = inspected.status;
      result.output = inspected.blocker;
      result.tasks = allTaskResults(candidatePlan.tasks, inspected.status, inspected.blocker);
      return result;
    }
    if (inspected.status === "merged") mergedHandoff = inspected;
  }

  if (!candidatePlan.tasks.length && !shouldSyncDefaultBranch && shouldSyncLocalPreview) {
    await guardQaExternalMutation(repoPath, candidatePlan, options, "sync_local_qa_preview");
    result.localQaPreview = await syncLocalQaPreview(candidatePlan, options);
    result.status = localPreviewFailed(result.localQaPreview)
      ? "preview_blocked"
      : "preview_ready";
    result.output = result.localQaPreview.output;
    return result;
  }

  let workspace = null;
  let validationSandbox = null;
  const sandboxOperations = validationSandboxAdapter(options);
  let executionRepoPath = "";
  let preparedHead = "";
  let pushed = false;
  try {
    workspace = await prepareQaWorkspace(repoPath, candidatePlan, options);
    executionRepoPath = workspace.executionRepoPath;
    result.workspacePath = workspace.workspacePath;
    result.workspaceStrategy = workspace.strategy;

    const gitOptions = qaGitOptions(options);
    const prepared = await prepareIntegrationBranch(executionRepoPath, project, candidatePlan.integrationBranch, gitOptions);
    result.output = appendOutput(result.output, prepared);
    const preparedCommit = await git(executionRepoPath, ["rev-parse", "--verify", "HEAD"], gitOptions);
    preparedHead = preparedCommit.stdout.trim();
    const defaultBranchHead = await remoteRefHead(
      executionRepoPath,
      `refs/heads/${normalizeBranchName(candidatePlan.defaultBranch || "main")}`,
      gitOptions,
    );
    if (!defaultBranchHead.ok || !defaultBranchHead.head) {
      throw new Error(`Could not resolve the exact default-branch base for the QA candidate: ${defaultBranchHead.output || "remote ref is missing"}`);
    }
    result.baseSha = defaultBranchHead.head;

    let branchChanged = false;
    if (!mergedHandoff && shouldSyncDefaultBranch) {
      result.defaultBranchSync = await mergeDefaultBranchIntoIntegration(executionRepoPath, candidatePlan, gitOptions);
      if (!result.defaultBranchSync.ok) {
        result.status = result.defaultBranchSync.status || "blocked";
        result.output = result.defaultBranchSync.output;
        result.tasks = result.tasks.length
          ? result.tasks
          : allTaskResults(candidatePlan.tasks, result.status, result.output);
        return result;
      }
      branchChanged = Boolean(result.defaultBranchSync.changed);
    }

    const mergedTasks = [];
    if (mergedHandoff) {
      const mergeIsReachable = await git(
        executionRepoPath,
        ["merge-base", "--is-ancestor", mergedHandoff.mergeCommit, preparedHead],
        { ...gitOptions, allowFailure: true },
      );
      if (!mergeIsReachable.ok) {
        result.status = "candidate_drift";
        result.integrationBlocker = `Protected target ${candidatePlan.integrationBranch} moved to ${preparedHead}, which no longer contains merged integration commit ${mergedHandoff.mergeCommit}.`;
        result.output = result.integrationBlocker;
        result.tasks = allTaskResults(candidatePlan.tasks, result.status, result.output);
        return result;
      }
      for (const task of candidatePlan.tasks) {
        const taskResult = {
          taskId: task.id,
          title: task.title,
          status: "merged",
          source: sourceLabel(task),
          sourceRef: taskSourceRef(task),
          headSha: task.expectedHeadSha,
          candidateCycle: task.candidateCycle,
          reviews: task.reviews,
          output: `Verified merged integration PR ${result.integrationPr?.url || ""} on protected target ${candidatePlan.integrationBranch} at ${preparedHead}.`,
        };
        result.tasks.push(taskResult);
        mergedTasks.push(taskResult);
      }
      result.output = appendOutput(
        result.output,
        `Verified merged integration commit ${mergedHandoff.mergeCommit} on protected target ${candidatePlan.integrationBranch} at ${preparedHead}. Source commits were not merged or pushed again.`,
      );
    } else {
      for (const task of candidatePlan.tasks) {
        const taskResult = await mergeTaskSource(executionRepoPath, task, gitOptions);
        result.tasks.push(taskResult);
        if (taskResult.status === "merged") mergedTasks.push(taskResult);
      }
    }

    const failedTaskMerge = result.tasks.find((task) => task.status !== "merged");
    if (failedTaskMerge) {
      result.status = failedTaskMerge.status === "conflict" ? "conflict" : "blocked";
      result.output = failedTaskMerge.output || `QA integration stopped before push because ${failedTaskMerge.taskId} could not be merged.`;
      return result;
    }

    if (!mergedTasks.length && !branchChanged) {
      result.status = result.tasks.some((task) => task.status === "conflict") ? "conflict" : "blocked";
      if (!candidatePlan.tasks.length) {
        result.status = "no_changes";
        result.output = result.defaultBranchSync?.output || "No QA integration changes were needed.";
        if (shouldSyncLocalPreview) {
          result.localQaPreview = await syncLocalQaPreview(candidatePlan, options);
          result.output = appendOutput(result.output, result.localQaPreview.output);
          if (localPreviewFailed(result.localQaPreview)) {
            result.status = "preview_blocked";
          }
        }
      }
      return result;
    }

    const validationCommands = normalizeList(candidatePlan.validationCommands);
    if (!validationCommands.length) {
      result.status = "validation_missing";
      result.output = "No project validationCommands are configured. The QA integration branch was not pushed or marked ready.";
      for (const task of mergedTasks) task.status = "validation_missing";
      return result;
    }

    const candidateCommit = await git(executionRepoPath, ["rev-parse", "--verify", "HEAD"], gitOptions);
    result.commit = candidateCommit.stdout.trim();
    const validationWorkspaceRoot = resolveWorkspaceRoot(
      options.projectValidationWorkspaceRoot
        || options.validationWorkspaceRoot
        || path.join(workspace.workspaceRoot, "_project-validation"),
    );
    validationSandbox = await sandboxOperations.prepare({
      sourceRepoPath: executionRepoPath,
      workspaceRoot: validationWorkspaceRoot,
      expectedHeadSha: result.commit,
      validationPath: options.projectValidationPath
        || options.path
        || process.env.MISSION_CONTROL_QA_INTEGRATION_PATH
        || DEFAULT_PROJECT_VALIDATION_PATH,
      sandboxExecutable: options.projectValidationSandboxExecutable,
      cloneTimeoutMs: options.validationCloneTimeoutMs,
      testGitRunner: options.testGitRunner,
      gitAuthEnv: options.gitAuthEnv,
      secrets: options.secrets,
    });
    result.validationSandbox = {
      policyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
      strategy: validationSandbox.strategy,
      networkPolicy: validationSandbox.networkPolicy,
      processPolicy: validationSandbox.processPolicy || "",
      expectedHeadSha: result.commit,
    };
    result.validation = await runValidationCommands(validationSandbox, validationCommands, options);
    result.validationSandbox.attestation = await sandboxOperations.verify(validationSandbox);
    const failedValidation = result.validation.find((item) => !item.ok);
    if (failedValidation) {
      result.status = "validation_failed";
      result.output = `Validation failed: ${failedValidation.command}`;
      for (const task of mergedTasks) task.status = "validation_failed";
      return result;
    }

    const executionHead = await git(executionRepoPath, ["rev-parse", "--verify", "HEAD"], gitOptions);
    const executionTree = await git(
      executionRepoPath,
      ["diff", "--quiet", "HEAD", "--"],
      qaGitOptions(options, { allowFailure: true }),
    );
    if (executionHead.stdout.trim() !== result.commit || !executionTree.ok) {
      const identityError = new Error("The trusted QA candidate changed while isolated validation was running.");
      identityError.code = "PROJECT_VALIDATION_IDENTITY_DRIFT";
      throw identityError;
    }

    if (mergedHandoff) {
      result.status = "ready";
      result.output = appendOutput(result.output, result.integrationCandidateCleanup);
      pushed = true;
      for (const task of mergedTasks) task.status = "ready";
    } else {
      await guardQaExternalMutation(executionRepoPath, candidatePlan, options, "push_integration_branch");
      const push = await git(executionRepoPath, ["push", "origin", `HEAD:refs/heads/${candidatePlan.integrationBranch}`], { ...gitOptions, allowFailure: true });
      if (!push.ok) {
        if (assemblingCandidate && protectedBranchPushRejected(push)) {
          const integrationCandidateBranch = integrationCandidateBranchName(candidatePlan, result.commit);
          const remoteCandidate = await remoteRefHead(
            executionRepoPath,
            `refs/heads/${integrationCandidateBranch}`,
            gitOptions,
          );
          if (!remoteCandidate.ok) {
            result.status = "candidate_publish_failed";
            result.output = `Protected branch ${candidatePlan.integrationBranch} requires a pull request, but StudioOps could not inspect candidate branch ${integrationCandidateBranch}: ${remoteCandidate.output}`;
            for (const task of mergedTasks) task.status = result.status;
            return result;
          }
          if (remoteCandidate.head && remoteCandidate.head !== result.commit) {
            result.status = "candidate_drift";
            result.integrationCandidateBranch = integrationCandidateBranch;
            result.integrationCandidateCommit = result.commit;
            result.integrationBlocker = `Candidate branch ${integrationCandidateBranch} changed remotely: expected ${result.commit}, observed ${remoteCandidate.head}. StudioOps will not overwrite it.`;
            result.output = result.integrationBlocker;
            for (const task of mergedTasks) task.status = result.status;
            return result;
          }
          if (!remoteCandidate.head) {
            await guardQaExternalMutation(executionRepoPath, candidatePlan, options, "push_integration_candidate_branch");
            const candidatePush = await git(
              executionRepoPath,
              ["push", "origin", `HEAD:refs/heads/${integrationCandidateBranch}`],
              { ...gitOptions, allowFailure: true },
            );
            if (!candidatePush.ok) {
              result.status = "candidate_publish_failed";
              result.output = `Protected branch ${candidatePlan.integrationBranch} requires a pull request, and the non-force candidate push to ${integrationCandidateBranch} failed.\n${truncateOutput(candidatePush.output)}`;
              for (const task of mergedTasks) task.status = result.status;
              return result;
            }
          }

          pushed = true;
          result.protectedBranchFallback = true;
          result.integrationCandidateBranch = integrationCandidateBranch;
          result.integrationCandidateCommit = result.commit;
          const pr = await ensureIntegrationPr(
            executionRepoPath,
            candidatePlan,
            integrationCandidateBranch,
            result.commit,
            options,
          );
          result.integrationPr = pr;
          result.integrationCheckState = pr.checkState;
          result.integrationBlocker = pr.blocker || (
            pr.workflowStatus === "merged"
              ? "The integration PR merged; rerun QA integration to verify the protected target and local preview."
              : ""
          );
          result.status = pr.workflowStatus === "merged" ? "pr_merged" : pr.workflowStatus;
          result.output = [
            result.output,
            `Protected branch ${candidatePlan.integrationBranch} rejected the direct non-force push; no force push was attempted.`,
            `Published exact candidate ${result.commit} to ${integrationCandidateBranch}.`,
            `Integration PR: ${pr.url}`,
            result.integrationBlocker,
          ].filter(Boolean).join("\n");
          for (const task of mergedTasks) task.status = result.status;
          return result;
        }
        result.status = "push_failed";
        result.output = `Non-force push to ${candidatePlan.integrationBranch} failed. The remote branch may have changed; rebuild a new candidate.\n${truncateOutput(push.output)}`;
        for (const task of mergedTasks) task.status = "push_failed";
        return result;
      }
      result.status = "ready";
      result.output = appendOutput(
        result.output,
        appendOutput(
          truncateOutput(push.output || `Pushed ${candidatePlan.integrationBranch}.`),
          result.integrationCandidateCleanup,
        ),
      );
      pushed = true;
      for (const task of mergedTasks) task.status = "ready";
    }
    if (shouldSyncLocalPreview) {
      await guardQaExternalMutation(executionRepoPath, candidatePlan, options, "sync_local_qa_preview");
      result.localQaPreview = await syncLocalQaPreview(candidatePlan, options);
      result.output = appendOutput(result.output, result.localQaPreview.output);
      if (localPreviewFailed(result.localQaPreview)) {
        result.status = "preview_blocked";
        for (const task of mergedTasks) task.status = "preview_blocked";
      }
    }
    if (!shouldSyncLocalPreview) {
      result.status = "preview_missing";
      result.output = appendOutput(result.output, "A healthy local QA preview is required before a candidate can be frozen.");
      for (const task of mergedTasks) task.status = "preview_missing";
      return result;
    }
    const previewConfig = localQaPreviewConfig(candidatePlan);
    if (
      result.localQaPreview?.after !== result.commit
      || !["current", "updated"].includes(result.localQaPreview?.status)
      || !previewConfig.previewUrl
      || result.localQaPreview?.attestation?.observedSha !== result.commit
    ) {
      result.status = "preview_identity_mismatch";
      result.output = appendOutput(result.output, "Local QA preview identity does not match the integration commit.");
      for (const task of mergedTasks) task.status = "preview_identity_mismatch";
      return result;
    }
    if (!assemblingCandidate) {
      result.status = "no_changes";
      result.output = appendOutput(
        result.output,
        "The configured QA branch and attested local preview were synchronized; no immutable task candidate was requested.",
      );
      return result;
    }
    const checks = result.validation.map((item, index) => ({
      id: `check_${index + 1}`,
      kind: "local-validation",
      name: `project-validation-${index + 1}`,
      outcome: item.ok ? "passed" : "failed",
      subjectSha: result.commit,
      evidenceDigest: `sha256:${createHash("sha256").update(JSON.stringify({
        command: item.command,
        ok: item.ok,
        output: stableQaOutput(item.output, result.workspacePath),
      })).digest("hex")}`,
    }));
    const candidate = createCandidateEnvelope({
      manifest: {
        candidateId,
        projectId: result.projectId,
        base: {
          branch: result.defaultBranch,
          sha: result.baseSha,
        },
        sources: mergedTasks.map((task) => ({
          taskId: task.taskId,
          sourceRef: task.sourceRef,
          headSha: task.headSha,
          candidateCycle: task.candidateCycle,
          reviews: task.reviews,
        })),
        integration: {
          branch: result.integrationBranch,
          sha: result.commit,
        },
        checks,
        preview: {
          url: previewConfig.previewUrl,
          status: "healthy",
          commitSha: result.localQaPreview.after,
          verifiedAt: new Date().toISOString(),
          attestation: result.localQaPreview.attestation,
        },
        assembly: result.assembly,
      },
    });
    if (options.renewQaClaim) await options.renewQaClaim();
    if (options.assertQaClaim) await options.assertQaClaim();
    const candidateVerification = await verifyCandidateRepositoryState(project, candidate, gitOptions);
    if (!candidateVerification.ok) {
      result.status = candidateVerification.status === "drift"
        ? "candidate_drift"
        : "candidate_verification_unavailable";
      result.output = appendOutput(result.output, candidateVerification.reason);
      for (const task of mergedTasks) task.status = result.status;
      return result;
    }
    candidate.repositoryVerification = candidateVerification;
    result.candidate = candidate;
    return result;
  } catch (error) {
    const validationSandboxFailure = String(error?.code || "").startsWith("PROJECT_VALIDATION_");
    const dependencyAcquisitionFailure = error?.code === "PROJECT_VALIDATION_DEPENDENCY_ACQUISITION_FAILED";
    result.status = dependencyAcquisitionFailure
      ? "dependency_acquisition_failed"
      : validationSandboxFailure ? "validation_sandbox_unavailable" : "blocked";
    result.output = truncateOutput(redactPromotionValidationText(
      dependencyAcquisitionFailure
        ? `Dependency acquisition failed before isolated validation; the QA candidate was not pushed: ${error.message}`
        : validationSandboxFailure
          ? `Project validation sandbox unavailable; the QA candidate was not pushed: ${error.message}`
        : error.message,
    ));
    if (result.tasks.length) {
      for (const task of result.tasks) {
        if (task.status === "merged") {
          task.status = result.status;
          task.output = result.output;
        }
      }
    } else {
      result.tasks = allTaskResults(candidatePlan.tasks, result.status, result.output);
    }
    return result;
  } finally {
    if (validationSandbox) {
      try {
        await sandboxOperations.cleanup(validationSandbox);
      } catch (error) {
        result.output = appendOutput(result.output, `Cleanup warning: ${error.message}`);
      }
    }
    if (preparedHead && !pushed && executionRepoPath) {
      const reset = await resetPreparedIntegrationBranch(
        executionRepoPath,
        candidatePlan.integrationBranch,
        preparedHead,
        qaGitOptions(options),
      );
      if (!reset.ok) {
        result.output = appendOutput(
          result.output,
          `Cleanup warning: ${reset.output || `could not reset ${candidatePlan.integrationBranch} to ${preparedHead}`}`,
        );
      }
    }
    if (workspace?.workspacePath) {
      try {
        await safeRemoveWorkspace(workspace.workspacePath, workspace.workspaceRoot);
      } catch (error) {
        result.output = appendOutput(result.output, `Cleanup warning: ${error.message}`);
      }
    }
  }
}

function authFailureProjectResult(projectPlan, error) {
  const output = `GitHub App auth failed for QA integration: ${error.message}`;
  return {
    ...projectPlan,
    tasks: allTaskResults(projectPlan.tasks, "blocked", output),
    status: "blocked",
    output: truncateOutput(output),
    commit: "",
    validation: [],
    sourceRepoPath: projectPlan.repoPath || "",
    workspacePath: "",
    workspaceStrategy: "",
  };
}

export function githubAppLocalFallbackEnabled(input = {}) {
  return booleanOption(
    input.githubAppFallbackToLocalAuth
      ?? process.env.MISSION_CONTROL_QA_GITHUB_APP_LOCAL_FALLBACK,
    false,
  );
}

export function isGitHubAppPermissionError(error) {
  return /resource not accessible by integration|installation token.*permission|github app.*permission/i
    .test(String(error?.message || error || ""));
}

function localFallbackResultNote(result) {
  const note = "GitHub App inspection lacked the required read scope; StudioOps retried once with the configured local GitHub identity and no installation-token environment.";
  return {
    ...result,
    output: appendOutput(note, result.output),
    tasks: (result.tasks || []).map((task) => ({
      ...task,
      output: appendOutput(note, task.output),
    })),
  };
}

function validationSummary(result) {
  if (!result.validation?.length) return "";
  return result.validation
    .map((item) => `- ${item.command}: ${item.ok ? "passed" : "failed"}${item.output ? `\n${item.output}` : ""}`)
    .join("\n");
}

function workspaceSummary(result) {
  if (!result.workspacePath) return "";
  const strategy = result.workspaceStrategy ? ` (${result.workspaceStrategy})` : "";
  return `\n\nWorkspace: ${result.workspacePath}${strategy}`;
}

function localPreviewSummary(result) {
  const preview = result.localQaPreview;
  if (!preview?.enabled) return "";
  const lines = [
    "",
    "",
    `Local QA preview: ${preview.status}`,
    `- Checkout: ${preview.checkoutPath || "(not configured)"}`,
    `- Branch: ${preview.branch || result.integrationBranch || "(not configured)"}`,
  ];
  if (preview.after) lines.push(`- Commit: ${preview.after}`);
  if (preview.stashed) lines.push("- Local changes were stashed before sync.");
  for (const item of preview.restartResults || []) {
    lines.push(`- Restart ${item.label}: ${item.status}`);
  }
  if (preview.output) lines.push(`- Note: ${preview.output}`);
  return lines.join("\n");
}

function commentForTask(projectResult, taskResult) {
  const branchLine = projectResult.integrationBranchUrl
    ? `\n\nIntegration branch: ${projectResult.integrationBranchUrl}`
    : `\n\nIntegration branch: ${projectResult.integrationBranch}`;
  const workspaceLine = workspaceSummary(projectResult);
  const previewLine = localPreviewSummary(projectResult);
  const supersededLine = projectResult.supersededHandoff
    ? `\n\nSuperseded handoff: ${projectResult.supersededHandoff.prUrl} at ${projectResult.supersededHandoff.candidateCommit}. ${projectResult.supersededHandoff.cleanup}`
    : "";

  if (taskResult.status === "ready") {
    return `QA integration branch ready: merged ${taskResult.source} into ${projectResult.integrationBranch} at ${projectResult.commit}.${branchLine}${workspaceLine}${previewLine}\n\nValidation passed:\n${validationSummary(projectResult)}${supersededLine}`;
  }

  if (taskResult.status === "conflict") {
    const files = taskResult.conflicts?.length ? taskResult.conflicts.map((file) => `- ${file}`).join("\n") : "- Git did not report conflicted file names.";
    return `QA integration blocked: merging ${taskResult.source} into ${projectResult.integrationBranch} produced conflicts. No changes were pushed.${workspaceLine}\n\nConflicts:\n${files}\n\nUpdate the PR branch or resolve the conflict, then rerun \`npm run qa-integrate -- --project ${projectResult.projectKey}\`.`;
  }

  if (taskResult.status === "validation_failed") {
    return `QA integration validation failed after merging ${taskResult.source} into ${projectResult.integrationBranch}. No changes were pushed.${branchLine}${workspaceLine}\n\nValidation:\n${validationSummary(projectResult)}`;
  }

  if (taskResult.status === "validation_missing") {
    return `QA integration paused after merging ${taskResult.source}: the project has no validationCommands configured, so StudioOps did not push or mark the QA bundle ready.${workspaceLine}\n\nAdd validation commands and rerun \`npm run qa-integrate -- --project ${projectResult.projectKey}\`.`;
  }

  if (taskResult.status === "push_failed") {
    return `QA integration could not update ${projectResult.integrationBranch} with ${taskResult.source}. No force push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (["pr_waiting", "pr_merged", "checks_failed", "changes_requested", "pr_closed"].includes(taskResult.status)) {
    const checkState = projectResult.integrationCheckState;
    const checks = checkState
      ? `\n\nChecks: ${checkState.state} (${checkState.passed} passed, ${checkState.pending} pending, ${checkState.failed} failed)`
      : "";
    return `Protected QA branch handoff for ${taskResult.source}: ${projectResult.integrationCandidateCommit} is published on ${projectResult.integrationCandidateBranch}.${projectResult.integrationPr?.url ? `\n\nPR: ${projectResult.integrationPr.url}` : ""}${branchLine}${checks}\n\n${projectResult.integrationBlocker || projectResult.output}${supersededLine}`;
  }

  if (["candidate_drift", "candidate_publish_failed", "candidate_supersession_failed"].includes(taskResult.status)) {
    return `Protected QA branch handoff is blocked for ${taskResult.source}. StudioOps did not force-push or overwrite the remote candidate.${branchLine}${workspaceLine}\n\n${projectResult.integrationBlocker || projectResult.output}`;
  }

  if (taskResult.status === "dependency_acquisition_failed") {
    return `QA integration could not prepare the lockfile-bound dependency cache, so no validation or push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "validation_sandbox_unavailable") {
    return `QA integration stopped before repository validation or push because its fail-closed validation sandbox was unavailable. StudioOps preserved the reviewed sources and will retry after the bounded delay.${workspaceLine}\n\n${projectResult.output}`;
  }

  return `QA integration skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No merge was attempted."}${workspaceLine}${previewLine}${supersededLine}`;
}

function stableQaOutput(value, workspacePath) {
  let output = String(value || "");
  if (workspacePath) output = output.split(workspacePath).join("<qa-workspace>");
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\bduration_ms\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "duration_ms <duration>")
    .replace(/\b(elapsed|duration|time)\s*(?::|=)?\s*\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/gi, "$1=<duration>")
    .replace(/\b(ran\s+\d+\s+tests?\s+in)\s+\d+(?:\.\d+)?s\b/gi, "$1 <duration>")
    .replace(/\bpid\s*[:=]?\s*\d+\b/gi, "pid <pid>");
}

export function qaResultFingerprint(projectResult, taskResult) {
  const workspacePath = projectResult.workspacePath || "";
  const ready = taskResult.status === "ready";
  const payload = {
    taskStatus: taskResult.status || "",
    source: taskResult.source || "",
    taskOutput: ready ? "" : stableQaOutput(taskResult.output, workspacePath),
    conflicts: [...(taskResult.conflicts || [])].sort(),
    projectStatus: projectResult.status || "",
    integrationBranch: projectResult.integrationBranch || "",
    commit: projectResult.commit || "",
    integrationCandidateBranch: projectResult.integrationCandidateBranch || "",
    integrationCandidateCommit: projectResult.integrationCandidateCommit || "",
    integrationMergeCommit: projectResult.integrationMergeCommit || "",
    deferredTaskIds: projectResult.deferredTaskIds || [],
    integrationPr: projectResult.integrationPr ? {
      url: projectResult.integrationPr.url || "",
      number: projectResult.integrationPr.number || 0,
      state: projectResult.integrationPr.state || "",
      headRefOid: projectResult.integrationPr.headRefOid || "",
      mergeStateStatus: projectResult.integrationPr.mergeStateStatus || "",
      reviewDecision: projectResult.integrationPr.reviewDecision || "",
    } : null,
    integrationCheckState: projectResult.integrationCheckState || null,
    integrationBlocker: projectResult.integrationBlocker || "",
    projectOutput: ready ? "" : stableQaOutput(projectResult.output, workspacePath),
    localPreview: projectResult.localQaPreview ? {
      status: ready ? "ready" : projectResult.localQaPreview.status || "",
      before: ready ? "" : projectResult.localQaPreview.before || "",
      after: projectResult.localQaPreview.after || "",
      output: ready ? "" : stableQaOutput(projectResult.localQaPreview.output, workspacePath),
    } : null,
    validation: (projectResult.validation || []).map((item) => ({
      command: item.command || "",
      ok: !!item.ok,
      output: stableQaOutput(item.output, workspacePath),
    })),
    validationSandbox: projectResult.validationSandbox || null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function taskPatchForResult(projectResult, taskResult, now, reportFingerprint) {
  const remediationStatuses = new Set([
    "checks_failed",
    "changes_requested",
    "candidate_drift",
    "candidate_publish_failed",
    "candidate_supersession_failed",
  ]);
  const integrationStatus = remediationStatuses.has(taskResult.status)
    ? "blocked"
    : taskResult.status;
  const integrationRetryNotBefore = taskResult.status === "ready"
    ? ""
    : new Date(Date.parse(now) + DEFAULT_QA_RETRY_DELAY_MS).toISOString();
  const protectedHandoff = Boolean(
    projectResult.protectedBranchFallback
    || projectResult.integrationCandidateBranch
    || projectResult.integrationPr,
  );
  const assignedAgentRole = taskResult.status === "ready"
    ? "owner"
    : ["pr_waiting", "pr_merged", "validation_sandbox_unavailable"].includes(taskResult.status)
      ? "qa-integration-worker"
      : taskResult.status === "pr_closed"
        ? "owner"
        : "builder";
  return {
    integrationStatus,
    integrationBranch: projectResult.integrationBranch,
    integrationBranchUrl: projectResult.integrationBranchUrl,
    integrationCommit: taskResult.status === "ready" || protectedHandoff ? projectResult.commit : "",
    integrationCandidateBranch: projectResult.integrationCandidateBranch || "",
    integrationCandidateCommit: projectResult.integrationCandidateCommit || "",
    integrationPrUrl: projectResult.integrationPr?.url || "",
    integrationPrNumber: Number(projectResult.integrationPr?.number || 0),
    integrationPrState: projectResult.integrationPr?.state || "",
    integrationPrHeadSha: projectResult.integrationPr?.headRefOid || "",
    integrationPrMergeState: projectResult.integrationPr?.mergeStateStatus || "",
    integrationPrReviewDecision: projectResult.integrationPr?.reviewDecision || "",
    integrationMergeCommit: projectResult.integrationMergeCommit || "",
    integrationCheckState: projectResult.integrationCheckState || null,
    integrationBlocker: projectResult.integrationBlocker || "",
    integrationSourceHeadSha: protectedHandoff ? taskResult.headSha || "" : "",
    integrationSourceCandidateCycle: protectedHandoff ? Number(taskResult.candidateCycle || 0) : 0,
    integrationSource: taskResult.source || "",
    integrationWorkspacePath: projectResult.workspacePath || "",
    integrationWorkspaceStrategy: projectResult.workspaceStrategy || "",
    localQaPreview: projectResult.localQaPreview || null,
    integrationUpdatedAt: now,
    integrationReportFingerprint: reportFingerprint,
    integrationRetryNotBefore,
    integrationConflictFiles: taskResult.conflicts || [],
    integrationValidation: {
      status: projectResult.status,
      commands: projectResult.validation || [],
      sandbox: projectResult.validationSandbox || null,
    },
    assignedAgentRole,
    reviewerThreadId: "",
  };
}

async function recordProjectResult(projectResult, projectPlan = null, claim = null, input = {}) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    if (projectPlan && claim) {
      try {
        assertExactQaClaimInState(state, projectPlan, claim, input);
      } catch (error) {
        const current = state.meta?.qaIntegrationAttemptClaims?.[projectPlan.projectId];
        if (
          current?.claimId === claim.claimId
          && Number(current?.fence) === Number(claim.fence)
          && current.status === "active"
        ) {
          current.status = "stale";
          current.terminalAt = now;
          current.outcome = "stale_result_discarded";
        }
        return {
          recorded: false,
          stale: true,
          reason: error.message,
        };
      }
    }
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.qaBundles = state.qaBundles || [];
    state.candidates = state.candidates || [];

    for (const taskResult of projectResult.tasks || []) {
      const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
      if (!task) continue;
      const supersededHandoff = projectResult.supersededHandoff;
      if (supersededHandoff?.taskIds?.includes(task.id)) {
        task.integrationHandoffHistory = Array.isArray(task.integrationHandoffHistory)
          ? task.integrationHandoffHistory
          : [];
        const alreadyRecorded = task.integrationHandoffHistory.some((item) => (
          item.candidateCommit === supersededHandoff.candidateCommit
          && item.prUrl === supersededHandoff.prUrl
        ));
        if (!alreadyRecorded) {
          task.integrationHandoffHistory.push({
            ...supersededHandoff,
            supersededAt: now,
          });
          state.events.push({
            id: nextId(state.events, "event"),
            type: "qa_integration_handoff_superseded",
            projectId: task.projectId,
            taskId: task.id,
            message: `${task.title}: superseded QA integration handoff ${supersededHandoff.prUrl}`,
            createdAt: now,
          });
        }
      }
      const reportFingerprint = qaResultFingerprint(projectResult, taskResult);
      const reportChanged = task.integrationReportFingerprint !== reportFingerprint;
      Object.assign(task, taskPatchForResult(projectResult, taskResult, now, reportFingerprint));
      task.updatedAt = now;
      if (reportChanged) {
        state.comments.push({
          id: nextId(state.comments, "comment"),
          taskId: task.id,
          author: "StudioOps QA Integration",
          systemGenerated: true,
          kind: "qa_integration",
          body: commentForTask(projectResult, taskResult),
          createdAt: now,
        });
        state.events.push({
          id: nextId(state.events, "event"),
          type: `qa_integration_${taskResult.status}`,
          projectId: task.projectId,
          taskId: task.id,
          message: `${task.title}: QA integration ${taskResult.status}`,
          createdAt: now,
        });
      }
    }

    const readyTasks = (projectResult.tasks || []).filter((task) => task.status === "ready");
    if (projectResult.status === "ready" && readyTasks.length && projectResult.candidate) {
      const readyTaskIds = new Set(readyTasks.map((task) => task.taskId));
      for (const candidate of state.candidates) {
        if (
          candidate.projectId !== projectResult.projectId
          || candidate.id === projectResult.candidate.id
          || candidate.status !== "frozen"
          || candidate.invalidation
          || !candidate.manifest.sources.some((source) => readyTaskIds.has(source.taskId))
        ) {
          continue;
        }
        invalidateCandidate(candidate, {
          reason: `Superseded by newer candidate ${projectResult.candidate.id}.`,
          expected: candidate.manifest.integration.sha,
          observed: projectResult.candidate.manifest.integration.sha,
          invalidatedAt: now,
        });
        const supersededBundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
        if (supersededBundle) {
          supersededBundle.status = "invalidated";
          supersededBundle.updatedAt = now;
        }
        state.events.push({
          id: nextId(state.events, "event"),
          type: "candidate_invalidated",
          projectId: candidate.projectId,
          message: `${candidate.id}: superseded by ${projectResult.candidate.id}.`,
          createdAt: now,
        });
      }
      let bundle = state.qaBundles.find((item) => (
        item.projectId === projectResult.projectId
        && item.candidateId === projectResult.candidate.id
      ));
      let bundleChanged = false;
      if (!bundle) {
        bundle = {
          id: nextId(state.qaBundles, "qa_bundle"),
          projectId: projectResult.projectId,
          projectKey: projectResult.projectKey,
          projectName: projectResult.projectName,
          status: "ready",
          candidateId: projectResult.candidate.id,
          manifestDigest: projectResult.candidate.manifestDigest,
          integrationBranch: projectResult.integrationBranch,
          integrationBranchUrl: projectResult.integrationBranchUrl,
          integrationCommit: projectResult.commit,
          previewUrl: projectResult.localQaPreview?.previewUrl || "",
          previewCheckoutPath: projectResult.localQaPreview?.checkoutPath || "",
          validation: projectResult.validation || [],
          tasks: [],
          createdAt: now,
          readyAt: now,
          updatedAt: now,
          notifiedAt: "",
          notificationAttempts: 0,
          notificationRetryNotBefore: "",
        };
        state.qaBundles.push(bundle);
        projectResult.candidate.qaBundleId = bundle.id;
        state.candidates.push(projectResult.candidate);
        bundleChanged = true;
      }
      const existingTaskIds = new Set(bundle.tasks.map((item) => item.id));
      for (const taskResult of readyTasks) {
        const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
        if (!task) continue;
        task.qaBundleId = bundle.id;
        task.candidateId = projectResult.candidate.id;
        task.candidateManifestDigest = projectResult.candidate.manifestDigest;
        task.updatedAt = now;
        if (!existingTaskIds.has(task.id)) {
          bundle.tasks.push({
            id: task.id,
            title: task.title,
            prUrl: task.prUrl || "",
            branchName: task.branchName || "",
            acceptanceCriteria: task.acceptanceCriteria || [],
          });
          existingTaskIds.add(task.id);
          bundleChanged = true;
        }
      }
      if (bundleChanged) {
        const gate = candidateCompletenessGate(projectResult.candidate, state, bundle);
        if (gate.ready) {
          projectResult.candidate.qaPacket = buildOwnerQaPacket(state, projectResult.candidate, { bundle });
          bundle.qaPacket = projectResult.candidate.qaPacket;
          bundle.packetDigest = projectResult.candidate.qaPacket.packetDigest;
          enqueueOwnerQaNotificationsInState(state, projectResult.candidate, { now });
        }
        bundle.updatedAt = now;
        state.events.push({
          id: nextId(state.events, "event"),
          type: "qa_bundle_ready",
          projectId: projectResult.projectId,
          message: `${bundle.id} is ready with ${bundle.tasks.length} task(s) at ${projectResult.commit}.`,
          createdAt: now,
        });
      }
    }
    if (projectPlan && claim) {
      const current = state.meta?.qaIntegrationAttemptClaims?.[projectPlan.projectId];
      if (current?.claimId === claim.claimId && Number(current?.fence) === Number(claim.fence)) {
        current.status = "terminal";
        current.terminalAt = now;
        current.outcome = String(projectResult.status || "completed");
      }
    }
    return { recorded: true, stale: false, reason: "" };
  }, { operationName: "qa_integration.record_result" });
}

async function recordIneligibleProject(projectPlan) {
  if (!projectPlan.tasks.length || !trustLeadApprovalsEnabled(projectPlan)) return;
  const projectResult = {
    ...projectPlan,
    status: "blocked",
    output: projectPlan.skipReason,
    tasks: projectPlan.tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: "blocked",
      source: sourceLabel(task),
      output: projectPlan.skipReason,
    })),
    validation: [],
    commit: "",
  };
  await recordProjectResult(projectResult);
}

export async function runQaIntegration(input = {}) {
  input = withQaTestAdapters(input);
  const state = await readState();
  const plan = planQaIntegrations(state, input);

  if (input.dryRun || input.plan) {
    return plan;
  }

  const results = [];
  for (const projectPlan of plan.projects) {
    if (!projectPlanHasWork(projectPlan)) continue;
    if (!projectPlan.eligible) {
      await recordIneligibleProject(projectPlan);
      results.push({
        ...projectPlan,
        status: "skipped",
        output: projectPlan.skipReason,
      });
      continue;
    }
    let claimed;
    try {
      claimed = await claimQaAttempt(projectPlan, input);
    } catch (error) {
      results.push({
        ...projectPlan,
        status: "claim_stale",
        output: truncateOutput(`QA authority changed before the attempt could be claimed: ${error.message}`),
        tasks: allTaskResults(projectPlan.tasks, "claim_stale", error.message),
        validation: [],
      });
      continue;
    }
    if (!claimed.acquired) {
      results.push({
        ...projectPlan,
        status: "claim_busy",
        output: claimed.reason,
        tasks: allTaskResults(projectPlan.tasks, "claim_busy", claimed.reason),
        validation: [],
        qaClaim: claimed.claim,
      });
      continue;
    }
    let qaClaim = claimed.claim;
    const renewClaim = async () => {
      qaClaim = await renewQaAttempt(projectPlan, qaClaim, input);
      return qaClaim;
    };
    const assertClaim = async () => assertQaAttempt(projectPlan, qaClaim, input);
    let authContext = null;
    let result = null;
    try {
      await assertClaim();
      authContext = await prepareQaIntegrationAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      const authenticatedEnv = githubAppAuthEnv(authContext, input.env || {});
      result = await integrateProject(projectPlan, {
        ...input,
        env: authenticatedEnv,
        gitAuthEnv: authContext ? {
          GIT_ASKPASS: authenticatedEnv.GIT_ASKPASS,
          MISSION_CONTROL_GITHUB_TOKEN: authenticatedEnv.MISSION_CONTROL_GITHUB_TOKEN,
          MISSION_CONTROL_GIT_USERNAME: authenticatedEnv.MISSION_CONTROL_GIT_USERNAME,
        } : {},
        secrets,
        sourceRepoPath: projectPlan.repoPath,
        renewQaClaim: renewClaim,
        assertQaClaim: assertClaim,
      });
    } catch (error) {
      const canFallback = authContext
        && githubAppLocalFallbackEnabled(input)
        && isGitHubAppPermissionError(error);
      if (!canFallback) {
        result = authFailureProjectResult(projectPlan, error);
      } else {
        await cleanupGitHubAppAuth(authContext);
        authContext = null;
        try {
          result = localFallbackResultNote(await integrateProject(projectPlan, {
            ...input,
            githubAppAuth: false,
            env: { ...(input.env || {}) },
            gitAuthEnv: {},
            secrets: normalizeSecrets(input.secrets),
            sourceRepoPath: projectPlan.repoPath,
            renewQaClaim: renewClaim,
            assertQaClaim: assertClaim,
          }));
        } catch (fallbackError) {
          result = authFailureProjectResult(
            projectPlan,
            new Error(`GitHub App permission fallback also failed: ${fallbackError.message}`),
          );
        }
      }
    } finally {
      await cleanupGitHubAppAuth(authContext);
    }
    const recorded = await recordProjectResult(result, projectPlan, qaClaim, input);
    if (!recorded.recorded) {
      result.status = "stale_result_discarded";
      result.output = truncateOutput(
        `QA integration result was discarded without overwriting newer state: ${recorded.reason}`,
      );
      result.tasks = allTaskResults(projectPlan.tasks, "stale_result_discarded", result.output);
    }
    results.push(result);
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: false,
    projects: results,
    taskCount: results.reduce((count, project) => count + (project.tasks || []).length, 0),
  };
}

export function formatQaIntegrationReport(report) {
  const lines = [
    `StudioOps QA integration sweep (${report.generatedAt})${report.dryRun ? " DRY RUN" : ""}`,
    `Projects: ${(report.projects || []).length}  Tasks: ${report.taskCount || 0}`,
    "",
  ];

  if (!report.projects?.length) {
    lines.push("No projects matched.");
    return lines.join("\n");
  }

  for (const project of report.projects) {
    lines.push(`[${project.projectKey}] ${project.projectName || project.projectKey}`);
    lines.push(`  QA branch: ${project.integrationBranch || "(not configured)"}`);
    if (project.integrationBranchUrl) lines.push(`  Link: ${project.integrationBranchUrl}`);
    if (project.workspacePath) {
      const strategy = project.workspaceStrategy ? ` (${project.workspaceStrategy})` : "";
      lines.push(`  Workspace: ${project.workspacePath}${strategy}`);
    }
    if (!project.eligible) lines.push(`  Skipped: ${project.skipReason || project.output || "not eligible"}`);
    else if (project.status) lines.push(`  Status: ${project.status}`);
    if (project.output) lines.push(`  Note: ${project.output}`);
    if (project.defaultBranchSync) {
      lines.push(`  Default branch sync: ${project.defaultBranchSync.status}${project.defaultBranchSync.changed ? " (changed)" : ""}`);
      if (project.defaultBranchSync.conflicts?.length) {
        lines.push(`    Conflicts: ${project.defaultBranchSync.conflicts.join(", ")}`);
      }
    }
    if (project.localQaPreview?.enabled) {
      lines.push(`  Local QA preview: ${project.localQaPreview.status || "configured"} ${project.localQaPreview.checkoutPath || ""}`.trimEnd());
      for (const item of project.localQaPreview.restartResults || []) {
        lines.push(`    Restart ${item.label}: ${item.status}`);
      }
    }
    for (const task of project.tasks || []) {
      const taskId = task.taskId || task.id;
      lines.push(`  - ${taskId}: ${task.status || task.integrationStatus || "pending"} ${task.title || ""}`.trimEnd());
      if (task.conflicts?.length) lines.push(`    Conflicts: ${task.conflicts.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
