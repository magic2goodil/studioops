import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_PROMOTION_WORKSPACE_ROOT = path.join(os.homedir(), ".mission-control", "promotion-workspaces");
const DEFAULT_PROMOTION_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");
const PROMOTION_DEPENDENCY_COMPLETE_STATUSES = new Set([
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

function childEnv(options = {}) {
  return {
    ...process.env,
    PATH: options.path || process.env.MISSION_CONTROL_PROMOTION_PATH || DEFAULT_PROMOTION_PATH,
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

function booleanOption(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function truncateOutput(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]`;
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

function redactCommandOutput(value, options = {}) {
  return redactSecrets(value, normalizeSecrets(options.secrets));
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

function prNumberFromUrl(value) {
  const match = String(value || "").match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  return match ? match[1] : "";
}

function sourceLabel(task) {
  return task.prUrl || task.branchName || "unlinked PR";
}

function isGitHubRepoUrl(value) {
  const raw = String(value || "").trim();
  return /^https:\/\/github\.com\//i.test(raw)
    || /^git@github\.com:/i.test(raw)
    || /^ssh:\/\/git@github\.com\//i.test(raw);
}

function promotionAuthEnabled(projectPlan, input = {}) {
  return booleanOption(
    input.githubAppAuth ?? process.env.MISSION_CONTROL_PROMOTION_GITHUB_APP_AUTH,
    isGitHubRepoUrl(projectPlan.repoUrl),
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

async function preparePromotionWorkspace(sourceRepoPath, projectPlan, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(
    options.promotionWorkspaceRoot
      || options.workspaceRoot
      || process.env.MISSION_CONTROL_PROMOTION_WORKSPACE_ROOT,
  );
  if (pathContains(sourceRepoPath, workspaceRoot)) {
    throw new Error(`Promotion workspace root must be outside the registered project repoPath: ${workspaceRoot}`);
  }

  const originUrl = await git(sourceRepoPath, ["remote", "get-url", "origin"], { allowFailure: true });
  if (!originUrl.ok || !originUrl.output.trim()) {
    throw new Error("Project repoPath must have an origin remote before promotion can push to the target branch.");
  }

  const projectSegment = workspaceSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const branchSegment = workspaceSegment(projectPlan.targetBranch || "main");
  const workspaceParent = path.join(workspaceRoot, projectSegment);

  await mkdir(workspaceParent, { recursive: true });
  const workspacePath = await mkdtemp(path.join(workspaceParent, `${branchSegment}-`));

  try {
    await runCommand("git", ["clone", "--shared", "--no-tags", sourceRepoPath, workspacePath], {
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
      env: options.env,
      secrets: options.secrets,
    });
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

function promotionBranchName(projectPlan) {
  const project = safeRefSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  return `qa/promotion-${project}-${Date.now()}`;
}

function hasUnmetPromotionDependency(task, tasksById, selectedIds, completedIds) {
  for (const dependencyId of task.dependsOnTaskIds || []) {
    if (selectedIds.has(dependencyId) && !completedIds.has(dependencyId)) return true;
    if (!selectedIds.has(dependencyId)) {
      const dependency = tasksById.get(dependencyId);
      if (dependency && !PROMOTION_DEPENDENCY_COMPLETE_STATUSES.has(dependency.status)) return true;
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
    .map((project) => {
      const projectTasks = (state.tasks || []).filter((task) => task.projectId === project.id);
      const candidates = projectTasks
        .filter((task) => task.status === "approved_for_main")
        .filter((task) => taskMatches(task, input));
      const ordered = orderPromotionTasks(projectTasks, candidates);
      return {
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
        repoPath: project.repoPath || "",
        repoUrl: project.repoUrl || "",
        defaultBranch: project.defaultBranch || "main",
        targetBranch: promotionTargetBranch(project),
        enabled: promotionEnabled(project),
        skipReason: promotionEnabled(project) ? "" : "promotion is disabled for this project.",
        validationCommands: promotionValidationCommands(project),
        tasks: ordered.ordered.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          branchName: task.branchName || "",
          prUrl: task.prUrl || "",
          dependsOnTaskIds: task.dependsOnTaskIds || [],
        })),
        blockedTasks: ordered.blocked,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    projects: projectPlans,
    taskCount: projectPlans.reduce((count, project) => count + project.tasks.length + project.blockedTasks.length, 0),
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

async function promoteProject(projectPlan, options = {}) {
  const repoPath = String(projectPlan.repoPath || "").trim();
  const result = {
    ...projectPlan,
    tasks: [...(projectPlan.blockedTasks || [])],
    status: "skipped",
    output: "",
    commit: "",
    validation: [],
    promotionBranch: "",
    prUrl: "",
    sourceRepoPath: repoPath,
    workspacePath: "",
    workspaceStrategy: "",
  };

  if (!projectPlan.tasks.length && !projectPlan.blockedTasks?.length) {
    result.status = "no_tasks";
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
  try {
    workspace = await preparePromotionWorkspace(repoPath, projectPlan, options);
    result.workspacePath = workspace.workspacePath;
    result.workspaceStrategy = workspace.strategy;
    const executionRepoPath = workspace.executionRepoPath;
    const gitOptions = { env: options.env, secrets: options.secrets };

    await prepareTargetBranch(executionRepoPath, projectPlan, gitOptions);

    const mergedTasks = [];
    for (const task of projectPlan.tasks) {
      const taskResult = await mergeTaskSource(executionRepoPath, task, gitOptions);
      result.tasks.push(taskResult);
      if (taskResult.status === "merged") mergedTasks.push(taskResult);
    }

    if (!mergedTasks.length) {
      result.status = result.tasks.some((task) => task.status === "conflict") ? "conflict" : "blocked";
      result.output = "No approved task could be promoted.";
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

    const commit = await branchHead(executionRepoPath, "HEAD", gitOptions);
    result.commit = commit;

    result.promotionBranch = promotionBranchName(projectPlan);
    const push = await git(executionRepoPath, ["push", "origin", `HEAD:refs/heads/${result.promotionBranch}`], { ...gitOptions, allowFailure: true });
    if (!push.ok) {
      result.status = "push_failed";
      result.output = `Non-force push to release-candidate branch ${result.promotionBranch} failed.\n${truncateOutput(push.output)}`;
      for (const task of mergedTasks) task.status = "push_failed";
      return result;
    }

    const taskList = projectPlan.tasks.map((task) => `- ${task.id}: ${task.title}${task.prUrl ? ` (${task.prUrl})` : ""}`).join("\n");
    const pr = await runCommand("gh", [
      "pr",
      "create",
      "--base",
      projectPlan.targetBranch,
      "--head",
      result.promotionBranch,
      "--title",
      `QA-approved release candidate: ${projectPlan.projectName || projectPlan.projectKey}`,
      "--body",
      `## QA-approved tasks\n\n${taskList}\n\nValidation passed in StudioOps. Production deployment remains release/tag gated.`,
    ], {
      cwd: executionRepoPath,
      env: options.env,
      secrets: options.secrets,
      timeoutMs: 60_000,
      allowFailure: true,
    });
    if (!pr.ok) {
      result.status = "pr_failed";
      result.output = `Release-candidate branch was pushed, but the pull request could not be created.\n${truncateOutput(pr.output)}`;
      for (const task of mergedTasks) task.status = "pr_failed";
      return result;
    }

    result.prUrl = String(pr.output || "").trim().split(/\s+/).find((value) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(value)) || "";
    result.status = "pr_ready";
    result.output = truncateOutput(pr.output || `Created release-candidate PR from ${result.promotionBranch}.`);
    for (const task of mergedTasks) task.status = "pr_ready";
    return result;
  } catch (error) {
    result.status = "blocked";
    result.output = truncateOutput(error.message);
    result.tasks = result.tasks.length ? result.tasks : allTaskResults(projectPlan.tasks, "blocked", error.message);
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

function authFailureProjectResult(projectPlan, error) {
  const output = `GitHub App auth failed for promotion: ${error.message}`;
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

  if (taskResult.status === "pr_ready") {
    return `QA-approved release-candidate PR is ready for ${projectResult.targetBranch} at ${projectResult.commit}.${projectResult.prUrl ? `\n\nPR: ${projectResult.prUrl}` : ""}${targetLine}${workspaceLine}\n\nValidation passed:\n${validationSummary(projectResult)}`;
  }

  if (taskResult.status === "conflict") {
    const files = taskResult.conflicts?.length ? taskResult.conflicts.map((file) => `- ${file}`).join("\n") : "- Git did not report conflicted file names.";
    return `Promotion blocked: merging ${taskResult.source} into ${projectResult.targetBranch} produced conflicts. No changes were pushed.${workspaceLine}\n\nConflicts:\n${files}`;
  }

  if (taskResult.status === "validation_failed") {
    return `Promotion validation failed after merging ${taskResult.source} into ${projectResult.targetBranch}. No changes were pushed.${targetLine}${workspaceLine}\n\nValidation:\n${validationSummary(projectResult)}`;
  }

  if (taskResult.status === "push_failed") {
    return `Promotion could not update ${projectResult.targetBranch} with ${taskResult.source}. No force push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "pr_failed") {
    return `Release-candidate branch ${projectResult.promotionBranch || ""} was pushed, but its pull request could not be created.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "dependency_blocked") {
    return `Promotion waiting: ${taskResult.output}`;
  }

  return `Promotion skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No promotion was attempted."}${workspaceLine}`;
}

function taskPatchForPromotion(projectResult, taskResult, now) {
  const patch = {
    promotionStatus: taskResult.status,
    promotionTargetBranch: projectResult.targetBranch,
    promotionUpdatedAt: now,
    promotionWorkspacePath: projectResult.workspacePath || "",
    promotionWorkspaceStrategy: projectResult.workspaceStrategy || "",
    promotionValidation: {
      status: projectResult.status,
      commands: projectResult.validation || [],
    },
    promotionConflictFiles: taskResult.conflicts || [],
  };

  if (taskResult.status === "pr_ready") {
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

  if (taskResult.status === "validation_missing") {
    return {
      ...patch,
      status: "promotion_blocked",
      assignedAgentRole: "promotion-worker",
      reviewerThreadId: "",
    };
  }

  if (["push_failed", "pr_failed"].includes(taskResult.status)) {
    return {
      ...patch,
      status: "promotion_blocked",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
      promotionBranch: projectResult.promotionBranch || "",
    };
  }

  if (["conflict", "blocked", "validation_failed"].includes(taskResult.status)) {
    return {
      ...patch,
      status: "needs_changes",
      assignedAgentRole: "builder",
      reviewerThreadId: "",
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
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.qaBundles = state.qaBundles || [];
    let promotedCount = 0;
    const promotedTaskIds = new Set();

    for (const taskResult of projectResult.tasks || []) {
      const task = (state.tasks || []).find((item) => item.id === taskResult.taskId);
      if (!task) continue;
      const patch = taskPatchForPromotion(projectResult, taskResult, now);
      Object.assign(task, patch);
      task.updatedAt = now;
      if (taskResult.status === "pr_ready") {
        promotedCount += 1;
        promotedTaskIds.add(task.id);
      }
      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "StudioOps Promotion",
        body: commentForTask(projectResult, taskResult),
        createdAt: now,
      });
      state.events.push({
        id: nextId(state.events, "event"),
        type: `promotion_${taskResult.status}`,
        projectId: task.projectId,
        taskId: task.id,
        message: `${task.title}: promotion ${taskResult.status}`,
        createdAt: now,
      });
    }

    if (promotedCount > 0) {
      for (const bundle of state.qaBundles) {
        const bundleTaskIds = (bundle.tasks || []).map((task) => task.id);
        const includedTaskIds = bundleTaskIds.filter((taskId) => promotedTaskIds.has(taskId));
        if (!includedTaskIds.length) continue;
        bundle.status = "release_candidate_ready";
        bundle.promotionBranch = projectResult.promotionBranch || "";
        bundle.promotionPrUrl = projectResult.prUrl || "";
        bundle.promotionCommit = projectResult.commit || "";
        bundle.promotedTaskIds = includedTaskIds;
        bundle.promotionReadyAt = now;
        bundle.promotionNotifiedAt = "";
        bundle.notificationStatus = "";
        bundle.notificationAttempts = 0;
        bundle.notificationRetryNotBefore = "";
        bundle.updatedAt = now;
      }
      state.events.push({
        id: nextId(state.events, "event"),
        type: "release_candidate_ready",
        projectId: projectResult.projectId,
        taskId: "",
        message: `${projectResult.projectName || projectResult.projectKey}: release-candidate PR ready with ${promotedCount} QA-approved task(s).`,
        createdAt: now,
      });
    }
  });
}

export async function runPromotion(input = {}) {
  const state = await readState();
  const plan = planPromotions(state, input);

  if (input.dryRun || input.plan) {
    return plan;
  }

  const results = [];
  for (const projectPlan of plan.projects) {
    if (!projectPlan.tasks.length && !projectPlan.blockedTasks.length) continue;
    let authContext = null;
    let result = null;
    try {
      authContext = await preparePromotionAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      result = await promoteProject(projectPlan, {
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
