import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_RESTART_AGENT_LABELS, runSelfUpdate } from "../src/self-update.js";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env || {}),
    },
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function git(repoPath, args) {
  const result = await run("git", args, { cwd: repoPath });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function emptyState(runs = []) {
  return {
    meta: {},
    projects: [],
    tasks: [],
    comments: [],
    events: [],
    reviews: [],
    runs,
  };
}

async function configureRepo(repoPath) {
  await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
}

async function commitFile(repoPath, fileName, body, message) {
  await writeFile(path.join(repoPath, fileName), body, "utf8");
  await git(repoPath, ["add", fileName]);
  await git(repoPath, ["commit", "-m", message]);
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-self-update-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const writerPath = path.join(root, "writer");

  await git(root, ["init", "--bare", remotePath]);
  await git(root, ["clone", remotePath, repoPath]);
  await configureRepo(repoPath);
  await git(repoPath, ["checkout", "-b", "main"]);
  await commitFile(repoPath, "app.txt", "base\n", "base");
  await git(repoPath, ["push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);

  await git(root, ["clone", remotePath, writerPath]);
  await configureRepo(writerPath);

  return { root, remotePath, repoPath, writerPath };
}

test("clean self-update dry-run detects origin/main ahead and live run fast-forwards", async () => {
  const fixture = await createFixture();
  try {
    const before = await git(fixture.repoPath, ["rev-parse", "main"]);
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);
    const remote = await git(fixture.remotePath, ["rev-parse", "refs/heads/main"]);

    const dryRun = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(dryRun.status, "ready");
    assert.equal(dryRun.localCommit, before);
    assert.equal(dryRun.remoteCommit, remote);
    assert.equal(dryRun.remoteAhead, 1);
    assert.deepEqual(dryRun.restartAgentLabels, DEFAULT_RESTART_AGENT_LABELS);
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), before);

    const applyState = emptyState();
    const applied = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: applyState,
      deployRuntime: false,
      restartAgents: false,
      record: false,
      notify: false,
    });

    assert.equal(applied.status, "updated");
    assert.equal(applied.previousCommit, before);
    assert.equal(applied.currentCommit, remote);
    assert.ok(applied.selfUpdateLease.id);
    assert.equal(applyState.meta.selfUpdateLease, undefined);
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), remote);
    assert.equal(applied.restartResults.length, DEFAULT_RESTART_AGENT_LABELS.length);
    assert.equal(applied.restartResults[0].status, "skipped");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update refuses to run while another self-update lease is active", async () => {
  const fixture = await createFixture();
  try {
    const before = await git(fixture.repoPath, ["rev-parse", "main"]);
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);

    const state = emptyState();
    state.meta.selfUpdateLease = {
      id: "lease_1",
      startedAt: "2026-07-17T21:00:00.000Z",
      expiresAt: "2026-07-17T21:10:00.000Z",
      repoPath: fixture.repoPath,
      branch: "main",
      remoteRef: "origin/main",
    };

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state,
      restartAgents: false,
      record: false,
      notify: false,
      nowMs: Date.parse("2026-07-17T21:01:00.000Z"),
    });

    assert.equal(report.status, "blocked_self_update_in_progress");
    assert.equal(report.selfUpdateLease.id, "lease_1");
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update refuses dirty working trees when origin/main is ahead", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);
    await writeFile(path.join(fixture.repoPath, "local.txt"), "dirty\n", "utf8");

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "blocked_dirty");
    assert.match(report.reason, /Working tree/);
    assert.ok(report.dirtyFiles.some((file) => file.includes("local.txt")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update refuses fresh active builder or reviewer runs", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState([
        {
          id: "run_1",
          taskId: "task_1",
          group: "builder",
          role: "builder",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      ]),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "blocked_active_runs");
    assert.equal(report.activeRunBlockers.length, 1);
    assert.equal(report.activeRunBlockers[0].id, "run_1");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update ignores stale running builder or reviewer runs", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState([
        {
          id: "run_1",
          taskId: "task_1",
          group: "reviewer",
          role: "lead-reviewer",
          status: "running",
          startedAt: "2026-07-17T00:00:00.000Z",
        },
      ]),
      nowMs: Date.parse("2026-07-17T04:00:00.000Z"),
      staleRunMs: 60 * 60 * 1000,
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "ready");
    assert.equal(report.activeRunBlockers.length, 0);
    assert.equal(report.staleActiveRuns.length, 1);
    assert.match(report.staleActiveRuns[0].staleReason, /started_at_stale/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update refuses non-fast-forward local main", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "remote.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);
    await commitFile(fixture.repoPath, "local.txt", "local\n", "local update");

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "blocked_non_fast_forward");
    assert.equal(report.localAhead, 1);
    assert.equal(report.remoteAhead, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
