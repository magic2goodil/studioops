import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/dispatcher.js";
import {
  classifyPreviewHealthFailure,
  planQaIntegrations,
  probePreviewHealth,
} from "../src/qa-integration.js";
import {
  claimRuns,
  completeRun,
  probeAutomationCircuit,
  reconcileStaleRuns,
} from "../src/runner.js";
import {
  automationTick,
  cancelQueuedRuns,
  resetAutomationCircuit,
  setAutomationPause,
} from "../src/store.js";

const NOW_MS = Date.parse("2026-07-22T12:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

function baseState() {
  return {
    meta: {},
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: "https://github.com/example/demo",
      workflowMode: "github",
      automationCircuit: { state: "closed" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Bound retries",
      type: "bug",
      status: "in_progress",
      assignedAgentRole: "builder",
      automationAttemptEpoch: 0,
      automationCircuit: { state: "closed" },
      createdAt: NOW,
      updatedAt: NOW,
    }],
    runs: [],
    comments: [],
    events: [],
    reviews: [],
    qaBundles: [],
  };
}

function runningRun(id, patch = {}) {
  return {
    id,
    taskId: "task_1",
    projectId: "project_1",
    actionType: "start_builder",
    group: "builder",
    role: "builder",
    status: "running",
    attemptEpoch: 0,
    attempt: 1,
    maxAttempts: 2,
    retryBackoffMs: 1_000,
    model: "gpt-5.6-sol",
    modelReasoningEffort: "xhigh",
    modelLaunchedAt: NOW,
    modelBudgetConsumed: true,
    taskStatusBeforeDispatch: "queued",
    startedAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

test("task retry limit survives action and review-cycle key changes", async () => {
  const state = baseState();
  state.runs.push(runningRun("run_1"));
  await completeRun("run_1", {
    state,
    status: "failed",
    exitCode: "sdk_error",
    notes: "provider stream failed with request 123456",
    elapsedMs: 1_250,
    tokenUsage: {
      available: true,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    },
  });

  assert.equal(state.tasks[0].status, "queued");
  assert.equal(state.runs[0].failureCode, "sdk_error");
  assert.equal(state.runs[0].elapsedMs, 1_250);
  assert.equal(state.runs[0].tokenUsage.totalTokens, 125);

  state.tasks[0].status = "in_progress";
  state.tasks[0].reviewCycle = 3;
  state.runs.push(runningRun("run_2", {
    actionType: "start_builder_fix",
    attempt: 2,
    taskStatusBeforeDispatch: "needs_changes",
    startedAt: new Date(NOW_MS + 2_000).toISOString(),
    modelLaunchedAt: new Date(NOW_MS + 2_000).toISOString(),
  }));
  await completeRun("run_2", {
    state,
    status: "failed",
    exitCode: "sdk_error",
    notes: "provider stream failed with request 987654",
  });

  const task = state.tasks[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.automationCircuit.state, "open");
  assert.equal(task.automationCircuit.attemptsConsumed, 2);
  assert.equal(task.automationCircuit.reasonCode, "sdk_error");
  assert.equal(state.runs[0].failureFingerprint, state.runs[1].failureFingerprint);

  const blockedDispatch = planDispatches(state, [{
    id: "task_1:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_1",
    taskTitle: task.title,
  }], { nowMs: NOW_MS + 5_000 });
  assert.equal(blockedDispatch.selected.length, 0);
  assert.match(blockedDispatch.skipped[0].reason, /task_circuit_open/);

  await automationTick({ state, nowMs: NOW_MS + 24 * 60 * 60 * 1_000 });
  assert.equal(task.status, "blocked");

  await resetAutomationCircuit({
    state,
    task: task.id,
    reason: "Owner repaired and verified the provider configuration.",
    nowMs: NOW_MS + 24 * 60 * 60 * 1_000,
  });
  assert.equal(task.status, "needs_changes");
  assert.equal(task.automationCircuit.state, "closed");
  assert.equal(task.automationAttemptEpoch, 1);
});

test("project credential preflight opens one circuit and cancels sibling queues without task failures", async () => {
  const state = baseState();
  state.tasks.push({
    ...state.tasks[0],
    id: "task_2",
    title: "Sibling task",
  });
  state.runs.push(
    {
      ...runningRun("run_1"),
      status: "queued",
      modelLaunchedAt: "",
      modelBudgetConsumed: false,
      budgetReservation: true,
    },
    {
      ...runningRun("run_2"),
      taskId: "task_2",
      status: "queued",
      modelLaunchedAt: "",
      modelBudgetConsumed: false,
      budgetReservation: true,
    },
  );

  const claimed = await claimRuns({
    state,
    limit: 2,
    preflightRun: async () => ({
      ok: false,
      code: "invalid_github_app_credentials",
      message: "GitHub App credentials are invalid.",
      remediation: "Repair the GitHub App credentials.",
    }),
  });

  assert.deepEqual(claimed, []);
  assert.equal(state.projects[0].automationCircuit.state, "open");
  assert.equal(state.projects[0].automationCircuit.reasonCode, "invalid_github_app_credentials");
  assert.equal(state.projects[0].automationCircuit.attemptsConsumed, 0);
  assert.deepEqual(state.runs.map((run) => run.status), ["cancelled", "cancelled"]);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[1].status, "queued");
  assert.equal(state.tasks[1].lastAutomationFailure, undefined);

  const probe = await probeAutomationCircuit({
    state,
    project: "demo",
    preflightRun: async () => ({
      ok: true,
      workflowMode: "github",
      originUrl: "https://github.com/example/demo",
    }),
  });
  assert.equal(probe.ok, true);
  assert.equal(state.projects[0].automationCircuit.state, "closed");
  assert.equal(state.tasks[0].status, "queued");
});

test("runner PID loss preserves evidence and opens a no-relaunch circuit", async () => {
  const state = baseState();
  state.runs.push(runningRun("run_1", {
    runnerPid: "999999999",
    childPid: "",
    threadId: "thread_preserved",
    workspacePath: "/tmp/studioops-preserved-workspace",
    outputPath: "/tmp/studioops-preserved-output.log",
    lastMessagePath: "/tmp/studioops-preserved-last-message.md",
    startedAt: new Date(NOW_MS - 60_000).toISOString(),
  }));

  const recovered = await reconcileStaleRuns({
    state,
    nowMs: NOW_MS,
    pidGraceMs: 1_000,
  });

  assert.equal(recovered.length, 1);
  assert.equal(state.runs[0].status, "failed");
  assert.equal(state.runs[0].failureCode, "runner_pid_lost");
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationCircuit.state, "open");
  assert.equal(state.tasks[0].automationCircuit.preservedEvidence.threadId, "thread_preserved");
  assert.equal(state.tasks[0].automationCircuit.preservedEvidence.workspacePath, "/tmp/studioops-preserved-workspace");
  assert.equal(state.runs.some((run) => run.status === "queued"), false);
});

test("preview TLS diagnostics are actionable and integrated tasks plan only a cheap probe", async () => {
  const tlsError = Object.assign(new Error("fetch failed"), {
    cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  });
  const classification = classifyPreviewHealthFailure(tlsError);
  assert.equal(classification.diagnosticCode, "preview_tls_error");
  assert.match(classification.remediation, /certificate|tls/i);

  const probe = await probePreviewHealth("https://127.0.0.1:4443/health", {
    fetch: async () => { throw tlsError; },
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.diagnosticCode, "preview_tls_error");

  const refused = classifyPreviewHealthFailure(Object.assign(new Error("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  }));
  assert.equal(refused.diagnosticCode, "preview_connection_refused");
  assert.match(refused.remediation, /process|listening/i);

  const http = await probePreviewHealth("http://127.0.0.1:4443/health", {
    fetch: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
    attempts: 1,
  });
  assert.equal(http.diagnosticCode, "preview_http_status");
  assert.equal(http.httpStatus, 503);

  const state = baseState();
  state.projects[0].reviewPolicy = {
    trustLeadApprovals: true,
    integrationBranch: "qa/demo",
  };
  state.projects[0].integrationBranch = "qa/demo";
  state.projects[0].localQaPreview = {
    enabled: true,
    checkoutPath: "/tmp/demo-preview",
    branch: "qa/demo",
    healthCheckUrl: "https://127.0.0.1:4443/health",
  };
  Object.assign(state.tasks[0], {
    status: "qa_review",
    integrationStatus: "preview_blocked",
    integrationCommit: "abc123",
    integrationRetryNotBefore: "",
    branchName: "codex/demo-task",
    prUrl: "https://github.com/example/demo/pull/1",
  });

  const plan = planQaIntegrations(state, { nowMs: NOW_MS });
  assert.equal(plan.projects[0].tasks.length, 0);
  assert.equal(plan.projects[0].previewTasks.length, 1);
  assert.equal(plan.projects[0].previewTasks[0].integrationCommit, "abc123");
});

test("operator pause and budget limits prevent new durable model queues", async () => {
  const state = baseState();
  state.tasks[0].status = "in_progress";
  state.runs.push({
    ...runningRun("run_queued"),
    status: "queued",
    modelLaunchedAt: "",
    modelBudgetConsumed: false,
    budgetReservation: true,
  });
  state.runs.push(runningRun("run_in_flight", {
    taskId: "task_in_flight",
    runnerPid: String(process.pid),
  }));
  await setAutomationPause(true, { state, reason: "Owner maintenance window.", nowMs: NOW_MS });

  const action = {
    id: "task_1:start_builder",
    type: "start_builder",
    role: "builder",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_1",
    taskTitle: "Bound retries",
  };
  const pausedPlan = planDispatches(state, [action], { nowMs: NOW_MS });
  assert.equal(pausedPlan.selected.length, 0);
  assert.equal(pausedPlan.skipped[0].reason, "operator_pause");

  const cancelled = await cancelQueuedRuns({ state, nowMs: NOW_MS, reason: "Owner cancelled queued work." });
  assert.equal(cancelled.length, 1);
  assert.equal(state.runs.find((run) => run.id === "run_in_flight").status, "running");
  assert.equal(state.tasks[0].status, "queued");
  assert.equal(state.tasks[0].lastAutomationFailure, undefined);

  await setAutomationPause(false, { state, nowMs: NOW_MS + 1_000 });
  state.runs = Array.from({ length: 6 }, (_, index) => ({
    id: `run_history_${index}`,
    taskId: `historical_${index}`,
    projectId: "project_1",
    group: "builder",
    status: "completed",
    budgetReservation: true,
    modelBudgetConsumed: true,
    modelLaunchedAt: new Date(NOW_MS - index * 1_000).toISOString(),
    createdAt: new Date(NOW_MS - index * 1_000).toISOString(),
  }));

  const budgetPlan = planDispatches(state, [action], {
    nowMs: NOW_MS,
    rollingHourRunBudget: 6,
    dailyRunBudget: 24,
  });
  assert.equal(budgetPlan.selected.length, 0);
  assert.equal(budgetPlan.skipped[0].reason, "rolling_hour_run_budget_exceeded");
  assert.equal(budgetPlan.budget.pause.reason, "rolling_hour_run_budget_exceeded");

  const overridePlan = planDispatches(state, [action], {
    nowMs: NOW_MS,
    rollingHourRunBudget: 6,
    dailyRunBudget: 24,
    budgetOverride: true,
  });
  assert.equal(overridePlan.selected.length, 1);

  state.runs = [
    ...state.runs.slice(0, 5),
    {
      id: "run_reserved",
      taskId: "task_reserved",
      projectId: "project_1",
      group: "builder",
      status: "queued",
      budgetReservation: true,
      modelBudgetConsumed: false,
      createdAt: NOW,
    },
  ];
  const reservationPlan = planDispatches(state, [action], {
    nowMs: NOW_MS,
    rollingHourRunBudget: 6,
    dailyRunBudget: 24,
  });
  assert.equal(reservationPlan.selected.length, 0);
  assert.equal(reservationPlan.skipped[0].reason, "rolling_hour_run_budget_exceeded");

  state.runs = Array.from({ length: 6 }, (_, index) => ({
    id: `run_claim_history_${index}`,
    taskId: `historical_${index}`,
    projectId: "project_1",
    group: "builder",
    status: "completed",
    modelBudgetConsumed: true,
    modelLaunchedAt: new Date(NOW_MS - index * 1_000).toISOString(),
    createdAt: new Date(NOW_MS - index * 1_000).toISOString(),
  }));
  state.runs.push({
    ...runningRun("run_waiting"),
    status: "queued",
    modelLaunchedAt: "",
    modelBudgetConsumed: false,
    budgetReservation: true,
  });
  const claimedAtLimit = await claimRuns({
    state,
    nowMs: NOW_MS,
    rollingHourRunBudget: 6,
    dailyRunBudget: 24,
    preflightRun: async () => ({ ok: true, workflowMode: "local" }),
  });
  assert.equal(claimedAtLimit.length, 0);
  assert.equal(state.runs.at(-1).status, "queued");
  assert.equal(state.meta.budgetPause.active, true);

  state.runs = [];
  const duplicateActionPlan = planDispatches(state, [
    action,
    { ...action, id: "task_1:start_builder_fix", type: "start_builder_fix" },
  ], {
    nowMs: NOW_MS,
    executionPolicy: { maxAttempts: 1 },
  });
  assert.equal(duplicateActionPlan.selected.length, 1);
  assert.equal(duplicateActionPlan.skipped[0].reason, "task_attempt_limit:1/1");
});
