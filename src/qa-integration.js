import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    .map((id) => Number(id.split("_")[1]))
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
        .filter((task) => taskMatches(task, input));
      return {
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
        repoPath: project.repoPath || "",
        repoUrl: project.repoUrl || "",
        defaultBranch: project.defaultBranch || "main",
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
  };

  if (!projectPlan.tasks.length) {
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

    const mergedTasks = [];
    for (const task of projectPlan.tasks) {
      const taskResult = await mergeTaskSource(executionRepoPath, task, gitOptions);
      result.tasks.push(taskResult);
      if (taskResult.status === "merged") mergedTasks.push(taskResult);
    }

    if (!mergedTasks.length) {
      result.status = result.tasks.some((task) => task.status === "conflict") ? "conflict" : "blocked";
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

function commentForTask(projectResult, taskResult) {
  const branchLine = projectResult.integrationBranchUrl
    ? `\n\nIntegration branch: ${projectResult.integrationBranchUrl}`
    : `\n\nIntegration branch: ${projectResult.integrationBranch}`;
  const workspaceLine = workspaceSummary(projectResult);

  if (taskResult.status === "ready") {
    return `QA integration branch ready: merged ${taskResult.source} into ${projectResult.integrationBranch} at ${projectResult.commit}.${branchLine}${workspaceLine}\n\nValidation passed:\n${validationSummary(projectResult)}`;
  }

  if (taskResult.status === "conflict") {
    const files = taskResult.conflicts?.length ? taskResult.conflicts.map((file) => `- ${file}`).join("\n") : "- Git did not report conflicted file names.";
    return `QA integration blocked: merging ${taskResult.source} into ${projectResult.integrationBranch} produced conflicts. No changes were pushed.${workspaceLine}\n\nConflicts:\n${files}\n\nUpdate the PR branch or resolve the conflict, then rerun \`npm run qa-integrate -- --project ${projectResult.projectKey}\`.`;
  }

  if (taskResult.status === "validation_failed") {
    return `QA integration validation failed after merging ${taskResult.source} into ${projectResult.integrationBranch}. No changes were pushed.${branchLine}${workspaceLine}\n\nValidation:\n${validationSummary(projectResult)}`;
  }

  if (taskResult.status === "validation_missing") {
    return `QA integration paused after merging ${taskResult.source}: the project has no validationCommands configured, so Mission Control did not push or mark the QA bundle ready.${workspaceLine}\n\nAdd validation commands and rerun \`npm run qa-integrate -- --project ${projectResult.projectKey}\`.`;
  }

  if (taskResult.status === "push_failed") {
    return `QA integration could not update ${projectResult.integrationBranch} with ${taskResult.source}. No force push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  return `QA integration skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No merge was attempted."}${workspaceLine}`;
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

    for (const taskResult of projectResult.tasks || []) {
      const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
      if (!task) continue;
      Object.assign(task, taskPatchForResult(projectResult, taskResult, now));
      task.updatedAt = now;
      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "Mission Control QA Integration",
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
    if (!projectPlan.tasks.length) continue;
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
    `Mission Control QA integration sweep (${report.generatedAt})${report.dryRun ? " DRY RUN" : ""}`,
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
    for (const task of project.tasks || []) {
      const taskId = task.taskId || task.id;
      lines.push(`  - ${taskId}: ${task.status || task.integrationStatus || "pending"} ${task.title || ""}`.trimEnd());
      if (task.conflicts?.length) lines.push(`    Conflicts: ${task.conflicts.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
