import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  automationCircuitIsOpen,
  cancelQueuedRuns,
  findProject,
  mutateState,
  readState,
} from "./store.js";
import { defaultStudioOpsWorkspaceRoot } from "./runtime-paths.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_QA_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_QA_WORKSPACE_ROOT = defaultStudioOpsWorkspaceRoot("qa");
const DEFAULT_QA_INTEGRATION_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");

function childEnv(options = {}) {
  return {
    ...process.env,
    PATH: options.path || process.env.MISSION_CONTROL_QA_INTEGRATION_PATH || DEFAULT_QA_INTEGRATION_PATH,
    ...(options.env || {}),
  };
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
    branch: normalizeBranchName(config.branch || projectPlan.integrationBranch),
    createIfMissing: booleanOption(config.createIfMissing, false),
    stashDirty: booleanOption(config.stashDirty, false),
    postUpdateCommands: normalizeList(config.postUpdateCommands || config.commands),
    restartLaunchAgents: normalizeList(config.restartLaunchAgents || config.agents),
    launchAgentPlists: config.launchAgentPlists || {},
    previewUrl: String(config.previewUrl || config.url || "").trim(),
    healthCheckUrl: String(config.healthCheckUrl || config.healthUrl || config.previewUrl || config.url || "").trim(),
  };
}

function localPreviewFailed(preview) {
  return ["blocked", "post_update_failed", "restart_failed", "health_check_failed"].includes(preview?.status);
}

function syncDefaultBranchEnabled(projectPlan) {
  const config = qaIntegrationConfig(projectPlan);
  return booleanOption(
    config.syncDefaultBranchIntoIntegration ?? config.syncDefaultBranch,
    false,
  );
}

function isGitHubRepoUrl(value) {
  const raw = String(value || "").trim();
  return /^https:\/\/github\.com\//i.test(raw)
    || /^git@github\.com:/i.test(raw)
    || /^ssh:\/\/git@github\.com\//i.test(raw);
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
  const prepareAuth = input.prepareGitHubAppAuth || prepareGitHubAppAuth;
  return prepareAuth(
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

const QA_PROJECT_FAILURE_DETAILS = Object.freeze({
  qa_integration_invalid_github_credentials: {
    normalizedReason: "QA-integration GitHub App credentials are invalid.",
    remediation: "Repair the qa-integration-worker GitHub App app ID, private key, and repository installation.",
  },
  qa_integration_missing_github_credentials: {
    normalizedReason: "QA-integration GitHub App credentials are missing.",
    remediation: "Install credentials for the qa-integration-worker GitHub App role.",
  },
  qa_integration_github_auth_failure: {
    normalizedReason: "QA-integration GitHub App authentication failed.",
    remediation: "Repair the qa-integration-worker GitHub App credentials and repository installation.",
  },
  qa_integration_missing_origin: {
    normalizedReason: "The QA-integration repository has no origin remote.",
    remediation: "Configure the project repository origin used by QA integration.",
  },
  qa_integration_remote_inaccessible: {
    normalizedReason: "The QA-integration GitHub remote is inaccessible.",
    remediation: "Repair the origin URL, network access, TLS trust, or qa-integration-worker repository permissions.",
  },
});

function qaProjectFailure(reasonCode) {
  const details = QA_PROJECT_FAILURE_DETAILS[reasonCode];
  if (!details) return null;
  return {
    scope: "project",
    reasonCode,
    ...details,
    failureFingerprint: createHash("sha256")
      .update(`project:${reasonCode}`)
      .digest("hex")
      .slice(0, 20),
    nextCheapProbe: "Prepare the qa-integration-worker GitHub App identity and run authenticated `git ls-remote origin` without launching a model.",
    probeKind: "qa_integration_preflight",
    probeRole: "qa-integration-worker",
    probeOperation: "git ls-remote origin",
  };
}

export function classifyQaIntegrationProjectFailure(value, stage = "remote") {
  const text = String(value?.message || value?.output || value || "");
  if (stage === "auth") {
    if (/were not found|not found|missing/i.test(text)) {
      return qaProjectFailure("qa_integration_missing_github_credentials");
    }
    if (/invalid|could not read app\.json|private-key\.pem|private key/i.test(text)) {
      return qaProjectFailure("qa_integration_invalid_github_credentials");
    }
    return qaProjectFailure("qa_integration_github_auth_failure");
  }
  if (/must have an origin remote|missing.*origin|no .*origin remote/i.test(text)) {
    return qaProjectFailure("qa_integration_missing_origin");
  }
  if (
    /authentication failed|bad credentials|could not read username|permission denied|repository not found|could not read from remote|unable to access|could not resolve host|connection (?:refused|reset|timed out)|network is unreachable|tls|ssl|certificate|http\s+(?:401|403)/i.test(text)
  ) {
    return qaProjectFailure("qa_integration_remote_inaccessible");
  }
  return null;
}

export async function probeQaIntegrationProject(project, input = {}) {
  const projectPlan = {
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    repoPath: project.repoPath,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    qaIntegration: project.qaIntegration || {},
    integrationBranch: integrationBranchName(project),
  };
  const cleanupAuth = input.cleanupGitHubAppAuth || cleanupGitHubAppAuth;
  let authContext = null;
  let stage = "auth";
  try {
    authContext = await prepareQaIntegrationAuth(projectPlan, input);
    stage = "remote";
    const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
    const env = githubAppAuthEnv(authContext, input.env || {});
    const origin = await git(projectPlan.repoPath, ["remote", "get-url", "origin"], {
      allowFailure: true,
      env,
      secrets,
    });
    if (!origin.ok || !origin.output.trim()) {
      return { ok: false, ...qaProjectFailure("qa_integration_missing_origin") };
    }
    const checkRemote = input.checkQaIntegrationRemote;
    const remote = checkRemote
      ? await checkRemote({
          project,
          projectPlan,
          authContext,
          role: "qa-integration-worker",
          operation: "git ls-remote origin",
          env,
          secrets,
        })
      : await git(projectPlan.repoPath, ["ls-remote", "origin"], {
          allowFailure: true,
          env,
          secrets,
          timeoutMs: 60_000,
        });
    if (remote?.ok === false) {
      const failure = classifyQaIntegrationProjectFailure(remote, "remote")
        || qaProjectFailure("qa_integration_remote_inaccessible");
      return { ok: false, ...failure };
    }
    return {
      ok: true,
      scope: "project",
      projectId: project.id,
      workflowMode: "github",
      role: "qa-integration-worker",
      operation: "git ls-remote origin",
    };
  } catch (error) {
    const failure = classifyQaIntegrationProjectFailure(error, stage)
      || qaProjectFailure(stage === "auth"
        ? "qa_integration_github_auth_failure"
        : "qa_integration_remote_inaccessible");
    return { ok: false, ...failure };
  } finally {
    await cleanupAuth(authContext);
  }
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: childEnv(options),
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

function git(repoPath, args, options = {}) {
  return runCommand("git", args, {
    cwd: repoPath,
    ...options,
  });
}

async function safeRemoveWorkspace(workspacePath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, workspacePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove unsafe QA workspace path: ${workspacePath}`);
  }
  await rm(workspacePath, { recursive: true, force: true });
}

async function copyGitConfigValue(sourceRepoPath, workspacePath, key) {
  const value = await git(sourceRepoPath, ["config", "--get", key], { allowFailure: true });
  if (!value.ok || !value.output.trim()) return;
  await git(workspacePath, ["config", key, value.output.trim()]);
}

async function copyGitIdentity(sourceRepoPath, workspacePath) {
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.name");
  await copyGitConfigValue(sourceRepoPath, workspacePath, "user.email");
}

async function configureWorkspaceOrigin(sourceRepoPath, workspacePath, originUrl) {
  const fetchUrl = String(originUrl || "").trim();
  await git(workspacePath, ["remote", "set-url", "origin", fetchUrl]);

  const pushUrlResult = await git(sourceRepoPath, ["remote", "get-url", "--push", "--all", "origin"], { allowFailure: true });
  const pushUrls = pushUrlResult.ok
    ? pushUrlResult.output.split("\n").map((item) => item.trim()).filter(Boolean)
    : [];
  if (pushUrls.length === 0 || (pushUrls.length === 1 && pushUrls[0] === fetchUrl)) return;

  await git(workspacePath, ["remote", "set-url", "--push", "origin", pushUrls[0]]);
  for (const pushUrl of pushUrls.slice(1)) {
    await git(workspacePath, ["remote", "set-url", "--add", "--push", "origin", pushUrl]);
  }
}

async function seedLocalBranchFromSourceClone(workspacePath, branchName) {
  if (!branchName || await localBranchExists(workspacePath, branchName)) return;
  const clonedSourceRef = `refs/remotes/origin/${branchName}`;
  const sourceBranch = await git(workspacePath, ["rev-parse", "--verify", clonedSourceRef], { allowFailure: true });
  if (!sourceBranch.ok) return;
  await git(workspacePath, ["branch", branchName, clonedSourceRef], { allowFailure: true });
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

  const originUrl = await git(sourceRepoPath, ["remote", "get-url", "origin"], { allowFailure: true });
  if (!originUrl.ok || !originUrl.output.trim()) {
    throw new Error("Project repoPath must have an origin remote before QA integration can fetch source branches or push integration updates.");
  }

  const projectSegment = workspaceSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const branchSegment = workspaceSegment(projectPlan.integrationBranch || "qa");
  const workspaceParent = path.join(workspaceRoot, projectSegment);

  await mkdir(workspaceParent, { recursive: true });
  const workspacePath = await mkdtemp(path.join(workspaceParent, `${branchSegment}-`));

  try {
    await runCommand("git", ["clone", "--shared", "--no-tags", sourceRepoPath, workspacePath], {
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    });
    await seedLocalBranchFromSourceClone(workspacePath, projectPlan.integrationBranch);
    await configureWorkspaceOrigin(sourceRepoPath, workspacePath, originUrl.output);
    await copyGitIdentity(sourceRepoPath, workspacePath);
    return {
      executionRepoPath: workspacePath,
      workspacePath,
      workspaceRoot,
      strategy: "isolated_clone",
    };
  } catch (error) {
    await safeRemoveWorkspace(workspacePath, workspaceRoot);
    throw error;
  }
}

async function localBranchExists(repoPath, branchName, options = {}) {
  const result = await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { allowFailure: true });
  return result.ok;
}

async function remoteBranchExists(repoPath, branchName, options = {}) {
  const fetchResult = await git(repoPath, ["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`], { ...options, allowFailure: true });
  if (fetchResult.ok) return true;
  const result = await git(repoPath, ["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], { allowFailure: true });
  return result.ok;
}

async function prepareIntegrationBranch(repoPath, project, branchName, options = {}) {
  await git(repoPath, ["check-ref-format", "--branch", branchName]);

  const hasLocalBranch = await localBranchExists(repoPath, branchName, options);
  const hasRemoteBranch = await remoteBranchExists(repoPath, branchName, options);

  if (hasLocalBranch) {
    await git(repoPath, ["checkout", branchName]);
    if (hasRemoteBranch) {
      const fastForward = await git(repoPath, ["merge", "--ff-only", `refs/remotes/origin/${branchName}`], { allowFailure: true });
      if (!fastForward.ok) {
        throw new Error(`Local integration branch ${branchName} cannot fast-forward to origin/${branchName}. Resolve or push local branch work before running QA integration.`);
      }
    }
    return hasRemoteBranch ? "updated_local_branch" : "using_local_branch";
  }

  if (hasRemoteBranch) {
    await git(repoPath, ["checkout", "-b", branchName, `refs/remotes/origin/${branchName}`]);
    return "checked_out_remote_branch";
  }

  const baseBranch = normalizeBranchName(project.defaultBranch || "main");
  const baseFetch = await git(repoPath, ["fetch", "origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { ...options, allowFailure: true });
  if (!baseFetch.ok) {
    throw new Error(`Could not fetch default branch origin/${baseBranch} to create ${branchName}: ${baseFetch.output}`);
  }
  await git(repoPath, ["checkout", "-b", branchName, `refs/remotes/origin/${baseBranch}`]);
  return "created_branch";
}

async function currentBranchName(repoPath) {
  const branch = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return branch.ok ? normalizeBranchName(branch.output) : "";
}

async function resetPreparedIntegrationBranch(repoPath, branchName, preparedHead) {
  if (!preparedHead) return { ok: true, output: "" };

  const currentBranch = await currentBranchName(repoPath);
  if (currentBranch !== branchName) {
    return {
      ok: false,
      output: `Refusing to reset ${branchName}: current checkout is ${currentBranch || "detached HEAD"}.`,
    };
  }

  return git(repoPath, ["reset", "--keep", preparedHead], { allowFailure: true });
}

async function fetchTaskSource(repoPath, task, options = {}) {
  const localRef = `refs/mission-control/tasks/${safeRefSegment(task.id)}`;
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
    error: errors.length ? errors.join("\n") : "Task needs a branch name or GitHub PR URL before QA integration can fetch a source ref.",
  };
}

async function conflictFiles(repoPath) {
  const result = await git(repoPath, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
  return result.output ? result.output.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

async function branchHead(repoPath, ref, options = {}) {
  const result = await git(repoPath, ["rev-parse", "--verify", ref], { ...options, allowFailure: true });
  return result.ok ? result.output.trim() : "";
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
    const conflicts = await conflictFiles(repoPath);
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

  await mkdir(path.dirname(checkoutPath), { recursive: true });
  const clone = await runCommand("git", ["clone", "--shared", "--no-tags", projectPlan.repoPath, checkoutPath], {
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    allowFailure: true,
    ...options,
  });
  if (!clone.ok) {
    return {
      ok: false,
      output: `Could not create local QA preview checkout: ${truncateOutput(clone.output)}`,
    };
  }

  const originUrl = await git(projectPlan.repoPath, ["remote", "get-url", "origin"], { ...options, allowFailure: true });
  if (originUrl.ok && originUrl.output.trim()) {
    await configureWorkspaceOrigin(projectPlan.repoPath, checkoutPath, originUrl.output);
  }
  return { ok: true, created: true };
}

export function classifyPreviewHealthFailure(error, response = null) {
  if (response) {
    return {
      diagnosticCode: "preview_http_status",
      message: `Preview returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
      remediation: "Inspect the preview application logs and health route; restore a successful 2xx response before rerunning the cheap probe.",
      httpStatus: response.status,
    };
  }
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  const message = String(error?.message || error || "Unknown preview connection failure.");
  if (
    code.includes("CERT")
    || code.includes("TLS")
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || /certificate|tls|ssl/i.test(message)
  ) {
    return {
      diagnosticCode: "preview_tls_error",
      message: `TLS validation failed: ${message}`,
      remediation: "Repair the local certificate trust chain, hostname, or HTTPS configuration; do not disable TLS verification globally.",
    };
  }
  if (code === "ECONNREFUSED" || /connection refused|fetch failed/i.test(message) && code === "ECONNREFUSED") {
    return {
      diagnosticCode: "preview_connection_refused",
      message: `The preview process refused the connection: ${message}`,
      remediation: "Start or restart the configured preview process and verify it is listening on the health-check host and port.",
    };
  }
  if (code === "ETIMEDOUT" || error?.name === "TimeoutError" || error?.name === "AbortError" || /timed? out/i.test(message)) {
    return {
      diagnosticCode: "preview_connection_timeout",
      message: `The preview health request timed out: ${message}`,
      remediation: "Check whether the preview process is hung, overloaded, or bound to a different address/port.",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      diagnosticCode: "preview_dns_error",
      message: `The preview hostname could not be resolved: ${message}`,
      remediation: "Correct the health-check hostname or local DNS/hosts configuration.",
    };
  }
  return {
    diagnosticCode: "preview_connection_error",
    message,
    remediation: "Inspect the preview process, host/port binding, and local network path before rerunning the cheap probe.",
  };
}

export async function probePreviewHealth(url, options = {}) {
  const healthCheckUrl = String(url || "").trim();
  if (!healthCheckUrl) {
    return {
      ok: false,
      status: "health_check_missing",
      diagnosticCode: "preview_health_url_missing",
      message: "No local QA preview health-check URL is configured.",
      remediation: "Configure localQaPreview.healthCheckUrl with a local non-production health endpoint.",
      attempts: 0,
    };
  }
  const attempts = Math.max(1, Number(options.healthAttempts || options.attempts || 1));
  const timeoutMs = Math.max(250, Number(options.healthTimeoutMs || options.timeoutMs || 5_000));
  const delayMs = Math.max(0, Number(options.healthRetryDelayMs ?? options.retryDelayMs ?? 1_000));
  const fetchImpl = options.fetch || globalThis.fetch;
  let lastDiagnostic = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthCheckUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        return {
          ok: true,
          status: "healthy",
          diagnosticCode: "preview_healthy",
          message: `Preview health probe returned HTTP ${response.status}.`,
          remediation: "",
          httpStatus: response.status,
          attempts: attempt,
          url: healthCheckUrl,
          probedAt: new Date().toISOString(),
        };
      }
      lastDiagnostic = classifyPreviewHealthFailure(null, response);
    } catch (error) {
      lastDiagnostic = classifyPreviewHealthFailure(error);
    }
    if (attempt < attempts && delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return {
    ok: false,
    status: "health_check_failed",
    ...lastDiagnostic,
    attempts,
    url: healthCheckUrl,
    probedAt: new Date().toISOString(),
  };
}

export async function probeProjectQaPreview(project, options = {}) {
  const preview = localQaPreviewConfig({
    ...project,
    projectId: project.id || project.projectId,
    projectKey: project.key || project.projectKey,
    integrationBranch: project.integrationBranch || integrationBranchName(project),
  });
  if (!preview.enabled) {
    return {
      ok: false,
      status: "preview_disabled",
      diagnosticCode: "preview_disabled",
      message: "Local QA preview is not enabled for this project.",
      remediation: "Enable localQaPreview or use an explicit owner circuit reset after manual verification.",
      attempts: 0,
    };
  }
  return probePreviewHealth(preview.healthCheckUrl, options);
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
    healthProbe: null,
  };
  if (!preview.enabled) return result;
  if (!preview.branch) {
    result.status = "blocked";
    result.output = "Local QA preview branch is not configured.";
    return result;
  }

  const gitOptions = { env: options.env, secrets: options.secrets };
  const ensured = await ensureLocalQaPreviewCheckout(projectPlan, preview, gitOptions);
  result.created = Boolean(ensured.created);
  if (!ensured.ok) {
    result.status = "blocked";
    result.output = ensured.output;
    return result;
  }

  const dirty = await git(preview.checkoutPath, ["status", "--porcelain"], { ...gitOptions, allowFailure: true });
  if (!dirty.ok) {
    result.status = "blocked";
    result.output = `Could not inspect local QA preview checkout: ${truncateOutput(dirty.output)}`;
    return result;
  }
  if (dirty.output.trim()) {
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

  const currentBranch = await currentBranchName(preview.checkoutPath);
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

  if (preview.healthCheckUrl) {
    result.healthProbe = await probePreviewHealth(preview.healthCheckUrl, {
      ...options,
      healthAttempts: options.healthAttempts || 8,
    });
    if (!result.healthProbe.ok) {
      result.status = "health_check_failed";
      result.output = `Local QA preview health check failed at ${preview.healthCheckUrl}: ${result.healthProbe.diagnosticCode}. ${result.healthProbe.message} Remediation: ${result.healthProbe.remediation}`;
      return result;
    }
  }

  result.status = result.before && result.after && result.before !== result.after ? "updated" : "current";
  result.output = result.status === "updated"
    ? `Local QA preview updated to ${result.after}.`
    : "Local QA preview already current.";
  return result;
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

async function runValidationCommands(repoPath, commands, options) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand("sh", ["-lc", command], {
      cwd: repoPath,
      env: options.env,
      secrets: options.secrets,
      timeoutMs: Number(options.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
      allowFailure: true,
    });
    results.push({
      command,
      ok: result.ok,
      output: truncateOutput(result.output),
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

function retryWindowElapsed(task, nowMs) {
  const retryAt = Date.parse(task.integrationRetryNotBefore || "");
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

export function planQaIntegrations(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const projectPlans = (state.projects || [])
    .filter((project) => projectMatches(project, input))
    .map((project) => {
      const integrationBranch = integrationBranchName(project);
      const safetyError = integrationBranchSafetyError(project);
      const trustEnabled = trustLeadApprovalsEnabled(project);
      const circuitOpen = automationCircuitIsOpen(project);
      const pendingTasks = (circuitOpen ? [] : state.tasks || [])
        .filter((task) => task.projectId === project.id)
        .filter((task) => task.status === "qa_review")
        .filter((task) => input.force || task.integrationStatus !== "ready")
        .filter((task) => taskMatches(task, input));
      const previewOnlyTasks = input.force
        ? []
        : pendingTasks.filter((task) => (
            task.integrationStatus === "preview_blocked"
            && task.integrationCommit
          ));
      const previewOnlyIds = new Set(previewOnlyTasks.map((task) => task.id));
      const tasks = pendingTasks
        .filter((task) => !previewOnlyIds.has(task.id))
        .filter((task) => input.force || retryWindowElapsed(task, nowMs));
      const previewTasks = previewOnlyTasks.filter((task) => retryWindowElapsed(task, nowMs));
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
        eligible: !circuitOpen && projectUsesTrustLeadQa(project),
        skipReason: circuitOpen
          ? `Project automation circuit is open: ${project.automationCircuit.reasonCode || "configuration failure"}.`
          : trustEnabled ? safetyError : "trustLeadApprovals is disabled.",
        automationCircuitOpen: circuitOpen,
        integrationBranch,
        integrationBranchUrl: branchWebUrl(project, integrationBranch),
        validationCommands: normalizeList(project.validationCommands),
        deferredTaskCount: pendingTasks.length - tasks.length - previewTasks.length,
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          branchName: task.branchName || "",
          prUrl: task.prUrl || "",
          integrationStatus: task.integrationStatus || "",
          integrationRetryNotBefore: task.integrationRetryNotBefore || "",
        })),
        previewTasks: previewTasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          branchName: task.branchName || "",
          prUrl: task.prUrl || "",
          integrationStatus: task.integrationStatus || "",
          integrationCommit: task.integrationCommit || "",
          integrationSource: task.integrationSource || sourceLabel(task),
          integrationRetryNotBefore: task.integrationRetryNotBefore || "",
        })),
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    projects: projectPlans,
    taskCount: projectPlans.reduce((count, project) => count + project.tasks.length + project.previewTasks.length, 0),
  };
}

export function projectPlanHasWork(projectPlan) {
  if (projectPlan.automationCircuitOpen) return false;
  if (projectPlan.tasks.length) return true;
  if (projectPlan.previewTasks?.length) return true;
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

async function integrateProject(projectPlan, options = {}) {
  const project = {
    id: projectPlan.projectId,
    key: projectPlan.projectKey,
    name: projectPlan.projectName,
    repoPath: projectPlan.repoPath,
    repoUrl: projectPlan.repoUrl,
    defaultBranch: projectPlan.defaultBranch,
    integrationBranch: projectPlan.integrationBranch,
  };
  const repoPath = String(project.repoPath || "").trim();
  const result = {
    ...projectPlan,
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
  };
  const shouldSyncDefaultBranch = syncDefaultBranchEnabled(projectPlan);
  const shouldSyncLocalPreview = localQaPreviewConfig(projectPlan).enabled;

  if (!projectPlan.tasks.length && projectPlan.previewTasks?.length) {
    const healthProbe = await probeProjectQaPreview(projectPlan, {
      ...options,
      healthAttempts: options.healthAttempts || 1,
    });
    const previewConfig = localQaPreviewConfig(projectPlan);
    result.previewProbeOnly = true;
    result.commit = projectPlan.previewTasks[0]?.integrationCommit || "";
    result.localQaPreview = {
      enabled: previewConfig.enabled,
      status: healthProbe.ok ? "current" : "health_check_failed",
      checkoutPath: previewConfig.checkoutPath || "",
      branch: previewConfig.branch || projectPlan.integrationBranch,
      previewUrl: previewConfig.previewUrl || "",
      healthCheckUrl: previewConfig.healthCheckUrl || "",
      healthProbe,
      output: healthProbe.ok
        ? healthProbe.message
        : `${healthProbe.diagnosticCode}: ${healthProbe.message} Remediation: ${healthProbe.remediation}`,
    };
    result.status = healthProbe.ok ? "ready" : "preview_blocked";
    result.output = healthProbe.ok
      ? `Already integrated branch ${projectPlan.integrationBranch} passed a cheap non-model preview health probe; feature branches were not rebuilt or remerged.`
      : `Already integrated branch ${projectPlan.integrationBranch} remains preview-blocked after a cheap non-model probe: ${result.localQaPreview.output}`;
    result.tasks = projectPlan.previewTasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: healthProbe.ok ? "ready" : "preview_blocked",
      source: task.integrationSource || sourceLabel(task),
      output: result.output,
    }));
    return result;
  }

  if (!projectPlan.tasks.length && !shouldSyncDefaultBranch && !shouldSyncLocalPreview) {
    result.status = "no_tasks";
    return result;
  }

  if (!path.isAbsolute(repoPath)) {
    result.status = "blocked";
    result.output = "Project repoPath must be an absolute local path before QA integration can run.";
    result.tasks = projectPlan.tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: "blocked",
      source: sourceLabel(task),
      output: result.output,
    }));
    return result;
  }

  if (!projectPlan.tasks.length && !shouldSyncDefaultBranch && shouldSyncLocalPreview) {
    result.localQaPreview = await syncLocalQaPreview(projectPlan, options);
    result.status = localPreviewFailed(result.localQaPreview)
      ? "preview_blocked"
      : "preview_ready";
    result.output = result.localQaPreview.output;
    return result;
  }

  let workspace = null;
  let executionRepoPath = "";
  let preparedHead = "";
  let pushed = false;
  try {
    workspace = await prepareQaWorkspace(repoPath, projectPlan, options);
    executionRepoPath = workspace.executionRepoPath;
    result.workspacePath = workspace.workspacePath;
    result.workspaceStrategy = workspace.strategy;

    const gitOptions = { env: options.env, secrets: options.secrets };
    const prepared = await prepareIntegrationBranch(executionRepoPath, project, projectPlan.integrationBranch, gitOptions);
    result.output = prepared;
    const preparedCommit = await git(executionRepoPath, ["rev-parse", "--verify", "HEAD"]);
    preparedHead = preparedCommit.output.trim();

    let branchChanged = false;
    if (shouldSyncDefaultBranch) {
      result.defaultBranchSync = await mergeDefaultBranchIntoIntegration(executionRepoPath, projectPlan, gitOptions);
      if (!result.defaultBranchSync.ok) {
        result.status = result.defaultBranchSync.status || "blocked";
        result.output = result.defaultBranchSync.output;
        result.tasks = result.tasks.length
          ? result.tasks
          : allTaskResults(projectPlan.tasks, result.status, result.output);
        return result;
      }
      branchChanged = Boolean(result.defaultBranchSync.changed);
    }

    const mergedTasks = [];
    for (const task of projectPlan.tasks) {
      const taskResult = await mergeTaskSource(executionRepoPath, task, gitOptions);
      result.tasks.push(taskResult);
      if (taskResult.status === "merged") mergedTasks.push(taskResult);
    }

    const failedTaskMerge = result.tasks.find((task) => task.status !== "merged");
    if (failedTaskMerge) {
      result.status = failedTaskMerge.status === "conflict" ? "conflict" : "blocked";
      result.output = failedTaskMerge.output || `QA integration stopped before push because ${failedTaskMerge.taskId} could not be merged.`;
      return result;
    }

    if (!mergedTasks.length && !branchChanged) {
      result.status = result.tasks.some((task) => task.status === "conflict") ? "conflict" : "blocked";
      if (!projectPlan.tasks.length) {
        result.status = "no_changes";
        result.output = result.defaultBranchSync?.output || "No QA integration changes were needed.";
        if (shouldSyncLocalPreview) {
          result.localQaPreview = await syncLocalQaPreview(projectPlan, options);
          result.output = appendOutput(result.output, result.localQaPreview.output);
          if (localPreviewFailed(result.localQaPreview)) {
            result.status = "preview_blocked";
          }
        }
      }
      return result;
    }

    const validationCommands = normalizeList(projectPlan.validationCommands);
    if (!validationCommands.length) {
      result.status = "validation_missing";
      result.output = "No project validationCommands are configured. The QA integration branch was not pushed or marked ready.";
      for (const task of mergedTasks) task.status = "validation_missing";
      return result;
    }

    result.validation = await runValidationCommands(executionRepoPath, validationCommands, options);
    const failedValidation = result.validation.find((item) => !item.ok);
    if (failedValidation) {
      result.status = "validation_failed";
      result.output = `Validation failed: ${failedValidation.command}`;
      for (const task of mergedTasks) task.status = "validation_failed";
      return result;
    }

    const commit = await git(executionRepoPath, ["rev-parse", "--verify", "HEAD"]);
    result.commit = commit.output.trim();

    const push = await git(executionRepoPath, ["push", "origin", `HEAD:refs/heads/${projectPlan.integrationBranch}`], { ...gitOptions, allowFailure: true });
    if (!push.ok) {
      result.status = "push_failed";
      result.output = `Non-force push to ${projectPlan.integrationBranch} failed. The remote branch may have changed; rerun QA integration after fetching/reconciling it.\n${truncateOutput(push.output)}`;
      result.projectCircuitFailure = classifyQaIntegrationProjectFailure(push, "remote");
      for (const task of mergedTasks) task.status = "push_failed";
      return result;
    }

    result.status = "ready";
    result.output = truncateOutput(push.output || `Pushed ${projectPlan.integrationBranch}.`);
    pushed = true;
    for (const task of mergedTasks) task.status = "ready";
    if (shouldSyncLocalPreview) {
      result.localQaPreview = await syncLocalQaPreview(projectPlan, options);
      result.output = appendOutput(result.output, result.localQaPreview.output);
      if (localPreviewFailed(result.localQaPreview)) {
        result.status = "preview_blocked";
        for (const task of mergedTasks) task.status = "preview_blocked";
      }
    }
    return result;
  } catch (error) {
    result.status = "blocked";
    result.output = truncateOutput(error.message);
    result.projectCircuitFailure = classifyQaIntegrationProjectFailure(error, "remote");
    result.tasks = result.tasks.length ? result.tasks : allTaskResults(projectPlan.tasks, "blocked", error.message);
    return result;
  } finally {
    if (preparedHead && !pushed && executionRepoPath) {
      const reset = await resetPreparedIntegrationBranch(executionRepoPath, projectPlan.integrationBranch, preparedHead);
      if (!reset.ok) {
        result.output = appendOutput(
          result.output,
          `Cleanup warning: ${reset.output || `could not reset ${projectPlan.integrationBranch} to ${preparedHead}`}`,
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
  const projectCircuitFailure = classifyQaIntegrationProjectFailure(error, "auth");
  const output = `${projectCircuitFailure.normalizedReason} ${projectCircuitFailure.remediation}`;
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
    projectCircuitFailure,
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
  if (preview.healthProbe) {
    lines.push(`- Health diagnostic: ${preview.healthProbe.diagnosticCode || preview.healthProbe.status}`);
    if (preview.healthProbe.remediation) lines.push(`- Health remediation: ${preview.healthProbe.remediation}`);
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

  if (taskResult.status === "ready") {
    if (projectResult.previewProbeOnly) {
      return `QA preview repair probe passed for the already-integrated ${projectResult.integrationBranch} commit ${projectResult.commit}. No feature branch was rebuilt or remerged, and no model run was launched.${branchLine}${previewLine}`;
    }
    return `QA integration branch ready: merged ${taskResult.source} into ${projectResult.integrationBranch} at ${projectResult.commit}.${branchLine}${workspaceLine}${previewLine}\n\nValidation passed:\n${validationSummary(projectResult)}`;
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

  return `QA integration skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No merge was attempted."}${workspaceLine}${previewLine}`;
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
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function taskPatchForResult(projectResult, taskResult, now, reportFingerprint) {
  const integrationRetryNotBefore = taskResult.status === "ready"
    ? ""
    : new Date(Date.parse(now) + DEFAULT_QA_RETRY_DELAY_MS).toISOString();
  const integratedCommit = (
    taskResult.status === "ready"
    || (taskResult.status === "preview_blocked" && projectResult.commit)
    || projectResult.previewProbeOnly
  ) ? projectResult.commit || "" : "";
  return {
    integrationStatus: taskResult.status,
    integrationBranch: projectResult.integrationBranch,
    integrationBranchUrl: projectResult.integrationBranchUrl,
    integrationCommit: integratedCommit,
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
    },
    assignedAgentRole: taskResult.status === "ready" ? "owner" : "builder",
    reviewerThreadId: "",
  };
}

export async function openQaIntegrationProjectCircuitInState(state, projectResult, input = {}) {
  const failure = projectResult.projectCircuitFailure;
  if (!failure) return null;
  const project = findProject(state, projectResult.projectId || projectResult.projectKey);
  if (!project) return null;
  const now = input.now || new Date(Number(input.nowMs || Date.now())).toISOString();
  const alreadyOpen = automationCircuitIsOpen(project);
  await cancelQueuedRuns({
    state,
    project: project.id,
    reason: `Project circuit opened for ${failure.reasonCode}; cancelled before model launch.`,
    nowMs: Date.parse(now),
  });

  const affectedTaskIds = [...new Set(
    (projectResult.tasks || []).map((task) => task.taskId || task.id).filter(Boolean),
  )];
  project.automationCircuit = {
    state: "open",
    scope: "project",
    reasonCode: failure.reasonCode,
    normalizedReason: failure.normalizedReason,
    failureFingerprint: failure.failureFingerprint,
    attemptsConsumed: 0,
    failureOccurrences: alreadyOpen
      ? Number(project.automationCircuit.failureOccurrences || 1) + 1
      : 1,
    openedAt: alreadyOpen ? project.automationCircuit.openedAt : now,
    remediation: failure.remediation,
    nextCheapProbe: failure.nextCheapProbe,
    probeKind: failure.probeKind,
    probeRole: failure.probeRole,
    probeOperation: failure.probeOperation,
    affectedTaskIds,
    resumeAction: `Run \`studioops circuit-probe --project ${project.key}\`; this uses the qa-integration-worker identity and does not launch a model.`,
  };
  project.updatedAt = now;

  for (const taskId of affectedTaskIds) {
    const task = (state.tasks || []).find((candidate) => candidate.id === taskId);
    if (!task) continue;
    const resumeIntegrationStatus = ["blocked", "push_failed"].includes(task.integrationStatus)
      ? ""
      : task.integrationStatus || "";
    task.status = "blocked";
    task.assignedAgentRole = "owner";
    task.retryNotBefore = "";
    task.automationBlocker = {
      type: "project_circuit",
      reason: failure.reasonCode,
      projectId: project.id,
      resumeStatus: "qa_review",
      resumeIntegrationStatus,
      blockedAt: now,
    };
    task.updatedAt = now;
  }

  state.comments = state.comments || [];
  state.events = state.events || [];
  if (!alreadyOpen && affectedTaskIds[0]) {
    state.comments.push({
      id: nextId(state.comments, "comment"),
      taskId: affectedTaskIds[0],
      author: "StudioOps Circuit Breaker",
      systemGenerated: true,
      kind: "automation_circuit",
      body: `Project automation circuit opened for ${failure.reasonCode}.\n\nNormalized root cause: ${failure.normalizedReason}\nRemediation: ${failure.remediation}\nNext cheap probe: ${failure.nextCheapProbe}\n\nNo builder or reviewer model work will launch for this project until the role-specific probe succeeds or the owner explicitly resets the circuit.`,
      createdAt: now,
    });
  }
  state.events.push({
    id: nextId(state.events, "event"),
    type: "qa_integration_project_circuit_opened",
    projectId: project.id,
    taskId: affectedTaskIds[0] || "",
    message: `${project.key} QA-integration project circuit opened for ${failure.reasonCode}.`,
    createdAt: now,
  });
  return project.automationCircuit;
}

async function recordProjectResult(projectResult) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.qaBundles = state.qaBundles || [];

    for (const taskResult of projectResult.tasks || []) {
      const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
      if (!task) continue;
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

    if (projectResult.projectCircuitFailure) {
      await openQaIntegrationProjectCircuitInState(state, projectResult, { now });
    }

    const readyTasks = (projectResult.tasks || []).filter((task) => task.status === "ready");
    if (projectResult.status === "ready" && readyTasks.length) {
      let bundle = state.qaBundles.find((item) => (
        item.projectId === projectResult.projectId
        && item.integrationCommit === projectResult.commit
      ));
      let bundleChanged = false;
      if (!bundle) {
        bundle = {
          id: nextId(state.qaBundles, "qa_bundle"),
          projectId: projectResult.projectId,
          projectKey: projectResult.projectKey,
          projectName: projectResult.projectName,
          status: "ready",
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
        bundleChanged = true;
      }
      const existingTaskIds = new Set(bundle.tasks.map((item) => item.id));
      for (const taskResult of readyTasks) {
        const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
        if (!task) continue;
        task.qaBundleId = bundle.id;
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
  });
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
    let authContext = null;
    let result = null;
    const cleanupAuth = input.cleanupGitHubAppAuth || cleanupGitHubAppAuth;
    try {
      const previewProbeOnly = !projectPlan.tasks.length && projectPlan.previewTasks?.length;
      authContext = previewProbeOnly ? null : await prepareQaIntegrationAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      result = await integrateProject(projectPlan, {
        ...input,
        env: githubAppAuthEnv(authContext, input.env || {}),
        secrets,
      });
      if (
        !result.projectCircuitFailure
        && ["blocked", "push_failed"].includes(result.status)
      ) {
        result.projectCircuitFailure = classifyQaIntegrationProjectFailure(result.output, "remote");
      }
    } catch (error) {
      result = authFailureProjectResult(projectPlan, error);
    } finally {
      await cleanupAuth(authContext);
    }
    await recordProjectResult(result);
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
      if (project.localQaPreview.healthProbe) {
        lines.push(`    Diagnostic: ${project.localQaPreview.healthProbe.diagnosticCode || project.localQaPreview.healthProbe.status}`);
        if (project.localQaPreview.healthProbe.remediation) {
          lines.push(`    Remediation: ${project.localQaPreview.healthProbe.remediation}`);
        }
      }
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
