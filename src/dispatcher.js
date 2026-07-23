import {
  automationCircuitIsOpen,
  findProject,
  findTask,
  generatePrompt,
  mutateState,
  taskAttemptSummary,
} from "./store.js";
import { laneProfile, laneProfilesConflict } from "./work-lanes.js";
import {
  DEFAULT_EXECUTION_POLICY,
  executionAttemptKey,
  resolveExecutionPolicy,
} from "./execution-policy.js";

const DISPATCHABLE_ACTIONS = new Set([
  "start_builder",
  "start_builder_fix",
  "return_to_builder",
  "start_review",
  "continue_review",
  "qa_integration_blocked",
  "notify_qa_review",
  "notify_owner",
  "unblock_task",
]);

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const FINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

const DEFAULTS = {
  provider: "prompt-outbox",
  maxDispatchesPerSweep: 6,
  builderConcurrency: 3,
  reviewerConcurrency: 3,
  ownerConcurrency: 10,
  rollingHourRunBudget: positiveBudget(process.env.STUDIOOPS_ROLLING_HOUR_RUN_BUDGET, 6),
  dailyRunBudget: positiveBudget(process.env.STUDIOOPS_DAILY_RUN_BUDGET, 24),
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveBudget(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isModelRunGroup(group) {
  return group === "builder" || group === "reviewer";
}

function budgetTimestamp(run) {
  return Date.parse(run.modelLaunchedAt || run.createdAt || run.startedAt || "");
}

function reservesModelBudget(run, includeReservations = true) {
  if (!isModelRunGroup(run.group)) return false;
  if (run.preflightOnly) return false;
  if (run.status === "cancelled" && !run.modelLaunchedAt && !run.startedAt) return false;
  return Boolean(
    (includeReservations && run.budgetReservation)
    || run.modelLaunchedAt
    || (run.startedAt && ["running", "completed", "failed"].includes(run.status)),
  );
}

export function dispatchBudgetSnapshot(state, options = {}, nowMs = Date.now()) {
  const rollingHourLimit = positiveBudget(
    options.rollingHourRunBudget || options.hourlyRunBudget,
    DEFAULTS.rollingHourRunBudget,
  );
  const dailyLimit = positiveBudget(options.dailyRunBudget, DEFAULTS.dailyRunBudget);
  const timestamps = (state.runs || [])
    .filter((run) => reservesModelBudget(run, options.includeReservations !== false))
    .map(budgetTimestamp)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const rollingHourTimestamps = timestamps.filter((value) => value > nowMs - HOUR_MS);
  const dailyTimestamps = timestamps.filter((value) => value > nowMs - DAY_MS);
  return {
    rollingHourLimit,
    dailyLimit,
    rollingHourUsed: rollingHourTimestamps.length,
    dailyUsed: dailyTimestamps.length,
    rollingHourResumesAt: rollingHourTimestamps.length
      ? new Date(rollingHourTimestamps[0] + HOUR_MS).toISOString()
      : "",
    dailyResumesAt: dailyTimestamps.length
      ? new Date(dailyTimestamps[0] + DAY_MS).toISOString()
      : "",
    override: booleanOption(
      options.budgetOverride
      ?? options.overrideBudget
      ?? process.env.STUDIOOPS_DISPATCH_BUDGET_OVERRIDE,
      false,
    ),
  };
}

function runGroupFor(action) {
  const role = String(action.role || "").toLowerCase();
  if (
    action.type === "notify_owner"
    || action.type === "notify_qa_review"
    || action.type === "qa_bundle_ready"
    || role === "owner"
  ) return "owner";
  if (role.includes("review")) return "reviewer";
  return "builder";
}

function concurrencyLimitFor(group, options) {
  if (group === "reviewer") return Number(options.reviewerConcurrency || DEFAULTS.reviewerConcurrency);
  if (group === "owner") return Number(options.ownerConcurrency || DEFAULTS.ownerConcurrency);
  return Number(options.builderConcurrency || DEFAULTS.builderConcurrency);
}

function dispatchStatusFor(action) {
  if (["notify_owner", "notify_qa_review", "qa_bundle_ready"].includes(action.type)) return "notified";
  if (action.type === "unblock_task") return "queued";
  return "queued";
}

function taskStatusFor(action) {
  if (["notify_owner", "notify_qa_review", "qa_bundle_ready", "qa_integration_blocked"].includes(action.type)) return "";
  if (action.type === "unblock_task") return "queued";
  if (action.type === "start_builder" || action.type === "start_builder_fix" || action.type === "return_to_builder") {
    return "in_progress";
  }
  return action.nextStatus || "";
}

function dispatchKeyFor(task, action) {
  const cycle = Number(task.reviewCycle || 0);
  const status = ["notify_owner", "notify_qa_review", "qa_bundle_ready", "qa_integration_blocked"].includes(action.type)
    ? action.type
    : String(action.nextStatus || task.status || "");
  return `${task.id}:${cycle}:${action.type}:${action.role || "system"}:${status}`;
}

function activeRunMatches(run, action, task) {
  if (run.taskId !== task.id) return false;
  if (["notify_owner", "notify_qa_review", "qa_bundle_ready"].includes(action.type)) {
    return run.actionType === action.type && !FINAL_RUN_STATUSES.has(run.status);
  }
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return false;
  if (run.role !== action.role) return false;
  return run.group === runGroupFor(action);
}

function hasExistingDispatch(state, action, task) {
  const key = dispatchKeyFor(task, action);
  return (state.runs || []).some((run) => (
    (run.dispatchKey === key && !FINAL_RUN_STATUSES.has(run.status))
    || activeRunMatches(run, action, task)
  ));
}

function activeCounts(state) {
  return (state.runs || []).reduce((counts, run) => {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return counts;
    const group = run.group || "builder";
    counts[group] = (counts[group] || 0) + 1;
    return counts;
  }, {});
}

function activeLaneProfiles(state, selected = []) {
  const activeRuns = (state.runs || [])
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
    .map((run) => {
      const task = findTask(state, run.taskId);
      if (!task) return null;
      const profile = laneProfile(task, run);
      return {
        id: run.id,
        taskId: run.taskId,
        projectId: run.projectId || task.projectId,
        lane: profile.lane,
        conflictGroup: profile.conflictGroup,
      };
    })
    .filter(Boolean);

  const selectedRuns = selected.map((item) => ({
    id: item.action.id,
    taskId: item.task.id,
    projectId: item.task.projectId,
    lane: item.profile.lane,
    conflictGroup: item.profile.conflictGroup,
  }));

  return [...activeRuns, ...selectedRuns];
}

function findLaneConflict(state, selected, action, task) {
  const profile = laneProfile(task, action);
  const current = {
    id: action.id,
    taskId: task.id,
    projectId: task.projectId,
    lane: profile.lane,
    conflictGroup: profile.conflictGroup,
  };
  const conflict = activeLaneProfiles(state, selected).find((item) => laneProfilesConflict(current, item));
  return conflict ? { conflict, profile } : { conflict: null, profile };
}

function ownerPrompt(action) {
  if (action.type === "notify_qa_review" || action.type === "qa_bundle_ready") {
    return `StudioOps local QA review requested.

Project: ${action.projectName}
Task: ${action.taskId} - ${action.taskTitle}
Task URL: ${action.taskUrl}
Feature branch: ${action.branchName || "(not recorded)"}
Pull request: ${action.prUrl || "(not recorded)"}
Integration branch: ${action.integrationBranch || "(not configured)"}

Reason:
${action.reason}

Local QA decision needed:
- Pull or build the non-production review/integration branch for this project.
- Visually test the task against its acceptance criteria and attached mockups.
- Review all tasks in the QA Review list for this project before approving production.
- If it fails local QA, move the task to needs_changes with concrete notes.
- If it passes local QA, approve/merge according to the protected project release workflow.
- Do not deploy production without explicit owner approval.
`;
  }

  return `StudioOps owner handoff requested.

Project: ${action.projectName}
Task: ${action.taskId} - ${action.taskTitle}
Task URL: ${action.taskUrl}
Branch: ${action.branchName || "(not recorded)"}
PR: ${action.prUrl || "(not recorded)"}

Reason:
${action.reason}

Human owner decision needed:
- Review the task and PR.
- Approve, request changes, merge, or deploy according to project rules.
- Do not let automation merge or deploy on your behalf.
`;
}

function qaIntegrationBlockedPrompt(action) {
  return `StudioOps QA integration remediation requested.

Project: ${action.projectName}
Task: ${action.taskId} - ${action.taskTitle}
Task URL: ${action.taskUrl}
Feature branch: ${action.branchName || "(not recorded)"}
Pull request: ${action.prUrl || "(not recorded)"}
Integration branch: ${action.integrationBranch || "(not configured)"}
Integration status: ${action.integrationStatus || "(not recorded)"}

Reason:
${action.reason}

Remediation expectations:
- Inspect the task comments and QA integration logs for the exact blocker.
- Fix the blocker in the safest narrow way available.
- For dirty worktrees, preserve unrelated local/user files; move them aside or use an isolated clean checkout rather than deleting them.
- For merge conflicts, update the feature branch or integration source branch without squashing unrelated merged work.
- For validation failures, fix the actual failing code or test configuration.
- Rerun the relevant validation and QA integration command when safe:
  ${action.integrationCommand || "npm run qa-integrate"}
- Leave a StudioOps comment explaining the change, validation result, and next state.
- Do not merge PRs, deploy production, or remove unrelated production files.
`;
}

function dispatchComment(run, action) {
  if (action.type === "notify_qa_review" || action.type === "qa_bundle_ready") {
    return `Local QA review notification queued as dispatch ${run.id}. Trust Leads accepted the lead review decision; this task is ready for non-production visual QA.${action.integrationBranch ? `\n\nIntegration branch: ${action.integrationBranch}` : ""}${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
  }
  if (action.type === "qa_integration_blocked") {
    return `QA integration remediation queued as dispatch ${run.id}. StudioOps found a blocker before owner QA and routed it back to a builder.${action.integrationStatus ? `\n\nIntegration status: ${action.integrationStatus}` : ""}${action.integrationBranch ? `\n\nIntegration branch: ${action.integrationBranch}` : ""}${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
  }
  if (action.type === "notify_owner") {
    return `Owner review notification queued as dispatch ${run.id}. Task is ready for final human review.${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
  }
  return `Dispatched ${action.role || "worker"} work as ${run.id} using provider ${run.provider}. The prompt snapshot is stored on the run record.${action.promptCommand ? `\n\nPrompt command: \`${action.promptCommand}\`` : ""}`;
}

function projectAllowed(action, options) {
  const onlyProjects = normalizeList(options.project || options.projects);
  if (!onlyProjects.length) return true;
  return onlyProjects.includes(action.projectKey) || onlyProjects.includes(action.projectId);
}

function makeRun(state, task, action, options, now) {
  const group = runGroupFor(action);
  const role = action.role || (group === "owner" ? "owner" : "builder");
  const prompt = action.type === "qa_integration_blocked"
    ? qaIntegrationBlockedPrompt(action)
    : role === "owner" ? ownerPrompt(action) : generatePrompt(state, task.id, role);
  const threadId = action.threadId || (group === "reviewer" ? task.reviewerThreadId : task.assignedThreadId) || "";
  const profile = laneProfile(task, action);
  const executionPolicy = resolveExecutionPolicy(task, action, options);
  const attemptKey = executionAttemptKey(task, action);
  const actionAttempt = (state.runs || []).filter((run) => run.attemptKey === attemptKey).length + 1;
  const attemptSummary = taskAttemptSummary(state, task);
  const attempt = isModelRunGroup(group) ? attemptSummary.attemptsReserved + 1 : 0;
  return {
    id: nextId(state.runs, "run"),
    taskId: task.id,
    projectId: task.projectId,
    dispatchKey: dispatchKeyFor(task, action),
    actionId: action.id,
    actionType: action.type,
    group,
    role,
    lane: profile.lane,
    conflictGroup: profile.conflictGroup,
    fileScope: profile.fileScope,
    provider: options.provider || DEFAULTS.provider,
    model: executionPolicy.model,
    modelReasoningEffort: executionPolicy.reasoningEffort,
    modelSelectionReason: executionPolicy.selectionReason,
    attemptKey,
    attempt,
    actionAttempt,
    attemptEpoch: attemptSummary.epoch,
    maxAttempts: executionPolicy.maxAttempts,
    retryBackoffMs: executionPolicy.retryBackoffMs,
    staleRunMs: executionPolicy.staleRunMs,
    status: dispatchStatusFor(action),
    prompt,
    promptCommand: action.promptCommand || "",
    reviewCommand: action.reviewCommand || "",
    taskUrl: action.taskUrl || "",
    branchName: action.branchName || "",
    prUrl: action.prUrl || "",
    integrationBranch: action.integrationBranch || "",
    integrationBranchUrl: action.integrationBranchUrl || "",
    integrationStatus: action.integrationStatus || "",
    threadId,
    taskStatusBeforeDispatch: task.status || "",
    assignedAgentRoleBeforeDispatch: task.assignedAgentRole || "",
    budgetReservation: isModelRunGroup(group),
    modelBudgetConsumed: false,
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function planDispatches(state, actions, input = {}) {
  const options = { ...DEFAULTS, ...input };
  const nowMs = Number(options.nowMs || Date.now());
  const counts = activeCounts(state);
  const maxDispatches = Math.max(1, Number(options.maxDispatchesPerSweep || DEFAULTS.maxDispatchesPerSweep));
  const budget = dispatchBudgetSnapshot(state, options, nowMs);
  const selected = [];
  const skipped = [];
  let selectedModelRuns = 0;
  const selectedModelRunsByTask = new Map();
  let budgetPause = null;

  for (const action of actions || []) {
    if (selected.length >= maxDispatches) {
      skipped.push({ action, reason: "max_dispatches_reached" });
      continue;
    }
    if (!DISPATCHABLE_ACTIONS.has(action.type)) {
      skipped.push({ action, reason: "not_dispatchable" });
      continue;
    }
    if (!projectAllowed(action, options)) {
      skipped.push({ action, reason: "project_filter" });
      continue;
    }
    if (state.meta?.operatorPause?.active) {
      skipped.push({ action, reason: "operator_pause" });
      continue;
    }
    const task = findTask(state, action.taskId);
    if (!task) {
      skipped.push({ action, reason: "missing_task" });
      continue;
    }
    const group = runGroupFor(action);
    const project = findProject(state, task.projectId);
    if (isModelRunGroup(group) && automationCircuitIsOpen(project)) {
      skipped.push({
        action,
        reason: `project_circuit_open:${project.automationCircuit.reasonCode || project.automationCircuit.failureFingerprint || "failure"}`,
      });
      continue;
    }
    if (isModelRunGroup(group) && automationCircuitIsOpen(task)) {
      skipped.push({
        action,
        reason: `task_circuit_open:${task.automationCircuit.reasonCode || task.automationCircuit.failureFingerprint || "failure"}`,
      });
      continue;
    }
    if (isModelRunGroup(group)) {
      const executionPolicy = resolveExecutionPolicy(task, action, options);
      const attempts = taskAttemptSummary(state, task);
      const attemptsWithSelection = attempts.attemptsReserved
        + (selectedModelRunsByTask.get(task.id) || 0);
      if (attemptsWithSelection >= executionPolicy.maxAttempts) {
        skipped.push({ action, reason: `task_attempt_limit:${attemptsWithSelection}/${executionPolicy.maxAttempts}` });
        continue;
      }
      if (!budget.override) {
        if (budget.rollingHourUsed + selectedModelRuns >= budget.rollingHourLimit) {
          budgetPause = {
            reason: "rolling_hour_run_budget_exceeded",
            resumesAt: budget.rollingHourResumesAt,
          };
          skipped.push({ action, reason: budgetPause.reason });
          continue;
        }
        if (budget.dailyUsed + selectedModelRuns >= budget.dailyLimit) {
          budgetPause = {
            reason: "daily_run_budget_exceeded",
            resumesAt: budget.dailyResumesAt,
          };
          skipped.push({ action, reason: budgetPause.reason });
          continue;
        }
      }
    }
    if (hasExistingDispatch(state, action, task)) {
      skipped.push({ action, reason: "already_dispatched" });
      continue;
    }
    const limit = concurrencyLimitFor(group, options);
    if ((counts[group] || 0) >= limit) {
      skipped.push({ action, reason: `${group}_concurrency_limit` });
      continue;
    }
    const { conflict, profile } = findLaneConflict(state, selected, action, task);
    if (conflict) {
      skipped.push({ action, reason: `lane_conflict:${profile.conflictGroup}:${conflict.taskId || conflict.id}` });
      continue;
    }
    selected.push({ action, task, group, profile });
    counts[group] = (counts[group] || 0) + 1;
    if (isModelRunGroup(group)) {
      selectedModelRuns += 1;
      selectedModelRunsByTask.set(task.id, (selectedModelRunsByTask.get(task.id) || 0) + 1);
    }
  }

  return {
    selected: selected.map(({ action, task, group, profile }) => ({
      action,
      taskId: task.id,
      taskTitle: task.title,
      group,
      lane: profile.lane,
      conflictGroup: profile.conflictGroup,
      fileScope: profile.fileScope,
    })),
    skipped: skipped.map(({ action, reason }) => ({
      actionId: action?.id || "",
      actionType: action?.type || "",
      taskId: action?.taskId || "",
      reason,
    })),
    budget: {
      ...budget,
      rollingHourReserved: budget.rollingHourUsed + selectedModelRuns,
      dailyReserved: budget.dailyUsed + selectedModelRuns,
      pause: budgetPause,
    },
  };
}

export async function dispatchSupervisorActions(actions, input = {}) {
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    state.comments = state.comments || [];
    state.events = state.events || [];
    state.meta = state.meta || {};

    const now = new Date().toISOString();
    const options = { ...DEFAULTS, ...input };
    const plan = planDispatches(state, actions, options);
    const runs = [];

    if (options.dryRun) {
      return {
        generatedAt: now,
        dryRun: true,
        runs,
        selected: plan.selected,
        skipped: plan.skipped,
        budget: plan.budget,
      };
    }

    state.meta.dispatchBudget = {
      ...plan.budget,
      checkedAt: now,
      actionRequired: plan.budget.pause
        ? "Wait for the budget window to reopen or rerun the dispatcher with the explicit budget override."
        : "",
    };
    state.meta.budgetPause = plan.budget.pause
      ? {
          active: true,
          reason: plan.budget.pause.reason,
          resumesAt: plan.budget.pause.resumesAt,
          openedAt: now,
        }
      : { active: false, clearedAt: now };

    for (const skipped of plan.skipped) {
      if (!skipped.reason.startsWith("task_attempt_limit:")) continue;
      const task = findTask(state, skipped.taskId);
      if (!task || automationCircuitIsOpen(task)) continue;
      const attempts = taskAttemptSummary(state, task, { includeReservations: false });
      const latestFailure = (state.runs || [])
        .filter((run) => run.taskId === task.id && run.status === "failed")
        .sort((a, b) => String(b.completedAt || b.updatedAt || "").localeCompare(String(a.completedAt || a.updatedAt || "")))[0];
      const maxAttempts = Number(
        skipped.reason.split(":")[1]?.split("/")[1]
        || DEFAULT_EXECUTION_POLICY.maxAttempts,
      );
      const resumeStatus = task.status || "queued";
      task.status = "blocked";
      task.assignedAgentRole = "owner";
      task.retryNotBefore = "";
      task.automationCircuit = {
        state: "open",
        scope: "task",
        reasonCode: "task_attempt_limit",
        normalizedReason: latestFailure?.normalizedFailureReason || latestFailure?.failureCode || "Task-wide model attempt limit reached.",
        failureFingerprint: latestFailure?.failureFingerprint || "task_attempt_limit",
        attemptsConsumed: attempts.attemptsConsumed,
        maxAttempts,
        lastRunId: latestFailure?.id || attempts.runIds.at(-1) || "",
        openedAt: now,
        resumeStatus,
        nextCheapProbe: latestFailure?.nextCheapProbe || "Inspect the last run evidence without launching a model.",
        resumeAction: `Run \`studioops circuit-probe --task ${task.id}\`; if no safe probe applies, use \`studioops circuit-reset --task ${task.id} --reason \"<owner repair>\"\`.`,
      };
      task.automationBlocker = {
        type: "circuit",
        reason: "task_attempt_limit",
        resumeStatus,
        runId: latestFailure?.id || "",
        blockedAt: now,
      };
      task.updatedAt = now;
      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "StudioOps Circuit Breaker",
        body: `Task-wide model attempt circuit opened after ${attempts.attemptsConsumed}/${maxAttempts} consumed attempts. No additional action or review cycle will launch model work until a cheap repair probe succeeds or the owner explicitly resets the circuit.`,
        createdAt: now,
      });
    }

    for (const item of plan.selected) {
      const task = findTask(state, item.taskId);
      if (!task) continue;
      const run = makeRun(state, task, item.action, options, now);
      state.runs.push(run);
      runs.push(run);

      const nextStatus = taskStatusFor(item.action);
      if (nextStatus) task.status = nextStatus;
      task.assignedAgentRole = run.role;
      task.retryNotBefore = "";
      task.updatedAt = now;

      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "StudioOps Dispatcher",
        body: dispatchComment(run, item.action),
        createdAt: now,
      });

      state.events.push({
        id: nextId(state.events, "event"),
        type: "dispatch_created",
        projectId: task.projectId,
        taskId: task.id,
        message: `${task.title} dispatched to ${run.role} as ${run.id} (${run.model}, ${run.modelReasoningEffort})`,
        createdAt: now,
      });
    }

    return {
      generatedAt: now,
      dryRun: false,
      runs,
      selected: plan.selected,
      skipped: plan.skipped,
      budget: plan.budget,
    };
  });
}

export function formatDispatchReport(report) {
  const lines = [
    `StudioOps dispatcher sweep (${report.generatedAt})`,
    `Created runs: ${report.runs.length}  Selected: ${report.selected.length}  Skipped: ${report.skipped.length}${report.dryRun ? "  DRY RUN" : ""}`,
    report.budget
      ? `Run budget: hour ${report.budget.rollingHourReserved ?? report.budget.rollingHourUsed}/${report.budget.rollingHourLimit}, day ${report.budget.dailyReserved ?? report.budget.dailyUsed}/${report.budget.dailyLimit}${report.budget.override ? " (override)" : ""}`
      : "",
    "",
  ].filter((line, index) => line || index === 3);

  if (report.budget?.pause) {
    lines.push(
      `Model dispatch paused: ${report.budget.pause.reason}.`,
      `Next budget window: ${report.budget.pause.resumesAt || "(not available)"}.`,
      "",
    );
  }

  if (!report.runs.length && !report.selected.length) {
    lines.push("No dispatchable work selected.");
  }

  for (const run of report.runs) {
    lines.push(`[${run.id}] ${run.actionType} -> ${run.role} (${run.status})`);
    lines.push(`  Task: ${run.taskId}`);
    lines.push(`  Model: ${run.model} (${run.modelReasoningEffort})  Attempt: ${run.attempt}/${run.maxAttempts}`);
    if (run.lane) lines.push(`  Lane: ${run.lane}${run.conflictGroup ? ` (${run.conflictGroup})` : ""}`);
    if (run.prUrl) lines.push(`  PR: ${run.prUrl}`);
    lines.push("");
  }

  if (report.dryRun) {
    for (const item of report.selected) {
      lines.push(`[dry-run] ${item.action.type} -> ${item.action.role || "system"}`);
      lines.push(`  Task: ${item.taskId} ${item.taskTitle}`);
      if (item.lane) lines.push(`  Lane: ${item.lane}${item.conflictGroup ? ` (${item.conflictGroup})` : ""}`);
      lines.push("");
    }
  }

  const skippedSummary = report.skipped.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  const skippedText = Object.entries(skippedSummary)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  if (skippedText) lines.push(`Skipped: ${skippedText}`);

  return lines.join("\n").trimEnd();
}
