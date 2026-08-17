import {
  architectureIsCompleteInState,
  cycleLimitLeadReviewApplies,
  currentReviewCandidateCycle,
  diskPressureIncidentIsActive,
  earliestIncompleteRequiredReviewStage,
  findProject,
  findTask,
  generatePrompt,
  mutateState,
  readState,
  resetAutomationCircuitInState,
  reviewStagesForTask,
  taskAutomationCircuitIsCurrent,
  workflowSnapshotForTask,
} from "./store.js";
import { laneProfile, laneProfilesConflict } from "./work-lanes.js";
import { executionAttemptKey, resolveExecutionPolicy } from "./execution-policy.js";
import { assessCreditAdmission, requestCodexCreditSnapshot } from "./credit-policy.js";
import { INSTALLED_AUTOMATION_CAPACITY } from "./config.js";

const DISPATCHABLE_ACTIONS = new Set([
  "start_architecture",
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
const ARCHITECTURE_GATED_ACTIONS = new Set([
  "start_builder",
  "start_builder_fix",
  "return_to_builder",
  "unblock_task",
]);
const REVIEW_ACTIONS = new Set(["start_review", "continue_review"]);
const REVIEW_HANDOFF_ACTIONS = new Set(["notify_owner", "notify_qa_review", "qa_bundle_ready"]);

const DEFAULTS = {
  provider: "prompt-outbox",
  maxDispatchesPerSweep: 6,
  builderConcurrency: INSTALLED_AUTOMATION_CAPACITY.builderConcurrency,
  architectConcurrency: 1,
  reviewerConcurrency: INSTALLED_AUTOMATION_CAPACITY.reviewerConcurrency,
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
  if (action.type === "start_architecture" || role.includes("architect")) return "architect";
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
  if (group === "architect") return Number(options.architectConcurrency || DEFAULTS.architectConcurrency);
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
  if (action.type === "start_architecture") return "architecture_pending";
  if (action.type === "start_builder" || action.type === "start_builder_fix" || action.type === "return_to_builder") {
    return "queued";
  }
  return action.nextStatus || "";
}

function dispatchKeyFor(task, action) {
  const cycle = Number(task.reviewCycle || 0);
  const candidateCycle = currentReviewCandidateCycle(task);
  const subjectSha = task.reviewSubjectSha || "no-subject";
  const status = ["notify_owner", "notify_qa_review", "qa_bundle_ready", "qa_integration_blocked"].includes(action.type)
    ? action.type
    : String(action.nextStatus || task.status || "");
  return `${task.id}:${cycle}:${candidateCycle}:${subjectSha}:${action.type}:${action.role || "system"}:${status}`;
}

function activeRunMatches(run, action, task) {
  if (run.taskId !== task.id) return false;
  if (["notify_owner", "notify_qa_review", "qa_bundle_ready"].includes(action.type)) {
    return run.actionType === action.type && !FINAL_RUN_STATUSES.has(run.status);
  }
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return false;
  if (run.role !== action.role) return false;
  if (
    run.group === "reviewer"
    && task.reviewSubjectSha
    && (
      run.reviewSubjectSha !== task.reviewSubjectSha
      || Number(run.candidateCycle || 0) !== currentReviewCandidateCycle(task)
    )
  ) {
    return false;
  }
  return run.group === runGroupFor(action);
}

export function executionAttemptWasConsumed(run = {}) {
  if (run.attemptConsumed === false) return false;
  if (run.status === "cancelled") return Boolean(run.startedAt);
  return ["running", "completed", "failed"].includes(run.status);
}

function executionAttemptCount(state, attemptKey) {
  return (state.runs || []).filter((run) => (
    run.attemptKey === attemptKey && executionAttemptWasConsumed(run)
  )).length;
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

function projectWipLimit(project) {
  const configured = Number(project?.wipPolicy?.maxActiveTasks || project?.maxActiveTasks || 0);
  return Number.isInteger(configured) && configured > 0 ? configured : 0;
}

function activeProjectTaskCount(state, projectId) {
  return new Set((state.tasks || [])
    .filter((task) => task.projectId === projectId)
    .filter((task) => ["queued", "in_progress", "builder_review", "backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review", "needs_changes"].includes(task.status))
    .map((task) => task.id)).size;
}

function effectiveGroupCapacity(options, initialCounts, finalCounts) {
  return Object.fromEntries(["architect", "builder", "reviewer", "owner"].map((group) => {
    const limit = concurrencyLimitFor(group, options);
    const active = Number(initialCounts[group] || 0);
    const selected = Math.max(0, Number(finalCounts[group] || 0) - active);
    return [group, {
      configuredLimit: limit,
      active,
      selected,
      available: Math.max(0, limit - active - selected),
    }];
  }));
}

function skippedConstraint(reason) {
  if (String(reason || "").endsWith("_concurrency_limit")) return "concurrency_limit";
  if (String(reason || "").startsWith("lane_conflict:")) return "lane_or_file_scope_conflict";
  return "policy_or_state";
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
        fileScope: profile.fileScope,
        fileScopeExplicit: profile.fileScopeExplicit,
      };
    })
    .filter(Boolean);

  const selectedRuns = selected.map((item) => ({
    id: item.action.id,
    taskId: item.task.id,
    projectId: item.task.projectId,
    lane: item.profile.lane,
    conflictGroup: item.profile.conflictGroup,
    fileScope: item.profile.fileScope,
    fileScopeExplicit: item.profile.fileScopeExplicit,
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
    fileScope: profile.fileScope,
    fileScopeExplicit: profile.fileScopeExplicit,
  };
  const conflict = activeLaneProfiles(state, selected).find((item) => laneProfilesConflict(current, item));
  return conflict ? { conflict, profile } : { conflict: null, profile };
}

function needsUnknownCreditSnapshotRetry(state, actions, options) {
  if (options.dryRun) return false;
  return (actions || []).some((action) => {
    if (!DISPATCHABLE_ACTIONS.has(action.type) || runGroupFor(action) === "owner") return false;
    if (!projectAllowed(action, options)) return false;
    const task = findTask(state, action.taskId);
    if (!task || task.automationCircuit?.state === "open") return false;
    if (hasExistingDispatch(state, action, task)) return false;
    if (action.taskStatus && task.status !== action.taskStatus) return false;
    if (reviewDispatchSafetyReason(state, task, action)) return false;
    if (preCreditDispatchSafetyReason(state, task, action, options)) return false;
    const executionPolicy = resolveExecutionPolicy(task, action, options);
    const admission = assessCreditAdmission(
      options.creditSnapshot,
      executionPolicy,
      options.creditPolicy,
    );
    return admission.code === "credit_snapshot_unknown";
  });
}

function preCreditDispatchSafetyReason(state, task, action, options) {
  const group = runGroupFor(action);
  if (group === "owner") return "";
  if (
    ARCHITECTURE_GATED_ACTIONS.has(action.type)
    && task.architectureRequired
    && !architectureIsCompleteInState(state, task)
  ) return "architecture_handoff_invalid";
  if (state.meta?.operatorPause?.active && !options.ignoreOperatorPause) {
    return "operator_pause";
  }
  if (diskPressureIncidentIsActive(state.meta?.diskPressureIncident) && !options.ignoreDiskPressureIncident) {
    return "disk_recovery_in_progress";
  }
  const project = findProject(state, task.projectId);
  if (project?.automationCircuit?.state === "open") return "project_circuit_open";
  if (task.automationCircuit?.state === "open") return "task_circuit_open";
  return "";
}

function dispatchSafetyReason(state, task, action, options) {
  const preCreditReason = preCreditDispatchSafetyReason(state, task, action, options);
  if (preCreditReason) return preCreditReason;
  if (runGroupFor(action) === "owner") return "";
  const executionPolicy = resolveExecutionPolicy(task, action, options);
  const creditAdmission = assessCreditAdmission(
    options.creditSnapshot,
    executionPolicy,
    options.creditPolicy,
  );
  if (
    executionPolicy.costBudget > 0
    && Number(creditAdmission.estimatedCredits || 0) > executionPolicy.costBudget
  ) return "task_budget:estimated_cost_exceeds_budget";
  if (!creditAdmission.allowed) return `credit_gate:${creditAdmission.code}`;
  const attemptKey = executionAttemptKey(task, action);
  const attemptCount = executionAttemptCount(state, attemptKey);
  if (attemptCount >= executionPolicy.maxAttempts) return "attempt_budget_exhausted";
  return "";
}

function openCreditAdmissionCircuits(state, actions, skipped, options, now) {
  const openedTaskIds = new Set();
  for (const item of skipped || []) {
    const creditGate = String(item.reason || "").startsWith("credit_gate:");
    const taskBudgetGate = String(item.reason || "").startsWith("task_budget:");
    if ((!creditGate && !taskBudgetGate) || openedTaskIds.has(item.taskId)) continue;
    const task = findTask(state, item.taskId);
    const action = skippedAction(actions, item);
    if (!task || !action || task.automationCircuit?.state === "open") continue;
    const executionPolicy = resolveExecutionPolicy(task, action, options);
    const admission = assessCreditAdmission(
      options.creditSnapshot,
      executionPolicy,
      options.creditPolicy,
    );
    const resumeStatus = task.status;
    const snapshot = workflowSnapshotForTask(task);
    task.status = "blocked";
    task.assignedAgentRole = "owner";
    task.retryNotBefore = "";
    const blockerCode = taskBudgetGate ? String(item.reason).split(":")[1] : admission.code;
    task.lastAutomationFailure = blockerCode;
    task.automationBlocker = {
      type: "circuit",
      reason: blockerCode,
      actionType: action.type,
      modelTier: admission.tier,
      estimatedCredits: admission.estimatedCredits,
      minRemainingPercent: admission.minRemainingPercent,
      resumeStatus,
      blockedAt: now,
      retryAt: "",
    };
    task.automationCircuit = {
      state: "open",
      scope: "task",
      reasonCode: taskBudgetGate ? "task_cost_budget_insufficient" : "credit_budget_insufficient",
      normalizedReason: taskBudgetGate
        ? `StudioOps did not start ${action.type} because its estimated ${admission.estimatedCredits}-credit cost exceeds the task budget ${executionPolicy.costBudget}.`
        : `StudioOps did not start ${action.type} because the ${admission.tier} quality tier failed credit admission (${admission.code}).`,
      failureFingerprint: `${task.id}:${action.type}:${admission.tier}:${blockerCode}`,
      attemptsConsumed: 0,
      maxAttempts: 0,
      snapshot,
      openedAt: now,
      nextCheapProbe: taskBudgetGate
        ? "Review the task cost budget without launching a model run."
        : "Check current Codex usage limits without launching a model run.",
      resumeAction: `studioops circuit-reset --task ${task.id} --expected-opened-at ${now} --reason ${taskBudgetGate ? "budget_updated" : "credits_verified"}`,
      remediation: taskBudgetGate
        ? "Increase the task cost budget or reduce the approved execution tier after owner review, then reset this task circuit."
        : "Wait for quota reset, add credits, or update the configured budget after review; then reset this task circuit.",
    };
    task.updatedAt = now;
    const remaining = Number.isFinite(admission.remainingPercent)
      ? `${admission.remainingPercent}%`
      : "unknown";
    state.comments.push({
      id: nextId(state.comments, "comment"),
      taskId: task.id,
      author: "StudioOps Budget Controller",
      body: taskBudgetGate
        ? `Run suppressed before model launch. Estimated run budget: ${admission.estimatedCredits} credits. Task cost budget: ${executionPolicy.costBudget}. StudioOps did not silently exceed the task budget. Update the approved budget, then run \`${task.automationCircuit.resumeAction}\`.`
        : `Run suppressed before model launch. Required tier: ${admission.tier}. Admission result: ${admission.code}. Estimated run budget: ${admission.estimatedCredits} credits. Remaining quota headroom: ${remaining}. StudioOps did not downgrade the task. Verify credits or quota, then run \`${task.automationCircuit.resumeAction}\`.`,
      createdAt: now,
    });
    state.events.push({
      id: nextId(state.events, "event"),
      type: taskBudgetGate ? "task_budget_blocked" : "credit_admission_blocked",
      projectId: task.projectId,
      taskId: task.id,
      message: taskBudgetGate
        ? `${task.title}: estimated cost exceeds task budget`
        : `${task.title}: ${admission.tier} tier blocked by ${admission.code}`,
      createdAt: now,
    });
    openedTaskIds.add(task.id);
  }
  return openedTaskIds;
}

export function recoverAffordableCreditCircuitsInState(state, options = {}, input = {}) {
  const snapshot = options.creditSnapshot;
  if (!options.creditPolicy?.enabled || snapshot?.status !== "available") return [];
  const now = input.now || new Date().toISOString();
  const recovered = [];

  for (const task of state.tasks || []) {
    const circuit = task.automationCircuit;
    const blocker = task.automationBlocker;
    if (
      circuit?.state !== "open"
      || circuit.reasonCode !== "credit_budget_insufficient"
      || blocker?.type !== "circuit"
      || !taskAutomationCircuitIsCurrent(task)
    ) continue;

    const admission = assessCreditAdmission(
      snapshot,
      { modelTier: blocker.modelTier },
      options.creditPolicy,
    );
    if (!admission.allowed) continue;

    resetAutomationCircuitInState(state, {
      task: task.id,
      expectedOpenedAt: circuit.openedAt,
      reason: `Fresh credit telemetry admitted the unchanged ${admission.tier} workflow at ${admission.remainingPercent}% remaining quota.`,
      author: "StudioOps Budget Controller",
      automatic: true,
      now,
    });
    task.automationCircuit.recoveryEvidence = {
      snapshotStatus: admission.snapshotStatus,
      snapshotSource: admission.snapshotSource,
      snapshotObservedAt: admission.snapshotObservedAt,
      tier: admission.tier,
      remainingPercent: Number.isFinite(admission.remainingPercent)
        ? admission.remainingPercent
        : null,
      decision: admission.code,
    };
    state.events.push({
      id: nextId(state.events, "event"),
      type: "credit_admission_recovered",
      projectId: task.projectId,
      taskId: task.id,
      message: `${task.title}: fresh credit telemetry restored ${task.status}; dispatch remains eligible for the next sweep.`,
      createdAt: now,
    });
    recovered.push(task.id);
  }
  return recovered;
}

function resolveReviewTargetStage(stages, task, action) {
  const targetStatus = String(
    action.nextStatus
    || action.taskStatus
    || task.status
    || "",
  );
  if (targetStatus) {
    const statusStage = stages.find((stage) => stage.status === targetStatus) || null;
    if (statusStage) {
      if (action.role && statusStage.role !== action.role) {
        return { stage: null, reason: "review_stage_role_mismatch" };
      }
      return { stage: statusStage, reason: "" };
    }
    if (action.nextStatus) {
      return { stage: null, reason: "review_stage_unknown" };
    }
  }

  const roleStages = stages.filter((stage) => stage.role === action.role);
  if (roleStages.length > 1) {
    return { stage: null, reason: "review_stage_ambiguous" };
  }
  return {
    stage: roleStages[0] || null,
    reason: roleStages.length ? "" : "review_stage_unknown",
  };
}

function reviewDispatchSafetyReason(state, task, action) {
  if (!task.reviewSubjectSha && !REVIEW_ACTIONS.has(action.type)) return "";
  if (action.reviewSubjectSha && action.reviewSubjectSha !== task.reviewSubjectSha) {
    return "review_subject_changed";
  }
  if (
    action.candidateCycle
    && Number(action.candidateCycle) !== currentReviewCandidateCycle(task)
  ) {
    return "review_candidate_cycle_changed";
  }
  const project = findProject(state, task.projectId);
  if (!project) return "missing_project";
  const earliestRequiredStage = earliestIncompleteRequiredReviewStage(state, project, task);
  if (REVIEW_HANDOFF_ACTIONS.has(action.type)) {
    return earliestRequiredStage
      ? `earlier_review_incomplete:${earliestRequiredStage.key}`
      : "";
  }
  if (!REVIEW_ACTIONS.has(action.type)) return "";
  const stages = reviewStagesForTask(project, task);
  const target = resolveReviewTargetStage(stages, task, action);
  if (target.reason) return target.reason;
  const targetStage = target.stage;
  const cycleLimitLeadReview = cycleLimitLeadReviewApplies(
    state,
    project,
    task,
    targetStage,
  );
  if (
    earliestRequiredStage
    && stages.indexOf(targetStage) > stages.indexOf(earliestRequiredStage)
    && !cycleLimitLeadReview
  ) {
    return `earlier_review_incomplete:${earliestRequiredStage.key}`;
  }
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
    const attempts = executionAttemptCount(state, attemptKey);
    const resumeStatus = task.status;
    const snapshot = workflowSnapshotForTask(task);
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
      snapshot,
      openedAt: now,
      nextCheapProbe: "Inspect the preserved run outputs and verify the underlying blocker without launching another model.",
      resumeAction: `studioops circuit-reset --task ${task.id} --expected-opened-at ${now} --reason verified`,
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
- If it passes local QA, record that result against the immutable candidate manifest; this handoff does not merge, tag, release, or deploy.
- Before production, make one separate explicit human release decision naming the full commit SHA, target host, candidate-manifest or artifact SHA-256 digest, successful exact-commit health-check time, and tested rollback commit or procedure.
- Automation must not merge or deploy on the owner's behalf.
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
- Approve, request changes, or perform the protected merge according to project rules.
- Treat the immutable candidate manifest as release authority; task status and prose are not release approval.
- Before production, make one separate explicit human release decision naming the full commit SHA, target host, candidate-manifest or artifact SHA-256 digest, successful exact-commit health-check time, and tested rollback commit or procedure.
- Do not let automation merge, tag, release, or deploy on your behalf.
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
    return `Local QA review notification queued as dispatch ${run.id}. Trust Leads accepted the lead review decision; this task is ready for non-production visual QA. StudioOps did not merge or deploy it; production still requires the immutable candidate release packet and an explicit human decision.${action.integrationBranch ? `\n\nIntegration branch: ${action.integrationBranch}` : ""}${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
  }
  if (action.type === "qa_integration_blocked") {
    return `QA integration remediation queued as dispatch ${run.id}. StudioOps found a blocker before owner QA and routed it back to a builder.${action.integrationStatus ? `\n\nIntegration status: ${action.integrationStatus}` : ""}${action.integrationBranch ? `\n\nIntegration branch: ${action.integrationBranch}` : ""}${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
  }
  if (action.type === "notify_owner") {
    return `Owner review notification queued as dispatch ${run.id}. Task is ready for final human review. StudioOps did not merge or deploy it; production requires a separate explicit human release decision bound to the immutable candidate packet.${action.prUrl ? `\n\nPR: ${action.prUrl}` : ""}`;
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
  const roleThreadId = group === "reviewer" ? task.reviewerThreadIds?.[role] : "";
  const requestedThreadId = action.threadId || roleThreadId || (group === "reviewer" ? "" : task.assignedThreadId) || "";
  const reservedReviewerThreads = new Set(Object.entries(task.reviewerThreadIds || {})
    .filter(([reviewerRole]) => reviewerRole !== role)
    .map(([, thread]) => String(thread || ""))
    .filter(Boolean));
  const threadId = group === "reviewer"
    && (requestedThreadId === task.assignedThreadId || reservedReviewerThreads.has(requestedThreadId))
    ? ""
    : requestedThreadId;
  const profile = laneProfile(task, action);
  const executionPolicy = resolveExecutionPolicy(task, action, options);
  const creditAdmission = assessCreditAdmission(
    options.creditSnapshot,
    executionPolicy,
    options.creditPolicy,
  );
  const attemptKey = executionAttemptKey(task, action);
  const attempt = executionAttemptCount(state, attemptKey) + 1;
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
    fileScopeExplicit: profile.fileScopeExplicit,
    provider: task.preferredRunnerProvider || options.provider || DEFAULTS.provider,
    model: executionPolicy.model,
    modelTier: executionPolicy.modelTier,
    modelReasoningEffort: executionPolicy.reasoningEffort,
    modelSelectionReason: executionPolicy.selectionReason,
    tokenBudget: executionPolicy.tokenBudget,
    costBudget: executionPolicy.costBudget,
    costTelemetry: {
      estimatedCredits: creditAdmission.estimatedCredits,
      tokenBudget: executionPolicy.tokenBudget,
      actualCredits: null,
      actualTokens: null,
      recordedAt: now,
    },
    reviewerIdentity: action.reviewerIdentity || "",
    creditAdmission: {
      code: creditAdmission.code,
      tier: creditAdmission.tier,
      estimatedCredits: creditAdmission.estimatedCredits,
      minRemainingPercent: creditAdmission.minRemainingPercent,
      remainingPercent: Number.isFinite(creditAdmission.remainingPercent)
        ? creditAdmission.remainingPercent
        : null,
      snapshotStatus: creditAdmission.snapshotStatus,
    },
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
    reviewSubjectSha: task.reviewSubjectSha || "",
    candidateCycle: currentReviewCandidateCycle(task),
    threadId,
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function planDispatches(state, actions, input = {}) {
  const options = { ...DEFAULTS, ...input };
  const counts = activeCounts(state);
  const initialCounts = { ...counts };
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
    if (action.taskStatus && task.status !== action.taskStatus) {
      skipped.push({ action, reason: `task_status_changed:${action.taskStatus}->${task.status}` });
      continue;
    }
    const project = state.projects?.find((item) => item.id === task.projectId);
    const wipLimit = projectWipLimit(project);
    if (wipLimit && ["builder", "architect"].includes(runGroupFor(action))) {
      const active = activeProjectTaskCount(state, task.projectId);
      const alreadyActive = ["queued", "in_progress", "builder_review", "backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review", "needs_changes"].includes(task.status);
      if (active >= wipLimit && !alreadyActive) {
        skipped.push({ action, reason: "project_wip_limit", projectId: task.projectId, wipLimit, active });
        continue;
      }
    }
    const reviewSafetyReason = reviewDispatchSafetyReason(state, task, action);
    if (reviewSafetyReason) {
      skipped.push({ action, reason: reviewSafetyReason });
      continue;
    }
    const safetyReason = dispatchSafetyReason(state, task, action, options);
    if (safetyReason) {
      skipped.push({ action, reason: safetyReason });
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
      skipped.push({
        action,
        reason: `lane_conflict:${profile.conflictGroup}:${conflict.taskId || conflict.id}`,
        lane: profile.lane,
        conflictGroup: profile.conflictGroup,
        fileScope: profile.fileScope,
        conflictTaskId: conflict.taskId || "",
      });
      continue;
    }
    selected.push({ action, task, group, profile });
    counts[group] = (counts[group] || 0) + 1;
  }

  return {
    effectiveCapacity: {
      maxDispatchesPerSweep: maxDispatches,
      groups: effectiveGroupCapacity(options, initialCounts, counts),
    },
    selected: selected.map(({ action, task, group, profile }) => ({
      action,
      taskId: task.id,
      taskTitle: task.title,
      group,
      lane: profile.lane,
      conflictGroup: profile.conflictGroup,
      fileScope: profile.fileScope,
      fileScopeExplicit: profile.fileScopeExplicit,
    })),
    skipped: skipped.map(({ action, reason, ...details }) => ({
      actionId: action?.id || "",
      actionType: action?.type || "",
      taskId: action?.taskId || "",
      reason,
      constraint: skippedConstraint(reason),
      ...details,
    })),
  };
}

export async function dispatchSupervisorActions(actions, input = {}) {
  const { state: inputState, ...initialDispatchInput } = input;
  const dispatchInput = { ...initialDispatchInput };
  const preflightOptions = { ...DEFAULTS, ...dispatchInput };
  if (!preflightOptions.dryRun && preflightOptions.creditPolicy?.enabled) {
    const preflightState = inputState || await readState();
    if (needsUnknownCreditSnapshotRetry(preflightState, actions, preflightOptions)) {
      const probe = input.creditSnapshotProbe || requestCodexCreditSnapshot;
      dispatchInput.creditSnapshot = await probe(preflightOptions.creditPolicy);
    }
  }
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => {
    state.runs = state.runs || [];
    state.comments = state.comments || [];
    state.events = state.events || [];

    const now = new Date().toISOString();
    const options = { ...DEFAULTS, ...dispatchInput };
    const recoveredCreditCircuitTaskIds = options.dryRun
      ? []
      : recoverAffordableCreditCircuitsInState(state, options, { now });
    const plan = planDispatches(state, actions, options);
    const runs = [];

    if (options.dryRun) {
      return {
        generatedAt: now,
        dryRun: true,
        runs,
        effectiveCapacity: plan.effectiveCapacity,
        selected: plan.selected,
        skipped: plan.skipped,
        recoveredCreditCircuitTaskIds,
      };
    }

    const openedTaskIds = openExhaustedAttemptCircuits(
      state,
      actions,
      plan.skipped,
      options,
      now,
    );
    const creditBlockedTaskIds = openCreditAdmissionCircuits(
      state,
      actions,
      plan.skipped,
      options,
      now,
    );
    for (const taskId of creditBlockedTaskIds) openedTaskIds.add(taskId);
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
      effectiveCapacity: plan.effectiveCapacity,
      selected,
      skipped,
      recoveredCreditCircuitTaskIds,
    };
  });
}

export function formatDispatchReport(report) {
  const lines = [
    `StudioOps dispatcher sweep (${report.generatedAt})`,
    `Created runs: ${report.runs.length}  Selected: ${report.selected.length}  Skipped: ${report.skipped.length}${report.dryRun ? "  DRY RUN" : ""}`,
  ];

  const groups = report.effectiveCapacity?.groups || {};
  const capacityText = ["architect", "builder", "reviewer", "owner"]
    .filter((group) => groups[group])
    .map((group) => {
      const capacity = groups[group];
      return `${group} ${capacity.active}+${capacity.selected}/${capacity.configuredLimit} (${capacity.available} available)`;
    })
    .join("; ");
  if (capacityText) {
    lines.push(
      `Effective capacity: ${capacityText}; sweep limit ${report.effectiveCapacity.maxDispatchesPerSweep}`,
    );
  }
  lines.push("");

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

  const constraintSummary = report.skipped.reduce((counts, item) => {
    const constraint = item.constraint || skippedConstraint(item.reason);
    counts[constraint] = (counts[constraint] || 0) + 1;
    return counts;
  }, {});
  const concurrencySkips = constraintSummary.concurrency_limit || 0;
  const conflictSkips = constraintSummary.lane_or_file_scope_conflict || 0;
  if (concurrencySkips || conflictSkips) {
    lines.push(`Capacity constraints: concurrency limits ${concurrencySkips}; lane/file-scope conflicts ${conflictSkips}.`);
  }

  return lines.join("\n").trimEnd();
}
