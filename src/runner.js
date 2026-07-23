import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  cleanupGitHubAppAuth,
  createSecretRedactor,
  formatGitHubAppAuthForLog,
  formatGitHubAppAuthForPrompt,
  githubAppAuthEnv,
  githubAppAuthSecrets,
  parseGitHubRepoUrl,
  prepareGitHubAppAuth,
  redactSecrets,
} from "./github-app-auth.js";
import { withGitRepositoryLock } from "./git-lock.js";
import { activeSelfUpdateLease } from "./self-update-lease.js";
import {
  architectureIsCompleteInState,
  DATA_DIR,
  findProject,
  findTask,
  mutateState,
  readState,
} from "./store.js";
import { laneProfile, laneProfilesConflict } from "./work-lanes.js";
import { DEFAULT_EXECUTION_POLICY, resolveExecutionPolicy } from "./execution-policy.js";
import { readDiskAvailability } from "./worker-heartbeat.js";
import { defaultStudioOpsWorkspaceRoot, missionControlRoot } from "./runtime-paths.js";
import { normalizeProjectWorkflowMode } from "./config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_BINS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_OUTPUT_DIR = path.join(DATA_DIR, "run-outputs");
const DEFAULT_WORKSPACE_ROOT = defaultStudioOpsWorkspaceRoot("run");
const RUNNABLE_GROUPS = new Set(["architect", "builder", "reviewer"]);
const RUNNABLE_STATUSES = new Set(["queued"]);
const ACTIVE_STATUSES = new Set(["running"]);
const SUPPORTED_PROVIDERS = new Set(["codex-cli", "codex-sdk"]);
const BLOCKED_QA_INTEGRATION_STATUSES = new Set(["conflict", "validation_failed", "push_failed", "preview_blocked", "blocked"]);
const BRANCH_WRITER_ACTIONS = new Set(["start_builder", "start_builder_fix", "return_to_builder", "qa_integration_blocked", "unblock_task"]);
const ARCHITECTURE_GATED_ACTIONS = new Set(["start_builder", "start_builder_fix", "return_to_builder", "unblock_task"]);
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RUNNER_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");

function nextId(items, prefix) {
  const max = (items || [])
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProvider(value) {
  const provider = String(value || "codex-cli").trim();
  if (!provider || provider === "prompt-outbox") return "codex-cli";
  return SUPPORTED_PROVIDERS.has(provider) ? provider : "codex-cli";
}

export function resolveCodexBin(input = {}) {
  const explicit = String(input.codexBin || process.env.MISSION_CONTROL_CODEX_BIN || "").trim();
  if (explicit) return explicit;
  return DEFAULT_CODEX_BINS.find((candidate) => existsSync(candidate)) || "codex";
}

function pidIsAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function activeRunStaleReason(run, input = {}) {
  if (run.completedAt) return "completed_at_recorded";
  const nowMs = Number(input.nowMs || Date.now());
  const startedMs = Date.parse(run.startedAt || "");
  const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : 0;
  const pidGraceMs = Math.max(1_000, Number(input.pidGraceMs || 30_000));
  if (ageMs >= pidGraceMs && run.runnerPid && !pidIsAlive(run.runnerPid)) {
    return `runner_pid_not_alive:${run.runnerPid}`;
  }
  const staleRunMs = Math.max(60_000, Number(run.staleRunMs || input.staleRunMs || DEFAULT_EXECUTION_POLICY.staleRunMs));
  if (ageMs > staleRunMs) return `run_exceeded_${staleRunMs}ms`;
  return "";
}

function projectAllowed(run, project, options) {
  const onlyProjects = normalizeList(options.project || options.projects);
  if (!onlyProjects.length) return true;
  return onlyProjects.includes(project?.key) || onlyProjects.includes(project?.id) || onlyProjects.includes(run.projectId);
}

function runLaneContext(state, run) {
  const task = findTask(state, run.taskId);
  if (!task) return null;
  const profile = laneProfile(task, run);
  return {
    id: run.id,
    taskId: run.taskId,
    projectId: run.projectId || task.projectId,
    lane: profile.lane,
    conflictGroup: profile.conflictGroup,
    fileScope: profile.fileScope,
  };
}

function activeLaneContexts(state, extraRuns = []) {
  return [
    ...(state.runs || []).filter((run) => ACTIVE_STATUSES.has(run.status)),
    ...extraRuns,
  ].map((run) => runLaneContext(state, run)).filter(Boolean);
}

function findRunnableLaneConflict(state, run, extraRuns = []) {
  const current = runLaneContext(state, run);
  if (!current) return null;
  return activeLaneContexts(state, extraRuns).find((item) => laneProfilesConflict(current, item)) || null;
}

function staleRunReason(state, run) {
  const task = findTask(state, run.taskId);
  if (!task) return "task_missing";
  if (
    run.actionType !== "start_architecture"
    && (task.type === "epic" || (state.tasks || []).some((candidate) => candidate.parentTaskId === task.id))
  ) {
    return "tracking_container";
  }

  if (run.actionType === "qa_integration_blocked") {
    if (task.status !== "qa_review") return `task_status_changed:${task.status || "unknown"}`;
    if (!BLOCKED_QA_INTEGRATION_STATUSES.has(task.integrationStatus)) {
      return `qa_integration_status_changed:${task.integrationStatus || "unknown"}`;
    }
    if (run.integrationStatus && run.integrationStatus !== task.integrationStatus) {
      return `qa_integration_status_changed:${run.integrationStatus}->${task.integrationStatus}`;
    }
    return "";
  }

  if (run.actionType === "start_architecture") {
    if (!["architecture_pending", "architecture_in_progress"].includes(task.status)) {
      return `task_status_changed:${task.status || "unknown"}`;
    }
    if (task.assignedAgentRole && task.assignedAgentRole !== run.role) {
      return `assignee_changed:${task.assignedAgentRole}`;
    }
    return "";
  }

  if (
    ARCHITECTURE_GATED_ACTIONS.has(run.actionType)
    && task.architectureRequired
    && !architectureIsCompleteInState(state, task)
  ) return "architecture_handoff_invalid";

  if (["start_builder", "start_builder_fix", "return_to_builder"].includes(run.actionType)) {
    if (!["queued", "in_progress"].includes(task.status)) return `task_status_changed:${task.status || "unknown"}`;
    if (task.assignedAgentRole && task.assignedAgentRole !== run.role) {
      return `assignee_changed:${task.assignedAgentRole}`;
    }
    return "";
  }

  if (run.actionType === "unblock_task") {
    if (!["queued", "in_progress"].includes(task.status)) return `task_status_changed:${task.status || "unknown"}`;
    return "";
  }

  if (["start_review", "continue_review"].includes(run.actionType)) {
    if (!String(task.status || "").includes("review")) return `task_status_changed:${task.status || "unknown"}`;
    if (task.status === "qa_review" || task.status === "user_review") return `task_status_changed:${task.status}`;
    if (task.assignedAgentRole && task.assignedAgentRole !== run.role) {
      return `assignee_changed:${task.assignedAgentRole}`;
    }
    return "";
  }

  return "";
}

function booleanOption(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function slugify(value) {
  return String(value || "run")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "run";
}

function branchNameForRun(run) {
  return String(run.branchName || `codex/${run.project?.key || run.projectId}-${run.taskId || run.id}`).trim();
}

export function resolveProjectWorkflowMode(project = {}, originUrl = "") {
  const configured = normalizeProjectWorkflowMode(project.workflowMode || "auto");
  if (configured !== "auto") return configured;
  return parseGitHubRepoUrl(project.repoUrl) || parseGitHubRepoUrl(originUrl) ? "github" : "local";
}

function preflightFailure(code, message, remediation) {
  return { ok: false, code, message, remediation };
}

function workflowAuthEnv(workflowMode, authContext, baseEnv = process.env) {
  const env = githubAppAuthEnv(authContext, baseEnv);
  if (workflowMode !== "local") return env;
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "MISSION_CONTROL_GITHUB_TOKEN",
    "MISSION_CONTROL_GITHUB_APP_AUTH",
    "MISSION_CONTROL_GITHUB_APP_ROLE",
    "MISSION_CONTROL_GITHUB_APP_SLUG",
    "MISSION_CONTROL_GITHUB_REPOSITORY",
    "MISSION_CONTROL_GIT_USERNAME",
    "GIT_ASKPASS",
    "GIT_CONFIG_PARAMETERS",
  ]) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function isBranchWriterRun(run) {
  return run.group === "builder" && BRANCH_WRITER_ACTIONS.has(run.actionType);
}

export function branchReuseSafetyReason(run, pr) {
  if (!isBranchWriterRun(run) || !run.prUrl || !pr) return "";
  const state = String(pr.state || "").toUpperCase();
  if (!state || state === "OPEN") return "";

  const branch = branchNameForRun(run);
  if (pr.headRefName && pr.headRefName !== branch) return "";

  const status = pr.mergedAt ? `merged at ${pr.mergedAt}` : state.toLowerCase();
  return `Refusing to reuse ${branch}: linked PR ${pr.url || run.prUrl} is ${status}. Create a new feature branch and PR before launching another builder run.`;
}

function resolveWorkspaceRoot(value) {
  const raw = String(value || DEFAULT_WORKSPACE_ROOT);
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    env: options.env || process.env,
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function gitOk(args, options = {}) {
  try {
    await git(args, options);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(args, options = {}) {
  try {
    return await git(args, options);
  } catch {
    return "";
  }
}

async function readLinkedPrState(run, env) {
  if (!run.prUrl || !isBranchWriterRun(run)) return null;
  try {
    const result = await execFileAsync("gh", ["pr", "view", run.prUrl, "--json", "state,mergedAt,headRefName,url"], {
      cwd: run.project.repoPath,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
}

async function assertBranchReuseIsSafe(run, env, log) {
  const pr = await readLinkedPrState(run, env);
  if (!pr) return;
  const reason = branchReuseSafetyReason(run, pr);
  if (!reason) return;
  log.write(`${reason}\n`);
  await recordUnsafeBranchReuse(run, reason);
  throw new Error(reason);
}

async function remoteBranchExists(repoPath, branch) {
  return gitOk(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], { cwd: repoPath });
}

async function resolveLocalBaseRef(repoPath, branch, defaultBranch) {
  const refs = [
    branch ? `refs/heads/${branch}` : "",
    defaultBranch ? `refs/heads/${defaultBranch}` : "",
    "HEAD",
  ].filter((value, index, items) => value && items.indexOf(value) === index);
  for (const ref of refs) {
    if (await gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoPath })) {
      return {
        ref,
        commit: await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoPath }),
      };
    }
  }
  return null;
}

async function defaultGitHubRemoteCheck(run, authContext) {
  await git(["ls-remote", "origin"], {
    cwd: run.project.repoPath,
    env: githubAppAuthEnv(authContext, process.env),
    timeout: 60_000,
  });
}

function githubCredentialFailure(error) {
  const notes = error?.message || String(error);
  return nonRetryableWorkspaceFailureReason(notes) || "github_credential_failure";
}

export async function preflightRun(run, input = {}) {
  const project = run.project || {};
  const repoPath = String(project.repoPath || "").trim();
  if (!repoPath) {
    return preflightFailure(
      "missing_repo_path",
      "The project does not have a local repository path.",
      "Set the project repoPath to the absolute path of an existing local Git repository.",
    );
  }

  let repositoryStat;
  try {
    repositoryStat = await stat(repoPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return preflightFailure(
        "repo_path_not_found",
        `The configured repository path does not exist: ${repoPath}`,
        "Update repoPath to an existing local checkout, then restore the task to its prior queue state.",
      );
    }
    return preflightFailure(
      "repo_path_inaccessible",
      `The configured repository path cannot be read: ${repoPath}`,
      "Fix the path permissions or update repoPath to a readable local checkout.",
    );
  }
  if (!repositoryStat.isDirectory()) {
    return preflightFailure(
      "repo_path_not_directory",
      `The configured repository path is not a directory: ${repoPath}`,
      "Set repoPath to the root directory of a local Git repository.",
    );
  }
  if (!await gitOk(["rev-parse", "--git-dir"], { cwd: repoPath })) {
    return preflightFailure(
      "not_git_repository",
      `The configured repository path is not a Git repository: ${repoPath}`,
      "Initialize Git in this directory or update repoPath to an existing Git checkout.",
    );
  }

  const originUrl = await gitOutput(["remote", "get-url", "origin"], { cwd: repoPath });
  if (run.group === "architect") {
    return {
      ok: true,
      workflowMode: "local",
      originUrl,
    };
  }
  const workflowMode = resolveProjectWorkflowMode(project, originUrl);
  if (workflowMode === "local") {
    const base = await resolveLocalBaseRef(
      repoPath,
      branchNameForRun(run),
      String(project.defaultBranch || "main").trim(),
    );
    if (!base) {
      return preflightFailure(
        "missing_local_base_ref",
        "The local repository has no feature branch, configured default branch, or valid HEAD commit to build from.",
        "Create an initial commit, create the configured default branch, or point the task at an existing local feature branch.",
      );
    }
    return {
      ok: true,
      workflowMode,
      originUrl,
      baseRef: base.ref,
      baseCommit: base.commit,
    };
  }

  if (!parseGitHubRepoUrl(originUrl)) {
    return preflightFailure(
      "missing_github_origin",
      "GitHub workflow mode requires an origin remote hosted on github.com.",
      "Add the GitHub repository as the origin remote, or change the project workflowMode to local.",
    );
  }

  const prepareAuth = input.prepareGitHubAppAuth || prepareGitHubAppAuth;
  const cleanupAuth = input.cleanupGitHubAppAuth || cleanupGitHubAppAuth;
  const checkRemote = input.checkGitHubRemote || defaultGitHubRemoteCheck;
  let authContext = null;
  try {
    authContext = await prepareAuth({ ...run, workflowMode, project: { ...project, workflowMode } }, input);
  } catch (error) {
    const code = githubCredentialFailure(error);
    return preflightFailure(
      code,
      `GitHub credentials could not be prepared: ${error?.message || String(error)}`,
      "Repair the configured GitHub App credentials and installation for this repository, then restore the task to its prior queue state.",
    );
  }
  try {
    await checkRemote({ ...run, workflowMode, project: { ...project, workflowMode } }, authContext, input);
  } catch (error) {
    return preflightFailure(
      "inaccessible_github_remote",
      `The GitHub origin is not accessible: ${error?.message || String(error)}`,
      "Verify the origin URL, repository access, network connection, and GitHub App installation permissions.",
    );
  } finally {
    await cleanupAuth(authContext);
  }
  return { ok: true, workflowMode, originUrl };
}

async function localBranchExists(repoPath, branch) {
  return gitOk(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoPath });
}

async function branchCheckedOut(repoPath, branch) {
  const output = await gitOutput(["worktree", "list", "--porcelain"], { cwd: repoPath });
  return output.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

async function safeRemoveWorkspace(workspacePath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, workspacePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove unsafe workspace path: ${workspacePath}`);
  }
  await rm(workspacePath, { recursive: true, force: true });
}

async function persistRunWorkspace(run, workspace) {
  run.executionRepoPath = workspace.executionRepoPath;
  run.workspacePath = workspace.workspacePath;
  run.workspaceStrategy = workspace.strategy;
  await mutateState(async (state) => {
    const liveRun = (state.runs || []).find((item) => item.id === run.id);
    if (!liveRun) return;
    liveRun.executionRepoPath = workspace.executionRepoPath;
    liveRun.workspacePath = workspace.workspacePath;
    liveRun.workspaceStrategy = workspace.strategy;
    liveRun.updatedAt = new Date().toISOString();
  });
}

async function createWorktreeWorkspace(run, workspacePath, branch, startRef, log, gitEnv) {
  const repoPath = run.project.repoPath;
  const hasLocalBranch = await localBranchExists(repoPath, branch);
  const inUse = hasLocalBranch && await branchCheckedOut(repoPath, branch);
  if (inUse) {
    throw new Error(`Branch ${branch} is already checked out in another worktree.`);
  }

  if (hasLocalBranch) {
    await git(["worktree", "add", workspacePath, branch], { cwd: repoPath, env: gitEnv });
  } else {
    await git(["worktree", "add", "-b", branch, workspacePath, startRef], { cwd: repoPath, env: gitEnv });
  }
  log.write(`Workspace strategy: git worktree\n`);
}

async function createCloneWorkspace(run, workspacePath, branch, startRef, log, gitEnv) {
  const repoPath = run.project.repoPath;
  const originUrl = await gitOutput(["remote", "get-url", "origin"], { cwd: repoPath });
  const cloneSource = cloneFallbackSource(repoPath, originUrl);
  await git(["clone", "--no-tags", cloneSource, workspacePath], { cwd: process.cwd(), timeout: 300_000, env: gitEnv });
  await git(["fetch", "origin", "--prune"], { cwd: workspacePath, timeout: 300_000, env: gitEnv });
  await git(["checkout", "-B", branch, startRef], { cwd: workspacePath, env: gitEnv });
  log.write(`Workspace strategy: isolated clone fallback\n`);
  log.write(`Clone source: ${originUrl ? "origin remote" : "local repository"}\n`);
}

async function createLocalCloneWorkspace(run, workspacePath, branch, startCommit, log, gitEnv) {
  await git(["clone", "--no-tags", "--no-hardlinks", run.project.repoPath, workspacePath], {
    cwd: process.cwd(),
    timeout: 300_000,
    env: gitEnv,
  });
  await git(["checkout", "-B", branch, startCommit], { cwd: workspacePath, env: gitEnv });
  await git(["remote", "remove", "origin"], { cwd: workspacePath, env: gitEnv });
  log.write("Workspace strategy: isolated local clone fallback\n");
  log.write("Clone source: local repository\n");
}

export function cloneFallbackSource(repoPath, originUrl) {
  return String(originUrl || "").trim() || repoPath;
}

export async function prepareRunWorkspace(run, input = {}, log, authContext = null) {
  if (run.group === "architect") {
    log.write("Workspace strategy: read-only source checkout for systems architecture\n");
    return {
      executionRepoPath: run.project.repoPath,
      workspacePath: "",
      strategy: "source-checkout",
    };
  }
  const workflowMode = run.workflowMode || resolveProjectWorkflowMode(run.project, run.preflightOriginUrl);
  const gitEnv = workflowAuthEnv(workflowMode, authContext, process.env);
  const enabled = booleanOption(
    input.useWorkspaces
      ?? input.workspaces
      ?? process.env.STUDIOOPS_USE_WORKSPACES
      ?? process.env.MISSION_CONTROL_USE_WORKSPACES,
    true,
  );
  if (!enabled && workflowMode !== "local") {
    return {
      executionRepoPath: run.project.repoPath,
      workspacePath: "",
      strategy: "source-checkout",
    };
  }

  const workspaceRoot = resolveWorkspaceRoot(
    input.workspaceRoot
      || process.env.STUDIOOPS_WORKSPACE_ROOT
      || process.env.MISSION_CONTROL_WORKSPACE_ROOT
      || DEFAULT_WORKSPACE_ROOT,
  );
  const branch = branchNameForRun(run);
  const defaultBranch = run.project.defaultBranch || "main";
  const projectKey = slugify(run.project.key || run.projectId || "project");
  const workspacePath = path.join(workspaceRoot, projectKey, `${slugify(run.id)}-${slugify(branch)}`);

  await mkdir(path.dirname(workspacePath), { recursive: true });
  await safeRemoveWorkspace(workspacePath, workspaceRoot);
  return withGitRepositoryLock(run.project.repoPath, async () => {
    log.write(`Acquired source repository Git lock: ${run.project.repoPath}\n`);
    let startRef;
    let startCommit = "";
    if (workflowMode === "github") {
      await git(["fetch", "origin", "--prune"], { cwd: run.project.repoPath, timeout: 300_000, env: gitEnv });
      await assertBranchReuseIsSafe(run, gitEnv, log);
      startRef = await remoteBranchExists(run.project.repoPath, branch)
        ? `origin/${branch}`
        : `origin/${defaultBranch}`;
    } else {
      const base = run.preflightBaseRef && run.preflightBaseCommit
        ? { ref: run.preflightBaseRef, commit: run.preflightBaseCommit }
        : await resolveLocalBaseRef(run.project.repoPath, branch, defaultBranch);
      if (!base) throw new Error("Local workspace preparation could not resolve a valid local base ref.");
      startRef = base.ref;
      startCommit = base.commit;
    }

    log.write(`Preparing isolated workspace for ${run.id}\n`);
    log.write(`Source repo: ${run.project.repoPath}\n`);
    log.write(`Workspace: ${workspacePath}\n`);
    log.write(`Branch: ${branch}\n`);
    log.write(`Start ref: ${startRef}\n`);

    if (workflowMode === "local") {
      await createLocalCloneWorkspace(run, workspacePath, branch, startCommit, log, gitEnv);
      const workspace = { executionRepoPath: workspacePath, workspacePath, strategy: "local-clone" };
      await (input.persistRunWorkspace || persistRunWorkspace)(run, workspace);
      return workspace;
    }

    try {
      await createWorktreeWorkspace(run, workspacePath, branch, startRef, log, gitEnv);
      const workspace = { executionRepoPath: workspacePath, workspacePath, strategy: "worktree" };
      await (input.persistRunWorkspace || persistRunWorkspace)(run, workspace);
      return workspace;
    } catch (error) {
      log.write(`Worktree preparation fell back to clone: ${error.message}\n`);
      await safeRemoveWorkspace(workspacePath, workspaceRoot);
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await createCloneWorkspace(run, workspacePath, branch, startRef, log, gitEnv);
      const workspace = { executionRepoPath: workspacePath, workspacePath, strategy: "clone" };
      await (input.persistRunWorkspace || persistRunWorkspace)(run, workspace);
      return workspace;
    }
  }, input.gitLock || {});
}

function withExecutionWorkspace(run, workspace) {
  return {
    ...run,
    executionRepoPath: workspace.executionRepoPath,
    workspacePath: workspace.workspacePath,
    workspaceStrategy: workspace.strategy,
    project: {
      ...run.project,
      sourceRepoPath: run.project.repoPath,
      repoPath: workspace.executionRepoPath || run.project.repoPath,
    },
  };
}

async function prepareRunAuth(run, input = {}) {
  if (run.workflowMode === "local") return null;
  const prepareAuth = input.prepareGitHubAppAuth || prepareGitHubAppAuth;
  return prepareAuth(run, input);
}

export function planRunnableRuns(state, input = {}) {
  const limit = Math.max(1, Number(input.limit || input.maxRuns || 1));
  const activeCount = (state.runs || []).filter((run) => (
    ACTIVE_STATUSES.has(run.status) && !activeRunStaleReason(run, input)
  )).length;
  const available = Math.max(0, limit - activeCount);
  const selfUpdateLease = activeSelfUpdateLease(state, input);
  const runnable = [];
  const skipped = [];
  const plannedRuns = [];

  for (const run of state.runs || []) {
    const project = findProject(state, run.projectId);
    if (!RUNNABLE_STATUSES.has(run.status)) continue;
    if (!RUNNABLE_GROUPS.has(run.group)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "not_runner_group" });
      continue;
    }
    if (selfUpdateLease) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: `self_update_in_progress:${selfUpdateLease.id}` });
      continue;
    }
    if (!projectAllowed(run, project, input)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "project_filter" });
      continue;
    }
    const task = findTask(state, run.taskId);
    if (state.meta?.operatorPause?.active && !input.ignoreOperatorPause) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "operator_pause" });
      continue;
    }
    if (project?.automationCircuit?.state === "open") {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "project_circuit_open" });
      continue;
    }
    if (task?.automationCircuit?.state === "open") {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "task_circuit_open" });
      continue;
    }
    if (Number(run.attempt || 1) > Number(run.maxAttempts || DEFAULT_EXECUTION_POLICY.maxAttempts)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "attempt_budget_exhausted" });
      continue;
    }
    const staleReason = staleRunReason(state, run);
    if (staleReason) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: `stale_run:${staleReason}` });
      continue;
    }
    const laneConflict = findRunnableLaneConflict(state, run, plannedRuns);
    if (laneConflict) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: `lane_conflict:${laneConflict.taskId || laneConflict.id}` });
      continue;
    }
    if (runnable.length >= available) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "runner_limit" });
      continue;
    }
    plannedRuns.push(run);
    runnable.push({
      ...run,
      project,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    limit,
    activeCount,
    available,
    runnable,
    skipped,
  };
}

function runnerPrompt(run, project, authContext = null) {
  const missionControlCli = path.join(MODULE_DIR, "mission-control-cli.js");
  const taskUrl = run.taskUrl || `http://127.0.0.1:4317/tasks/${run.taskId}`;
  const sourceRepoPath = project?.sourceRepoPath || project?.repoPath || "(not recorded)";
  const executionRepoPath = run.executionRepoPath || project?.repoPath || "(not recorded)";
  return `StudioOps automation run: ${run.id}

You are being launched automatically by StudioOps.

Run details:
- Run ID: ${run.id}
- Role: ${run.role}
- Action: ${run.actionType}
- Project: ${project?.name || run.projectId}
- Repository path: ${executionRepoPath}
- Source repository path: ${sourceRepoPath}
- Workspace strategy: ${run.workspaceStrategy || "source-checkout"}
- Workflow mode: ${run.workflowMode || project?.workflowMode || "auto"}
- Work lane: ${run.lane || "(not recorded)"}
- File scope: ${(run.fileScope || []).join(", ") || "(not recorded)"}
- Task: ${run.taskId}
- Task URL: ${taskUrl}
- Branch: ${run.branchName || "(not recorded)"}
- PR: ${run.prUrl || "(not recorded)"}
- Model: ${run.model || DEFAULT_EXECUTION_POLICY.model}
- Reasoning effort: ${run.modelReasoningEffort || DEFAULT_EXECUTION_POLICY.reasoningEffort}
- Attempt: ${run.attempt || 1}/${run.maxAttempts || DEFAULT_EXECUTION_POLICY.maxAttempts}

${run.workflowMode === "local"
    ? "Local project workflow:\n- GitHub App authentication is disabled for this run.\n- Do not fetch an external remote, push commits, or open/update a pull request.\n- Work only in the isolated local workspace and preserve the resulting local branch and commits."
    : formatGitHubAppAuthForPrompt(authContext)}

StudioOps CLI:
\`node ${missionControlCli}\`

Automation rules:
- This run is ${run.group === "architect" ? "a systems-architecture pass: inspect the repository and supplied assets, create/update StudioOps tasks, and record the architecture decision; do not edit product code or create a feature branch/PR" : "an implementation or review pass governed by the task prompt"}.
- You may create local branches, edit code, run validation, commit, push, and open/update a PR when the task requires it.
- Do not merge PRs.
- Do not deploy production.
- Do not send emails, push notifications, Discord messages, SMS, payment actions, toy/device actions, or other external side effects unless the task explicitly authorizes that action.
- Do not commit secrets, tokens, .env files, private user data, or unrelated changes.
- If you discover necessary follow-up work, add it to StudioOps with \`node ${missionControlCli} add-task ...\`, including user story and acceptance criteria.
- Keep code edits inside the repository path for this run. If it differs from the source repository path, you are in an isolated workspace; do not edit the source checkout directly.
- Keep edits inside the work lane and file scope unless the task comment explicitly authorizes expanding scope.
- When implementation/review work is ready, update the task and leave a clear StudioOps comment with changed files, validation, known gaps, branch/PR, and next review step.
- If blocked, add a StudioOps comment explaining the blocker and set the task to an appropriate blocked/needs_changes state.
- The runner will mark this run completed or failed based on your process exit code.
${run.workflowMode === "local"
    ? "- Local mode forbids pushes and pull requests; leave the local branch and validation evidence recorded on the task."
    : "- A successful process is not enough by itself: builders must leave the task linked to a branch and PR and move it to builder_review; reviewers must record an explicit review outcome. StudioOps verifies this handoff after the process exits."}

Original prompt:

${run.prompt || ""}
`;
}

function restoreTaskStatusForRun(run, task) {
  if (run.actionType === "start_architecture") return "architecture_pending";
  if (["start_builder_fix", "return_to_builder"].includes(run.actionType)) return "needs_changes";
  if (["start_builder", "unblock_task"].includes(run.actionType)) return "queued";
  if (run.actionType === "qa_integration_blocked") return "qa_review";
  if (["start_review", "continue_review"].includes(run.actionType)) return task.status || "builder_review";
  return task.status || "queued";
}

function reviewerRecordedOutcome(state, run) {
  const startedAt = Date.parse(run.startedAt || "");
  return (state.reviews || []).some((review) => {
    if (review.taskId !== run.taskId || review.role !== run.role) return false;
    const createdAt = Date.parse(review.createdAt || "");
    return !Number.isFinite(startedAt) || (Number.isFinite(createdAt) && createdAt >= startedAt - 1_000);
  });
}

export function successfulHandoffFailure(state, run, task) {
  if (!task) return "task_missing_after_run";
  if (run.group === "architect") {
    if (task.architectureStatus !== "completed") return "architecture_handoff_missing";
    const childTaskIds = task.architectureDecisionTaskIds || [];
    if (!childTaskIds.length) return "architecture_task_graph_missing";
    const childTasks = childTaskIds.map((taskId) => findTask(state, taskId));
    if (
      childTasks.some((child) => !child)
      || childTasks.some((child) => !architectureIsCompleteInState(state, child))
    ) return "architecture_task_graph_invalid";
    return "";
  }
  if (run.group === "builder") {
    if (task.status !== "in_progress" && task.status !== "qa_review") return "";
    if (task.branchName && task.prUrl && run.actionType !== "qa_integration_blocked") return "";
    if (run.actionType === "qa_integration_blocked" && !BLOCKED_QA_INTEGRATION_STATUSES.has(task.integrationStatus)) return "";
    return "builder_handoff_missing";
  }
  if (run.group === "reviewer" && !reviewerRecordedOutcome(state, run)) return "review_outcome_missing";
  return "";
}

function applySuccessfulHandoff(state, run, task, now) {
  if (!task) return;
  task.retryNotBefore = "";
  task.lastAutomationFailure = "";
  delete task.automationBlocker;
  if (
    run.group === "builder"
    && task.status === "in_progress"
    && task.branchName
    && task.prUrl
  ) {
    task.status = "builder_review";
    task.assignedAgentRole = "";
    task.reviewerThreadId = "";
    task.reviewCycle = Number(task.reviewCycle || 0) + 1;
    task.updatedAt = now;
  }
}

export function applyFailedRunToTask(task, run, reason, now) {
  if (!task || task.automationBlocker?.type === "configuration") return { blocked: true, retryAt: "" };
  const attempt = Math.max(1, Number(run.attempt || 1));
  const maxAttempts = Math.max(1, Number(run.maxAttempts || DEFAULT_EXECUTION_POLICY.maxAttempts));
  task.lastAutomationFailure = reason;
  task.lastAutomationFailureRunId = run.id;
  task.updatedAt = now;
  if (
    reason === "sdk_error"
    && run.provider === "codex-sdk"
    && task.preferredRunnerProvider !== "codex-cli"
  ) {
    task.preferredRunnerProvider = "codex-cli";
    task.automationAttemptEpoch = Number(task.automationAttemptEpoch || 0) + 1;
    task.automationFailover = {
      from: "codex-sdk",
      to: "codex-cli",
      reason,
      runId: run.id,
      failedOverAt: now,
    };
    task.status = restoreTaskStatusForRun(run, task);
    task.assignedAgentRole = run.group === "reviewer" ? run.role : run.group === "architect" ? "systems-architect" : "builder";
    task.retryNotBefore = new Date(Date.parse(now) + 15_000).toISOString();
    return { blocked: false, retryAt: task.retryNotBefore, failedOver: true };
  }
  if (attempt >= maxAttempts) {
    const resumeStatus = restoreTaskStatusForRun(run, task);
    task.status = "blocked";
    task.assignedAgentRole = "owner";
    task.retryNotBefore = "";
    const recoveryCount = Math.max(0, Number(task.lastAutomationRecoveryCount || 0));
    const recoveryDelayMs = Math.min(15 * 60 * 1000, 2 * 60 * 1000 * (2 ** recoveryCount));
    task.automationBlocker = {
      type: "transient",
      reason,
      runId: run.id,
      attempts: attempt,
      resumeStatus,
      blockedAt: now,
      retryAt: new Date(Date.parse(now) + recoveryDelayMs).toISOString(),
      recoveryCount,
    };
    return { blocked: true, retryAt: "" };
  }
  const backoffMs = Math.max(1_000, Number(run.retryBackoffMs || DEFAULT_EXECUTION_POLICY.retryBackoffMs)) * attempt;
  task.status = restoreTaskStatusForRun(run, task);
  task.assignedAgentRole = run.group === "reviewer" ? run.role : "builder";
  task.retryNotBefore = new Date(Date.parse(now) + backoffMs).toISOString();
  return { blocked: false, retryAt: task.retryNotBefore };
}

function runFailureComment(run, reason, disposition) {
  if (disposition.failedOver) {
    return `${run.id} failed in the Codex SDK path: ${reason}. StudioOps switched this task to the approved codex-cli provider and will retry after ${disposition.retryAt}.`;
  }
  if (disposition.blocked) {
    return `${run.id} stopped after ${run.attempt || 1}/${run.maxAttempts || DEFAULT_EXECUTION_POLICY.maxAttempts} attempts: ${reason}. Rapid retries are paused; StudioOps will run one bounded automatic recovery cycle before opening the task circuit.`;
  }
  return `${run.id} failed: ${reason}. StudioOps will retry no earlier than ${disposition.retryAt}.`;
}

async function appendTaskComment(state, run, body, now, author = "StudioOps Runner") {
  state.comments = state.comments || [];
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId: run.taskId,
    author,
    body,
    createdAt: now,
  });
}

async function recordUnsafeBranchReuse(run, reason) {
  const now = new Date().toISOString();
  await mutateState(async (state) => {
    state.events = state.events || [];
    const task = findTask(state, run.taskId);
    if (task) {
      task.status = "needs_changes";
      task.assignedAgentRole = "builder";
      task.updatedAt = now;
    }
    await appendTaskComment(
      state,
      run,
      `${run.id} blocked before launch: ${reason}`,
      now,
    );
    state.events.push({
      id: nextId(state.events, "event"),
      type: "branch_reuse_blocked",
      projectId: run.projectId,
      taskId: run.taskId,
      message: `${run.id} blocked stale branch reuse`,
      createdAt: now,
    });
  });
}

function nonRetryableWorkspaceFailureReason(notes) {
  const text = String(notes || "");
  if (/github_app_not_installed_on_repository/i.test(text)) return "github_app_not_installed_on_repository";
  if (/GitHub App credentials .* were not found/i.test(text)) return "missing_github_app_credentials";
  if (/GitHub App credentials .* invalid/i.test(text)) return "invalid_github_app_credentials";
  if (/could not read app\.json/i.test(text)) return "invalid_github_app_credentials";
  if (/private-key\.pem/i.test(text) && /not found|missing|could not read/i.test(text)) return "invalid_github_app_credentials";
  return "";
}

async function pauseTaskForAutomationConfig(run, reason, notes) {
  const now = new Date().toISOString();
  await mutateState(async (state) => {
    state.events = state.events || [];
    const task = findTask(state, run.taskId);
    if (task) {
      const resumeStatus = task.status;
      task.status = "blocked";
      task.assignedAgentRole = "owner";
      task.automationBlocker = {
        type: "configuration",
        reason,
        runId: run.id,
        resumeStatus,
        blockedAt: now,
      };
      task.updatedAt = now;
    }
    await appendTaskComment(
      state,
      run,
      `${run.id} paused automation for this task: ${reason}.\n\n${notes}\n\nFix the StudioOps runner configuration, then move the task back to the appropriate ready/review state to retry.`,
      now,
    );
    state.events.push({
      id: nextId(state.events, "event"),
      type: "automation_config_blocked",
      projectId: run.projectId,
      taskId: run.taskId,
      message: `${run.id} paused after non-retryable workspace preparation failure: ${reason}`,
      createdAt: now,
    });
  });
}

async function blockQueuedRunForPreflight(state, run, failure, now) {
  const task = findTask(state, run.taskId);
  run.status = "cancelled";
  run.exitCode = failure.code;
  // Configuration preflight is outside the worker retry budget. Clearing the
  // attempt key keeps a repaired task's first actual worker launch at attempt 1.
  run.attemptKey = "";
  run.notes = `${failure.message}\n\nRemediation: ${failure.remediation}`;
  run.completedAt = now;
  run.updatedAt = now;
  if (task) {
    const resumeStatus = restoreTaskStatusForRun(run, task);
    task.status = "blocked";
    task.assignedAgentRole = "owner";
    task.retryNotBefore = "";
    task.lastAutomationFailure = failure.code;
    task.lastAutomationFailureRunId = run.id;
    task.automationBlocker = {
      type: "configuration",
      reason: failure.code,
      message: failure.message,
      remediation: failure.remediation,
      runId: run.id,
      resumeStatus,
      blockedAt: now,
    };
    task.updatedAt = now;
  }
  const body = `${run.id} was blocked by runner preflight before a worker was claimed: ${failure.code}.\n\n${failure.message}\n\nRemediation: ${failure.remediation}`;
  await appendTaskComment(state, run, body, now);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "runner_preflight_blocked",
    projectId: run.projectId,
    taskId: run.taskId,
    message: `${run.id} blocked before claim: ${failure.code}`,
    createdAt: now,
  });
}

export async function claimRuns(input = {}) {
  const limit = Math.max(1, Number(input.limit || input.maxRuns || 1));
  const preflightState = input.state || await readState();
  const candidates = planRunnableRuns(preflightState, { ...input, limit }).runnable;
  const preflightResults = new Map();
  for (const candidate of candidates) {
    try {
      const check = input.preflightRun || preflightRun;
      preflightResults.set(candidate.id, await check(candidate, input));
    } catch (error) {
      preflightResults.set(candidate.id, preflightFailure(
        "runner_preflight_failed",
        `Runner preflight could not complete: ${error?.message || String(error)}`,
        "Review the runner logs and project configuration, then restore the task to its prior queue state.",
      ));
    }
  }
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;

  return mutate(async (state) => {
    state.runs = state.runs || [];
    state.events = state.events || [];
    state.comments = state.comments || [];
    const now = new Date().toISOString();
    const activeCount = state.runs.filter((run) => (
      ACTIVE_STATUSES.has(run.status) && !activeRunStaleReason(run, input)
    )).length;
    const available = Math.max(0, limit - activeCount);
    if (available <= 0) return [];
    if (activeSelfUpdateLease(state, input)) return [];

    const claimed = [];
    const plannedRuns = [];
    for (const run of state.runs) {
      if (claimed.length >= available) break;
      const project = findProject(state, run.projectId);
      if (!RUNNABLE_STATUSES.has(run.status)) continue;
      if (!RUNNABLE_GROUPS.has(run.group)) continue;
      if (!projectAllowed(run, project, input)) continue;
      if (state.meta?.operatorPause?.active && !input.ignoreOperatorPause) continue;
      const task = findTask(state, run.taskId);
      const safetyReason = project?.automationCircuit?.state === "open"
        ? "project_circuit_open"
        : task?.automationCircuit?.state === "open"
          ? "task_circuit_open"
          : Number(run.attempt || 1) > Number(run.maxAttempts || DEFAULT_EXECUTION_POLICY.maxAttempts)
            ? "attempt_budget_exhausted"
            : "";
      if (safetyReason) {
        run.status = "cancelled";
        run.exitCode = safetyReason;
        run.completedAt = now;
        run.updatedAt = now;
        const message = `${run.id} cancelled before launch: ${safetyReason.replaceAll("_", " ")}.`;
        await appendTaskComment(state, run, message, now);
        state.events.push({
          id: nextId(state.events, "event"),
          type: "run_cancelled",
          projectId: run.projectId,
          taskId: run.taskId,
          message,
          createdAt: now,
        });
        continue;
      }
      const staleReason = staleRunReason(state, run);
      if (staleReason) {
        run.status = "cancelled";
        run.exitCode = staleReason;
        run.completedAt = now;
        run.updatedAt = now;
        const message = `${run.id} cancelled before launch because its queued action is stale: ${staleReason}.`;
        await appendTaskComment(state, run, message, now);
        state.events.push({
          id: nextId(state.events, "event"),
          type: "run_cancelled",
          projectId: run.projectId,
          taskId: run.taskId,
          message,
          createdAt: now,
        });
        continue;
      }
      const laneConflict = findRunnableLaneConflict(state, run, plannedRuns);
      if (laneConflict) continue;
      const preflight = preflightResults.get(run.id);
      if (!preflight) continue;
      if (!preflight?.ok) {
        await blockQueuedRunForPreflight(state, run, preflight || preflightFailure(
          "runner_preflight_failed",
          "Runner preflight returned no result.",
          "Review the runner configuration and retry after correcting it.",
        ), now);
        continue;
      }

      run.status = "running";
      run.workflowMode = preflight.workflowMode;
      run.preflightOriginUrl = preflight.originUrl || "";
      run.preflightBaseRef = preflight.baseRef || "";
      run.preflightBaseCommit = preflight.baseCommit || "";
      const profile = laneProfile(findTask(state, run.taskId) || {}, run);
      run.lane = run.lane || profile.lane;
      run.conflictGroup = run.conflictGroup || profile.conflictGroup;
      run.fileScope = Array.isArray(run.fileScope) && run.fileScope.length ? run.fileScope : profile.fileScope;
      run.provider = normalizeProvider(input.provider || run.provider);
      const executionPolicy = resolveExecutionPolicy(findTask(state, run.taskId) || {}, run, input);
      run.model = run.model || executionPolicy.model || input.model;
      run.modelReasoningEffort = run.modelReasoningEffort || executionPolicy.reasoningEffort || input.modelReasoningEffort;
      run.modelSelectionReason = run.modelSelectionReason || executionPolicy.selectionReason;
      run.attempt = Math.max(1, Number(run.attempt || 1));
      run.maxAttempts = Math.max(1, Number(run.maxAttempts || executionPolicy.maxAttempts));
      run.retryBackoffMs = Math.max(1_000, Number(run.retryBackoffMs || executionPolicy.retryBackoffMs));
      run.staleRunMs = Math.max(60_000, Number(run.staleRunMs || executionPolicy.staleRunMs));
      run.startedAt = now;
      run.completedAt = "";
      run.exitCode = "";
      run.failureNotifiedAt = "";
      run.notificationFailedAt = "";
      run.notificationStatus = "";
      run.notificationChannel = "";
      run.notificationError = "";
      run.updatedAt = now;
      run.runnerPid = String(process.pid);
      run.outputPath = path.join(RUN_OUTPUT_DIR, `${run.id}.log`);
      run.lastMessagePath = path.join(RUN_OUTPUT_DIR, `${run.id}.last-message.md`);
      if (task && run.group === "architect") {
        task.status = "architecture_in_progress";
        task.assignedAgentRole = run.role;
        task.updatedAt = now;
      } else if (task && run.group === "builder" && run.actionType !== "qa_integration_blocked") {
        task.status = "in_progress";
        task.assignedAgentRole = run.role;
        task.updatedAt = now;
      }

      state.events.push({
        id: nextId(state.events, "event"),
        type: "run_claimed",
        projectId: run.projectId,
        taskId: run.taskId,
        message: `${run.id} claimed by StudioOps runner`,
        createdAt: now,
      });
      await appendTaskComment(state, run, `${run.id} started by StudioOps Runner in ${run.workflowMode} workflow mode using ${run.provider}, ${run.model}, ${run.modelReasoningEffort} reasoning (attempt ${run.attempt}/${run.maxAttempts}).`, now);
      claimed.push({
        ...run,
        project,
      });
      plannedRuns.push(run);
    }
    return claimed;
  });
}

export async function completeRun(runId, input = {}) {
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    state.events = state.events || [];
    state.comments = state.comments || [];
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const now = new Date().toISOString();
    run.status = input.status || "completed";
    run.exitCode = String(input.exitCode ?? "");
    run.completedAt = now;
    run.updatedAt = now;
    run.outputPath = input.outputPath || run.outputPath || "";
    run.lastMessagePath = input.lastMessagePath || run.lastMessagePath || "";
    run.notes = String(input.notes || run.notes || "").trim();

    const task = findTask(state, run.taskId);
    let handoffFailure = "";
    if (run.status === "completed") {
      handoffFailure = successfulHandoffFailure(state, run, task);
      if (handoffFailure) {
        run.status = "failed";
        run.exitCode = handoffFailure;
        run.notes = run.notes ? `${run.notes}\n\n${handoffFailure}` : handoffFailure;
      } else {
        applySuccessfulHandoff(state, run, task, now);
      }
    }

    let failureDisposition = null;
    if (run.status === "failed") {
      failureDisposition = applyFailedRunToTask(task, run, run.exitCode || run.notes || "runner_failed", now);
    }

    const summary = run.status === "completed"
      ? `${run.id} completed. Output: ${run.outputPath || "(not recorded)"}`
      : `${run.id} failed with exit code ${run.exitCode || "unknown"}. Output: ${run.outputPath || "(not recorded)"}`;
    await appendTaskComment(state, run, summary, now);
    if (failureDisposition) {
      await appendTaskComment(
        state,
        run,
        runFailureComment(run, run.exitCode || run.notes || "runner_failed", failureDisposition),
        now,
      );
    }

    state.events.push({
      id: nextId(state.events, "event"),
      type: run.status === "completed" ? "run_completed" : "run_failed",
      projectId: run.projectId,
      taskId: run.taskId,
      message: summary,
      createdAt: now,
    });

    return run;
  });
}

export async function reconcileStaleRuns(input = {}) {
  return mutateState(async (state) => {
    state.events = state.events || [];
    state.comments = state.comments || [];
    const now = new Date(Number(input.nowMs || Date.now())).toISOString();
    const recovered = [];
    for (const run of state.runs || []) {
      if (run.status !== "running") continue;
      const reason = activeRunStaleReason(run, input);
      if (!reason) continue;
      run.status = "failed";
      run.exitCode = `orphaned_run:${reason}`;
      run.completedAt = now;
      run.updatedAt = now;
      const task = findTask(state, run.taskId);
      const disposition = applyFailedRunToTask(task, run, run.exitCode, now);
      const message = `${run.id} recovered from stale running state: ${reason}.`;
      await appendTaskComment(state, run, `${message}\n\n${runFailureComment(run, run.exitCode, disposition)}`, now);
      state.events.push({
        id: nextId(state.events, "event"),
        type: "stale_run_recovered",
        projectId: run.projectId,
        taskId: run.taskId,
        message,
        createdAt: now,
      });
      recovered.push({ runId: run.id, taskId: run.taskId, reason, blocked: disposition.blocked });
    }
    return recovered;
  });
}

async function persistRunThread(run, threadId) {
  if (!threadId || run.threadId === threadId) return;
  run.threadId = threadId;
  await mutateState(async (state) => {
    state.runs = state.runs || [];
    state.tasks = state.tasks || [];
    state.events = state.events || [];
    const now = new Date().toISOString();
    const liveRun = state.runs.find((item) => item.id === run.id);
    if (liveRun) {
      liveRun.threadId = threadId;
      liveRun.updatedAt = now;
    }
    const task = state.tasks.find((item) => item.id === run.taskId);
    if (task) {
      if (run.group === "reviewer") task.reviewerThreadId = threadId;
      else task.assignedThreadId = threadId;
      task.updatedAt = now;
    }
    state.events.push({
      id: nextId(state.events, "event"),
      type: "run_thread_linked",
      projectId: run.projectId,
      taskId: run.taskId,
      message: `${run.id} linked to Codex thread ${threadId}`,
      createdAt: now,
    });
  });
}

export function sdkThreadOptions(run, input = {}) {
  return {
    workingDirectory: run.project.repoPath,
    sandboxMode: input.sandboxMode || "danger-full-access",
    approvalPolicy: input.approvalPolicy || "never",
    networkAccessEnabled: input.networkAccessEnabled ?? true,
    ...((run.model || input.model) ? { model: run.model || input.model } : {}),
    ...((run.modelReasoningEffort || input.modelReasoningEffort)
      ? { modelReasoningEffort: run.modelReasoningEffort || input.modelReasoningEffort }
      : {}),
    ...(input.webSearchMode ? { webSearchMode: input.webSearchMode } : {}),
  };
}

export function sdkClientOptions(input = {}, authContext = null) {
  const codexPathOverride = resolveCodexBin(input);
  const childPath = input.path || process.env.MISSION_CONTROL_RUNNER_PATH || DEFAULT_RUNNER_PATH;
  const env = workflowAuthEnv(input.workflowMode, authContext, {
    ...process.env,
    PATH: childPath,
    STUDIOOPS_ROOT: process.env.STUDIOOPS_ROOT || missionControlRoot(),
    MISSION_CONTROL_ROOT: process.env.MISSION_CONTROL_ROOT || missionControlRoot(),
    STUDIOOPS_CONFIG_ROOT: process.env.STUDIOOPS_CONFIG_ROOT || missionControlRoot(),
    MISSION_CONTROL_CONFIG_ROOT: process.env.MISSION_CONTROL_CONFIG_ROOT || missionControlRoot(),
    MISSION_CONTROL_DATA_DIR: DATA_DIR,
  });
  if (!booleanOption(input.allowApiKeyAuth, false)) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  return {
    codexPathOverride,
    env,
  };
}

async function runClaimedRunWithSdk(run, input = {}) {
  await mkdir(RUN_OUTPUT_DIR, { recursive: true });
  const timeoutMs = Math.max(60_000, Number(input.timeoutMs || process.env.MISSION_CONTROL_RUN_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS));
  const outputPath = run.outputPath || path.join(RUN_OUTPUT_DIR, `${run.id}.log`);
  const lastMessagePath = run.lastMessagePath || path.join(RUN_OUTPUT_DIR, `${run.id}.last-message.md`);
  const log = createWriteStream(outputPath, { flags: "a" });
  const controller = new AbortController();
  let finalResponse = "";
  let exitCode = 0;
  let status = "completed";
  let notes = "";
  let pauseReason = "";
  let executionRun = run;
  let authContext = null;

  const timeout = setTimeout(() => {
    log.write(`\nRunner timeout after ${Math.round(timeoutMs / 1000)}s. Aborting Codex SDK turn.\n`);
    controller.abort();
  }, timeoutMs);
  timeout.unref();

  try {
    log.write(`StudioOps SDK Runner started ${run.id} at ${new Date().toISOString()}\n`);
    log.write(`Provider: codex-sdk\n`);
    log.write(`Model: ${run.model || input.model || DEFAULT_EXECUTION_POLICY.model}\n`);
    log.write(`Reasoning: ${run.modelReasoningEffort || input.modelReasoningEffort || DEFAULT_EXECUTION_POLICY.reasoningEffort}\n`);
    authContext = run.group === "architect" ? null : await prepareRunAuth(run, input);
    log.write(formatGitHubAppAuthForLog(authContext));
    const workspace = await prepareRunWorkspace(run, input, log, authContext);
    executionRun = withExecutionWorkspace(run, workspace);
    const prompt = runnerPrompt(executionRun, executionRun.project, authContext);
    log.write(`Repo: ${executionRun.project.repoPath}\n`);
    log.write(`Existing thread: ${run.threadId || "(new thread)"}\n`);
    log.write(`Timeout: ${Math.round(timeoutMs / 1000)}s\n\n`);

    const { Codex } = await import("@openai/codex-sdk");
    const codex = new Codex(sdkClientOptions({ ...input, workflowMode: run.workflowMode }, authContext));
    const options = sdkThreadOptions(executionRun, input);
    const thread = run.threadId
      ? codex.resumeThread(run.threadId, options)
      : codex.startThread(options);
    const { events } = await thread.runStreamed(prompt, { signal: controller.signal });

    for await (const event of events) {
      log.write(`${redactSecrets(JSON.stringify(event), githubAppAuthSecrets(authContext))}\n`);
      if (event.type === "thread.started") {
        await persistRunThread(run, event.thread_id);
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalResponse = event.item.text || "";
      } else if (event.type === "turn.failed") {
        throw new Error(event.error?.message || "Codex SDK turn failed");
      } else if (event.type === "error") {
        throw new Error(event.message || "Codex SDK stream failed");
      }
    }

    if (thread.id) await persistRunThread(run, thread.id);
    notes = redactSecrets(finalResponse.trim(), githubAppAuthSecrets(authContext));
    await writeFile(lastMessagePath, notes, "utf8");
  } catch (error) {
    status = "failed";
    notes = redactSecrets(error?.message || String(error), githubAppAuthSecrets(authContext));
    pauseReason = nonRetryableWorkspaceFailureReason(notes);
    exitCode = pauseReason || (error?.name === "AbortError" ? "timeout" : "sdk_error");
    log.write(`\nCodex SDK runner error: ${notes}\n`);
    try {
      await writeFile(lastMessagePath, notes, "utf8");
    } catch {
      // Keep the run failure intact even if the summary file cannot be written.
    }
  } finally {
    clearTimeout(timeout);
    log.write(`\nStudioOps SDK Runner finished ${run.id} at ${new Date().toISOString()} with status ${status}\n`);
    log.end();
    await cleanupGitHubAppAuth(authContext);
  }

  const completed = await completeRun(run.id, {
    status,
    exitCode,
    outputPath,
    lastMessagePath,
    notes,
  });
  if (pauseReason) await pauseTaskForAutomationConfig(run, pauseReason, notes);
  return completed;
}

async function runClaimedRunWithCli(run, input = {}) {
  await mkdir(RUN_OUTPUT_DIR, { recursive: true });
  const codexBin = resolveCodexBin(input);
  const childPath = input.path || process.env.MISSION_CONTROL_RUNNER_PATH || DEFAULT_RUNNER_PATH;
  const timeoutMs = Math.max(60_000, Number(input.timeoutMs || process.env.MISSION_CONTROL_RUN_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS));
  const outputPath = run.outputPath || path.join(RUN_OUTPUT_DIR, `${run.id}.log`);
  const lastMessagePath = run.lastMessagePath || path.join(RUN_OUTPUT_DIR, `${run.id}.last-message.md`);
  const log = createWriteStream(outputPath, { flags: "a" });
  let executionRun = run;
  let prompt = "";
  let authContext = null;
  try {
    authContext = run.group === "architect" ? null : await prepareRunAuth(run, input);
    log.write(formatGitHubAppAuthForLog(authContext));
    const workspace = await prepareRunWorkspace(run, input, log, authContext);
    executionRun = withExecutionWorkspace(run, workspace);
    prompt = runnerPrompt(executionRun, executionRun.project, authContext);
  } catch (error) {
    const notes = redactSecrets(error?.message || String(error), githubAppAuthSecrets(authContext));
    log.write(`\nWorkspace preparation failed: ${notes}\n`);
    log.end();
    await cleanupGitHubAppAuth(authContext);
    try {
      await writeFile(lastMessagePath, notes, "utf8");
    } catch {
      // Keep the run failure intact even if the summary file cannot be written.
    }
    const completed = await completeRun(run.id, {
      status: "failed",
      exitCode: nonRetryableWorkspaceFailureReason(notes) || "workspace_error",
      outputPath,
      lastMessagePath,
      notes,
    });
    const pauseReason = nonRetryableWorkspaceFailureReason(notes);
    if (pauseReason) await pauseTaskForAutomationConfig(run, pauseReason, notes);
    return completed;
  }
  const args = [
    "exec",
    "--model",
    run.model || input.model || DEFAULT_EXECUTION_POLICY.model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(run.modelReasoningEffort || input.modelReasoningEffort || DEFAULT_EXECUTION_POLICY.reasoningEffort)}`,
    "--cd",
    executionRun.project.repoPath,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    lastMessagePath,
    "-",
  ];

  return new Promise((resolve) => {
    let settled = false;
    const secrets = githubAppAuthSecrets(authContext);
    const stdoutRedactor = createSecretRedactor(secrets);
    const stderrRedactor = createSecretRedactor(secrets);
    log.write(`StudioOps Runner started ${run.id} at ${new Date().toISOString()}\n`);
    log.write(`Command: ${codexBin} ${args.join(" ")}\n\n`);
    log.write(`PATH: ${childPath}\n`);
    log.write(`Repo: ${executionRun.project.repoPath}\n`);
    log.write(`Source repo: ${executionRun.project.sourceRepoPath || run.project.repoPath}\n`);
    log.write(`Workspace strategy: ${executionRun.workspaceStrategy || "source-checkout"}\n`);
    log.write(`Timeout: ${Math.round(timeoutMs / 1000)}s\n\n`);
    const child = spawn(codexBin, args, {
      cwd: executionRun.project.repoPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: workflowAuthEnv(run.workflowMode, authContext, {
        ...process.env,
        PATH: childPath,
        MISSION_CONTROL_RUN_ID: run.id,
        MISSION_CONTROL_TASK_ID: run.taskId,
        MISSION_CONTROL_WORKSPACE_PATH: executionRun.project.repoPath,
        MISSION_CONTROL_SOURCE_REPO_PATH: executionRun.project.sourceRepoPath || run.project.repoPath,
        MISSION_CONTROL_WORK_LANE: run.lane || "",
        STUDIOOPS_ROOT: process.env.STUDIOOPS_ROOT || missionControlRoot(),
        MISSION_CONTROL_ROOT: process.env.MISSION_CONTROL_ROOT || missionControlRoot(),
        STUDIOOPS_CONFIG_ROOT: process.env.STUDIOOPS_CONFIG_ROOT || missionControlRoot(),
        MISSION_CONTROL_CONFIG_ROOT: process.env.MISSION_CONTROL_CONFIG_ROOT || missionControlRoot(),
        MISSION_CONTROL_DATA_DIR: DATA_DIR,
        MISSION_CONTROL_RUN_MODEL: run.model || input.model || DEFAULT_EXECUTION_POLICY.model,
        MISSION_CONTROL_RUN_REASONING_EFFORT: run.modelReasoningEffort || input.modelReasoningEffort || DEFAULT_EXECUTION_POLICY.reasoningEffort,
      }),
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      log.write(`\nRunner timeout after ${Math.round(timeoutMs / 1000)}s. Sending SIGTERM to child process.\n`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          log.write("\nRunner child did not exit after SIGTERM. Sending SIGKILL.\n");
          child.kill("SIGKILL");
        }
      }, 10_000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => stdoutRedactor.write(chunk, (text) => log.write(text)));
    child.stderr.on("data", (chunk) => stderrRedactor.write(chunk, (text) => log.write(text)));
    child.on("error", async (error) => {
      settled = true;
      clearTimeout(timeout);
      stdoutRedactor.flush((text) => log.write(text));
      stderrRedactor.flush((text) => log.write(text));
      const notes = redactSecrets(error.message, secrets);
      log.write(`\nRunner spawn error: ${notes}\n`);
      log.end();
      await cleanupGitHubAppAuth(authContext);
      const completed = await completeRun(run.id, {
        status: "failed",
        exitCode: "spawn_error",
        outputPath,
        lastMessagePath,
        notes,
      });
      resolve(completed);
    });
    child.on("close", async (code) => {
      settled = true;
      clearTimeout(timeout);
      let notes = "";
      try {
        notes = redactSecrets((await readFile(lastMessagePath, "utf8")).trim(), secrets);
        if (notes) await writeFile(lastMessagePath, notes, "utf8");
      } catch {
        notes = "";
      }
      stdoutRedactor.flush((text) => log.write(text));
      stderrRedactor.flush((text) => log.write(text));
      log.write(`\nStudioOps Runner finished ${run.id} at ${new Date().toISOString()} with code ${code}\n`);
      log.end();
      await cleanupGitHubAppAuth(authContext);
      const completed = await completeRun(run.id, {
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
        outputPath,
        lastMessagePath,
        notes,
      });
      resolve(completed);
    });
    child.stdin.end(prompt);
  });
}

export async function runClaimedRun(run, input = {}) {
  const provider = normalizeProvider(input.provider || run.provider);
  if (provider === "codex-sdk") return runClaimedRunWithSdk(run, input);
  return runClaimedRunWithCli(run, input);
}

export async function runQueuedRuns(input = {}) {
  const disk = input.disk || await readDiskAvailability({
    ...input,
    path: DATA_DIR,
  });
  if (disk.pressure) {
    return {
      generatedAt: new Date().toISOString(),
      disk,
      paused: true,
      pauseReason: "disk_space_below_safety_threshold",
      recovered: [],
      claimed: [],
      results: [],
    };
  }
  const state = await readState();
  if (state.meta?.operatorPause?.active && !input.ignoreOperatorPause) {
    return {
      generatedAt: new Date().toISOString(),
      disk,
      paused: true,
      pauseReason: state.meta.operatorPause.reason || "operator_pause",
      recovered: [],
      claimed: [],
      results: [],
    };
  }
  const recovered = await reconcileStaleRuns(input);
  const claimed = await claimRuns(input);
  const results = await Promise.all(claimed.map((run) => runClaimedRun(run, input)));
  return {
    generatedAt: new Date().toISOString(),
    disk,
    recovered,
    claimed: claimed.map((run) => run.id),
    results,
  };
}

export function formatRunnerReport(report) {
  const lines = [
    `StudioOps runner sweep (${report.generatedAt})`,
    `Recovered: ${(report.recovered || []).length}  Claimed: ${report.claimed.length}  Finished: ${report.results.length}`,
    "",
  ];
  if (report.paused) {
    lines.push(
      `Automation paused: ${report.pauseReason}.`,
      `Available disk: ${report.disk?.availableBytes || 0} bytes (${report.disk?.availablePercent || 0}%).`,
    );
    return lines.join("\n");
  }
  for (const item of report.recovered || []) {
    lines.push(`[recovered] ${item.runId}: ${item.reason}${item.blocked ? " (retry limit reached)" : ""}`);
  }
  if (report.recovered?.length) lines.push("");
  if (!report.claimed.length) {
    lines.push("No queued runs claimed.");
    return lines.join("\n");
  }
  for (const run of report.results) {
    lines.push(`[${run.id}] ${run.status}${run.exitCode ? ` (${run.exitCode})` : ""}`);
    lines.push(`  Task: ${run.taskId}`);
    if (run.outputPath) lines.push(`  Output: ${run.outputPath}`);
    if (run.lastMessagePath) lines.push(`  Last message: ${run.lastMessagePath}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatRunnerPlan(plan) {
  const lines = [
    `StudioOps runner plan (${plan.generatedAt})`,
    `Limit: ${plan.limit}  Active: ${plan.activeCount}  Available: ${plan.available}  Runnable: ${plan.runnable.length}`,
    "",
  ];
  if (!plan.runnable.length) {
    lines.push("No queued builder/reviewer runs are ready for this runner.");
  }
  for (const run of plan.runnable) {
    lines.push(`[${run.id}] ${run.role} ${run.actionType}`);
    lines.push(`  Project: ${run.project?.key || run.projectId}`);
    lines.push(`  Task: ${run.taskId}`);
    lines.push(`  Repo: ${run.project?.repoPath || "(missing)"}`);
    lines.push(`  Provider: ${normalizeProvider(run.provider)}`);
    lines.push(`  Model: ${run.model || DEFAULT_EXECUTION_POLICY.model} (${run.modelReasoningEffort || DEFAULT_EXECUTION_POLICY.reasoningEffort})`);
    if (run.threadId) lines.push(`  Thread: ${run.threadId}`);
    lines.push("");
  }
  const skippedSummary = (plan.skipped || []).reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  const skippedText = Object.entries(skippedSummary)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  if (skippedText) lines.push(`Skipped: ${skippedText}`);
  return lines.join("\n").trimEnd();
}
