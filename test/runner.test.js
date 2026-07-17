import assert from "node:assert/strict";
import test from "node:test";
import { branchReuseSafetyReason, planRunnableRuns } from "../src/runner.js";

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
