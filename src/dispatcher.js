import { findTask, generatePrompt, mutateState } from "./store.js";
import { laneProfile, laneProfilesConflict } from "./work-lanes.js";

const DISPATCHABLE_ACTIONS = new Set([
  "start_builder",
  "start_builder_fix",
  "return_to_builder",
  "start_review",
  "continue_review",
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
  if (action.type === "notify_owner" || action.type === "notify_qa_review" || role === "owner") return "owner";
  if (role.includes("review")) return "reviewer";
  return "builder";
}

function concurrencyLimitFor(group, options) {
  if (group === "reviewer") return Number(options.reviewerConcurrency || DEFAULTS.reviewerConcurrency);
  if (group === "owner") return Number(options.ownerConcurrency || DEFAULTS.ownerConcurrency);
  return Number(options.builderConcurrency || DEFAULTS.builderConcurrency);
}

function dispatchStatusFor(action) {
  if (action.type === "notify_owner" || action.type === "notify_qa_review") return "notified";
  if (action.type === "unblock_task") return "queued";
  return "queued";
}

function taskStatusFor(action) {
  if (action.type === "notify_owner" || action.type === "notify_qa_review") return "";
  if (action.type === "unblock_task") return "queued";
  if (action.type === "start_builder" || action.type === "start_builder_fix" || action.type === "return_to_builder") {
    return "in_progress";
  }
  return action.nextStatus || "";
}

function dispatchKeyFor(task, action) {
  const cycle = Number(task.reviewCycle || 0);
  const status = (action.type === "notify_owner" || action.type === "notify_qa_review") ? action.type : String(action.nextStatus || task.status || "");
  return `${task.id}:${cycle}:${action.type}:${action.role || "system"}:${status}`;
}

function activeRunMatches(run, action, task) {
  if (run.taskId !== task.id) return false;
  if (action.type === "notify_owner" || action.type === "notify_qa_review") {
    return run.actionType === action.type && !FINAL_RUN_STATUSES.has(run.status);
  }
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return false;
  if (run.role !== action.role) return false;
  return run.group === runGroupFor(action);
}

function hasExistingDispatch(state, action, task) {
  const key = dispatchKeyFor(task, action);
  return (state.runs || []).some((run) => (
    run.dispatchKey === key || activeRunMatches(run, action, task)
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
  if (action.type === "notify_qa_review") {
    return `Mission Control local QA review requested.

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

  return `Mission Control owner handoff requested.

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

function dispatchComment(run, action) {
  if (action.type === "notify_qa_review") {
    return `Local QA review notification queued as dispatch ${run.id}. Trust Leads accepted the lead review decision; this task is ready for non-production visual QA.${action.integrationBranch ? `\n\nIntegration branch: ${action.integrationBranch}` : ""}${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
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
  const prompt = role === "owner" ? ownerPrompt(action) : generatePrompt(state, task.id, role);
  const threadId = action.threadId || (group === "reviewer" ? task.reviewerThreadId : task.assignedThreadId) || "";
  const profile = laneProfile(task, action);
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
    status: dispatchStatusFor(action),
    prompt,
    promptCommand: action.promptCommand || "",
    reviewCommand: action.reviewCommand || "",
    taskUrl: action.taskUrl || "",
    branchName: action.branchName || "",
    prUrl: action.prUrl || "",
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
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    state.comments = state.comments || [];
    state.events = state.events || [];

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
      };
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
      task.updatedAt = now;

      state.comments.push({
        id: nextId(state.comments, "comment"),
        taskId: task.id,
        author: "Mission Control Dispatcher",
        body: dispatchComment(run, item.action),
        createdAt: now,
      });

      state.events.push({
        id: nextId(state.events, "event"),
        type: "dispatch_created",
        projectId: task.projectId,
        taskId: task.id,
        message: `${task.title} dispatched to ${run.role} as ${run.id}`,
        createdAt: now,
      });
    }

    return {
      generatedAt: now,
      dryRun: false,
      runs,
      selected: plan.selected,
      skipped: plan.skipped,
    };
  });
}

export function formatDispatchReport(report) {
  const lines = [
    `Mission Control dispatcher sweep (${report.generatedAt})`,
    `Created runs: ${report.runs.length}  Selected: ${report.selected.length}  Skipped: ${report.skipped.length}${report.dryRun ? "  DRY RUN" : ""}`,
    "",
  ];

  if (!report.runs.length && !report.selected.length) {
    lines.push("No dispatchable work selected.");
  }

  for (const run of report.runs) {
    lines.push(`[${run.id}] ${run.actionType} -> ${run.role} (${run.status})`);
    lines.push(`  Task: ${run.taskId}`);
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
