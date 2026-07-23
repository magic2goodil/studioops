import assert from "node:assert/strict";
import test from "node:test";
import { buildOwnerInbox } from "../src/owner-inbox.js";

function fixtureState() {
  return {
    meta: {},
    projects: [{
      id: "project_1",
      key: "dollos",
      name: "DollOS",
      localQaPreview: {
        previewUrl: "http://127.0.0.1:5080/",
      },
      reviewPolicy: {
        integrationBranch: "qa/dollos",
      },
    }],
    tasks: [{
      id: "task_7",
      projectId: "project_1",
      title: "Fix ritual duration",
      status: "user_review",
      branchName: "codex/dollos-task_7",
      prUrl: "https://github.com/example/dollos/pull/36",
      acceptanceCriteria: [
        "The updated ritual duration is visible in the local preview.",
      ],
      updatedAt: "2026-07-23T15:02:00.000Z",
    }],
    runs: [{
      id: "run_32",
      projectId: "project_1",
      taskId: "task_7",
      actionType: "notify_owner",
      status: "notified",
      notificationStatus: "sent",
      notificationChannel: "macos",
      externalNotifiedAt: "2026-07-23T15:02:36.000Z",
    }],
    qaBundles: [],
  };
}

test("owner handoffs remain in the inbox after a desktop notification was sent", () => {
  const inbox = buildOwnerInbox(fixtureState());
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].taskId, "task_7");
  assert.equal(inbox.items[0].notification.status, "sent");
  assert.equal(inbox.items[0].previewUrl, "http://127.0.0.1:5080/");
  assert.equal(inbox.items[0].prUrl, "https://github.com/example/dollos/pull/36");
  assert.equal(inbox.items[0].checklist[0].taskId, "task_7");
  assert.match(inbox.items[0].checklist[0].text, /ritual duration/);
});

test("non-Trust-Leads QA tasks with a configured local preview remain visible", () => {
  const state = fixtureState();
  state.tasks[0].status = "qa_review";
  delete state.tasks[0].integrationStatus;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].kind, "qa_review");
  assert.equal(inbox.items[0].previewUrl, "http://127.0.0.1:5080/");
});

test("Trust Leads QA handoffs remain hidden until integration and preview validation are ready", () => {
  const state = fixtureState();
  state.projects[0].reviewPolicy = {
    trustLeadApprovals: true,
    integrationBranch: "qa/dollos",
  };
  state.tasks[0].status = "qa_review";
  delete state.tasks[0].integrationStatus;

  assert.equal(buildOwnerInbox(state).count, 0);

  state.tasks[0].integrationStatus = "ready";
  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].kind, "qa_review");
});

test("desktop delivery failures remain visible on the persistent handoff", () => {
  const state = fixtureState();
  state.runs[0] = {
    ...state.runs[0],
    notificationStatus: "failed",
    notificationError: "osascript unavailable",
    notificationFailedAt: "2026-07-23T15:03:00.000Z",
    externalNotifiedAt: "",
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.items[0].notification.status, "failed");
  assert.equal(inbox.items[0].notification.error, "osascript unavailable");
  assert.equal(inbox.items[0].notification.attemptedAt, "2026-07-23T15:03:00.000Z");
});

test("open circuits and operator pauses remain visibly actionable", () => {
  const state = fixtureState();
  state.meta.operatorPause = {
    active: true,
    reason: "Incident recovery",
  };
  state.tasks[0] = {
    ...state.tasks[0],
    status: "blocked",
    automationBlocker: {
      type: "circuit",
      reason: "sdk_error",
      attempts: 2,
    },
    automationCircuit: {
      state: "open",
      normalizedReason: "Automatic attempts were exhausted.",
      attemptsConsumed: 2,
      maxAttempts: 2,
      resumeAction: "studioops circuit-reset --task task_7 --reason verified",
    },
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.operatorPause.active, true);
  assert.equal(inbox.items[0].kind, "automation_blocked");
  assert.equal(inbox.items[0].blocker.attempts, 2);
  assert.match(inbox.items[0].nextAction, /circuit-reset/);
});

test("project circuits remain visibly owner-gated and resettable", () => {
  const state = fixtureState();
  state.tasks[0].status = "ready";
  state.projects[0].automationCircuit = {
    state: "open",
    normalizedReason: "Repository access is unavailable.",
    openedAt: "2026-07-23T15:04:00.000Z",
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].kind, "project_automation_blocked");
  assert.equal(inbox.items[0].blocker.reason, "Repository access is unavailable.");
  assert.match(inbox.items[0].nextAction, /circuit-reset --project dollos/);
  assert.equal(inbox.items[0].notification.status, "not_applicable");
});

test("ready QA bundles expose task acceptance criteria as a durable checklist", () => {
  const state = fixtureState();
  state.tasks[0].status = "qa_review";
  state.tasks[0].integrationStatus = "ready";
  state.tasks[0].qaBundleId = "qa_bundle_1";
  state.qaBundles = [{
    id: "qa_bundle_1",
    projectId: "project_1",
    status: "ready",
    previewUrl: "http://127.0.0.1:5080/",
    tasks: [{ id: "task_7" }],
    updatedAt: "2026-07-23T15:05:00.000Z",
  }];

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].kind, "qa_bundle");
  assert.equal(inbox.items[0].checklist[0].taskId, "task_7");
  assert.match(inbox.items[0].checklist[0].text, /ritual duration/);
});
