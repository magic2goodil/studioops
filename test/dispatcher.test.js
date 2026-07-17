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

function qaBundleReadyAction() {
  return {
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
  };
}

function qaIntegrationBlockedAction() {
  return {
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
  };
}

function qaIntegrationBlockedRun(status) {
  return {
    id: `run_${status}`,
    taskId: "task_2",
    projectId: "project_1",
    dispatchKey: "task_2:0:qa_integration_blocked:builder:qa_integration_blocked",
    actionType: "qa_integration_blocked",
    group: "builder",
    role: "builder",
    status,
  };
}

test("QA-ready bundles are dispatchable owner notifications", () => {
  const state = fixtureState();
  const report = planDispatches(state, [qaBundleReadyAction()]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].action.type, "qa_bundle_ready");
  assert.equal(report.selected[0].group, "owner");
  assert.equal(report.skipped.length, 0);
});

test("blocked QA integrations are dispatchable builder remediation runs", () => {
  const state = fixtureState();
  const report = planDispatches(state, [qaIntegrationBlockedAction()]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].action.type, "qa_integration_blocked");
  assert.equal(report.selected[0].group, "builder");
  assert.equal(report.skipped.length, 0);
});

test("finished failed or cancelled runs do not permanently block redispatch", () => {
  const state = fixtureState();
  state.runs.push(
    qaIntegrationBlockedRun("failed"),
    qaIntegrationBlockedRun("cancelled"),
  );

  const report = planDispatches(state, [qaIntegrationBlockedAction()]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].action.type, "qa_integration_blocked");
  assert.equal(report.skipped.length, 0);
});

test("queued and running runs still block duplicate dispatches", () => {
  for (const status of ["queued", "running"]) {
    const state = fixtureState();
    state.runs.push(qaIntegrationBlockedRun(status));

    const report = planDispatches(state, [qaIntegrationBlockedAction()]);

    assert.equal(report.selected.length, 0, status);
    assert.equal(report.skipped.length, 1, status);
    assert.equal(report.skipped[0].reason, "already_dispatched", status);
  }
});

test("notified owner handoff runs still block duplicate notifications", () => {
  const state = fixtureState();
  state.runs.push({
    id: "run_notified",
    taskId: "task_1",
    projectId: "project_1",
    dispatchKey: "task_1:0:qa_bundle_ready:owner:qa_bundle_ready",
    actionType: "qa_bundle_ready",
    group: "owner",
    role: "owner",
    status: "notified",
  });

  const report = planDispatches(state, [qaBundleReadyAction()]);

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "already_dispatched");
});
