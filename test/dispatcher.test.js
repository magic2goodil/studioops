import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  dispatchSupervisorActions,
  formatDispatchReport,
  planDispatches,
} from "../src/dispatcher.js";
import { buildOwnerInbox } from "../src/owner-inbox.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { fileScopesMayOverlap } from "../src/work-lanes.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);

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

test("project run budget limits concurrent worker dispatches", async () => {
  const state = fixtureState();
  state.projects[0].wipPolicy = { maxActiveRuns: 1 };
  state.tasks[0] = {
    ...state.tasks[0],
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  state.tasks[1] = {
    ...state.tasks[1],
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  const actions = ["task_1", "task_2"].map((taskId) => ({
    id: `${taskId}:start_builder`,
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId,
    taskTitle: taskId,
    taskStatus: "ready",
    nextStatus: "in_progress",
  }));

  const report = await dispatchSupervisorActions(actions, { state });

  assert.equal(report.runs.length, 1);
  assert.equal(report.skipped.filter((item) => item.reason === "project_active_run_limit").length, 1);
  assert.equal(state.runs.filter((run) => run.group !== "owner").length, 1);
});

test("project run budget limits recent worker runs while allowing the window to expire", () => {
  const state = fixtureState();
  state.projects[0].wipPolicy = { maxRunsPerWindow: 2, runWindowMinutes: 60 };
  state.runs.push(
    { id: "run_old", taskId: "task_1", projectId: "project_1", group: "builder", status: "completed", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "run_recent", taskId: "task_1", projectId: "project_1", group: "builder", status: "completed", createdAt: "2026-01-01T00:30:00.000Z" },
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
  };

  const blocked = planDispatches(state, [action], {
    nowMs: Date.parse("2026-01-01T00:45:00.000Z"),
  });
  assert.equal(blocked.selected.length, 0);
  assert.equal(blocked.skipped[0].reason, "project_run_window_limit");

  const afterWindow = planDispatches(state, [action], {
    nowMs: Date.parse("2026-01-01T02:00:00.000Z"),
  });
  assert.equal(afterWindow.selected.length, 1);
});

test("project run budgets do not block owner handoffs", () => {
  const state = fixtureState();
  state.projects[0].wipPolicy = { maxActiveRuns: 1, maxRunsPerWindow: 1, runWindowMinutes: 60 };
  state.runs.push({
    id: "run_worker",
    taskId: "task_2",
    projectId: "project_1",
    group: "builder",
    status: "running",
    createdAt: "2026-01-01T00:30:00.000Z",
  });

  const plan = planDispatches(state, [{
    id: "task_1:notify_owner",
    type: "notify_owner",
    role: "owner",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_1",
    taskTitle: "QA-ready task",
    taskStatus: "qa_review",
    taskUrl: "http://127.0.0.1:4317/tasks/task_1",
    reason: "QA integration branch is validated and ready for local owner testing.",
    integrationBranch: "qa/demo",
    integrationBranchUrl: "https://github.com/example/demo/tree/qa/demo",
  }], { nowMs: Date.parse("2026-01-01T00:45:00.000Z") });

  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].group, "owner");
  assert.equal(plan.skipped.length, 0);
});

test("global run admission limits workers across projects without hiding owner handoffs", () => {
  const state = fixtureState();
  state.projects.push({ id: "project_2", key: "other", name: "Other" });
  state.tasks[1] = {
    ...state.tasks[1],
    projectId: "project_2",
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  state.runs.push({
    id: "run_active_other",
    taskId: "task_1",
    projectId: "project_1",
    group: "builder",
    status: "running",
    createdAt: "2026-01-01T00:30:00.000Z",
  });
  const worker = {
    id: "task_2:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_2",
    projectKey: "other",
    taskId: "task_2",
    taskStatus: "ready",
    nextStatus: "in_progress",
  };
  const owner = {
    id: "task_1:notify_owner",
    type: "notify_owner",
    role: "owner",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_1",
    taskStatus: state.tasks[0].status,
  };
  const report = planDispatches(state, [worker, owner], {
    nowMs: Date.parse("2026-01-01T00:45:00.000Z"),
    globalRunAdmission: { maxActiveMeteredRuns: 1, maxMeteredRunsPerWindow: 12, runWindowMinutes: 60 },
  });
  assert.equal(report.skipped[0].reason, "global_active_run_limit");
  assert.equal(report.selected[0].group, "owner");
});

test("global rolling window and exact recent candidate-stage suppress redundant work", () => {
  const state = fixtureState();
  state.tasks[0] = {
    ...state.tasks[0],
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  const action = {
    id: "task_1:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_1",
    taskStatus: "ready",
    nextStatus: "in_progress",
  };
  state.runs.push({
    id: "run_recent",
    taskId: "task_other",
    projectId: "project_other",
    group: "builder",
    status: "completed",
    createdAt: "2026-01-01T00:30:00.000Z",
  });
  const windowBlocked = planDispatches(state, [action], {
    nowMs: Date.parse("2026-01-01T00:45:00.000Z"),
    globalRunAdmission: { maxActiveMeteredRuns: 2, maxMeteredRunsPerWindow: 1, runWindowMinutes: 60 },
  });
  assert.equal(windowBlocked.skipped[0].reason, "global_run_window_limit");

  state.runs = [{
    id: "run_same_stage",
    taskId: "task_1",
    projectId: "project_1",
    dispatchKey: "task_1:0:0:no-subject:start_builder:builder:in_progress",
    group: "builder",
    role: "builder",
    status: "completed",
    completedAt: "2026-01-01T00:40:00.000Z",
  }];
  const duplicate = planDispatches(state, [action], {
    nowMs: Date.parse("2026-01-01T00:45:00.000Z"),
    globalRunAdmission: { maxActiveMeteredRuns: 2, maxMeteredRunsPerWindow: 12, runWindowMinutes: 60 },
  });
  assert.equal(duplicate.skipped[0].reason, "duplicate_candidate_stage");
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
  assert.deepEqual(second.recoveredCreditCircuitTaskIds, []);
});

test("fresh admissible telemetry automatically restores an unchanged credit-only circuit once", async () => {
  const state = fixtureState();
  state.tasks.push({
    id: "task_credit_recovery",
    projectId: "project_1",
    title: "Harden OAuth authorization",
    status: "ready",
    priority: "critical",
    acceptanceCriteria: ["Authorization remains tenant scoped."],
  });
  const action = {
    id: "task_credit_recovery:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_credit_recovery",
    taskTitle: "Harden OAuth authorization",
    taskStatus: "ready",
  };
  const executionPolicy = {
    modelTiers: {
      critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
    tierRouting: { defaultTier: "critical", complexTier: "critical" },
  };
  const blockedPolicy = {
    enabled: true,
    tierBudgets: { critical: { estimatedCredits: 30, minRemainingPercent: 20 } },
  };
  await dispatchSupervisorActions([action], {
    state,
    executionPolicy,
    creditPolicy: blockedPolicy,
    creditSnapshot: {
      status: "available",
      source: "codex-app-server",
      observedAt: new Date().toISOString(),
      remainingPercent: 7,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });
  assert.equal(state.tasks.at(-1).status, "blocked");

  const recovered = await dispatchSupervisorActions([action], {
    state,
    executionPolicy,
    creditPolicy: {
      enabled: true,
      tierBudgets: { critical: { estimatedCredits: 30, minRemainingPercent: 5 } },
    },
    creditSnapshot: {
      status: "available",
      source: "codex-app-server",
      observedAt: new Date().toISOString(),
      remainingPercent: 7,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });

  assert.deepEqual(recovered.recoveredCreditCircuitTaskIds, ["task_credit_recovery"]);
  assert.equal(recovered.runs.length, 1);
  assert.equal(state.tasks.at(-1).automationCircuit.state, "closed");
  assert.equal(state.tasks.at(-1).automationCircuit.closedBy, "StudioOps Budget Controller");
  assert.equal(state.tasks.at(-1).automationCircuit.recoveryEvidence.remainingPercent, 7);
  assert.ok(state.events.some((event) => event.type === "credit_admission_recovered"));

  const duplicate = await dispatchSupervisorActions([action], {
    state,
    executionPolicy,
    creditPolicy: {
      enabled: true,
      tierBudgets: { critical: { estimatedCredits: 30, minRemainingPercent: 5 } },
    },
    creditSnapshot: {
      status: "available",
      source: "codex-app-server",
      observedAt: new Date().toISOString(),
      remainingPercent: 7,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });
  assert.equal(duplicate.runs.length, 0);
  assert.deepEqual(duplicate.recoveredCreditCircuitTaskIds, []);
});

test("automatic credit recovery fails closed when candidate identity drifted", async () => {
  const state = fixtureState();
  const snapshot = {
    status: "ready",
    assignedAgentRole: "",
    reviewCycle: 1,
    reviewSubjectCycle: 1,
    reviewSubjectSha: "a".repeat(40),
    candidateIdentity: null,
    branchName: "feature/original",
  };
  state.tasks.push({
    id: "task_credit_drift",
    projectId: "project_1",
    title: "Review OAuth policy",
    status: "blocked",
    assignedAgentRole: "owner",
    reviewCycle: 1,
    reviewSubjectCycle: 1,
    reviewSubjectSha: "b".repeat(40),
    branchName: "feature/changed",
    automationBlocker: {
      type: "circuit",
      modelTier: "critical",
      resumeStatus: "ready",
    },
    automationCircuit: {
      state: "open",
      reasonCode: "credit_budget_insufficient",
      openedAt: "2026-08-17T14:00:00.000Z",
      snapshot,
    },
  });

  const report = await dispatchSupervisorActions([], {
    state,
    creditPolicy: {
      enabled: true,
      tierBudgets: { critical: { estimatedCredits: 30, minRemainingPercent: 5 } },
    },
    creditSnapshot: {
      status: "available",
      source: "codex-app-server",
      observedAt: new Date().toISOString(),
      remainingPercent: 50,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });

  assert.deepEqual(report.recoveredCreditCircuitTaskIds, []);
  assert.equal(state.tasks.at(-1).automationCircuit.state, "open");
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

test("one sweep exposes and uses three compatible builder and reviewer slots by default", () => {
  const state = fixtureState();
  state.projects = [];
  state.tasks = [];
  const actions = [];
  for (let index = 1; index <= 6; index += 1) {
    const projectId = `project_${index}`;
    const taskId = `task_${index}`;
    const reviewer = index > 3;
    state.projects.push({ id: projectId, key: `demo-${index}`, name: `Demo ${index}` });
    state.tasks.push({
      id: taskId,
      projectId,
      title: reviewer ? `Review API ${index}` : `Build API ${index}`,
      status: "ready",
      lane: "backend",
      workAreas: [`src/component-${index}/**`],
    });
    actions.push({
      id: `${taskId}:${reviewer ? "review" : "build"}`,
      type: reviewer ? "qa_integration_blocked" : "start_builder",
      role: reviewer ? "backend-reviewer" : "builder",
      projectId,
      projectKey: `demo-${index}`,
      taskId,
      taskTitle: state.tasks.at(-1).title,
      taskStatus: "ready",
    });
  }

  const report = planDispatches(state, actions);

  assert.equal(report.selected.filter((item) => item.group === "builder").length, 3);
  assert.equal(report.selected.filter((item) => item.group === "reviewer").length, 3);
  assert.deepEqual(report.effectiveCapacity.groups.builder, {
    configuredLimit: 3,
    active: 0,
    selected: 3,
    available: 0,
  });
  assert.deepEqual(report.effectiveCapacity.groups.reviewer, {
    configuredLimit: 3,
    active: 0,
    selected: 3,
    available: 0,
  });
});

test("installed dispatcher plan JSON includes effective capacity", async () => {
  const isolated = await createHermeticTestEnvironment();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("src/mission-control-dispatcher.js"),
      "--plan",
      "--json",
    ], {
      cwd: process.cwd(),
      env: isolated.env,
      timeout: 30_000,
    });
    const report = JSON.parse(stdout);

    assert.equal(report.dryRun, true);
    assert.equal(report.effectiveCapacity.groups.builder.configuredLimit, 3);
    assert.equal(report.effectiveCapacity.groups.reviewer.configuredLimit, 3);
    assert.equal(report.effectiveCapacity.maxDispatchesPerSweep, 6);
  } finally {
    await isolated.cleanup();
  }
});

test("reports make an explicit lower concurrency limit distinct from lane conflicts", () => {
  const state = fixtureState();
  state.projects.push({ id: "project_2", key: "other", name: "Other" });
  state.tasks = [
    { id: "task_a", projectId: "project_1", title: "First API", status: "ready", lane: "backend", workAreas: ["src/a/**"] },
    { id: "task_b", projectId: "project_2", title: "Second API", status: "ready", lane: "backend", workAreas: ["src/a/generated/**"] },
  ];
  const actions = state.tasks.map((task) => ({
    id: `${task.id}:start_builder`, type: "start_builder", role: "builder",
    projectId: task.projectId, taskId: task.id, taskTitle: task.title, taskStatus: "ready",
  }));
  const limited = planDispatches(state, actions, { builderConcurrency: 1 });

  assert.equal(limited.effectiveCapacity.groups.builder.configuredLimit, 1);
  assert.equal(limited.skipped[0].reason, "builder_concurrency_limit");
  assert.equal(limited.skipped[0].constraint, "concurrency_limit");

  state.tasks[1].projectId = "project_1";
  const conflicting = planDispatches(state, actions.map((action, index) => ({
    ...action,
    projectId: index ? "project_1" : action.projectId,
  })), { builderConcurrency: 3 });
  assert.match(conflicting.skipped[0].reason, /^lane_conflict:backend:/);
  assert.equal(conflicting.skipped[0].constraint, "lane_or_file_scope_conflict");
  assert.deepEqual(conflicting.skipped[0].fileScope, ["src/a/generated/**"]);

  const text = formatDispatchReport({
    generatedAt: new Date().toISOString(), dryRun: true, runs: [], ...conflicting,
  });
  assert.match(text, /Effective capacity:.*builder 0\+1\/3/);
  assert.match(text, /concurrency limits 0; lane\/file-scope conflicts 1/);
});

test("explicit disjoint same-lane scopes can use separate builder slots", () => {
  const state = fixtureState();
  state.tasks = [
    { id: "task_a", projectId: "project_1", title: "Lifecycle", status: "ready", lane: "backend", workAreas: ["src/lifecycle/**", "test/lifecycle/**"] },
    { id: "task_b", projectId: "project_1", title: "Retention", status: "ready", lane: "backend", workAreas: ["src/retention/**", "test/retention/**"] },
  ];
  const actions = state.tasks.map((task) => ({
    id: `${task.id}:start_builder`, type: "start_builder", role: "builder",
    projectId: task.projectId, taskId: task.id, taskTitle: task.title, taskStatus: "ready",
  }));

  const report = planDispatches(state, actions, { builderConcurrency: 2 });

  assert.deepEqual(report.selected.map((item) => item.taskId), ["task_a", "task_b"]);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.selected.every((item) => item.fileScopeExplicit), true);
});

test("explicit overlapping scopes serialize across lane labels", () => {
  const state = fixtureState();
  state.tasks = [
    { id: "task_a", projectId: "project_1", title: "Server", status: "ready", lane: "backend", workAreas: ["src/server/**"] },
    { id: "task_b", projectId: "project_1", title: "Deploy server", status: "ready", lane: "devops", workAreas: ["src/server/deploy.js"] },
  ];
  const actions = state.tasks.map((task) => ({
    id: `${task.id}:start_builder`, type: "start_builder", role: "builder",
    projectId: task.projectId, taskId: task.id, taskTitle: task.title, taskStatus: "ready",
  }));

  const report = planDispatches(state, actions, { builderConcurrency: 2 });

  assert.equal(report.selected.length, 1);
  assert.match(report.skipped[0].reason, /^lane_conflict:devops:task_a/);
});

test("devops and backend scopes run together only when explicitly disjoint", () => {
  const state = fixtureState();
  state.tasks = [
    { id: "task_a", projectId: "project_1", title: "Lifecycle", status: "ready", lane: "backend", workAreas: ["src/lifecycle-policy.js"] },
    { id: "task_b", projectId: "project_1", title: "Workflow", status: "ready", lane: "devops", workAreas: [".github/workflows/check.yml"] },
  ];
  const actions = state.tasks.map((task) => ({
    id: `${task.id}:start_builder`, type: "start_builder", role: "builder",
    projectId: task.projectId, taskId: task.id, taskTitle: task.title, taskStatus: "ready",
  }));

  const report = planDispatches(state, actions, { builderConcurrency: 2 });

  assert.equal(report.selected.length, 2);
  assert.deepEqual(report.selected.map((item) => item.conflictGroup), ["backend", "devops"]);
});

test("unknown same-lane scope stays serialized and glob overlap is conservative", () => {
  const state = fixtureState();
  state.tasks = [
    { id: "task_a", projectId: "project_1", title: "Unknown API", status: "ready", lane: "backend" },
    { id: "task_b", projectId: "project_1", title: "Known API", status: "ready", lane: "backend", workAreas: ["src/specific.js"] },
  ];
  const actions = state.tasks.map((task) => ({
    id: `${task.id}:start_builder`, type: "start_builder", role: "builder",
    projectId: task.projectId, taskId: task.id, taskTitle: task.title, taskStatus: "ready",
  }));

  const report = planDispatches(state, actions, { builderConcurrency: 2 });

  assert.equal(report.selected.length, 1);
  assert.match(report.skipped[0].reason, /^lane_conflict:backend:/);
  assert.equal(fileScopesMayOverlap(["src/a/**"], ["src/a/generated/**"]), true);
  assert.equal(fileScopesMayOverlap(["src/a/**"], ["src/b/**"]), false);
  assert.equal(fileScopesMayOverlap(["package*.json"], ["package-lock.json"]), true);
  assert.equal(fileScopesMayOverlap(["src/a.js"], ["src/b.js"]), false);
  assert.equal(fileScopesMayOverlap(["packages/design"], ["packages/design/src/tokens.js"]), true);
  assert.equal(fileScopesMayOverlap(["**/*"], ["docs/readme.md"]), true);
  assert.equal(fileScopesMayOverlap(["../outside/**"], ["src/safe.js"]), true);
  assert.equal(fileScopesMayOverlap(["/tmp/outside/**"], ["src/safe.js"]), true);
});

test("read-only architecture runs do not block independent mutating work", () => {
  const state = fixtureState();
  state.tasks = [
    {
      id: "task_architecture",
      projectId: "project_1",
      title: "Plan lifecycle controls",
      status: "architecture_in_progress",
      lane: "backend",
      workAreas: ["src/store.js", "src/server.js"],
    },
    {
      id: "task_builder",
      projectId: "project_1",
      title: "Implement workspace cleanup adapter",
      status: "ready",
      lane: "devops",
      workAreas: ["src/runner.js"],
    },
  ];
  state.runs = [{
    id: "run_architecture",
    taskId: "task_architecture",
    projectId: "project_1",
    status: "running",
    group: "architect",
    role: "systems-architect",
    actionType: "start_architecture",
  }];
  const action = {
    id: "task_builder:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_builder",
    taskTitle: "Implement workspace cleanup adapter",
    taskStatus: "ready",
  };

  const report = planDispatches(state, [action]);

  assert.equal(report.selected.length, 1);
  assert.equal(report.selected[0].taskId, "task_builder");
  assert.equal(report.effectiveCapacity.groups.architect.active, 1);
  assert.equal(report.effectiveCapacity.groups.builder.selected, 1);
});

test("read-only architecture runs remain architect-concurrency limited", () => {
  const state = fixtureState();
  state.tasks = [
    {
      id: "task_architecture_a",
      projectId: "project_1",
      title: "Plan lifecycle controls",
      status: "architecture_in_progress",
    },
    {
      id: "task_architecture_b",
      projectId: "project_1",
      title: "Plan lease controls",
      status: "architecture_pending",
    },
  ];
  state.runs = [{
    id: "run_architecture_a",
    taskId: "task_architecture_a",
    projectId: "project_1",
    status: "running",
    group: "architect",
    role: "systems-architect",
    actionType: "start_architecture",
  }];
  const action = {
    id: "task_architecture_b:start_architecture",
    type: "start_architecture",
    role: "systems-architect",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_architecture_b",
    taskTitle: "Plan lease controls",
    taskStatus: "architecture_pending",
  };

  const report = planDispatches(state, [action]);

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped[0].reason, "architect_concurrency_limit");
});

function criticalCreditFixture() {
  const state = fixtureState();
  state.tasks.push({
    id: "task_credit",
    projectId: "project_1",
    title: "Secure production release migration",
    status: "ready",
    priority: "critical",
  });
  const action = {
    id: "task_credit:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_credit",
    taskTitle: "Secure production release migration",
    taskStatus: "ready",
  };
  const options = {
    state,
    executionPolicy: {
      modelTiers: {
        economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
        critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      tierRouting: { defaultTier: "economy", complexTier: "critical" },
    },
    creditPolicy: {
      enabled: true,
      probeTimeoutMs: 1000,
      failClosedTiers: ["critical", "frontier"],
      tierBudgets: { critical: { estimatedCredits: 30, minRemainingPercent: 20 } },
    },
    creditSnapshot: {
      status: "unknown",
      source: "sanitized-test-probe",
      observedAt: new Date().toISOString(),
      reason: "Temporary sanitized probe failure.",
    },
  };
  return { state, action, options };
}

test("live dispatch retries one transient unknown snapshot outside admission and then succeeds", async () => {
  const { state, action, options } = criticalCreditFixture();
  let probes = 0;
  options.creditSnapshotProbe = async () => {
    probes += 1;
    return {
      status: "available",
      source: "sanitized-test-probe",
      observedAt: new Date().toISOString(),
      remainingPercent: 80,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    };
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(probes, 1);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].modelTier, "critical");
  assert.equal(report.runs[0].model, "gpt-5.6-sol");
  assert.equal(state.tasks.at(-1).automationCircuit, undefined);
});

test("live dispatch probes an unknown snapshot exactly once and opens one circuit if still unknown", async () => {
  const { state, action, options } = criticalCreditFixture();
  let probes = 0;
  options.creditSnapshotProbe = async () => {
    probes += 1;
    return { ...options.creditSnapshot, observedAt: new Date().toISOString() };
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(probes, 1);
  assert.equal(report.runs.length, 0);
  assert.equal(report.skipped[0].reason, "credit_gate:credit_snapshot_unknown");
  assert.equal(state.tasks.at(-1).automationCircuit.state, "open");
  assert.equal(state.events.filter((event) => event.type === "credit_admission_blocked").length, 1);
});

test("plan mode never performs the unknown credit recovery probe", async () => {
  const { action, options } = criticalCreditFixture();
  options.dryRun = true;
  let probes = 0;
  options.creditSnapshotProbe = async () => {
    probes += 1;
    return { status: "available", observedAt: new Date().toISOString() };
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(probes, 0);
  assert.equal(report.dryRun, true);
  assert.equal(report.skipped[0].reason, "credit_gate:credit_snapshot_unknown");
});

test("a retry that reports a real limit opens one circuit without another probe or model run", async () => {
  const { state, action, options } = criticalCreditFixture();
  let probes = 0;
  options.creditSnapshotProbe = async () => {
    probes += 1;
    return {
      status: "available",
      source: "sanitized-test-probe",
      observedAt: new Date().toISOString(),
      remainingPercent: 0,
      reached: true,
      reachedType: "usage_limit",
      credits: { available: false, unlimited: false, balance: null },
    };
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(probes, 1);
  assert.equal(report.runs.length, 0);
  assert.equal(report.skipped[0].reason, "credit_gate:rate_limit_reached");
  assert.equal(state.tasks.at(-1).automationCircuit.state, "open");
  assert.equal(state.events.filter((event) => event.type === "credit_admission_blocked").length, 1);
});

test("a real rate limit fails closed without a retry or quality downgrade", async () => {
  const { state, action, options } = criticalCreditFixture();
  options.creditSnapshot = {
    status: "available",
    source: "sanitized-test-probe",
    observedAt: new Date().toISOString(),
    remainingPercent: 0,
    reached: true,
    reachedType: "usage_limit",
    credits: { available: false, unlimited: false, balance: null },
  };
  let probes = 0;
  options.creditSnapshotProbe = async () => {
    probes += 1;
    throw new Error("real limits must not be retried");
  };

  const report = await dispatchSupervisorActions([action], options);

  assert.equal(probes, 0);
  assert.equal(report.runs.length, 0);
  assert.equal(report.skipped[0].reason, "credit_gate:rate_limit_reached");
  assert.equal(state.tasks.at(-1).automationBlocker.modelTier, "critical");
  assert.equal(state.tasks.at(-1).automationCircuit.state, "open");
});

test("owner handoff requires the immutable human production release packet", async () => {
  const state = fixtureState();
  const report = await dispatchSupervisorActions([{
    id: "task_1:notify_owner",
    type: "notify_owner",
    role: "owner",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_1",
    taskTitle: "QA-ready task",
    taskUrl: "http://127.0.0.1:4317/tasks/task_1",
  }], { state });

  assert.match(report.runs[0].prompt, /immutable candidate manifest/i);
  assert.match(report.runs[0].prompt, /full commit SHA/);
  assert.match(report.runs[0].prompt, /target host/);
  assert.match(report.runs[0].prompt, /SHA-256 digest/);
  assert.match(report.runs[0].prompt, /exact-commit health-check time/);
  assert.match(report.runs[0].prompt, /tested rollback commit or procedure/);
  assert.match(report.runs[0].prompt, /automation merge, tag, release, or deploy/i);
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

test("active disk recovery blocks worker dispatches but preserves owner handoffs", () => {
  const state = fixtureState();
  state.meta = { diskPressureIncident: { id: "disk_incident_1", state: "awaiting_health", generation: 2 } };
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

  assert.equal(builder.selected.length, 0);
  assert.equal(builder.skipped[0].reason, "disk_recovery_in_progress");
  assert.equal(owner.selected.length, 1);
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

test("reviewers receive role-scoped threads and never reuse builder or peer reviewer threads", async () => {
  const { state, action } = finalAttemptReviewFixture("completed");
  state.runs = [];
  state.tasks[1].reviewSubjectSha = "a".repeat(40);
  state.tasks[1].reviewSubjectCycle = 1;
  state.tasks[1].reviewCycle = 1;
  state.tasks[1].assignedThreadId = "thread-builder";
  state.tasks[1].reviewerThreadId = "thread-legacy";
  state.tasks[1].reviewerThreadIds = {
    "backend-reviewer": "thread-backend",
    "frontend-reviewer": "thread-frontend",
  };
  state.reviews.push({
    id: "review_backend_current",
    taskId: "task_2",
    stageKey: "backend",
    role: "backend-reviewer",
    outcome: "approved",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: "a".repeat(40),
  }, {
    id: "review_accessibility_current",
    taskId: "task_2",
    stageKey: "accessibility",
    role: "accessibility-reviewer",
    outcome: "skipped",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: "a".repeat(40),
  });
  const frontend = await dispatchSupervisorActions([action], { state });
  assert.equal(frontend.runs[0].threadId, "thread-frontend");

  state.runs = [];
  state.tasks[1].status = "lead_review";
  state.reviews.push({
    id: "review_frontend_current",
    taskId: "task_2",
    stageKey: "frontend",
    role: "frontend-reviewer",
    outcome: "approved",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: "a".repeat(40),
  });
  const lead = await dispatchSupervisorActions([{
    ...action,
    id: "task_2:continue_review:lead-independent",
    role: "lead-reviewer",
    taskStatus: "lead_review",
    nextStatus: "lead_review",
    threadId: "thread-backend",
  }], { state });
  assert.equal(lead.runs[0].threadId, "");
});

test("estimated task cost budgets fail closed before model launch", async () => {
  const state = fixtureState();
  state.tasks[0] = {
    ...state.tasks[0],
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
    costBudget: 0.01,
  };
  const report = await dispatchSupervisorActions([{
    id: "task_1:start_builder:budget",
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
  }], {
    state,
    executionPolicy: {
      modelTiers: { economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" } },
      tierRouting: { defaultTier: "economy" },
    },
    creditPolicy: {
      enabled: true,
      tierBudgets: { economy: { estimatedCredits: 8, minRemainingPercent: 5 } },
    },
    creditSnapshot: {
      status: "available",
      observedAt: new Date().toISOString(),
      remainingPercent: 80,
      reached: false,
      credits: { available: false, unlimited: false, balance: null },
    },
  });
  assert.equal(report.runs.length, 0);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationBlocker.type, "circuit");
  assert.equal(state.tasks[0].automationCircuit.reasonCode, "task_cost_budget_insufficient");
});
