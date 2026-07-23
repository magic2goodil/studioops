import { findProject, findTask } from "./store.js";
import { projectUsesTrustLeadQa } from "./integration-policy.js";

const OWNER_ACTIONS = new Set(["notify_owner", "notify_qa_review", "qa_bundle_ready"]);
const QA_BUNDLE_STATUSES = new Set(["ready", "partially_reviewed", "release_candidate_ready"]);

function latestRunForTask(state, taskId) {
  return [...(state.runs || [])]
    .filter((run) => run.taskId === taskId && OWNER_ACTIONS.has(run.actionType))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
}

function projectPreviewUrl(project) {
  return String(
    project?.localQaPreview?.previewUrl
    || project?.qaIntegration?.localPreview?.previewUrl
    || "",
  ).trim();
}

function taskUrl(baseUrl, taskId) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
}

function notificationSummary(run) {
  if (!run) {
    return {
      status: "pending",
      channel: "",
      attemptedAt: "",
      error: "",
    };
  }
  return {
    status: run.notificationStatus || (run.externalNotifiedAt ? "sent" : "pending"),
    channel: run.notificationChannel || "",
    attemptedAt: run.externalNotifiedAt || run.notificationFailedAt || "",
    error: run.notificationError || "",
  };
}

function checklistForTask(task) {
  const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [];
  return criteria.map((text) => ({
    taskId: task.id,
    taskTitle: task.title,
    text: String(text),
  }));
}

function recoveryChecklist(circuit = {}) {
  return [
    circuit.nextCheapProbe
      || "Inspect the preserved failure evidence and verify the underlying blocker without launching another model.",
    circuit.remediation
      || "Repair the blocker, then explicitly reset the circuit with a recorded verification reason.",
  ].map((text) => ({ taskId: "", taskTitle: "", text }));
}

function taskInboxItem(state, task, input = {}) {
  const project = findProject(state, task.projectId);
  const run = latestRunForTask(state, task.id);
  const blocked = task.automationCircuit?.state === "open"
    || (task.status === "blocked" && Boolean(task.automationBlocker));
  const qaReady = task.status === "qa_review";
  const previewUrl = projectPreviewUrl(project);
  return {
    id: `task:${task.id}`,
    kind: blocked ? "automation_blocked" : qaReady ? "qa_review" : "owner_review",
    severity: blocked ? "critical" : "action",
    projectId: project?.id || task.projectId,
    projectKey: project?.key || task.projectId,
    projectName: project?.name || task.projectId,
    taskId: task.id,
    title: task.title,
    status: blocked ? "automation_blocked" : task.status,
    taskUrl: taskUrl(input.baseUrl, task.id),
    prUrl: task.prUrl || "",
    branchName: task.branchName || "",
    integrationBranch: task.integrationBranch || project?.reviewPolicy?.integrationBranch || project?.integrationBranch || "",
    previewUrl,
    nextAction: blocked
      ? task.automationCircuit?.resumeAction || "Inspect the blocker and reset the circuit after remediation."
      : qaReady
        ? "Open the local QA preview and record a pass or failure."
        : "Review the task and pull request, then approve or request changes.",
    blocker: blocked ? {
      reason: task.automationCircuit?.normalizedReason
        || task.automationBlocker?.reason
        || task.lastAutomationFailure
        || "Automation is blocked.",
      attempts: Number(task.automationCircuit?.attemptsConsumed || task.automationBlocker?.attempts || 0),
      maxAttempts: Number(task.automationCircuit?.maxAttempts || 0),
    } : null,
    checklistLabel: blocked ? "Recovery checklist" : qaReady ? "QA checklist" : "Review checklist",
    checklist: blocked ? recoveryChecklist(task.automationCircuit) : checklistForTask(task),
    notification: notificationSummary(run),
    updatedAt: task.updatedAt || task.createdAt || "",
  };
}

function projectInboxItem(project) {
  const circuit = project.automationCircuit || {};
  const target = project.key || project.id;
  return {
    id: `project:${project.id}:automation-circuit`,
    kind: "project_automation_blocked",
    severity: "critical",
    projectId: project.id,
    projectKey: project.key || project.id,
    projectName: project.name || project.key || project.id,
    title: `${project.name || project.key || project.id} automation circuit is open`,
    status: "automation_blocked",
    taskUrl: "",
    prUrl: "",
    branchName: "",
    integrationBranch: project.reviewPolicy?.integrationBranch || project.integrationBranch || "",
    previewUrl: projectPreviewUrl(project),
    nextAction: circuit.resumeAction
      || `studioops circuit-reset --project ${target} --reason verified`,
    blocker: {
      reason: circuit.normalizedReason || circuit.reasonCode || "Project automation is blocked.",
      attempts: Number(circuit.attemptsConsumed || 0),
      maxAttempts: Number(circuit.maxAttempts || 0),
    },
    checklistLabel: "Recovery checklist",
    checklist: recoveryChecklist(circuit),
    notification: {
      status: "not_applicable",
      channel: "",
      attemptedAt: "",
      error: "",
    },
    updatedAt: circuit.openedAt || project.updatedAt || project.createdAt || "",
  };
}

function bundleTaskRecords(state, bundle) {
  return (bundle.tasks || [])
    .map((item) => findTask(state, item.id || item.taskId || item))
    .filter(Boolean);
}

function bundleInboxItem(state, bundle, input = {}) {
  const project = findProject(state, bundle.projectId);
  const tasks = bundleTaskRecords(state, bundle);
  return {
    id: `bundle:${bundle.id}`,
    kind: bundle.status === "release_candidate_ready" ? "release_candidate" : "qa_bundle",
    severity: "action",
    projectId: project?.id || bundle.projectId,
    projectKey: project?.key || bundle.projectId,
    projectName: project?.name || bundle.projectId,
    bundleId: bundle.id,
    title: bundle.status === "release_candidate_ready"
      ? `${tasks.length} change${tasks.length === 1 ? "" : "s"} ready for release review`
      : `${tasks.length} change${tasks.length === 1 ? "" : "s"} ready for local QA`,
    status: bundle.status,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      taskUrl: taskUrl(input.baseUrl, task.id),
      prUrl: task.prUrl || "",
    })),
    prUrl: bundle.promotionPrUrl || "",
    integrationBranch: bundle.integrationBranch || "",
    previewUrl: bundle.previewUrl || projectPreviewUrl(project),
    nextAction: bundle.status === "release_candidate_ready"
      ? "Review the release-candidate pull request. Production still requires explicit approval."
      : "Open the local QA preview and test the listed tasks as one bundle.",
    checklistLabel: "QA checklist",
    checklist: tasks.flatMap(checklistForTask),
    notification: {
      status: bundle.notificationStatus || (bundle.notifiedAt || bundle.promotionNotifiedAt ? "sent" : "pending"),
      channel: bundle.notificationChannel || "",
      attemptedAt: bundle.notifiedAt || bundle.promotionNotifiedAt || bundle.notificationFailedAt || "",
      error: bundle.notificationError || "",
    },
    updatedAt: bundle.updatedAt || bundle.createdAt || "",
  };
}

export function buildOwnerInbox(state, input = {}) {
  const activeBundleTaskIds = new Set(
    (state.qaBundles || [])
      .filter((bundle) => QA_BUNDLE_STATUSES.has(bundle.status))
      .flatMap((bundle) => (bundle.tasks || []).map((task) => task.id || task.taskId || task)),
  );
  const items = [];

  for (const bundle of state.qaBundles || []) {
    if (QA_BUNDLE_STATUSES.has(bundle.status)) items.push(bundleInboxItem(state, bundle, input));
  }

  for (const project of state.projects || []) {
    if (project.automationCircuit?.state === "open") items.push(projectInboxItem(project));
  }

  for (const task of state.tasks || []) {
    const project = findProject(state, task.projectId);
    const blocked = task.automationCircuit?.state === "open"
      || (task.status === "blocked" && Boolean(task.automationBlocker));
    const ownerReview = task.status === "user_review";
    const qaValidationReady = task.integrationStatus === "ready"
      || (!projectUsesTrustLeadQa(project) && Boolean(projectPreviewUrl(project)));
    const standaloneQa = task.status === "qa_review"
      && qaValidationReady
      && !activeBundleTaskIds.has(task.id);
    if (blocked || ownerReview || standaloneQa) items.push(taskInboxItem(state, task, input));
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const operatorPause = state.meta?.operatorPause?.active ? {
    ...state.meta.operatorPause,
    active: true,
  } : null;

  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
    operatorPause,
  };
}
