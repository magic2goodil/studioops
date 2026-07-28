import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSupervisorActions, planDispatches } from "../src/dispatcher.js";
import { buildOwnerInbox } from "../src/owner-inbox.js";
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

function finalAttemptReviewFixture(status = "running") {
  const state = fixtureState();
  state.projects[0].reviewPipeline = [
    {
      key: "frontend",
      role: "frontend-reviewer",
      status: "qa_review",
      required: true,
    },
    {
      key: "lead",
      role: "lead-reviewer",
      status: "lead_review",
      required: true,
    },
  ];
  const attemptKey = "task_2:0:continue_review:frontend-reviewer";
  const action = {
    id: "task_2:continue_review",
    type: "continue_review",
    role: "frontend-reviewer",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_2",
    taskTitle: "Blocked integration task",
    taskStatus: "qa_review",
    priority: "high",
    reason: "Frontend review has not recorded an outcome yet.",
  };
  const finalAttempt = {
    id: "run_2",
    taskId: "task_2",
    projectId: "project_1",
    attemptKey,
    actionType: action.type,
    group: "reviewer",
    role: action.role,
    status,
    attempt: 2,
    maxAttempts: 2,
  };
  state.runs.push(
    {
      ...finalAttempt,
      id: "run_1",
      status: "failed",
      attempt: 1,
    },
    finalAttempt,
  );
  return { state, action, finalAttempt, attemptKey };
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

test("a cancelled run that never started does not consume an execution attempt", async () => {
  const state = fixtureState();
  state.runs.push({
    id: "run_1",
    taskId: "task_2",
    projectId: "project_1",
    attemptKey: "task_2:0:qa_integration_blocked:builder",
    status: "cancelled",
    startedAt: "",
  });
  const action = {
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
  };

  const report = await dispatchSupervisorActions([action], { state });
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].attempt, 1);
});

test("builder dispatch stays truthfully queued until the runner claims it", async () => {
  const state = fixtureState();
  state.tasks[0] = {
    ...state.tasks[0],
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  const report = await dispatchSupervisorActions([{
    id: "task_1:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_1",
    taskTitle: "QA-ready task",
    taskStatus: "ready",
    priority: "high",
    reason: "Ready to build.",
    nextStatus: "in_progress",
  }], { state });

  assert.equal(report.runs[0].status, "queued");
  assert.equal(state.tasks[0].status, "queued");
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

test("active final-attempt review runs suppress duplicate dispatch before exhaustion opens a circuit", async () => {
  for (const status of ["queued", "running"]) {
    const { state, action } = finalAttemptReviewFixture(status);

    const report = await dispatchSupervisorActions([action], { state });

    assert.equal(report.runs.length, 0, status);
    assert.equal(report.skipped[0].reason, "already_dispatched", status);
    assert.equal(state.tasks[1].automationCircuit, undefined, status);
    assert.equal(state.tasks[1].status, "qa_review", status);
    assert.equal(
      state.events.some((event) => event.type === "automation_circuit_opened"),
      false,
      status,
    );
  }
});

test("a successful active final attempt leaves the next review stage dispatchable", async () => {
  const { state, action, finalAttempt } = finalAttemptReviewFixture();
  const activeReport = await dispatchSupervisorActions([action], { state });
  assert.equal(activeReport.skipped[0].reason, "already_dispatched");

  finalAttempt.status = "completed";
  state.reviews.push({
    id: "review_1",
    taskId: "task_2",
    projectId: "project_1",
    stageKey: "frontend",
    role: "frontend-reviewer",
    outcome: "approved",
  }, {
    id: "review_2",
    taskId: "task_2",
    projectId: "project_1",
    stageKey: "accessibility",
    role: "accessibility-reviewer",
    outcome: "skipped",
  });
  state.tasks[1].status = "lead_review";
  const nextReport = await dispatchSupervisorActions([{
    id: "task_2:continue_review:lead",
    type: "continue_review",
    role: "lead-reviewer",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_2",
    taskTitle: "Blocked integration task",
    taskStatus: "lead_review",
  }], { state });

  assert.equal(nextReport.runs.length, 1);
  assert.equal(nextReport.runs[0].role, "lead-reviewer");
  assert.equal(nextReport.runs[0].group, "reviewer");
  assert.equal(state.tasks[1].automationCircuit, undefined);
});

test("a failed final attempt opens the bounded circuit after no matching run remains active", async () => {
  const { state, action, finalAttempt, attemptKey } = finalAttemptReviewFixture();
  const activeReport = await dispatchSupervisorActions([action], { state });
  assert.equal(activeReport.skipped[0].reason, "already_dispatched");

  finalAttempt.status = "failed";
  const exhaustedReport = await dispatchSupervisorActions([action], { state });

  assert.equal(exhaustedReport.runs.length, 0);
  assert.equal(exhaustedReport.skipped[0].reason, "attempt_budget_exhausted");
  assert.equal(state.tasks[1].status, "blocked");
  assert.equal(state.tasks[1].automationCircuit.state, "open");
  assert.equal(state.tasks[1].automationCircuit.attemptsConsumed, 2);
  assert.equal(state.tasks[1].automationCircuit.maxAttempts, 2);
  assert.equal(state.tasks[1].automationBlocker.attemptKey, attemptKey);
  assert.match(state.comments.at(-1).body, /2\/2 dispatch-attempt budget is exhausted/);
  assert.ok(state.events.some((event) => (
    event.type === "automation_circuit_opened"
    && event.taskId === "task_2"
  )));
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

test("an actual dispatcher sweep turns exhausted historical attempts into a visible resettable circuit", async () => {
  const state = fixtureState();
  state.tasks[1].acceptanceCriteria = ["QA integration succeeds without conflicts."];
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
  const action = {
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
  };

  const report = await dispatchSupervisorActions([action], { state });

  assert.equal(report.runs.length, 0);
  assert.equal(report.skipped[0].reason, "attempt_budget_exhausted");
  assert.equal(state.tasks[1].status, "blocked");
  assert.equal(state.tasks[1].automationCircuit.state, "open");
  assert.equal(state.tasks[1].automationBlocker.resumeStatus, "qa_review");
  assert.equal(state.tasks[1].automationCircuit.attemptsConsumed, 2);
  assert.ok(state.events.some((event) => event.type === "automation_circuit_opened"));
  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.items[0].taskId, "task_2");
  assert.match(inbox.items[0].nextAction, /circuit-reset/);
});

test("opening an exhausted circuit does not suppress an owner handoff in the same sweep", async () => {
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

  const report = await dispatchSupervisorActions([
    {
      id: "task_2:qa_integration_blocked",
      type: "qa_integration_blocked",
      role: "builder",
      projectId: "project_1",
      projectKey: "demo",
      projectName: "Demo",
      taskId: "task_2",
      taskTitle: "Blocked integration task",
    },
    {
      id: "task_2:notify_owner",
      type: "notify_owner",
      role: "owner",
      projectId: "project_1",
      projectKey: "demo",
      projectName: "Demo",
      taskId: "task_2",
      taskTitle: "Blocked integration task",
    },
  ], { state });

  assert.equal(state.tasks[1].automationCircuit.state, "open");
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].actionType, "notify_owner");
});

test("credit admission blocks a critical run once and opens an owner-visible circuit", async () => {
  const state = fixtureState();
  state.tasks.push({
    id: "task_3",
    projectId: "project_1",
    title: "Deploy the production database migration",
    status: "ready",
    priority: "critical",
    acceptanceCriteria: ["Production migration is safe and reversible."],
  });
  const action = {
    id: "task_3:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_3",
    taskTitle: "Deploy the production database migration",
    taskStatus: "ready",
  };
  const options = {
    state,
    executionPolicy: {
      modelTiers: {
        economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
        critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      tierRouting: {
        defaultTier: "economy",
        complexTier: "critical",
      },
    },
    creditPolicy: {
      enabled: true,
      failClosedTiers: ["critical"],
      tierBudgets: {
        critical: { estimatedCredits: 30, minRemainingPercent: 20 },
      },
    },
    creditSnapshot: {
      status: "available",
      observedAt: new Date().toISOString(),
      remainingPercent: 10,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(report.runs.length, 0);
  assert.equal(report.skipped[0].reason, "credit_gate:insufficient_quota_headroom");
  assert.equal(state.tasks[2].status, "blocked");
  assert.equal(state.tasks[2].automationCircuit.state, "open");
  assert.equal(state.tasks[2].automationCircuit.reasonCode, "credit_budget_insufficient");
  assert.equal(state.tasks[2].automationBlocker.modelTier, "critical");
  assert.ok(state.events.some((event) => event.type === "credit_admission_blocked"));
  assert.match(state.comments.at(-1).body, /did not downgrade/i);

  const second = await dispatchSupervisorActions([action], options);
  assert.equal(second.runs.length, 0);
  assert.equal(second.skipped[0].reason, "task_status_changed:ready->blocked");
});

test("credit admission allows an affordable ordinary run at its configured quality tier", async () => {
  const state = fixtureState();
  state.tasks.push({
    id: "task_4",
    projectId: "project_1",
    title: "Polish event card spacing",
    status: "ready",
    priority: "medium",
    acceptanceCriteria: ["Spacing matches the approved design."],
  });
  const report = await dispatchSupervisorActions([{
    id: "task_4:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_4",
    taskTitle: "Polish event card spacing",
    taskStatus: "ready",
  }], {
    state,
    executionPolicy: {
      modelTiers: {
        economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      },
      tierRouting: {
        defaultTier: "economy",
      },
    },
    creditPolicy: {
      enabled: true,
      tierBudgets: {
        economy: { estimatedCredits: 8, minRemainingPercent: 5 },
      },
    },
    creditSnapshot: {
      status: "available",
      observedAt: new Date().toISOString(),
      remainingPercent: 80,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });

  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].modelTier, "economy");
  assert.equal(report.runs[0].model, "gpt-5.6-luna");
  assert.equal(report.runs[0].creditAdmission.code, "included_quota_available");
  assert.equal(report.runs[0].creditAdmission.remainingPercent, 80);
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

test("open project circuits stop worker redispatch without hiding owner handoffs", () => {
  const state = fixtureState();
  state.projects[0].automationCircuit = { state: "open" };
  const worker = planDispatches(state, [{
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

  assert.equal(worker.skipped[0].reason, "project_circuit_open");
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
