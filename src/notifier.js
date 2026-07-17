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
    return !run.externalNotifiedAt && run.notificationStatus !== "failed";
  }
  if (run.status === "failed") {
    return !run.failureNotifiedAt && run.notificationStatus !== "failed";
  }
  return false;
}

function notificationFor(state, run) {
  const project = findProject(state, run.projectId);
  const task = findTask(state, run.taskId);
  if (run.status === "failed") {
    return {
      title: "Mission Control run failed",
      subtitle: `${project?.key || run.projectId} · ${run.id}`,
      body: `${task?.title || run.taskId}. Check ${run.outputPath || "the run log"}.`,
    };
  }
  if (run.actionType === "notify_qa_review" || run.actionType === "qa_bundle_ready") {
    return {
      title: "Mission Control QA review ready",
      subtitle: `${project?.key || run.projectId} · ${run.taskId}`,
      body: `${task?.title || "Task ready for local QA"}${run.integrationBranch ? ` · ${run.integrationBranch}` : ""}${run.prUrl ? ` · ${run.prUrl}` : ""}`,
    };
  }
  return {
    title: "Mission Control needs your review",
    subtitle: `${project?.key || run.projectId} · ${run.taskId}`,
    body: `${task?.title || "Task ready for owner review"}${run.prUrl ? ` · ${run.prUrl}` : ""}`,
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

export async function markNotificationAttempt(runId, statusPatch) {
  return mutateState(async (state) => {
    state.events = state.events || [];
    const run = (state.runs || []).find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
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
  for (const run of plan.pending) {
    if (input.dryRun) continue;
    try {
      await sendMacNotification(run.notification);
      sent.push(await markNotificationAttempt(run.id, {
        notificationStatus: "sent",
        notificationChannel: "macos",
      }));
    } catch (error) {
      sent.push(await markNotificationAttempt(run.id, {
        notificationStatus: "failed",
        notificationChannel: "macos",
        notificationError: error.message,
      }));
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
    `Mission Control notifier sweep (${report.generatedAt})`,
    `Pending: ${report.pending.length}  Sent: ${report.sent.length}${report.dryRun ? "  DRY RUN" : ""}`,
    "",
  ];
  if (!report.pending.length) {
    lines.push("No owner, QA bundle, or failure notifications need to be sent.");
  }
  for (const run of report.pending) {
    lines.push(`[${run.id}] ${run.notification.title}`);
    lines.push(`  ${run.notification.subtitle}`);
    lines.push(`  ${run.notification.body}`);
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
