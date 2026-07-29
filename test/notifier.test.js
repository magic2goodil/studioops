import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationFor,
  notificationForBundle,
  notificationRetryReady,
  renderEmailNotification,
  sendPendingNotifications,
  studioOpsBaseUrl,
} from "../src/notifier.js";

const state = {
  projects: [{ id: "project_1", key: "demo" }],
  tasks: [{ id: "task_1", projectId: "project_1", title: "Canonical identity" }],
};

test("owner, QA, and failure runs produce exact StudioOps envelopes", () => {
  const owner = notificationFor(state, {
    id: "run_1",
    projectId: "project_1",
    taskId: "task_1",
    status: "notified",
    actionType: "notify_owner",
    prUrl: "https://github.com/example/product/pull/7",
  });
  assert.deepEqual(owner, {
    subject: "StudioOps needs your review",
    title: "StudioOps needs your review",
    subtitle: "demo · task_1",
    body: "Canonical identity · https://github.com/example/product/pull/7",
    actionUrl: "http://127.0.0.1:4317/tasks/task_1",
  });

  const qa = notificationFor(state, {
    id: "run_2",
    projectId: "project_1",
    taskId: "task_1",
    status: "notified",
    actionType: "notify_qa_review",
    integrationBranch: "qa/demo",
    prUrl: "https://github.com/example/product/pull/8",
  });
  assert.deepEqual(qa, {
    subject: "StudioOps QA review ready",
    title: "StudioOps QA review ready",
    subtitle: "demo · task_1",
    body: "Canonical identity · qa/demo · https://github.com/example/product/pull/8",
    actionUrl: "http://127.0.0.1:4317/tasks/task_1",
  });

  const failure = notificationFor(state, {
    id: "run_3",
    projectId: "project_1",
    taskId: "task_1",
    status: "failed",
    notes: "builder exited 1",
    outputPath: "/tmp/studioops-run.log",
  });
  assert.deepEqual(failure, {
    subject: "StudioOps run failed",
    title: "StudioOps run failed",
    subtitle: "demo · run_3",
    body: "Canonical identity. builder exited 1 Log: /tmp/studioops-run.log",
    actionUrl: "http://127.0.0.1:4317/tasks/task_1",
  });
});

test("QA bundles produce one exact checklist envelope with the preview URL", () => {
  const notification = notificationForBundle({
    projectKey: "event-horizons-web",
    status: "ready",
    previewUrl: "http://127.0.0.1:4174/",
    tasks: [
      { id: "task_126", title: "Fix map categories" },
      { id: "task_127", title: "Clarify Discover and Map" },
    ],
  });

  assert.deepEqual(notification, {
    subject: "StudioOps QA bundle ready",
    title: "StudioOps QA bundle ready",
    subtitle: "event-horizons-web · 2 task(s)",
    body: "task_126 Fix map categories; task_127 Clarify Discover and Map · http://127.0.0.1:4174/",
    actionUrl: "http://127.0.0.1:4317/tasks/task_126",
  });
});

test("release candidates produce an exact StudioOps envelope", () => {
  const notification = notificationForBundle({
    projectKey: "event-horizons-web",
    status: "release_candidate_ready",
    promotionPrUrl: "https://github.com/example/event-horizon/pull/42",
    tasks: [{ id: "task_126", title: "Fix map categories" }],
  });

  assert.deepEqual(notification, {
    subject: "StudioOps release candidate ready",
    title: "StudioOps release candidate ready",
    subtitle: "event-horizons-web · 1 task(s)",
    body: "task_126 Fix map categories · https://github.com/example/event-horizon/pull/42",
    actionUrl: "http://127.0.0.1:4317/tasks/task_126",
  });
});

test("email rendering is exact and transport-free", () => {
  const envelope = notificationForBundle({
    projectKey: "demo",
    status: "ready",
    tasks: [{ id: "task_1", title: "Canonical identity" }],
  });
  assert.deepEqual(renderEmailNotification(envelope), {
    subject: "StudioOps QA bundle ready",
    body: [
      "StudioOps QA bundle ready",
      "demo · 1 task(s)",
      "task_1 Canonical identity",
      "Action: http://127.0.0.1:4317/tasks/task_1",
    ].join("\n"),
  });
});

test("dry-run delivery returns the shared envelope without invoking a transport", async () => {
  const envelope = notificationFor(state, {
    id: "run_1",
    projectId: "project_1",
    taskId: "task_1",
    status: "notified",
    actionType: "notify_owner",
  });
  let transportCalls = 0;
  const report = await sendPendingNotifications({
    dryRun: true,
    plan: {
      generatedAt: "2026-07-28T12:00:00.000Z",
      pending: [{ id: "run_1", notification: envelope }],
      skipped: [],
    },
    sendNotification: async () => {
      transportCalls += 1;
    },
  });

  assert.equal(transportCalls, 0);
  assert.equal(report.sent.length, 0);
  assert.equal(report.pending[0].notification, envelope);
  assert.equal(report.dryRun, true);
});

test("StudioOps variables win, enumerated legacy base URL fallback remains bounded, and retries stop", () => {
  assert.equal(studioOpsBaseUrl({
    STUDIOOPS_BASE_URL: "http://127.0.0.1:9000/",
    MISSION_CONTROL_BASE_URL: "http://127.0.0.1:8000/",
  }), "http://127.0.0.1:9000");
  assert.equal(studioOpsBaseUrl({
    MISSION_CONTROL_BASE_URL: "http://127.0.0.1:8000/",
  }), "http://127.0.0.1:8000");
  assert.equal(studioOpsBaseUrl({}), "http://127.0.0.1:4317");
  assert.equal(notificationRetryReady({ notificationStatus: "failed", notificationAttempts: 3 }), false);
  assert.equal(notificationRetryReady({ notificationStatus: "failed", notificationAttempts: 2 }), true);
});
