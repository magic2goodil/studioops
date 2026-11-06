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

function compactedMergedHistory() {
  const state = baseState();
  state.tasks[0].status = "done";
  const at = "2026-09-04T12:00:00.000Z";
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_history", createdAt: at,
    manifest: {
      candidateId: "candidate_history", projectId: "project_1",
      base: { branch: "main", sha: "a".repeat(40) },
      sources: [{ taskId: "task_1", sourceRef: "refs/heads/codex/history",
        headSha: "b".repeat(40), candidateCycle: 1,
        reviews: [{ id: "review_history", stageKey: "lead", role: "lead-reviewer",
          outcome: "approved", subjectSha: "b".repeat(40), candidateCycle: 1, reviewedAt: at }] }],
      integration: { branch: "qa/history", sha: "c".repeat(40) },
      checks: [{ id: "check_history", kind: "local-validation", name: "npm test",
        outcome: "passed", subjectSha: "c".repeat(40), evidenceDigest: `sha256:${"d".repeat(64)}` }],
      preview: { url: "http://127.0.0.1:4174/", status: "healthy", commitSha: "c".repeat(40),
        verifiedAt: at, attestation: { kind: "json", key: "commitSha", observedSha: "c".repeat(40) } },
      assembly: { mode: "atomic", requestedTaskIds: ["task_1"], includedTaskIds: ["task_1"], excludedTaskIds: [] },
    },
  });
  state.reviews = [{ ...candidate.manifest.sources[0].reviews[0], taskId: "task_1", createdAt: at }];
  const bundle = {
    id: candidate.qaBundleId, projectId: candidate.projectId, candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest, integrationBranch: candidate.manifest.integration.branch,
    integrationCommit: candidate.manifest.integration.sha, previewUrl: candidate.manifest.preview.url,
    status: "ready", tasks: [{ id: "task_1", title: state.tasks[0].title }],
  };
  state.candidates = [candidate];
  state.qaBundles = [bundle];
  const packet = buildOwnerQaPacket(state, candidate, { bundle, generatedAt: at });
  candidate.qaPacket = packet;
  bundle.qaPacket = structuredClone(packet);
  bundle.packetDigest = packet.packetDigest;
  candidate.qaDecision = {
    outcome: "passed", candidateId: candidate.id, manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha, ownerQaPacketDigest: packet.packetDigest,
    taskIds: ["task_1"], repositoryVerifiedAt: at, author: "Historical owner", notes: "Historical approval", decidedAt: at,
  };
  bundle.qaDecision = structuredClone(candidate.qaDecision);
  candidate.promotion = {
    branch: "qa/history", prUrl: "https://github.com/example/demo/pull/1",
    commitSha: candidate.manifest.integration.sha, manifestDigest: candidate.manifestDigest, readyAt: at,
  };
  candidate.promotionMerge = { mergeCommit: "e".repeat(40), mergedAt: at, reconciledAt: at };
  Object.assign(bundle, {
    status: "merged", promotionBranch: candidate.promotion.branch, promotionPrUrl: candidate.promotion.prUrl,
    promotionCommit: candidate.promotion.commitSha, promotionReadyAt: at, promotedTaskIds: ["task_1"],
    promotionMergedAt: at, promotionMergeCommit: candidate.promotionMerge.mergeCommit, tasks: [],
  });
  candidate.status = "merged";
  return structuredClone(state);
}

async function seedCompactedHistory(root, state) {
  // Reproduce pre-existing storage, not a newly authorized candidate. Normal
  // writers intentionally cannot create a candidate with historical authority.
  const initial = baseState(); initial.tasks[0].status = "done";
  await writeLegacyState(root, initial);
  await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
  const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"));
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [table, rows] of [["candidates", state.candidates], ["qa_bundles", state.qaBundles], ["reviews", state.reviews]]) {
      for (const [index, row] of rows.entries()) {
        db.prepare(`INSERT INTO ${table} (id, sequence, payload) VALUES (?, ?, ?)`)
          .run(row.id, index, JSON.stringify(row));
      }
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}

test("compacted merged history permits unrelated writes without changing historical authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-merged-history-"));
  try {
    const state = compactedMergedHistory();
    await seedCompactedHistory(root, state);
    await runStoreScript(root, `import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState(state => { state.meta.historyRepairProbe = true; });`);
    const after = readPersistedState(root);
    assert.equal(after.meta.historyRepairProbe, true);
    assert.deepEqual(after.candidates, state.candidates);
    assert.deepEqual(after.qaBundles, state.qaBundles);
    assert.deepEqual(after.reviews, state.reviews);
    assert.equal(after.tasks[0].status, "done");
    for (const mutation of [
      'state.candidates[0].status = "qa_passed"',
      'state.candidates[0].qaDecision.notes = "new approval"',
      'state.qaBundles[0].tasks = [{id:"task_1"}]',
      'state.qaBundles[0].qaPacket.tasks[0].title = "rewritten"',
      'state.qaBundles[0].promotionMergeCommit = "f".repeat(40)',
    ]) {
      await assert.rejects(() => runStoreScript(root, `import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState(state => { ${mutation}; });`));
      const unchanged = readPersistedState(root);
      assert.deepEqual(unchanged.candidates, after.candidates);
      assert.deepEqual(unchanged.qaBundles, after.qaBundles);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compacted history does not excuse active, tampered, or incomplete QA evidence", async () => {
  const cases = [
    state => { state.candidates[0].status = "frozen"; },
    state => { state.qaBundles[0].status = "ready"; },
    state => { state.qaBundles[0].tasks = [{ id: "wrong_task" }]; },
    state => { delete state.qaBundles[0].tasks; },
    state => { delete state.candidates[0].promotionMerge; },
    state => { state.qaBundles[0].promotionMergeCommit = "f".repeat(40); },
    state => { state.qaBundles[0].qaDecision.notes = "changed"; },
    state => { state.candidates[0].qaPacket.tasks[0].title = "changed";
      state.qaBundles[0].qaPacket = structuredClone(state.candidates[0].qaPacket); },
    state => { state.qaBundles[0].packetDigest = `sha256:${"f".repeat(64)}`; },
    ...["author", "decidedAt", "repositoryVerifiedAt"].map(field => state => {
      delete state.candidates[0].qaDecision[field]; delete state.qaBundles[0].qaDecision[field];
    }),
    state => { state.candidates[0].qaDecision.author = " "; state.qaBundles[0].qaDecision.author = " "; },
    ...[["branch", "promotionBranch"], ["prUrl", "promotionPrUrl"]].map(([field, mirror]) => state => {
      delete state.candidates[0].promotion[field]; delete state.qaBundles[0][mirror];
    }),
    state => { state.candidates[0].promotion.prUrl = "not-a-pr"; state.qaBundles[0].promotionPrUrl = "not-a-pr"; },
    state => { delete state.candidates[0].promotionMerge.reconciledAt; },
  ];
  for (const change of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-rejected-history-"));
    try {
      const state = compactedMergedHistory(); change(state);
      await seedCompactedHistory(root, state);
      await assert.rejects(() => runStoreScript(root, `import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState(state => { state.meta.shouldNotCommit = true; });`),
      /owner QA packet|owner packet|packet digest|authority|candidate identity|mirror|bundle identity/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

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

function operatorCandidateTestScript() {
  return `
    import assert from "node:assert/strict";
    import { mutateDatabaseState, mutateOperatorCandidateState, mutateScopeDispatchState, mutateNativeWorkspaceState, readDatabaseState, writeDatabaseState } from ${JSON.stringify(stateDatabaseModuleUrl)};
    const candidate = { baseSha: "a".repeat(40), commitSha: "b".repeat(40), treeSha: "c".repeat(40), branch: "codex/fixture" };
    const frozenScopePlan = { project: { id: "project_1", key: "demo" }, manifest: { digest: "sha256:" + "d".repeat(64) }, allowedFileScope: ["src/example.js"] };
    const verification = { taskId: "task_1", candidate, scopeDigest: "sha256:" + "e".repeat(64), requestDigest: "sha256:" + "f".repeat(64), frozenScopePlan, dispositionTaskIds: [] };
    function adopt(state, verified = verification) {
      const task = state.tasks.find(item => item.id === verified.taskId);
      task.status = "builder_review";
      task.reviewSubjectSha = verified.candidate.commitSha;
      task.reviewSubjectCycle = task.reviewCycle = 1;
      task.candidateIdentity = { ...verified.candidate, candidateCycle: 1 };
      task.impactScopePlan = structuredClone(verified.frozenScopePlan);
      task.operatorIntake = { schemaVersion: 1, candidate: structuredClone(verified.candidate), requestDigest: verified.requestDigest, scopeDigest: verified.scopeDigest };
    }
    await readDatabaseState();
  `;
}

test("persistence rejects serialized operator authority and absent-scope generic handoffs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-ingress-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, operatorCandidateTestScript() + `
      await assert.rejects(mutateDatabaseState(state => adopt(state), {
        operatorCandidateCapability: "studioops.operator-candidate-write", operatorCandidateVerification: verification,
      }), /operator_intake_verified_writer_required/);
      const replacement = await readDatabaseState(); adopt(replacement);
      await assert.rejects(writeDatabaseState(replacement), /operator_intake_verified_writer_required/);
      for (const addScope of [false, true]) {
        await assert.rejects(mutateDatabaseState(state => {
          const task = state.tasks[0]; task.status = "builder_review"; task.reviewSubjectSha = candidate.commitSha;
          if (addScope) task.impactScopePlan = structuredClone(frozenScopePlan);
        }), /builder_handoff_frozen_scope_required|frozen_scope_verified_writer_required/);
      }
      assert.equal((await readDatabaseState()).tasks[0].status, "ready");
      assert.equal((await readDatabaseState()).tasks[0].operatorIntake, undefined);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cold-start legacy JSON cannot bootstrap serialized operator intake authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-bootstrap-"));
  try {
    const state = baseState();
    state.tasks[0].operatorIntake = { schemaVersion: 1, source: "operator", principal: "forged-json-owner" };
    await writeLegacyState(root, state);
    await assert.rejects(runStoreScript(root, `
      import { readDatabaseState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readDatabaseState();
    `), /operator_intake_verified_writer_required/);
    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS count FROM tasks").get().count, 0); }
    finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified intake is immutable historical evidence and exact scope is retained", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-history-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, operatorCandidateTestScript() + `
      await mutateOperatorCandidateState(async state => verification, (state, verified) => {
        assert.equal(Object.isFrozen(verified.candidate), true);
        assert.equal(Object.isFrozen(verified.frozenScopePlan.allowedFileScope), true);
        adopt(state, verified);
      });
      const intake = structuredClone((await readDatabaseState()).tasks[0].operatorIntake);
      await mutateDatabaseState(state => { state.meta.unrelated = true; });
      assert.deepEqual((await readDatabaseState()).tasks[0].operatorIntake, intake);
      for (const edit of [
        state => { delete state.tasks[0].operatorIntake; },
        state => { state.tasks[0].operatorIntake.requestDigest = "sha256:" + "0".repeat(64); },
        state => { state.tasks = []; },
      ]) await assert.rejects(mutateDatabaseState(edit), /operator_intake_history_immutable/);
      const replacement = await readDatabaseState(); delete replacement.tasks[0].operatorIntake;
      await assert.rejects(writeDatabaseState(replacement), /operator_intake_history_immutable/);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a genuine private replacement preserves the exact prior intake while unchanged material cannot start a cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-replacement-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, operatorCandidateTestScript() + `
      await mutateOperatorCandidateState(async () => verification, adopt);
      const previous = structuredClone((await readDatabaseState()).tasks[0].operatorIntake);
      await mutateDatabaseState(state => { state.tasks[0].status = "needs_changes"; });
      const replacement = { ...verification, requestDigest: "sha256:" + "1".repeat(64), candidate: { ...candidate, commitSha: "d".repeat(40), treeSha: "e".repeat(40) } };
      const appendReceipt = state => state.events.push({ id: "event_replaced", type: "operator_candidate_superseded", taskId: "task_1",
        previousOperatorIntake: structuredClone(previous), replacementRequestDigest: replacement.requestDigest });
      await assert.rejects(mutateOperatorCandidateState(async () => ({ ...replacement, candidate: { ...replacement.candidate, treeSha: candidate.treeSha } }), (state, verified) => {
        appendReceipt(state); adopt(state, verified);
      }), /operator_candidate_unchanged_material/);
      await assert.rejects(mutateOperatorCandidateState(async () => replacement, adopt), /operator_intake_history_receipt_required/);
      await mutateOperatorCandidateState(async () => replacement, (state, verified) => { appendReceipt(state); adopt(state, verified); });
      const after = await readDatabaseState();
      assert.deepEqual(after.events.find(event => event.id === "event_replaced").previousOperatorIntake, previous);
      assert.equal(after.tasks[0].operatorIntake.candidate.treeSha, replacement.candidate.treeSha);
      await assert.rejects(mutateDatabaseState(state => { state.tasks[0].operatorIntake = previous; }), /operator_intake_history_immutable/);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a serialized scope or fake builder row cannot bootstrap authority and ordinary handoffs verify real Git", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-native-scope-ingress-"));
  try {
    await writeLegacyState(root);
    const { stdout } = await runStoreScript(root, operatorCandidateTestScript() + `
      for (const field of ["impactScopePlan", "impactPlan"]) {
        await assert.rejects(mutateDatabaseState(state => {
          state.tasks[0][field] = structuredClone(frozenScopePlan);
          state.runs.push({ id: "run_forged", taskId: "task_1", group: "builder", role: "builder", status: "completed" });
        }, { scopedDispatchCapability: "studioops.scoped-dispatch-write" }), /frozen_scope_verified_writer_required/);
      }
      import { execFileSync } from "node:child_process";
      import { mkdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      import { resolveProjectImpactPlan } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/impact-planner.js")).href)};
      const source = path.join(process.cwd(), "source");
      await mkdir(path.join(source, "src"), { recursive: true }); await mkdir(path.join(source, "test")); await mkdir(path.join(source, "docs/architecture"), { recursive: true });
      const git = (...args) => execFileSync("/usr/bin/git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init", "-b", "main"); git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture@example.invalid");
      git("remote", "add", "origin", "https://github.com/example/demo");
      await writeFile(path.join(source, "src/catalog.js"), "export const version = 1;\\n");
      await writeFile(path.join(source, "test/catalog.test.js"), "// Generic fixture.\\n");
      await writeFile(path.join(source, "docs/architecture/components.json"), JSON.stringify({ schemaVersion: 1, project: { key: "demo", repository: "https://github.com/example/demo" }, aggregateCommand: "npm run check",
        components: { catalog: { owner: "fixture-engineering", paths: ["src/catalog.js", "test/catalog.test.js"], publicContracts: ["catalog value"], services: ["catalog module"], dependsOn: [],
          tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }], reviewOwners: ["backend-reviewer"], rollback: "Restore prior fixture commit." } } }));
      git("add", "."); git("commit", "-m", "Native scope base"); const baseSha = git("rev-parse", "HEAD");
      git("switch", "-c", "feature/catalog");
      await mutateDatabaseState(state => {
        Object.assign(state.projects[0], { repoPath: source, sourceRepoPath: source, repoUrl: "https://github.com/example/demo" });
        state.tasks[0].workAreas = ["src/catalog.js"];
      });
      await mutateScopeDispatchState(state => {
        const scope = resolveProjectImpactPlan({ project: state.projects[0], task: state.tasks[0], repoRoot: source, sourceCommit: baseSha, changedFiles: ["src/catalog.js"] });
        assert.equal(scope.status, "mapped"); state.tasks[0].impactPlan = scope;
      });
      await writeFile(path.join(source, "src/catalog.js"), "export const version = 2;\\n"); git("add", "."); git("commit", "-m", "Real native candidate");
      const actual = { baseSha, commitSha: git("rev-parse", "HEAD"), treeSha: git("rev-parse", "HEAD^{tree}"), branch: "feature/catalog", candidateCycle: 1 };
      const ordinaryHandoff = (state, coordinates) => {
        state.tasks[0].impactScopePlan ||= structuredClone(state.tasks[0].impactPlan);
        state.tasks[0].impactPlan = { ...state.tasks[0].impactPlan, classificationRefreshed: true };
        Object.assign(state.tasks[0], { status: "builder_review", reviewSubjectSha: coordinates.commitSha, reviewSubjectCycle: 1, reviewCycle: 1,
          branchName: coordinates.branch, candidateIdentity: coordinates, impactEvidence: { changedFiles: ["src/catalog.js"] } });
      };
      await assert.rejects(mutateDatabaseState(state => ordinaryHandoff(state, { ...actual, commitSha: "0".repeat(40) })), /builder_handoff_branch_mismatch/);
      const replacementState = await readDatabaseState(); ordinaryHandoff(replacementState, actual);
      await assert.rejects(writeDatabaseState(replacementState), /builder_handoff_verified_mutation_required/);
      await mutateDatabaseState(state => ordinaryHandoff(state, actual));
      assert.equal((await readDatabaseState()).tasks[0].reviewSubjectSha, actual.commitSha);
      assert.equal((await readDatabaseState()).tasks[0].impactScopePlan.classificationRefreshed, undefined);
      import { dispatchSupervisorActions } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/dispatcher.js")).href)};
      await mutateDatabaseState(state => Object.assign(state.tasks[0], {
        status: "needs_changes", type: "bug", architectureRequired: false, architectureStatus: "not_required",
        description: "Validate a genuine native isolated builder workspace.", userStory: "As a reviewer I need the exact isolated commit.",
        expectedOutcome: "The persisted native run authorizes only its actual prepared workspace.", acceptanceCriteria: ["Source identity stays exact."],
        affectedSurfaces: ["src/catalog.js"], validationPlan: ["node --test test/catalog.test.js"], riskClassification: "low",
        privacyNotes: "Synthetic source without personal data.", securityNotes: "No executor, network or paid API is invoked.",
      }));
      const dispatched = await dispatchSupervisorActions([{ id: "task_1:start_builder_fix", type: "start_builder_fix", role: "builder", taskId: "task_1", projectId: "project_1",
        taskStatus: "needs_changes", nextStatus: "in_progress", branchName: actual.branch }], { failureIncidents: [], creditPolicy: { enabled: false } });
      assert.equal(dispatched.runs.length, 1, JSON.stringify(dispatched.skipped));
      const runId = dispatched.runs[0].id;
      const workspace = path.join(process.cwd(), "isolated-source");
      execFileSync("/usr/bin/git", ["clone", "--no-hardlinks", source, workspace], { stdio: ["ignore", "pipe", "pipe"] });
      const workspaceGit = (...args) => execFileSync("/usr/bin/git", ["-C", workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      workspaceGit("config", "user.name", "Fixture Author"); workspaceGit("config", "user.email", "fixture@example.invalid");
      workspaceGit("remote", "set-url", "origin", "https://github.com/example/demo");
      await writeFile(path.join(workspace, "src/catalog.js"), "export const version = 3;\\n");
      workspaceGit("add", "src/catalog.js"); workspaceGit("commit", "-m", "Native isolated candidate");
      const isolated = { ...actual, commitSha: workspaceGit("rev-parse", "HEAD"), treeSha: workspaceGit("rev-parse", "HEAD^{tree}") };
      const prepareWorkspaceRecord = state => Object.assign(state.runs.find(run => run.id === runId), {
        status: "cancelled", completedAt: new Date().toISOString(), workspacePath: workspace, executionRepoPath: workspace,
        notes: "Real fixture workspace prepared; queued executor cancelled before launch.",
      });
      await assert.rejects(mutateDatabaseState(state => {
        prepareWorkspaceRecord(state); ordinaryHandoff(state, isolated);
      }), /native_workspace_verified_writer_required/);
      assert.equal((await readDatabaseState()).runs.find(run => run.id === runId).executionRepoPath, undefined);
      await assert.rejects(mutateDatabaseState(prepareWorkspaceRecord), /native_workspace_verified_writer_required/);
      await assert.rejects(mutateDatabaseState(state => state.runs.push({ id: "run_fake_native", taskId: "task_1", projectId: "project_1", group: "builder", role: "builder",
        status: "failed", branchName: actual.branch, workspacePath: workspace, executionRepoPath: workspace })), /native_workspace_verified_writer_required/);
      const replacementWithWorkspace = await readDatabaseState(); prepareWorkspaceRecord(replacementWithWorkspace);
      await assert.rejects(writeDatabaseState(replacementWithWorkspace), /native_workspace_verified_writer_required/);
      import { persistRunWorkspace } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/runner.js")).href)};
      // Only the actual native workspace producer seals the prepared path onto
      // the existing dispatched run; ordinary writes cannot manufacture it.
      await persistRunWorkspace(dispatched.runs[0], { workspacePath: workspace, executionRepoPath: workspace, strategy: "clone" });
      await mutateDatabaseState(state => { const run = state.runs.find(run => run.id === runId); run.status = "cancelled"; run.completedAt = new Date().toISOString(); });
      await assert.rejects(mutateNativeWorkspaceState("run_nonexistent", state => state.runs.push({ id: "run_nonexistent" })), /native_workspace_persisted_run_required/);
      await assert.rejects(mutateNativeWorkspaceState(runId, state => state.runs.push({ id: "run_invented" })), /native_workspace_run_set_immutable/);
      await assert.rejects(mutateNativeWorkspaceState(runId, state => { state.runs.find(run => run.id === runId).status = "completed"; }), /native_workspace_run_record_immutable/);
      for (const field of ["workspacePath", "executionRepoPath", "workspaceStrategy", "gitHooksPath", "workspaceProvenanceUntrusted"]) {
        await assert.rejects(mutateDatabaseState(state => { state.runs.find(run => run.id === runId)[field] = "forged"; }), /native_workspace_verified_writer_required/);
      }
      for (const field of ["taskId", "projectId", "role", "group", "branchName"]) {
        await assert.rejects(mutateDatabaseState(state => { state.runs.find(run => run.id === runId)[field] = "forged"; }), /native_workspace_run_identity_immutable/);
      }
      await mutateDatabaseState(state => ordinaryHandoff(state, isolated));
      const after = await readDatabaseState();
      assert.equal(after.tasks[0].reviewSubjectSha, isolated.commitSha);
      console.log(JSON.stringify({ project: after.projects[0], task: after.tasks[0], run: after.runs.find(run => run.id === runId), isolated }));
    `);
    const prepared = JSON.parse(stdout.trim().split("\n").at(-1));
    const coldRoot = path.join(root, "cold-import");
    const coldState = baseState();
    coldState.projects = [prepared.project];
    coldState.tasks = [{ ...prepared.task, status: "in_progress" }];
    coldState.runs = [{ ...prepared.run, workspaceProvenanceUntrusted: false }];
    await writeLegacyState(coldRoot, coldState);
    await runStoreScript(coldRoot, `
      import assert from "node:assert/strict";
      import { readDatabaseState, mutateDatabaseState, writeDatabaseState } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import { persistRunWorkspace } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/runner.js")).href)};
      const before = await readDatabaseState();
      assert.equal(before.runs[0].workspaceProvenanceUntrusted, true);
      assert.equal(before.runs[0].workspacePath, ${JSON.stringify(prepared.run.workspacePath)});
      const handoff = state => { state.tasks[0].status = "builder_review"; };
      await assert.rejects(mutateDatabaseState(handoff), /builder_handoff_branch_mismatch|builder_handoff_repository_unavailable/);
      await assert.rejects(mutateDatabaseState(state => { delete state.runs[0].workspaceProvenanceUntrusted; }), /native_workspace_verified_writer_required/);
      const replacement = await readDatabaseState(); replacement.runs[0].workspaceProvenanceUntrusted = false;
      await assert.rejects(writeDatabaseState(replacement), /native_workspace_verified_writer_required/);
      await persistRunWorkspace(before.runs[0], { workspacePath: before.runs[0].workspacePath, executionRepoPath: before.runs[0].executionRepoPath, strategy: before.runs[0].workspaceStrategy });
      assert.equal((await readDatabaseState()).runs[0].workspaceProvenanceUntrusted, false);
      await mutateDatabaseState(handoff);
      assert.equal((await readDatabaseState()).tasks[0].reviewSubjectSha, ${JSON.stringify(prepared.isolated.commitSha)});
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified writer rejects mismatched candidate, scope and another task's intake", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-bindings-"));
  try {
    const state = baseState(); state.tasks.push({ ...state.tasks[0], id: "task_2" });
    await writeLegacyState(root, state);
    await runStoreScript(root, operatorCandidateTestScript() + `
      await assert.rejects(mutateOperatorCandidateState(verification, adopt), /executable verification/);
      for (const change of [
        state => { state.tasks[0].candidateIdentity.treeSha = "0".repeat(40); },
        state => { state.tasks[0].operatorIntake.requestDigest = "sha256:" + "0".repeat(64); },
        state => { state.tasks[0].impactScopePlan.allowedFileScope.push("src/other.js"); },
        state => { state.tasks[1].operatorIntake = { trusted: true }; },
      ]) {
        await assert.rejects(mutateOperatorCandidateState(async () => verification, (state, verified) => {
          adopt(state, verified); change(state);
        }), /operator_candidate_binding_mismatch|operator_candidate_frozen_scope_mismatch|operator_intake_verified_writer_required/);
      }
      for (const conflictTaskIds of [["task_2", "task_2"], [null], Array.from({ length: 4097 }, (_, i) => "task_" + i)]) {
        await assert.rejects(mutateOperatorCandidateState(async () => ({ ...verification, conflictTaskIds }), adopt), /verification_invalid/);
      }
      await mutateScopeDispatchState(state => { state.tasks[0].impactPlan = structuredClone(frozenScopePlan); });
      await assert.rejects(mutateOperatorCandidateState(async () => verification, (state, verified) => adopt(state, verified)), /frozen_scope_mismatch/);
      await mutateOperatorCandidateState(async () => verification, (state, verified) => {
        adopt(state, verified); delete state.tasks[0].impactScopePlan;
      });
      assert.deepEqual((await readDatabaseState()).tasks[0].impactPlan, frozenScopePlan);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operator verification reruns on optimistic replay against the fresh snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-replay-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, operatorCandidateTestScript() + `
      let attempts = 0, entered, resume;
      const started = new Promise(resolve => { entered = resolve; });
      const pause = new Promise(resolve => { resume = resolve; });
      const pending = mutateOperatorCandidateState(async state => {
        attempts++;
        if (attempts === 1) { entered(); await pause; }
        else assert.equal(state.meta.concurrentChange, true);
        return verification;
      }, (state, verified) => adopt(state, verified), { operationName: "test.operator_replay" });
      await started;
      await mutateDatabaseState(state => { state.meta.concurrentChange = true; });
      resume(); await pending;
      assert.equal(attempts, 2);
      assert.equal((await readDatabaseState()).meta.concurrentChange, true);
      assert.equal((await readDatabaseState()).tasks[0].status, "builder_review");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operator final transaction fence catches a coordination lease racing without a state-version bump", async () => {
  for (const leaseTaskId of ["task_1", "task_2", "task_3"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-lease-race-"));
    try {
      const state = baseState(); state.tasks.push({ ...state.tasks[0], id: "task_2" }, { ...state.tasks[0], id: "task_3" });
      await writeLegacyState(root, state);
      await runStoreScript(root, operatorCandidateTestScript() + `
        import { claimResourceLease } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/coordination.js")).href)};
        verification.dispositionTaskIds = ["task_2"];
        verification.conflictTaskIds = ["task_3"];
        await assert.rejects(mutateOperatorCandidateState(async () => verification, async (state, verified) => {
          const task = state.tasks.find(item => item.id === ${JSON.stringify(leaseTaskId)});
          const lease = await claimResourceLease({ resourceKey: "test:adoption-race", aggregateType: "task", aggregateId: task.id,
            ownerProcessIdentity: "test:race-worker", expectedStateVersion: task.stateVersion, leaseTtlMs: 10000 });
          assert.equal(lease.acquired, true);
          adopt(state, verified);
        }), /operator_candidate_coordination_lease_active/);
        assert.equal((await readDatabaseState()).tasks[0].operatorIntake, undefined);
      `);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("operator writer refuses queued or running ownership before invoking its mutator", async () => {
  for (const status of ["queued", "running"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operator-live-run-"));
    try {
      const state = baseState(); state.runs = [{ id: "run_owned", taskId: "task_1", role: "builder", status }];
      await writeLegacyState(root, state);
      await runStoreScript(root, operatorCandidateTestScript() + `
        let called = false;
        await assert.rejects(mutateOperatorCandidateState(async () => verification, () => { called = true; }), /operator_candidate_active_run/);
        assert.equal(called, false);
      `);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

function prerequisiteRecoveryTestScript() {
  return operatorCandidateTestScript() + `
    import { DatabaseSync } from 'node:sqlite';
    import { DATABASE_FILE, claimFailureContainmentPaidAttempt, recordFailureContainmentActivity,
      openFailureContainmentCircuit, scheduleFailureContainmentBackoff, readFailureIncidents,
      readPrerequisiteFailureRecovery } from ${JSON.stringify(stateDatabaseModuleUrl)};
    import { failureEvidence } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/failure-containment.js")).href)};
    const fault = { taskId: 'task_2', action: 'start_builder', provider: 'codex', reasonCode: 'output_guard_exceeded',
      evidence: { configurationDigest: 'sha256:' + '1'.repeat(64), policyDigest: 'sha256:' + '2'.repeat(64) } };
    await claimFailureContainmentPaidAttempt(fault); await claimFailureContainmentPaidAttempt(fault);
    const ancestor = (await claimFailureContainmentPaidAttempt(fault)).incident;
    assert.equal(ancestor.state, 'open');
    const blocker = { type: 'circuit', reason: ancestor.reasonCode, incidentId: ancestor.incidentId,
      incidentGeneration: ancestor.generation, evidenceDigest: ancestor.evidenceDigest, attempts: ancestor.paidAttempts };
    await mutateDatabaseState(state => { state.tasks.find(task => task.id === 'task_2').automationBlocker = blocker; });
    const changed = { ...fault.evidence, policyDigest: 'sha256:' + '3'.repeat(64) };
    const successor = await recordFailureContainmentActivity({ ...fault, evidence: changed, type: 'cheap_probe', outcome: 'passed',
      verifier: { id: 'policy_probe', outcome: 'passed', evidenceDigest: failureEvidence(changed).digest } });
    const prerequisite = (await readDatabaseState()).tasks.find(task => task.id === 'task_2');
    const recovery = await readPrerequisiteFailureRecovery(prerequisite);
    const disposition = { taskId: 'task_2', expectedStateVersion: prerequisite.stateVersion,
      evidenceDigest: 'sha256:' + '4'.repeat(64), reason: 'Verified existing fixture prerequisite.',
      sourceSha: candidate.baseSha, failureRecovery: recovery };
    verification.dispositionTaskIds = ['task_2']; verification.dispositions = [disposition];
    function dispose(state, verified) {
      const task = state.tasks.find(task => task.id === 'task_2');
      delete task.automationBlocker; task.status = 'closed';
      task.preexistingWorkDisposition = { schemaVersion: 1, ...structuredClone(verified.dispositions[0]),
        kind: 'preexisting_work_verified', principal: 'fixture-owner', recordedAt: new Date().toISOString() };
    }
    function version() { const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
      try { return db.prepare('SELECT version FROM state_meta WHERE singleton_id=1').get().version; } finally { db.close(); } }
  `;
}

function nativePrerequisiteRecoveryTestScript() {
  return operatorCandidateTestScript() + `
    import { DatabaseSync } from 'node:sqlite';
    import { DATABASE_FILE, claimFailureContainmentPaidAttempt, recordFailureContainmentActivity,
      openFailureContainmentCircuit, scheduleFailureContainmentBackoff, readFailureIncidents,
      readPrerequisiteFailureRecovery } from ${JSON.stringify(stateDatabaseModuleUrl)};
    import { failureEvidence } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/failure-containment.js")).href)};
    import { claimCurrentFailureAttempt, claimRuns, completeRun, failureEvidenceForRun } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/runner.js")).href)};
    import { reconcileAutomationStateInState } from ${JSON.stringify(storeModuleUrl)};
    const now = offset => new Date(Date.now() + offset).toISOString();
    const run = { id: 'run_prerequisite', taskId: 'task_2', projectId: 'project_1', group: 'builder', role: 'builder',
      actionType: 'start_builder', provider: 'codex-sdk', status: 'running', executionCommitSha: candidate.baseSha,
      candidateCycle: 0, startedAt: now(-100), impactPlan: { manifest: { digest: frozenScopePlan.manifest.digest } },
      failureContainmentAdmission: { consulted: true, decision: 'admitted', authority: 'dispatcher_read_only',
        claimBoundary: 'runner_pre_provider_launch', actionIdentity: 'start_builder', provider: 'codex' } };
    const initialState = await readDatabaseState();
    const evidence = failureEvidence(failureEvidenceForRun({ ...run, project: initialState.projects[0] }, initialState));
    const fault = { taskId: 'task_2', action: 'start_builder', provider: 'codex', reasonCode: 'output_guard_exceeded',
      candidateIdentity: { commitSha: candidate.baseSha }, evidence: evidence.value };
    await claimFailureContainmentPaidAttempt({ ...fault, initiator: 'runner', transport: 'codex_sdk', now: now(-5000) });
    const providerFault = { ...fault, reasonCode: 'provider_unavailable' };
    await claimFailureContainmentPaidAttempt({ ...providerFault, initiator: 'runner', transport: 'codex_sdk', now: now(-4000) });
    await recordFailureContainmentActivity({ ...providerFault, type: 'cheap_probe', outcome: 'failed',
      verifier: { id: 'service_health_probe' }, now: now(-3500) });
    await claimFailureContainmentPaidAttempt({ ...providerFault, initiator: 'runner', transport: 'codex_sdk', now: now(-3000) });
    const repaired = failureEvidence({ ...evidence.value, configurationDigest: 'sha256:' + '5'.repeat(64) });
    const providerSuccessor = await recordFailureContainmentActivity({ ...providerFault, evidence: repaired.value,
      type: 'cheap_probe', outcome: 'passed', now: now(-1000),
      verifier: { id: 'service_health_probe', outcome: 'passed', evidenceDigest: repaired.digest } });
    const providerInput = { ...providerFault, evidence: repaired.value };
    const cancelled = [1, 2].map(index => ({ id: 'run_queued_cancelled_' + index, taskId: run.taskId, projectId: run.projectId,
      group: 'builder', role: 'builder', actionType: 'start_builder', provider: 'codex-cli', status: 'queued',
      createdAt: now(-500 + index), attempt: 3, maxAttempts: 2, failureContainmentAdmission: structuredClone(run.failureContainmentAdmission) }));
    assert.deepEqual(await claimRuns({ state: { meta: {}, projects: initialState.projects, tasks: initialState.tasks,
      runs: cancelled, events: [], comments: [] } }), []);
    for (const row of cancelled) { assert.equal(row.status, 'cancelled'); assert.equal(row.startedAt, undefined); assert.equal(row.failureContainmentClaim, undefined); }
    run.startedAt = now(0);
    await mutateDatabaseState(state => { state.runs.push(...structuredClone(cancelled), structuredClone(run)); });
    assert.equal((await claimCurrentFailureAttempt(run)).incident.incidentId, providerSuccessor.incidentId);
    const terminal = await completeRun(run.id, { status: 'failed', exitCode: 'command_output_budget_exceeded' });
    assert.equal(terminal.failureContainmentError, undefined);
    assert.equal(terminal.failureContainmentClaim.reasonCode, 'output_guard_exceeded');
    await mutateDatabaseState(state => reconcileAutomationStateInState(state));
    const ancestor = (await readFailureIncidents({ taskId: 'task_2' })).find(item => item.reasonCode === 'output_guard_exceeded');
    const changed = { ...evidence.value, policyDigest: 'sha256:' + '3'.repeat(64) };
    const successor = await recordFailureContainmentActivity({ ...fault, evidence: changed, type: 'cheap_probe', outcome: 'passed',
      verifier: { id: 'policy_probe', outcome: 'passed', evidenceDigest: failureEvidence(changed).digest } });
    const prerequisite = (await readDatabaseState()).tasks.find(task => task.id === 'task_2');
    assert.equal(prerequisite.automationBlocker.incidentGeneration, undefined);
    assert.equal(prerequisite.automationBlocker.evidenceDigest, undefined);
    const recovery = await readPrerequisiteFailureRecovery(prerequisite);
    assert.equal(recovery.supportingAdmissions[0].terminalRunId, run.id);
    verification.dispositionTaskIds = ['task_2']; verification.dispositions = [{ taskId: 'task_2',
      expectedStateVersion: prerequisite.stateVersion, evidenceDigest: 'sha256:' + '4'.repeat(64),
      reason: 'Verified existing fixture prerequisite.', sourceSha: candidate.baseSha, failureRecovery: recovery }];
    function dispose(state, verified) {
      const task = state.tasks.find(task => task.id === 'task_2'); delete task.automationBlocker; task.status = 'closed';
      task.preexistingWorkDisposition = { schemaVersion: 1, ...structuredClone(verified.dispositions[0]),
        kind: 'preexisting_work_verified', principal: 'fixture-owner', recordedAt: new Date().toISOString() };
    }
    function version() { const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
      try { return db.prepare('SELECT version FROM state_meta WHERE singleton_id=1').get().version; } finally { db.close(); } }
  `;
}

test("native historical admission proof cannot be forged by generic writes or changed in its adoption proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-native-prerequisite-ingress-"));
  try {
    const state = baseState(); state.tasks.push({ id: "task_2", projectId: "project_1", title: "Verified prerequisite", status: "blocked" });
    await writeLegacyState(root, state);
    await runStoreScript(root, nativePrerequisiteRecoveryTestScript() + `
      const before = await readDatabaseState(), stateVersion = version();
      await assert.rejects(mutateDatabaseState(state => { dispose(state, verification); adopt(state, verification); },
        { operatorCandidateVerification: verification }), /preexisting_work_disposition_verified_writer_required|operator_intake_verified_writer_required/);
      const forged = structuredClone(verification);
      forged.dispositions[0].failureRecovery.supportingAdmissions[0].terminalRunRecordDigest = 'sha256:' + '0'.repeat(64);
      await assert.rejects(mutateOperatorCandidateState(async () => forged, (state, verified) => {
        dispose(state, verified); adopt(state, verified);
      }), /operator_prerequisite_failure_changed/);
      for (const edit of [state => { state.runs[0].notes = 'Changed during adoption'; },
        state => { state.runs.push({ ...state.runs[0], id: 'run_proposed_other' }); },
        state => { state.runs = []; }]) {
        await assert.rejects(mutateOperatorCandidateState(async () => verification, (state, verified) => {
          edit(state); dispose(state, verified); adopt(state, verified);
        }), /operator_prerequisite_run_changed/);
      }
      assert.deepEqual((await readDatabaseState()).tasks, before.tasks);
      assert.deepEqual((await readDatabaseState()).runs, before.runs);
      assert.equal(version(), stateVersion);
      const ledger = await readFailureIncidents({ taskId: 'task_2' });
      await mutateOperatorCandidateState(async () => verification, (state, verified) => { dispose(state, verified); adopt(state, verified); });
      assert.equal((await readDatabaseState()).tasks[1].status, 'closed');
      assert.deepEqual((await readDatabaseState()).runs, before.runs);
      assert.deepEqual(await readFailureIncidents({ taskId: 'task_2' }), ledger);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supporting native admission lineage and run races are rechecked inside the final SQL fence", async () => {
  for (const race of ["open", "backoff", "paid", "probe", "generation", "run_claim", "run_material", "new_run", "old_run"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-native-prerequisite-race-"));
    try {
      const state = baseState(); state.tasks.push({ id: "task_2", projectId: "project_1", title: "Verified prerequisite", status: "blocked" });
      await writeLegacyState(root, state);
      await runStoreScript(root, nativePrerequisiteRecoveryTestScript() + `
        const before = (await readDatabaseState()).tasks, stateVersion = version();
        await assert.rejects(mutateOperatorCandidateState(async () => verification, async (state, verified) => {
          const race = ${JSON.stringify(race)};
          if (race === 'open') await openFailureContainmentCircuit(providerInput);
          if (race === 'backoff') await scheduleFailureContainmentBackoff({ ...providerInput, delayMs: 60000 });
          if (race === 'paid') await claimFailureContainmentPaidAttempt(providerInput);
          if (race === 'probe') await recordFailureContainmentActivity({ ...providerInput, type: 'cheap_probe', outcome: 'passed', verifier: { id: 'service_health_probe' } });
          if (race === 'generation') {
            const next = failureEvidence({ ...providerInput.evidence, configurationDigest: 'sha256:' + '6'.repeat(64) });
            await recordFailureContainmentActivity({ ...providerInput, evidence: next.value, type: 'cheap_probe', outcome: 'passed',
              verifier: { id: 'service_health_probe', outcome: 'passed', evidenceDigest: next.digest } });
          }
          if (['run_claim', 'run_material', 'new_run', 'old_run'].includes(race)) {
            const db = new DatabaseSync(DATABASE_FILE);
            try {
              db.exec('BEGIN IMMEDIATE');
              const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id), saved = JSON.parse(row.payload);
              if (race === 'new_run' || race === 'old_run') {
                const other = { id: 'run_unrecognized_later', taskId: saved.taskId, projectId: saved.projectId, role: 'builder',
                  status: 'failed', startedAt: race === 'old_run' ? now(-10000) : saved.completedAt,
                  completedAt: race === 'old_run' ? now(-9000) : saved.completedAt };
                db.prepare('INSERT INTO runs (id,sequence,project_id,task_id,status,role,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
                  .run(other.id, row.sequence + 1, other.projectId, other.taskId, other.status, other.role, '', JSON.stringify(other));
              } else {
                if (race === 'run_claim') saved.failureContainmentClaim.evidenceDigest = 'sha256:' + '0'.repeat(64);
                if (race === 'run_material') saved.notes = 'Changed bound run record without changing task snapshot version';
                db.prepare('UPDATE runs SET payload = ? WHERE id = ?').run(JSON.stringify(saved), run.id);
              }
              db.exec('COMMIT');
            } finally { db.close(); }
          }
          assert.equal(version(), stateVersion, 'Independent ledger/run writes leave task CAS unchanged');
          dispose(state, verified); adopt(state, verified);
        }), /operator_prerequisite_failure_unresolved|operator_prerequisite_failure_changed/);
        assert.deepEqual((await readDatabaseState()).tasks, before);
        assert.equal(version(), stateVersion, 'Neither proposed task change committed');
      `);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("prerequisite recovery receipts require the private writer and cannot be rewritten or imported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-prerequisite-ingress-"));
  try {
    const state = baseState(); state.tasks.push({ id: "task_2", projectId: "project_1", title: "Verified prerequisite", status: "blocked" });
    await writeLegacyState(root, state);
    await runStoreScript(root, prerequisiteRecoveryTestScript() + `
      const before = (await readDatabaseState()).tasks;
      await assert.rejects(mutateDatabaseState(state => dispose(state, verification), {
        operatorCandidateCapability: 'studioops.operator-candidate-write', operatorCandidateVerification: verification,
      }), /preexisting_work_disposition_verified_writer_required/);
      const replacement = await readDatabaseState(); dispose(replacement, verification);
      await assert.rejects(writeDatabaseState(replacement), /preexisting_work_disposition_verified_writer_required/);
      const forged = structuredClone(verification); forged.dispositions[0].failureRecovery.successorEvidenceDigest = 'sha256:' + '0'.repeat(64);
      await assert.rejects(mutateOperatorCandidateState(async () => forged, (state, verified) => {
        dispose(state, verified); adopt(state, verified);
      }), /operator_prerequisite_failure_changed/);
      assert.deepEqual((await readDatabaseState()).tasks, before);
      await mutateOperatorCandidateState(async () => verification, (state, verified) => { dispose(state, verified); adopt(state, verified); });
      const saved = await readDatabaseState();
      for (const edit of [state => { delete state.tasks[1].preexistingWorkDisposition; },
        state => { state.tasks[1].preexistingWorkDisposition.failureRecovery.outcome = 'forged'; },
        state => { state.tasks = state.tasks.filter(task => task.id !== 'task_2'); }]) {
        await assert.rejects(mutateDatabaseState(edit), /preexisting_work_disposition_immutable/);
      }
      assert.deepEqual((await readDatabaseState()).tasks, saved.tasks);
      assert.equal((await readFailureIncidents({ taskId: 'task_2' })).find(item => item.incidentId === ancestor.incidentId).paidAttempts, 2);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prerequisite failure ledger races are fenced at adoption commit without a task version change", async () => {
  for (const race of ["open", "backoff", "paid", "new_fault", "changed_proof", "new_generation"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-prerequisite-race-"));
    try {
      const state = baseState(); state.tasks.push({ id: "task_2", projectId: "project_1", title: "Verified prerequisite", status: "blocked" });
      await writeLegacyState(root, state);
      await runStoreScript(root, prerequisiteRecoveryTestScript() + `
        const before = (await readDatabaseState()).tasks, stateVersion = version();
        await assert.rejects(mutateOperatorCandidateState(async () => verification, async (state, verified) => {
          const race = ${JSON.stringify(race)};
          if (race === 'open') await openFailureContainmentCircuit({ ...fault, evidence: changed });
          if (race === 'backoff') await scheduleFailureContainmentBackoff({ ...fault, evidence: changed, delayMs: 60000 });
          if (race === 'paid') await claimFailureContainmentPaidAttempt({ ...fault, evidence: changed });
          if (race === 'new_fault') await claimFailureContainmentPaidAttempt({ ...fault, reasonCode: 'service_unhealthy' });
          if (race === 'changed_proof') await recordFailureContainmentActivity({ ...fault, evidence: changed, type: 'retry_avoided' });
          if (race === 'new_generation') {
            const next = { ...changed, policyDigest: 'sha256:' + '5'.repeat(64) };
            await recordFailureContainmentActivity({ ...fault, evidence: next, type: 'cheap_probe', outcome: 'passed',
              verifier: { id: 'policy_probe', outcome: 'passed', evidenceDigest: failureEvidence(next).digest } });
          }
          assert.equal(version(), stateVersion, 'Ledger transitions do not advance task snapshot CAS');
          dispose(state, verified); adopt(state, verified);
        }), /operator_prerequisite_failure_unresolved|operator_prerequisite_failure_changed/);
        assert.deepEqual((await readDatabaseState()).tasks, before, 'Both tasks roll back, including the stale pointer');
        assert.equal(version(), stateVersion);
      `);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

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
    assert.equal(state.meta.stateIntegrityVersion, 7);
    assert.equal(state.meta.lifecycleMigration.schemaVersion, 1);
    assert.equal(state.meta.lifecycleMigration.backupVerified, true);
    assert.equal(state.meta.failureContainmentMigration.schemaVersion, 1);
    assert.equal(state.meta.failureContainmentMigration.contract, "studioops.failure-containment.v1");
    assert.equal(state.meta.failureContainmentMigration.backupVerified, true);
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
      assert.ok(migratedDb.prepare("PRAGMA index_list(failure_incidents)").all()
        .some((entry) => entry.name === "idx_failure_incidents_task_fingerprint_state"));
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

test("integrity v7 quarantines active legacy candidates that reference invalidated reviews", async () => {
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
    assert.equal(persisted.meta.stateIntegrityVersion, 7);
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
    assert.equal(persisted.meta.stateIntegrityVersion, 7);
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
    assert.equal(persisted.meta.stateIntegrityVersion, 7);
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

test("conflicting idempotent mutations finish through optimistic replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-serialized-replay-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    await Promise.all(Array.from({ length: 4 }, (_, index) => runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state.meta.serializedReplayWorkers = state.meta.serializedReplayWorkers || [];
        if (!state.meta.serializedReplayWorkers.includes(${index})) {
          state.meta.serializedReplayWorkers.push(${index});
        }
      }, { operationName: "test.serialized_replay_${index}", idempotent: true });
    `)));

    const state = readPersistedState(root);
    assert.deepEqual([...state.meta.serializedReplayWorkers].sort(), [0, 1, 2, 3]);
    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const timings = db.prepare(`
        SELECT outcome, retry_count
        FROM database_contention_events
        WHERE operation_name LIKE 'test.serialized_replay_%'
      `).all();
      assert.equal(timings.length, 4);
      assert.equal(timings.some((timing) => timing.outcome === "optimistic_replay"), true);
      assert.equal(
        timings.every((timing) => timing.outcome !== "optimistic_replay" || Number(timing.retry_count) >= 1),
        true,
      );
      assert.equal(
        timings.every((timing) => timing.outcome !== "committed" || Number(timing.retry_count) === 0),
        true,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-process asynchronous mutations retain every update through optimistic replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-shared-connection-"));
  try {
    await writeLegacyState(root);
    const { stdout } = await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      import { databaseContentionHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      await Promise.all(Array.from({ length: 4 }, (_, index) => mutateState(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state.meta.workers = state.meta.workers || [];
        if (!state.meta.workers.includes(index)) state.meta.workers.push(index);
      }, { operationName: "test.same_process_" + index })));
      assert.deepEqual([...(await readState()).meta.workers].sort(), [0, 1, 2, 3]);
      process.stdout.write(JSON.stringify(await databaseContentionHealth()));
    `);
    const health = JSON.parse(stdout);
    assert.equal(health.successfulOperationCount, 4);
    assert.equal(health.failedOperationCount, 0);
    assert.ok(health.recent.some((event) => event.outcome === "optimistic_replay"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default empty candidate identity remains eligible for exact PR URL recording", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-empty-candidate-record-"));
  try {
    const initial = baseState();
    initial.tasks[0] = { ...initial.tasks[0], status: "blocked", stateVersion: 3,
      reviewCycle: 0, reviewSubjectCycle: 0, reviewSubjectSha: "", branchName: "",
      candidateIdentity: { commitSha: "", treeSha: "", baseSha: "", branch: "", candidateCycle: 0,
        impactEvidence: { changedFiles: [], classifications: [], unknown: true,
          backendRequired: true, frontend: false, accessibility: false }, operationalLocalArtifactRef: "" } };
    await writeLegacyState(root, initial);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { addComment, updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      const before = (await readState()).tasks[0];
      const task = await updateTask("task_1", {prUrl: " https://example.invalid/example/project/pull/12 "});
      assert.equal(task.prUrl, "https://example.invalid/example/project/pull/12");
      assert.deepEqual(task, {...before, prUrl: task.prUrl, updatedAt: task.updatedAt});
      assert.equal(task.stateVersion, 3);
      await addComment("task_1", "Recorded against the held prerequisite");
      assert.deepEqual((await readState()).tasks[0], task);
      await withStateDatabaseConnection(db => {
        const rows = db.prepare("SELECT outcome FROM database_contention_events WHERE operation_name IN ('task.add_comment', 'task.update')").all();
        assert.equal(rows.length, 2);
        assert.ok(rows.every(row => row.outcome === "current_record_committed"));
      });
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("five public recording writers commit every comment and exact PR URL against current rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-writers-"));
  try {
    const initial = baseState();
    initial.meta.recordingFixture = { unrelated: "preserved", nested: [1, 2, 3] };
    for (let index = 0; index < 5; index += 1) {
      initial.tasks.push({ id: `task_writer_${index}`, projectId: "project_1", title: `Writer ${index}`,
        status: "blocked", reviewCycle: 0, stateVersion: 3, dependsOnTaskIds: ["task_1"],
        automationBlocker: { type: "configuration", reason: "Retained prerequisite" } });
    }
    for (let index = 0; index < 1000; index += 1) {
      initial.tasks.push({ id: `task_history_${index}`, projectId: "project_1", title: `History ${index}`,
        status: "ready", description: "Unrelated task metadata", stateVersion: 2 });
      initial.comments.push({ id: `comment_${index + 1}`, taskId: `task_history_${index}`,
        author: "Fixture", body: `Retained comment ${index}`, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    for (let index = 0; index < 1200; index += 1) {
      initial.events.push({ id: `event_${index + 1}`, projectId: "project_1", taskId: "task_1",
        type: `retained_${index}`, message: "Unrelated history", createdAt: "2026-01-01T00:00:00.000Z" });
    }
    for (const id of ["comment_1500_extra", "comment_0x600", "comment_2e3_extra"]) {
      initial.comments.push({ id, taskId: "task_1", author: "Fixture", body: "Active ID semantics" });
    }
    await writeLegacyState(root, initial);
    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      import { withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      await withStateDatabaseConnection(db => {
        const insert = db.prepare("INSERT INTO operational_archive(entity_type, entity_id, project_id, task_id, created_at, archived_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const [kind, id] of [["comments", "comment_99999999"], ["events", "event_99999999"]])
          insert.run(kind, id, "project_1", "task_1", "", "", JSON.stringify({id, retained: true}));
      });
    `);
    const before = readPersistedState(root);
    const databasePath = path.join(root, "data", "mission-control.sqlite3");
    const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
    const beforeVersion = beforeDb.prepare("SELECT version FROM state_meta").get().version;
    beforeDb.close();
    const results = await Promise.all(Array.from({ length: 5 }, (_, worker) => runStoreScript(root, `
      import assert from "node:assert/strict";
      import { addComment, updateTask } from ${JSON.stringify(storeModuleUrl)};
      const ids = [];
      for (let index = 0; index < 10; index += 1) {
        const result = await addComment("task_1", " writer-${worker}-" + index + " ", "Recording test");
        assert.equal(result.body, "writer-${worker}-" + index);
        ids.push(result.id);
        const task = await updateTask("task_writer_${worker}", { prUrl: " https://example.invalid/pull/${worker}-" + index + " " });
        assert.equal(task.prUrl, "https://example.invalid/pull/${worker}-" + index);
        assert.equal(task.stateVersion, 3);
      }
      process.stdout.write(JSON.stringify(ids));
    `)));
    const ids = results.flatMap(({ stdout }) => JSON.parse(stdout));
    assert.equal(new Set(ids).size, 50);
    assert.deepEqual(ids.map(id => Number(id.split("_")[1])).sort((a, b) => a - b),
      Array.from({ length: 50 }, (_, index) => 2001 + index));
    const after = readPersistedState(root);
    assert.deepEqual(after.tasks.filter(item => item.id.startsWith("task_history_")),
      before.tasks.filter(item => item.id.startsWith("task_history_")));
    assert.deepEqual(after.tasks.find(item => item.id === "task_1"), before.tasks.find(item => item.id === "task_1"));
    assert.deepEqual(after.comments.filter(item => !ids.includes(item.id)), before.comments);
    assert.deepEqual(after.meta.recordingFixture, before.meta.recordingFixture);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.reviews, before.reviews);
    assert.deepEqual(after.qaBundles, before.qaBundles);
    assert.equal(after.comments.length, before.comments.length + 50);
    for (let worker = 0; worker < 5; worker += 1) {
      const task = after.tasks.find(item => item.id === `task_writer_${worker}`);
      const expected = { ...before.tasks.find(item => item.id === task.id), prUrl: `https://example.invalid/pull/${worker}-9`, updatedAt: task.updatedAt };
      assert.deepEqual(task, expected);
      for (let index = 0; index < 10; index += 1)
        assert.equal(after.comments.filter(item => item.body === `writer-${worker}-${index}`).length, 1);
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT version FROM state_meta").get().version, beforeVersion + 100);
      const events = db.prepare("SELECT payload FROM events UNION ALL SELECT payload FROM operational_archive WHERE entity_type = 'events'")
        .all().map(row => JSON.parse(row.payload));
      assert.equal(events.filter(item => item.type === "comment_created").length, 50);
      assert.equal(events.filter(item => item.type === "task_updated").length, 50);
      assert.equal(after.events.filter(item => item.type === "comment_created").length, 40);
      assert.equal(after.meta.operationalArchive.events, 10);
      assert.equal(db.prepare("SELECT count(*) count FROM operational_archive WHERE entity_id = 'comment_99999999'").get().count, 1);
      assert.equal(db.prepare("SELECT count(*) count FROM operational_archive WHERE entity_id = 'event_99999999'").get().count, 1);
      const timings = db.prepare("SELECT outcome FROM database_contention_events WHERE operation_name IN ('task.add_comment', 'task.update')").all();
      assert.equal(timings.length, 100);
      assert.ok(timings.every(item => item.outcome === "current_record_committed"));
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current recording refreshes task and metadata after connection ownership is granted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-refresh-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { addComment, updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { withStateDatabaseConnection, readDatabaseStateCached } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      const first = await readDatabaseStateCached();
      let entered, resume;
      const ready = new Promise(resolve => { entered = resolve; });
      const pause = new Promise(resolve => { resume = resolve; });
      const owner = withStateDatabaseConnection(async db => {
        entered(); await pause;
        db.exec("BEGIN IMMEDIATE");
        const row = db.prepare("SELECT payload FROM tasks WHERE id = 'task_1'").get();
        const task = JSON.parse(row.payload);
        task.title = "Current title";
        task.description = "Committed while the recorder waited";
        task.stateVersion += 1;
        db.prepare("UPDATE tasks SET payload = ?, state_version = ? WHERE id = ?").run(JSON.stringify(task), task.stateVersion, task.id);
        const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta").get().payload);
        meta.concurrentMarker = { retained: true };
        db.prepare("UPDATE state_meta SET payload = ?, version = version + 1").run(JSON.stringify(meta));
        db.exec("COMMIT");
      });
      await ready;
      const pending = addComment("task_1", "Current record", "Recording test");
      resume(); await owner; await pending;
      const task = await updateTask("task_1", {prUrl: " https://example.invalid/pull/1 "});
      assert.equal(task.title, "Current title");
      assert.equal(task.description, "Committed while the recorder waited");
      assert.equal(task.stateVersion, first.tasks[0].stateVersion + 1);
      assert.equal(task.prUrl, "https://example.invalid/pull/1");
      const second = await readDatabaseStateCached();
      assert.notEqual(second, first);
      assert.equal(second.meta.concurrentMarker.retained, true);
      assert.equal(second.events.find(event => event.type === "comment_created").message, "Comment added to Current title");
      await updateTask("task_1", {prUrl: task.prUrl});
      assert.equal((await readState()).events.filter(event => event.type === "task_updated").length, 2,
        "a repeated metadata request keeps the existing task_updated semantics");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current recording rechecks a newly acquired maintenance lease and rolls back both operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-maintenance-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { addComment, updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      let entered, resume;
      const ready = new Promise(resolve => { entered = resolve; });
      const pause = new Promise(resolve => { resume = resolve; });
      const owner = withStateDatabaseConnection(async db => {
        entered(); await pause;
        db.exec("BEGIN IMMEDIATE");
        const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta").get().payload);
        meta.selfUpdateLease = {id: "maintenance_recording", ownerPid: "other", expiresAt: new Date(Date.now()+60000).toISOString()};
        db.prepare("UPDATE state_meta SET payload = ?, version = version + 1").run(JSON.stringify(meta));
        db.exec("COMMIT");
      });
      await ready;
      const comment = assert.rejects(addComment("task_1", "Not committed", "Recording test"), {code: "STUDIOOPS_MAINTENANCE"});
      const patch = assert.rejects(updateTask("task_1", {prUrl: "https://example.invalid/pull/1"}), {code: "STUDIOOPS_MAINTENANCE"});
      resume(); await Promise.all([owner, comment, patch]);
      const after = await readState();
      assert.equal(after.comments.length, 0);
      assert.equal(after.events.length, 0);
      assert.equal(after.tasks[0].prUrl, undefined);
      assert.equal(after.meta.selfUpdateLease.id, "maintenance_recording");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recording accepts only closed inert operations and preserves off-lock generic patch preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-input-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { addComment, updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { DATABASE_FILE, recordCurrentTaskOperation, withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      let getterCalls = 0;
      for (const operation of [
        {kind: "add_comment", taskId: "task_1", body: "Test", author: "Fixture", callback() {}},
        {kind: "set_pr_url", taskId: "task_1", prUrl: "url", pure: true},
        {kind: "set_pr_url", taskId: "task_1", prUrl: "url", status: "done"},
        {kind: "other", taskId: "task_1"},
        Object.defineProperty({kind: "set_pr_url", taskId: "task_1"}, "prUrl", {enumerable: true, get() { getterCalls++; return "url"; }}),
        Promise.resolve({kind: "set_pr_url", taskId: "task_1", prUrl: "url"}),
      ]) await assert.rejects(recordCurrentTaskOperation(operation), TypeError);
      assert.equal(getterCalls, 0);
      assert.equal((await readState()).events.length, 0);
      const probe = new DatabaseSync(DATABASE_FILE);
      probe.exec("PRAGMA busy_timeout = 1");
      try {
        const patch = Object.defineProperty({}, "prUrl", {enumerable: true, get() {
          probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); getterCalls++;
          return " https://example.invalid/pull/2 ";
        }});
        assert.equal((await updateTask("task_1", patch)).prUrl, "https://example.invalid/pull/2");
        assert.ok(getterCalls > 0, "an accessor patch stays on off-lock generic preparation");
        await updateTask("task_1", {prUrl: "https://example.invalid/pull/3", description: "Mixed patch"});
        const outcomes = probe.prepare("SELECT outcome FROM database_contention_events WHERE operation_name = 'task.update'").all();
        assert.equal(outcomes.length, 2);
        assert.ok(outcomes.every(event => event.outcome === "committed"));
        const body = {toString() { probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); return "Generic converted body"; }};
        assert.equal((await addComment("task_1", body)).body, "Generic converted body");
      } finally { probe.close(); }
      await assert.rejects(withStateDatabaseConnection(() => addComment("task_1", "Nested")), {code: "STUDIOOPS_DATABASE_TRANSACTION_REENTRY"});
      await assert.rejects(addComment("missing", ""), /Unknown task: missing/);
      await assert.rejects(addComment("task_1", "   "), /Comment body is required/);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact PR URL recording validates current relationships and defers native candidate writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-policy-"));
  try {
    const initial = baseState();
    initial.tasks.push({id: "task_2", projectId: "project_1", title: "Dependency", status: "ready"});
    await writeLegacyState(root, initial);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { recordCurrentTaskOperation, withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      await withStateDatabaseConnection(db => {
        const task = JSON.parse(db.prepare("SELECT payload FROM tasks WHERE id = 'task_1'").get().payload);
        task.dependsOnTaskIds = ["missing"];
        db.prepare("UPDATE tasks SET payload = ? WHERE id = ?").run(JSON.stringify(task), task.id);
      });
      await assert.rejects(updateTask("task_1", {prUrl: "https://example.invalid/pull/1"}), /Unknown dependency task: missing/);
      assert.equal((await readState()).events.length, 0);
      await withStateDatabaseConnection(db => {
        const task = JSON.parse(db.prepare("SELECT payload FROM tasks WHERE id = 'task_1'").get().payload);
        task.dependsOnTaskIds = ["task_2"];
        task.reviewCycle = task.reviewSubjectCycle = 1;
        task.reviewSubjectSha = "a".repeat(40);
        task.candidateIdentity = {commitSha: task.reviewSubjectSha, candidateCycle: 1};
        db.prepare("UPDATE tasks SET payload = ? WHERE id = ?").run(JSON.stringify(task), task.id);
      });
      const before = await readState();
      assert.deepEqual(await recordCurrentTaskOperation({kind: "set_pr_url", taskId: "task_1", prUrl: "https://example.invalid/pull/2"}), {handled: false});
      assert.deepEqual(await readState(), before, "unsupported native authority is never rewritten by the narrow port");
      await updateTask("task_1", {prUrl: " https://example.invalid/pull/2 "});
      const after = await readState();
      assert.equal(after.tasks[0].prUrl, "https://example.invalid/pull/2");
      assert.deepEqual(after.tasks[0].candidateIdentity, before.tasks[0].candidateIdentity);
      assert.equal(after.tasks[0].reviewSubjectSha, before.tasks[0].reviewSubjectSha);
      await withStateDatabaseConnection(db => {
        const outcome = db.prepare("SELECT outcome FROM database_contention_events WHERE operation_name = 'task.update'").get();
        assert.equal(outcome.outcome, "committed", "native writes retain generic validation");
      });
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current recording rolls back late SQL failures and its finite execution deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-current-record-rollback-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { addComment, updateTask, readState } from ${JSON.stringify(storeModuleUrl)};
      import { withStateDatabaseConnection, databaseContentionHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      const before = await readState();
      let version;
      await withStateDatabaseConnection(db => {
        version = db.prepare("SELECT version FROM state_meta").get().version;
        db.exec("CREATE TRIGGER reject_recorded_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic late event rejection'); END");
      });
      await assert.rejects(addComment("task_1", "Rolled back comment"), /synthetic late event rejection/);
      await assert.rejects(updateTask("task_1", {prUrl: "https://example.invalid/pull/1"}), /synthetic late event rejection/);
      assert.deepEqual(await readState(), before);
      await withStateDatabaseConnection(db => {
        assert.equal(db.prepare("SELECT version FROM state_meta").get().version, version);
        db.exec("DROP TRIGGER reject_recorded_event");
        db.function("pause_recording", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1050); return 0; });
        db.exec("CREATE TRIGGER delay_recorded_comment AFTER INSERT ON comments BEGIN SELECT pause_recording(); END");
      });
      await assert.rejects(addComment("task_1", "Deadline payload remains private"), {code: "STUDIOOPS_TASK_RECORDING_TIMEOUT"});
      assert.deepEqual(await readState(), before);
      const health = await databaseContentionHealth();
      assert.ok(health.recent.some(item => item.failureCode === "STUDIOOPS_TASK_RECORDING_TIMEOUT"));
      assert.equal(JSON.stringify(health).includes("Deadline payload"), false);
      await withStateDatabaseConnection(db => {
        assert.equal(db.prepare("SELECT version FROM state_meta").get().version, version);
        assert.equal(db.prepare("SELECT count(*) count FROM comments").get().count, 0);
        db.exec("DROP TRIGGER delay_recorded_comment");
      });
      assert.equal((await addComment("task_1", "Later valid request")).id, "comment_1");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("slow replay leaves the writer free and rebases after unrelated commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-replay-consumers-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      import { readDatabaseStateCached, databaseStorageHealth, withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      import { claimResourceLease, listDueExternalOperations } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/coordination.js")).href)};
      await readState();
      let started, resumeFirst, replayStarted, resumeReplay;
      const first = new Promise((resolve) => { started = resolve; });
      const firstPause = new Promise((resolve) => { resumeFirst = resolve; });
      const replay = new Promise((resolve) => { replayStarted = resolve; });
      const replayPause = new Promise((resolve) => { resumeReplay = resolve; });
      let attempts = 0;
      const slow = mutateState(async (state) => {
        attempts += 1;
        if (attempts === 1) { started(); await firstPause; }
        else { replayStarted(); await replayPause; }
        state.meta.slow = true;
      }, { operationName: "test.replay_consumer" });
      await first;
      await mutateState((state) => { state.meta.fast = true; });
      const before = await readDatabaseStateCached();
      resumeFirst();
      await replay;
      assert.equal(await readDatabaseStateCached(), before);
      assert.equal((await readState()).meta.slow, undefined);
      assert.equal((await databaseStorageHealth()).storage, "sqlite");
      assert.deepEqual(await listDueExternalOperations(), []);
      let leaseFinished = false;
      const lease = claimResourceLease({ resourceKey: "test:consumer", aggregateType: "task", aggregateId: "task_1", ownerProcessIdentity: "test:worker", expectedStateVersion: before.tasks[0].stateVersion, leaseTtlMs: 10000 }).then((result) => { leaseFinished = true; return result; });
      const write = mutateState((state) => { state.meta.other = true; });
      try {
        await Promise.race([
          Promise.all([lease, write]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Replay held the database writer")), 1000)),
        ]);
        await withStateDatabaseConnection(() => {}, { deadlineAt: Date.now() + 100 });
        assert.equal(leaseFinished, true);
      } finally { resumeReplay(); }
      await Promise.all([slow, lease, write]);
      const after = await readState();
      assert.equal(after.meta.slow, true);
      assert.equal(after.meta.other, true);
      assert.equal(leaseFinished, true);
      assert.ok(attempts >= 3, "slow replay must refresh after the unrelated write");
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutation validation and serialization do not hold the SQLite writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-prepare-plan-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      import { DATABASE_FILE } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      const probe = new DatabaseSync(DATABASE_FILE);
      probe.exec("PRAGMA busy_timeout = 1");
      let observations = 0;
      try {
        await mutateState((state) => {
          Object.defineProperty(state.tasks[0], "title", { enumerable: true, get() {
            probe.exec("BEGIN IMMEDIATE");
            probe.exec("ROLLBACK");
            observations += 1;
            return "Prepared before locking";
          }});
        }, { idempotent: false });
        assert.ok(observations > 0);
        assert.equal((await readState()).tasks[0].title, "Prepared before locking");
      } finally { probe.close(); }
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle sweeps preserve state versions while real metadata changes persist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-noop-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { mutateState, readState, automationTick } from ${JSON.stringify(storeModuleUrl)};
      import { DATABASE_FILE, readDatabaseStateCached } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await mutateState((state) => { state.meta.operatorPause = { active: true, reason: "test" }; });
      const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
      const version = () => db.prepare("SELECT version FROM state_meta").get().version;
      const before = version(), cached = await readDatabaseStateCached();
      const taskVersion = cached.tasks[0].stateVersion;
      for (let i = 0; i < 3; i += 1) assert.equal((await automationTick()).paused, true);
      assert.equal(version(), before);
      assert.equal(await readDatabaseStateCached(), cached);
      await mutateState((state) => { state.meta.observedAt = "new genuine metadata"; });
      assert.equal(version(), before + 1);
      assert.equal((await readState()).meta.observedAt, "new genuine metadata");
      assert.equal((await readState()).tasks[0].stateVersion, taskVersion);
      db.close();
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stale no-op is reevaluated after another writer changes its input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-stale-noop-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      let ready, resume, calls = 0;
      const started = new Promise(resolve => { ready = resolve; });
      const pause = new Promise(resolve => { resume = resolve; });
      const conditional = mutateState(async (state) => {
        if (++calls === 1) { ready(); await pause; }
        if (state.meta.pendingWork) state.meta.handled = true;
        return Boolean(state.meta.pendingWork);
      });
      await started;
      await mutateState(state => { state.meta.pendingWork = true; });
      resume();
      assert.equal(await conditional, true);
      assert.equal(calls, 2);
      assert.equal((await readState()).meta.handled, true);
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("maintenance acquired during no-op preparation still blocks its commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-noop-maintenance-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      let ready, resume;
      const started = new Promise(resolve => { ready = resolve; });
      const pause = new Promise(resolve => { resume = resolve; });
      const noop = mutateState(async () => { ready(); await pause; });
      await started;
      await mutateState(state => { state.meta.selfUpdateLease = { id: "maintenance_test", ownerPid: "other", expiresAt: new Date(Date.now()+60000).toISOString() }; });
      const rejection = assert.rejects(noop, { code: "STUDIOOPS_MAINTENANCE" });
      resume();
      await rejection;
      assert.equal((await readState()).meta.selfUpdateLease.id, "maintenance_test");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cached display snapshots are immutable and follow committed versions across connections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-cached-read-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { DATABASE_FILE, readDatabaseStateCached, withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      const first = await readDatabaseStateCached();
      assert.equal(first, await readDatabaseStateCached());
      assert.ok(Object.isFrozen(first) && Object.isFrozen(first.tasks) && Object.isFrozen(first.tasks[0]));
      assert.throws(() => { first.tasks[0].title = "must not mutate"; }, TypeError);
      let entered, resume;
      const enteredGate = new Promise((resolve) => { entered = resolve; });
      const pause = new Promise((resolve) => { resume = resolve; });
      const owner = withStateDatabaseConnection(async (db) => {
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE state_meta SET payload = ?, version = version + 1 WHERE singleton_id = 1").run(JSON.stringify({ ...first.meta, marker: "committed" }));
        entered();
        await pause;
        db.exec("COMMIT");
      });
      await enteredGate;
      assert.equal(await readDatabaseStateCached(), first);
      assert.equal((await readDatabaseStateCached()).meta.marker, undefined);
      resume();
      await owner;
      const second = await readDatabaseStateCached();
      assert.notEqual(second, first);
      assert.equal(second.meta.marker, "committed");
      const external = new DatabaseSync(DATABASE_FILE);
      external.prepare("UPDATE state_meta SET payload = ?, version = version + 1 WHERE singleton_id = 1").run(JSON.stringify({ ...second.meta, marker: "external" }));
      external.close();
      const third = await readDatabaseStateCached();
      assert.notEqual(third, second);
      assert.equal(third.meta.marker, "external");
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connection ownership cannot grant an expired waiter after a stalled event loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-owner-deadline-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { withStateDatabaseConnection } from ${JSON.stringify(stateDatabaseModuleUrl)};
      let entered, resume;
      const ready = new Promise((resolve) => { entered = resolve; });
      const pause = new Promise((resolve) => { resume = resolve; });
      const owner = withStateDatabaseConnection(async () => {
        entered();
        await pause;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      });
      await ready;
      let called = false;
      const rejected = assert.rejects(withStateDatabaseConnection(() => { called = true; }, { deadlineAt: Date.now() + 25 }), { code: "STUDIOOPS_DATABASE_CONNECTION_TIMEOUT" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      resume();
      await Promise.all([owner, rejected]);
      assert.equal(called, false);
      await withStateDatabaseConnection(() => {});
    `);
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

test("failed mutation telemetry survives a locked workflow database and the writer process exiting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-failed-telemetry-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      import { DATABASE_FILE, databaseContentionHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      const blocker = new DatabaseSync(DATABASE_FILE);
      blocker.exec("BEGIN IMMEDIATE");
      try {
        await assert.rejects(mutateState((state) => {
          state.meta.privateMarker = "must-not-be-in-health";
        }, { operationName: "test.locked_failure", maxBusyRetries: 0 }), /locked/);
        const health = await databaseContentionHealth();
        assert.equal(health.failedOperationCount, 1);
        assert.equal(health.failureTelemetryAvailable, true);
        assert.equal(health.recent[0].failureCode, "SQLITE_BUSY");
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      await assert.rejects(mutateState(() => {
        throw new Error("private-error-must-not-be-in-health");
      }, { operationName: "test.callback_failure" }));
    `);
    const { stdout } = await runStoreScript(root, `
      import { databaseContentionHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      process.stdout.write(JSON.stringify(await databaseContentionHealth()));
    `);
    const health = JSON.parse(stdout);
    assert.equal(health.failedOperationCount, 2);
    assert.equal(health.operationCount, health.successfulOperationCount + 2);
    assert.equal(health.recent.every((event) => event.outcome === "failed"), true);
    assert.equal(stdout.includes("must-not-be-in-health"), false);
    assert.equal(stdout.includes("private-error"), false);
    const files = await readdir(path.join(root, "data", "database-contention-failures"));
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => name.endsWith(".json")));
    for (const name of files) {
      assert.equal((await stat(path.join(root, "data", "database-contention-failures", name))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failure telemetry retention is capped and unreadable evidence is reported unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-telemetry-retention-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { mkdir, readdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      import { mutateState, readState } from ${JSON.stringify(storeModuleUrl)};
      import { DATABASE_FILE, databaseContentionHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      await readState();
      const directory = path.join(path.dirname(DATABASE_FILE), "database-contention-failures");
      await mkdir(directory, { mode: 0o700 });
      const now = Date.now();
      const event = { operation_name: "test.retention", outcome: "failed", failure_code: "MUTATION_FAILED", wait_ms: 0, duration_ms: 1, retry_count: 0, created_at: new Date(now).toISOString() };
      for (let index = 0; index < 1001; index += 32) {
        await Promise.all(Array.from({ length: Math.min(32, 1001 - index) }, (_, offset) => writeFile(path.join(directory, (now - index - offset) + "-" + randomUUID() + ".json"), JSON.stringify(event), { mode: 0o600 })));
      }
      const expired = (now - 2 * 86400000) + "-" + randomUUID() + ".tmp";
      await writeFile(path.join(directory, expired), "{}", { mode: 0o600 });
      await assert.rejects(mutateState(() => { throw new Error("retention probe"); }));
      const files = await readdir(directory);
      assert.equal(files.length, 1000);
      assert.equal(files.includes(expired), false);
      const health = await databaseContentionHealth();
      assert.equal(health.failedOperationCount, 1000);
      assert.equal(health.failureTelemetryAvailable, true);
      await writeFile(path.join(directory, Date.now() + "-" + randomUUID() + ".json"), "x".repeat(3000), { mode: 0o600 });
      await assert.rejects(mutateState(() => { throw new Error("retention probe"); }));
      assert.equal((await readdir(directory)).length, 1000);
      assert.equal((await databaseContentionHealth()).failureTelemetryAvailable, false);
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database storage health reads bounded metadata from a large state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-storage-health-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const databasePath = path.join(root, "data", "mission-control.sqlite3");
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(`
        INSERT INTO comments(id, sequence, task_id, created_at, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "comment_large_private",
        10_000,
        "task_1",
        new Date().toISOString(),
        JSON.stringify({ body: `private-health-marker-${"x".repeat(16 * 1024 * 1024)}` }),
      );
    } finally {
      db.close();
    }

    const { stdout } = await runStoreScript(root, `
      import { performance } from "node:perf_hooks";
      import { databaseStorageHealth } from ${JSON.stringify(stateDatabaseModuleUrl)};
      const startedAt = performance.now();
      const health = await databaseStorageHealth();
      process.stdout.write(JSON.stringify({ health, durationMs: performance.now() - startedAt }));
    `);
    const result = JSON.parse(stdout);
    assert.equal(result.health.storage, "sqlite");
    assert.ok(result.health.updatedAt);
    assert.ok(result.durationMs < 1_000, `storage health took ${result.durationMs}ms`);
    assert.equal(stdout.includes("private-health-marker"), false);
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

test("hosted RC persistence fences writes, preserves legacy history, survives restart and revokes without reopening tasks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-hosted-rc-state-"));
  const fixtureUrl = pathToFileURL(path.join(process.cwd(), "test/hosted-rc-evidence.test.js")).href;
  const authorityUrl = pathToFileURL(path.join(process.cwd(), "src/release-qualification.js")).href;
  const common = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { hostedRcFixture } from ${JSON.stringify(fixtureUrl)};
    import { createReleaseQualificationAuthority } from ${JSON.stringify(authorityUrl)};
    import * as store from ${JSON.stringify(storeModuleUrl)};
    import { DATABASE_FILE } from ${JSON.stringify(stateDatabaseModuleUrl)};
    const f = hostedRcFixture();
  `;
  try {
    await writeLegacyState(root);
    const { stdout } = await runStoreScript(root, `${common}
      await store.readState();
      const { createCandidateEnvelope } = await import(${JSON.stringify(candidateManifestModuleUrl)});
      const reviews = f.context.currentReviews.map(r=>({id:r.id,taskId:'task_1',projectId:'project_1',stageKey:r.role,
        role:r.role+'-reviewer',candidateCycle:1,subjectSha:r.subjectSha,outcome:'approved',author:r.actorId,createdAt:'2026-09-06T01:00:00.000Z'}));
      const candidate = createCandidateEnvelope({qaBundleId:'qa_bundle_1',createdAt:'2026-09-06T01:30:00.000Z',manifest:{
        candidateId:'candidate_1',projectId:'project_1',base:{branch:'main',sha:'a'.repeat(40)},
        sources:[{taskId:'task_1',sourceRef:'refs/heads/codex/fixture',headSha:'b'.repeat(40),candidateCycle:1,
          reviews:reviews.map(r=>({...r,reviewedAt:r.createdAt}))}],
        integration:{branch:'qa/fixture',sha:'c'.repeat(40)},checks:[{id:'check_1',kind:'local-validation',name:'fixture',outcome:'passed',subjectSha:'c'.repeat(40),evidenceDigest:f.digest('check')}],
        preview:{url:'http://127.0.0.1:4174/',status:'healthy',commitSha:'c'.repeat(40),verifiedAt:'2026-09-06T01:30:00.000Z',attestation:{kind:'header',key:'commit',observedSha:'c'.repeat(40)}},
        assembly:{mode:'atomic',requestedTaskIds:['task_1'],includedTaskIds:['task_1'],excludedTaskIds:[]}}});
      // Hermetic fixture for an already-frozen and owner-decided candidate. No product raw SQL adapter.
      candidate.qaPacket={packetDigest:f.context.ownerPacketDigest};
      candidate.qaDecision={outcome:'passed',candidateId:candidate.id,ownerQaPacketDigest:f.context.ownerPacketDigest};
      const db = new DatabaseSync(DATABASE_FILE);
      db.prepare('INSERT INTO candidates(id,sequence,project_id,status,manifest_digest,payload) VALUES (?,?,?,?,?,?)')
        .run(candidate.id,1,candidate.projectId,candidate.status,candidate.manifestDigest,JSON.stringify(candidate));
      for (const [i,r] of reviews.entries()) db.prepare('INSERT INTO reviews(id,sequence,task_id,outcome,payload) VALUES (?,?,?,?,?)').run(r.id,i,'task_1','approved',JSON.stringify(r));
      db.close();
      f.input.evidence.binding.manifestDigest=candidate.manifestDigest; f.context.binding=structuredClone(f.input.evidence.binding);
      f.context.currentReviews=f.context.currentReviews.map(r=>({...r,evidenceDigest:f.digest('placeholder')}));
      const { hostedRcDigest } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src/hosted-rc-evidence.js')).href)});
      f.context.currentReviews=f.context.currentReviews.map(r=>({...r,evidenceDigest:hostedRcDigest(reviews.find(row=>row.id===r.id))}));
      f.context.decisionDigest=hostedRcDigest(candidate.qaDecision); f.seal();
      const authority=createReleaseQualificationAuthority(()=>f.context);
      assert.equal((await store.getCurrentReleaseQualification('project_1','candidate_1')).reason,'qualification_missing');
      const policy=await store.recordReleaseQaPolicy({projectId:'project_1',expectedVersion:0,policy:f.context.policy,proof:f.context.policyProof},authority);
      assert.equal(policy.queryCount,2);
      const policyAgain=await store.recordReleaseQaPolicy({projectId:'project_1',expectedVersion:1,policy:f.context.policy,proof:f.context.policyProof},authority);
      assert.equal(policyAgain.idempotent,true); assert.equal(policyAgain.version,1);
      const append={projectId:'project_1',candidateId:'candidate_1',expectedVersion:0,...f.input};
      const admitted=await store.appendHostedRcEvidence(append,authority);
      assert.equal(admitted.queryCount,4); assert.equal(admitted.version,1);
      await assert.rejects(store.appendHostedRcEvidence(append,authority),{code:'state_conflict'});
      const duplicate=await store.appendHostedRcEvidence({...append,expectedVersion:1},authority);
      assert.equal(duplicate.idempotent,true); assert.equal(duplicate.version,1);
      const writeStart=performance.now();
      const q=await store.recordReleaseQualification({projectId:'project_1',candidateId:'candidate_1',expectedVersion:1,evidenceDigest:admitted.evidenceDigest},authority);
      const qualificationWriteMs=performance.now()-writeStart;
      assert.equal(q.version,2);
      f.context.now='2026-09-06T02:01:01.000Z';
      const retriedQualification=await store.recordReleaseQualification({projectId:'project_1',candidateId:'candidate_1',expectedVersion:2,evidenceDigest:admitted.evidenceDigest},authority);
      assert.equal(retriedQualification.idempotent,true); assert.equal(retriedQualification.version,2);
      assert.deepEqual(retriedQualification.qualification,q.qualification);
      const readStart=performance.now();
      const view=await store.getCurrentReleaseQualification('project_1','candidate_1',{nowMs:Date.parse(f.context.now)});
      const qualificationReadMs=performance.now()-readStart;
      assert.equal(view.reason,'qualified'); assert.equal(view.queryCount,3);
      const list=await store.listHostedRcEvidence('project_1','candidate_1',{limit:1});
      assert.equal(list.items.length,1); assert.equal(list.items[0].evidence,undefined); assert.equal(list.nextOffset,null);
      await assert.rejects(store.listHostedRcEvidence('project_1','candidate_1',{limit:51}),{code:'evidence_malformed'});
      const before=await store.readState();
      assert.ok(before.candidates[0].hostedRc.qualifications[0].reviewState.every(r=>Object.keys(r).sort().join(',')==='id,payloadDigest'));
      await assert.rejects(store.mutateState(s=>{s.candidates[0].hostedRc.generation=99}),{code:'authority_required'});
      await assert.rejects(store.writeState({...before,projects:before.projects.map(p=>({...p,hostedRc:{version:99}}))}),{code:'authority_required'});
      for (let index=0;index<52;index++) {
        f.input.evidence.evidenceDigests=[f.digest('evidence-page-'+index)]; f.seal();
        await store.appendHostedRcEvidence({...append,...f.input,expectedVersion:2+index},authority);
      }
      const pageStart=performance.now();
      const page=await store.listHostedRcEvidence('project_1','candidate_1');
      const summaryPageMs=performance.now()-pageStart;
      assert.equal(page.items.length,50); assert.equal(page.nextOffset,50);
      assert.equal((await store.listHostedRcEvidence('project_1','candidate_1',{offset:50})).items.length,3);
      assert.ok(page.items.every(item=>!('evidence' in item)));
      console.log(JSON.stringify({envelopeBytes:Buffer.byteLength(JSON.stringify(f.input.evidence)),writeQueryCount:q.queryCount,readQueryCount:view.queryCount,qualificationWriteMs,qualificationReadMs,summaryPageMs,summaryCount:page.items.length}));
    `);
    assert.match(stdout, /"writeQueryCount":4/);
    t.diagnostic(stdout.trim());
    const restarted = await runStoreScript(root, `${common}
      const current=await store.getCurrentReleaseQualification('project_1','candidate_1',{nowMs:Date.parse(f.context.now)});
      assert.equal(current.reason,'qualified'); assert.equal(current.version,54);
      const authority=createReleaseQualificationAuthority(()=>f.context);
      const payload={id:'revocation_1',projectId:'project_1',candidateId:'candidate_1',generation:1,reason:'owner_revoked',actorId:'release-owner',observedAt:f.context.now};
      const input={projectId:'project_1',candidateId:'candidate_1',expectedVersion:54,payload,proof:f.proof('revocation',payload,'owner')};
      const revoked=await store.invalidateReleaseQualification(input,authority);
      assert.equal(revoked.generation,1); assert.equal(revoked.version,55);
      assert.equal((await store.getCurrentReleaseQualification('project_1','candidate_1',{nowMs:Date.parse(f.context.now)})).reason,'revoked');
      const again=await store.invalidateReleaseQualification({...input,expectedVersion:55},authority);
      assert.equal(again.idempotent,true); assert.equal(again.version,55);
      const state=await store.readState(); assert.equal(state.candidates[0].hostedRc.qualifications.length,1);
      assert.equal(state.candidates[0].manifest.candidateId,'candidate_1');
      assert.equal(state.tasks[0].status,'ready');
      f.context.policy.revision=2; f.seal();
      const policyInput={projectId:'project_1',expectedVersion:1,policy:f.context.policy,proof:f.context.policyProof};
      const raced=await Promise.allSettled([store.recordReleaseQaPolicy(policyInput,authority),store.recordReleaseQaPolicy(policyInput,authority)]);
      assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(raced.find(r=>r.status==='rejected').reason.code,'state_conflict');
      const after=await store.readState();
      assert.deepEqual(after.tasks,state.tasks); assert.deepEqual(after.candidates[0].manifest,state.candidates[0].manifest);
      assert.equal(after.projects[0].hostedRc.policies.length,2);
      console.log('restart-and-revocation-passed');
    `);
    assert.match(restarted.stdout, /restart-and-revocation-passed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
