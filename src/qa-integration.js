import { execFile } from "node:child_process";
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
import { mutateState, readState } from "./store.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_QA_WORKSPACE_ROOT = path.join(os.homedir(), ".mission-control", "qa-workspaces");
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
    let healthError = "";
    let healthy = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await fetch(preview.healthCheckUrl, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          healthy = true;
          break;
        }
        healthError = `HTTP ${response.status}`;
      } catch (error) {
        healthError = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!healthy) {
      result.status = "health_check_failed";
      result.output = `Local QA preview health check failed at ${preview.healthCheckUrl}: ${healthError}`;
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

export function planQaIntegrations(state, input = {}) {
  const projectPlans = (state.projects || [])
    .filter((project) => projectMatches(project, input))
    .map((project) => {
      const integrationBranch = integrationBranchName(project);
      const safetyError = integrationBranchSafetyError(project);
      const trustEnabled = trustLeadApprovalsEnabled(project);
      const tasks = (state.tasks || [])
        .filter((task) => task.projectId === project.id)
        .filter((task) => task.status === "qa_review")
        .filter((task) => input.force || task.integrationStatus !== "ready")
        .filter((task) => taskMatches(task, input));
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
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          branchName: task.branchName || "",
          prUrl: task.prUrl || "",
          integrationStatus: task.integrationStatus || "",
        })),
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    projects: projectPlans,
    taskCount: projectPlans.reduce((count, project) => count + project.tasks.length, 0),
  };
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

  if (taskResult.status === "ready") {
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

function taskPatchForResult(projectResult, taskResult, now) {
  return {
    integrationStatus: taskResult.status,
    integrationBranch: projectResult.integrationBranch,
    integrationBranchUrl: projectResult.integrationBranchUrl,
    integrationCommit: taskResult.status === "ready" ? projectResult.commit : "",
    integrationSource: taskResult.source || "",
    integrationWorkspacePath: projectResult.workspacePath || "",
    integrationWorkspaceStrategy: projectResult.workspaceStrategy || "",
    localQaPreview: projectResult.localQaPreview || null,
    integrationUpdatedAt: now,
    integrationConflictFiles: taskResult.conflicts || [],
    integrationValidation: {
      status: projectResult.status,
      commands: projectResult.validation || [],
    },
    assignedAgentRole: taskResult.status === "ready" ? "owner" : "builder",
    reviewerThreadId: "",
  };
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
      Object.assign(task, taskPatchForResult(projectResult, taskResult, now));
      task.updatedAt = now;
      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "StudioOps QA Integration",
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

    const readyTasks = (projectResult.tasks || []).filter((task) => task.status === "ready");
    if (projectResult.status === "ready" && readyTasks.length) {
      let bundle = state.qaBundles.find((item) => (
        item.projectId === projectResult.projectId
        && item.integrationCommit === projectResult.commit
      ));
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
        }
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
    const hasProjectWork = projectPlan.tasks.length
      || projectPlan.syncDefaultBranchIntoIntegration
      || localQaPreviewConfig(projectPlan).enabled;
    if (!hasProjectWork) continue;
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
    try {
      authContext = await prepareQaIntegrationAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      result = await integrateProject(projectPlan, {
        ...input,
        env: githubAppAuthEnv(authContext, input.env || {}),
        secrets,
      });
    } catch (error) {
      result = authFailureProjectResult(projectPlan, error);
    } finally {
      await cleanupGitHubAppAuth(authContext);
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
