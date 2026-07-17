import { reviewPolicyForProject, reviewStagesForProject } from "./store.js";
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
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    taskCount: tasks.length,
    statuses: statusCounts(tasks),
  };
}

function actionBase(state, task, type, role, reason, options = {}) {
  const project = projectForTask(state, task);
  const integrationBranch = task.integrationBranch || options.integrationBranch || integrationBranchName(project);
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

  const missingDependencies = incompleteDependencies(state, task);

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
    if (["conflict", "validation_failed", "push_failed", "blocked"].includes(task.integrationStatus)) {
      return [actionBase(state, task, "qa_integration_blocked", "builder", `QA integration is blocked with status ${task.integrationStatus}. Review task comments and update the PR branch before rerunning integration.`, options)];
    }
    return [actionBase(state, task, "run_qa_integration", "qa-integration-worker", "Task is lead-approved and waiting for the QA integration branch worker.", {
      ...options,
      integrationCommand: `npm run qa-integrate -- --project ${project.key}`,
    })];
  }

  if (task.status === "user_review") {
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
  const passiveActionTypes = new Set(["waiting_on_dependency", "blocked"]);
  const actions = options.includeWaiting || options.all
    ? allActions
    : allActions.filter((action) => !passiveActionTypes.has(action.type));
  return {
    generatedAt: new Date().toISOString(),
    intervalSeconds: Number(options.intervalSeconds || 300),
    mode: options.mode || "once",
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
    `Mission Control supervisor sweep (${report.generatedAt})`,
    `Projects: ${report.totals.projects}  Tasks: ${report.totals.tasks}  Actions: ${report.totals.actions}  Waiting: ${report.totals.waiting}`,
    "",
  ];

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
    if (action.promptCommand) lines.push(`  Prompt: ${action.promptCommand}`);
    if (action.reviewCommand) lines.push(`  Review command: ${action.reviewCommand}`);
    if (action.integrationCommand) lines.push(`  Integration command: ${action.integrationCommand}`);
    if (action.nextStatus) lines.push(`  Next status: ${action.nextStatus}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
