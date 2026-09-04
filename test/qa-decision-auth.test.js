import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import test from "node:test";
import { createCandidateEnvelope, invalidateCandidate } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const qaTestEnvironment = await createHermeticTestEnvironment({
  tempParent: os.tmpdir(),
});
Object.assign(process.env, qaTestEnvironment.env);
test.after(async () => qaTestEnvironment.cleanup());

const {
  createQaDecisionTestDependencies,
  adoptDefaultProjectStandards,
  mutateState,
  qaDecisionCoordinatesForState,
  readState,
  reconcilePendingQaRevocations,
  recordQaBundleDecision,
  recordQaDecision,
  transitionTask,
  updateProject,
  updateTask,
  writeState,
} = await import(`../src/store.js?qa-decision-auth=${Date.now()}`);
const {
  DATABASE_FILE,
  mutateCandidatePromotionState,
  mutatePromotionAttemptClaimState,
  mutateQaRevocationSettlementState,
  recoverMergedPromotionAdmissionState,
} = await import("../src/state-database.js");
const {
  claimPromotionAttemptInState,
  promotionProjectPolicyBinding,
  terminalPromotionAttemptClaimInState,
} = await import("../src/promotion-attempt-claim.js");
const {
  mergedPromotionRecoveryAuthorityForState,
} = await import("../src/promotion-remote-observation.js");
const {
  createMergedPromotionRecoveryTestObservation,
  createPromotionRemoteTestObservation,
} = await import("./support/promotion-authority-harness.js");

const BASE_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);
const REPOSITORY_URL = "https://github.com/example/private-demo";
const PROMOTION_POLICY_DIGEST = `sha256:${"9".repeat(64)}`;

function fixtureState(options = {}) {
  const suffix = String(options.suffix || "1");
  const projectId = `project_${suffix}`;
  const candidateId = `candidate_${suffix}`;
  const qaBundleId = `qa_bundle_${suffix}`;
  const taskIds = Array.from({ length: Number(options.taskCount || 1) }, (_, index) => (
    index === 0 ? `task_${suffix}` : `task_${suffix}_${index + 1}`
  ));
  const dependencyTaskId = options.withDependency ? `dependency_${suffix}` : "";
  const candidate = createCandidateEnvelope({
    qaBundleId,
    manifest: {
      candidateId,
      projectId,
      base: { branch: "main", sha: BASE_SHA },
      sources: taskIds.map((taskId, index) => ({
        taskId,
        sourceRef: `refs/heads/feature/task-${index + 1}`,
        headSha: SOURCE_SHA,
        candidateCycle: 1,
        reviews: [{
          id: `review_${suffix}_${index + 1}`,
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: SOURCE_SHA,
          candidateCycle: 1,
          reviewedAt: "2026-09-03T12:00:00.000Z",
        }],
      })),
      integration: { branch: "qa/demo", sha: INTEGRATION_SHA },
      checks: [{
        id: `check_${suffix}`,
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: INTEGRATION_SHA,
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: INTEGRATION_SHA,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: {
          kind: "json",
          key: "commitSha",
          observedSha: INTEGRATION_SHA,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: taskIds,
        includedTaskIds: taskIds,
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-09-03T12:05:00.000Z",
  });
  candidate.status = options.candidateStatus || "frozen";
  candidate.updatedAt = "2026-09-03T12:05:00.000Z";
  if (["qa_passed", "release_candidate_ready"].includes(candidate.status)) {
    candidate.qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: INTEGRATION_SHA,
      taskIds,
      repositoryVerifiedAt: "2026-09-03T12:06:00.000Z",
      author: "Owner QA",
      notes: "Initially passed.",
      decidedAt: "2026-09-03T12:06:00.000Z",
    };
  }
  if (candidate.status === "release_candidate_ready") {
    candidate.promotion = {
      branch: "qa/promotion-private-demo",
      prUrl: "https://github.com/example/private-demo/pull/42",
      commitSha: INTEGRATION_SHA,
      manifestDigest: candidate.manifestDigest,
      readyAt: "2026-09-03T12:15:00.000Z",
    };
  }
  const taskStatus = options.taskStatus || (candidate.status === "release_candidate_ready"
    ? "user_review"
    : candidate.status === "qa_passed" ? "approved_for_main" : "qa_review");
  const state = {
    meta: {},
    projects: [{
      id: projectId,
      key: "private-demo",
      name: "Private Demo",
      repoPath: "/private/demo",
      repoUrl: options.repoUrl || REPOSITORY_URL,
      defaultBranch: "main",
      workflowMode: "github",
    }],
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      projectId,
      title: "Exact owner QA",
      status: taskStatus,
      assignedAgentRole: candidate.status === "frozen"
        ? "owner"
        : candidate.status === "qa_passed" ? "promotion-worker" : "owner",
      stateVersion: 7,
      reviewSubjectSha: SOURCE_SHA,
      reviewSubjectCycle: 1,
      integrationStatus: "ready",
      integrationCommit: INTEGRATION_SHA,
      candidateManifestDigest: candidate.manifestDigest,
      candidateId: candidate.id,
      qaBundleId,
      ...(dependencyTaskId ? { dependsOnTaskIds: [dependencyTaskId] } : {}),
    })).concat(dependencyTaskId ? [{
      id: dependencyTaskId,
      projectId,
      title: "Shared dependency",
      expectedOutcome: "Dependency remains stable.",
      status: "done",
      stateVersion: 3,
      dependsOnTaskIds: [],
    }] : []),
    comments: [],
    events: [],
    reviews: [],
    runs: [],
    qaBundles: [{
      id: qaBundleId,
      projectId,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationBranch: "qa/demo",
      integrationCommit: INTEGRATION_SHA,
      previewUrl: "http://127.0.0.1:4393/",
      status: candidate.status === "release_candidate_ready"
        ? "release_candidate_ready"
        : candidate.status === "qa_passed" ? "passed" : "ready",
      ...(candidate.status === "release_candidate_ready" ? {
        promotionPrUrl: candidate.promotion.prUrl,
        promotionBranch: candidate.promotion.branch,
        promotionCommit: candidate.promotion.commitSha,
        promotedTaskIds: taskIds,
      } : {}),
      updatedAt: "2026-09-03T12:05:00.000Z",
      tasks: taskIds.map((taskId) => ({ id: taskId, title: "Exact owner QA" })),
    }],
    candidates: [candidate],
  };
  const bundle = state.qaBundles[0];
  candidate.qaPacket = buildOwnerQaPacket(state, candidate, {
    bundle,
    generatedAt: "2026-09-03T12:05:00.000Z",
  });
  bundle.qaPacket = candidate.qaPacket;
  bundle.packetDigest = candidate.qaPacket.packetDigest;
  if (candidate.qaDecision) {
    candidate.qaDecision.ownerQaPacketDigest = candidate.qaPacket.packetDigest;
    bundle.qaDecision = structuredClone(candidate.qaDecision);
    for (const task of state.tasks.filter((item) => taskIds.includes(item.id))) {
      task.qaDecision = structuredClone(candidate.qaDecision);
    }
  }
  return state;
}

function decisionInput(state, candidate, outcome = "passed") {
  return {
    outcome,
    author: "Owner QA",
    notes: "Reviewed exact candidate.",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: INTEGRATION_SHA,
    ownerQaPacketDigest: qaDecisionCoordinatesForState(state).tasks[state.tasks[0].id],
  };
}

function bundleDecisionInput(state, candidate, outcome = "failed") {
  return {
    outcome,
    author: "Owner QA",
    notes: "Reviewed exact candidate bundle.",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: INTEGRATION_SHA,
    taskIds: candidate.manifest.sources.map((source) => source.taskId),
    ownerQaPacketDigest: qaDecisionCoordinatesForState(state).bundles[candidate.qaBundleId],
  };
}

function successfulVerificationDependencies() {
  return createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => ({
      ok: true,
      status: "verified",
      verifiedAt: "2026-09-03T12:10:00.000Z",
      observations: [],
    }),
  });
}

function releaseRevocationDependencies(settle, calls = []) {
  return createQaDecisionTestDependencies({
    loadConfig: async () => ({
      githubApps: {
        credentialsDir: "/trusted/github-apps",
        roleMap: { "promotion-worker": "promotion-worker" },
        defaultRole: "builder",
      },
    }),
    prepareGitHubAppAuth: async (run) => {
      calls.push({ phase: "prepare", role: run.role });
      return {
        role: run.role,
        token: "ghs_release_revocation_test_token",
        askpassPath: "/tmp/studioops-release-revocation-askpass",
      };
    },
    cleanupGitHubAppAuth: async () => {
      calls.push({ phase: "cleanup" });
    },
    settleReleaseCandidatePullRequestForRevocation: async (...args) => {
      calls.push({ phase: "settle" });
      return settle(...args);
    },
  });
}

function promotionClaimInput(state, candidateId, overrides = {}) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  const project = state.projects.find((item) => item.id === candidate.projectId);
  return {
    projectId: project.id,
    candidateId,
    mode: "create",
    policyDigest: PROMOTION_POLICY_DIGEST,
    projectPolicy: promotionProjectPolicyBinding(project),
    ttlMs: 15 * 60 * 1_000,
    ...overrides,
  };
}

async function installActivePromotionClaim(candidateId, label = "fixture") {
  const nowMs = Date.now();
  const claimId = `${label}-${candidateId}`;
  const result = await mutatePromotionAttemptClaimState(candidateId, (state) => (
    claimPromotionAttemptInState(state, promotionClaimInput(state, candidateId, {
      nowMs,
      claimIdFactory: () => claimId,
    }))
  ), { operationName: `test.install_active_promotion_claim.${label}` });
  assert.equal(result.acquired, true);
  return result.claim;
}

async function terminalizePromotionClaim(candidateId, claim, outcome) {
  const nowMs = Date.now();
  return mutatePromotionAttemptClaimState(candidateId, (state) => (
    terminalPromotionAttemptClaimInState(state, claim, promotionClaimInput(state, candidateId, {
      nowMs,
      outcome,
    }))
  ), { operationName: `test.terminalize_promotion_claim.${outcome}` });
}

function createOpenPromotionObservation(state, candidate, claim, promotion) {
  const project = state.projects.find((item) => item.id === candidate.projectId);
  const repository = new URL(project.repoUrl).pathname.replace(/^\//, "");
  const prNumber = Number(new URL(promotion.prUrl).pathname.split("/").at(-1));
  return createPromotionRemoteTestObservation({
    projectId: project.id,
    repoUrl: project.repoUrl,
    targetBranch: candidate.manifest.base.branch,
    promotionBranch: promotion.branch,
    headSha: candidate.manifest.integration.sha,
    candidate,
    subjectCandidate: candidate,
    claim,
  }, {
    number: prNumber,
    url: promotion.prUrl,
    state: "OPEN",
    mergedAt: "",
    mergeCommit: "",
    baseRefName: candidate.manifest.base.branch,
    headRefName: promotion.branch,
    headRefOid: candidate.manifest.integration.sha,
    headRepository: repository,
    body: [
      `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
      `<!-- studioops-claim:${claim.claimId}:${claim.fence} -->`,
    ].join("\n"),
  }, { nowMs: Date.now() });
}

async function installFixtureState(options = {}) {
  const current = await readState();
  const suffix = (current.candidates || []).length + 1;
  const requestedCandidateStatus = options.candidateStatus || "frozen";
  const state = fixtureState({
    ...options,
    suffix,
    candidateStatus: "frozen",
    taskStatus: "qa_review",
  });
  state.meta = structuredClone(current.meta || {});
  state.projects.push(...structuredClone(current.projects || []));
  state.candidates.push(...structuredClone(current.candidates || []));
  state.qaBundles.push(...structuredClone(current.qaBundles || []));
  state.tasks.push(...structuredClone(current.tasks || []));
  await writeState(state);
  let persisted = await readState();
  if (requestedCandidateStatus === "frozen") return persisted;

  const candidateId = state.candidates[0].id;
  let candidate = persisted.candidates.find((item) => item.id === candidateId);
  await recordQaBundleDecision(
    candidate.qaBundleId,
    bundleDecisionInput(persisted, candidate, "passed"),
    successfulVerificationDependencies(),
  );
  persisted = await readState();
  if (requestedCandidateStatus === "qa_passed") return persisted;
  assert.equal(requestedCandidateStatus, "release_candidate_ready");

  candidate = persisted.candidates.find((item) => item.id === candidateId);
  const claim = await installActivePromotionClaim(candidateId, `fixture-promotion-claim-${suffix}`);

  const promotion = {
    branch: "qa/promotion-private-demo",
    prUrl: "https://github.com/example/private-demo/pull/42",
    commitSha: candidate.manifest.integration.sha,
    manifestDigest: candidate.manifestDigest,
    readyAt: "2026-09-03T12:15:00.000Z",
  };
  const claimState = await readState();
  candidate = claimState.candidates.find((item) => item.id === candidateId);
  const promotionRemoteObservation = createOpenPromotionObservation(claimState, candidate, claim, promotion);
  const terminalAtMs = Date.now();
  await mutateCandidatePromotionState(candidateId, claim, (next) => {
    const terminalClaim = terminalPromotionAttemptClaimInState(
      next,
      claim,
      promotionClaimInput(next, candidateId, {
        nowMs: terminalAtMs,
        outcome: "pr_ready",
      }),
    );
    const promotedCandidate = next.candidates.find((item) => item.id === candidateId);
    const bundle = next.qaBundles.find((item) => item.id === promotedCandidate.qaBundleId);
    const taskIds = promotedCandidate.manifest.sources.map((source) => source.taskId);
    promotedCandidate.status = "release_candidate_ready";
    promotedCandidate.promotion = structuredClone(promotion);
    promotedCandidate.updatedAt = promotion.readyAt;
    Object.assign(bundle, {
      status: "release_candidate_ready",
      promotionPrUrl: promotion.prUrl,
      promotionBranch: promotion.branch,
      promotionCommit: promotion.commitSha,
      promotedTaskIds: taskIds,
      promotionReadyAt: promotion.readyAt,
      updatedAt: promotion.readyAt,
    });
    for (const taskId of taskIds) {
      const task = next.tasks.find((item) => item.id === taskId);
      Object.assign(task, {
        status: "user_review",
        assignedAgentRole: "owner",
        promotionStatus: "pr_ready",
        promotionPrUrl: promotion.prUrl,
        promotionBranch: promotion.branch,
        promotionCommit: promotion.commitSha,
        updatedAt: promotion.readyAt,
      });
    }
    return terminalClaim;
  }, {
    operationName: "test.install_release_candidate",
    promotionRemoteObservation,
  });
  return readState();
}

function forceLegacyStalePostMergeResult(taskId) {
  const db = new DatabaseSync(DATABASE_FILE);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM tasks WHERE id = ?").get(taskId);
    const task = JSON.parse(row.payload);
    const candidate = JSON.parse(
      db.prepare("SELECT payload FROM candidates WHERE id = ?").get(task.candidateId).payload,
    );
    const failureRecordedAt = "2026-09-03T12:16:02.000Z";
    Object.assign(task, {
      status: "needs_changes",
      assignedAgentRole: "builder",
      promotionStatus: "validation_failed",
      promotionCommit: candidate.manifest.integration.sha,
      promotionUpdatedAt: failureRecordedAt,
      promotionValidation: {
        status: "validation_failed",
        commands: [{ command: "npm test", ok: false, output: "synthetic late failure" }],
      },
      lastAutomationFailure: "Legacy stale validation result landed after the release PR merged.",
      stateVersion: Number(task.stateVersion) + 1,
      updatedAt: failureRecordedAt,
    });
    db.prepare(`
      UPDATE tasks
      SET status = ?, state_version = ?, assigned_role = ?, updated_at = ?, payload = ?
      WHERE id = ?
    `).run(
      task.status,
      task.stateVersion,
      task.assignedAgentRole,
      task.updatedAt,
      JSON.stringify(task),
      task.id,
    );
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (id, sequence, project_id, task_id, type, created_at, payload)
      VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events), ?, ?, ?, ?, ?)
    `);
    const readyEvent = {
      id: `event_legacy_ready_${task.id}`,
      type: "promotion_pr_ready",
      projectId: task.projectId,
      taskId: task.id,
      message: "Synthetic historical release handoff.",
      createdAt: candidate.promotion.readyAt,
    };
    insertEvent.run(
      readyEvent.id,
      task.projectId,
      task.id,
      readyEvent.type,
      readyEvent.createdAt,
      JSON.stringify(readyEvent),
    );
    const failureEvent = {
      id: `event_legacy_failure_${task.id}`,
      type: "promotion_validation_failed",
      projectId: task.projectId,
      taskId: task.id,
      message: "Synthetic historical late validation result.",
      createdAt: failureRecordedAt,
    };
    insertEvent.run(
      failureEvent.id,
      task.projectId,
      task.id,
      failureEvent.type,
      failureEvent.createdAt,
      JSON.stringify(failureEvent),
    );
    db.prepare("UPDATE state_meta SET version = version + 1 WHERE singleton_id = 1").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function forceLegacyCandidateStatus(candidateId, status) {
  const db = new DatabaseSync(DATABASE_FILE);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM candidates WHERE id = ?").get(candidateId);
    const candidate = JSON.parse(row.payload);
    candidate.status = status;
    db.prepare(`
      UPDATE candidates
      SET status = ?, payload = ?
      WHERE id = ?
    `).run(status, JSON.stringify(candidate), candidateId);
    db.prepare("UPDATE state_meta SET version = version + 1 WHERE singleton_id = 1").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function createMergedRecoveryObservation(state, candidate) {
  const authority = mergedPromotionRecoveryAuthorityForState(state, candidate);
  const repository = new URL(authority.repoUrl).pathname.replace(/^\//, "");
  const number = Number(new URL(candidate.promotion.prUrl).pathname.split("/").at(-1));
  return createMergedPromotionRecoveryTestObservation(authority, {
    number,
    url: candidate.promotion.prUrl,
    state: "MERGED",
    mergedAt: "2026-09-03T12:16:00.000Z",
    mergeCommit: "e".repeat(40),
    baseRefName: candidate.manifest.base.branch,
    headRefName: candidate.promotion.branch,
    headRefOid: candidate.manifest.integration.sha,
    headRepository: repository,
    body: [
      "## Immutable StudioOps candidate",
      `Candidate: ${candidate.id}`,
      `Manifest: ${candidate.manifestDigest}`,
      `Integration SHA: ${candidate.manifest.integration.sha}`,
    ].join("\n"),
  }, { nowMs: Date.parse("2026-09-03T12:16:03.000Z") });
}

test("durable candidate-status gates stop a three-transaction generic-writer recovery bounce", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidateId = initial.candidates[0].id;
  const taskId = initial.candidates[0].manifest.sources[0].taskId;
  forceLegacyStalePostMergeResult(taskId);

  try {
    // Transaction 1 of the former bypass hid the release-ready authority from
    // the recovery gate. A current generic writer must reject that first hop.
    await assert.rejects(
      mutateState((state) => {
        state.candidates.find((item) => item.id === candidateId).status = "frozen";
      }, { operationName: "test.generic_status_bounce.hide_authority" }),
      /status transition release_candidate_ready -> frozen requires its exact fenced lifecycle writer/i,
    );
    let current = await readState();
    assert.equal(current.candidates.find((item) => item.id === candidateId).status, "release_candidate_ready");
    assert.equal(current.tasks.find((item) => item.id === taskId).status, "needs_changes");

    // Seed the exact durable state transaction 1 could have left before this
    // gate existed, then prove transaction 3 cannot restore authority after a
    // separate generic transaction repairs the task lifecycle.
    forceLegacyCandidateStatus(candidateId, "frozen");
    await mutateState((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      task.status = "promotion_blocked";
      task.assignedAgentRole = "promotion-worker";
      task.promotionStatus = "remote_merge_reconciliation_pending";
    }, { operationName: "test.generic_status_bounce.repair_task" });

    current = await readState();
    assert.equal(current.candidates.find((item) => item.id === candidateId).status, "frozen");
    assert.equal(current.tasks.find((item) => item.id === taskId).status, "promotion_blocked");

    await assert.rejects(
      mutateState((state) => {
        state.candidates.find((item) => item.id === candidateId).status = "release_candidate_ready";
      }, { operationName: "test.generic_status_bounce.restore_authority" }),
      /status transition frozen -> release_candidate_ready requires its exact fenced lifecycle writer/i,
    );
    current = await readState();
    assert.equal(current.candidates.find((item) => item.id === candidateId).status, "frozen");
  } finally {
    // Keep the suite's shared database fail-closed after the historical-state
    // simulation, regardless of which assertion failed.
    const current = await readState();
    if (!current.candidates.find((item) => item.id === candidateId)?.invalidation) {
      await mutateState((state) => {
        const candidate = state.candidates.find((item) => item.id === candidateId);
        const invalidatedAt = new Date().toISOString();
        invalidateCandidate(candidate, {
          reason: "End historical candidate-status bounce simulation.",
          expected: "release_candidate_ready",
          observed: candidate.status,
          invalidatedAt,
        });
        const bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
        bundle.status = "invalidated";
        bundle.updatedAt = invalidatedAt;
      }, { operationName: "test.generic_status_bounce.cleanup" });
    }
  }
});

test("an exact merged legacy PR restores stranded reconciliation admission through the narrow writer", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidateId = initial.candidates[0].id;
  const taskId = initial.candidates[0].manifest.sources[0].taskId;
  forceLegacyStalePostMergeResult(taskId);
  let stale = await readState();
  let candidate = stale.candidates.find((item) => item.id === candidateId);

  await assert.rejects(
    mutateState((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      task.status = "promotion_blocked";
      task.assignedAgentRole = "promotion-worker";
      task.promotionStatus = "remote_merge_reconciliation_pending";
    }, { operationName: "test.generic_merged_admission_repair" }),
    /attested merged-PR recovery/i,
  );

  stale = await readState();
  candidate = stale.candidates.find((item) => item.id === candidateId);
  const staleObservation = createMergedRecoveryObservation(stale, candidate);
  forceLegacyStalePostMergeResult(taskId);
  await assert.rejects(
    recoverMergedPromotionAdmissionState(candidateId, staleObservation),
    /not an exact attested GitHub result/i,
  );
  stale = await readState();
  candidate = stale.candidates.find((item) => item.id === candidateId);
  const staleVersion = stale.tasks.find((task) => task.id === taskId).stateVersion;
  const observation = createMergedRecoveryObservation(stale, candidate);
  await assert.rejects(
    recoverMergedPromotionAdmissionState(candidateId, structuredClone(observation)),
    /not an exact attested GitHub result/i,
  );
  const recovered = await recoverMergedPromotionAdmissionState(candidateId, observation);
  assert.deepEqual(recovered, { candidateId, repaired: true, taskIds: [taskId] });

  const current = await readState();
  const task = current.tasks.find((item) => item.id === taskId);
  candidate = current.candidates.find((item) => item.id === candidateId);
  assert.equal(candidate.status, "release_candidate_ready");
  assert.equal(candidate.promotionMerge, null);
  assert.equal(task.status, "promotion_blocked");
  assert.equal(task.assignedAgentRole, "promotion-worker");
  assert.equal(task.promotionStatus, "remote_merge_reconciliation_pending");
  assert.equal(task.promotionRecovery.mergeCommit, "e".repeat(40));
  assert.equal(task.stateVersion, staleVersion + 1);
  assert.equal(
    current.events.filter((event) => (
      event.type === "merged_promotion_admission_recovered"
      && event.candidateId === candidateId
    )).length,
    1,
  );
});

test("private owner QA uses only narrow read-verification auth outside the state mutation", async () => {
  const initial = await installFixtureState();
  const calls = [];
  const auth = {
    role: "qa-reviewer",
    token: "ghs_private_owner_qa_token",
    jwt: "private-owner-qa-jwt-value",
    askpassPath: "/tmp/studioops-owner-qa-askpass",
  };
  const dependencies = createQaDecisionTestDependencies({
    loadConfig: async () => ({
      githubApps: {
        credentialsDir: "/trusted/github-apps",
        roleMap: { "qa-reviewer": "lead-reviewer" },
        defaultRole: "builder",
      },
    }),
    prepareGitHubAppAuth: async (run, options) => {
      calls.push({ phase: "prepare", run, options });
      return auth;
    },
    cleanupGitHubAppAuth: async (value) => {
      calls.push({ phase: "cleanup", value });
    },
    verifyCandidateRepositoryState: async (_project, _candidate, options) => {
      calls.push({ phase: "verify", options });
      if (!options.gitAuthEnv) {
        return { ok: false, status: "unavailable", reason: "authentication required" };
      }
      assert.deepEqual(options.gitAuthEnv, {
        GIT_ASKPASS: auth.askpassPath,
        MISSION_CONTROL_GITHUB_TOKEN: auth.token,
        MISSION_CONTROL_GIT_USERNAME: "x-access-token",
      });
      return {
        ok: true,
        status: "verified",
        verifiedAt: "2026-09-03T12:10:00.000Z",
        observations: [],
      };
    },
  });
  const candidate = initial.candidates[0];
  const result = await recordQaDecision(initial.tasks[0].id, {
    ...decisionInput(initial, candidate),
    env: { GH_TOKEN: "caller-token", PATH: "/caller/bin" },
    githubAppCredentialsDir: "/caller/credentials",
    githubAppRole: "promotion-worker",
  }, dependencies);

  assert.equal(result.candidate.status, "qa_passed");
  assert.equal(result.candidate.qaDecision.repositoryVerifiedAt, "2026-09-03T12:10:00.000Z");
  assert.deepEqual(calls.map((item) => item.phase), ["verify", "prepare", "verify", "cleanup"]);
  const prepared = calls.find((item) => item.phase === "prepare");
  assert.equal(prepared.run.role, "qa-reviewer");
  assert.equal(prepared.run.project.repoUrl, REPOSITORY_URL);
  assert.deepEqual(prepared.options, {
    githubAppAuth: true,
    githubAppCredentialsDir: "/trusted/github-apps",
    githubAppRoleMap: { "qa-reviewer": "lead-reviewer" },
    githubAppDefaultRole: "builder",
  });
  assert.equal(JSON.stringify(prepared).includes("caller-token"), false);
  assert.equal((await readState()).tasks[0].status, "approved_for_main");
});

test("a task QA request missing exact candidate coordinates fails before repository access", async () => {
  const initial = await installFixtureState();
  let verificationCalls = 0;
  const dependencies = createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => {
      verificationCalls += 1;
      throw new Error("repository verification must not run for an unbound request");
    },
  });

  await assert.rejects(
    recordQaDecision(initial.tasks[0].id, {
      outcome: "passed",
      author: "Owner QA",
      notes: "Missing exact coordinates.",
      candidateId: "",
      manifestDigest: initial.candidates[0].manifestDigest,
      integrationSha: INTEGRATION_SHA,
    }, dependencies),
    /candidate ID does not match/i,
  );
  assert.equal(verificationCalls, 0);
});

test("owner QA becomes non-actionable when a frozen source is reassigned", async () => {
  const initial = await installFixtureState({ taskCount: 2 });
  const candidate = initial.candidates[0];
  const input = bundleDecisionInput(initial, candidate, "passed");
  let verificationCalls = 0;
  await updateTask(initial.tasks[0].id, { assignedAgentRole: "builder" });

  const current = await readState();
  assert.equal(qaDecisionCoordinatesForState(current).bundles[candidate.qaBundleId], undefined);
  await assert.rejects(
    recordQaBundleDecision(
      candidate.qaBundleId,
      input,
      createQaDecisionTestDependencies({
        verifyCandidateRepositoryState: async () => {
          verificationCalls += 1;
          return { ok: true, status: "verified" };
        },
      }),
    ),
    /QA task .* does not match the immutable candidate authority/i,
  );
  assert.equal(verificationCalls, 0);
});

test("owner QA rejects noncanonical repository authority before minting a token", async () => {
  const initial = await installFixtureState({ repoUrl: `${REPOSITORY_URL}.git` });
  let authCalls = 0;
  const dependencies = createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => ({
      ok: false,
      status: "unavailable",
      reason: "repository authority is invalid",
    }),
    prepareGitHubAppAuth: async () => {
      authCalls += 1;
      throw new Error("must not mint for malformed authority");
    },
  });

  await assert.rejects(
    recordQaDecision(
      initial.tasks[0].id,
      decisionInput(initial, initial.candidates[0]),
      dependencies,
    ),
    /canonical GitHub repository URL/i,
  );
  assert.equal(authCalls, 0);
});

test("a state or repository binding change after verification cannot commit QA authority", async () => {
  const initial = await installFixtureState();
  const dependencies = createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => {
      await mutateState((state) => {
        state.projects[0].repoUrl = "https://github.com/example/replacement";
      }, { operationName: "test.qa_authority_drift" });
      return {
        ok: true,
        status: "verified",
        verifiedAt: "2026-09-03T12:10:00.000Z",
        observations: [],
      };
    },
  });

  await assert.rejects(
    recordQaDecision(initial.tasks[0].id, decisionInput(initial, initial.candidates[0]), dependencies),
    /authority changed during repository verification|owner QA packet no longer matches current project or task definitions/i,
  );
  const state = await readState();
  assert.equal(state.tasks.find((task) => task.id === initial.tasks[0].id).status, "qa_review");
  assert.equal(state.candidates[0].status, "frozen");
  assert.equal(state.projects[0].repoUrl, "https://github.com/example/private-demo");
});

test("a negative owner QA decision is exact-bound but does not require remote availability", async () => {
  const initial = await installFixtureState();
  let verificationCalls = 0;
  const dependencies = createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => {
      verificationCalls += 1;
      throw new Error("negative decisions must not contact the repository");
    },
  });

  const result = await recordQaDecision(
    initial.tasks[0].id,
    decisionInput(initial, initial.candidates[0], "failed"),
    dependencies,
  );
  assert.equal(verificationCalls, 0);
  assert.equal(result.candidate.status, "qa_failed");
  assert.equal(result.decisions[0].task.status, "needs_changes");
  assert.equal(result.candidate.qaDecision.repositoryVerifiedAt, "");
});

test("private owner QA fails closed and redacts scoped credentials", async () => {
  const initial = await installFixtureState();
  const token = "ghs_should_never_appear_in_error";
  let cleaned = false;
  const dependencies = createQaDecisionTestDependencies({
    loadConfig: async () => ({ githubApps: {} }),
    prepareGitHubAppAuth: async () => ({
      role: "qa-reviewer",
      token,
      jwt: "jwt_should_never_appear_in_error",
      askpassPath: "/tmp/studioops-owner-qa-askpass",
    }),
    cleanupGitHubAppAuth: async () => { cleaned = true; },
    verifyCandidateRepositoryState: async (_project, _candidate, options) => (
      options.gitAuthEnv
        ? { ok: false, status: "unavailable", reason: `remote rejected ${token}` }
        : { ok: false, status: "unavailable", reason: "authentication required" }
    ),
  });

  await assert.rejects(
    recordQaDecision(initial.tasks[0].id, decisionInput(initial, initial.candidates[0]), dependencies),
    (error) => {
      assert.match(error.message, /Candidate integrity could not be verified/);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /REDACTED_GITHUB_APP_TOKEN/);
      return true;
    },
  );
  assert.equal(cleaned, true);
  const state = await readState();
  assert.equal(state.tasks.find((task) => task.id === initial.tasks[0].id).status, "qa_review");
  assert.equal(state.candidates[0].status, "frozen");
});

test("persistence rejects corrupt frozen task and bundle links before they can reach QA", async () => {
  for (const corruption of ["task", "bundle"]) {
    const initial = await installFixtureState({ taskCount: corruption === "bundle" ? 2 : 1 });
    const candidate = initial.candidates[0];
    await assert.rejects(
      () => mutateState((state) => {
        if (corruption === "task") {
          state.tasks.find((task) => task.id === initial.tasks[0].id).candidateId = "candidate_corrupt";
        } else {
          state.qaBundles.find((bundle) => bundle.id === candidate.qaBundleId).integrationCommit = BASE_SHA;
        }
      }, { operationName: `test.corrupt_${corruption}_qa_link` }),
      /append-only|owner packet|bundle/i,
    );
    const state = await readState();
    assert.equal(state.candidates[0].id, candidate.id);
    assert.equal(state.qaBundles[0].integrationCommit, candidate.manifest.integration.sha);
  }
});

test("a QA pass followed by a task-definition edit atomically revokes promotion authority", async () => {
  const initial = await installFixtureState({ taskCount: 2 });
  const candidate = initial.candidates[0];
  await recordQaBundleDecision(
    candidate.qaBundleId,
    bundleDecisionInput(initial, candidate, "passed"),
    successfulVerificationDependencies(),
  );

  await updateTask(initial.tasks[0].id, { title: "Changed after owner approval" });
  const state = await readState();
  const storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  const storedBundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
  const storedTasks = candidate.manifest.sources.map((source) => (
    state.tasks.find((task) => task.id === source.taskId)
  ));

  assert.equal(storedCandidate.status, "invalidated");
  assert.equal(storedCandidate.qaDecision.outcome, "passed");
  assert.equal(storedCandidate.qaDecision.ownerQaPacketDigest, storedCandidate.qaPacket.packetDigest);
  assert.equal(storedBundle.status, "invalidated");
  assert.deepEqual(storedTasks.map((task) => task.status), ["needs_changes", "needs_changes"]);
  assert.ok(storedTasks.every((task) => !task.candidateId && !task.qaBundleId && task.qaDecision === null));
  assert.ok(storedTasks.every((task) => !task.promotionStatus));
});

test("recording a QA decision atomically terminalizes stale queued and claimed notifications", async () => {
  const initial = await installFixtureState();
  const candidate = initial.candidates[0];
  await mutateState((state) => {
    state.notificationOutbox = ["queued", "attempted"].map((status, index) => ({
      id: `notification_${candidate.id}_${index + 1}`,
      idempotencyKey: `${candidate.id}:${candidate.manifestDigest}:test-${index + 1}`,
      kind: "owner_qa",
      projectId: candidate.projectId,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      channel: "in_app",
      status,
      attempts: index,
      packet: candidate.qaPacket,
      policy: { maxAttempts: 3 },
      ...(status === "attempted" ? {
        claimToken: "active-claim",
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      } : {}),
      createdAt: "2026-09-03T12:05:00.000Z",
      updatedAt: "2026-09-03T12:05:00.000Z",
    }));
  }, { operationName: "test.seed_owner_qa_notifications" });

  await recordQaDecision(
    initial.tasks[0].id,
    decisionInput(initial, candidate),
    successfulVerificationDependencies(),
  );
  const state = await readState();
  assert.ok(state.notificationOutbox.every((item) => item.status === "acknowledged"));
  assert.ok(state.notificationOutbox.every((item) => item.resolutionReason === "qa_passed"));
  assert.ok(state.notificationOutbox.every((item) => !item.claimToken && !item.claimExpiresAt));
});

test("a frozen packet edit invalidates every candidate task before a stale owner click", async () => {
  const initial = await installFixtureState({ taskCount: 2 });
  const candidate = initial.candidates[0];
  const staleInput = bundleDecisionInput(initial, candidate, "passed");
  await updateTask(initial.tasks[0].id, { title: "Fresh requirements" });
  let repositoryCalls = 0;
  const dependencies = createQaDecisionTestDependencies({
    verifyCandidateRepositoryState: async () => {
      repositoryCalls += 1;
      throw new Error("stale owner click must not reach repository verification");
    },
  });

  await assert.rejects(
    recordQaBundleDecision(candidate.qaBundleId, staleInput, dependencies),
    /invalid|lifecycle|current status|bundle/i,
  );
  assert.equal(repositoryCalls, 0);
  const state = await readState();
  assert.equal(state.candidates.find((item) => item.id === candidate.id).status, "invalidated");
  assert.ok(candidate.manifest.sources.every((source) => (
    state.tasks.find((task) => task.id === source.taskId).status === "needs_changes"
  )));
});

test("project authority changes invalidate frozen QA, while active release candidates require explicit revocation", async () => {
  const frozen = await installFixtureState({ taskCount: 2 });
  const frozenCandidate = frozen.candidates[0];
  await updateProject(frozenCandidate.projectId, { description: "Changed safety context" });
  let state = await readState();
  assert.equal(state.candidates.find((item) => item.id === frozenCandidate.id).status, "invalidated");
  assert.ok(frozenCandidate.manifest.sources.every((source) => (
    state.tasks.find((task) => task.id === source.taskId).status === "needs_changes"
  )));

  const release = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const releaseCandidate = release.candidates[0];
  await assert.rejects(
    updateProject(releaseCandidate.projectId, { description: "Unsafe in-place release edit" }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    updateTask(release.tasks[0].id, { title: "Unsafe in-place task edit" }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    updateTask(release.tasks[0].id, { status: "needs_changes" }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    updateTask(release.tasks[0].id, { status: "blocked" }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    transitionTask({
      action: "close_task",
      taskId: release.tasks[0].id,
      expectedStateVersion: release.tasks[0].stateVersion,
      actorContext: {
        actorId: "StudioOps Owner",
        actorType: "owner",
        role: "owner",
        trusted: true,
      },
      evidence: { targetStatus: "closed" },
    }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    updateTask(release.tasks[0].id, { subjectSha: BASE_SHA }),
    /revoke that QA approval first/i,
  );
  await assert.rejects(
    transitionTask({
      action: "request_changes",
      taskId: release.tasks[0].id,
      expectedStateVersion: release.tasks[0].stateVersion,
      actorContext: {
        actorId: "StudioOps Owner",
        actorType: "owner",
        role: "owner",
        trusted: true,
      },
      evidence: {
        candidateId: releaseCandidate.id,
        manifestDigest: releaseCandidate.manifestDigest,
        candidateCycle: 1,
      },
    }),
    /revoke that QA approval first/i,
  );
  state = await readState();
  assert.equal(state.candidates.find((item) => item.id === releaseCandidate.id).status, "release_candidate_ready");
  assert.equal(state.tasks.find((task) => task.id === release.tasks[0].id).status, "user_review");
});

test("dependency definition edits invalidate frozen and passed packets but fence active release PRs", async () => {
  for (const candidateStatus of ["frozen", "qa_passed", "release_candidate_ready"]) {
    const initial = await installFixtureState({ candidateStatus, withDependency: true });
    const candidate = initial.candidates[0];
    const sourceTaskId = candidate.manifest.sources[0].taskId;
    const dependency = initial.tasks.find((task) => task.id.startsWith("dependency_"));
    const changedTitle = `Changed dependency for ${candidateStatus}`;
    if (candidateStatus === "release_candidate_ready") {
      await assert.rejects(
        updateTask(dependency.id, { title: changedTitle }),
        /affected release-candidate pull request|revoke that QA approval first/i,
      );
      const state = await readState();
      assert.equal(state.candidates.find((item) => item.id === candidate.id).status, candidateStatus);
      assert.equal(state.tasks.find((item) => item.id === dependency.id).title, "Shared dependency");
      assert.equal(state.tasks.find((item) => item.id === sourceTaskId).status, "user_review");
      continue;
    }

    await updateTask(dependency.id, { title: changedTitle });
    const state = await readState();
    assert.equal(state.candidates.find((item) => item.id === candidate.id).status, "invalidated");
    assert.equal(state.tasks.find((item) => item.id === dependency.id).title, changedTitle);
    assert.equal(state.tasks.find((item) => item.id === sourceTaskId).status, "needs_changes");
    assert.equal(state.tasks.find((item) => item.id === sourceTaskId).qaBundleId || "", "");
  }
});

test("multi-task QA revocation is atomic and preserves the original signed approval audit", async () => {
  const initial = await installFixtureState({ candidateStatus: "qa_passed", taskCount: 2 });
  const candidate = initial.candidates[0];
  const result = await recordQaBundleDecision(
    candidate.qaBundleId,
    bundleDecisionInput(initial, candidate),
    releaseRevocationDependencies(async () => ({
      status: "absent",
      observedAt: "2026-09-03T12:20:00.000Z",
    })),
  );

  assert.equal(result.outcome, "revoked");
  const state = await readState();
  const storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  const storedBundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
  assert.equal(storedCandidate.status, "invalidated");
  assert.equal(storedCandidate.qaDecision.outcome, "passed");
  assert.equal(storedCandidate.qaRevocationSettlement.status, "absent");
  assert.equal(storedBundle.status, "invalidated");
  for (const source of candidate.manifest.sources) {
    const task = state.tasks.find((item) => item.id === source.taskId);
    assert.equal(task.status, "needs_changes");
    assert.equal(task.candidateId, "");
    assert.equal(task.qaBundleId, "");
    assert.equal(task.qaDecision, null);
  }
  assert.equal(
    state.events.filter((event) => (
      event.type === "qa_approval_revoked"
      && candidate.manifest.sources.some((source) => source.taskId === event.taskId)
    )).length,
    2,
  );
});

test("release revocation uses promotion-worker auth, closes the PR, and persists settlement evidence", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready", taskCount: 2 });
  const candidate = initial.candidates[0];
  const calls = [];
  const observedAt = "2026-09-03T12:31:00.000Z";
  const dependencies = releaseRevocationDependencies(async (_project, settledCandidate, options) => {
    assert.equal(settledCandidate.id, candidate.id);
    assert.equal(options.githubToken, "ghs_release_revocation_test_token");
    return {
      status: "closed",
      prUrl: candidate.promotion.prUrl,
      observedAt,
      mergeCommit: "d".repeat(40),
      mergedAt: "",
    };
  }, calls);

  await recordQaBundleDecision(
    candidate.qaBundleId,
    bundleDecisionInput(initial, candidate),
    dependencies,
  );
  assert.deepEqual(calls.map((call) => call.phase), ["prepare", "settle", "cleanup"]);
  assert.equal(calls[0].role, "promotion-worker");
  const state = await readState();
  const event = [...state.events].reverse().find((item) => (
    item.type === "candidate_qa_approval_revoked" && item.message.startsWith(`${candidate.id}:`)
  ));
  assert.deepEqual(event.promotionSettlement, {
    status: "closed",
    prUrl: candidate.promotion.prUrl,
    observedAt,
    mergeCommit: "",
    mergedAt: "",
  });
  assert.equal(state.candidates.find((item) => item.id === candidate.id).status, "invalidated");
});

test("a merged release PR refuses revocation without changing local QA authority", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidate = initial.candidates[0];
  const dependencies = releaseRevocationDependencies(async () => ({
    status: "merged",
    prUrl: candidate.promotion.prUrl,
    observedAt: "2026-09-03T12:32:00.000Z",
    mergeCommit: "e".repeat(40),
    mergedAt: "2026-09-03T12:31:00.000Z",
  }));

  await assert.rejects(
    recordQaBundleDecision(candidate.qaBundleId, bundleDecisionInput(initial, candidate), dependencies),
    /already merged/i,
  );
  const state = await readState();
  const storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  assert.equal(storedCandidate.status, "release_candidate_ready");
  assert.equal(storedCandidate.qaRevocationIntent.ownerQaPacketDigest, candidate.qaPacket.packetDigest);
  assert.equal(storedCandidate.qaRevocationSettlement.status, "merged");
  assert.equal(state.tasks.find((item) => item.id === initial.tasks[0].id).status, "user_review");
  assert.equal(state.qaBundles.find((item) => item.id === candidate.qaBundleId).status, "release_candidate_ready");
});

test("durable revocation intent survives benign state drift after remote PR closure", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidate = initial.candidates[0];
  const dependencies = releaseRevocationDependencies(async () => {
    await mutateState((state) => {
      state.tasks.find((task) => task.id === initial.tasks[0].id).updatedAt = "2026-09-03T12:33:00.000Z";
    }, { operationName: "test.revocation_remote_close_race" });
    return {
      status: "closed",
      prUrl: candidate.promotion.prUrl,
      observedAt: "2026-09-03T12:33:00.000Z",
      mergeCommit: "",
      mergedAt: "",
    };
  });

  await recordQaBundleDecision(candidate.qaBundleId, bundleDecisionInput(initial, candidate), dependencies);
  const state = await readState();
  assert.equal(state.candidates.find((item) => item.id === candidate.id).status, "invalidated");
  assert.equal(state.tasks.find((item) => item.id === initial.tasks[0].id).status, "needs_changes");
  assert.equal(state.candidates.find((item) => item.id === candidate.id).qaRevocationSettlement.status, "closed");
});

test("a durable pending revocation is autonomously reconciled on a later sweep", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidate = initial.candidates[0];
  const unavailable = releaseRevocationDependencies(async () => ({
    status: "unavailable",
    reason: "temporary GitHub outage",
  }));

  await assert.rejects(
    recordQaBundleDecision(candidate.qaBundleId, bundleDecisionInput(initial, candidate), unavailable),
    /durably pending.*temporary GitHub outage/i,
  );
  let state = await readState();
  let storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  assert.equal(storedCandidate.status, "release_candidate_ready");
  assert.ok(storedCandidate.qaRevocationIntent.requestId);
  assert.equal(storedCandidate.qaRevocationSettlement, undefined);

  const recovered = await reconcilePendingQaRevocations({ task: initial.tasks[0].id }, releaseRevocationDependencies(async () => ({
    status: "closed",
    prUrl: candidate.promotion.prUrl,
    observedAt: "2026-09-03T12:40:00.000Z",
    mergeCommit: "",
    mergedAt: "",
  })));
  assert.deepEqual(recovered, [{ candidateId: candidate.id, status: "revoked" }]);
  state = await readState();
  storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  assert.equal(storedCandidate.status, "invalidated");
  assert.equal(storedCandidate.qaRevocationSettlement.status, "closed");
  assert.equal(state.tasks.find((item) => item.id === initial.tasks[0].id).status, "needs_changes");
});

test("QA-passed absence waits for an active promotion claim and settles after its lease", async () => {
  const initial = await installFixtureState({ candidateStatus: "qa_passed" });
  const candidate = initial.candidates[0];
  await installActivePromotionClaim(candidate.id, "qa-revocation-lease");
  const absent = releaseRevocationDependencies(async () => ({
    status: "absent",
    observedAt: "2026-09-03T12:45:00.000Z",
  }));

  await assert.rejects(
    recordQaBundleDecision(candidate.qaBundleId, bundleDecisionInput(initial, candidate), absent),
    /durably pending.*promotion attempt remains leased/i,
  );
  let state = await readState();
  let storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  assert.equal(storedCandidate.status, "qa_passed");
  assert.ok(storedCandidate.qaRevocationIntent);
  assert.equal(storedCandidate.qaRevocationSettlement, undefined);

  const recovered = await reconcilePendingQaRevocations({
    task: initial.tasks[0].id,
    nowMs: Date.parse("2100-09-03T12:00:00.000Z"),
  }, absent);
  assert.deepEqual(recovered, [{ candidateId: candidate.id, status: "revoked" }]);
  state = await readState();
  storedCandidate = state.candidates.find((item) => item.id === candidate.id);
  assert.equal(storedCandidate.status, "invalidated");
  assert.equal(storedCandidate.qaRevocationSettlement.status, "absent");
});

test("generic state writers cannot plant an exact QA revocation intent or trigger reconciliation", async () => {
  for (const candidateStatus of ["qa_passed", "release_candidate_ready"]) {
    const initial = await installFixtureState({ candidateStatus });
    const candidate = initial.candidates[0];
    const taskId = candidate.manifest.sources[0].taskId;
    const forgedIntent = {
      schemaVersion: "studioops.qa-revocation-intent.v1",
      requestId: "qa_revocation_00000000-0000-4000-8000-000000000001",
      outcome: "failed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      ownerQaPacketDigest: candidate.qaPacket.packetDigest,
      taskIds: candidate.manifest.sources.map((source) => source.taskId).sort(),
      author: "Owner QA",
      notes: "Structurally exact but unauthorized.",
      requestedAt: "2026-09-03T12:48:00.000Z",
    };
    let settlementCalls = 0;
    const dependencies = releaseRevocationDependencies(async () => {
      settlementCalls += 1;
      throw new Error("reconciliation must not settle a rejected forged intent");
    });

    for (const writer of ["mutation", "full_write"]) {
      await assert.rejects(
        writer === "mutation"
          ? mutateState((state) => {
              state.candidates.find((item) => item.id === candidate.id).qaRevocationIntent = structuredClone(forgedIntent);
            }, { operationName: `test.forge_revocation_intent_${candidateStatus}` })
          : (async () => {
              const state = await readState();
              state.candidates.find((item) => item.id === candidate.id).qaRevocationIntent = structuredClone(forgedIntent);
              await writeState(state);
            })(),
        /QA revocation intent requires the fenced owner-QA writer/i,
        `${writer} must reject an exact ${candidateStatus} revocation intent forgery`,
      );

      const recovered = await reconcilePendingQaRevocations({ task: taskId }, dependencies);
      assert.deepEqual(recovered, []);
      assert.equal(settlementCalls, 0);
      const persisted = await readState();
      const storedCandidate = persisted.candidates.find((item) => item.id === candidate.id);
      assert.equal(storedCandidate.status, candidateStatus);
      assert.equal(storedCandidate.qaRevocationIntent, undefined);
    }
  }
});

test("generic and directly imported writers cannot forge remote revocation settlement", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidate = initial.candidates[0];
  await assert.rejects(
    recordQaBundleDecision(
      candidate.qaBundleId,
      bundleDecisionInput(initial, candidate),
      releaseRevocationDependencies(async () => ({
        status: "unavailable",
        reason: "temporary GitHub outage",
      })),
    ),
    /durably pending/i,
  );
  const forged = {
    schemaVersion: "studioops.qa-revocation-settlement.v1",
    status: "merged",
    prUrl: candidate.promotion.prUrl,
    observedAt: "2026-09-03T12:50:00.000Z",
    mergeCommit: "f".repeat(40),
    mergedAt: "2026-09-03T12:49:00.000Z",
  };

  await assert.rejects(
    mutateState((state) => {
      state.candidates.find((item) => item.id === candidate.id).qaRevocationSettlement = forged;
    }, { operationName: "test.forge_revocation_settlement" }),
    /fenced remote-observation writer/i,
  );
  await assert.rejects(
    (async () => {
      const state = await readState();
      state.candidates.find((item) => item.id === candidate.id).qaRevocationSettlement = forged;
      await writeState(state);
    })(),
    /fenced remote-observation writer/i,
  );
  await assert.rejects(
    mutateQaRevocationSettlementState(candidate.id, forged, (state, authorized) => {
      state.candidates.find((item) => item.id === candidate.id).qaRevocationSettlement = authorized;
    }),
    /remote-observation attestation/i,
  );

  const state = await readState();
  assert.equal(state.candidates.find((item) => item.id === candidate.id).qaRevocationSettlement, undefined);
});

test("raw state writers cannot strand a release candidate outside reconciliation", async () => {
  const initial = await installFixtureState({ candidateStatus: "release_candidate_ready" });
  const candidate = initial.candidates[0];
  const taskId = initial.tasks[0].id;

  await assert.rejects(
    mutateState((state) => {
      state.tasks.find((item) => item.id === taskId).status = "blocked";
    }, { operationName: "test.strand_release_candidate" }),
    /reconciliation-safe task and bundle lifecycle/i,
  );
  await assert.rejects(
    (async () => {
      const state = await readState();
      state.tasks.find((item) => item.id === taskId).status = "closed";
      await writeState(state);
    })(),
    /reconciliation-safe task and bundle lifecycle/i,
  );

  const state = await readState();
  assert.equal(state.candidates.find((item) => item.id === candidate.id).status, "release_candidate_ready");
  assert.equal(state.tasks.find((item) => item.id === taskId).status, "user_review");
});

test("raw state writers cannot strand a QA-passed candidate with an active promotion claim", async () => {
  const initial = await installFixtureState({ candidateStatus: "qa_passed" });
  const candidate = initial.candidates[0];
  const taskId = initial.tasks[0].id;
  await installActivePromotionClaim(candidate.id, "raw-writer-active");

  await assert.rejects(
    mutateState((state) => {
      state.tasks.find((item) => item.id === taskId).status = "closed";
    }, { operationName: "test.strand_qa_passed_claim" }),
    /reconciliation-safe task and bundle lifecycle/i,
  );
  await assert.rejects(
    (async () => {
      const state = await readState();
      state.qaBundles.find((item) => item.id === candidate.qaBundleId).status = "invalidated";
      await writeState(state);
    })(),
    /reconciliation-safe task and bundle lifecycle/i,
  );
  for (const [label, mutate] of [
    ["assignment", (task) => { task.assignedAgentRole = "builder"; }],
    ["candidate link", (task) => { task.candidateId = ""; }],
    ["bundle link", (task) => { task.qaBundleId = ""; }],
    ["manifest link", (task) => { task.candidateManifestDigest = ""; }],
    ["integration link", (task) => { task.integrationCommit = ""; }],
  ]) {
    await assert.rejects(
      mutateState((state) => {
        mutate(state.tasks.find((item) => item.id === taskId));
      }, { operationName: `test.strand_qa_passed_claim_${label.replaceAll(" ", "_")}` }),
      /exact authority links and assignments/i,
      label,
    );
  }

  const state = await readState();
  assert.equal(state.tasks.find((item) => item.id === taskId).status, "approved_for_main");
  assert.equal(state.tasks.find((item) => item.id === taskId).assignedAgentRole, "promotion-worker");
  assert.equal(state.tasks.find((item) => item.id === taskId).candidateId, candidate.id);
  assert.equal(state.tasks.find((item) => item.id === taskId).qaBundleId, candidate.qaBundleId);
  assert.equal(state.tasks.find((item) => item.id === taskId).candidateManifestDigest, candidate.manifestDigest);
  assert.equal(state.tasks.find((item) => item.id === taskId).integrationCommit, candidate.manifest.integration.sha);
  assert.equal(state.qaBundles.find((item) => item.id === candidate.qaBundleId).status, "passed");
});

test("terminal promotion claims keep QA-passed retry authority reconciliation-safe", async () => {
  const initial = await installFixtureState({ candidateStatus: "qa_passed" });
  const candidate = initial.candidates[0];
  const taskId = initial.tasks[0].id;
  const activeClaim = await installActivePromotionClaim(candidate.id, "raw-writer-terminal");
  await terminalizePromotionClaim(candidate.id, activeClaim, "push_failed");

  await assert.rejects(
    mutateState((state) => {
      state.tasks.find((item) => item.id === taskId).status = "closed";
    }, { operationName: "test.strand_terminal_qa_passed_claim" }),
    /reconciliation-safe task and bundle lifecycle/i,
  );
  await assert.rejects(
    (async () => {
      const state = await readState();
      state.qaBundles.find((item) => item.id === candidate.qaBundleId).status = "invalidated";
      await writeState(state);
    })(),
    /reconciliation-safe task and bundle lifecycle/i,
  );

  const state = await readState();
  assert.equal(state.tasks.find((item) => item.id === taskId).status, "approved_for_main");
  assert.equal(state.qaBundles.find((item) => item.id === candidate.qaBundleId).status, "passed");
  assert.equal(state.meta.promotionAttemptClaims[candidate.id].status, "terminal");
});
