import assert from "node:assert/strict";
import test from "node:test";
import { automationTick } from "../src/store.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

function stateWith(task, runs = []) {
  return {
    projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo" }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Build a durable feature",
      type: "feature",
      status: "in_progress",
      dependsOnTaskIds: [],
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
      ...task,
    }],
    comments: [],
    events: [],
    reviews: [],
    runs,
  };
}

test("automation reconciles orphaned executable tasks back to the queue", async () => {
  const state = stateWith({ assignedAgentRole: "builder", assignedThreadId: "thread_1" });
  const result = await automationTick({ state, nowMs: NOW, orphanGraceMs: 60_000 });

  assert.match(result.actions.join("\n"), /recovered orphaned in-progress task/);
  assert.equal(state.tasks[0].status, "queued");
  assert.equal(state.tasks[0].assignedThreadId, "");
  assert.ok(state.events.some((event) => event.type === "orphaned_task_recovered"));
});

test("automation leaves an in-progress task alone when a durable run exists", async () => {
  const state = stateWith({}, [{
    id: "run_1",
    taskId: "task_1",
    projectId: "project_1",
    status: "running",
    createdAt: "2026-07-21T11:59:00.000Z",
  }]);
  await automationTick({ state, nowMs: NOW, orphanGraceMs: 60_000 });
  assert.equal(state.tasks[0].status, "in_progress");
});

test("automation does not dispatch tracking epics as builder work", async () => {
  const state = stateWith({ type: "epic" });
  await automationTick({ state, nowMs: NOW, orphanGraceMs: 60_000 });
  assert.equal(state.tasks[0].status, "in_progress");
});

test("transient blockers recover automatically after their retry window", async () => {
  const state = stateWith({
    status: "blocked",
    automationBlocker: {
      type: "transient",
      reason: "sdk_error",
      resumeStatus: "queued",
      blockedAt: "2026-07-21T10:00:00.000Z",
      retryAt: "2026-07-21T10:15:00.000Z",
    },
  });
  const result = await automationTick({ state, nowMs: NOW });
  assert.match(result.actions.join("\n"), /recovered transient automation failure/);
  assert.equal(state.tasks[0].status, "queued");
  assert.equal(state.tasks[0].automationBlocker, undefined);
});

test("transient recovery opens a circuit instead of looping after the recovery budget", async () => {
  const state = stateWith({
    status: "blocked",
    lastAutomationRecoveryCount: 1,
    automationBlocker: {
      type: "transient",
      reason: "sdk_error",
      runId: "run_8",
      attempts: 2,
      resumeStatus: "queued",
      blockedAt: "2026-07-21T10:00:00.000Z",
      retryAt: "2026-07-21T10:15:00.000Z",
      recoveryCount: 1,
    },
  });
  const result = await automationTick({ state, nowMs: NOW });
  assert.match(result.actions.join("\n"), /opened automation circuit/);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationCircuit.state, "open");
  assert.equal(state.tasks[0].automationBlocker.type, "circuit");
});

test("operator pause prevents automation state advancement", async () => {
  const state = stateWith({ status: "ready" });
  state.meta = {
    operatorPause: {
      active: true,
      reason: "Database recovery verification",
    },
  };
  const result = await automationTick({ state, nowMs: NOW });
  assert.equal(result.paused, true);
  assert.equal(result.actions.length, 0);
  assert.equal(state.tasks[0].status, "ready");
});

test("configuration blockers still require explicit owner repair", async () => {
  const state = stateWith({
    status: "blocked",
    automationBlocker: {
      type: "configuration",
      reason: "invalid_github_app_credentials",
      resumeStatus: "queued",
      blockedAt: "2026-07-21T10:00:00.000Z",
    },
  });
  await automationTick({ state, nowMs: NOW });
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationBlocker.type, "configuration");
});
