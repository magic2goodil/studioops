import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mutateState, readState, findProject, findTask } from "./store.js";

const execFileAsync = promisify(execFile);
const NOTIFIABLE_STATUSES = new Set(["notified", "failed"]);
const OWNER_NOTIFICATION_ACTIONS = new Set([
  "notify_owner",
  "notify_qa_review",
  "qa_bundle_ready",
]);
const MAX_NOTIFICATION_ATTEMPTS = 3;
const NOTIFICATION_RETRY_MS = 5 * 60 * 1000;

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

function projectAllowed(run, project, options) {
  const onlyProjects = normalizeList(options.project || options.projects);
  if (!onlyProjects.length) return true;
  return onlyProjects.includes(project?.key) || onlyProjects.includes(project?.id) || onlyProjects.includes(run.projectId);
}

function needsNotification(run) {
  if (!NOTIFIABLE_STATUSES.has(run.status)) return false;
  if (
    run.status === "notified"
    && run.group === "owner"
    && OWNER_NOTIFICATION_ACTIONS.has(run.actionType)
  ) {
    return !run.externalNotifiedAt && notificationRetryReady(run);
  }
  if (run.status === "failed") {
    return !run.failureNotifiedAt && notificationRetryReady(run);
  }
  return false;
}

export function notificationRetryReady(item) {
  if (item.notificationStatus !== "failed") return true;
  if (Number(item.notificationAttempts || 0) >= MAX_NOTIFICATION_ATTEMPTS) return false;
  const retryAt = Date.parse(item.notificationRetryNotBefore || "");
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

function notificationFor(state, run) {
  const project = findProject(state, run.projectId);
  const task = findTask(state, run.taskId);
  if (run.status === "failed") {
    const failureNote = String(run.notes || run.exitCode || "").trim();
    const logHint = run.outputPath ? ` Log: ${run.outputPath}` : "";
    return {
      title: "StudioOps run failed",
      subtitle: `${project?.key || run.projectId} · ${run.id}`,
      body: `${task?.title || run.taskId}.${failureNote ? ` ${failureNote}` : ""}${logHint}`,
    };
  }
  if (run.actionType === "notify_qa_review" || run.actionType === "qa_bundle_ready") {
    return {
      title: "StudioOps QA review ready",
      subtitle: `${project?.key || run.projectId} · ${run.taskId}`,
      body: `${task?.title || "Task ready for local QA"}${run.integrationBranch ? ` · ${run.integrationBranch}` : ""}${run.prUrl ? ` · ${run.prUrl}` : ""}`,
    };
  }
  return {
    title: "StudioOps needs your review",
    subtitle: `${project?.key || run.projectId} · ${run.taskId}`,
    body: `${task?.title || "Task ready for owner review"}${run.prUrl ? ` · ${run.prUrl}` : ""}`,
  };
}

export function notificationForBundle(bundle) {
  const taskSummary = (bundle.tasks || [])
    .slice(0, 4)
    .map((task) => `${task.id} ${task.title}`)
    .join("; ");
  const remainder = Math.max(0, (bundle.tasks || []).length - 4);
  const releaseCandidate = bundle.status === "release_candidate_ready";
  return {
    title: releaseCandidate ? "StudioOps release candidate ready" : "StudioOps QA bundle ready",
    subtitle: `${bundle.projectKey || bundle.projectId} · ${bundle.tasks?.length || 0} task(s)`,
    body: `${taskSummary}${remainder ? `; and ${remainder} more` : ""}${releaseCandidate ? ` · ${bundle.promotionPrUrl || bundle.promotionBranch || "PR ready"}` : bundle.previewUrl ? ` · ${bundle.previewUrl}` : ""}`,
  };
}

function appleScriptString(value) {
  return `"${String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", " ")
    .slice(0, 240)}"`;
}

export async function sendMacNotification(notification) {
  const script = [
    "display notification",
    appleScriptString(notification.body),
    "with title",
    appleScriptString(notification.title),
    notification.subtitle ? `subtitle ${appleScriptString(notification.subtitle)}` : "",
  ].filter(Boolean).join(" ");
  await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
}

export async function planNotifications(input = {}) {
  const state = await readState();
  const pending = [];
  const skipped = [];
  const limit = Math.max(1, Number(input.limit || input.maxNotifications || 10));
  for (const bundle of state.qaBundles || []) {
    const qaReady = bundle.status === "ready" && !bundle.notifiedAt;
    const promotionReady = bundle.status === "release_candidate_ready" && !bundle.promotionNotifiedAt;
    if ((!qaReady && !promotionReady) || !notificationRetryReady(bundle)) continue;
    const project = findProject(state, bundle.projectId);
    if (!projectAllowed(bundle, project, input)) {
      skipped.push({ bundleId: bundle.id, reason: "project_filter" });
      continue;
    }
    if (pending.length >= limit) {
      skipped.push({ bundleId: bundle.id, reason: "notifier_limit" });
      continue;
    }
    pending.push({
      ...bundle,
      notificationType: "qa_bundle",
      notification: notificationForBundle(bundle),
    });
  }
  for (const run of state.runs || []) {
    if (!needsNotification(run)) continue;
    const project = findProject(state, run.projectId);
    if (!projectAllowed(run, project, input)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "project_filter" });
      continue;
    }
    if (pending.length >= limit) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "notifier_limit" });
      continue;
    }
    pending.push({
      ...run,
      notification: notificationFor(state, run),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    pending,
    skipped,
  };
}

export async function markNotificationAttempt(itemId, statusPatch, notificationType = "run") {
  return mutateState(async (state) => {
    state.events = state.events || [];
    if (notificationType === "qa_bundle") {
      const bundle = (state.qaBundles || []).find((item) => item.id === itemId);
      if (!bundle) throw new Error(`Unknown QA bundle: ${itemId}`);
      const now = new Date().toISOString();
      bundle.notificationStatus = statusPatch.notificationStatus || "sent";
      bundle.notificationChannel = statusPatch.notificationChannel || "macos";
      bundle.notificationError = statusPatch.notificationError || "";
      bundle.notificationAttempts = Number(bundle.notificationAttempts || 0) + 1;
      bundle.updatedAt = now;
      if (bundle.notificationStatus === "sent") {
        if (bundle.status === "release_candidate_ready") bundle.promotionNotifiedAt = now;
        else bundle.notifiedAt = now;
        bundle.notificationRetryNotBefore = "";
      } else if (bundle.notificationAttempts < MAX_NOTIFICATION_ATTEMPTS) {
        bundle.notificationRetryNotBefore = new Date(Date.now() + NOTIFICATION_RETRY_MS).toISOString();
      }
      state.events.push({
        id: nextId(state.events, "event"),
        type: "qa_bundle_notification",
        projectId: bundle.projectId,
        message: `${bundle.id} notification ${bundle.notificationStatus} via ${bundle.notificationChannel}`,
        createdAt: now,
      });
      return bundle;
    }
    const run = (state.runs || []).find((item) => item.id === itemId);
    if (!run) throw new Error(`Unknown run: ${itemId}`);
    const now = new Date().toISOString();
    if (statusPatch.notificationStatus === "sent") {
      if (run.status === "failed") run.failureNotifiedAt = now;
      else run.externalNotifiedAt = now;
    } else {
      run.notificationFailedAt = now;
    }
    run.notificationStatus = statusPatch.notificationStatus || "sent";
    run.notificationChannel = statusPatch.notificationChannel || "macos";
    run.notificationError = statusPatch.notificationError || "";
    run.notificationAttempts = Number(run.notificationAttempts || 0) + 1;
    if (run.notificationStatus === "sent") run.notificationRetryNotBefore = "";
    else if (run.notificationAttempts < MAX_NOTIFICATION_ATTEMPTS) {
      run.notificationRetryNotBefore = new Date(Date.now() + NOTIFICATION_RETRY_MS).toISOString();
    }
    run.updatedAt = now;
    state.events.push({
      id: nextId(state.events, "event"),
      type: "notification_sent",
      projectId: run.projectId,
      taskId: run.taskId,
      message: `${run.id} notification ${run.notificationStatus} via ${run.notificationChannel}`,
      createdAt: now,
    });
    return run;
  });
}

export async function sendPendingNotifications(input = {}) {
  const plan = await planNotifications(input);
  const sent = [];
  for (const item of plan.pending) {
    if (input.dryRun) continue;
    try {
      await sendMacNotification(item.notification);
      sent.push(await markNotificationAttempt(item.id, {
        notificationStatus: "sent",
        notificationChannel: "macos",
      }, item.notificationType));
    } catch (error) {
      sent.push(await markNotificationAttempt(item.id, {
        notificationStatus: "failed",
        notificationChannel: "macos",
        notificationError: error.message,
      }, item.notificationType));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    pending: plan.pending,
    skipped: plan.skipped,
    sent,
    dryRun: Boolean(input.dryRun),
  };
}

export function formatNotificationReport(report) {
  const lines = [
    `StudioOps notifier sweep (${report.generatedAt})`,
    `Pending: ${report.pending.length}  Sent: ${report.sent.length}${report.dryRun ? "  DRY RUN" : ""}`,
    "",
  ];
  if (!report.pending.length) {
    lines.push("No owner, QA bundle, or failure notifications need to be sent.");
  }
  for (const item of report.pending) {
    lines.push(`[${item.id}] ${item.notification.title}`);
    lines.push(`  ${item.notification.subtitle}`);
    lines.push(`  ${item.notification.body}`);
    lines.push("");
  }
  const skippedSummary = (report.skipped || []).reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  const skippedText = Object.entries(skippedSummary)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  if (skippedText) lines.push(`Skipped: ${skippedText}`);
  return lines.join("\n").trimEnd();
}
