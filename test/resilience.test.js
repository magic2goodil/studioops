import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGitHubRemoteRecoveryProbeResultInState,
  automationTick,
  claimDueGitHubRemoteRecoveryProbesInState,
  resetAutomationCircuitInState,
  resumeOperatorAutomationInState,
  scheduleGitHubRemoteRecoveryProbeInState,
  setOperatorPauseInState,
} from "../src/store.js";
import { createSupervisorReport } from "../src/supervisor.js";

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

function githubRecoveryState(nowMs = NOW) {
  const run = {
    id: "run_9",
    taskId: "task_1",
    projectId: "project_1",
    status: "cancelled",
    exitCode: "inaccessible_github_remote",
    group: "builder",
    role: "builder",
    actionType: "start_builder",
    branchName: "codex/demo-task",
    prUrl: "",
    attempt: 1,
  };
  const state = stateWith({
    status: "blocked",
    assignedAgentRole: "owner",
    branchName: "codex/demo-task",
    prUrl: "",
    automationAttemptEpoch: 3,
  }, [run]);
  scheduleGitHubRemoteRecoveryProbeInState(state, run, {
    nowMs,
    owner: "Example",
    repository: "Demo.git",
    branchName: "codex/demo-task",
    resumeStatus: "queued",
    diagnostic: "remote unavailable",
    remediation: "verify access",
  });
  return state;
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

test("automation does not recover tracking parents with child tasks into builder work", async () => {
  const state = stateWith({ type: "feature" });
  state.tasks.push({
    id: "task_child",
    projectId: "project_1",
    parentTaskId: "task_1",
    title: "Buildable child",
    type: "feature",
    status: "idea",
    dependsOnTaskIds: [],
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  });

  const result = await automationTick({ state, nowMs: NOW, orphanGraceMs: 60_000 });
  assert.equal(state.tasks[0].status, "in_progress");
  assert.equal(result.actions.some((action) => action.includes("task_1")), false);
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

test("operator pause has an explicit audited resume transition", () => {
  const state = stateWith({ status: "ready" });
  const pausedAt = "2026-07-21T11:00:00.000Z";
  const resumedAt = "2026-07-21T12:00:00.000Z";

  setOperatorPauseInState(state, {
    reason: "Incident verification",
    author: "Operator",
    now: pausedAt,
  });
  const resumed = resumeOperatorAutomationInState(state, {
    reason: "Database and workers verified",
    author: "Operator",
    now: resumedAt,
  });

  assert.equal(resumed.active, false);
  assert.equal(resumed.pausedAt, pausedAt);
  assert.equal(resumed.resumedAt, resumedAt);
  assert.equal(resumed.resumeReason, "Database and workers verified");
  assert.deepEqual(
    state.events.map((event) => event.type),
    ["automation_paused", "automation_resumed"],
  );
});

test("task circuit reset preserves evidence and starts a fresh dispatch epoch", () => {
  const state = stateWith({
    status: "blocked",
    assignedAgentRole: "owner",
    automationBlocker: {
      type: "circuit",
      reason: "attempt_budget_exhausted",
      resumeStatus: "lead_review",
    },
    automationCircuit: {
      state: "open",
      reasonCode: "attempt_budget_exhausted",
      openedAt: "2026-07-21T11:00:00.000Z",
    },
  });

  const reset = resetAutomationCircuitInState(state, {
    task: "task_1",
    reason: "Run output and repository access verified",
    author: "Operator",
    now: "2026-07-21T12:00:00.000Z",
  });

  assert.equal(reset.status, "lead_review");
  assert.equal(reset.assignedAgentRole, "");
  assert.equal(reset.automationAttemptEpoch, 1);
  assert.equal(reset.automationCircuit.state, "closed");
  assert.equal(reset.automationCircuit.reasonCode, "attempt_budget_exhausted");
  assert.equal(reset.automationCircuit.closeReason, "Run output and repository access verified");
  assert.equal(reset.automationBlocker, undefined);
  assert.ok(state.comments.some((comment) => /New execution epoch 1/.test(comment.body)));
  assert.ok(state.events.some((event) => event.type === "automation_circuit_reset"));
});

test("project circuit reset advances every project task into a fresh attempt epoch", () => {
  const state = stateWith({ status: "ready" });
  state.projects[0].automationCircuit = {
    state: "open",
    reasonCode: "shared_repository_unavailable",
  };
  state.tasks.push({
    ...state.tasks[0],
    id: "task_2",
  });

  resetAutomationCircuitInState(state, {
    project: "demo",
    reason: "Shared repository access verified",
    now: "2026-07-21T12:00:00.000Z",
  });

  assert.equal(state.projects[0].automationCircuit.state, "closed");
  assert.deepEqual(state.tasks.map((task) => task.automationAttemptEpoch), [1, 1]);
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

test("GitHub recovery probes use durable capped exponential backoff", () => {
  const state = githubRecoveryState();
  const expectedDelays = [2, 4, 8, 15, 15].map((minutes) => minutes * 60_000);
  let dueAt = NOW + 60_000;

  for (let index = 0; index < expectedDelays.length; index += 1) {
    const [claim] = claimDueGitHubRemoteRecoveryProbesInState(state, {
      nowMs: dueAt,
      leaseMs: 30_000,
      leaseIdFactory: () => `lease_${index}`,
    });
    assert.ok(claim);
    const result = applyGitHubRemoteRecoveryProbeResultInState(state, claim, {
      ok: false,
      probeable: true,
      code: "inaccessible_github_remote",
      diagnostic: `failure ${index + 1}`,
    }, { nowMs: dueAt });
    assert.equal(result.status, "waiting");
    assert.equal(Date.parse(result.nextProbeAt) - dueAt, expectedDelays[index]);
    dueAt = Date.parse(result.nextProbeAt);
  }

  const probe = state.tasks[0].automationBlocker.recoveryProbe;
  assert.equal(probe.probeCount, 5);
  assert.equal(probe.lastCode, "inaccessible_github_remote");
  assert.equal(probe.lastDiagnostic, "failure 5");
});

test("GitHub recovery lease compare-and-set prevents duplicate writes and permits expiry retry", () => {
  const state = githubRecoveryState();
  const dueAt = NOW + 60_000;
  const [first] = claimDueGitHubRemoteRecoveryProbesInState(state, {
    nowMs: dueAt,
    leaseMs: 5_000,
    leaseIdFactory: () => "lease_first",
  });
  assert.ok(first);
  assert.deepEqual(claimDueGitHubRemoteRecoveryProbesInState(state, {
    nowMs: dueAt + 1_000,
    leaseMs: 5_000,
  }), []);

  const [replacement] = claimDueGitHubRemoteRecoveryProbesInState(state, {
    nowMs: dueAt + 5_001,
    leaseMs: 5_000,
    leaseIdFactory: () => "lease_replacement",
  });
  assert.ok(replacement);
  assert.equal(
    applyGitHubRemoteRecoveryProbeResultInState(state, first, {
      ok: true,
      code: "verified",
    }, { nowMs: dueAt + 5_002 }).applied,
    false,
  );
  assert.equal(
    applyGitHubRemoteRecoveryProbeResultInState(state, replacement, {
      ok: true,
      code: "verified",
    }, { nowMs: dueAt + 5_002 }).status,
    "recovered",
  );
  assert.equal(state.comments.filter((comment) => /Verified GitHub remote recovery/.test(comment.body)).length, 1);
});

test("changed recovery target and exact source role become owner-actionable non-probeable blockers", () => {
  const targetChanged = githubRecoveryState();
  targetChanged.tasks[0].branchName = "";
  assert.deepEqual(claimDueGitHubRemoteRecoveryProbesInState(targetChanged, {
    nowMs: NOW + 60_000,
  }), []);
  assert.equal(
    targetChanged.tasks[0].automationBlocker.reason,
    "github_remote_recovery_target_changed",
  );
  assert.equal(targetChanged.tasks[0].automationBlocker.recoveryProbe.nextProbeAt, "");

  const roleChanged = githubRecoveryState();
  roleChanged.runs[0].role = "frontend-reviewer";
  assert.deepEqual(claimDueGitHubRemoteRecoveryProbesInState(roleChanged, {
    nowMs: NOW + 60_000,
  }), []);
  assert.equal(
    roleChanged.tasks[0].automationBlocker.reason,
    "github_remote_recovery_source_context_changed",
  );
  assert.equal(roleChanged.tasks[0].assignedAgentRole, "owner");

  const invalidResume = githubRecoveryState();
  invalidResume.tasks[0].automationBlocker.recoveryProbe.resumeStatus = "done";
  assert.deepEqual(claimDueGitHubRemoteRecoveryProbesInState(invalidResume, {
    nowMs: NOW + 60_000,
  }), []);
  assert.equal(
    invalidResume.tasks[0].automationBlocker.reason,
    "github_remote_recovery_invalid_resume_status",
  );

  const missingSource = githubRecoveryState();
  missingSource.runs = [];
  assert.deepEqual(claimDueGitHubRemoteRecoveryProbesInState(missingSource, {
    nowMs: NOW + 60_000,
  }), []);
  assert.equal(
    missingSource.tasks[0].automationBlocker.reason,
    "github_remote_recovery_source_run_missing",
  );
});

test("GitHub recovery diagnostics are redacted and supervisor distinguishes automatic waiting", () => {
  const state = githubRecoveryState();
  scheduleGitHubRemoteRecoveryProbeInState(state, state.runs[0], {
    nowMs: NOW,
    owner: "example",
    repository: "demo",
    branchName: "codex/demo-task",
    resumeStatus: "queued",
    diagnostic: "failed with github_pat_1234567890abcdef and https://user:password@github.com/example/demo",
  });
  const probe = state.tasks[0].automationBlocker.recoveryProbe;
  assert.doesNotMatch(probe.lastDiagnostic, /1234567890abcdef|password/);
  assert.match(probe.lastDiagnostic, /\[REDACTED\]/);

  const report = createSupervisorReport(state, { includeWaiting: true });
  const action = report.actions.find((item) => item.taskId === "task_1");
  assert.equal(action.type, "waiting_for_github_remote_recovery");
  assert.match(action.reason, /probe 1/);
  assert.match(action.reason, /Role: builder/);
  assert.match(action.reason, /repository: example\/demo/);
  assert.match(action.reason, /target: codex\/demo-task/);
  assert.match(action.reason, /latest diagnostic:/);
});
