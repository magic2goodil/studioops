import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyActiveWorkflowClaims,
  DEFAULT_RESTART_AGENT_LABELS,
  runSelfUpdate,
} from "../src/self-update.js";

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

function runtimeVerification(commit, valid = true) {
  return {
    runtime: { commit },
    provenance: { valid },
  };
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

test("self-update publishes a stale runtime when source main already matches origin", async () => {
  const fixture = await createFixture();
  try {
    const sourceCommit = await git(fixture.repoPath, ["rev-parse", "main"]);
    const staleRuntimeCommit = "1".repeat(40);
    const dryRun = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      runtimeVerification: runtimeVerification(staleRuntimeCommit),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(dryRun.status, "ready");
    assert.equal(dryRun.sourceUpdateAvailable, false);
    assert.equal(dryRun.runtimeUpdateAvailable, true);
    assert.equal(dryRun.runtimeCommit, staleRuntimeCommit);
    assert.match(dryRun.reason, /does not match local source/);

    const deployments = [];
    const applied = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      runtimeVerification: runtimeVerification(staleRuntimeCommit),
      deployRuntimeFn: async (input) => {
        deployments.push(input);
        return { releasePath: `/runtime/releases/${sourceCommit}` };
      },
      restartAgents: false,
      record: false,
      notify: false,
    });

    assert.equal(applied.status, "updated");
    assert.equal(applied.sourceUpdateAvailable, false);
    assert.equal(applied.currentCommit, sourceCommit);
    assert.equal(deployments.length, 1);
    assert.equal(deployments[0].sourceRoot, fixture.repoPath);
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), sourceCommit);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update repairs invalid runtime provenance and no-ops for an aligned verified runtime", async () => {
  const fixture = await createFixture();
  try {
    const sourceCommit = await git(fixture.repoPath, ["rev-parse", "main"]);
    const invalid = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      runtimeVerification: runtimeVerification(sourceCommit, false),
      dryRun: true,
      record: false,
      notify: false,
    });
    assert.equal(invalid.status, "ready");
    assert.equal(invalid.runtimeUpdateAvailable, true);
    assert.match(invalid.runtimeReason, /invalid provenance/);

    const aligned = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState(),
      runtimeVerification: runtimeVerification(sourceCommit),
      dryRun: true,
      record: false,
      notify: false,
    });
    assert.equal(aligned.status, "up_to_date");
    assert.equal(aligned.sourceUpdateAvailable, false);
    assert.equal(aligned.runtimeUpdateAvailable, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime-only repair remains blocked while a fresh builder is active", async () => {
  const fixture = await createFixture();
  try {
    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state: emptyState([{
        id: "run_1",
        taskId: "task_1",
        group: "builder",
        role: "builder",
        status: "running",
        startedAt: new Date().toISOString(),
      }]),
      runtimeVerification: runtimeVerification("2".repeat(40)),
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "blocked_active_runs");
    assert.equal(report.sourceUpdateAvailable, false);
    assert.equal(report.runtimeUpdateAvailable, true);
    assert.equal(report.activeRunBlockers[0].id, "run_1");
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

test("self-update defers while bounded QA integration or promotion claims are active", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);
    const before = await git(fixture.repoPath, ["rev-parse", "main"]);
    const nowMs = Date.parse("2026-07-17T21:00:00.000Z");
    const state = emptyState();
    state.meta.promotionAttemptClaims = {
      candidate_1: {
        status: "active",
        claimId: "private-promotion-claim",
        authorityDigest: "sha256:private",
        projectId: "project_1",
        candidateId: "candidate_1",
        fence: 4,
        acquiredAt: "2026-07-17T20:58:00.000Z",
        renewedAt: "2026-07-17T20:59:00.000Z",
        expiresAt: "2026-07-17T21:30:00.000Z",
      },
    };
    state.meta.qaIntegrationAttemptClaims = {
      project_2: {
        status: "active",
        claimId: "private-qa-claim",
        authorityDigest: "sha256:also-private",
        projectId: "project_2",
        fence: 2,
        acquiredAt: "2026-07-17T20:57:00.000Z",
        renewedAt: "2026-07-17T20:59:30.000Z",
        expiresAt: "2026-07-17T21:15:00.000Z",
      },
    };

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state,
      nowMs,
      dryRun: true,
      record: false,
      notify: false,
    });

    assert.equal(report.status, "blocked_active_workflow_claims");
    assert.equal(report.activeWorkflowClaimBlockers.length, 2);
    assert.deepEqual(report.activeWorkflowClaimBlockers.map((item) => item.kind), [
      "qa_integration",
      "promotion",
    ]);
    assert.equal(report.activeWorkflowClaimBlockers[0].resourceId, "project_2");
    assert.equal(report.activeWorkflowClaimBlockers[1].candidateId, "candidate_1");
    assert.doesNotMatch(JSON.stringify(report.activeWorkflowClaimBlockers), /private|authorityDigest|claimId/);
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("self-update lease acquisition rechecks workflow claims that arrive after planning", async () => {
  const fixture = await createFixture();
  try {
    await commitFile(fixture.writerPath, "app.txt", "remote\n", "remote update");
    await git(fixture.writerPath, ["push", "origin", "main"]);
    const before = await git(fixture.repoPath, ["rev-parse", "main"]);
    const nowMs = Date.parse("2026-07-17T21:00:00.000Z");
    const state = emptyState();

    const report = await runSelfUpdate({
      repoPath: fixture.repoPath,
      state,
      nowMs,
      restartAgents: false,
      record: false,
      notify: false,
      beforeSelfUpdateLease() {
        state.meta.qaIntegrationAttemptClaims = {
          project_1: {
            status: "active",
            projectId: "project_1",
            fence: 1,
            acquiredAt: "2026-07-17T20:59:00.000Z",
            renewedAt: "2026-07-17T20:59:00.000Z",
            expiresAt: "2026-07-17T21:10:00.000Z",
          },
        };
      },
    });

    assert.equal(report.status, "blocked_active_workflow_claims");
    assert.equal(report.activeWorkflowClaimBlockers[0].kind, "qa_integration");
    assert.equal(state.meta.selfUpdateLease, undefined);
    assert.equal(await git(fixture.repoPath, ["rev-parse", "main"]), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("terminal, expired, and malformed workflow claims do not block self-update", () => {
  const state = emptyState();
  state.meta.promotionAttemptClaims = {
    candidate_expired: {
      status: "active",
      projectId: "project_1",
      candidateId: "candidate_expired",
      expiresAt: "2026-07-17T20:59:59.999Z",
    },
    candidate_terminal: {
      status: "terminal",
      projectId: "project_1",
      candidateId: "candidate_terminal",
      expiresAt: "2026-07-17T21:30:00.000Z",
    },
  };
  state.meta.qaIntegrationAttemptClaims = {
    project_malformed: {
      status: "active",
      projectId: "project_malformed",
      expiresAt: "not-a-time",
    },
  };

  assert.deepEqual(classifyActiveWorkflowClaims(state, {
    nowMs: Date.parse("2026-07-17T21:00:00.000Z"),
  }), { blocking: [] });
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
