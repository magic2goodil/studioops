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
});

test("QA tasks with a configured local preview remain visible without synthetic integration metadata", () => {
  const state = fixtureState();
  state.tasks[0].status = "qa_review";
  delete state.tasks[0].integrationStatus;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.items[0].kind, "qa_review");
  assert.equal(inbox.items[0].previewUrl, "http://127.0.0.1:5080/");
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
