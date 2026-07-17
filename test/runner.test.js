import assert from "node:assert/strict";
import test from "node:test";
import { planRunnableRuns } from "../src/runner.js";

function fixtureState(taskPatch = {}, runPatch = {}) {
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
        title: "QA integration task",
        status: "qa_review",
        integrationStatus: "ready",
        assignedAgentRole: "owner",
        ...taskPatch,
      },
    ],
    runs: [
      {
        id: "run_1",
        taskId: "task_1",
        projectId: "project_1",
        actionType: "qa_integration_blocked",
        group: "builder",
        role: "builder",
        status: "queued",
        integrationStatus: "conflict",
        ...runPatch,
      },
    ],
    comments: [],
    events: [],
  };
}

test("stale QA remediation runs are skipped before runner launch", () => {
  const report = planRunnableRuns(fixtureState(), { limit: 1 });

  assert.equal(report.runnable.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "stale_run:qa_integration_status_changed:ready");
});

test("current QA remediation runs remain runnable", () => {
  const report = planRunnableRuns(fixtureState({
    integrationStatus: "conflict",
    assignedAgentRole: "builder",
  }), { limit: 1 });

  assert.equal(report.runnable.length, 1);
  assert.equal(report.runnable[0].id, "run_1");
  assert.equal(report.skipped.length, 0);
});

test("active builder runs created by dispatch remain runnable after task status moves to in progress", () => {
  const report = planRunnableRuns(fixtureState(
    {
      status: "in_progress",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
    },
  ), { limit: 1 });

  assert.equal(report.runnable.length, 1);
  assert.equal(report.runnable[0].id, "run_1");
  assert.equal(report.skipped.length, 0);
});
