import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mutateState, readState, findProject, findTask } from "./store.js";
import { randomUUID } from "node:crypto";
import { buildOwnerQaPacket, candidateCompletenessGate } from "./owner-inbox.js";

const execFileAsync = promisify(execFile);
const NOTIFIABLE_STATUSES = new Set(["notified", "failed"]);
const OWNER_NOTIFICATION_ACTIONS = new Set([
  "notify_owner",
  "notify_qa_review",
  "qa_bundle_ready",
]);
const MAX_NOTIFICATION_ATTEMPTS = 3;
const NOTIFICATION_RETRY_MS = 5 * 60 * 1000;
const OUTBOX_STATUSES = new Set(["queued", "attempted", "delivered", "acknowledged", "deferred", "failed", "escalated"]);

function nowIso() { return new Date().toISOString(); }

function policyFor(project, input = {}) {
  return {
    channels: input.channels || project?.notificationPolicy?.channels || ["in_app", "macos"],
    doNotDisturb: input.doNotDisturb ?? project?.notificationPolicy?.doNotDisturb ?? false,
    acknowledgementTimeoutMs: Number(input.acknowledgementTimeoutMs || project?.notificationPolicy?.acknowledgementTimeoutMs || 24 * 60 * 60 * 1000),
    maxAttempts: Number(input.maxAttempts || project?.notificationPolicy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS),
  };
}

export function notificationStatusIsValid(status) { return OUTBOX_STATUSES.has(status); }

/** Enqueue once per candidate/channel. The manifest digest is the idempotency key. */
export async function enqueueOwnerQaNotification(candidate, stateInput = null, input = {}) {
  return mutateState(async (state) => {
    const stateForPacket = stateInput || state;
    const persistedCandidate = (state.candidates || []).find((item) => item.id === candidate.id) || candidate;
    const bundle = (state.qaBundles || []).find((item) => item.candidateId === persistedCandidate.id);
    const gate = candidateCompletenessGate(persistedCandidate, stateForPacket, bundle);
    if (!gate.ready) throw new Error(`Candidate is not QA-ready: ${gate.reasons.join(", ")}`);
    const project = findProject(state, persistedCandidate.projectId);
    const packet = persistedCandidate.qaPacket || buildOwnerQaPacket(stateForPacket, persistedCandidate, { ...input, bundle });
    const channels = [...new Set(policyFor(project, input).channels.map(String))];
    state.notificationOutbox = state.notificationOutbox || [];
    const created = [];
    for (const channel of channels) {
      const key = `${persistedCandidate.id}:${persistedCandidate.manifestDigest}:${channel}`;
      let item = state.notificationOutbox.find((entry) => entry.idempotencyKey === key);
      if (!item) {
        item = { id: `notification_${randomUUID()}`, idempotencyKey: key, kind: "owner_qa", projectId: persistedCandidate.projectId, candidateId: persistedCandidate.id, manifestDigest: persistedCandidate.manifestDigest, channel, status: "queued", attempts: 0, packet, policy: policyFor(project, input), createdAt: nowIso(), updatedAt: nowIso() };
        state.notificationOutbox.push(item);
      }
      created.push(item);
    }
    persistedCandidate.qaPacket = packet;
    return created;
  });
}

/** Claim is performed inside mutateState/SQLite's immediate transaction. */
export async function claimNotificationOutbox(input = {}) {
  return mutateState(async (state) => {
    const now = Date.now();
    const limit = Math.max(1, Number(input.limit || 10));
    const claims = (state.notificationOutbox || []).filter((item) => {
      if (!["queued", "failed"].includes(item.status)) return false;
      if (Number(item.attempts || 0) >= Number(item.policy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS)) return false;
      const retryAt = Date.parse(item.retryNotBefore || "");
      return !Number.isFinite(retryAt) || retryAt <= now;
    }).slice(0, limit);
    for (const item of claims) {
      item.status = "attempted";
      item.claimedAt = nowIso();
      item.attempts = Number(item.attempts || 0) + 1;
      item.updatedAt = nowIso();
    }
    return structuredClone(claims);
  });
}

export async function updateNotificationOutbox(id, patch = {}) {
  return mutateState(async (state) => {
    const item = (state.notificationOutbox || []).find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown notification outbox item: ${id}`);
    const status = patch.status || item.status;
    if (!notificationStatusIsValid(status)) throw new Error(`Invalid notification status: ${status}`);
    Object.assign(item, patch, { status, updatedAt: nowIso() });
    if (status === "failed" && Number(item.attempts || 0) < Number(item.policy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS)) item.retryNotBefore = new Date(Date.now() + NOTIFICATION_RETRY_MS).toISOString();
    return structuredClone(item);
  });
}

export async function acknowledgeNotification(id, action, input = {}) {
  if (!["pass", "fail", "request_changes", "defer"].includes(action)) throw new Error(`Unsupported owner action: ${action}`);
  return mutateState(async (state) => {
    const item = (state.notificationOutbox || []).find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown notification outbox item: ${id}`);
    if (input.manifestDigest !== item.manifestDigest) throw new Error("Owner action is bound to a different manifest digest.");
    item.status = action === "defer" ? "deferred" : "acknowledged";
    item.ownerAction = action;
    item.acknowledgedAt = nowIso();
    item.acknowledgedBy = String(input.actor || "owner");
    item.updatedAt = nowIso();
    return structuredClone(item);
  });
}

export async function escalateNotification(id, input = {}) {
  return updateNotificationOutbox(id, { status: "escalated", escalationReason: input.reason || "Owner acknowledgement timeout." });
}

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
  for (const item of state.notificationOutbox || []) {
    if (!["queued", "failed"].includes(item.status) || !notificationRetryReady(item)) continue;
    const project = findProject(state, item.projectId);
    if (!projectAllowed(item, project, input)) continue;
    if (item.policy?.doNotDisturb && !input.ignoreDoNotDisturb) continue;
    if (pending.length >= limit) break;
    pending.push({
      ...item,
      notificationType: "outbox",
      notification: notificationForBundle(item.packet || { projectId: item.projectId, tasks: [], previewUrl: "" }),
    });
  }
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
  const outboxItems = plan.pending.filter((item) => item.notificationType === "outbox");
  const claimed = input.dryRun ? outboxItems : await claimNotificationOutbox({ limit: outboxItems.length || 1 });
  const sent = [];
  for (const item of plan.pending.filter((entry) => entry.notificationType !== "outbox")) {
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
  for (const item of claimed) {
    if (input.dryRun) continue;
    try {
      if (item.channel === "macos") await sendMacNotification(item.notification);
      // in_app is durable by definition; email is an adapter hook supplied by
      // callers so the local-first runtime never invents SMTP credentials.
      else if (item.channel === "email" && typeof input.sendEmail === "function") await input.sendEmail(item.packet, item);
      else if (!["in_app", "email"].includes(item.channel)) throw new Error(`Unsupported notification channel: ${item.channel}`);
      sent.push(await updateNotificationOutbox(item.id, { status: "delivered", deliveredAt: nowIso(), deliveryError: "" }));
    } catch (error) {
      sent.push(await updateNotificationOutbox(item.id, { status: "failed", deliveryError: error.message }));
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
