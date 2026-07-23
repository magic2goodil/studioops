import { findProject, findTask, generatePrompt, mutateState } from "./store.js";
import { laneProfile, laneProfilesConflict } from "./work-lanes.js";
import { executionAttemptKey, resolveExecutionPolicy } from "./execution-policy.js";

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
};

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

function dispatchSafetyReason(state, task, action, options) {
  const group = runGroupFor(action);
  if (group === "owner") return "";
  if (state.meta?.operatorPause?.active && !options.ignoreOperatorPause) {
    return "operator_pause";
  }
  const project = findProject(state, task.projectId);
  if (project?.automationCircuit?.state === "open") return "project_circuit_open";
  if (task.automationCircuit?.state === "open") return "task_circuit_open";
  const executionPolicy = resolveExecutionPolicy(task, action, options);
  const attemptKey = executionAttemptKey(task, action);
  const attemptCount = (state.runs || []).filter((run) => run.attemptKey === attemptKey).length;
  if (attemptCount >= executionPolicy.maxAttempts) return "attempt_budget_exhausted";
  return "";
}

function skippedAction(actions, skipped) {
  return (actions || []).find((action) => (
    (skipped.actionId && action.id === skipped.actionId)
    || (
      action.taskId === skipped.taskId
      && action.type === skipped.actionType
    )
  )) || null;
}

function openExhaustedAttemptCircuits(state, actions, skipped, options, now) {
  const openedTaskIds = new Set();
  for (const item of skipped || []) {
    if (item.reason !== "attempt_budget_exhausted" || openedTaskIds.has(item.taskId)) continue;
    const task = findTask(state, item.taskId);
    const action = skippedAction(actions, item);
    if (!task || !action || task.automationCircuit?.state === "open") continue;
    const policy = resolveExecutionPolicy(task, action, options);
    const attemptKey = executionAttemptKey(task, action);
    const attempts = (state.runs || []).filter((run) => run.attemptKey === attemptKey).length;
    const resumeStatus = task.status;
    task.status = "blocked";
    task.assignedAgentRole = "owner";
    task.retryNotBefore = "";
    task.lastAutomationFailure = "attempt_budget_exhausted";
    task.automationBlocker = {
      type: "circuit",
      reason: "attempt_budget_exhausted",
      actionType: action.type,
      attemptKey,
      attempts,
      maxAttempts: policy.maxAttempts,
      resumeStatus,
      blockedAt: now,
      retryAt: "",
    };
    task.automationCircuit = {
      state: "open",
      scope: "task",
      reasonCode: "attempt_budget_exhausted",
      normalizedReason: `StudioOps suppressed ${action.type} after ${attempts}/${policy.maxAttempts} dispatch attempts.`,
      failureFingerprint: `${task.id}:${attemptKey}:attempt_budget_exhausted`,
      attemptsConsumed: attempts,
      maxAttempts: policy.maxAttempts,
      openedAt: now,
      nextCheapProbe: "Inspect the preserved run outputs and verify the underlying blocker without launching another model.",
      resumeAction: `studioops circuit-reset --task ${task.id} --reason verified`,
      remediation: "Repair or verify the underlying blocker, then explicitly reset this task circuit.",
    };
    task.updatedAt = now;
    state.comments.push({
      id: nextId(state.comments, "comment"),
      taskId: task.id,
      author: "StudioOps Dispatcher",
      body: `Opened the task automation circuit after suppressing ${action.type}: the ${attempts}/${policy.maxAttempts} dispatch-attempt budget is exhausted. No additional model run will start until the blocker is verified and the circuit is explicitly reset.`,
      createdAt: now,
    });
    state.events.push({
      id: nextId(state.events, "event"),
      type: "automation_circuit_opened",
      projectId: task.projectId,
      taskId: task.id,
      message: `${task.title}: ${action.type} attempt budget exhausted`,
      createdAt: now,
    });
    openedTaskIds.add(task.id);
  }
  return openedTaskIds;
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
  const attempt = (state.runs || []).filter((run) => run.attemptKey === attemptKey).length + 1;
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
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function planDispatches(state, actions, input = {}) {
  const options = { ...DEFAULTS, ...input };
  const counts = activeCounts(state);
  const maxDispatches = Math.max(1, Number(options.maxDispatchesPerSweep || DEFAULTS.maxDispatchesPerSweep));
  const selected = [];
  const skipped = [];

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
    const task = findTask(state, action.taskId);
    if (!task) {
      skipped.push({ action, reason: "missing_task" });
      continue;
    }
    const safetyReason = dispatchSafetyReason(state, task, action, options);
    if (safetyReason) {
      skipped.push({ action, reason: safetyReason });
      continue;
    }
    if (hasExistingDispatch(state, action, task)) {
      skipped.push({ action, reason: "already_dispatched" });
      continue;
    }
    const group = runGroupFor(action);
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
  };
}

export async function dispatchSupervisorActions(actions, input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  const { state: _inputState, ...dispatchInput } = input;
  return mutate(async (state) => {
    state.runs = state.runs || [];
    state.comments = state.comments || [];
    state.events = state.events || [];

    const now = new Date().toISOString();
    const options = { ...DEFAULTS, ...dispatchInput };
    const plan = planDispatches(state, actions, options);
    const runs = [];

    if (options.dryRun) {
      return {
        generatedAt: now,
        dryRun: true,
        runs,
        selected: plan.selected,
        skipped: plan.skipped,
      };
    }

    const openedTaskIds = openExhaustedAttemptCircuits(
      state,
      actions,
      plan.skipped,
      options,
      now,
    );
    const selected = plan.selected.filter((item) => (
      !openedTaskIds.has(item.taskId) || item.group === "owner"
    ));
    const skipped = [
      ...plan.skipped,
      ...plan.selected
        .filter((item) => openedTaskIds.has(item.taskId) && item.group !== "owner")
        .map((item) => ({
          actionId: item.action?.id || "",
          actionType: item.action?.type || "",
          taskId: item.taskId,
          reason: "task_circuit_open",
        })),
    ];

    for (const item of selected) {
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
      selected,
      skipped,
    };
  });
}

export function formatDispatchReport(report) {
  const lines = [
    `StudioOps dispatcher sweep (${report.generatedAt})`,
    `Created runs: ${report.runs.length}  Selected: ${report.selected.length}  Skipped: ${report.skipped.length}${report.dryRun ? "  DRY RUN" : ""}`,
    "",
  ];

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
