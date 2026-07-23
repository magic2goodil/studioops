import {
  automationCircuitIsOpen,
  reviewPolicyForProject,
  reviewStagesForProject,
  taskAttemptSummary,
} from "./store.js";
import {
  branchWebUrl,
  integrationBranchName,
  integrationBranchSafetyError,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "./integration-policy.js";

const COMPLETE_STATUSES = new Set(["approved", "merged", "deployed", "done", "closed"]);
const BUILDABLE_STATUSES = new Set(["ready", "queued"]);
const REVIEW_COMPLETE_OUTCOMES = new Set(["approved", "skipped"]);

const PRIORITY_WEIGHT = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function projectForTask(state, task) {
  return state.projects.find((project) => project.id === task.projectId) || null;
}

function taskUrl(baseUrl, task) {
  const trimmedBase = String(baseUrl || "http://127.0.0.1:4317").replace(/\/+$/, "");
  return `${trimmedBase}/tasks/${task.id}`;
}

function promptCommand(task, role) {
  return `node src/mission-control-cli.js prompt ${task.id} --role ${role}`;
}

function reviewCommand(task, stage) {
  return `node src/mission-control-cli.js review ${task.id} --stage ${stage.key} --outcome approved --body "Reviewed ${stage.label || stage.key}."`;
}

function dependenciesForTask(state, task) {
  return (task.dependsOnTaskIds || [])
    .map((taskId) => state.tasks.find((candidate) => candidate.id === taskId))
    .filter(Boolean);
}

function incompleteDependencies(state, task) {
  return dependenciesForTask(state, task).filter((dependency) => !COMPLETE_STATUSES.has(dependency.status));
}

function currentReviewCycle(task) {
  return Number(task.reviewCycle || 0);
}

function latestReviewForStage(state, task, stage) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => Number(review.cycle || 0) === currentReviewCycle(task))
    .filter((review) => review.stageKey === stage.key || review.status === stage.status || review.role === stage.role)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function isLeadReviewStage(stage) {
  const key = String(stage?.key || "").toLowerCase();
  const role = String(stage?.role || "").toLowerCase();
  return key === "lead" || role.includes("lead");
}

function leadReviewStageForProject(project) {
  const stages = reviewStagesForProject(project);
  return stages.find(isLeadReviewStage) || stages[stages.length - 1] || null;
}

function reviewCycleAtLimit(project, task) {
  return currentReviewCycle(task) >= reviewPolicyForProject(project).maxBuilderReviewCycles;
}

function changeRequestedReviewsForCycle(state, task) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => Number(review.cycle || 0) === currentReviewCycle(task))
    .filter((review) => review.outcome === "changes_requested");
}

function leadReviewCompleteForCycle(state, task, project) {
  const leadStage = leadReviewStageForProject(project);
  if (!leadStage) return false;
  const latest = latestReviewForStage(state, task, leadStage);
  return latest && REVIEW_COMPLETE_OUTCOMES.has(latest.outcome);
}

function stageForStatus(project, status) {
  return reviewStagesForProject(project).find((stage) => stage.status === status) || null;
}

function nextOpenReviewStage(state, project, task) {
  if (
    reviewCycleAtLimit(project, task)
    && changeRequestedReviewsForCycle(state, task).length
  ) {
    if (leadReviewCompleteForCycle(state, task, project)) return null;
    return leadReviewStageForProject(project);
  }
  return reviewStagesForProject(project).find((stage) => {
    const latest = latestReviewForStage(state, task, stage);
    return !latest || !REVIEW_COMPLETE_OUTCOMES.has(latest.outcome);
  }) || null;
}

function statusCounts(tasks) {
  return tasks.reduce((counts, task) => {
    counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, {});
}

function projectSummary(state, project) {
  const tasks = state.tasks.filter((task) => task.projectId === project.id);
  const circuit = project.automationCircuit || { state: "closed" };
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    taskCount: tasks.length,
    statuses: statusCounts(tasks),
    circuit: {
      state: automationCircuitIsOpen(project) ? circuit.state : "closed",
      reasonCode: circuit.reasonCode || "",
      normalizedReason: circuit.normalizedReason || "",
      failureFingerprint: circuit.failureFingerprint || "",
      attemptsConsumed: circuit.attemptsConsumed || 0,
      nextCheapProbe: circuit.nextCheapProbe || "",
      resumeAction: circuit.resumeAction || "",
    },
  };
}

function actionBase(state, task, type, role, reason, options = {}) {
  const project = projectForTask(state, task);
  const integrationBranch = task.integrationBranch || options.integrationBranch || integrationBranchName(project);
  const attempts = taskAttemptSummary(state, task);
  const taskCircuit = task.automationCircuit || { state: "closed" };
  const projectCircuit = project?.automationCircuit || { state: "closed" };
  return {
    id: `${task.id}:${type}`,
    type,
    role,
    projectId: project?.id || task.projectId,
    projectKey: project?.key || task.projectId,
    projectName: project?.name || task.projectId,
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    priority: task.priority || "medium",
    reason,
    taskUrl: taskUrl(options.baseUrl, task),
    branchName: task.branchName || "",
    prUrl: task.prUrl || "",
    integrationBranch,
    integrationBranchUrl: task.integrationBranchUrl || branchWebUrl(project, integrationBranch),
    integrationStatus: task.integrationStatus || "",
    promptCommand: role && role !== "owner" && !String(role).includes("integration-worker") ? promptCommand(task, role) : "",
    reviewCommand: options.stage ? reviewCommand(task, options.stage) : "",
    integrationCommand: options.integrationCommand || "",
    nextStatus: options.nextStatus || "",
    circuit: automationCircuitIsOpen(task)
      ? taskCircuit
      : automationCircuitIsOpen(project) ? projectCircuit : { state: "closed" },
    circuitScope: automationCircuitIsOpen(task)
      ? "task"
      : automationCircuitIsOpen(project) ? "project" : "",
    attemptsConsumed: attempts.attemptsConsumed,
    attemptsReserved: attempts.attemptsReserved,
    nextCheapProbe: options.nextCheapProbe || (automationCircuitIsOpen(task)
      ? taskCircuit.nextCheapProbe || ""
      : projectCircuit.nextCheapProbe || ""),
    resumeAction: options.resumeAction || (automationCircuitIsOpen(task)
      ? taskCircuit.resumeAction || ""
      : projectCircuit.resumeAction || ""),
    dependencies: dependenciesForTask(state, task).map((dependency) => ({
      id: dependency.id,
      status: dependency.status,
      title: dependency.title,
    })),
  };
}

function reviewCompleteAction(state, task, project, reason, options = {}) {
  if (projectUsesTrustLeadQa(project)) {
    return actionBase(state, task, "run_qa_integration", "qa-integration-worker", reason, {
      ...options,
      nextStatus: "qa_review",
      integrationCommand: `npm run qa-integrate -- --project ${project.key}`,
    });
  }

  if (trustLeadApprovalsEnabled(project)) {
    const safetyReason = integrationBranchSafetyError(project);
    if (safetyReason) {
      return actionBase(state, task, "notify_owner", "owner", `${reason} Trust Leads QA integration is not eligible: ${safetyReason}`, {
        ...options,
        nextStatus: "user_review",
      });
    }
  }

  return actionBase(state, task, "notify_owner", "owner", reason, {
    ...options,
    nextStatus: "user_review",
  });
}

function taskActions(state, task, options = {}) {
  const project = projectForTask(state, task);
  if (!project) {
    return [actionBase(state, task, "repair_task_project", "owner", "Task is attached to a missing project.", options)];
  }

  const hasChildren = (state.tasks || []).some((candidate) => candidate.parentTaskId === task.id);
  if (task.type === "epic" || hasChildren) return [];

  if (state.meta?.operatorPause?.active) {
    return [actionBase(
      state,
      task,
      "waiting_for_operator_resume",
      "",
      `Global operator pause is active: ${state.meta.operatorPause.reason || "No new durable runs are allowed."} Selected in-flight runs may finish; resume action: ${state.meta.operatorPause.actionRequired || "studioops automation-resume"}`,
      options,
    )];
  }

  if (automationCircuitIsOpen(project)) {
    const circuit = project.automationCircuit;
    return [actionBase(
      state,
      task,
      "repair_project_circuit",
      "owner",
      `Project automation circuit is open for ${circuit.reasonCode || circuit.failureFingerprint || "a configuration failure"}. ${circuit.remediation || ""} Next cheap probe: ${circuit.nextCheapProbe || "(not recorded)"}. Exact resume action: ${circuit.resumeAction || `studioops circuit-probe --project ${project.key}`}`,
      options,
    )];
  }

  if (automationCircuitIsOpen(task)) {
    const circuit = task.automationCircuit;
    return [actionBase(
      state,
      task,
      "repair_task_circuit",
      "owner",
      `Task automation circuit is open for ${circuit.reasonCode || circuit.failureFingerprint || "a repeated failure"} after ${circuit.attemptsConsumed || 0}/${circuit.maxAttempts || "?"} attempts. ${circuit.remediation || ""} Next cheap probe: ${circuit.nextCheapProbe || "(not recorded)"}. Exact resume action: ${circuit.resumeAction || `studioops circuit-probe --task ${task.id}`}`,
      options,
    )];
  }

  const missingDependencies = incompleteDependencies(state, task);
  const retryNotBefore = Date.parse(task.retryNotBefore || "");
  if (Number.isFinite(retryNotBefore) && retryNotBefore > Date.now()) {
    return [actionBase(
      state,
      task,
      "waiting_for_retry",
      "",
      `Automatic retry is paused until ${task.retryNotBefore} after ${task.lastAutomationFailure || "a worker failure"}.`,
      options,
    )];
  }

  if (BUILDABLE_STATUSES.has(task.status)) {
    if (missingDependencies.length) {
      return [actionBase(
        state,
        task,
        "waiting_on_dependency",
        "",
        `Waiting on unfinished dependencies: ${missingDependencies.map((dependency) => `${dependency.id} (${dependency.status})`).join(", ")}.`,
        options,
      )];
    }
    return [actionBase(state, task, "start_builder", "builder", "Task is queued and dependencies are complete.", {
      ...options,
      nextStatus: "in_progress",
    })];
  }

  if (task.status === "blocked") {
    if (task.automationBlocker) {
      const blocker = task.automationBlocker;
      return [actionBase(
        state,
        task,
        "repair_automation_config",
        "owner",
        `Automation is paused after ${blocker.runId || "a runner failure"}: ${blocker.reason || "worker error"}. Repair the blocker or add owner guidance, then restore the task to ${blocker.resumeStatus || "its prior workflow state"}.`,
        {
          ...options,
          nextStatus: blocker.resumeStatus || "queued",
        },
      )];
    }
    if (missingDependencies.length) {
      return [actionBase(
        state,
        task,
        "blocked",
        "",
        `Still blocked by: ${missingDependencies.map((dependency) => `${dependency.id} (${dependency.status})`).join(", ")}.`,
        options,
      )];
    }
    return [actionBase(state, task, "unblock_task", "builder", "Dependencies are complete; task can return to the builder queue.", {
      ...options,
      nextStatus: "queued",
    })];
  }

  if (task.status === "needs_changes") {
    return [actionBase(state, task, "start_builder_fix", "builder", "Review requested changes; builder should update the existing branch/PR or split work if requested.", {
      ...options,
      nextStatus: "in_progress",
    })];
  }

  if (task.status === "builder_review") {
    if (!task.branchName || !task.prUrl) {
      return [actionBase(state, task, "return_to_builder", "builder", "Builder review intake is incomplete: branch and PR URL are required before reviewer routing.", {
        ...options,
        nextStatus: "needs_changes",
      })];
    }
    const nextStage = nextOpenReviewStage(state, project, task);
    if (!nextStage) {
      return [reviewCompleteAction(state, task, project, "All review stages are complete.", options)];
    }
    return [actionBase(state, task, "start_review", nextStage.role, `Ready for ${nextStage.label || nextStage.key}.`, {
      ...options,
      stage: nextStage,
      nextStatus: nextStage.status,
    })];
  }

  const currentStage = stageForStatus(project, task.status);
  if (currentStage) {
    const latest = latestReviewForStage(state, task, currentStage);
    if (!latest) {
      return [actionBase(state, task, "continue_review", currentStage.role, `${currentStage.label || currentStage.key} has not recorded an outcome yet.`, {
        ...options,
        stage: currentStage,
      })];
    }
    if (latest.outcome === "changes_requested") {
      const policy = reviewPolicyForProject(project);
      if (policy.leadOwnsFinalDecisionAtLimit && reviewCycleAtLimit(project, task)) {
        const leadStage = leadReviewStageForProject(project);
        if (leadStage && !isLeadReviewStage(currentStage)) {
          return [actionBase(state, task, "start_review", leadStage.role, `${currentStage.label || currentStage.key} requested changes at the ${policy.maxBuilderReviewCycles}-cycle review limit; route to lead for final decision.`, {
            ...options,
            stage: leadStage,
            nextStatus: leadStage.status,
          })];
        }
        if (isLeadReviewStage(currentStage)) {
          return [actionBase(state, task, "notify_owner", "owner", `${currentStage.label || currentStage.key} requested changes after the ${policy.maxBuilderReviewCycles}-cycle review limit; human owner decision is required.`, {
            ...options,
            nextStatus: "user_review",
          })];
        }
      }
      return [actionBase(state, task, "return_to_builder", "builder", `${currentStage.label || currentStage.key} requested changes.`, {
        ...options,
        nextStatus: "needs_changes",
      })];
    }
    const nextStage = nextOpenReviewStage(state, project, task);
    if (nextStage) {
      return [actionBase(state, task, "start_review", nextStage.role, `${currentStage.label || currentStage.key} is complete; ready for ${nextStage.label || nextStage.key}.`, {
        ...options,
        stage: nextStage,
        nextStatus: nextStage.status,
      })];
    }
    return [reviewCompleteAction(state, task, project, "All review stages are complete.", options)];
  }

  if (task.status === "qa_review") {
    if (!projectUsesTrustLeadQa(project)) {
      return [actionBase(state, task, "qa_integration_config_error", "owner", `QA review is waiting, but the project integration branch is not eligible: ${integrationBranchSafetyError(project) || "Trust Leads QA integration is disabled."}`, options)];
    }
    if (task.integrationStatus === "ready") {
      return [actionBase(state, task, "qa_bundle_ready", "owner", "QA integration branch is validated and ready for local owner testing.", options)];
    }
    if (task.integrationStatus === "preview_blocked") {
      const healthProbe = task.localQaPreview?.healthProbe || {};
      return [actionBase(
        state,
        task,
        "repair_qa_preview",
        "owner",
        `The QA branch is already integrated and validated, but the local preview probe failed${healthProbe.diagnosticCode ? ` with ${healthProbe.diagnosticCode}` : ""}. ${healthProbe.message || "Repair the preview service without rebuilding the feature PR."} ${healthProbe.remediation || ""}`.trim(),
        {
          ...options,
          nextCheapProbe: `Run \`npm run qa-integrate -- --project ${project.key} --task ${task.id}\`; StudioOps will probe the existing integrated commit without a model or feature rebuild.`,
          resumeAction: "A successful preview probe automatically restores integrationStatus=ready; no model circuit reset is required.",
        },
      )];
    }
    if (["conflict", "validation_failed", "push_failed", "blocked"].includes(task.integrationStatus)) {
      return [actionBase(state, task, "qa_integration_blocked", "builder", `QA integration is blocked with status ${task.integrationStatus}. Review task comments and update the PR branch before rerunning integration.`, options)];
    }
    return [actionBase(state, task, "run_qa_integration", "qa-integration-worker", "Task is lead-approved and waiting for the QA integration branch worker.", {
      ...options,
      integrationCommand: `npm run qa-integrate -- --project ${project.key}`,
    })];
  }

  if (task.status === "user_review") {
    if (task.qaBundleId && task.promotionPrUrl) {
      return [actionBase(state, task, "release_candidate_ready", "", "A validated release-candidate PR is ready for owner review.", options)];
    }
    return [actionBase(state, task, "notify_owner", "owner", "Task is ready for final human review.", options)];
  }

  return [];
}

function sortActions(actions) {
  return actions.sort((a, b) => {
    const priority = (PRIORITY_WEIGHT[a.priority] ?? 2) - (PRIORITY_WEIGHT[b.priority] ?? 2);
    if (priority !== 0) return priority;
    return `${a.projectKey}:${a.taskId}:${a.type}`.localeCompare(`${b.projectKey}:${b.taskId}:${b.type}`);
  });
}

export function createSupervisorReport(state, options = {}) {
  const allActions = sortActions((state.tasks || []).flatMap((task) => taskActions(state, task, options)));
  const passiveActionTypes = new Set(["waiting_on_dependency", "waiting_for_retry", "waiting_for_operator_resume", "blocked", "release_candidate_ready"]);
  const actions = options.includeWaiting || options.all
    ? allActions
    : allActions.filter((action) => !passiveActionTypes.has(action.type));
  return {
    generatedAt: new Date().toISOString(),
    intervalSeconds: Number(options.intervalSeconds || 300),
    mode: options.mode || "once",
    operatorPause: state.meta?.operatorPause || { active: false },
    dispatchBudget: state.meta?.dispatchBudget || null,
    projects: (state.projects || []).map((project) => projectSummary(state, project)),
    totals: {
      projects: (state.projects || []).length,
      tasks: (state.tasks || []).length,
      actions: actions.length,
      waiting: allActions.filter((action) => passiveActionTypes.has(action.type)).length,
      actionsByType: actions.reduce((counts, action) => {
        counts[action.type] = (counts[action.type] || 0) + 1;
        return counts;
      }, {}),
    },
    actions,
  };
}

export function formatSupervisorReport(report) {
  const lines = [
    `StudioOps supervisor sweep (${report.generatedAt})`,
    `Projects: ${report.totals.projects}  Tasks: ${report.totals.tasks}  Actions: ${report.totals.actions}  Waiting: ${report.totals.waiting}`,
    "",
  ];

  if (report.operatorPause?.active) {
    lines.push(
      `GLOBAL OPERATOR PAUSE: ${report.operatorPause.reason || "New durable runs are disabled."}`,
      `Resume: ${report.operatorPause.actionRequired || "studioops automation-resume"}`,
      "",
    );
  }
  if (report.dispatchBudget?.pause) {
    lines.push(
      `MODEL RUN BUDGET PAUSE: ${report.dispatchBudget.pause.reason}`,
      `Resumes: ${report.dispatchBudget.pause.resumesAt || "(not recorded)"}`,
      "",
    );
  }

  if (!report.actions.length) {
    lines.push("No actionable work found.");
    return lines.join("\n");
  }

  for (const action of report.actions) {
    const target = action.role ? ` -> ${action.role}` : "";
    lines.push(`[${action.projectKey}] ${action.taskId} ${action.type}${target}`);
    lines.push(`  ${action.taskTitle}`);
    lines.push(`  Reason: ${action.reason}`);
    lines.push(`  Task: ${action.taskUrl}`);
    if (action.prUrl) lines.push(`  PR: ${action.prUrl}`);
    if (action.branchName) lines.push(`  Branch: ${action.branchName}`);
    if (action.integrationBranch) lines.push(`  QA branch: ${action.integrationBranch}${action.integrationBranchUrl ? ` (${action.integrationBranchUrl})` : ""}`);
    if (action.integrationStatus) lines.push(`  QA status: ${action.integrationStatus}`);
    if (action.circuitScope) {
      lines.push(`  Circuit: ${action.circuitScope}/${action.circuit.state || "open"} ${action.circuit.reasonCode || action.circuit.failureFingerprint || ""}`.trimEnd());
      lines.push(`  Attempts consumed: ${action.attemptsConsumed}`);
    }
    if (action.nextCheapProbe) lines.push(`  Next cheap probe: ${action.nextCheapProbe}`);
    if (action.resumeAction) lines.push(`  Resume: ${action.resumeAction}`);
    if (action.promptCommand) lines.push(`  Prompt: ${action.promptCommand}`);
    if (action.reviewCommand) lines.push(`  Review command: ${action.reviewCommand}`);
    if (action.integrationCommand) lines.push(`  Integration command: ${action.integrationCommand}`);
    if (action.nextStatus) lines.push(`  Next status: ${action.nextStatus}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
