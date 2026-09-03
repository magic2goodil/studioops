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
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const OUTBOX_STATUSES = new Set(["queued", "attempted", "delivered", "acknowledged", "deferred", "failed", "escalated"]);

function nowIso() { return new Date().toISOString(); }

function policyFor(project, input = {}) {
  return {
    channels: input.channels || project?.notificationPolicy?.channels || ["in_app", "macos"],
    doNotDisturb: input.doNotDisturb ?? project?.notificationPolicy?.doNotDisturb ?? false,
    acknowledgementTimeoutMs: Math.max(60_000, Number(input.acknowledgementTimeoutMs || project?.notificationPolicy?.acknowledgementTimeoutMs || 24 * 60 * 60 * 1000)),
    maxAttempts: Math.max(1, Number(input.maxAttempts || project?.notificationPolicy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS)),
  };
}

export function notificationStatusIsValid(status) { return OUTBOX_STATUSES.has(status); }

function pipelineStallFingerprint(assessment = {}) {
  return String(assessment.fingerprint || `${assessment.taskId || "unknown"}:${assessment.cause || "unknown"}`)
    .slice(0, 500);
}

export function pipelineLivenessNotificationNeedsUpdate(state, assessment = {}) {
  const current = state.meta?.pipelineLiveness;
  if (!assessment.stalled) return current?.active === true;
  return current?.active !== true || current.fingerprint !== pipelineStallFingerprint(assessment);
}

export function reconcilePipelineLivenessNotificationInState(state, assessment = {}, input = {}) {
  state.meta = state.meta || {};
  state.notificationOutbox = state.notificationOutbox || [];
  const current = state.meta.pipelineLiveness || {};
  const now = input.now || new Date(Number(input.nowMs || Date.now())).toISOString();
  if (!assessment.stalled) {
    if (current.active) {
      state.meta.pipelineLiveness = { ...current, active: false, resolvedAt: now };
    }
    return { incident: state.meta.pipelineLiveness || null, notifications: [] };
  }

  const fingerprint = pipelineStallFingerprint(assessment);
  if (current.active && current.fingerprint === fingerprint) {
    return {
      incident: structuredClone(current),
      notifications: state.notificationOutbox
        .filter((item) => item.pipelineStallId === current.id)
        .map((item) => structuredClone(item)),
    };
  }

  const project = findProject(state, assessment.projectId);
  const notificationPolicy = policyFor(project, input);
  const channels = [...new Set(notificationPolicy.channels.map((channel) => String(channel).trim()).filter(Boolean))];
  const incident = {
    id: `pipeline_stall_${randomUUID()}`,
    active: true,
    fingerprint,
    projectId: String(assessment.projectId || ""),
    projectKey: String(assessment.projectKey || project?.key || ""),
    taskId: String(assessment.taskId || ""),
    taskTitle: String(assessment.taskTitle || "Automation work"),
    taskUrl: String(assessment.taskUrl || ""),
    cause: String(assessment.cause || "No executable run can advance eligible work."),
    recoveryAction: String(assessment.recoveryAction || "Open StudioOps and inspect worker admission and task blockers."),
    detectedAt: now,
  };
  const notifications = channels.map((channel) => {
    const item = {
      id: `notification_${randomUUID()}`,
      idempotencyKey: `${incident.id}:${channel}`,
      kind: "pipeline_stall",
      pipelineStallId: incident.id,
      projectId: incident.projectId,
      taskId: incident.taskId,
      channel,
      status: "queued",
      attempts: 0,
      packet: incident,
      policy: notificationPolicy,
      createdAt: now,
      updatedAt: now,
    };
    state.notificationOutbox.push(item);
    return structuredClone(item);
  });
  state.meta.pipelineLiveness = incident;
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "pipeline_stall_detected",
    projectId: incident.projectId,
    taskId: incident.taskId,
    message: `${incident.taskId || "Pipeline"} stalled: ${incident.cause}`,
    createdAt: now,
  });
  return { incident: structuredClone(incident), notifications };
}

export async function reconcilePipelineLivenessNotification(assessment = {}, input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => (
    reconcilePipelineLivenessNotificationInState(state, assessment, input)
  ), { operationName: "notification.pipeline_liveness" });
}

/** Enqueue once per candidate/channel. The manifest digest is the idempotency key. */
export function enqueueOwnerQaNotificationsInState(state, candidate, input = {}) {
  const persistedCandidate = (state.candidates || []).find((item) => item.id === candidate.id);
  if (!persistedCandidate) throw new Error(`Unknown persisted candidate: ${candidate.id}`);
  const bundle = (state.qaBundles || []).find((item) => item.candidateId === persistedCandidate.id);
  const gate = candidateCompletenessGate(persistedCandidate, state, bundle);
  if (!gate.ready) throw new Error(`Candidate is not QA-ready: ${gate.reasons.join(", ")}`);
  const project = findProject(state, persistedCandidate.projectId);
  const packet = persistedCandidate.qaPacket || buildOwnerQaPacket(state, persistedCandidate, { ...input, bundle });
  const notificationPolicy = policyFor(project, input);
  const channels = [...new Set(notificationPolicy.channels.map((channel) => String(channel).trim()).filter(Boolean))];
  state.notificationOutbox = state.notificationOutbox || [];
  const created = [];
  for (const channel of channels) {
    const key = `${persistedCandidate.id}:${persistedCandidate.manifestDigest}:${channel}`;
    let item = state.notificationOutbox.find((entry) => entry.idempotencyKey === key);
    if (!item) {
      const now = input.now || nowIso();
      item = {
        id: `notification_${randomUUID()}`,
        idempotencyKey: key,
        kind: "owner_qa",
        projectId: persistedCandidate.projectId,
        candidateId: persistedCandidate.id,
        manifestDigest: persistedCandidate.manifestDigest,
        channel,
        status: "queued",
        attempts: 0,
        packet,
        policy: notificationPolicy,
        createdAt: now,
        updatedAt: now,
      };
      state.notificationOutbox.push(item);
    }
    created.push(structuredClone(item));
  }
  persistedCandidate.qaPacket = packet;
  return created;
}

export async function enqueueOwnerQaNotification(candidate, stateInput = null, input = {}) {
  return mutateState(async (state) => {
    if (stateInput && stateInput !== state) {
      throw new Error("Notification enqueue must use the authoritative persisted state.");
    }
    return enqueueOwnerQaNotificationsInState(state, candidate, input);
  });
}

export function claimNotificationOutboxInState(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const now = new Date(nowMs).toISOString();
  const limit = Math.max(1, Number(input.limit || 10));
  const selectedIds = new Set((input.ids || []).map(String));
  const claims = (state.notificationOutbox || []).filter((item) => {
    if (selectedIds.size && !selectedIds.has(item.id)) return false;
    const staleAttempt = item.status === "attempted" && Date.parse(item.claimExpiresAt || "") <= nowMs;
    if (!["queued", "failed"].includes(item.status) && !staleAttempt) return false;
    if (Number(item.attempts || 0) >= Number(item.policy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS)) return false;
    const retryAt = Date.parse(item.retryNotBefore || "");
    return !Number.isFinite(retryAt) || retryAt <= nowMs;
  }).slice(0, limit);
  for (const item of claims) {
    item.status = "attempted";
    item.claimToken = randomUUID();
    item.claimedAt = now;
    item.claimExpiresAt = new Date(nowMs + Math.max(10_000, Number(input.claimLeaseMs || CLAIM_LEASE_MS))).toISOString();
    item.attempts = Number(item.attempts || 0) + 1;
    item.updatedAt = now;
  }
  return structuredClone(claims);
}

/** Claim is atomic and stale claims are safely recoverable after the lease. */
export async function claimNotificationOutbox(input = {}) {
  return mutateState(async (state) => claimNotificationOutboxInState(state, input));
}

export async function updateNotificationOutbox(id, patch = {}) {
  return mutateState(async (state) => {
    const item = (state.notificationOutbox || []).find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown notification outbox item: ${id}`);
    const status = patch.status || item.status;
    if (!notificationStatusIsValid(status)) throw new Error(`Invalid notification status: ${status}`);
    if (patch.claimToken && patch.claimToken !== item.claimToken) {
      throw new Error("Notification claim token no longer owns this delivery attempt.");
    }
    Object.assign(item, patch, { status, updatedAt: nowIso() });
    delete item.claimToken;
    delete item.claimExpiresAt;
    if (status === "failed" && Number(item.attempts || 0) < Number(item.policy?.maxAttempts || MAX_NOTIFICATION_ATTEMPTS)) item.retryNotBefore = new Date(Date.now() + NOTIFICATION_RETRY_MS).toISOString();
    if (status === "delivered") {
      item.acknowledgementDueAt = new Date(Date.now() + Number(item.policy?.acknowledgementTimeoutMs || 24 * 60 * 60 * 1000)).toISOString();
    }
    return structuredClone(item);
  });
}

export async function acknowledgeNotification(id, action, input = {}) {
  if (!["pass", "fail", "request_changes", "defer", "open_candidate"].includes(action)) throw new Error(`Unsupported owner action: ${action}`);
  return mutateState(async (state) => {
    const item = (state.notificationOutbox || []).find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown notification outbox item: ${id}`);
    if (input.manifestDigest !== item.manifestDigest) throw new Error("Owner action is bound to a different manifest digest.");
    if (action === "open_candidate") {
      item.openedAt = nowIso();
      item.updatedAt = item.openedAt;
      return structuredClone(item);
    }
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

export function escalateDueNotificationsInState(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const now = new Date(nowMs).toISOString();
  const escalated = [];
  for (const item of state.notificationOutbox || []) {
    if (item.status !== "delivered") continue;
    const dueAt = Date.parse(item.acknowledgementDueAt || "");
    if (!Number.isFinite(dueAt) || dueAt > nowMs) continue;
    item.status = "escalated";
    item.escalationReason = "Owner acknowledgement timeout.";
    item.escalatedAt = now;
    item.updatedAt = now;
    escalated.push(structuredClone(item));
  }
  return escalated;
}

export async function escalateDueNotifications(input = {}) {
  return mutateState(async (state) => escalateDueNotificationsInState(state, input));
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
    .slice(0, 3)
    .map((task) => task.title)
    .join("; ");
  const remainder = Math.max(0, (bundle.tasks || []).length - 3);
  const releaseCandidate = bundle.status === "release_candidate_ready";
  return {
    title: releaseCandidate ? "StudioOps release candidate ready" : "StudioOps QA bundle ready",
    subtitle: `${bundle.projectName || bundle.projectKey || bundle.projectId} · ${bundle.tasks?.length || 0} change${bundle.tasks?.length === 1 ? "" : "s"}`,
    body: `${releaseCandidate ? "Ready for release review" : "Ready to test locally"}: ${taskSummary || "validated product changes"}${remainder ? `; and ${remainder} more` : ""}${releaseCandidate ? ` · ${bundle.promotionPrUrl || bundle.promotionBranch || "Open StudioOps for the release PR"}` : bundle.previewUrl ? ` · ${bundle.previewUrl}` : " · Open StudioOps for the ordered QA checklist"}`,
  };
}

export function notificationForOwnerQaPacket(packet = {}) {
  const sha = String(packet.integration?.sha || "");
  const shortSha = sha ? sha.slice(0, 12) : "unknown";
  const outcomes = (packet.tasks || [])
    .slice(0, 2)
    .map((task) => task.expectedOutcome || task.title)
    .filter(Boolean)
    .join("; ");
  return {
    title: "StudioOps QA candidate ready",
    subtitle: `${packet.projectName || packet.projectKey || packet.projectId || "Project"} · ${packet.tasks?.length || 0} change${packet.tasks?.length === 1 ? "" : "s"}`,
    body: `Ready to test: ${outcomes || "validated product changes"}. Approval applies only to tested SHA ${shortSha}. Open StudioOps for the ordered checklist.`,
  };
}

export function notificationForPipelineStall(item = {}) {
  const stall = item.packet || item;
  return {
    title: "StudioOps pipeline stalled",
    subtitle: `${stall.projectKey || stall.projectId || "StudioOps"} · ${stall.taskId || "automation"}`,
    body: `${stall.taskTitle || "Eligible work is waiting"}. Cause: ${stall.cause || "No executable run can make progress."} Recovery: ${stall.recoveryAction || "Open StudioOps and inspect the automation workers."}${stall.taskUrl ? ` · ${stall.taskUrl}` : ""}`,
  };
}

function notificationForOutboxItem(item) {
  return item.kind === "pipeline_stall"
    ? notificationForPipelineStall(item)
    : notificationForOwnerQaPacket(item.packet);
}

export async function deliverNotificationOutboxItem(item, input = {}) {
  const notification = notificationForOutboxItem(item);
  if (item.channel === "macos") {
    await (input.sendMac || sendMacNotification)(notification);
    return;
  }
  if (item.channel === "email") {
    if (typeof input.sendEmail !== "function") {
      throw new Error("Email notification channel is configured without a delivery adapter.");
    }
    await input.sendEmail(item.packet, item);
    return;
  }
  if (item.channel === "in_app") return;
  throw new Error(`Unsupported notification channel: ${item.channel}`);
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
  const state = input.state || await readState();
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
      notification: notificationForOutboxItem(item),
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
  }, { operationName: "notification.record_attempt" });
}

export async function sendPendingNotifications(input = {}) {
  if (!input.dryRun) await escalateDueNotifications();
  const plan = await planNotifications(input);
  const outboxItems = plan.pending.filter((item) => item.notificationType === "outbox");
  const claimed = input.dryRun
    ? outboxItems
    : await claimNotificationOutbox({ ids: outboxItems.map((item) => item.id), limit: outboxItems.length || 1 });
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
      await deliverNotificationOutboxItem(item, input);
      sent.push(await updateNotificationOutbox(item.id, { claimToken: item.claimToken, status: "delivered", deliveredAt: nowIso(), deliveryError: "" }));
    } catch (error) {
      sent.push(await updateNotificationOutbox(item.id, { claimToken: item.claimToken, status: "failed", deliveryError: error.message }));
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
