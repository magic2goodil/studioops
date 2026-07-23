import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/dispatcher.js";
import { createSupervisorReport } from "../src/supervisor.js";

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

test("QA-ready tasks do not create duplicate per-task owner notification runs", () => {
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

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped[0].reason, "not_dispatchable");
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

test("finished failed or cancelled runs do not permanently block redispatch", () => {
  const state = fixtureState();
  state.runs.push(
    {
      id: "run_1",
      taskId: "task_2",
      projectId: "project_1",
      dispatchKey: "task_2:0:qa_integration_blocked:builder:qa_integration_blocked",
      actionType: "qa_integration_blocked",
      group: "builder",
      role: "builder",
      status: "failed",
    },
    {
      id: "run_2",
      taskId: "task_2",
      projectId: "project_1",
      dispatchKey: "task_2:0:qa_integration_blocked:builder:qa_integration_blocked",
      actionType: "qa_integration_blocked",
      group: "builder",
      role: "builder",
      status: "cancelled",
    },
  );

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
  assert.equal(report.skipped.length, 0);
});

test("queued runs still block duplicate dispatches", () => {
  const state = fixtureState();
  state.runs.push({
    id: "run_1",
    taskId: "task_2",
    projectId: "project_1",
    dispatchKey: "task_2:0:qa_integration_blocked:builder:qa_integration_blocked",
    actionType: "qa_integration_blocked",
    group: "builder",
    role: "builder",
    status: "queued",
  });

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

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "already_dispatched");
});

test("exhausted attempt budgets stop redispatch", () => {
  const state = fixtureState();
  state.runs.push(
    {
      id: "run_1",
      taskId: "task_2",
      projectId: "project_1",
      attemptKey: "task_2:0:qa_integration_blocked:builder",
      status: "failed",
    },
    {
      id: "run_2",
      taskId: "task_2",
      projectId: "project_1",
      attemptKey: "task_2:0:qa_integration_blocked:builder",
      status: "failed",
    },
  );

  const report = planDispatches(state, [{
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
  }]);

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped[0].reason, "attempt_budget_exhausted");
});

test("open task circuits stop redispatch without blocking owner notifications", () => {
  const state = fixtureState();
  state.tasks[1].automationCircuit = { state: "open" };
  const blocked = planDispatches(state, [{
    id: "task_2:qa_integration_blocked",
    type: "qa_integration_blocked",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_2",
    taskTitle: "Blocked integration task",
  }]);
  const owner = planDispatches(state, [{
    id: "task_2:notify_owner",
    type: "notify_owner",
    role: "owner",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_2",
    taskTitle: "Blocked integration task",
  }]);

  assert.equal(blocked.selected.length, 0);
  assert.equal(blocked.skipped[0].reason, "task_circuit_open");
  assert.equal(owner.selected.length, 1);
});

test("operator pause suppresses builders but still permits owner handoffs", () => {
  const state = fixtureState();
  state.meta = { operatorPause: { active: true, reason: "Recovery" } };
  const builder = planDispatches(state, [{
    id: "task_2:qa_integration_blocked",
    type: "qa_integration_blocked",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_2",
  }]);
  const owner = planDispatches(state, [{
    id: "task_2:notify_owner",
    type: "notify_owner",
    role: "owner",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_2",
  }]);

  assert.equal(builder.skipped[0].reason, "operator_pause");
  assert.equal(owner.selected.length, 1);
});

test("operator pause also suppresses dependency-unblock builder dispatches", () => {
  const state = fixtureState();
  state.meta = { operatorPause: { active: true, reason: "Recovery" } };

  const report = planDispatches(state, [{
    id: "task_2:unblock_task",
    type: "unblock_task",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_2",
  }]);

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped[0].reason, "operator_pause");
});

test("preview service failures route to infrastructure repair instead of rebuilding feature code", () => {
  const state = fixtureState();
  state.projects[0].reviewPolicy = { trustLeadApprovals: true, integrationBranch: "qa/demo" };
  state.tasks[0].integrationStatus = "preview_blocked";
  const report = createSupervisorReport(state);
  const action = report.actions.find((item) => item.taskId === "task_1");

  assert.equal(action.type, "repair_qa_preview");
  assert.equal(action.role, "owner");
  assert.match(action.reason, /preview/i);
});
