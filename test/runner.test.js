import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectFromConfig } from "../src/config.js";
import {
  activeRunStaleReason,
  branchReuseSafetyReason,
  claimRuns,
  cloneFallbackSource,
  planRunnableRuns,
  preflightRun,
  prepareRunWorkspace,
  resolveProjectWorkflowMode,
} from "../src/runner.js";

const execFileAsync = promisify(execFile);

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
