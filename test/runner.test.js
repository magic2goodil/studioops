import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectFromConfig } from "../src/config.js";
import {
  activeRunStaleReason,
  applyFailedRunToTask,
  branchReuseSafetyReason,
  claimRuns,
  cloneFallbackSource,
  completeRun,
  completeRunAfterExecution,
  performGitHubRemoteRecoveryProbe,
  planRunnableRuns,
  preflightRun,
  prepareRunWorkspace,
  resolveProjectWorkflowMode,
  runGitHubRemoteRecoveryProbes,
  runWorkspaceCleanup,
  runQueuedRuns,
} from "../src/runner.js";
import { materializeLocalCandidate } from "../src/workspace.js";
import { eligibleRunWorkspaceSnapshotsInState } from "../src/store.js";

const execFileAsync = promisify(execFile);

test("authoritative provider usage blocks automatic retry when a run exceeds its token budget", async () => {
  const state = {
    projects: [{ id: "project_budget", key: "budget", workflowMode: "local" }],
    tasks: [{
      id: "task_budget",
      projectId: "project_budget",
      title: "Bounded run",
      status: "in_progress",
      assignedAgentRole: "builder",
    }],
    runs: [{
      id: "run_budget",
      taskId: "task_budget",
      projectId: "project_budget",
      group: "builder",
      role: "builder",
      actionType: "start_builder",
      status: "running",
      tokenBudget: 100,
      costBudget: 2,
      costTelemetry: { estimatedCredits: 1, tokenBudget: 100 },
    }],
    reviews: [], comments: [], events: [],
  };
  const run = await completeRun("run_budget", {
    state,
    status: "completed",
    usage: {
      input_tokens: 80,
      cached_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 10,
      actual_credits: 1.25,
    },
  });
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, "effective_token_budget_exceeded");
  assert.equal(run.costTelemetry.actualTokens, 110);
  assert.equal(run.costTelemetry.actualCredits, 1.25);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationBlocker.type, "budget");
  assert.equal(state.tasks[0].retryNotBefore, "");
});

test("over-budget GitHub builder completion preserves the exact review handoff and pauses continuation", async () => {
  const subjectSha = "a".repeat(40);
  const state = {
    projects: [{ id: "project_budget_builder", workflowMode: "github" }],
    tasks: [{ id: "task_budget_builder", projectId: "project_budget_builder", status: "in_progress", branchName: "codex/task-budget-builder", prUrl: "https://github.com/example/repo/pull/1", reviewSubjectSha: subjectSha, reviewSubjectCycle: 1 }],
    runs: [{ id: "run_budget_builder", taskId: "task_budget_builder", projectId: "project_budget_builder", group: "builder", role: "builder", actionType: "start_builder", status: "running", workflowMode: "github", tokenBudget: 100 }],
    reviews: [], comments: [], events: [],
  };

  const run = await completeRun("run_budget_builder", {
    state, status: "completed",
    usage: { input_tokens: 90, cached_input_tokens: 0, output_tokens: 30, actual_credits: 2 },
  });

  assert.equal(run.status, "completed");
  assert.equal(run.completionDisposition, "completed_over_budget");
  assert.equal(run.exitCode, "effective_token_budget_exceeded");
  assert.equal(state.tasks[0].status, "builder_review");
  assert.equal(state.tasks[0].reviewSubjectSha, subjectSha);
  assert.equal(state.tasks[0].budgetTelemetry.disposition, "handoff_preserved");
  assert.equal(state.tasks[0].budgetPause.resumeStatus, "builder_review");
});

test("over-budget completed architecture handoff preserves the governed graph", async () => {
  const state = {
    projects: [{ id: "project_budget_arch", workflowMode: "local" }],
    tasks: [{ id: "task_budget_arch", projectId: "project_budget_arch", status: "architecture_ready", architectureRequired: true, architectureStatus: "completed", architectureDecisionTaskIds: ["task_budget_child"] }, {
      id: "task_budget_child", projectId: "project_budget_arch", parentTaskId: "task_budget_arch", architectureParentTaskId: "task_budget_arch", architectureRequired: true, architectureStatus: "inherited", description: "Implement the governed architecture slice.", userStory: "As an owner, I need the architecture slice implemented.", expectedOutcome: "The governed implementation is ready for builder work.", acceptanceCriteria: ["The implementation is validated."], lane: "backend", workAreas: ["src/runner.js"], dependsOnTaskIds: [],
    }],
    runs: [{ id: "run_budget_arch", taskId: "task_budget_arch", projectId: "project_budget_arch", group: "architect", role: "systems-architect", actionType: "start_architecture", status: "running", tokenBudget: 100 }],
    reviews: [], comments: [], events: [],
  };

  const run = await completeRun("run_budget_arch", {
    state, status: "completed", usage: { input_tokens: 101, output_tokens: 1 },
  });

  assert.equal(run.status, "completed");
  assert.equal(run.completionDisposition, "completed_over_budget");
  assert.equal(state.tasks[0].architectureStatus, "completed");
  assert.deepEqual(state.tasks[0].architectureDecisionTaskIds, ["task_budget_child"]);
  assert.equal(state.tasks[0].budgetTelemetry.continuationStopped, true);
  assert.equal(state.tasks[1].budgetPause.runId, "run_budget_arch");
});

test("runner does not launch queued work for a task paused after preserving an over-budget handoff", () => {
  const state = {
    projects: [{ id: "project_budget_pause" }],
    tasks: [{ id: "task_budget_pause", projectId: "project_budget_pause", status: "builder_review", budgetPause: { runId: "run_old" } }],
    runs: [{ id: "run_next", taskId: "task_budget_pause", projectId: "project_budget_pause", group: "reviewer", status: "queued" }],
  };
  const report = planRunnableRuns(state, { limit: 1 });
  assert.deepEqual(report.runnable, []);
  assert.equal(report.skipped[0].reason, "budget_pause");
});

async function git(repoPath, args) {
  const result = await execFileAsync("git", args, { cwd: repoPath });
  return String(result.stdout || "").trim();
}

async function createRepository(root, options = {}) {
  const repoPath = path.join(root, options.name || "repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["checkout", "-b", options.defaultBranch || "main"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
  await git(repoPath, ["config", "user.email", "studioops@example.invalid"]);
  if (options.commit !== false) {
    await writeFile(path.join(repoPath, "README.md"), "test\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "Initial commit"]);
  }
  return repoPath;
}

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

test("runner starts queued same-project builders with explicit disjoint scopes", () => {
  const state = fixtureState(
    {
      id: "task_a",
      status: "queued",
      integrationStatus: "",
      assignedAgentRole: "builder",
      lane: "backend",
      workAreas: ["src/lifecycle/**"],
    },
    {
      id: "run_a",
      taskId: "task_a",
      actionType: "start_builder",
      status: "queued",
      integrationStatus: "",
      lane: "backend",
      fileScope: ["src/lifecycle/**"],
      fileScopeExplicit: true,
    },
  );
  state.tasks.push({
    id: "task_b",
    projectId: "project_1",
    title: "Retention",
    status: "queued",
    assignedAgentRole: "builder",
    lane: "backend",
    workAreas: ["src/retention/**"],
  });
  state.runs.push({
    ...state.runs[0],
    id: "run_b",
    taskId: "task_b",
    fileScope: ["src/retention/**"],
  });

  const report = planRunnableRuns(state, { limit: 2 });

  assert.deepEqual(report.runnable.map((run) => run.id), ["run_a", "run_b"]);
  assert.equal(report.skipped.length, 0);
});

test("runner serializes queued builders whose explicit scopes overlap", () => {
  const state = fixtureState(
    {
      id: "task_a",
      status: "queued",
      integrationStatus: "",
      assignedAgentRole: "builder",
      lane: "backend",
      workAreas: ["src/shared/**"],
    },
    {
      id: "run_a",
      taskId: "task_a",
      actionType: "start_builder",
      status: "queued",
      integrationStatus: "",
      lane: "backend",
      fileScope: ["src/shared/**"],
      fileScopeExplicit: true,
    },
  );
  state.tasks.push({
    id: "task_b",
    projectId: "project_1",
    title: "Shared child",
    status: "queued",
    assignedAgentRole: "builder",
    lane: "backend",
    workAreas: ["src/shared/child.js"],
  });
  state.runs.push({
    ...state.runs[0],
    id: "run_b",
    taskId: "task_b",
    fileScope: ["src/shared/child.js"],
  });

  const report = planRunnableRuns(state, { limit: 2 });

  assert.deepEqual(report.runnable.map((run) => run.id), ["run_a"]);
  assert.equal(report.skipped[0].reason, "lane_conflict:task_a");
});

test("runner claim is the transition from queued to in progress", async () => {
  const state = fixtureState(
    {
      status: "queued",
      integrationStatus: "",
      assignedAgentRole: "builder",
    },
    {
      actionType: "start_builder",
      integrationStatus: "",
    },
  );

  const claimed = await claimRuns({
    state,
    limit: 1,
    preflightRun: async () => ({
      ok: true,
      workflowMode: "local",
      originUrl: "",
      baseRef: "HEAD",
      baseCommit: "test-commit",
    }),
  });

  assert.equal(claimed.length, 1);
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.tasks[0].status, "in_progress");
});

test("an SDK infrastructure error fails over to codex-cli without waiting for owner repair", () => {
  const task = {
    id: "task_1",
    status: "in_progress",
    assignedAgentRole: "builder",
    automationAttemptEpoch: 0,
  };
  const run = {
    id: "run_1",
    actionType: "start_builder",
    group: "builder",
    role: "builder",
    provider: "codex-sdk",
    attempt: 1,
    maxAttempts: 2,
  };
  const now = "2026-07-21T12:00:00.000Z";

  const result = applyFailedRunToTask(task, run, "sdk_error", now);

  assert.equal(result.failedOver, true);
  assert.equal(task.preferredRunnerProvider, "codex-cli");
  assert.equal(task.status, "queued");
  assert.equal(task.automationAttemptEpoch, 1);
  assert.equal(task.automationFailover.from, "codex-sdk");
  assert.equal(task.automationFailover.to, "codex-cli");
  assert.ok(Date.parse(task.retryNotBefore) > Date.parse(now));
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

test("project workflow mode defaults to auto and only selects github for GitHub remotes", () => {
  assert.equal(projectFromConfig({ key: "demo", name: "Demo" }).workflowMode, "auto");
  assert.equal(resolveProjectWorkflowMode({ workflowMode: "auto" }, ""), "local");
  assert.equal(resolveProjectWorkflowMode({ workflowMode: "auto", repoUrl: "https://github.com/example/demo.git" }, ""), "github");
  assert.equal(resolveProjectWorkflowMode({ workflowMode: "auto" }, "git@github.com:example/demo.git"), "github");
  assert.equal(resolveProjectWorkflowMode({ workflowMode: "auto", repoUrl: "https://gitlab.com/example/demo.git" }, ""), "local");
  assert.equal(resolveProjectWorkflowMode({ workflowMode: "local", repoUrl: "https://github.com/example/demo.git" }, "git@github.com:example/demo.git"), "local");
});

test("local preflight never prepares GitHub auth and creates an isolated no-origin workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-runner-"));
  try {
    const repoPath = await createRepository(root);
    let authCalls = 0;
    const run = {
      ...builderRun({ branchName: "codex/demo-local" }),
      project: { key: "demo", repoPath, repoUrl: "", workflowMode: "auto", defaultBranch: "main" },
    };
    const preflight = await preflightRun(run, {
      prepareGitHubAppAuth: async () => {
        authCalls += 1;
        throw new Error("Local preflight must not prepare GitHub credentials.");
      },
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.workflowMode, "local");
    assert.equal(preflight.baseRef, "refs/heads/main");
    assert.equal(authCalls, 0);

    const workspaceRoot = path.join(root, "workspaces");
    const workspace = await prepareRunWorkspace({
      ...run,
      workflowMode: preflight.workflowMode,
      preflightBaseRef: preflight.baseRef,
      preflightBaseCommit: preflight.baseCommit,
    }, {
      workspaceRoot,
      persistRunWorkspace: async () => {},
    }, { write() {} });

    assert.equal(workspace.strategy, "local-clone");
    assert.equal(path.relative(workspaceRoot, workspace.workspacePath).startsWith(".."), false);
    assert.equal(await git(workspace.workspacePath, ["symbolic-ref", "--short", "HEAD"]), "codex/demo-local");
    assert.equal(await git(workspace.workspacePath, ["remote"]), "");
    assert.equal(await readFile(path.join(workspace.workspacePath, "README.md"), "utf8"), "test\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("systems architect preflight validates the source checkout without GitHub credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-architect-preflight-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["remote", "add", "origin", "https://github.com/example/demo.git"]);
    let authCalls = 0;
    const result = await preflightRun({
      id: "run_architect",
      group: "architect",
      role: "systems-architect",
      actionType: "start_architecture",
      project: {
        key: "demo",
        repoPath,
        repoUrl: "https://github.com/example/demo.git",
        workflowMode: "github",
        defaultBranch: "main",
      },
    }, {
      prepareGitHubAppAuth: async () => {
        authCalls += 1;
        throw new Error("Architect preflight must not prepare GitHub credentials.");
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.workflowMode, "local");
    assert.equal(result.originUrl, "https://github.com/example/demo.git");
    assert.equal(authCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local reviewer preflight binds the artifact to the run SHA and candidate cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-review-identity-"));
  try {
    const repoPath = await createRepository(root);
    await writeFile(path.join(repoPath, "candidate.txt"), "candidate\n", "utf8");
    await git(repoPath, ["add", "candidate.txt"]);
    await git(repoPath, ["commit", "-m", "Candidate"]);
    const identity = await materializeLocalCandidate({
      workspacePath: repoPath,
      root,
      branch: "codex/demo-task_1",
      taskId: "task_1",
      identity: { candidateCycle: 3 },
    });
    const run = {
      id: "run_review",
      taskId: "task_1",
      group: "reviewer",
      role: "backend-reviewer",
      actionType: "start_review",
      branchName: identity.branch,
      reviewSubjectSha: identity.commitSha,
      candidateCycle: identity.candidateCycle,
      candidateIdentity: identity,
      project: { key: "demo", repoPath, repoUrl: "", workflowMode: "local", defaultBranch: "main" },
    };

    assert.equal((await preflightRun(run, { workspaceRoot: root })).ok, true);
    const wrongSha = await preflightRun({ ...run, reviewSubjectSha: "f".repeat(40) }, { workspaceRoot: root });
    assert.equal(wrongSha.code, "local_candidate_identity_mismatch");
    const wrongCycle = await preflightRun({ ...run, candidateCycle: 4 }, { workspaceRoot: root });
    assert.equal(wrongCycle.code, "local_candidate_identity_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful local builder completion materializes under the configured workspace root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-builder-completion-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["checkout", "-b", "codex/demo-task_1"]);
    await writeFile(path.join(repoPath, "candidate.txt"), "candidate\n", "utf8");
    await git(repoPath, ["add", "candidate.txt"]);
    await git(repoPath, ["commit", "-m", "Candidate"]);
    const workspaceRoot = path.join(root, "configured-workspaces");
    const run = {
      id: "run_local_builder",
      taskId: "task_1",
      projectId: "project_1",
      group: "builder",
      role: "builder",
      actionType: "start_builder",
      status: "running",
      workflowMode: "local",
      branchName: "codex/demo-task_1",
      candidateCycle: 1,
      project: { id: "project_1", key: "demo", repoPath },
    };
    const state = {
      projects: [run.project],
      tasks: [{ id: "task_1", projectId: "project_1", status: "in_progress", branchName: run.branchName }],
      runs: [run],
      comments: [],
      events: [],
    };

    const completed = await completeRunAfterExecution(run, {
      status: "completed",
      exitCode: 0,
      state,
      workspaceRoot,
    }, run);

    assert.equal(completed.status, "completed");
    assert.equal(state.tasks[0].status, "builder_review");
    assert.equal(state.tasks[0].candidateIdentity.commitSha, await git(repoPath, ["rev-parse", "HEAD"]));
    assert.match(state.tasks[0].candidateIdentity.operationalLocalArtifactRef, /^candidates\/task_1\/1-/);
    assert.equal(
      await git(path.join(workspaceRoot, state.tasks[0].candidateIdentity.operationalLocalArtifactRef), ["rev-parse", `${state.tasks[0].candidateIdentity.commitSha}^{tree}`]),
      state.tasks[0].candidateIdentity.treeSha,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged local builder-fix trees preserve candidate and builder-review cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-builder-metadata-repair-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["checkout", "-b", "codex/demo-task_1"]);
    await writeFile(path.join(repoPath, "candidate.txt"), "candidate\n", "utf8");
    await git(repoPath, ["add", "candidate.txt"]);
    await git(repoPath, ["commit", "-m", "Candidate"]);
    const workspaceRoot = path.join(root, "configured-workspaces");
    const candidateIdentity = await materializeLocalCandidate({
      workspacePath: repoPath,
      root: workspaceRoot,
      branch: "codex/demo-task_1",
      taskId: "task_1",
      identity: { candidateCycle: 2 },
    });
    const run = {
      id: "run_local_builder_fix",
      taskId: "task_1",
      projectId: "project_1",
      group: "builder",
      role: "builder",
      actionType: "start_builder_fix",
      status: "running",
      workflowMode: "local",
      branchName: candidateIdentity.branch,
      candidateCycle: 2,
      reviewSubjectSha: candidateIdentity.commitSha,
      candidateIdentity,
      project: { id: "project_1", key: "demo", repoPath },
    };
    const state = {
      projects: [run.project],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        status: "in_progress",
        branchName: run.branchName,
        reviewCycle: 2,
        reviewSubjectCycle: 2,
        reviewSubjectSha: candidateIdentity.commitSha,
        candidateIdentity,
      }],
      runs: [run],
      comments: [],
      events: [],
    };

    const completed = await completeRunAfterExecution(run, {
      status: "completed",
      exitCode: 0,
      state,
      workspaceRoot,
    }, run);

    assert.equal(completed.status, "completed");
    assert.equal(state.tasks[0].status, "builder_review");
    assert.equal(state.tasks[0].reviewCycle, 2);
    assert.equal(state.tasks[0].reviewSubjectCycle, 2);
    assert.equal(state.tasks[0].candidateIdentity.candidateCycle, 2);
    assert.equal(state.tasks[0].candidateIdentity.commitSha, candidateIdentity.commitSha);
    assert.equal(state.tasks[0].candidateIdentity.operationalLocalArtifactRef, candidateIdentity.operationalLocalArtifactRef);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("github preflight validates credentials and remote access without using a real network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-github-runner-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["remote", "add", "origin", "https://github.com/example/demo.git"]);
    let authCalls = 0;
    let remoteCalls = 0;
    let cleanupCalls = 0;
    const result = await preflightRun({
      ...builderRun(),
      project: { key: "demo", repoPath, repoUrl: "", workflowMode: "auto", defaultBranch: "main" },
    }, {
      prepareGitHubAppAuth: async () => {
        authCalls += 1;
        return { token: "fake", askpassPath: "" };
      },
      checkGitHubRemote: async () => { remoteCalls += 1; },
      cleanupGitHubAppAuth: async () => { cleanupCalls += 1; },
    });

    assert.equal(result.ok, true);
    assert.equal(result.workflowMode, "github");
    assert.equal(authCalls, 1);
    assert.equal(remoteCalls, 1);
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("github preflight prefers verified inherited SSH and gh credentials over GitHub App auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-github-ssh-first-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["remote", "add", "origin", "git@github.com:example/demo.git"]);
    let inheritedCalls = 0;
    let appCalls = 0;
    const result = await preflightRun({
      ...builderRun(),
      project: { key: "demo", repoPath, workflowMode: "auto", defaultBranch: "main" },
    }, {
      checkInheritedGitHubCredentials: async () => { inheritedCalls += 1; },
      prepareGitHubAppAuth: async () => {
        appCalls += 1;
        throw new Error("GitHub App auth must not run after inherited SSH succeeds.");
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.workflowMode, "github");
    assert.equal(result.gitAuthStrategy, "inherited-ssh");
    assert.equal(inheritedCalls, 1);
    assert.equal(appCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("github preflight falls back to GitHub App auth when inherited SSH or gh access fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-github-app-fallback-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["remote", "add", "origin", "git@github.com:example/demo.git"]);
    let inheritedCalls = 0;
    let appCalls = 0;
    let remoteCalls = 0;
    const result = await preflightRun({
      ...builderRun(),
      project: { key: "demo", repoPath, workflowMode: "auto", defaultBranch: "main" },
    }, {
      checkInheritedGitHubCredentials: async () => {
        inheritedCalls += 1;
        throw new Error("No inherited access");
      },
      prepareGitHubAppAuth: async () => {
        appCalls += 1;
        return { token: "fake", askpassPath: "" };
      },
      checkGitHubRemote: async () => { remoteCalls += 1; },
      cleanupGitHubAppAuth: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.workflowMode, "github");
    assert.equal(result.gitAuthStrategy, "github-app");
    assert.equal(inheritedCalls, 1);
    assert.equal(appCalls, 1);
    assert.equal(remoteCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("github preflight reports the inherited SSH or gh failure when App fallback also fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-github-dual-auth-failure-"));
  try {
    const repoPath = await createRepository(root);
    await git(repoPath, ["remote", "add", "origin", "git@github.com:example/demo.git"]);
    const result = await preflightRun({
      ...builderRun(),
      project: { key: "demo", repoPath, workflowMode: "auto", defaultBranch: "main" },
    }, {
      checkInheritedGitHubCredentials: async () => {
        const error = new Error("spawn gh ENOENT");
        error.code = "ENOENT";
        throw error;
      },
      prepareGitHubAppAuth: async () => {
        throw new Error("GitHub App is not installed");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /Inherited SSH\/gh preflight failed first: spawn gh ENOENT/);
    assert.match(result.remediation, /installed worker PATH or inherited SSH\/gh authentication/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight reports actionable repository, local ref, origin, remote, and credential codes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-preflight-codes-"));
  try {
    const missing = await preflightRun({ project: {} });
    assert.equal(missing.code, "missing_repo_path");
    assert.ok(missing.remediation);

    const nonexistent = await preflightRun({ project: { repoPath: path.join(root, "missing") } });
    assert.equal(nonexistent.code, "repo_path_not_found");

    const plainPath = path.join(root, "plain");
    await mkdir(plainPath);
    const nonGit = await preflightRun({ project: { repoPath: plainPath } });
    assert.equal(nonGit.code, "not_git_repository");

    const emptyRepo = await createRepository(root, { name: "empty", commit: false });
    const noBase = await preflightRun({
      branchName: "codex/empty",
      project: { repoPath: emptyRepo, workflowMode: "local", defaultBranch: "main" },
    });
    assert.equal(noBase.code, "missing_local_base_ref");

    const githubRepo = await createRepository(root, { name: "github" });
    const noOrigin = await preflightRun({ project: { repoPath: githubRepo, workflowMode: "github" } });
    assert.equal(noOrigin.code, "missing_github_origin");

    await git(githubRepo, ["remote", "add", "origin", "https://github.com/example/demo.git"]);
    const inaccessible = await preflightRun({ project: { repoPath: githubRepo, workflowMode: "github" } }, {
      prepareGitHubAppAuth: async () => null,
      checkGitHubRemote: async () => { throw new Error("permission denied"); },
      cleanupGitHubAppAuth: async () => {},
    });
    assert.equal(inaccessible.code, "inaccessible_github_remote");

    const credentials = await preflightRun({ project: { repoPath: githubRepo, workflowMode: "github" } }, {
      prepareGitHubAppAuth: async () => { throw new Error("GitHub App credentials for builder were not found"); },
    });
    assert.equal(credentials.code, "missing_github_app_credentials");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claim preflight blocks configuration failures once without starting or retrying the run", async () => {
  const state = fixtureState({
    status: "in_progress",
    integrationStatus: "",
    assignedAgentRole: "builder",
  }, {
    actionType: "start_builder",
    integrationStatus: "",
    attempt: 1,
  });
  state.projects[0].repoPath = "/path/that/does/not/exist";

  assert.deepEqual(await claimRuns({ state, limit: 1 }), []);
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.runs[0].exitCode, "repo_path_not_found");
  assert.equal(state.runs[0].startedAt, undefined);
  assert.equal(state.runs[0].attempt, 1);
  assert.equal(state.runs[0].attemptKey, "");
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationBlocker.type, "configuration");
  assert.equal(state.comments.length, 1);

  assert.deepEqual(await claimRuns({ state, limit: 1 }), []);
  assert.equal(state.comments.length, 1);
});

test("an inaccessible GitHub preflight is retried once after an injectable delay", async () => {
  const state = fixtureState({
    status: "in_progress",
    integrationStatus: "",
    assignedAgentRole: "builder",
    branchName: "codex/demo-task",
  }, {
    actionType: "start_builder",
    integrationStatus: "",
    branchName: "codex/demo-task",
  });
  let checks = 0;
  const delays = [];

  const claimed = await claimRuns({
    state,
    limit: 1,
    preflightRetryDelayMs: 17,
    delay: async (ms) => { delays.push(ms); },
    preflightRun: async () => {
      checks += 1;
      if (checks === 1) {
        return {
          ok: false,
          code: "inaccessible_github_remote",
          message: "temporary network failure",
          remediation: "retry",
          owner: "example",
          repository: "demo",
          originUrl: "https://github.com/example/demo.git",
        };
      }
      return {
        ok: true,
        workflowMode: "github",
        originUrl: "https://github.com/example/demo.git",
      };
    },
  });

  assert.equal(checks, 2);
  assert.deepEqual(delays, [17]);
  assert.equal(claimed.length, 1);
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.tasks[0].automationBlocker, undefined);
});

test("two inaccessible GitHub preflights cancel before launch and schedule exact recovery", async () => {
  const state = fixtureState({
    status: "in_progress",
    integrationStatus: "",
    assignedAgentRole: "builder",
    branchName: "codex/demo-task",
    automationAttemptEpoch: 4,
  }, {
    actionType: "start_builder",
    integrationStatus: "",
    branchName: "codex/demo-task",
    attempt: 1,
    attemptKey: "task_1:builder:4",
  });
  state.projects[0].repoUrl = "https://github.com/Example/Demo.git";
  const failure = {
    ok: false,
    code: "inaccessible_github_remote",
    message: "The GitHub origin is not accessible: timed out",
    remediation: "Verify access.",
    owner: "Example",
    repository: "Demo",
    originUrl: state.projects[0].repoUrl,
  };

  assert.deepEqual(await claimRuns({
    state,
    limit: 1,
    preflightRetryDelayMs: 0,
    preflightRun: async () => failure,
  }), []);

  const probe = state.tasks[0].automationBlocker.recoveryProbe;
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.runs[0].attemptKey, "");
  assert.equal(state.runs[0].startedAt, undefined);
  assert.equal(state.tasks[0].automationAttemptEpoch, 4);
  assert.deepEqual({
    sourceRunId: probe.sourceRunId,
    projectId: probe.projectId,
    owner: probe.owner,
    repository: probe.repository,
    role: probe.role,
    actionType: probe.actionType,
    branchName: probe.branchName,
    prUrl: probe.prUrl,
    resumeStatus: probe.resumeStatus,
    probeCount: probe.probeCount,
  }, {
    sourceRunId: "run_1",
    projectId: "project_1",
    owner: "example",
    repository: "demo",
    role: "builder",
    actionType: "start_builder",
    branchName: "codex/demo-task",
    prUrl: "",
    resumeStatus: "queued",
    probeCount: 0,
  });
  assert.equal(Date.parse(probe.nextProbeAt) - Date.parse(probe.lastProbeAt || state.tasks[0].automationBlocker.blockedAt), 60_000);
  assert.equal(probe.lastCode, "inaccessible_github_remote");
  assert.equal(probe.lease, null);
});

test("periodic GitHub recovery failure then success restores state without a run or attempt mutation", async () => {
  const initialNow = Date.parse("2026-07-21T12:00:00.000Z");
  const state = fixtureState({
    status: "in_progress",
    integrationStatus: "",
    assignedAgentRole: "builder",
    branchName: "codex/demo-task",
    automationAttemptEpoch: 7,
  }, {
    actionType: "start_builder",
    integrationStatus: "",
    branchName: "codex/demo-task",
    attempt: 1,
  });
  state.projects[0].repoUrl = "https://github.com/example/demo.git";
  const failure = {
    ok: false,
    code: "inaccessible_github_remote",
    message: "temporary",
    remediation: "retry",
    owner: "example",
    repository: "demo",
    originUrl: state.projects[0].repoUrl,
  };
  await claimRuns({
    state,
    limit: 1,
    preflightRetryDelayMs: 0,
    preflightRun: async () => failure,
  });
  state.tasks[0].automationBlocker.blockedAt = new Date(initialNow).toISOString();
  state.tasks[0].automationBlocker.recoveryProbe.nextProbeAt = new Date(initialNow + 60_000).toISOString();
  const runCount = state.runs.length;
  const attempt = state.runs[0].attempt;

  const failed = await runGitHubRemoteRecoveryProbes({
    state,
    nowMs: initialNow + 60_000,
    performRecoveryProbe: async () => ({
      ok: false,
      probeable: true,
      code: "inaccessible_github_remote",
      diagnostic: "still unavailable",
    }),
  });
  assert.equal(failed[0].status, "waiting");
  assert.equal(state.tasks[0].automationBlocker.recoveryProbe.probeCount, 1);
  assert.equal(
    Date.parse(state.tasks[0].automationBlocker.recoveryProbe.nextProbeAt),
    initialNow + 3 * 60_000,
  );

  const recovered = await runGitHubRemoteRecoveryProbes({
    state,
    nowMs: initialNow + 3 * 60_000,
    performRecoveryProbe: async () => ({
      ok: true,
      code: "github_remote_recovery_verified",
      diagnostic: "verified",
    }),
  });
  assert.equal(recovered[0].status, "recovered");
  assert.equal(state.tasks[0].status, "queued");
  assert.equal(state.tasks[0].automationBlocker, undefined);
  assert.equal(state.tasks[0].automationAttemptEpoch, 7);
  assert.equal(state.runs.length, runCount);
  assert.equal(state.runs[0].attempt, attempt);
  assert.equal(state.comments.filter((comment) => /restored queued/.test(comment.body)).length, 1);
  assert.equal(state.events.filter((event) => event.type === "github_remote_recovery_verified").length, 1);
});

test("recovery probes do not delay ordinary claimed worker launch", async () => {
  const order = [];
  let finishProbe;
  const reportPromise = runQueuedRuns({
    state: { meta: {} },
    disk: { pressure: false },
    reconcileStaleRuns: async () => [],
    claimRuns: async () => [{ id: "run_ready", taskId: "task_1" }],
    runClaimedRun: async (run) => {
      order.push(`run:${run.id}`);
      return { ...run, status: "completed", exitCode: "" };
    },
    runGitHubRemoteRecoveryProbes: async () => {
      order.push("probe");
      return new Promise((resolve) => { finishProbe = resolve; });
    },
  });

  for (let attempt = 0; attempt < 100 && order.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(order, ["run:run_ready", "probe"]);
  finishProbe([{ taskId: "task_blocked", status: "waiting", code: "unavailable" }]);
  const report = await reportPromise;
  assert.deepEqual(report.claimed, ["run_ready"]);
  assert.equal(report.results[0].status, "completed");
  assert.equal(report.recoveryProbes[0].status, "waiting");
});

test("a completed recovery probe applies without waiting for a slower sibling", async () => {
  const claims = [
    { taskId: "task_fast", leaseId: "lease_fast" },
    { taskId: "task_slow", leaseId: "lease_slow" },
  ];
  let releaseSlowProbe;
  let fastApplied = false;
  const reportPromise = runGitHubRemoteRecoveryProbes({
    claimRecoveryProbes: async () => claims,
    performRecoveryProbe: async (claim) => {
      if (claim.taskId === "task_fast") {
        return { ok: true, code: "github_remote_recovery_verified" };
      }
      return new Promise((resolve) => { releaseSlowProbe = resolve; });
    },
    applyRecoveryProbeResult: async (claim) => {
      if (claim.taskId === "task_fast") fastApplied = true;
      return { applied: true, status: "recovered" };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fastApplied, true);
  releaseSlowProbe({ ok: false, probeable: true, code: "inaccessible_github_remote" });
  const results = await reportPromise;
  assert.deepEqual(results.map((result) => result.taskId), ["task_fast", "task_slow"]);
});

test("periodic recovery verifies exact repository branch and pull request head", async () => {
  const claim = {
    probe: {
      owner: "example",
      repository: "demo",
      role: "backend-reviewer",
      actionType: "start_review",
      branchName: "codex/demo-task",
      prUrl: "https://github.com/example/demo/pull/12",
    },
    sourceRun: {
      id: "run_1",
      group: "reviewer",
      role: "backend-reviewer",
      actionType: "start_review",
    },
    project: {
      repoPath: "/tmp/demo",
      workflowMode: "github",
    },
  };
  let preparedRole = "";
  const result = await performGitHubRemoteRecoveryProbe(claim, {
    prepareGitHubAppAuth: async (run) => {
      preparedRole = run.role;
      return { token: "secret-token" };
    },
    cleanupGitHubAppAuth: async () => {},
    preflightRun: async (run, input) => {
      await input.prepareGitHubAppAuth(run);
      return {
        ok: true,
        workflowMode: "github",
        originUrl: "git@github.com:example/demo.git",
      };
    },
    verifyRecoveryBranch: async () => ({ exists: true }),
    verifyRecoveryPr: async () => ({
      ok: true,
      pr: { state: "OPEN", headRefName: "codex/demo-task" },
    }),
  });

  assert.equal(preparedRole, "backend-reviewer");
  assert.equal(result.ok, true);

  const missingBranch = await performGitHubRemoteRecoveryProbe(claim, {
    preflightRun: async () => ({
      ok: true,
      workflowMode: "github",
      originUrl: "https://github.com/example/demo.git",
    }),
    cleanupGitHubAppAuth: async () => {},
    verifyRecoveryBranch: async () => ({ exists: false }),
  });
  assert.equal(missingBranch.probeable, false);
  assert.equal(missingBranch.code, "github_remote_recovery_branch_missing");

  const closedPr = await performGitHubRemoteRecoveryProbe(claim, {
    preflightRun: async () => ({
      ok: true,
      workflowMode: "github",
      originUrl: "https://github.com/example/demo.git",
    }),
    cleanupGitHubAppAuth: async () => {},
    verifyRecoveryBranch: async () => ({ exists: true }),
    verifyRecoveryPr: async () => ({
      ok: true,
      pr: { state: "CLOSED", headRefName: "codex/demo-task" },
    }),
  });
  assert.equal(closedPr.probeable, false);
  assert.equal(closedPr.code, "github_remote_recovery_pr_closed");

  const changedInaccessibleOrigin = await performGitHubRemoteRecoveryProbe(claim, {
    preflightRun: async () => ({
      ok: false,
      code: "inaccessible_github_remote",
      message: "The changed origin is inaccessible.",
      originUrl: "https://github.com/example/different-repository.git",
      owner: "example",
      repository: "different-repository",
    }),
    cleanupGitHubAppAuth: async () => {},
  });
  assert.equal(changedInaccessibleOrigin.probeable, false);
  assert.equal(
    changedInaccessibleOrigin.code,
    "github_remote_recovery_repository_changed",
  );
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

  const [run] = await claimRuns({
    state,
    limit: 1,
    modelReasoningEffort: "high",
    preflightRun: async () => ({ ok: true, workflowMode: "github", originUrl: "https://github.com/example/demo.git" }),
  });

  assert.equal(run.model, "gpt-5.6-sol");
  assert.equal(run.modelReasoningEffort, "xhigh");
  assert.equal(run.modelSelectionReason, "complex_task");
});

function cleanupDiskReader(reports) {
  let index = 0;
  return async ({ path: target }) => ({
    path: target,
    availableBytes: reports[Math.min(index, reports.length - 1)].availableBytes,
    totalBytes: 1_000_000,
    availablePercent: reports[Math.min(index++, reports.length - 1)].availablePercent,
    minAvailableBytes: 1,
    minAvailablePercent: 1,
    pressure: reports[Math.min(index - 1, reports.length - 1)].pressure,
  });
}

test("runner cleanup removes worktree, clone, and local-clone fixtures without touching the source", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-runner-cleanup-"));
  const root = await realpath(temporaryRoot);
  try {
    const sourceRepo = await createRepository(root, { name: "source" });
    const workspaceRoot = path.join(root, "workspaces");
    const projectRoot = path.join(workspaceRoot, "demo");
    const worktreePath = path.join(projectRoot, "run_worktree-cleanup-worktree");
    const clonePath = path.join(projectRoot, "run_clone-clone");
    const localClonePath = path.join(projectRoot, "run_local-local-clone");
    await mkdir(clonePath, { recursive: true });
    await mkdir(localClonePath, { recursive: true });
    await writeFile(path.join(clonePath, "payload"), "clone\n");
    await writeFile(path.join(localClonePath, "payload"), "local\n");
    await git(sourceRepo, ["worktree", "add", "-b", "cleanup-worktree", worktreePath, "main"]);
    const state = {
      meta: {},
      projects: [{ id: "project_1", key: "demo", repoPath: sourceRepo }],
      runs: [
        { id: "run_worktree", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "cleanup-worktree", workspaceStrategy: "worktree", workspacePath: worktreePath },
        { id: "run_clone", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "clone", workspaceStrategy: "clone", workspacePath: clonePath },
        { id: "run_local", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "local-clone", workspaceStrategy: "local-clone", workspacePath: localClonePath },
      ],
    };
    assert.equal(eligibleRunWorkspaceSnapshotsInState(state, {
      workspaceRoot,
      policy: { retainForHours: { failed: 1 } },
      nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    }).length, 3);
    const report = await runWorkspaceCleanup({
      state,
      workspaceRoot,
      dataPath: path.join(root, "data"),
      workspaceRetention: { retainForHours: { failed: 1 } },
      eligibleRunWorkspaceSnapshots: async (input) => eligibleRunWorkspaceSnapshotsInState(state, input),
      readDiskAvailability: cleanupDiskReader([
        { availableBytes: 100_000, availablePercent: 10, pressure: false },
      ]),
      git: async (args, options) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          await rm(args.at(-1), { recursive: true, force: true });
          return { stdout: "", stderr: "" };
        }
        return execFileAsync("git", args, options);
      },
      nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    });
    assert.equal(report.selectedCount, 3, JSON.stringify(report));
    assert.equal(report.failures.length, 0);
    for (const target of [worktreePath, clonePath, localClonePath]) {
      await assert.rejects(() => lstat(target), { code: "ENOENT" });
    }
    assert.equal(await git(sourceRepo, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.equal((await git(sourceRepo, ["worktree", "list", "--porcelain"])).split("worktree ").length - 1, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner cleanup preserves unsafe, unrecorded, candidate, and symlinked workspaces", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-runner-safety-"));
  const root = await realpath(temporaryRoot);
  try {
    const sourceRepo = await createRepository(root, { name: "source" });
    const workspaceRoot = path.join(root, "workspaces");
    const safePath = path.join(workspaceRoot, "demo", "run_safe-safe");
    const siblingPath = path.join(workspaceRoot, "demo", "unrecorded");
    const candidatePath = path.join(workspaceRoot, "candidates", "artifact");
    const outsidePath = path.join(root, "outside");
    const linkedPath = path.join(workspaceRoot, "demo", "run_linked-linked");
    await mkdir(safePath, { recursive: true });
    await mkdir(siblingPath, { recursive: true });
    await mkdir(candidatePath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(path.join(outsidePath, "keep"), "keep\n");
    await symlink(outsidePath, linkedPath);
    const state = {
      meta: {},
      projects: [{ id: "project_1", key: "demo", repoPath: sourceRepo }],
      runs: [
        { id: "run_safe", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "safe", workspaceStrategy: "clone", workspacePath: safePath },
        { id: "run_linked", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "linked", workspaceStrategy: "clone", workspacePath: linkedPath },
      ],
    };
    const report = await runWorkspaceCleanup({
      state,
      workspaceRoot,
      dataPath: path.join(root, "data"),
      workspaceRetention: { retainForHours: { failed: 1 } },
      eligibleRunWorkspaceSnapshots: async (input) => eligibleRunWorkspaceSnapshotsInState(state, input),
      readDiskAvailability: cleanupDiskReader([{ availableBytes: 100_000, availablePercent: 10, pressure: false }]),
      nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    });
    assert.equal(report.selectedCount, 1, JSON.stringify(report));
    await assert.rejects(() => lstat(safePath), { code: "ENOENT" });
    await lstat(siblingPath);
    await lstat(candidatePath);
    await lstat(linkedPath);
    await lstat(path.join(outsidePath, "keep"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner cleanup fails closed on a post-claim symlink swap, releases the lease, and is idempotent for missing targets", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-runner-race-"));
  const root = await realpath(temporaryRoot);
  try {
    const workspaceRoot = path.join(root, "workspaces");
    const target = path.join(workspaceRoot, "demo", "run_race-race");
    const outside = path.join(root, "outside");
    await mkdir(target, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep"), "keep\n");
    const run = { id: "run_race", projectId: "project_1", projectKey: "demo", status: "failed", completedAt: "2026-08-01T00:00:00.000Z", branchName: "race", workspaceStrategy: "clone", workspacePath: target };
    const state = { meta: {}, projects: [{ id: "project_1", key: "demo", repoPath: path.join(root, "source") }], runs: [run] };
    let released = null;
    const report = await runWorkspaceCleanup({
      state,
      workspaceRoot,
      dataPath: path.join(root, "data"),
      workspaceRetention: { retainForHours: { failed: 1 } },
      readDiskAvailability: cleanupDiskReader([{ availableBytes: 100_000, availablePercent: 10, pressure: false }]),
      eligibleRunWorkspaceSnapshots: async () => [{ runId: run.id, workspacePath: target }],
      claimRunWorkspaceCandidates: async () => {
        await rm(target, { recursive: true, force: true });
        await symlink(outside, target);
        return { leaseId: "lease_race", candidates: [{ ...run, workspaceCleanup: { state: "claimed", leaseId: "lease_race" } }] };
      },
      releaseRunWorkspaceCleanup: async (runId, input) => {
        released = { runId, ...input };
        return { state: "released" };
      },
    });
    assert.equal(report.selectedCount, 0);
    assert.equal(report.failures.length, 1);
    assert.equal(released.runId, run.id);
    assert.match(released.error, /symlink/);
    await lstat(path.join(outside, "keep"));
    await lstat(target);

    const missingRun = { ...run, id: "run_missing", workspacePath: path.join(workspaceRoot, "demo", "run_missing-missing") };
    const missing = await runWorkspaceCleanup({
      state,
      workspaceRoot,
      dataPath: path.join(root, "data"),
      workspaceRetention: { retainForHours: { failed: 1 } },
      readDiskAvailability: cleanupDiskReader([{ availableBytes: 100_000, availablePercent: 10, pressure: false }]),
      eligibleRunWorkspaceSnapshots: async () => [{ runId: missingRun.id, workspacePath: missingRun.workspacePath }],
      claimRunWorkspaceCandidates: async () => ({ leaseId: "lease_missing", candidates: [missingRun] }),
      finalizeRunWorkspaceCleanup: async () => ({ state: "completed" }),
    });
    assert.equal(missing.selectedCount, 1);
    assert.equal(missing.logicalDeletedBytes, 0);
    assert.equal(missing.failures.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner cleanup reports percent pressure, thresholds, and bounded policy exclusions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-runner-pressure-report-"));
  const root = await realpath(temporaryRoot);
  try {
    const workspaceRoot = path.join(root, "workspaces");
    const dataPath = path.join(root, "data");
    const oldPath = path.join(workspaceRoot, "demo", "run_old-old");
    await mkdir(oldPath, { recursive: true });
    await writeFile(path.join(oldPath, "payload"), "measured before cleanup\n");
    const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
    const state = {
      meta: {},
      projects: [{ id: "project_1", key: "demo", repoPath: path.join(root, "source") }],
      runs: [
        { id: "run_old", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "old", workspaceStrategy: "clone", workspacePath: oldPath, completedAt: new Date(nowMs - 48 * 3_600_000).toISOString() },
        { id: "run_young", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "young", workspaceStrategy: "clone", workspacePath: path.join(workspaceRoot, "demo", "run_young-young"), completedAt: new Date(nowMs - 1 * 3_600_000).toISOString() },
        { id: "run_active", projectId: "project_1", projectKey: "demo", status: "running", branchName: "active", workspaceStrategy: "clone", workspacePath: path.join(workspaceRoot, "demo", "run_active-active"), updatedAt: new Date(nowMs - 48 * 3_600_000).toISOString() },
        { id: "run_artifact", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "artifact", workspaceStrategy: "clone", workspacePath: path.join(workspaceRoot, "candidates", "run_artifact-artifact"), completedAt: new Date(nowMs - 48 * 3_600_000).toISOString() },
      ],
    };
    const percentPressure = async ({ path: target }) => ({
      path: target,
      availableBytes: 900_000,
      totalBytes: 1_000_000,
      availablePercent: 1,
      minAvailableBytes: 100,
      minAvailablePercent: 5,
      pressure: true,
    });

    const report = await runWorkspaceCleanup({
      state,
      workspaceRoot,
      dataPath,
      sameVolume: true,
      workspaceRetention: {
        retainForHours: { failed: 336 },
        pressureMinAgeHours: 24,
      },
      readDiskAvailability: percentPressure,
      nowMs,
    });

    assert.equal(report.selectedCount, 1, JSON.stringify(report));
    assert.equal(report.remainingShortfall.pressure, true);
    assert.equal(report.remainingShortfall.bytes, 0);
    assert.equal(report.remainingShortfall.percentPoints, 4);
    assert.equal(report.policy.thresholds.data.minAvailablePercent, 5);
    assert.equal(report.selection.selectedCount, 1);
    assert.equal(report.selection.excludedByReason.minimum_age_not_reached, 1);
    assert.equal(report.selection.excludedByReason.nonterminal_run, 1);
    assert.equal(report.selection.excludedByReason.protected_candidate_artifact_path, 1);
    assert.equal(report.skippedCount, 3);
    await assert.rejects(() => lstat(oldPath), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner claims after recoverable pressure cleanup but pauses for persistent pressure or disk recovery", async () => {
  const state = { meta: {}, projects: [], runs: [] };
  const resolvedReports = [
    { availableBytes: 1, availablePercent: 0.1, pressure: true },
    { availableBytes: 1, availablePercent: 0.1, pressure: true },
    { availableBytes: 100, availablePercent: 10, pressure: false },
    { availableBytes: 100, availablePercent: 10, pressure: false },
  ];
  let claims = 0;
  const resolved = await runQueuedRuns({
    state,
    workspaceRoot: "/tmp/workspaces",
    dataPath: "/tmp/data",
    workspaceRetention: { enabled: true },
    readDiskAvailability: cleanupDiskReader(resolvedReports),
    reconcileStaleRuns: async () => [],
    claimRuns: async () => { claims += 1; return []; },
    runGitHubRemoteRecoveryProbes: async () => [],
  });
  assert.equal(resolved.paused, undefined);
  assert.equal(claims, 1);

  const persistent = await runQueuedRuns({
    state,
    workspaceRoot: "/tmp/workspaces",
    dataPath: "/tmp/data",
    workspaceRetention: { enabled: true },
    disk: { availableBytes: 1, availablePercent: 0.1, minAvailableBytes: 100, minAvailablePercent: 2, pressure: true },
    reconcileStaleRuns: async () => [],
    claimRuns: async () => { throw new Error("claim must not run"); },
    runGitHubRemoteRecoveryProbes: async () => [],
  });
  assert.equal(persistent.paused, true);
  assert.equal(persistent.pauseReason, "disk_space_below_safety_threshold");

  const recoveryState = { ...state, meta: { diskRecovery: { state: "awaiting_watchdog_health" }, operatorPause: { active: true } } };
  const recovery = await runQueuedRuns({
    state: recoveryState,
    workspaceRoot: "/tmp/workspaces",
    dataPath: "/tmp/data",
    workspaceRetention: { enabled: true },
    disk: { availableBytes: 100, availablePercent: 10, minAvailableBytes: 1, minAvailablePercent: 1, pressure: false },
    reconcileStaleRuns: async () => [],
    claimRuns: async () => { throw new Error("claim must not run"); },
    runGitHubRemoteRecoveryProbes: async () => [],
  });
  assert.equal(recovery.pauseReason, "disk_recovery_awaiting_watchdog_health");
  assert.equal(recoveryState.meta.operatorPause.active, true);

  const incidentState = { ...state, meta: { diskPressureIncident: { id: "disk_incident_1", state: "awaiting_health", generation: 2 } } };
  const incident = await runQueuedRuns({
    state: incidentState,
    workspaceRoot: "/tmp/workspaces",
    dataPath: "/tmp/data",
    workspaceRetention: { enabled: true },
    disk: { availableBytes: 100, availablePercent: 10, minAvailableBytes: 1, minAvailablePercent: 1, pressure: false },
    reconcileStaleRuns: async () => [],
    claimRuns: async () => { throw new Error("claim must not run"); },
    runGitHubRemoteRecoveryProbes: async () => [],
  });
  assert.equal(incident.paused, true);
  assert.equal(incident.pauseReason, "disk_recovery_in_progress");
});
