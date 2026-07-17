import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/dispatcher.js";

function fixtureState() {
  return {
    projects: [
      {
        id: "project_1",
        key: "demo",
        name: "Demo",
      },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "QA-ready task",
        status: "qa_review",
        priority: "high",
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Blocked integration task",
        status: "qa_review",
        priority: "high",
      },
    ],
    runs: [],
    reviews: [],
    comments: [],
    events: [],
  };
}

test("QA-ready bundles are dispatchable owner notifications", () => {
  const state = fixtureState();
  const report = planDispatches(state, [
    {
      id: "task_1:qa_bundle_ready",
      type: "qa_bundle_ready",
      role: "owner",
      projectId: "project_1",
      projectKey: "demo",
      projectName: "Demo",
      taskId: "task_1",
      taskTitle: "QA-ready task",
      taskStatus: "qa_review",
      priority: "high",
      reason: "QA integration branch is validated and ready for local owner testing.",
      integrationBranch: "qa/demo",
      integrationBranchUrl: "https://github.com/example/demo/tree/qa/demo",
    },
  ]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].action.type, "qa_bundle_ready");
  assert.equal(report.selected[0].group, "owner");
  assert.equal(report.skipped.length, 0);
});

test("blocked QA integrations are dispatchable builder remediation runs", () => {
  const state = fixtureState();
  const report = planDispatches(state, [
    {
      id: "task_2:qa_integration_blocked",
      type: "qa_integration_blocked",
      role: "builder",
      projectId: "project_1",
      projectKey: "demo",
      projectName: "Demo",
      taskId: "task_2",
      taskTitle: "Blocked integration task",
      taskStatus: "qa_review",
      priority: "high",
      reason: "QA integration is blocked with status conflict.",
      integrationStatus: "conflict",
      integrationBranch: "qa/demo",
      integrationCommand: "npm run qa-integrate -- --project demo",
    },
  ]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].action.type, "qa_integration_blocked");
  assert.equal(report.selected[0].group, "builder");
  assert.equal(report.skipped.length, 0);
});
