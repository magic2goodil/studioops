import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compactOperationalHistory, maintenanceWriteBlocker } from "../src/state-database.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { createCandidateEnvelope, manifestDigest } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { readPersistedState } from "./state-database-helper.js";
import {
  claimRunWorkspaceCandidatesInState,
  eligibleRunWorkspaceSnapshotsInState,
  finalizeRunWorkspaceCleanupInState,
  releaseRunWorkspaceCleanupInState,
  workspacePathProtectionReason,
} from "../src/store.js";

const execFileAsync = promisify(execFile);
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const stateDatabaseModuleUrl = pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href;
const candidateManifestModuleUrl = pathToFileURL(path.join(process.cwd(), "src/candidate-manifest.js")).href;
const candidateRepositoryModuleUrl = pathToFileURL(path.join(process.cwd(), "src/candidate-repository.js")).href;
const promotionAttemptClaimModuleUrl = pathToFileURL(path.join(process.cwd(), "src/promotion-attempt-claim.js")).href;
const promotionAuthorityHarnessModuleUrl = pathToFileURL(
  path.join(process.cwd(), "test/support/promotion-authority-harness.js"),
).href;
const TEST_WORKSPACE_ROOT = path.join(os.tmpdir(), "studioops-run-workspaces");
const TEST_SOURCE_ROOT = path.join(os.tmpdir(), "studioops-source");

test("maintenance lease blocks non-owner writes until it expires", () => {
  const state = {
    meta: {
      selfUpdateLease: {
        id: "lease_1",
        ownerPid: "100",
        expiresAt: "2026-07-22T22:00:00.000Z",
      },
    },
  };
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "200",
  })?.id, "lease_1");
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "100",
  }), null);
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T22:00:01.000Z"),
    ownerPid: "200",
  }), null);
});

function baseState() {
  return {
    meta: { source: "legacy" },
    projects: [{ id: "project_1", key: "demo", name: "Demo" }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Persist me", status: "ready" }],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [],
  };
}

test("terminal run retention preserves configured attempt-budget evidence", () => {
  const state = baseState();
  state.runs = Array.from({ length: 7 }, (_, index) => ({
    id: `run_budget_${index + 1}`,
    taskId: "task_1",
    actionType: "start_builder",
    role: "builder",
    status: "failed",
    maxAttempts: 5,
  }));

  const archived = compactOperationalHistory(state);
  assert.equal(state.runs.length, 6);
  assert.equal(archived.runs.length, 1);
  assert.equal(state.runs.every((run) => run.maxAttempts === 5), true);
});

test("workspace retention eligibility is age bounded, ordered, and protects active or unsafe paths", () => {
  const root = TEST_WORKSPACE_ROOT;
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [
    { id: "run_old", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "feature/old", workspaceStrategy: "worktree", workspacePath: `${root}/demo/run_old-feature-old`, completedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", workspaceBytes: 2 },
    { id: "run_new", projectId: "project_1", projectKey: "demo", status: "completed", branchName: "feature/new", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_new-feature-new`, completedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", workspaceBytes: 1 },
    { id: "run_active", projectId: "project_1", projectKey: "demo", status: "running", branchName: "feature/active", workspaceStrategy: "worktree", workspacePath: `${root}/demo/run_active-feature-active`, updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "run_artifact", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "feature/artifact", workspaceStrategy: "clone", workspacePath: `${root}/demo/candidates/run_artifact-feature-artifact`, completedAt: "2026-08-01T00:00:00.000Z" },
  ];
  const candidates = eligibleRunWorkspaceSnapshotsInState(state, {
    workspaceRoot: root,
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    policy: { retainForHours: { completed: 1, failed: 1, cancelled: 1 } },
  });
  assert.deepEqual(candidates.map((item) => item.runId), ["run_old", "run_new"]);
  assert.equal(workspacePathProtectionReason(state.runs[3], { workspaceRoot: root, project: state.projects[0] }), "candidate_artifact_path");
});

test("workspace retention applies exact normal and pressure age boundaries", () => {
  const root = TEST_WORKSPACE_ROOT;
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [
    { id: "run_boundary", projectId: "project_1", projectKey: "demo", status: "completed", branchName: "boundary", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_boundary-boundary`, completedAt: new Date(nowMs - 168 * 3_600_000).toISOString() },
    { id: "run_too_young", projectId: "project_1", projectKey: "demo", status: "completed", branchName: "too-young", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_too_young-too-young`, completedAt: new Date(nowMs - 168 * 3_600_000 + 1).toISOString() },
  ];
  assert.deepEqual(eligibleRunWorkspaceSnapshotsInState(state, { workspaceRoot: root, nowMs }).map((item) => item.runId), ["run_boundary"]);

  const pressureState = baseState();
  pressureState.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  pressureState.runs = [
    { id: "run_pressure_boundary", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "pressure-boundary", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_pressure_boundary-pressure-boundary`, completedAt: new Date(nowMs - 24 * 3_600_000).toISOString() },
    { id: "run_pressure_young", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "pressure-young", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_pressure_young-pressure-young`, completedAt: new Date(nowMs - 24 * 3_600_000 + 1).toISOString() },
  ];
  assert.deepEqual(eligibleRunWorkspaceSnapshotsInState(pressureState, {
    workspaceRoot: root,
    nowMs,
    pressure: true,
    verifiedWorkspaceBytes: { run_pressure_boundary: 1, run_pressure_young: 1 },
  }).map((item) => item.runId), ["run_pressure_boundary"]);
});

test("pressure discovery measures safe old workspaces before the verified deletion claim", () => {
  const root = TEST_WORKSPACE_ROOT;
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [{
    id: "run_unmeasured",
    projectId: "project_1",
    projectKey: "demo",
    status: "failed",
    branchName: "unmeasured",
    workspaceStrategy: "clone",
    workspacePath: `${root}/demo/run_unmeasured-unmeasured`,
    completedAt: new Date(nowMs - 48 * 3_600_000).toISOString(),
  }];
  const policy = { retainForHours: { failed: 336 }, pressureMinAgeHours: 24 };

  const discovery = eligibleRunWorkspaceSnapshotsInState(state, {
    workspaceRoot: root,
    nowMs,
    pressure: true,
    policy,
    includeUnverifiedPressureCandidates: true,
  });
  assert.deepEqual(discovery.map((item) => item.runId), ["run_unmeasured"]);
  assert.equal(discovery[0].discoveryOnly, true);

  const unverifiedClaim = claimRunWorkspaceCandidatesInState(state, {
    workspaceRoot: root,
    nowMs,
    pressure: true,
    policy,
    leaseId: "unverified",
  });
  assert.deepEqual(unverifiedClaim.candidates, []);
  assert.equal(unverifiedClaim.selectionReport.excludedByReason.unverified_workspace_size, 1);

  const verifiedClaim = claimRunWorkspaceCandidatesInState(state, {
    workspaceRoot: root,
    nowMs,
    pressure: true,
    policy,
    verifiedWorkspaceBytes: { run_unmeasured: 42 },
    leaseId: "verified",
  });
  assert.deepEqual(verifiedClaim.candidates.map((run) => run.id), ["run_unmeasured"]);
});

test("workspace retention protects roots, sources, unknown strategies, active references, and symlinked ancestors", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-retention-paths-"));
  const root = await realpath(temporaryRoot);
  try {
    const project = { id: "project_1", key: "demo", repoPath: path.join(root, "demo", "run_source-source") };
    const safeRun = { id: "run_safe", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "safe", workspaceStrategy: "clone", workspacePath: path.join(root, "demo", "run_safe-safe"), completedAt: "2026-08-01T00:00:00.000Z" };
    assert.equal(workspacePathProtectionReason({ ...safeRun, workspacePath: root }, { workspaceRoot: root, project }), "outside_workspace_root");
    assert.equal(workspacePathProtectionReason({ ...safeRun, workspacePath: path.join(root, "demo") }, { workspaceRoot: root, project }), "source_repository_path");
    assert.equal(workspacePathProtectionReason({ ...safeRun, id: "run_source", branchName: "source", workspacePath: project.repoPath }, { workspaceRoot: root, project }), "source_repository_path");
    assert.equal(workspacePathProtectionReason({ ...safeRun, workspaceStrategy: "source-checkout" }, { workspaceRoot: root, project }), "unexpected_workspace_strategy");

    await mkdir(path.join(root, "outside"), { recursive: true });
    await mkdir(path.join(root, "demo"), { recursive: true });
    await symlink(path.join(root, "outside"), path.join(root, "demo", "linked"));
    const linked = { ...safeRun, id: "linked", branchName: "workspace", workspacePath: path.join(root, "demo", "linked", "linked-workspace") };
    assert.equal(workspacePathProtectionReason(linked, { workspaceRoot: root, project }), "symlinked_workspace_ancestor");

    const state = baseState();
    state.projects[0] = project;
    state.runs = [
      safeRun,
      { ...safeRun, id: "run_active", status: "running", branchName: "active", workspacePath: "", executionRepoPath: safeRun.workspacePath },
    ];
    assert.deepEqual(eligibleRunWorkspaceSnapshotsInState(state, {
      workspaceRoot: root,
      nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
      policy: { retainForHours: { failed: 1 } },
    }), []);

    await mkdir(safeRun.workspacePath, { recursive: true });
    const activeAlias = path.join(root, "active-workspace-alias");
    await symlink(safeRun.workspacePath, activeAlias);
    state.runs = [
      safeRun,
      { ...safeRun, id: "run_active_alias", status: "running", branchName: "active-alias", workspacePath: "", executionRepoPath: activeAlias },
    ];
    assert.deepEqual(eligibleRunWorkspaceSnapshotsInState(state, {
      workspaceRoot: root,
      nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
      policy: { retainForHours: { failed: 1 } },
    }), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workspace cleanup leases are exclusive, expire for retry, and finalize idempotently", () => {
  const root = TEST_WORKSPACE_ROOT;
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [{ id: "run_lease", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "feature/lease", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_lease-feature-lease`, completedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", workspaceBytes: 42 }];
  const input = { workspaceRoot: root, nowMs: Date.parse("2026-08-17T00:00:00.000Z"), policy: { retainForHours: { failed: 1 } }, verifiedWorkspaceBytes: { run_lease: 42 }, leaseId: "lease_a" };
  const first = claimRunWorkspaceCandidatesInState(state, input);
  const second = claimRunWorkspaceCandidatesInState(state, { ...input, leaseId: "lease_b" });
  assert.deepEqual(first.candidates.map((run) => run.id), ["run_lease"]);
  assert.deepEqual(second.candidates, []);
  const retry = claimRunWorkspaceCandidatesInState(state, { ...input, nowMs: input.nowMs + 900_001, leaseId: "lease_b" });
  assert.deepEqual(retry.candidates.map((run) => run.id), ["run_lease"]);
  assert.equal(finalizeRunWorkspaceCleanupInState(state, "run_lease", { leaseId: "lease_a", nowMs: input.nowMs + 900_002 }), null);
  assert.equal(finalizeRunWorkspaceCleanupInState(state, "run_lease", { leaseId: "lease_b", nowMs: input.nowMs + 900_002, logicalBytes: 42, filesystemReclaimedBytes: 40, success: true }).state, "completed");
  assert.equal(finalizeRunWorkspaceCleanupInState(state, "run_lease", { leaseId: "lease_b", nowMs: input.nowMs + 900_002 }).state, "completed");
  assert.equal(releaseRunWorkspaceCleanupInState(state, "run_lease", { leaseId: "lease_b" }).state, "completed");
});

test("workspace cleanup refuses malformed persisted lease expiries", () => {
  const state = baseState();
  state.runs = [{
    id: "run_malformed_lease",
    status: "failed",
    workspaceCleanup: { state: "claimed", leaseId: "lease_malformed", leaseExpiresAt: "not-a-timestamp" },
  }];

  assert.equal(finalizeRunWorkspaceCleanupInState(state, "run_malformed_lease", {
    leaseId: "lease_malformed",
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
  }), null);
  assert.equal(state.runs[0].workspaceCleanup.state, "claimed");
});

test("workspace capacity pressure uses only verified sizes and preserves failed cleanup evidence", () => {
  const root = TEST_WORKSPACE_ROOT;
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [
    { id: "run_verified", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "feature/verified", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_verified-feature-verified`, completedAt: "2026-08-15T00:00:00.000Z" },
    { id: "run_unverified", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "feature/unverified", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_unverified-feature-unverified`, completedAt: "2026-08-15T00:00:00.000Z", workspaceBytes: 999999 },
  ];
  const input = {
    workspaceRoot: root,
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    policy: { retainForHours: { failed: 336 }, maxRetainedBytes: 10, pressureMinAgeHours: 24 },
    verifiedWorkspaceBytes: { run_verified: 20 },
  };
  const candidates = eligibleRunWorkspaceSnapshotsInState(state, input);
  assert.deepEqual(candidates.map((item) => item.runId), ["run_verified"]);
  assert.equal(candidates[0].logicalBytes, 20);
  const claim = claimRunWorkspaceCandidatesInState(state, { ...input, leaseId: "lease_failed" });
  const released = releaseRunWorkspaceCleanupInState(state, "run_verified", {
    leaseId: claim.leaseId,
    now: "2026-08-17T00:01:00.000Z",
    logicalBytes: 20,
    filesystemReclaimedBytes: 18,
    reason: "disk_pressure",
    error: "line one\nline two\u0000 token=ghp_1234567890abcdef",
  });
  assert.equal(released.state, "released");
  assert.equal(released.runId, "run_verified");
  assert.equal(released.strategy, "clone");
  assert.equal(released.logicalBytes, 20);
  assert.equal(released.filesystemReclaimedBytes, 18);
  assert.equal(released.reason, "disk_pressure");
  assert.equal(released.error, "line one line two token=[REDACTED]");
});

test("pressure cleanup claims oldest terminal workspaces first with stable run-ID ties", () => {
  const root = TEST_WORKSPACE_ROOT;
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [
    { id: "run_new_large", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "new-large", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_new_large-new-large`, completedAt: "2026-08-15T00:00:00.000Z" },
    { id: "run_old_b", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "old-b", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_old_b-old-b`, completedAt: "2026-08-14T00:00:00.000Z" },
    { id: "run_old_a", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "old-a", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_old_a-old-a`, completedAt: "2026-08-14T00:00:00.000Z" },
  ];
  const input = {
    workspaceRoot: root,
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    pressure: true,
    policy: { pressureMinAgeHours: 24, maxDeletesPerSweep: 2 },
    verifiedWorkspaceBytes: { run_new_large: 10_000, run_old_b: 5, run_old_a: 10 },
    leaseId: "oldest-first",
  };

  assert.deepEqual(
    eligibleRunWorkspaceSnapshotsInState(state, input).map((item) => item.runId),
    ["run_old_a", "run_old_b", "run_new_large"],
  );
  assert.deepEqual(
    claimRunWorkspaceCandidatesInState(state, input).candidates.map((run) => run.id),
    ["run_old_a", "run_old_b"],
  );
});

test("completed cleanup evidence no longer contributes to retained-byte pressure", () => {
  const root = TEST_WORKSPACE_ROOT;
  const state = baseState();
  state.projects[0].repoPath = path.join(TEST_SOURCE_ROOT, "demo");
  state.runs = [
    { id: "run_cleaned", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "cleaned", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_cleaned-cleaned`, completedAt: "2026-08-01T00:00:00.000Z", workspaceCleanup: { state: "completed", logicalBytes: 20 } },
    { id: "run_retained", projectId: "project_1", projectKey: "demo", status: "failed", branchName: "retained", workspaceStrategy: "clone", workspacePath: `${root}/demo/run_retained-retained`, completedAt: "2026-08-15T00:00:00.000Z" },
  ];
  const input = {
    workspaceRoot: root,
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
    policy: { retainForHours: { failed: 336 }, maxRetainedBytes: 25, pressureMinAgeHours: 24 },
    verifiedWorkspaceBytes: { run_cleaned: 20, run_retained: 20 },
  };
  assert.deepEqual(eligibleRunWorkspaceSnapshotsInState(state, input), []);
  const sweep = claimRunWorkspaceCandidatesInState(state, { ...input, leaseId: "lease_next" });
  assert.deepEqual(sweep.candidates, []);
  assert.equal(state.meta.workspaceRetention.verifiedRetainedBytes, 20);
});

async function writeLegacyState(root, state = baseState()) {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runStoreScript(root, source, options = {}) {
  const env = await environmentForTestControlRoot(root);
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: { ...env, ...(options.env || {}) },
    timeout: 30_000,
  });
}

function mutatePersistedMeta(root, mutator) {
  const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"));
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
    const meta = JSON.parse(row.payload || "{}");
    mutator(meta);
    db.prepare(`
      UPDATE state_meta
      SET payload = ?, version = version + 1, updated_at = ?
      WHERE singleton_id = 1
    `).run(JSON.stringify(meta), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

test("full-state writes cannot rewrite or delete review history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-review-full-write-"));
  try {
    const state = baseState();
    state.reviews = [{
      id: "review_1",
      taskId: "task_1",
      outcome: "approved",
      author: "Backend reviewer",
      subjectSha: "a".repeat(40),
      createdAt: "2026-08-17T00:00:00.000Z",
    }];
    await writeLegacyState(root, state);
    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      await readState();
    `);

    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.reviews[0].outcome = "changes_requested";
        await writeState(state);
      `),
      /Review review_1 history is immutable/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.reviews = [];
        await writeState(state);
      `),
      /Review review_1 cannot be deleted/,
    );

    assert.equal(readPersistedState(root).reviews[0].outcome, "approved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite cleanup claims are exclusive across processes and terminal runs cannot reactivate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-retention-concurrency-"));
  const workspaceRoot = path.join(root, "run-workspaces");
  try {
    const state = baseState();
    state.projects[0].repoPath = path.join(root, "source", "demo");
    state.runs = [{
      id: "run_terminal",
      projectId: "project_1",
      projectKey: "demo",
      status: "failed",
      branchName: "terminal",
      workspaceStrategy: "clone",
      workspacePath: path.join(workspaceRoot, "demo", "run_terminal-terminal"),
      completedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }];
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const claims = await Promise.all(["lease_a", "lease_b"].map((leaseId) => runStoreScript(root, `
      import { claimRunWorkspaceCandidates } from ${JSON.stringify(storeModuleUrl)};
      const claim = await claimRunWorkspaceCandidates({
        workspaceRoot: ${JSON.stringify(workspaceRoot)},
        nowMs: ${Date.parse("2026-08-17T00:00:00.000Z")},
        policy: { retainForHours: { failed: 1 } },
        verifiedWorkspaceBytes: { run_terminal: 1 },
        leaseId: ${JSON.stringify(leaseId)}
      });
      console.log(JSON.stringify(claim.candidates.map((run) => run.id)));
    `)));
    assert.deepEqual(claims.map((result) => JSON.parse(result.stdout.trim())).sort((a, b) => a.length - b.length), [[], ["run_terminal"]]);
    assert.equal(readPersistedState(root).runs[0].workspaceCleanup.state, "claimed");

    await assert.rejects(
      () => runStoreScript(root, `
        import { updateRun } from ${JSON.stringify(storeModuleUrl)};
        await updateRun("run_terminal", { status: "running" });
      `),
      /terminal run cannot transition back to active/,
    );
    assert.equal(readPersistedState(root).runs[0].status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite migrates legacy state once and protects persisted PII at rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-migration-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      const state = await readState();
      console.log(JSON.stringify(state));
    `);

    const state = readPersistedState(root);
    assert.equal(state.projects[0].key, "demo");
    assert.equal(state.tasks[0].title, "Persist me");
    assert.equal(state.meta.storageBackend, "sqlite");
    assert.match(state.meta.migratedFrom, /mission-control\.json$/);
    assert.equal(state.meta.stateIntegrityVersion, 6);
    assert.equal(state.meta.lifecycleMigration.schemaVersion, 1);
    assert.equal(state.meta.lifecycleMigration.backupVerified, true);
    assert.equal(state.tasks[0].stateVersion, 1);

    const dataMode = (await stat(path.join(root, "data"))).mode & 0o777;
    const databaseMode = (await stat(path.join(root, "data", "mission-control.sqlite3"))).mode & 0o777;
    const legacyMode = (await stat(path.join(root, "data", "mission-control.json"))).mode & 0o777;
    assert.equal(dataMode, 0o700);
    assert.equal(databaseMode, 0o600);
    assert.equal(legacyMode, 0o600);
    assert.equal((await stat(state.meta.lifecycleMigration.backupPath)).mode & 0o777, 0o600);

    const migratedDb = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      assert.equal(migratedDb.prepare("SELECT state_version FROM tasks WHERE id = 'task_1'").get().state_version, 1);
      assert.equal(migratedDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      migratedDb.close();
    }

    const backupPath = path.join(root, "backups", "snapshot.sqlite3");
    await runStoreScript(root, `
      import { backupStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      await backupStateDatabase(${JSON.stringify(backupPath)});
    `);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integrity v6 quarantines active legacy candidates that reference invalidated reviews", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-invalidated-review-migration-"));
  try {
    const invalidatedAt = "2026-08-24T21:38:03.807Z";
    const candidate = createCandidateEnvelope({
      qaBundleId: "qa_bundle_legacy_review",
      createdAt: "2026-08-20T12:00:00.000Z",
      manifest: {
        candidateId: "candidate_legacy_review",
        projectId: "project_1",
        base: { branch: "main", sha: "a".repeat(40) },
        sources: [{
          taskId: "task_1",
          sourceRef: "refs/heads/codex/task-1",
          headSha: "b".repeat(40),
          candidateCycle: 1,
          reviews: [{
            id: "review_legacy_invalidated",
            stageKey: "lead",
            role: "lead-reviewer",
            outcome: "approved",
            subjectSha: "b".repeat(40),
            candidateCycle: 1,
            reviewedAt: "2026-08-20T11:00:00.000Z",
          }],
        }],
        integration: { branch: "qa/legacy-review", sha: "c".repeat(40) },
        checks: [{
          id: "check_legacy_review",
          kind: "local-validation",
          name: "npm test",
          outcome: "passed",
          subjectSha: "c".repeat(40),
          evidenceDigest: `sha256:${"d".repeat(64)}`,
        }],
        preview: {
          url: "http://127.0.0.1:4174/",
          status: "healthy",
          commitSha: "c".repeat(40),
          verifiedAt: "2026-08-20T12:00:00.000Z",
          attestation: { kind: "json", key: "commitSha", observedSha: "c".repeat(40) },
        },
        assembly: {
          mode: "atomic",
          requestedTaskIds: ["task_1"],
          includedTaskIds: ["task_1"],
          excludedTaskIds: [],
        },
      },
    });
    const taskEvidence = { preserved: true, digest: `sha256:${"e".repeat(64)}` };
    const state = baseState();
    Object.assign(state.tasks[0], {
      status: "done",
      stateVersion: 9,
      candidateId: candidate.id,
      qaBundleId: candidate.qaBundleId,
      candidateManifestDigest: candidate.manifestDigest,
      integrationCommit: candidate.manifest.integration.sha,
      terminalEvidence: taskEvidence,
    });
    state.reviews = [{
      id: "review_legacy_invalidated",
      taskId: "task_1",
      stageKey: "lead",
      role: "lead-reviewer",
      outcome: "approved",
      subjectSha: "b".repeat(40),
      candidateCycle: 1,
      reviewedAt: "2026-08-20T11:00:00.000Z",
      createdAt: "2026-08-20T11:00:00.000Z",
      invalidatedAt,
      invalidation: { action: "owner_override", reasonCode: "owner_override", invalidatedAt },
    }];
    state.qaBundles = [{
      id: candidate.qaBundleId,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationBranch: candidate.manifest.integration.branch,
      integrationCommit: candidate.manifest.integration.sha,
      previewUrl: candidate.manifest.preview.url,
      status: "ready",
      tasks: [{ id: "task_1", title: state.tasks[0].title }],
    }];
    state.candidates = [candidate];
    const historicalPacket = buildOwnerQaPacket(state, candidate, {
      bundle: state.qaBundles[0],
      generatedAt: "2026-08-20T12:00:01.000Z",
    });
    candidate.qaPacket = historicalPacket;
    state.qaBundles[0].qaPacket = historicalPacket;
    state.qaBundles[0].packetDigest = historicalPacket.packetDigest;
    // Version-5 history compaction removed summaries after authority had been
    // revoked. Integrity v6 must quarantine the active envelope without
    // attempting to reactivate or rewrite that historical packet.
    state.qaBundles[0].tasks = [];
    await writeLegacyState(root, state);

    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    let persisted = readPersistedState(root);
    const quarantined = persisted.candidates[0];
    assert.equal(persisted.meta.stateIntegrityVersion, 6);
    assert.equal(quarantined.status, "invalidated");
    assert.deepEqual(quarantined.invalidation, {
      reason: `Integrity migration quarantined candidate ${candidate.id} because source review review_legacy_invalidated was already invalidated.`,
      expected: "review:review_legacy_invalidated:valid",
      observed: "review:review_legacy_invalidated:invalidated:owner_override",
      observedAt: invalidatedAt,
    });
    assert.equal(quarantined.updatedAt, invalidatedAt);
    assert.equal(persisted.qaBundles[0].status, "invalidated");
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_1"]);
    assert.deepEqual(persisted.candidates[0].qaPacket, historicalPacket);
    assert.deepEqual(persisted.qaBundles[0].qaPacket, historicalPacket);
    assert.equal(persisted.qaBundles[0].updatedAt, invalidatedAt);
    assert.equal(persisted.tasks[0].status, "done");
    assert.deepEqual(persisted.tasks[0].terminalEvidence, taskEvidence);
    assert.equal(persisted.tasks[0].candidateId, candidate.id);
    assert.deepEqual(persisted.meta.candidateReviewIntegrityQuarantine.candidateIds, [candidate.id]);

    const firstCandidate = structuredClone(quarantined);
    const firstTask = structuredClone(persisted.tasks[0]);

    // Reproduce the version-5 production shape: authority was already
    // invalidated, then history compaction removed the bundle summaries.
    const databasePath = path.join(root, "data", "mission-control.sqlite3");
    const legacyDb = new DatabaseSync(databasePath);
    try {
      const bundleRow = legacyDb.prepare("SELECT payload FROM qa_bundles WHERE id = ?")
        .get(candidate.qaBundleId);
      const compactedBundle = JSON.parse(bundleRow.payload);
      compactedBundle.tasks = [];
      legacyDb.prepare("UPDATE qa_bundles SET payload = ? WHERE id = ?")
        .run(JSON.stringify(compactedBundle), candidate.qaBundleId);
      const metaRow = legacyDb.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
      const legacyMeta = JSON.parse(metaRow.payload);
      legacyMeta.stateIntegrityVersion = 5;
      legacyDb.prepare("UPDATE state_meta SET payload = ? WHERE singleton_id = 1")
        .run(JSON.stringify(legacyMeta));
    } finally {
      legacyDb.close();
    }

    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    persisted = readPersistedState(root);
    assert.deepEqual(persisted.candidates[0], firstCandidate);
    assert.deepEqual(persisted.tasks[0], firstTask);
    assert.deepEqual(persisted.qaBundles[0].tasks, []);
    assert.deepEqual(persisted.qaBundles[0].qaPacket, historicalPacket);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task aggregate versions change only for lifecycle or evidence mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-task-version-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { readState, updateTask } from ${JSON.stringify(storeModuleUrl)};
      await readState();
      await updateTask("task_1", { labels: ["metadata-only"] });
      await updateTask("task_1", { impactEvidence: { changedFiles: ["src/store.js"], impact: ["backend"] } });
    `);
    const state = readPersistedState(root);
    assert.equal(state.tasks[0].stateVersion, 2);
    assert.deepEqual(state.tasks[0].labels, ["metadata-only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle integrity migration upgrades an existing v4 database once from a verified pre-migration backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-lifecycle-migration-replay-"));
  try {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, "mission-control.sqlite3");
    const legacyDb = new DatabaseSync(databasePath);
    try {
      legacyDb.exec(`
        CREATE TABLE state_meta (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          assigned_role TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL
        );
      `);
      const state = baseState();
      state.meta.stateIntegrityVersion = 4;
      legacyDb.prepare("INSERT INTO state_meta VALUES (1, ?, 1, ?)")
        .run(JSON.stringify(state.meta), "2026-08-17T00:00:00.000Z");
      legacyDb.prepare("INSERT INTO tasks VALUES (?, 0, ?, ?, '', '', ?)")
        .run("task_1", "project_1", "ready", JSON.stringify(state.tasks[0]));
    } finally {
      legacyDb.close();
    }

    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    let persisted = readPersistedState(root);
    assert.equal(persisted.meta.stateIntegrityVersion, 6);
    assert.equal(persisted.meta.lifecycleMigration.schemaVersion, 1);
    assert.equal(persisted.tasks[0].stateVersion, 1);
    const backupPath = persisted.meta.lifecycleMigration.backupPath;
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backupDb.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "state_version"), false);
      assert.equal(backupDb.prepare("SELECT count(*) count FROM tasks").get().count, 1);
    } finally {
      backupDb.close();
    }
    const backupsBeforeReplay = await readdir(path.join(dataDir, "backups"));
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].stateVersion, 1);
    assert.deepEqual(await readdir(path.join(dataDir, "backups")), backupsBeforeReplay);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle schema migration repairs a version-5 database that lacks the lifecycle column", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-lifecycle-version-collision-"));
  try {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, "mission-control.sqlite3");
    const legacyDb = new DatabaseSync(databasePath);
    try {
      legacyDb.exec(`
        CREATE TABLE state_meta (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          assigned_role TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL
        );
      `);
      const state = baseState();
      state.meta.stateIntegrityVersion = 5;
      legacyDb.prepare("INSERT INTO state_meta VALUES (1, ?, 1, ?)")
        .run(JSON.stringify(state.meta), "2026-08-17T00:00:00.000Z");
      legacyDb.prepare("INSERT INTO tasks VALUES (?, 0, ?, ?, '', '', ?)")
        .run("task_1", "project_1", "ready", JSON.stringify(state.tasks[0]));
    } finally {
      legacyDb.close();
    }

    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const persisted = readPersistedState(root);
    assert.equal(persisted.meta.stateIntegrityVersion, 6);
    assert.equal(persisted.meta.lifecycleMigration.schemaVersion, 1);
    assert.equal(persisted.meta.lifecycleMigration.backupVerified, true);
    assert.equal(persisted.tasks[0].stateVersion, 1);

    const migratedDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(migratedDb.prepare("SELECT state_version FROM tasks WHERE id = 'task_1'").get().state_version, 1);
      assert.equal(
        migratedDb.prepare("PRAGMA index_list(tasks)").all().some((index) => index.name === "idx_tasks_state_version"),
        true,
      );
      assert.equal(migratedDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      migratedDb.close();
    }

    const backupDb = new DatabaseSync(persisted.meta.lifecycleMigration.backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "state_version"), false);
      assert.equal(backupDb.prepare("SELECT count(*) count FROM tasks").get().count, 1);
    } finally {
      backupDb.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compare-and-swap lifecycle commands serialize and reject stale replay without mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-lifecycle-cas-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const source = `
      import { transitionTask } from ${JSON.stringify(storeModuleUrl)};
      await transitionTask({
        action: "close_task",
        taskId: "task_1",
        expectedStateVersion: 1,
        actorContext: { actorId: "owner-local", actorType: "owner", role: "owner", trusted: true },
        evidence: { targetStatus: "closed" },
      });
    `;
    const results = await Promise.allSettled([runStoreScript(root, source), runStoreScript(root, source)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = results.find((result) => result.status === "rejected");
    assert.match(`${rejection.reason.stderr}\n${rejection.reason.message}`, /Stale lifecycle command/);
    const state = readPersistedState(root);
    assert.equal(state.tasks[0].status, "closed");
    assert.equal(state.tasks[0].stateVersion, 2);
    assert.equal(state.events.filter((event) => event.type === "lifecycle_transition").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent worker processes serialize updates without dropping comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-concurrency-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    await Promise.all(Array.from({ length: 6 }, (_, index) => runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      await addComment("task_1", "worker-${index}", "Concurrency test");
    `)));

    const state = readPersistedState(root);
    const bodies = state.comments.map((comment) => comment.body).sort();
    assert.deepEqual(bodies, ["worker-0", "worker-1", "worker-2", "worker-3", "worker-4", "worker-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slow mutation preparation does not hold the SQLite write lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-short-lock-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const slowMutation = runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        state.meta.slowMutationCompleted = true;
      }, { operationName: "test.slow_prepare", idempotent: true });
    `);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    await runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      await addComment("task_1", "fast writer", "Contention test");
    `);
    const elapsedMs = Date.now() - startedAt;
    await slowMutation;

    assert.ok(elapsedMs < 600, `fast writer waited ${elapsedMs}ms behind mutation preparation`);
    const state = readPersistedState(root);
    assert.equal(state.meta.slowMutationCompleted, true);
    assert.equal(state.comments.some((comment) => comment.body === "fast writer"), true);
    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const timing = db.prepare(`
        SELECT wait_ms, duration_ms
        FROM database_contention_events
        WHERE operation_name = 'test.slow_prepare'
        ORDER BY created_at DESC
        LIMIT 1
      `).get();
      assert.ok(Number(timing.duration_ms) >= 700);
      assert.ok(Number(timing.wait_ms) < 600, `lock wait incorrectly included ${timing.wait_ms}ms of preparation`);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-idempotent mutations fail closed instead of replaying after a version conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-non-idempotent-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const nonIdempotent = runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        state.meta.mustNotReplay = true;
      }, { operationName: "test.non_idempotent", idempotent: false });
    `);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      await addComment("task_1", "wins conflict", "Contention test");
    `);
    await assert.rejects(nonIdempotent, /state changed during test\.non_idempotent/);

    const state = readPersistedState(root);
    assert.equal(state.meta.mustNotReplay, undefined);
    assert.equal(state.comments.some((comment) => comment.body === "wins conflict"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database contention health is bounded and omits mutation payload data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-contention-health-"));
  try {
    await writeLegacyState(root);
    const { stdout } = await runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      import { databaseContentionHealth } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      await addComment("task_1", "private comment body", "Health test");
      process.stdout.write(JSON.stringify(await databaseContentionHealth()));
    `);
    const health = JSON.parse(stdout);
    assert.equal(health.operationCount >= 1, true);
    assert.equal(Array.isArray(health.recent), true);
    assert.equal(JSON.stringify(health).includes("private comment body"), false);
    assert.equal(health.recent.length <= 20, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatcher runner watchdog notifier and QA writers preserve every concurrent update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-worker-stress-"));
  const workers = ["dispatcher", "runner", "watchdog", "notifier", "qa"];
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    await Promise.all(workers.flatMap((worker) => Array.from({ length: 4 }, (_, index) => runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, ${5 + index * 3}));
        state.meta.workerCounters = state.meta.workerCounters || {};
        state.meta.workerCounters[${JSON.stringify(worker)}] = Number(state.meta.workerCounters[${JSON.stringify(worker)}] || 0) + 1;
      }, { operationName: ${JSON.stringify(`${worker}.stress`)}, idempotent: true, maxBusyRetries: 8 });
    `))));

    const state = readPersistedState(root);
    assert.deepEqual(state.meta.workerCounters, Object.fromEntries(workers.map((worker) => [worker, 4])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy JSON bootstrap rejects candidate authority and cannot be enabled after module import", async () => {
  const variants = [
    ["status", "qa_passed"],
    ["qaDecision", { forged: true }],
    ["promotion", { forged: true }],
    ["promotionMerge", { forged: true }],
    ["promotionValidationRecoveryReceipt", { forged: true }],
  ];
  for (const [field, value] of variants) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-authority-bootstrap-"));
    try {
      const candidate = createCandidateEnvelope({
        qaBundleId: `qa_bundle_bootstrap_${field}`,
        createdAt: "2026-07-25T12:00:00.000Z",
        manifest: {
          candidateId: `candidate_bootstrap_${field}`,
          projectId: "project_1",
          base: { branch: "main", sha: "a".repeat(40) },
          sources: [{
            taskId: "task_1",
            sourceRef: "refs/heads/codex/task-1",
            headSha: "b".repeat(40),
            candidateCycle: 1,
            reviews: [{
              id: "review_bootstrap_1",
              stageKey: "lead",
              role: "lead-reviewer",
              outcome: "approved",
              subjectSha: "b".repeat(40),
              candidateCycle: 1,
              reviewedAt: "2026-07-25T11:00:00.000Z",
            }],
          }],
          integration: { branch: "qa/bootstrap", sha: "c".repeat(40) },
          checks: [{
            id: "check_bootstrap_1",
            kind: "local-validation",
            name: "npm test",
            outcome: "passed",
            subjectSha: "c".repeat(40),
            evidenceDigest: `sha256:${"d".repeat(64)}`,
          }],
          preview: {
            url: "http://127.0.0.1:4174/",
            status: "healthy",
            commitSha: "c".repeat(40),
            verifiedAt: "2026-07-25T12:00:00.000Z",
            attestation: { kind: "json", key: "commitSha", observedSha: "c".repeat(40) },
          },
          assembly: {
            mode: "atomic",
            requestedTaskIds: ["task_1"],
            includedTaskIds: ["task_1"],
            excludedTaskIds: [],
          },
        },
      });
      candidate[field] = structuredClone(value);
      await writeLegacyState(root, { ...baseState(), candidates: [candidate] });
      await assert.rejects(
        () => runStoreScript(root, `
          import { readState } from ${JSON.stringify(storeModuleUrl)};
          process.env.STUDIOOPS_TEST_TRUST_LEGACY_AUTHORITY_BOOTSTRAP = "1";
          await readState();
        `),
        /must begin in exactly frozen status|cannot begin with QA, promotion, or merge authority|cannot begin with promotion validation authority/,
        `legacy ${field} authority must be rejected`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("trusted fixture bootstrap cannot follow a post-import test-realm pivot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-trusted-bootstrap-realm-"));
  const pivotRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-trusted-bootstrap-pivot-"));
  try {
    const candidate = createCandidateEnvelope({
      qaBundleId: "qa_bundle_trusted_bootstrap",
      createdAt: "2026-07-25T12:00:00.000Z",
      manifest: {
        candidateId: "candidate_trusted_bootstrap",
        projectId: "project_1",
        base: { branch: "main", sha: "a".repeat(40) },
        sources: [{
          taskId: "task_1",
          sourceRef: "refs/heads/codex/task-1",
          headSha: "b".repeat(40),
          candidateCycle: 1,
          reviews: [{
            id: "review_trusted_bootstrap",
            stageKey: "lead",
            role: "lead-reviewer",
            outcome: "approved",
            subjectSha: "b".repeat(40),
            candidateCycle: 1,
            reviewedAt: "2026-07-25T11:00:00.000Z",
          }],
        }],
        integration: { branch: "qa/trusted-bootstrap", sha: "c".repeat(40) },
        checks: [{
          id: "check_trusted_bootstrap",
          kind: "local-validation",
          name: "npm test",
          outcome: "passed",
          subjectSha: "c".repeat(40),
          evidenceDigest: `sha256:${"d".repeat(64)}`,
        }],
        preview: {
          url: "http://127.0.0.1:4174/",
          status: "healthy",
          commitSha: "c".repeat(40),
          verifiedAt: "2026-07-25T12:00:00.000Z",
          attestation: { kind: "json", key: "commitSha", observedSha: "c".repeat(40) },
        },
        assembly: {
          mode: "atomic",
          requestedTaskIds: ["task_1"],
          includedTaskIds: ["task_1"],
          excludedTaskIds: [],
        },
      },
    });
    candidate.status = "qa_passed";
    await writeLegacyState(root, { ...baseState(), candidates: [candidate] });
    const pivotEnv = await environmentForTestControlRoot(pivotRoot);
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState } from ${JSON.stringify(storeModuleUrl)};
        Object.assign(process.env, ${JSON.stringify(pivotEnv)});
        await readState();
      `, {
        env: { STUDIOOPS_TEST_TRUST_LEGACY_AUTHORITY_BOOTSTRAP: "1" },
      }),
      /no longer matches its boot realm|could not re-attest its boot realm|filesystem identity changed/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(pivotRoot, { recursive: true, force: true });
  }
});

test("SQLite rejects mutation of a frozen candidate manifest and rolls back atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-candidate-immutability-"));
  const sourceSha = "a".repeat(40);
  const integrationSha = "b".repeat(40);
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_immutable",
    createdAt: "2026-07-25T12:00:00.000Z",
    manifest: {
      candidateId: "candidate_immutable",
      projectId: "project_1",
      base: { branch: "main", sha: "c".repeat(40) },
      sources: [{
        taskId: "task_1",
        sourceRef: "refs/heads/codex/task-1",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T11:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-immutable", sha: integrationSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T12:00:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_1"],
        includedTaskIds: ["task_1"],
        excludedTaskIds: [],
      },
    },
  });
  const grantedAuthorityFields = [
    "qaDecision",
    "promotion",
    "promotionMerge",
    "promotionValidationRecoveryReceipt",
  ];
  const prepopulatedAuthorityCandidates = Object.fromEntries(grantedAuthorityFields.map((field, index) => {
    const id = `candidate_prepopulated_${index + 1}`;
    const seeded = createCandidateEnvelope({
      qaBundleId: `qa_bundle_prepopulated_${index + 1}`,
      createdAt: "2026-07-25T12:00:00.000Z",
      manifest: {
        ...structuredClone(candidate.manifest),
        candidateId: id,
      },
    });
    seeded[field] = { forged: true };
    return [field, seeded];
  }));
  const nonFrozenCandidates = [null, "qa_passed", "release_candidate_ready"].map((status, index) => {
    const id = `candidate_non_frozen_${index + 1}`;
    const seeded = createCandidateEnvelope({
      qaBundleId: `qa_bundle_non_frozen_${index + 1}`,
      createdAt: "2026-07-25T12:00:00.000Z",
      manifest: {
        ...structuredClone(candidate.manifest),
        candidateId: id,
      },
    });
    seeded.status = status;
    return seeded;
  });

  const assertReviewInvalidationRequiresCandidateCascade = async (expectedCandidateStatus) => {
    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const invalidateReviewOnly = (state) => {
            const invalidatedAt = "2026-07-25T13:30:00.000Z";
            state.reviews[0].invalidatedAt = invalidatedAt;
            state.reviews[0].invalidation = {
              action: "request_changes",
              reasonCode: "source_changed",
              invalidatedAt
            };
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(invalidateReviewOnly);
          } else {
            const state = await readState();
            invalidateReviewOnly(state);
            await writeState(state);
          }
        `),
        /still grants authority from invalidated review review_1.*invalidate the candidate in the same transaction/,
        `${writer} must reject review-only invalidation for a ${expectedCandidateStatus} candidate`,
      );
      const persisted = readPersistedState(root);
      assert.equal(persisted.candidates[0].status, expectedCandidateStatus);
      assert.equal(persisted.reviews[0].invalidatedAt, undefined);
    }
  };

  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.projects[0].repoPath = ${JSON.stringify(path.join(root, "repo"))};
        state.projects[0].repoUrl = "https://github.com/example/demo";
        state.projects[0].defaultBranch = "main";
        state.projects[0].validationCommands = ["npm run check"];
        state.projects[0].promotion = { enabled: true, targetBranch: "main" };
        state.tasks[0].qaBundleId = ${JSON.stringify(candidate.qaBundleId)};
        state.tasks[0].candidateId = ${JSON.stringify(candidate.id)};
        state.tasks[0].candidateManifestDigest = ${JSON.stringify(candidate.manifestDigest)};
        state.tasks[0].integrationCommit = ${JSON.stringify(candidate.manifest.integration.sha)};
        state.tasks[0].stateVersion = 1;
        state.tasks[0].automationAttemptEpoch = 0;
        state.reviews.push({
          id: "review_1",
          taskId: "task_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: ${JSON.stringify(sourceSha)},
          candidateCycle: 1,
          reviewedAt: "2026-07-25T11:00:00.000Z",
          createdAt: "2026-07-25T11:00:00.000Z"
        });
        state.qaBundles.push({
          id: ${JSON.stringify(candidate.qaBundleId)},
          projectId: ${JSON.stringify(candidate.projectId)},
          status: "ready",
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          integrationBranch: ${JSON.stringify(candidate.manifest.integration.branch)},
          integrationCommit: ${JSON.stringify(candidate.manifest.integration.sha)},
          previewUrl: ${JSON.stringify(candidate.manifest.preview.url)},
          tasks: [{ id: "task_1", title: state.tasks[0].title }]
        });
        state.candidates.push(${JSON.stringify(candidate)});
      });
    `);

    const altered = structuredClone(candidate);
    altered.manifest.base.sha = "e".repeat(40);
    altered.manifestDigest = manifestDigest(altered.manifest);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0] = ${JSON.stringify(altered)};
        });
      `),
      /manifest is immutable/,
    );

    const persisted = readPersistedState(root);
    assert.equal(persisted.candidates[0].manifest.base.sha, candidate.manifest.base.sha);
    assert.equal(persisted.candidates[0].manifestDigest, candidate.manifestDigest);

    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates = [];
        });
      `),
      /cannot be deleted/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates = [];
        await writeState(state);
      `),
      /cannot be deleted/,
    );

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          import { buildOwnerQaPacket } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/owner-qa-packet.js")).href)};
          const appendBundleOnly = (state) => {
            const candidate = state.candidates[0];
            const bundle = state.qaBundles[0];
            const packet = buildOwnerQaPacket(state, candidate, {
              bundle,
              generatedAt: "2026-07-25T12:00:01.000Z"
            });
            bundle.qaPacket = packet;
            bundle.packetDigest = packet.packetDigest;
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(appendBundleOnly);
          } else {
            const state = await readState();
            appendBundleOnly(state);
            await writeState(state);
          }
        `),
        /matching candidate packet/,
      );
    }

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      import { buildOwnerQaPacket } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/owner-qa-packet.js")).href)};
      await mutateState((state) => {
        const candidate = state.candidates[0];
        const bundle = state.qaBundles[0];
        const packet = buildOwnerQaPacket(state, candidate, {
          bundle,
          generatedAt: "2026-07-25T12:00:01.000Z"
        });
        candidate.qaPacket = packet;
        bundle.qaPacket = packet;
        bundle.packetDigest = packet.packetDigest;
      });
    `);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].qaPacket.tasks[0].definition.branchName = "codex/rewritten";
        });
      `),
      /qaPacket record is append-only|packet digest is missing or invalid/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        delete state.candidates[0].qaPacket;
        await writeState(state);
      `),
      /qaPacket record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.qaBundles[0].tasks = [];
        await writeState(state);
      `),
      /tasks authority is append-only/,
    );

    for (const field of grantedAuthorityFields) {
      for (const writer of ["mutation", "full_write"]) {
        await assert.rejects(
          () => runStoreScript(root, `
            import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
            const grantAuthority = (state) => {
              state.candidates[0][${JSON.stringify(field)}] = { forged: true };
            };
            if (${JSON.stringify(writer)} === "mutation") {
              await mutateState(grantAuthority);
            } else {
              const state = await readState();
              grantAuthority(state);
              await writeState(state);
            }
          `),
          /initial (?:QA decision|.* authority) requires the fenced/,
          `${writer} must not first-create ${field}`,
        );
      }
    }

    for (const field of grantedAuthorityFields) {
      for (const writer of ["mutation", "full_write"]) {
        await assert.rejects(
          () => runStoreScript(root, `
            import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
            const insertPreauthorizedCandidate = (state) => {
              state.candidates.push(${JSON.stringify(prepopulatedAuthorityCandidates[field])});
            };
            if (${JSON.stringify(writer)} === "mutation") {
              await mutateState(insertPreauthorizedCandidate);
            } else {
              const state = await readState();
              insertPreauthorizedCandidate(state);
              await writeState(state);
            }
          `),
          /cannot begin with (?:QA, promotion, or merge|promotion validation) authority/,
          `${writer} must not insert a candidate prepopulated with ${field}`,
        );
      }
    }

    for (const seeded of nonFrozenCandidates) {
      for (const writer of ["mutation", "full_write"]) {
        await assert.rejects(
          () => runStoreScript(root, `
            import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
            const append = (state) => state.candidates.push(${JSON.stringify(seeded)});
            if (${JSON.stringify(writer)} === "mutation") {
              await mutateState(append);
            } else {
              const state = await readState();
              append(state);
              await writeState(state);
            }
          `),
          /must begin in exactly frozen status/,
          `${writer} must reject new candidate status ${String(seeded.status)}`,
        );
      }
    }

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const forgeInvalidation = (state) => {
            const candidate = state.candidates[0];
            candidate.status = "invalidated";
            candidate.invalidation = { forged: true };
            candidate.updatedAt = "2026-07-25T12:10:00.000Z";
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(forgeInvalidation);
          } else {
            const state = await readState();
            forgeInvalidation(state);
            await writeState(state);
          }
        `),
        /exact durable invalidation schema/,
        `${writer} must reject a truthy lookalike candidate invalidation`,
      );
    }

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const forgeReviewInvalidation = (state) => {
            state.reviews[0].invalidatedAt = "2026-07-25T12:10:00.000Z";
            state.reviews[0].invalidation = { forged: true };
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(forgeReviewInvalidation);
          } else {
            const state = await readState();
            forgeReviewInvalidation(state);
            await writeState(state);
          }
        `),
        /exact durable review-invalidation schema/,
        `${writer} must reject a truthy lookalike review invalidation`,
      );
    }

    await assertReviewInvalidationRequiresCandidateCascade("frozen");

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const forge = (state) => {
            const candidate = state.candidates[0];
            candidate.qaRevocationIntent = {
              schemaVersion: "studioops.qa-revocation-intent.v0",
              requestId: "forged",
              outcome: "failed",
              candidateId: candidate.id,
              manifestDigest: candidate.manifestDigest,
              integrationSha: candidate.manifest.integration.sha,
              ownerQaPacketDigest: candidate.qaPacket.packetDigest,
              taskIds: ["task_1"],
              author: "attacker",
              notes: "",
              requestedAt: "2026-07-25T12:00:02.000Z"
            };
            candidate.qaRevocationSettlement = {
              schemaVersion: "studioops.qa-revocation-settlement.v0",
              status: "merged"
            };
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(forge);
          } else {
            const state = await readState();
            forge(state);
            await writeState(state);
          }
        `),
        /revocation intent|revocation settlement|release-candidate/i,
      );
    }

    const qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha,
      taskIds: ["task_1"],
      ownerQaPacketDigest: readPersistedState(root).candidates[0].qaPacket.packetDigest,
      author: "Owner QA",
      notes: "",
      repositoryVerifiedAt: "2026-07-25T12:29:59.000Z",
      decidedAt: "2026-07-25T12:30:00.000Z",
    };
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      import { mutateCandidateQaDecisionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import { createCandidateRepositoryTestVerificationObservation } from ${JSON.stringify(candidateRepositoryModuleUrl)};
      const snapshot = await readState();
      const verification = createCandidateRepositoryTestVerificationObservation(
        snapshot.projects[0],
        snapshot.candidates[0],
        {
          ok: true,
          status: "verified",
          verifiedAt: ${JSON.stringify(qaDecision.repositoryVerifiedAt)}
        }
      );
      const applyDecision = (state, corruption = "") => {
        const candidate = state.candidates[0];
        const decision = structuredClone(${JSON.stringify(qaDecision)});
        if (corruption === "candidate") decision.candidateId = "candidate_other";
        if (corruption === "manifest") decision.manifestDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        if (corruption === "integration") decision.integrationSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (corruption === "tasks") decision.taskIds = [];
        if (corruption === "packet") decision.ownerQaPacketDigest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (corruption === "author") decision.author = " ";
        if (corruption === "time") decision.decidedAt = "not-a-time";
        candidate.qaDecision = decision;
        candidate.status = "qa_passed";
        candidate.updatedAt = decision.decidedAt;
        state.tasks[0].status = "approved_for_main";
        state.tasks[0].assignedAgentRole = "promotion-worker";
        state.tasks[0].reviewSubjectSha = ${JSON.stringify(sourceSha)};
        state.tasks[0].reviewSubjectCycle = 1;
        state.tasks[0].qaDecision = corruption === "task_mirror" ? null : structuredClone(decision);
        state.tasks[0].updatedAt = decision.decidedAt;
        state.qaBundles[0].status = "passed";
        state.qaBundles[0].qaDecision = structuredClone(decision);
        state.qaBundles[0].updatedAt = decision.decidedAt;
      };
      for (const corruption of [
        "candidate", "manifest", "integration", "tasks", "packet", "author", "time", "task_mirror"
      ]) {
        await assert.rejects(
          mutateCandidateQaDecisionState(${JSON.stringify(candidate.id)}, verification, (state) => {
            applyDecision(state, corruption);
          }),
          /not completely bound|exact authority mirror|repository verification time|unsupported or missing fields/i,
          corruption
        );
      }
      await mutateCandidateQaDecisionState(${JSON.stringify(candidate.id)}, verification, (state) => {
        applyDecision(state);
      });
    `);
    await assertReviewInvalidationRequiresCandidateCascade("qa_passed");
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].qaDecision = {
            ...state.candidates[0].qaDecision,
            notes: "rewritten"
          };
        });
      `),
      /qaDecision record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates[0].qaDecision = {
          ...state.candidates[0].qaDecision,
          author: "replacement"
        };
        await writeState(state);
      `),
      /qaDecision record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.tasks[0].qaDecision = null;
        });
      `),
      /qaDecision authority mirror is append-only/i,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.qaBundles[0].qaDecision = null;
        await writeState(state);
      `),
      /qaDecision authority mirror is append-only/i,
    );

    const promotionPolicyDigest = `sha256:${"1".repeat(64)}`;
    const promotionValidationEvidence = {
      path: "/private-evidence/candidate_1-attempt-1.json",
      digest: `sha256:${"4".repeat(64)}`,
      bytes: 512,
      createdAt: "2026-07-25T12:44:00.000Z",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha,
      attempt: 1,
      policyDigest: promotionPolicyDigest,
      commandCount: 1,
    };

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const forgeClaim = (state) => {
            state.meta.promotionAttemptClaims = {
              [${JSON.stringify(candidate.id)}]: {
                schemaVersion: "studioops.promotion-attempt-claim.v4",
                claimId: "forged_claim",
                fence: 1,
                candidateId: ${JSON.stringify(candidate.id)},
                mode: "create",
                status: "active"
              }
            };
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(forgeClaim);
          } else {
            const state = await readState();
            forgeClaim(state);
            await writeState(state);
          }
        `),
        /requires the private claim-transition writer/,
        `${writer} must not first-create a promotion attempt claim`,
      );
      assert.equal(readPersistedState(root).meta.promotionAttemptClaims?.[candidate.id], undefined);
    }

    const legacyUnsupportedClaim = {
      schemaVersion: "studioops.promotion-attempt-claim.v1",
      claimId: "legacy_unsupported_claim",
      fence: 3,
      status: "terminal",
      operationalAttempt: 3,
      candidateId: candidate.id,
    };
    mutatePersistedMeta(root, (meta) => {
      meta.promotionAttemptClaims = {
        ...(meta.promotionAttemptClaims || {}),
        [candidate.id]: structuredClone(legacyUnsupportedClaim),
      };
    });
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutatePromotionAttemptClaimState } from ${JSON.stringify(stateDatabaseModuleUrl)};
        await mutatePromotionAttemptClaimState(${JSON.stringify(candidate.id)}, (state) => {
          const claim = structuredClone(state.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}]);
          delete state.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
          return {
            acquired: false,
            reason: "claim_schema_unsupported",
            claim,
            circuit: {
              shouldOpen: true,
              reasonCode: "promotion_claim_schema_unsupported",
              attemptsConsumed: 3,
              maxAttempts: 3
            }
          };
        }, { removeUnsupportedClaim: true });
      `),
      /no private helper attestation/i,
      "a caller Boolean and lookalike unsupported-claim result cannot delete durable claim evidence",
    );
    assert.deepEqual(
      readPersistedState(root).meta.promotionAttemptClaims[candidate.id],
      legacyUnsupportedClaim,
    );
    mutatePersistedMeta(root, (meta) => {
      delete meta.promotionAttemptClaims[candidate.id];
    });

    await runStoreScript(root, `
      import { mutatePromotionAttemptClaimState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import {
        claimPromotionAttemptInState,
        promotionProjectPolicyBinding
      } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
      const acquired = await mutatePromotionAttemptClaimState(${JSON.stringify(candidate.id)}, (state) => {
        return claimPromotionAttemptInState(state, {
          projectId: ${JSON.stringify(candidate.projectId)},
          candidateId: ${JSON.stringify(candidate.id)},
          mode: "create",
          policyDigest: ${JSON.stringify(promotionPolicyDigest)},
          projectPolicy: promotionProjectPolicyBinding(state.projects[0]),
          nowMs: Date.now(),
          ttlMs: 3600000,
          claimIdFactory: () => "claim_candidate_immutable"
        });
      });
      if (!acquired.acquired) throw new Error("expected the gated claim writer to acquire");
    `);
    const acquiredClaim = readPersistedState(root).meta.promotionAttemptClaims[candidate.id];
    assert.equal(acquiredClaim.status, "active");
    assert.equal(acquiredClaim.claimId, "claim_candidate_immutable");

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        () => runStoreScript(root, `
          import { mutateState, readState, writeState } from ${JSON.stringify(storeModuleUrl)};
          const alterClaim = (state) => {
            state.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}].claimId = "forged_replacement";
          };
          if (${JSON.stringify(writer)} === "mutation") {
            await mutateState(alterClaim);
          } else {
            const state = await readState();
            alterClaim(state);
            await writeState(state);
          }
        `),
        /requires the private claim-transition writer/,
        `${writer} must not alter a promotion attempt claim`,
      );
      assert.equal(
        readPersistedState(root).meta.promotionAttemptClaims[candidate.id].claimId,
        "claim_candidate_immutable",
      );
    }

    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      import { mutateCandidatePromotionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import {
        promotionProjectPolicyBinding,
        recordPromotionRecoveryReceiptInState
      } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
      const snapshot = await readState();
      const claim = snapshot.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
      const recordReceipt = (state) => recordPromotionRecoveryReceiptInState(state, claim, {
          projectId: ${JSON.stringify(candidate.projectId)},
          candidateId: ${JSON.stringify(candidate.id)},
          mode: "create",
          policyDigest: ${JSON.stringify(promotionPolicyDigest)},
          projectPolicy: promotionProjectPolicyBinding(state.projects[0]),
          nowMs: Date.now(),
          validationResults: [{
            command: "npm run check",
            ok: true,
            outputDigest: "sha256:${"2".repeat(64)}"
          }],
          validationEvidence: ${JSON.stringify(promotionValidationEvidence)}
        });
      await assert.rejects(
        mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, (state) => {
          const result = recordReceipt(state);
          state.candidates[0].promotionValidationRecoveryReceipt.validationResultDigest =
            "sha256:3333333333333333333333333333333333333333333333333333333333333333";
          return result;
        }),
        /must exactly match the private claim helper result/i
      );
      await mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, (state) => {
        return recordReceipt(state);
      });
    `);
    assert.equal(
      readPersistedState(root).candidates[0].promotionValidationRecoveryReceipt.candidateId,
      candidate.id,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].promotionValidationRecoveryReceipt = {
            ...state.candidates[0].promotionValidationRecoveryReceipt,
            validationResultDigest: "sha256:${"3".repeat(64)}"
          };
        });
      `),
      /promotionValidationRecoveryReceipt record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        delete state.candidates[0].promotionValidationRecoveryReceipt;
        await writeState(state);
      `),
      /promotionValidationRecoveryReceipt record is append-only/,
    );

    const promotion = {
      branch: "qa/promotion-demo",
      prUrl: "https://github.com/example/demo/pull/1",
      commitSha: integrationSha,
      manifestDigest: candidate.manifestDigest,
      readyAt: "2026-07-25T13:00:00.000Z",
    };
    const promotionMutationSource = `
      const terminal = terminalPromotionAttemptClaimInState(state, claim, {
        projectId: ${JSON.stringify(candidate.projectId)},
        candidateId: ${JSON.stringify(candidate.id)},
        mode: "create",
        policyDigest: ${JSON.stringify(promotionPolicyDigest)},
        projectPolicy,
        nowMs: Date.now(),
        outcome: "pr_ready"
      });
      state.candidates[0].promotion = ${JSON.stringify(promotion)};
      state.candidates[0].status = "release_candidate_ready";
      state.tasks[0].status = "user_review";
      state.tasks[0].assignedAgentRole = "owner";
      state.tasks[0].promotionStatus = "pr_ready";
      state.tasks[0].promotionBranch = ${JSON.stringify(promotion.branch)};
      state.tasks[0].promotionPrUrl = ${JSON.stringify(promotion.prUrl)};
      state.tasks[0].promotionCommit = ${JSON.stringify(promotion.commitSha)};
      state.qaBundles[0].status = "release_candidate_ready";
      state.qaBundles[0].promotionBranch = ${JSON.stringify(promotion.branch)};
      state.qaBundles[0].promotionPrUrl = ${JSON.stringify(promotion.prUrl)};
      state.qaBundles[0].promotionCommit = ${JSON.stringify(promotion.commitSha)};
      state.qaBundles[0].promotedTaskIds = ["task_1"];
      return terminal;
    `;
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState } from ${JSON.stringify(storeModuleUrl)};
        import { mutateCandidatePromotionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
        import {
          promotionProjectPolicyBinding,
          terminalPromotionAttemptClaimInState
        } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
        const snapshot = await readState();
        const claim = snapshot.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
        const projectPolicy = promotionProjectPolicyBinding(snapshot.projects[0]);
        await mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, (state) => {
          ${promotionMutationSource}
        });
      `),
      /not an exact attested GitHub result/,
      "a public terminal helper and canonical-looking PR cannot mint promotion authority without a remote seal",
    );
    let afterUnsealedPromotion = readPersistedState(root);
    assert.equal(afterUnsealedPromotion.candidates[0].status, "qa_passed");
    assert.equal(afterUnsealedPromotion.candidates[0].promotion, null);
    assert.equal(afterUnsealedPromotion.meta.promotionAttemptClaims[candidate.id].status, "active");

    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      import { mutateCandidatePromotionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import {
        promotionProjectPolicyBinding,
        terminalPromotionAttemptClaimInState
      } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
      import { createPromotionRemoteTestObservation } from ${JSON.stringify(promotionAuthorityHarnessModuleUrl)};
      const snapshot = await readState();
      const claim = snapshot.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
      const currentCandidate = snapshot.candidates[0];
      const projectPolicy = promotionProjectPolicyBinding(snapshot.projects[0]);
      const remoteAuthority = {
        projectId: ${JSON.stringify(candidate.projectId)},
        repoUrl: snapshot.projects[0].repoUrl,
        targetBranch: currentCandidate.manifest.base.branch,
        promotionBranch: ${JSON.stringify(promotion.branch)},
        headSha: currentCandidate.manifest.integration.sha,
        candidate: currentCandidate,
        subjectCandidate: currentCandidate,
        claim
      };
      const promotionRemoteObservation = createPromotionRemoteTestObservation(remoteAuthority, {
        number: 1,
        url: ${JSON.stringify(promotion.prUrl)},
        state: "OPEN",
        baseRefName: currentCandidate.manifest.base.branch,
        headRefName: ${JSON.stringify(promotion.branch)},
        headRefOid: currentCandidate.manifest.integration.sha,
        headRepository: { nameWithOwner: "example/demo" },
        body: "<!-- studioops-candidate:" + currentCandidate.id + ":" + currentCandidate.manifestDigest
          + " -->\\n<!-- studioops-claim:" + claim.claimId + ":" + claim.fence + " -->"
      }, { nowMs: Date.now() });
      await mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, (state) => {
        ${promotionMutationSource}
      }, { promotionRemoteObservation });
    `);
    await assertReviewInvalidationRequiresCandidateCascade("release_candidate_ready");
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].promotion = {
            ...state.candidates[0].promotion,
            prUrl: "https://github.com/example/demo/pull/2"
          };
        });
      `),
      /promotion record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates[0].promotion = {
          ...state.candidates[0].promotion,
          branch: "qa/replaced"
        };
        await writeState(state);
      `),
      /promotion record is append-only/,
    );

    const mergeCommit = "f".repeat(40);
    const mergedAt = "2026-07-25T13:30:00.000Z";
    const promotionMerge = {
      mergeCommit,
      mergedAt,
      reconciledAt: "2026-07-25T13:31:00.000Z",
      reconciledByCandidateId: "",
      reconciledByManifestDigest: "",
    };
    await runStoreScript(root, `
      import { mutatePromotionAttemptClaimState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import {
        claimPromotionAttemptInState,
        promotionProjectPolicyBinding
      } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
      const acquired = await mutatePromotionAttemptClaimState(${JSON.stringify(candidate.id)}, (state) => {
        return claimPromotionAttemptInState(state, {
          projectId: ${JSON.stringify(candidate.projectId)},
          candidateId: ${JSON.stringify(candidate.id)},
          mode: "reconcile",
          policyDigest: ${JSON.stringify(promotionPolicyDigest)},
          projectPolicy: promotionProjectPolicyBinding(state.projects[0]),
          nowMs: Date.now(),
          ttlMs: 3600000,
          claimIdFactory: () => "claim_candidate_immutable_reconcile"
        });
      });
      if (!acquired.acquired) throw new Error("expected the gated reconciliation claim to acquire");
    `);

    const mergeMutationSource = `
      const terminal = terminalPromotionAttemptClaimInState(state, claim, {
        projectId: ${JSON.stringify(candidate.projectId)},
        candidateId: ${JSON.stringify(candidate.id)},
        mode: "reconcile",
        policyDigest: ${JSON.stringify(promotionPolicyDigest)},
        projectPolicy,
        nowMs: Date.now(),
        outcome: "merged",
        terminalResult: {
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          prUrl: ${JSON.stringify(promotion.prUrl)},
          mergeCommit: ${JSON.stringify(mergeCommit)},
          mergedAt: ${JSON.stringify(mergedAt)}
        }
      });
      state.candidates[0].status = "merged";
      state.candidates[0].promotionMerge = ${JSON.stringify(promotionMerge)};
      state.tasks[0].status = "merged";
      state.tasks[0].assignedAgentRole = "";
      state.tasks[0].promotionStatus = "merged";
      state.qaBundles[0].status = "merged";
      state.qaBundles[0].promotionMergedAt = ${JSON.stringify(mergedAt)};
      state.qaBundles[0].promotionMergeCommit = ${JSON.stringify(mergeCommit)};
      return terminal;
    `;
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState } from ${JSON.stringify(storeModuleUrl)};
        import { mutateCandidatePromotionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
        import {
          promotionProjectPolicyBinding,
          terminalPromotionAttemptClaimInState
        } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
        const snapshot = await readState();
        const claim = snapshot.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
        const projectPolicy = promotionProjectPolicyBinding(snapshot.projects[0]);
        await mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, (state) => {
          ${mergeMutationSource}
        });
      `),
      /not an exact attested GitHub result/,
      "a structurally valid merged terminal result cannot mint merge authority without a remote seal",
    );
    const afterUnsealedMerge = readPersistedState(root);
    assert.equal(afterUnsealedMerge.candidates[0].status, "release_candidate_ready");
    assert.equal(afterUnsealedMerge.candidates[0].promotionMerge, null);
    assert.equal(afterUnsealedMerge.meta.promotionAttemptClaims[candidate.id].status, "active");

    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      import { mutateCandidatePromotionState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import {
        promotionProjectPolicyBinding,
        terminalPromotionAttemptClaimInState
      } from ${JSON.stringify(promotionAttemptClaimModuleUrl)};
      import {
        createPromotionMergeAncestryTestObservation,
        createPromotionRemoteTestObservation
      } from ${JSON.stringify(promotionAuthorityHarnessModuleUrl)};
      const snapshot = await readState();
      const claim = snapshot.meta.promotionAttemptClaims[${JSON.stringify(candidate.id)}];
      const currentCandidate = snapshot.candidates[0];
      const projectPolicy = promotionProjectPolicyBinding(snapshot.projects[0]);
      const remoteAuthority = {
        projectId: ${JSON.stringify(candidate.projectId)},
        repoUrl: snapshot.projects[0].repoUrl,
        targetBranch: currentCandidate.manifest.base.branch,
        promotionBranch: currentCandidate.promotion.branch,
        headSha: currentCandidate.manifest.integration.sha,
        candidate: currentCandidate,
        subjectCandidate: currentCandidate,
        claim
      };
      const promotionRemoteObservation = createPromotionRemoteTestObservation(remoteAuthority, {
        number: 1,
        url: currentCandidate.promotion.prUrl,
        state: "MERGED",
        mergedAt: ${JSON.stringify(mergedAt)},
        mergeCommit: ${JSON.stringify(mergeCommit)},
        baseRefName: currentCandidate.manifest.base.branch,
        headRefName: currentCandidate.promotion.branch,
        headRefOid: currentCandidate.manifest.integration.sha,
        headRepository: { nameWithOwner: "example/demo" },
        body: "<!-- studioops-candidate:" + currentCandidate.id + ":" + currentCandidate.manifestDigest
          + " -->\\n<!-- studioops-claim:" + claim.claimId + ":" + claim.fence + " -->"
      }, { nowMs: Date.now() });
      const promotionMergeAncestryObservation = createPromotionMergeAncestryTestObservation({
        projectId: ${JSON.stringify(candidate.projectId)},
        repoUrl: snapshot.projects[0].repoUrl,
        targetBranch: currentCandidate.manifest.base.branch,
        promotionBranch: currentCandidate.promotion.branch,
        subjectCandidate: currentCandidate,
        remoteCandidate: currentCandidate,
        claim,
        prUrl: currentCandidate.promotion.prUrl,
        mergeCommit: ${JSON.stringify(mergeCommit)},
        mergedAt: ${JSON.stringify(mergedAt)},
        remoteObservation: promotionRemoteObservation
      }, { targetHead: ${JSON.stringify(mergeCommit)}, nowMs: Date.now() });
      const applyMerge = (state) => {
        ${mergeMutationSource}
      };
      await assert.rejects(
        mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, applyMerge, {
          promotionRemoteObservation
        }),
        /ancestry is not an exact attested Git result/i
      );
      await mutateCandidatePromotionState(${JSON.stringify(candidate.id)}, claim, applyMerge, {
        promotionRemoteObservation,
        promotionMergeAncestryObservation
      });
    `);
    const merged = readPersistedState(root);
    assert.equal(merged.candidates[0].status, "merged");
    assert.equal(merged.candidates[0].promotionMerge.mergeCommit, mergeCommit);
    assert.equal(merged.meta.promotionAttemptClaims[candidate.id].outcome, "merged");
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].promotionMerge.mergeCommit = "${"e".repeat(40)}";
        });
      `),
      /promotionMerge record is append-only/,
    );

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      import { invalidateCandidate } from ${JSON.stringify(candidateManifestModuleUrl)};
      await mutateState((state) => {
        const invalidatedAt = "2026-07-25T14:00:00.000Z";
        state.reviews[0].invalidatedAt = invalidatedAt;
        state.reviews[0].invalidation = {
          action: "request_changes",
          reasonCode: "source_changed",
          invalidatedAt
        };
        invalidateCandidate(state.candidates[0], {
          reason: "Source drift.",
          expected: "${sourceSha}",
          observed: "${"f".repeat(40)}",
          invalidatedAt
        });
      });
    `);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].invalidation = null;
          state.candidates[0].status = "frozen";
        });
      `),
      /invalidation record is append-only/,
    );
    const invalidated = readPersistedState(root).candidates[0];
    assert.equal(invalidated.status, "invalidated");
    assert.equal(invalidated.invalidation.reason, "Source drift.");
    assert.equal(readPersistedState(root).reviews[0].invalidation.reasonCode, "source_changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite import removes orphaned and cross-project QA bundle references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-integrity-"));
  try {
    const state = baseState();
    state.projects.push({ id: "project_2", key: "other", name: "Other" });
    state.tasks[0].qaBundleId = "qa_bundle_1";
    state.tasks.push({
      id: "task_2",
      projectId: "project_2",
      title: "Valid QA task",
      status: "qa_review",
      qaBundleId: "qa_bundle_1",
    });
    state.qaBundles.push({
      id: "qa_bundle_1",
      projectId: "project_2",
      status: "ready",
      tasks: [
        { id: "task_1", title: "Wrong project" },
        { id: "task_2", title: "Valid QA task" },
      ],
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").qaBundleId, undefined);
    assert.equal(persisted.tasks.find((task) => task.id === "task_2").qaBundleId, undefined);
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.qaBundles[0].legacyStatus, "ready");
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite migration reconstructs bundles for previously integrated QA tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-backfill-"));
  try {
    const state = baseState();
    state.projects[0].repoUrl = "git@github.com:example/demo.git";
    state.projects[0].localQaPreview = {
      checkoutPath: "/tmp/demo-qa",
      previewUrl: "http://127.0.0.1:4174/",
    };
    Object.assign(state.tasks[0], {
      status: "qa_review",
      qaBundleId: "qa_bundle_99",
      localQaPreview: {
        status: "current",
        branch: "qa/demo",
        after: "abc123",
        checkoutPath: "/tmp/demo-qa",
      },
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.qaBundles.length, 1);
    assert.equal(persisted.qaBundles[0].projectId, "project_1");
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.qaBundles[0].previewUrl, "http://127.0.0.1:4174/");
    assert.equal(persisted.qaBundles[0].integrationBranchUrl, "https://github.com/example/demo/tree/qa/demo");
    assert.equal(persisted.tasks[0].qaBundleId, undefined);
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy QA bundles remain visible but cannot authorize a new QA decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-qa-ineligible-"));
  try {
    const state = baseState();
    state.tasks[0].status = "qa_review";
    state.tasks[0].qaBundleId = "qa_bundle_legacy";
    state.qaBundles.push({
      id: "qa_bundle_legacy",
      projectId: "project_1",
      status: "ready",
      tasks: [{ id: "task_1", title: state.tasks[0].title }],
    });
    await writeLegacyState(root, state);

    await assert.rejects(
      () => runStoreScript(root, `
        import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        await recordQaBundleDecision("qa_bundle_legacy", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: "candidate_missing",
          manifestDigest: "sha256:${"a".repeat(64)}",
          integrationSha: "${"b".repeat(40)}"
        });
      `),
      /legacy and has no immutable candidate/,
    );
    const persisted = readPersistedState(root);
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.tasks[0].status, "qa_review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy task-level QA approvals remain visible but are not promotion authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-task-approval-"));
  try {
    const state = baseState();
    state.tasks[0].status = "approved_for_main";
    state.tasks[0].promotionStatus = "queued";
    state.tasks[0].qaDecision = {
      outcome: "passed",
      author: "Legacy owner",
      decidedAt: "2026-07-24T12:00:00.000Z",
    };
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].status, "legacy_untrusted");
    assert.equal(persisted.tasks[0].legacyStatus, "approved_for_main");
    assert.equal(persisted.tasks[0].legacyQaDecisionUntrusted, true);
    assert.equal(persisted.tasks[0].promotionStatus, "");
    assert.match(persisted.tasks[0].integrityBlocker, /immutable candidate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite archives excess machine QA history without compacting human comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-history-compaction-"));
  try {
    const state = baseState();
    const machineComments = Array.from({ length: 30 }, (_, index) => ({
      id: `comment_${index + 1}`,
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: `QA integration blocked report ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    }));
    state.comments = [...machineComments];
    state.comments.push(...Array.from({ length: 18 }, (_, index) => ({
      id: `comment_runner_${index + 1}`,
      taskId: "task_1",
      author: "StudioOps Runner",
      systemGenerated: true,
      kind: "run_update",
      body: `Runner update ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 3, index)).toISOString(),
    })));
    state.comments.splice(5, 0, {
      id: "comment_human",
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: "QA integration is a name I used for this human decision.",
      createdAt: "2026-07-01T00:05:30.000Z",
    });
    state.events = Array.from({ length: 50 }, (_, index) => ({
      id: `event_${index + 1}`,
      type: "qa_integration_blocked",
      projectId: "project_1",
      taskId: "task_1",
      message: `Blocked ${index + 1}`,
      createdAt: index < machineComments.length
        ? machineComments[index].createdAt
        : new Date(Date.UTC(2026, 6, 1, 1, index)).toISOString(),
    }));
    state.runs = Array.from({ length: 10 }, (_, index) => ({
      id: `run_${index + 1}`,
      taskId: "task_1",
      projectId: "project_1",
      dispatchKey: "task_1:1:continue_review:qa-reviewer:qa_review",
      actionType: "continue_review",
      role: "qa-reviewer",
      status: "cancelled",
      prompt: `Large generated prompt ${index + 1}`,
      exitCode: "task_status_changed:qa_review",
      createdAt: new Date(Date.UTC(2026, 6, 1, 2, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 1, 2, index)).toISOString(),
    }));
    state.runs.push({
      id: "run_running",
      taskId: "task_1",
      projectId: "project_1",
      dispatchKey: "task_1:1:continue_review:qa-reviewer:qa_review",
      actionType: "continue_review",
      role: "qa-reviewer",
      status: "running",
      attemptKey: "task_1:attempt:current",
      createdAt: "2026-07-01T02:30:00.000Z",
      updatedAt: "2026-07-01T02:30:00.000Z",
    });
    state.runs.push({
      id: "run_queued",
      taskId: "task_1",
      projectId: "project_1",
      dispatchKey: "task_1:1:continue_review:qa-reviewer:qa_review",
      actionType: "continue_review",
      role: "qa-reviewer",
      status: "queued",
      attemptKey: "task_1:attempt:current",
      createdAt: "2026-07-01T02:31:00.000Z",
      updatedAt: "2026-07-01T02:31:00.000Z",
    });
    state.runs.push({
      id: "run_failed",
      taskId: "task_1",
      projectId: "project_1",
      dispatchKey: "task_1:1:continue_review:qa-reviewer:qa_review",
      actionType: "continue_review",
      role: "qa-reviewer",
      status: "failed",
      prompt: "Preserved failure evidence",
      createdAt: "2026-07-01T03:00:00.000Z",
      updatedAt: "2026-07-01T03:00:00.000Z",
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    let persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human").length, 32);
    assert.equal(persisted.comments.filter((item) => item.kind === "run_update").length, 12);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);
    assert.equal(persisted.runs.filter((item) => item.status === "cancelled").length, 2);
    assert.equal(persisted.runs.some((item) => item.id === "run_failed"), true);
    assert.equal(persisted.runs.some((item) => item.id === "run_running"), true);
    assert.equal(persisted.runs.some((item) => item.id === "run_queued"), true);

    const backupPath = persisted.meta.operationalArchive.backupPath;
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare("SELECT count(*) count FROM comments").get().count, 49);
      assert.equal(backupDb.prepare("SELECT count(*) count FROM events").get().count, 50);
    } finally {
      backupDb.close();
    }

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        for (let index = 1; index <= 5; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 6, 2, 0, index)).toISOString();
          state.comments.push({
            id: \`comment_new_\${index}\`,
            taskId: "task_1",
            author: "StudioOps QA Integration",
            systemGenerated: true,
            kind: "qa_integration",
            body: \`QA integration blocked new report \${index}\`,
            createdAt,
          });
          state.events.push({
            id: \`event_new_\${index}\`,
            type: "qa_integration_blocked",
            projectId: "project_1",
            taskId: "task_1",
            message: \`New blocked report \${index}\`,
            createdAt,
          });
        }
      });
    `);
    persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.kind === "qa_integration").length, 5);
    assert.equal(persisted.comments.filter((item) => item.kind === "run_update").length, 12);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human" && item.id.startsWith("comment_") && !item.kind).length, 15);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);

    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const archived = db.prepare("SELECT entity_type, count(*) count FROM operational_archive GROUP BY entity_type ORDER BY entity_type")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(archived, [
        { entity_type: "comments", count: 21 },
        { entity_type: "events", count: 15 },
        { entity_type: "runs", count: 8 },
      ]);
      const archivedRun = JSON.parse(db.prepare(
        "SELECT payload FROM operational_archive WHERE entity_type = 'runs' LIMIT 1",
      ).get().payload);
      assert.equal(archivedRun.prompt, undefined);
      assert.equal(archivedRun.promptOmitted, true);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
