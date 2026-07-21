import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorReport } from "../src/supervisor.js";
import { automationTick } from "../src/store.js";

function fixtureState(taskPatch = {}) {
  return {
    projects: [
      {
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath: "/tmp/demo",
      },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Review the design foundation",
        status: "blocked",
        dependsOnTaskIds: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        ...taskPatch,
      },
    ],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
  };
}

test("automation configuration blockers are not mistaken for completed dependencies", async () => {
  const state = fixtureState({
    assignedAgentRole: "owner",
    automationBlocker: {
      type: "configuration",
      reason: "invalid_github_app_credentials",
      runId: "run_1",
      resumeStatus: "lead_review",
      blockedAt: "2026-07-20T10:00:00.000Z",
    },
  });

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, []);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].assignedAgentRole, "owner");
  assert.equal(state.tasks[0].automationBlocker.resumeStatus, "lead_review");

  const report = createSupervisorReport(state);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "repair_automation_config");
  assert.equal(report.actions[0].role, "owner");
  assert.equal(report.actions[0].nextStatus, "lead_review");
  assert.match(report.actions[0].reason, /invalid_github_app_credentials/);
});

test("ordinary dependency blockers still return to the builder queue", async () => {
  const state = fixtureState();

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, ["task_1: unblocked"]);
  assert.equal(state.tasks[0].status, "queued");
});
