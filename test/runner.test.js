import assert from "node:assert/strict";
import test from "node:test";
import { activeRunStaleReason, branchReuseSafetyReason, claimRuns, cloneFallbackSource, planRunnableRuns } from "../src/runner.js";

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

function builderRun(patch = {}) {
  return {
    id: "run_1",
    taskId: "task_1",
    projectId: "project_1",
    actionType: "start_builder",
    group: "builder",
    role: "builder",
    branchName: "codex/demo-task",
    prUrl: "https://github.com/example/repo/pull/12",
    ...patch,
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

test("runner does not plan or claim runs while self-update lease is active", async () => {
  const state = fixtureState(
    {
      status: "in_progress",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
    },
  );
  state.meta = {
    selfUpdateLease: {
      id: "lease_1",
      startedAt: "2026-07-17T21:00:00.000Z",
      expiresAt: "2026-07-17T21:10:00.000Z",
      repoPath: "/tmp/mission-control",
      branch: "main",
      remoteRef: "origin/main",
    },
  };

  const report = planRunnableRuns(state, { limit: 1, nowMs: Date.parse("2026-07-17T21:01:00.000Z") });

  assert.equal(report.runnable.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "self_update_in_progress:lease_1");

  const claimed = await claimRuns({ state, limit: 1, nowMs: Date.parse("2026-07-17T21:01:00.000Z") });

  assert.deepEqual(claimed, []);
  assert.equal(state.runs[0].status, "queued");
});

test("runner does not plan or claim runs while the operator pause is active", async () => {
  const state = fixtureState(
    {
      status: "in_progress",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
    },
  );
  state.meta = {
    operatorPause: {
      active: true,
      reason: "Incident recovery",
    },
  };

  const report = planRunnableRuns(state, { limit: 1 });
  const claimed = await claimRuns({ state, limit: 1 });

  assert.equal(report.runnable.length, 0);
  assert.equal(report.skipped[0].reason, "operator_pause");
  assert.deepEqual(claimed, []);
  assert.equal(state.runs[0].status, "queued");
});

test("runner cancels queued work whose task circuit is open", async () => {
  const state = fixtureState(
    {
      status: "blocked",
      integrationStatus: "",
      automationCircuit: { state: "open" },
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
    },
  );

  const claimed = await claimRuns({ state, limit: 1 });

  assert.deepEqual(claimed, []);
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.runs[0].exitCode, "task_circuit_open");
});

test("builder runs may continue writing to open linked PR branches", () => {
  assert.equal(branchReuseSafetyReason(builderRun(), {
    state: "OPEN",
    headRefName: "codex/demo-task",
    url: "https://github.com/example/repo/pull/12",
  }), "");
});

test("builder runs refuse to reuse merged linked PR branches", () => {
  const reason = branchReuseSafetyReason(builderRun(), {
    state: "MERGED",
    mergedAt: "2026-07-17T15:00:00Z",
    headRefName: "codex/demo-task",
    url: "https://github.com/example/repo/pull/12",
  });

  assert.ok(reason.includes("Refusing to reuse codex/demo-task"));
  assert.match(reason, /merged at 2026-07-17T15:00:00Z/);
});

test("builder runs refuse to reuse closed linked PR branches", () => {
  const reason = branchReuseSafetyReason(builderRun(), {
    state: "CLOSED",
    headRefName: "codex/demo-task",
    url: "https://github.com/example/repo/pull/12",
  });

  assert.match(reason, /closed/);
});

test("reviewer runs are not blocked by closed PR branch reuse checks", () => {
  assert.equal(branchReuseSafetyReason(builderRun({
    actionType: "continue_review",
    group: "reviewer",
    role: "backend-reviewer",
  }), {
    state: "CLOSED",
    headRefName: "codex/demo-task",
    url: "https://github.com/example/repo/pull/12",
  }), "");
});

test("clone fallback prefers the repository origin over a local worktree source", () => {
  assert.equal(
    cloneFallbackSource("/tmp/local-worktree", "git@github.com:example/repo.git"),
    "git@github.com:example/repo.git",
  );
  assert.equal(cloneFallbackSource("/tmp/local-worktree", ""), "/tmp/local-worktree");
});

test("dead or overlong running jobs are identified for automatic recovery", () => {
  const nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  assert.match(activeRunStaleReason({
    status: "running",
    startedAt: "2026-07-20T11:00:00.000Z",
    runnerPid: 999_999_999,
  }, { nowMs, pidGraceMs: 1_000 }), /runner_pid_not_alive/);

  assert.match(activeRunStaleReason({
    status: "running",
    startedAt: "2026-07-20T08:00:00.000Z",
    staleRunMs: 60 * 60 * 1000,
  }, { nowMs }), /run_exceeded/);
});

test("legacy queued security work is upgraded to the current xhigh execution policy when claimed", async () => {
  const state = fixtureState(
    {
      title: "Harden OAuth PII storage",
      status: "in_progress",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
      model: "",
      modelReasoningEffort: "",
    },
  );

  const [run] = await claimRuns({ state, limit: 1, modelReasoningEffort: "high" });

  assert.equal(run.model, "gpt-5.6-sol");
  assert.equal(run.modelReasoningEffort, "xhigh");
  assert.equal(run.modelSelectionReason, "complex_task");
});
