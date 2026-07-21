import assert from "node:assert/strict";
import test from "node:test";
import {
  branchReuseSafetyReason,
  claimRuns,
  cloneFallbackSource,
  planRunnableRuns,
  resolveCodexBin,
  loadCodexSdk,
  sdkClientOptions,
  sdkThreadOptions,
} from "../src/runner.js";

test("Codex SDK resolves through its exported ESM entrypoint", async () => {
  const sdk = await loadCodexSdk();
  assert.equal(typeof sdk.Codex, "function");
});

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

test("stale running records do not block unrelated queued work", async () => {
  const state = fixtureState(
    {
      status: "in_progress",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
      createdAt: "2026-07-20T12:00:00.000Z",
    },
  );
  state.projects.push({
    id: "project_2",
    key: "other",
    name: "Other",
    repoPath: "/tmp/other",
  });
  state.runs.unshift({
    id: "run_stale",
    taskId: "task_other",
    projectId: "project_2",
    actionType: "start_builder",
    group: "builder",
    role: "builder",
    status: "running",
    startedAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
  });

  const input = {
    limit: 1,
    project: "demo",
    timeoutMs: 2 * 60 * 60 * 1000,
    nowMs: Date.parse("2026-07-20T15:00:00.000Z"),
  };
  const plan = planRunnableRuns(state, input);
  assert.equal(plan.activeCount, 0);
  assert.equal(plan.staleActiveCount, 1);
  assert.equal(plan.runnable[0].id, "run_1");

  const claimed = await claimRuns({ ...input, state });
  assert.equal(claimed[0].id, "run_1");
  assert.equal(state.runs.find((run) => run.id === "run_stale").status, "running");
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

test("SDK threads receive the configured model and reasoning effort", () => {
  assert.deepEqual(sdkThreadOptions({ project: { repoPath: "/tmp/demo" } }, {
    model: "gpt-5.6",
    modelReasoningEffort: "xhigh",
  }), {
    workingDirectory: "/tmp/demo",
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    model: "gpt-5.6",
    modelReasoningEffort: "xhigh",
  });
});

test("SDK client defaults to ChatGPT sign-in instead of API-key billing", () => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexKey = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.CODEX_API_KEY = "test-codex-key";
  try {
    const options = sdkClientOptions({ codexBin: "/tmp/codex" });
    assert.equal(options.codexPathOverride, "/tmp/codex");
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_API_KEY, undefined);
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodexKey;
  }
});

test("explicit Codex binary paths take precedence", () => {
  assert.equal(resolveCodexBin({ codexBin: "/tmp/custom-codex" }), "/tmp/custom-codex");
});
