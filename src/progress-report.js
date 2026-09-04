const WINDOW_MS = Object.freeze({ "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 });
const TERMINAL_TASK_STATUSES = new Set(["merged", "deployed", "done", "closed"]);
const MEANINGFUL_EVENT_TYPES = new Set([
  "architecture_completed", "candidate_identity_changed", "github_remote_recovery_verified",
  "qa_passed", "review_recorded", "review_subject_changed", "techops_recovery_succeeded",
  "workflow_state_changed",
]);
const PRIVATE_TEXT_PATTERN = /(?:file:\/\/|\/(?:Users|home|private|var|tmp)\/|\\Users\\|(?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=])/i;
const MAX_RESPONSE_BYTES = 128 * 1024;

const REASON_PRESENTATION = Object.freeze({
  attempt_budget_exhausted: ["Paid attempts are contained for this unchanged failure.", "Run the allowlisted verifier or change the candidate evidence."],
  configuration_invalid: ["Project automation configuration is invalid.", "Repair the project configuration, then run its configuration check."],
  credential_unavailable: ["A required project credential is unavailable.", "Restore the project-scoped credential and run the credential check."],
  dependency_unavailable: ["A required project dependency is unavailable.", "Restore the dependency and run its health check."],
  execution_failed: ["The current execution failed and is contained.", "Inspect the bounded validation evidence and apply one deterministic repair."],
  inaccessible_github_remote: ["The configured GitHub repository is unavailable to its assigned role.", "Restore repository access and run the repository check."],
  output_guard_exceeded: ["Worker output exceeded the bounded evidence limit.", "Narrow the task context or validation output before retrying."],
  provider_auth_failed: ["The model provider rejected project authentication.", "Restore the provider credential and run the credential check."],
  provider_rate_limited: ["The model provider is temporarily rate limited.", "Wait for the recorded backoff, then run one quota check."],
  provider_unavailable: ["The model provider is unavailable.", "Run the provider health check before another paid attempt."],
  repository_unavailable: ["The project repository is unavailable.", "Restore repository access and run the repository check."],
  service_unhealthy: ["A required local service is unhealthy.", "Repair the service and run its health check."],
  stale_pull_request: ["The linked pull request no longer matches the current candidate.", "Create a collision-safe branch from the protected base and relink the exact candidate."],
  validation_failed: ["The exact candidate failed validation.", "Fix the failing validation and create a new candidate generation."],
  unknown_failure: ["Automation stopped on an unclassified failure.", "Inspect bounded evidence and classify the failure before retrying."],
  operator_pause: ["StudioOps automation is paused by the operator.", "Resolve the recorded pause reason, verify health, then resume automation."],
  dependency_wait: ["This task is waiting for a task in the same project.", "Complete the recorded same-project dependency."],
  active_run: ["A bounded worker run is currently active.", "Wait for the current run to finish or enter containment."],
  workflow_gate: ["This task is waiting at its current workflow gate.", "Complete the current review, QA, or promotion gate."],
});

function typedError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isoTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function timeInWindow(value, cutoffMs, nowMs) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed >= cutoffMs && parsed <= nowMs;
}

function boundedToken(value, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 120);
  return normalized || fallback;
}

function safeTitle(value, fallback) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180);
  return text && !PRIVATE_TEXT_PATTERN.test(text) ? text : fallback;
}

export function normalizeProgressWindow(value) {
  const window = String(value || "24h").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(WINDOW_MS, window)) {
    throw typedError("Progress window must be one of 1h, 24h, or 7d.", "PROGRESS_WINDOW_INVALID");
  }
  return window;
}

export function encodeProgressCursor(incident) {
  if (!incident?.updatedAt || !incident?.incidentId) return "";
  return Buffer.from(JSON.stringify({ updatedAt: incident.updatedAt, incidentId: incident.incidentId }), "utf8").toString("base64url");
}

export function decodeProgressCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const updatedAt = isoTime(parsed.updatedAt);
    const incidentId = String(parsed.incidentId || "");
    if (!updatedAt || !/^failure_[a-f0-9]{24}-g[1-9][0-9]*$/.test(incidentId)) throw new Error("invalid");
    return { updatedAt, incidentId };
  } catch {
    throw typedError("Progress cursor is invalid.", "PROGRESS_CURSOR_INVALID");
  }
}

export function resolveProgressProject(state, value) {
  const keyOrId = String(value || "").trim();
  if (!keyOrId) return null;
  const project = (state.projects || []).find((entry) => entry.id === keyOrId || entry.key === keyOrId);
  if (!project) throw typedError("Progress project was not found.", "PROGRESS_PROJECT_NOT_FOUND", 404);
  return project;
}

function waitingReasonForTask(task, state, activeTaskIds, nowMs) {
  const blocker = task.automationBlocker || {};
  const circuit = task.automationCircuit || {};
  const retryAt = isoTime(blocker.retryAt || task.retryNotBefore || circuit.backoffUntil);
  let reasonCode = boundedToken(blocker.reason || circuit.reasonCode || "", "");
  if (!reasonCode && activeTaskIds.has(task.id)) reasonCode = "active_run";
  else if (!reasonCode && (task.dependsOnTaskIds || []).some((id) => {
    const dependency = (state.tasks || []).find((entry) => entry.id === id);
    return dependency && dependency.projectId === task.projectId && !TERMINAL_TASK_STATUSES.has(dependency.status);
  })) reasonCode = "dependency_wait";
  else if (!reasonCode && state.meta?.operatorPause?.active) reasonCode = "operator_pause";
  else if (!reasonCode && !TERMINAL_TASK_STATUSES.has(task.status)) reasonCode = "workflow_gate";
  if (!reasonCode) return null;
  const [reason, nextAction] = REASON_PRESENTATION[reasonCode] || REASON_PRESENTATION.unknown_failure;
  const waiting = {
    taskId: boundedToken(task.id), title: safeTitle(task.title, "Project task"),
    status: boundedToken(task.status), reasonCode, reason, nextAction,
  };
  if (retryAt && Date.parse(retryAt) > nowMs) waiting.retryAt = retryAt;
  return waiting;
}

function safeIncident(incident) {
  const item = {
    incidentId: boundedToken(incident.incidentId), taskId: boundedToken(incident.taskId),
    reasonCode: boundedToken(incident.reasonCode), state: boundedToken(incident.state),
    generation: Math.max(1, Number(incident.generation || 1)),
    paidAttempts: Math.max(0, Number(incident.paidAttempts || 0)),
    cheapProbeAttempts: Math.max(0, Number(incident.cheapProbeAttempts || 0)),
    repairAttempts: Math.max(0, Number(incident.repairAttempts || 0)),
    avoidedRetries: Math.max(0, Number(incident.avoidedRetries || 0)),
    updatedAt: isoTime(incident.updatedAt),
  };
  if (incident.state === "backoff" && isoTime(incident.backoffUntil)) item.retryAt = isoTime(incident.backoffUntil);
  return item;
}

function responseSize(value) { return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8"); }

export function buildProgressReport(state, incidentPage = {}, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const window = normalizeProgressWindow(input.window);
  const cutoffMs = nowMs - WINDOW_MS[window];
  const project = input.project || null;
  const projectId = project?.id || "";
  const tasks = (state.tasks || []).filter((task) => !projectId || task.projectId === projectId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const runs = (state.runs || []).filter((run) => !projectId || run.projectId === projectId);
  const activeTaskIds = new Set(runs.filter((run) => ["queued", "running"].includes(run.status)).map((run) => run.taskId));
  const incidents = (incidentPage.incidents || []).filter((item) => taskIds.has(item.taskId)).map(safeIncident);
  const relevantEvents = (state.events || []).filter((event) => (
    (!projectId || event.projectId === projectId) && timeInWindow(event.createdAt, cutoffMs, nowMs)
  ));
  const summaryIncidents = (incidentPage.windowIncidents || incidentPage.incidents || []).filter((item) => taskIds.has(item.taskId));
  const incidentTotals = incidentPage.incidentTotals || {
    containedFingerprintGenerations: summaryIncidents.filter((item) => ["open", "backoff"].includes(item.state)).length,
    cheapProbesAndRepairs: summaryIncidents.reduce((total, item) => total + Number(item.cheapProbeAttempts || 0) + Number(item.repairAttempts || 0), 0),
    paidModelAttempts: summaryIncidents.reduce((total, item) => total + Number(item.paidAttempts || 0), 0),
    avoidedModelRetries: summaryIncidents.reduce((total, item) => total + Number(item.avoidedRetries || 0), 0),
  };
  const report = {
    schemaVersion: "studioops.progress-report.v1", generatedAt: new Date(nowMs).toISOString(), window,
    project: project ? { id: boundedToken(project.id), key: boundedToken(project.key), name: safeTitle(project.name, "StudioOps project") } : null,
    summary: {
      productiveCompletions: runs.filter((run) => run.status === "completed" && timeInWindow(run.completedAt || run.updatedAt, cutoffMs, nowMs)).length,
      meaningfulAdvances: relevantEvents.filter((event) => MEANINGFUL_EVENT_TYPES.has(event.type)).length,
      containedFingerprintGenerations: Number(incidentTotals.containedFingerprintGenerations || 0),
      cheapProbesAndRepairs: Number(incidentTotals.cheapProbesAndRepairs || 0),
      paidModelAttempts: Number(incidentTotals.paidModelAttempts || 0),
      avoidedModelRetries: Number(incidentTotals.avoidedModelRetries || 0),
    },
    waiting: tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status)).map((task) => waitingReasonForTask(task, state, activeTaskIds, nowMs)).filter(Boolean).slice(0, 100),
    incidents,
    page: { limit: Number(incidentPage.limit || incidents.length || 100), nextCursor: incidentPage.nextCursor || "" },
    degraded: [...new Set((input.degraded || []).map((item) => boundedToken(item)).filter(Boolean))],
  };
  if (responseSize(report) >= MAX_RESPONSE_BYTES) {
    report.incidents = [];
    report.page.nextCursor = incidentPage.nextCursor || encodeProgressCursor(incidentPage.incidents?.at(-1));
    report.degraded.push("incident_details_omitted_for_payload_limit");
  }
  if (responseSize(report) >= MAX_RESPONSE_BYTES) {
    report.waiting = report.waiting.slice(0, 20);
    report.degraded.push("waiting_details_truncated_for_payload_limit");
  }
  if (responseSize(report) >= MAX_RESPONSE_BYTES) throw typedError("Progress response exceeded its bounded payload.", "PROGRESS_PAYLOAD_EXCEEDED", 503);
  return report;
}

export const progressReportLimits = Object.freeze({ maxResponseBytes: MAX_RESPONSE_BYTES, maxIncidentRows: 100 });
