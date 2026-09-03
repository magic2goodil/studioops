import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  assertCandidateEnvelope,
  invalidateCandidate,
} from "./candidate-manifest.js";
import { verifyCandidateRepositoryState } from "./candidate-repository.js";
import { applyLifecycleTransitionInState, mutateState, readState } from "./store.js";
import { defaultStudioOpsWorkspaceRoot } from "./runtime-paths.js";
import {
  assertPromotionAttemptClaimInState,
  claimPromotionAttemptInState,
  recordPromotionRecoveryReceiptInState,
  renewPromotionAttemptClaimInState,
  terminalPromotionAttemptClaimInState,
  validPromotionRetryAuthorization,
} from "./promotion-attempt-claim.js";
import {
  boundedHeadTail,
  persistPromotionValidationEvidence,
  promotionValidationPolicyDigest,
  redactPromotionValidationText,
  scrubProjectRepositoryCredentials,
} from "./promotion-validation-evidence.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const WORKSPACE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_PROMOTION_WORKSPACE_ROOT = defaultStudioOpsWorkspaceRoot("promotion");
const DEFAULT_PROMOTION_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");
const MAX_PROMOTION_VALIDATION_ATTEMPTS = 2;
const PROMOTION_ATTEMPT_TTL_MS = 30 * 60_000;
const MAX_VALIDATION_SUMMARIES = 20;
const MAX_VALIDATION_COMMAND_CHARS = 500;
const MAX_VALIDATION_OUTPUT_CHARS = 2_000;
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

function projectCommandEnv(options = {}) {
  return scrubProjectRepositoryCredentials(childEnv(options));
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
      env: options.projectCommand ? projectCommandEnv(options) : childEnv(options),
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

async function existingExactPromotionPullRequest(repoPath, projectPlan, branch, commit, options = {}) {
  const response = await runCommand("gh", [
    "pr",
    "list",
    "--base",
    projectPlan.targetBranch,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    "url,state,headRefName,headRefOid",
  ], {
    cwd: repoPath,
    env: options.env,
    secrets: options.secrets,
    timeoutMs: 60_000,
    allowFailure: true,
  });
  if (!response.ok) return null;
  try {
    const matches = JSON.parse(response.output || "[]");
    if (!Array.isArray(matches)) return null;
    return matches.find((item) => (
      item?.headRefName === branch
      && item?.headRefOid === commit
      && /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(item?.url || ""))
    )) || null;
  } catch {
    return null;
  }
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
      || process.env.STUDIOOPS_PROMOTION_WORKSPACE_ROOT
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

async function runValidationCommands(repoPath, commands, options, context) {
  const completeResults = [];
  for (const command of commands) {
    if (options.beforeValidationCommand) await options.beforeValidationCommand();
    const result = await runCommand("sh", ["-lc", command], {
      cwd: repoPath,
      env: options.env,
      projectCommand: true,
      secrets: options.secrets,
      timeoutMs: Number(options.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
      allowFailure: true,
    });
    completeResults.push({
      command: redactPromotionValidationText(redactCommandOutput(command, options)),
      ok: result.ok,
      output: redactPromotionValidationText(result.output),
    });
    if (!result.ok) break;
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

function promotionBranchName(projectPlan) {
  const project = safeRefSegment(projectPlan.projectKey || projectPlan.projectId || "project");
  const candidateDigest = String(projectPlan.candidate?.manifestDigest || "")
    .replace(/^sha256:/, "")
    .slice(0, 16);
  return `qa/promotion-${project}-${candidateDigest || "candidate"}`;
}

function candidateHasTrustedQaPass(candidate, allowedStatuses = ["qa_passed"]) {
  try {
    assertCandidateEnvelope(candidate);
  } catch {
    return false;
  }
  const decision = candidate.qaDecision;
  if (
    !allowedStatuses.includes(candidate.status)
    || candidate.invalidation
    || decision?.outcome !== "passed"
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || decision.integrationSha !== candidate.manifest.integration.sha
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

function candidateHasValidQaPass(candidate) {
  return candidateHasTrustedQaPass(candidate, ["qa_passed"]);
}

function candidateHasValidPromotionHandoff(candidate) {
  if (!candidateHasTrustedQaPass(candidate, ["release_candidate_ready"])) return false;
  const promotion = candidate.promotion;
  return Boolean(
    promotion
    && /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(promotion.prUrl || ""))
    && String(promotion.branch || "").trim()
    && promotion.commitSha === candidate.manifest.integration.sha
    && promotion.manifestDigest === candidate.manifestDigest
  );
}

function candidateNeedsPromotionReconciliation(candidate) {
  try {
    assertCandidateEnvelope(candidate);
  } catch {
    return false;
  }
  return candidate.status === "release_candidate_ready"
    && /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(String(candidate.promotion?.prUrl || ""));
}

const PROMOTABLE_TASK_STATUSES = new Set([
  "user_review",
  "approved_for_main",
  "promotion_blocked",
  "merged",
  "deployed",
  "done",
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
  return candidate.manifest.sources.every((source) => {
    const task = tasksById.get(source.taskId);
    if (!task) return false;
    const attempts = promotionValidationAttemptsForCandidate(task, candidate);
    if (candidate.status === "qa_passed" && attempts > 0) {
      return taskCanRetryPromotionValidation(task, candidate, source, policyDigest);
    }
    return PROMOTABLE_TASK_STATUSES.has(task.status);
  });
}

function candidateUsesPromotionValidationRetry(candidate, tasksById, policyDigest) {
  return candidate.manifest.sources.some((source) => (
    taskCanRetryPromotionValidation(tasksById.get(source.taskId), candidate, source, policyDigest)
  ));
}

function candidateHasTrustedMerge(candidate) {
  if (!candidateHasTrustedQaPass(candidate, ["merged"])) return false;
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
    .flatMap((project) => {
      const validationCommands = promotionValidationCommands(project);
      const validationTimeoutMs = Number(input.validationTimeoutMs || VALIDATION_TIMEOUT_MS);
      const validationPolicyDigest = promotionValidationPolicyDigest({
        commands: validationCommands,
        timeoutMs: validationTimeoutMs,
      });
      const projectTasks = new Map(
        (state.tasks || [])
          .filter((task) => task.projectId === project.id)
          .map((task) => [task.id, task]),
      );
      return (state.candidates || [])
        .filter((candidate) => candidate.projectId === project.id)
        .filter((candidate) => candidateHasValidQaPass(candidate) || candidateNeedsPromotionReconciliation(candidate))
        .filter((candidate) => candidateTasksRemainPromotable(candidate, projectTasks, validationPolicyDigest))
        .filter((candidate) => {
          const candidateFilter = normalizeList(input.candidate || input.candidates || input.candidateId);
          if (candidateFilter.length && !candidateFilter.includes(candidate.id)) return false;
          const taskFilter = normalizeList(input.task || input.tasks || input.taskId);
          return !taskFilter.length || candidate.manifest?.sources?.some((source) => taskFilter.includes(source.taskId));
        })
        .map((candidate) => ({
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
          validationPolicyDigest,
          mode: candidate.status === "release_candidate_ready"
            ? "reconcile"
            : candidateUsesPromotionValidationRetry(candidate, projectTasks, validationPolicyDigest)
              ? "retry"
              : "create",
          candidate,
          mergedCandidates: (state.candidates || [])
            .filter((item) => item.projectId === project.id)
            .filter((item) => item.id !== candidate.id)
            .filter(candidateHasTrustedMerge)
            .map((item) => ({
              id: item.id,
              manifestDigest: item.manifestDigest,
              manifest: {
                base: item.manifest.base,
                integration: item.manifest.integration,
              },
              promotion: { prUrl: item.promotion.prUrl },
              promotionMerge: item.promotionMerge,
            })),
          tasks: candidate.manifest.sources.map((source) => {
            const task = projectTasks.get(source.taskId);
            return {
              id: source.taskId,
              title: task?.title || source.taskId,
              status: task?.status || "",
              branchName: task?.branchName || "",
              prUrl: task?.prUrl || "",
              dependsOnTaskIds: task?.dependsOnTaskIds || [],
              sourceRef: source.sourceRef,
              headSha: source.headSha,
              stateVersion: Number(task?.stateVersion || 1),
              promotionValidationAttempts: promotionValidationAttemptsForCandidate(task, candidate),
              promotionRetryAuthorization: task?.promotionRetryAuthorization || null,
            };
          }),
          blockedTasks: [],
        }));
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
  return promotionValidationPolicyDigest({
    commands: promotionValidationCommands(project),
    timeoutMs: Number(projectPlan.validationTimeoutMs || VALIDATION_TIMEOUT_MS),
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
    ttlMs: Number(input.promotionAttemptTtlMs || PROMOTION_ATTEMPT_TTL_MS),
    claimIdFactory: input.promotionClaimIdFactory,
    ...overrides,
  };
}

async function claimProjectPromotionAttempt(projectPlan, input = {}) {
  return mutateState((state) => claimPromotionAttemptInState(
    state,
    promotionClaimInput(projectPlan, input, {}, state),
  ), { operationName: "promotion.claim_attempt" });
}

async function renewProjectPromotionAttempt(projectPlan, claim, input = {}) {
  return mutateState((state) => renewPromotionAttemptClaimInState(
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

async function recordProjectPromotionRecoveryReceipt(projectPlan, claim, validationResults, input = {}) {
  return mutateState((state) => recordPromotionRecoveryReceiptInState(
    state,
    claim,
    {
      ...promotionClaimInput(projectPlan, input, {}, state),
      validationResults,
    },
  ), { operationName: "promotion.record_recovery_receipt" });
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
  const repositoryVerification = await verifyCandidateRepositoryState({
    repoPath,
  }, candidate, options);
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

async function reconcileSupersededCandidate(projectPlan, result, options = {}) {
  const candidate = projectPlan.candidate;
  const gitOptions = { env: options.env, secrets: options.secrets };
  const fetched = await git(
    projectPlan.repoPath,
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
    projectPlan.repoPath,
    `refs/remotes/origin/${projectPlan.targetBranch}`,
    gitOptions,
  );

  for (const replacement of projectPlan.mergedCandidates || []) {
    if (replacement.manifest.base.branch !== projectPlan.targetBranch) continue;
    const candidateIncluded = await git(
      projectPlan.repoPath,
      ["merge-base", "--is-ancestor", candidate.manifest.integration.sha, replacement.manifest.integration.sha],
      { ...gitOptions, allowFailure: true },
    );
    if (!candidateIncluded.ok) continue;
    const sourceChecks = await Promise.all(candidate.manifest.sources.map((source) => git(
      projectPlan.repoPath,
      ["merge-base", "--is-ancestor", source.headSha, replacement.manifest.integration.sha],
      { ...gitOptions, allowFailure: true },
    )));
    if (sourceChecks.some((check) => !check.ok)) continue;
    const replacementIncluded = await git(
      projectPlan.repoPath,
      ["merge-base", "--is-ancestor", replacement.manifest.integration.sha, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    const mergeIncluded = await git(
      projectPlan.repoPath,
      ["merge-base", "--is-ancestor", replacement.promotionMerge.mergeCommit, targetHead],
      { ...gitOptions, allowFailure: true },
    );
    if (!replacementIncluded.ok || !mergeIncluded.ok) continue;

    result.status = "merged";
    result.prUrl = replacement.promotion.prUrl;
    result.mergeCommit = replacement.promotionMerge.mergeCommit;
    result.mergedAt = replacement.promotionMerge.mergedAt;
    result.reconciledByCandidateId = replacement.id;
    result.reconciledByManifestDigest = replacement.manifestDigest;
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

  const inspected = await runCommand("gh", [
    "pr", "view", promotion.prUrl,
    "--json", "state,baseRefName,headRefName,headRefOid,mergeCommit,url,mergedAt",
  ], {
    cwd: projectPlan.repoPath,
    env: options.env,
    secrets: options.secrets,
    timeoutMs: 60_000,
    allowFailure: true,
  });
  if (!inspected.ok) {
    result.output = `Promotion PR could not be inspected; reconciliation will retry without changing task state.\n${truncateOutput(inspected.output)}`;
    result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
    return result;
  }

  let pr;
  try {
    pr = JSON.parse(inspected.stdout || inspected.output);
  } catch {
    result.output = "Promotion PR inspection returned invalid JSON; reconciliation will retry without changing task state.";
    result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
    return result;
  }

  const prState = String(pr.state || "").trim().toUpperCase();
  const expectedSha = candidate.manifest.integration.sha;
  if (pr.url !== promotion.prUrl || pr.baseRefName !== projectPlan.targetBranch || pr.headRefOid !== expectedSha) {
    result.status = "promotion_invalid";
    result.output = [
      "Promotion PR no longer matches the immutable candidate.",
      `Expected URL/base/head: ${promotion.prUrl} / ${projectPlan.targetBranch} / ${expectedSha}`,
      `Observed URL/base/head: ${pr.url || "missing"} / ${pr.baseRefName || "missing"} / ${pr.headRefOid || "missing"}`,
    ].join("\n");
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }
  if (prState === "OPEN") {
    result.status = "pending";
    result.output = "Release-candidate PR remains open for the owner; no workflow state changed.";
    result.tasks = reconciliationTaskResults(projectPlan, "pending", result.output);
    return result;
  }
  if (prState !== "MERGED") {
    const superseded = await reconcileSupersededCandidate(projectPlan, result, options);
    if (superseded) return superseded;
    result.status = "promotion_closed";
    result.output = "Release-candidate PR was closed without merging. Owner action is required before promotion can continue.";
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_closed", result.output);
    return result;
  }

  const mergeCommit = String(pr.mergeCommit?.oid || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(mergeCommit) || !Number.isFinite(Date.parse(pr.mergedAt || ""))) {
    result.status = "promotion_invalid";
    result.output = "Merged promotion PR is missing an immutable merge commit or merged timestamp.";
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }

  const gitOptions = { env: options.env, secrets: options.secrets };
  const fetched = await git(
    projectPlan.repoPath,
    ["fetch", "origin", `refs/heads/${projectPlan.targetBranch}:refs/remotes/origin/${projectPlan.targetBranch}`],
    { ...gitOptions, allowFailure: true },
  );
  if (!fetched.ok) {
    result.output = `Merged promotion target could not be fetched; reconciliation will retry without changing task state.\n${truncateOutput(fetched.output)}`;
    result.tasks = reconciliationTaskResults(projectPlan, "reconciliation_unavailable", result.output);
    return result;
  }
  const targetHead = await branchHead(projectPlan.repoPath, `refs/remotes/origin/${projectPlan.targetBranch}`, gitOptions);
  const candidateReachable = await git(
    projectPlan.repoPath,
    ["merge-base", "--is-ancestor", expectedSha, targetHead],
    { ...gitOptions, allowFailure: true },
  );
  const mergeReachable = await git(
    projectPlan.repoPath,
    ["merge-base", "--is-ancestor", mergeCommit, targetHead],
    { ...gitOptions, allowFailure: true },
  );
  if (!candidateReachable.ok || !mergeReachable.ok) {
    result.status = "promotion_invalid";
    result.output = `Protected target ${projectPlan.targetBranch} at ${targetHead || "missing"} does not contain the exact candidate and recorded merge commit.`;
    result.tasks = reconciliationTaskResults(projectPlan, "promotion_invalid", result.output);
    return result;
  }

  result.status = "merged";
  result.mergeCommit = mergeCommit;
  result.mergedAt = pr.mergedAt;
  result.output = `Verified ${promotion.prUrl} merged the exact candidate into ${projectPlan.targetBranch} at ${mergeCommit}.`;
  result.tasks = reconciliationTaskResults(projectPlan, "merged", result.output);
  return result;
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

    await checkoutExactCandidate(executionRepoPath, projectPlan, gitOptions);
    if (options.renewPromotionClaim) {
      const renewed = await options.renewPromotionClaim();
      projectPlan.promotionClaim = renewed;
      result.promotionClaim = renewed;
    }
    const candidateTasks = allTaskResults(projectPlan.tasks, "candidate_verified", "Exact candidate identity verified.");
    result.tasks.push(...candidateTasks);

    let validationReceiptResults = [];
    const reusableRecoveryReceipt = projectPlan.mode === "retry"
      ? projectPlan.promotionRecoveryReceipt
      : null;
    if (reusableRecoveryReceipt) {
      result.validation = [{
        command: "[exact promotion recovery receipt]",
        ok: true,
        output: `Reused ${reusableRecoveryReceipt.validationResultDigest}.`,
        outputDigest: reusableRecoveryReceipt.validationResultDigest,
      }];
    } else {
      const validationRun = await runValidationCommands(
        executionRepoPath,
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

    const prePushVerification = await verifyCandidateRepositoryState({
      repoPath: executionRepoPath,
    }, projectPlan.candidate, gitOptions);
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

    if (projectPlan.mode === "retry" && !reusableRecoveryReceipt) {
      const recorded = await options.recordRecoveryReceipt(validationReceiptResults);
      projectPlan.promotionClaim = recorded.claim;
      projectPlan.promotionRecoveryReceipt = recorded.receipt;
      projectPlan.candidate.promotionValidationRecoveryReceipt = recorded.receipt;
      result.promotionClaim = recorded.claim;
      result.promotionRecoveryReceipt = recorded.receipt;
    }
    if (options.assertPromotionClaim) await options.assertPromotionClaim();

    result.promotionBranch = promotionBranchName(projectPlan);
    const push = await git(executionRepoPath, ["push", "origin", `HEAD:refs/heads/${result.promotionBranch}`], { ...gitOptions, allowFailure: true });
    if (!push.ok) {
      result.status = "push_failed";
      result.output = `Non-force push to release-candidate branch ${result.promotionBranch} failed.\n${truncateOutput(push.output)}`;
      for (const task of candidateTasks) task.status = "push_failed";
      return result;
    }

    const prePrVerification = await verifyCandidateRepositoryState({
      repoPath: executionRepoPath,
    }, projectPlan.candidate, gitOptions);
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

    const existingPr = await existingExactPromotionPullRequest(
      executionRepoPath,
      projectPlan,
      result.promotionBranch,
      commit,
      options,
    );
    let prOutput = existingPr?.url || "";
    if (!existingPr) {
      if (options.assertPromotionClaim) await options.assertPromotionClaim();
      const taskList = projectPlan.tasks
        .map((task) => `- ${task.id}: ${task.title}${task.prUrl ? ` (${task.prUrl})` : ""} at ${task.headSha}`)
        .join("\n");
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
        `## Immutable StudioOps candidate\n\nCandidate: ${projectPlan.candidate.id}\nManifest: ${projectPlan.candidate.manifestDigest}\nIntegration SHA: ${projectPlan.candidate.manifest.integration.sha}\n\n## QA-approved tasks\n\n${taskList}\n\nValidation passed against the exact candidate in StudioOps. Production deployment remains release/tag gated.`,
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
        for (const task of candidateTasks) task.status = "pr_failed";
        return result;
      }
      prOutput = pr.output || "";
    }

    result.prUrl = String(prOutput).trim().split(/\s+/).find((value) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(value)) || "";
    result.status = "pr_ready";
    result.output = truncateOutput(prOutput || `Created release-candidate PR from ${result.promotionBranch}.`);
    for (const task of candidateTasks) task.status = "pr_ready";
    return result;
  } catch (error) {
    const failureStatus = error.code === "PROMOTION_VALIDATION_EVIDENCE_FAILED"
      ? "evidence_failed"
      : "blocked";
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
  return {
    ...projectPlan,
    tasks: allTaskResults(projectPlan.tasks, reconciliation ? "reconciliation_unavailable" : "blocked", output),
    status: reconciliation ? "reconciliation_unavailable" : "blocked",
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

  if (taskResult.status === "pr_ready") {
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

  if (taskResult.status === "push_failed") {
    return `Promotion could not update ${projectResult.targetBranch} with ${taskResult.source}. No force push was attempted.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "pr_failed") {
    return `Release-candidate branch ${projectResult.promotionBranch || ""} was pushed, but its pull request could not be created.${workspaceLine}\n\n${projectResult.output}`;
  }

  if (taskResult.status === "dependency_blocked") {
    return `Promotion waiting: ${taskResult.output}`;
  }

  if (taskResult.status === "merged") {
    return `Verified release-candidate merge for immutable candidate ${projectResult.candidate.id}.\n\nPR: ${projectResult.prUrl}\nMerge commit: ${projectResult.mergeCommit}\nTarget: ${projectResult.targetBranch}`;
  }

  if (["promotion_closed", "promotion_invalid"].includes(taskResult.status)) {
    return `Promotion reconciliation requires owner action. No review was restarted and no replacement PR was created.\n\n${taskResult.output || projectResult.output}`;
  }

  return `Promotion skipped for ${taskResult.source}: ${taskResult.output || projectResult.output || "No promotion was attempted."}${workspaceLine}`;
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
    promotionStatus: taskResult.status,
    promotionTargetBranch: projectResult.targetBranch,
    promotionUpdatedAt: now,
    promotionWorkspacePath: projectResult.workspacePath || "",
    promotionWorkspaceStrategy: projectResult.workspaceStrategy || "",
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

  if (taskResult.status === "evidence_failed") {
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
    return {
      ...patch,
      status: "promotion_blocked",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
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
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.qaBundles = state.qaBundles || [];
    state.candidates = state.candidates || [];
    if (projectResult.promotionClaim) {
      try {
        if (authoritativePromotionPolicyDigest(state, projectResult) !== projectResult.validationPolicyDigest) {
          throw new Error("Promotion validation policy changed before result recording.");
        }
        terminalPromotionAttemptClaimInState(state, projectResult.promotionClaim, {
          projectId: projectResult.projectId,
          candidateId: projectResult.candidate?.id,
          mode: projectResult.mode,
          policyDigest: projectResult.validationPolicyDigest,
          outcome: projectResult.status,
        });
      } catch (error) {
        error.code = "PROMOTION_ATTEMPT_STALE";
        throw error;
      }
    }
    const candidate = state.candidates.find((item) => item.id === projectResult.candidate?.id);
    if (!candidate) throw new Error(`Promotion result has no persisted candidate: ${projectResult.candidate?.id || "missing"}`);
    assertCandidateEnvelope(candidate);
    if (projectResult.candidateInvalidation) {
      invalidateCandidate(candidate, projectResult.candidateInvalidation);
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
        if (terminalStatus) {
          if (task.candidateId !== candidate.id || task.reviewSubjectSha !== source?.headSha) {
            throw new Error(`Terminal task ${task.id} does not match reconciled candidate ${candidate.id}.`);
          }
        } else {
          applyLifecycleTransitionInState(state, {
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
              candidateCycle: source?.candidateCycle,
              subjectSha: source?.headSha,
              candidateId: candidate.id,
              manifestDigest: candidate.manifestDigest,
              integrationSha: candidate.manifest.integration.sha,
              mergeCommit: projectResult.mergeCommit,
              prUrl: projectResult.prUrl,
            },
          }, { now });
        }
        task.assignedAgentRole = "";
        task.reviewerThreadId = "";
        task.promotionStatus = "merged";
        task.promotionUpdatedAt = now;
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
        Object.assign(task, patch);
        task.updatedAt = now;
      }
      if (taskResult.status === "pr_ready") {
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
  }, { operationName: "promotion.record_result" });
}

export async function runPromotion(input = {}) {
  const state = await readState();
  const plan = planPromotions(state, input);

  if (input.dryRun || input.plan) {
    return plan;
  }

  const results = [];
  for (const plannedProject of plan.projects) {
    if (!plannedProject.tasks.length && !plannedProject.blockedTasks.length) continue;
    let projectPlan = plannedProject;
    if (projectPlan.mode !== "reconcile") {
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
        results.push({
          ...projectPlan,
          status: "claim_busy",
          output: "Another fenced promotion attempt already owns this immutable candidate.",
          tasks: allTaskResults(projectPlan.tasks, "claim_busy", "Another fenced promotion attempt is active."),
          validation: [],
          validationEvidence: null,
        });
        continue;
      }
      projectPlan = {
        ...projectPlan,
        promotionClaim: claimed.claim,
        promotionRecoveryReceipt: claimed.receipt || null,
      };
    }
    let authContext = null;
    let result = null;
    try {
      authContext = await preparePromotionAuth(projectPlan, input);
      const secrets = normalizeSecrets(input.secrets, githubAppAuthSecrets(authContext));
      const options = {
        ...input,
        env: githubAppAuthEnv(authContext, input.env || {}),
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
          ? async (validationResults) => {
              const recorded = await recordProjectPromotionRecoveryReceipt(
                projectPlan,
                projectPlan.promotionClaim,
                validationResults,
                input,
              );
              projectPlan.promotionClaim = recorded.claim;
              projectPlan.promotionRecoveryReceipt = recorded.receipt;
              return recorded;
            }
          : null,
      };
      result = projectPlan.mode === "reconcile"
        ? await reconcilePromotionProject(projectPlan, options)
        : await promoteProject(projectPlan, options);
    } catch (error) {
      result = authFailureProjectResult(projectPlan, error);
    } finally {
      await cleanupGitHubAppAuth(authContext);
    }
    try {
      await recordProjectResult(result);
    } catch (error) {
      if (error.code !== "PROMOTION_ATTEMPT_STALE") throw error;
      result.status = "stale_result_discarded";
      result.output = truncateOutput(`Promotion result was discarded without overwriting newer state: ${error.message}`);
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
