import assert from "node:assert/strict";
import test from "node:test";
import { createCandidateEnvelope, invalidateCandidate } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import {
  assertPromotionAttemptClaimInState,
  assertPromotionAttemptClaimTransitionAttestation,
  assertTerminalMergedPromotionClaimForTask,
  bindPromotionReconciliationReplacementInState,
  claimPromotionAttemptInState,
  promotionProjectPolicyBinding,
  recordPromotionRecoveryReceiptInState,
  renewPromotionAttemptClaimInState,
  terminalPromotionAttemptClaimInState,
  validPromotionRetryAuthorization,
} from "../src/promotion-attempt-claim.js";

const NOW = Date.parse("2026-09-03T16:00:00.000Z");
const POLICY = `sha256:${"9".repeat(64)}`;
const FIRST_EVIDENCE = `sha256:${"8".repeat(64)}`;
const OUTPUT_A = `sha256:${"7".repeat(64)}`;
const OUTPUT_B = `sha256:${"6".repeat(64)}`;
const PROJECT_POLICY = {
  repoPath: "/tmp/demo",
  repoUrl: "https://github.com/example/demo",
  enabled: true,
  targetBranch: "main",
};
const SHA = {
  base: "1".repeat(40),
  sourceA: "2".repeat(40),
  sourceB: "3".repeat(40),
  integration: "4".repeat(40),
};

function review(id, sha) {
  return {
    id,
    stageKey: "lead",
    role: "lead-reviewer",
    outcome: "approved",
    subjectSha: sha,
    candidateCycle: 3,
    reviewedAt: "2026-09-03T15:00:00.000Z",
  };
}

function fixture({ retry = true, multiTask = true } = {}) {
  const sources = [
    {
      taskId: "task_1",
      sourceRef: "refs/heads/codex/one",
      headSha: SHA.sourceA,
      candidateCycle: 3,
      reviews: [review("review_1", SHA.sourceA)],
    },
  ];
  if (multiTask) {
    sources.push({
      taskId: "task_2",
      sourceRef: "refs/heads/codex/two",
      headSha: SHA.sourceB,
      candidateCycle: 3,
      reviews: [review("review_2", SHA.sourceB)],
    });
  }
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    createdAt: "2026-09-03T15:30:00.000Z",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: SHA.base },
      sources,
      integration: { branch: "qa/studioops-candidate-1", sha: SHA.integration },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "npm run check",
        outcome: "passed",
        subjectSha: SHA.integration,
        evidenceDigest: `sha256:${"5".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: SHA.integration,
        verifiedAt: "2026-09-03T15:35:00.000Z",
        attestation: { kind: "header", key: "x-studioops-commit", observedSha: SHA.integration },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: sources.map((source) => source.taskId),
        includedTaskIds: sources.map((source) => source.taskId),
        excludedTaskIds: [],
      },
    },
  });
  candidate.status = "qa_passed";
  candidate.qaDecision = {
    outcome: "passed",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    taskIds: sources.map((source) => source.taskId),
    author: "Owner QA",
    repositoryVerifiedAt: "2026-09-03T15:45:00.000Z",
    decidedAt: "2026-09-03T15:46:00.000Z",
  };
  const tasks = sources.map((source, index) => ({
    id: source.taskId,
    projectId: "project_1",
    status: "approved_for_main",
    assignedAgentRole: "promotion-worker",
    stateVersion: 10 + index,
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: source.headSha,
    reviewSubjectCycle: source.candidateCycle,
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts: retry ? 1 : 0,
    promotionValidation: retry ? {
      status: "validation_failed",
      commands: [{ command: "npm run check", ok: false, outputDigest: FIRST_EVIDENCE }],
      evidence: {
        path: `/private-evidence/${source.taskId}.json`,
        digest: FIRST_EVIDENCE,
        bytes: 512,
        createdAt: "2026-09-03T15:54:00.000Z",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: candidate.manifest.integration.sha,
        attempt: 1,
        policyDigest: POLICY,
        commandCount: 1,
      },
      omittedSummaryCount: 0,
    } : null,
    promotionRetryAuthorization: retry ? {
      schemaVersion: "studioops.promotion-retry-authorization.v1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      policyDigest: POLICY,
      firstEvidenceDigest: FIRST_EVIDENCE,
      independentResult: "validation_failed",
      authorizedBy: "owner:test",
      authorizedAt: "2026-09-03T15:55:00.000Z",
    } : null,
  }));
  const bundle = {
    id: candidate.qaBundleId,
    projectId: candidate.projectId,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.manifest.integration.branch,
    integrationCommit: candidate.manifest.integration.sha,
    previewUrl: candidate.manifest.preview.url,
    tasks: tasks.map((task) => ({ id: task.id })),
    status: "passed",
  };
  const current = {
    state: {
      meta: {},
      projects: [{
        id: "project_1",
        repoPath: PROJECT_POLICY.repoPath,
        repoUrl: PROJECT_POLICY.repoUrl,
        defaultBranch: "main",
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks,
      candidates: [candidate],
      qaBundles: [bundle],
    },
    candidate,
    tasks,
    bundle,
  };
  refreshOwnerQaPacket(current);
  return current;
}

function refreshOwnerQaPacket(current) {
  const packet = buildOwnerQaPacket(current.state, current.candidate, {
    bundle: current.bundle,
    generatedAt: "2026-09-03T15:44:00.000Z",
  });
  current.candidate.qaPacket = structuredClone(packet);
  current.bundle.qaPacket = structuredClone(packet);
  current.bundle.packetDigest = packet.packetDigest;
  if (current.candidate.qaDecision) {
    current.candidate.qaDecision.ownerQaPacketDigest = packet.packetDigest;
    current.bundle.qaDecision = structuredClone(current.candidate.qaDecision);
  }
  return current;
}

function markReleaseCandidateReady(current, taskStatus = "user_review") {
  current.candidate.status = "release_candidate_ready";
  current.candidate.promotion = {
    branch: "qa/promotion-demo",
    prUrl: "https://github.com/example/demo/pull/42",
    commitSha: current.candidate.manifest.integration.sha,
    manifestDigest: current.candidate.manifestDigest,
    readyAt: new Date(NOW).toISOString(),
  };
  for (const task of current.tasks) {
    task.status = taskStatus;
    task.assignedAgentRole = taskStatus === "user_review"
      ? "owner"
      : taskStatus === "promotion_blocked"
        ? "promotion-worker"
        : "";
    task.stateVersion += 1;
    task.promotionStatus = "pr_ready";
    task.promotionBranch = current.candidate.promotion.branch;
    task.promotionPrUrl = current.candidate.promotion.prUrl;
    task.promotionCommit = current.candidate.promotion.commitSha;
  }
  return current;
}

function input(overrides = {}) {
  return {
    projectId: "project_1",
    candidateId: "candidate_1",
    mode: "retry",
    policyDigest: POLICY,
    projectPolicy: PROJECT_POLICY,
    nowMs: NOW,
    ttlMs: 10_000,
    claimIdFactory: () => "claim_1",
    ...overrides,
  };
}

function validation() {
  return [
    { command: "npm run check", ok: true, outputDigest: OUTPUT_A },
    { command: "git diff --check", status: "passed", outputDigest: OUTPUT_B },
  ];
}

function recoveryEvidence(candidate, overrides = {}) {
  return {
    path: "/private-evidence/recovery.json",
    digest: `sha256:${"a".repeat(64)}`,
    bytes: 1_024,
    createdAt: "2026-09-03T16:00:00.000Z",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    attempt: 2,
    policyDigest: POLICY,
    commandCount: 2,
    ...overrides,
  };
}

test("candidate-wide atomic claim admits one winner", () => {
  const { state, candidate } = fixture();
  const first = claimPromotionAttemptInState(state, input());
  const second = claimPromotionAttemptInState(state, input({ claimIdFactory: () => "claim_2" }));
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "active");
  assert.equal(second.claim.claimId, first.claim.claimId);
  assert.equal(first.claim.schemaVersion, "studioops.promotion-attempt-claim.v4");
  assert.equal(first.claim.ownerQaPacketDigest, candidate.qaPacket.packetDigest);
  assert.equal(first.claim.qaDecision.ownerQaPacketDigest, candidate.qaPacket.packetDigest);
  assert.deepEqual(first.claim.expectedTaskStateVersions, { task_1: 10, task_2: 11 });
});

test("private transition attestations cover acquire, renew, receipt, and terminal helpers", () => {
  const current = fixture({ retry: false, multiTask: false });
  const claimInput = input({ mode: "create" });
  const beforeAcquire = current.state.meta?.promotionAttemptClaims?.[current.candidate.id];
  const acquired = claimPromotionAttemptInState(current.state, claimInput);
  assert.equal(
    assertPromotionAttemptClaimTransitionAttestation(
      acquired,
      current.candidate.id,
      beforeAcquire,
      current.state,
    ),
    true,
  );

  const beforeRenew = structuredClone(current.state.meta.promotionAttemptClaims[current.candidate.id]);
  const renewed = renewPromotionAttemptClaimInState(current.state, acquired.claim, {
    ...claimInput,
    nowMs: NOW + 1,
  });
  assert.equal(
    assertPromotionAttemptClaimTransitionAttestation(
      renewed,
      current.candidate.id,
      beforeRenew,
      current.state,
    ),
    true,
  );

  const beforeReceipt = structuredClone(current.state.meta.promotionAttemptClaims[current.candidate.id]);
  const recorded = recordPromotionRecoveryReceiptInState(current.state, renewed, {
    ...claimInput,
    nowMs: NOW + 2,
    validationResults: validation(),
    validationEvidence: recoveryEvidence(current.candidate, { attempt: 1 }),
  });
  assert.equal(
    assertPromotionAttemptClaimTransitionAttestation(
      recorded,
      current.candidate.id,
      beforeReceipt,
      current.state,
    ),
    true,
  );

  const beforeTerminal = structuredClone(current.state.meta.promotionAttemptClaims[current.candidate.id]);
  const terminal = terminalPromotionAttemptClaimInState(current.state, recorded.claim, {
    ...claimInput,
    nowMs: NOW + 3,
    outcome: "pr_ready",
  });
  assert.equal(
    assertPromotionAttemptClaimTransitionAttestation(
      terminal,
      current.candidate.id,
      beforeTerminal,
      current.state,
    ),
    true,
  );
});

test("claim transition attestations reject lookalikes and post-helper tampering", () => {
  const lookalikeFixture = fixture({ retry: false, multiTask: false });
  const claimInput = input({ mode: "create" });
  const acquired = claimPromotionAttemptInState(lookalikeFixture.state, claimInput);
  assert.throws(
    () => assertPromotionAttemptClaimTransitionAttestation(
      structuredClone(acquired),
      lookalikeFixture.candidate.id,
      undefined,
      lookalikeFixture.state,
    ),
    /no private helper attestation/i,
  );
  assert.throws(
    () => assertPromotionAttemptClaimTransitionAttestation(
      acquired,
      lookalikeFixture.candidate.id,
      {},
      lookalikeFixture.state,
    ),
    /pre-claim value/i,
  );

  acquired.claim.claimId = "tampered_return";
  assert.throws(
    () => assertPromotionAttemptClaimTransitionAttestation(
      acquired,
      lookalikeFixture.candidate.id,
      undefined,
      lookalikeFixture.state,
    ),
    /returned object changed/i,
  );

  const persistedFixture = fixture({ retry: false, multiTask: false });
  const persisted = claimPromotionAttemptInState(persistedFixture.state, claimInput);
  persistedFixture.state.meta.promotionAttemptClaims[persistedFixture.candidate.id].claimId = "tampered_state";
  assert.throws(
    () => assertPromotionAttemptClaimTransitionAttestation(
      persisted,
      persistedFixture.candidate.id,
      undefined,
      persistedFixture.state,
    ),
    /persisted post-claim value changed/i,
  );
});

test("claim acquisition and use require the exact current task assignment authority", () => {
  for (const attemptMode of ["create", "retry"]) {
    const current = fixture({ retry: attemptMode === "retry", multiTask: false });
    current.tasks[0].assignedAgentRole = "builder";
    assert.throws(
      () => claimPromotionAttemptInState(current.state, input({ mode: attemptMode })),
      /no longer matches the promotion candidate/i,
      `${attemptMode}: acquire`,
    );
  }

  const active = fixture({ multiTask: false });
  const claim = claimPromotionAttemptInState(active.state, input()).claim;
  active.tasks[0].assignedAgentRole = "builder";
  const activeOperations = [
    ["assert", () => assertPromotionAttemptClaimInState(active.state, claim, input())],
    ["renew", () => renewPromotionAttemptClaimInState(active.state, claim, input())],
    ["receipt", () => recordPromotionRecoveryReceiptInState(active.state, claim, {
      ...input(),
      validationResults: validation(),
      validationEvidence: recoveryEvidence(active.candidate),
    })],
    ["terminal", () => terminalPromotionAttemptClaimInState(active.state, claim, {
      ...input(),
      outcome: "validation_failed",
    })],
  ];
  for (const [operation, invoke] of activeOperations) {
    assert.throws(
      invoke,
      /no longer matches the promotion candidate/i,
      `active claim ${operation}`,
    );
  }

  const release = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
  release.tasks[0].assignedAgentRole = "builder";
  assert.throws(
    () => claimPromotionAttemptInState(release.state, input({ mode: "reconcile" })),
    /no longer matches the promotion candidate/i,
    "reconcile owner handoff",
  );

  for (const role of ["owner", "promotion-worker"]) {
    const blocked = markReleaseCandidateReady(
      fixture({ retry: false, multiTask: false }),
      "promotion_blocked",
    );
    blocked.tasks[0].assignedAgentRole = role;
    assert.equal(
      claimPromotionAttemptInState(blocked.state, input({ mode: "reconcile" })).acquired,
      true,
      `reconcile promotion_blocked ${role}`,
    );
  }
  const blockedBuilder = markReleaseCandidateReady(
    fixture({ retry: false, multiTask: false }),
    "promotion_blocked",
  );
  blockedBuilder.tasks[0].assignedAgentRole = "builder";
  assert.throws(
    () => claimPromotionAttemptInState(blockedBuilder.state, input({ mode: "reconcile" })),
    /no longer matches the promotion candidate/i,
    "reconcile promotion_blocked builder",
  );
});

test("expired claim takeover waits for deterministic backoff and increments the fence", () => {
  const { state } = fixture();
  const first = claimPromotionAttemptInState(state, input()).claim;
  const expired = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(expired.acquired, false);
  assert.equal(expired.reason, "retry_deferred");
  assert.equal(expired.claim.status, "terminal");
  assert.equal(expired.claim.outcome, "claim_expired");
  assert.equal(expired.retryNotBefore, new Date(NOW + 70_001).toISOString());
  const stillDeferred = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 70_000,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(stillDeferred.reason, "retry_deferred");
  assert.equal(stillDeferred.retryNotBefore, expired.retryNotBefore);
  const takeover = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 70_001,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.claim.fence, first.fence + 1);
  assert.equal(takeover.claim.claimId, "claim_2");
  assert.equal(takeover.claim.operationalAttempt, 2);
});

test("stale owner cannot assert, renew, record, or terminalize", () => {
  const { state } = fixture();
  const stale = claimPromotionAttemptInState(state, input()).claim;
  claimPromotionAttemptInState(state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  const current = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 70_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  const later = input({ nowMs: NOW + 70_002 });
  assert.throws(() => assertPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.throws(() => renewPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.throws(() => recordPromotionRecoveryReceiptInState(state, stale, { ...later, validationResults: validation() }), /stale/i);
  assert.throws(() => terminalPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.doesNotThrow(() => assertPromotionAttemptClaimInState(state, current, later));
});

test("terminal create PR-ready claim hands off to reconciliation without consuming an operational attempt", () => {
  const current = fixture({ retry: false, multiTask: false });
  const createClaim = claimPromotionAttemptInState(current.state, input({ mode: "create" })).claim;
  const ready = terminalPromotionAttemptClaimInState(current.state, createClaim, {
    ...input({ mode: "create" }),
    outcome: "pr_ready",
  });
  markReleaseCandidateReady(current);

  const reconciled = claimPromotionAttemptInState(current.state, input({
    mode: "reconcile",
    nowMs: NOW + 1,
    claimIdFactory: () => "claim_reconcile",
  }));
  assert.equal(reconciled.acquired, true);
  assert.equal(reconciled.claim.mode, "reconcile");
  assert.equal(reconciled.claim.attempt, 0);
  assert.equal(reconciled.claim.operationalAttempt, ready.operationalAttempt);
  assert.equal(reconciled.claim.fence, ready.fence + 1);
  assert.equal(reconciled.claim.retryNotBefore, "");
  assert.equal(reconciled.claim.circuit, null);
});

test("reconciliation claims exclude active competitors and can poll repeatedly without budget or delay", () => {
  const current = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
  const first = claimPromotionAttemptInState(current.state, input({
    mode: "reconcile",
    claimIdFactory: () => "claim_reconcile_1",
  })).claim;
  assert.equal(first.operationalAttempt, 0);

  const competitor = claimPromotionAttemptInState(current.state, input({
    mode: "reconcile",
    claimIdFactory: () => "claim_reconcile_competitor",
  }));
  assert.equal(competitor.acquired, false);
  assert.equal(competitor.reason, "active");
  assert.equal(competitor.claim.claimId, first.claimId);

  const pending = terminalPromotionAttemptClaimInState(current.state, first, {
    ...input({ mode: "reconcile" }),
    outcome: "pending",
  });
  assert.equal(pending.retryNotBefore, "");
  assert.equal(pending.attemptsExhausted, false);
  assert.equal(pending.circuit, null);

  const second = claimPromotionAttemptInState(current.state, input({
    mode: "reconcile",
    nowMs: NOW + 1,
    claimIdFactory: () => "claim_reconcile_2",
  })).claim;
  assert.equal(second.operationalAttempt, 0);
  assert.equal(second.fence, first.fence + 1);
  const operationallyNamedOutcome = terminalPromotionAttemptClaimInState(current.state, second, {
    ...input({ mode: "reconcile", nowMs: NOW + 1 }),
    outcome: "auth_failed",
  });
  assert.equal(operationallyNamedOutcome.retryNotBefore, "");
  assert.equal(operationallyNamedOutcome.attemptsExhausted, false);
  assert.equal(operationallyNamedOutcome.circuit, null);

  const third = claimPromotionAttemptInState(current.state, input({
    mode: "reconcile",
    nowMs: NOW + 2,
    claimIdFactory: () => "claim_reconcile_3",
  }));
  assert.equal(third.acquired, true);
  assert.equal(third.claim.operationalAttempt, 0);
});

test("reconciliation admits only exact release-ready source lifecycle bindings", () => {
  for (const taskStatus of ["user_review", "promotion_blocked", "merged", "deployed", "done"]) {
    const current = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }), taskStatus);
    const claimed = claimPromotionAttemptInState(current.state, input({
      mode: "reconcile",
      claimIdFactory: () => `claim_${taskStatus}`,
    }));
    assert.equal(claimed.acquired, true, taskStatus);
  }

  const wrongCandidateState = fixture({ retry: false, multiTask: false });
  wrongCandidateState.tasks[0].status = "user_review";
  assert.throws(
    () => claimPromotionAttemptInState(wrongCandidateState.state, input({ mode: "reconcile" })),
    /release-candidate ready/i,
  );

  const wrongTaskState = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
  wrongTaskState.tasks[0].status = "approved_for_main";
  assert.throws(
    () => claimPromotionAttemptInState(wrongTaskState.state, input({ mode: "reconcile" })),
    /no longer matches/i,
  );
});

test("reconciliation claim rejects candidate, task, stateVersion, and project-policy drift", () => {
  const cases = [
    ["candidate state", (current) => { current.candidate.status = "qa_passed"; }, /release-candidate ready/i],
    ["candidate QA decision", (current) => { current.candidate.qaDecision.author = "Changed owner"; }, /QA decision|binding changed/i],
    ["task binding", (current) => { current.tasks[0].candidateId = "candidate_other"; }, /no longer matches/i],
    ["task promotion mirror", (current) => { current.tasks[0].promotionBranch = "qa/other"; }, /promotion handoff mirror/i],
    ["task stateVersion", (current) => { current.tasks[0].stateVersion += 1; }, /stateVersion|binding changed/i],
    ["project policy", (current) => { current.state.projects[0].repoUrl = "https:\/\/github.com\/example\/other.git"; }, /project policy changed/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const current = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
    const claim = claimPromotionAttemptInState(current.state, input({ mode: "reconcile" })).claim;
    mutate(current);
    assert.throws(
      () => assertPromotionAttemptClaimInState(current.state, claim, input({ mode: "reconcile" })),
      expected,
      label,
    );
  }
});

test("reconciliation claim binds authoritative replacement promotion and merge identity", () => {
  const current = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
  const replacement = createCandidateEnvelope({
    qaBundleId: "qa_bundle_2",
    createdAt: "2026-09-03T15:40:00.000Z",
    manifest: {
      candidateId: "candidate_2",
      projectId: "project_1",
      base: { branch: "main", sha: SHA.base },
      sources: [{
        taskId: "task_2",
        sourceRef: "refs/heads/codex/replacement",
        headSha: SHA.sourceB,
        candidateCycle: 3,
        reviews: [review("review_replacement", SHA.sourceB)],
      }],
      integration: { branch: "qa/candidate-replacement", sha: SHA.sourceB },
      checks: [{
        id: "check_replacement",
        kind: "local-validation",
        name: "npm run check",
        outcome: "passed",
        subjectSha: SHA.sourceB,
        evidenceDigest: `sha256:${"5".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: SHA.sourceB,
        verifiedAt: "2026-09-03T15:45:00.000Z",
        attestation: { kind: "header", key: "x-studioops-commit", observedSha: SHA.sourceB },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: [],
      },
    },
  });
  replacement.status = "merged";
  replacement.qaDecision = {
    outcome: "passed",
    candidateId: replacement.id,
    manifestDigest: replacement.manifestDigest,
    integrationSha: replacement.manifest.integration.sha,
    taskIds: ["task_2"],
    author: "Owner QA",
    repositoryVerifiedAt: "2026-09-03T15:45:30.000Z",
    decidedAt: "2026-09-03T15:45:45.000Z",
  };
  replacement.promotion = {
    branch: "qa/promotion-replacement",
    prUrl: "https://github.com/example/demo/pull/43",
    commitSha: SHA.sourceB,
    manifestDigest: replacement.manifestDigest,
    readyAt: "2026-09-03T15:46:00.000Z",
  };
  replacement.promotionMerge = {
    mergeCommit: "5".repeat(40),
    mergedAt: "2026-09-03T15:47:00.000Z",
    reconciledAt: "2026-09-03T15:48:00.000Z",
  };
  const replacementTask = {
    id: "task_2",
    projectId: "project_1",
    title: "Replacement task",
    status: "merged",
    stateVersion: 1,
    candidateId: replacement.id,
    qaBundleId: replacement.qaBundleId,
    reviewSubjectSha: SHA.sourceB,
    reviewSubjectCycle: 3,
  };
  const replacementBundle = {
    id: replacement.qaBundleId,
    projectId: replacement.projectId,
    candidateId: replacement.id,
    manifestDigest: replacement.manifestDigest,
    integrationBranch: replacement.manifest.integration.branch,
    integrationCommit: replacement.manifest.integration.sha,
    previewUrl: replacement.manifest.preview.url,
    tasks: [{ id: replacementTask.id }],
    status: "merged",
  };
  current.state.tasks.push(replacementTask);
  current.state.qaBundles.push(replacementBundle);
  current.state.candidates.push(replacement);
  const replacementPacket = buildOwnerQaPacket(current.state, replacement, {
    bundle: replacementBundle,
    generatedAt: "2026-09-03T15:45:15.000Z",
  });
  replacement.qaPacket = structuredClone(replacementPacket);
  replacementBundle.qaPacket = structuredClone(replacementPacket);
  replacementBundle.packetDigest = replacementPacket.packetDigest;
  replacement.qaDecision.ownerQaPacketDigest = replacementPacket.packetDigest;
  replacementBundle.qaDecision = structuredClone(replacement.qaDecision);
  const claimInput = input({ mode: "reconcile" });
  const claim = claimPromotionAttemptInState(current.state, claimInput).claim;
  const replacementBinding = {
    candidateId: replacement.id,
    manifestDigest: replacement.manifestDigest,
    integrationBranch: replacement.manifest.integration.branch,
    integrationSha: replacement.manifest.integration.sha,
    qaDecision: replacement.qaDecision,
    promotion: replacement.promotion,
    promotionMerge: replacement.promotionMerge,
    observedPromotionPr: {
      number: 43,
      url: replacement.promotion.prUrl,
      state: "MERGED",
      mergedAt: replacement.promotionMerge.mergedAt,
      mergeCommit: replacement.promotionMerge.mergeCommit,
      baseRefName: "main",
      headRefName: replacement.promotion.branch,
      headRefOid: replacement.manifest.integration.sha,
      headRepository: "example/demo",
      repository: "example/demo",
      candidateMarker: `<!-- studioops-candidate:${replacement.id}:${replacement.manifestDigest} -->`,
    },
  };
  for (const [label, mutate] of [
    ["PR number", (value) => { value.observedPromotionPr.number += 1; }],
    ["canonical PR URL", (value) => {
      value.observedPromotionPr.url = `https://github.com/example/demo?ignored=/pull/${value.observedPromotionPr.number}`;
    }],
    ["repository", (value) => { value.observedPromotionPr.repository = "other/demo"; }],
    ["head repository", (value) => { value.observedPromotionPr.headRepository = "other/demo"; }],
    ["base branch", (value) => { value.observedPromotionPr.baseRefName = "release"; }],
    ["head branch", (value) => { value.observedPromotionPr.headRefName = "qa/promotion-other"; }],
    ["head SHA", (value) => { value.observedPromotionPr.headRefOid = SHA.sourceA; }],
    ["candidate marker", (value) => {
      value.observedPromotionPr.candidateMarker = `<!-- studioops-candidate:${replacement.id}:sha256:${"0".repeat(64)} -->`;
    }],
  ]) {
    const mismatched = structuredClone(replacementBinding);
    mutate(mismatched);
    assert.throws(
      () => bindPromotionReconciliationReplacementInState(
        current.state,
        claim,
        { ...claimInput, replacement: mismatched },
      ),
      /canonical|number does not match|internally inconsistent|authoritative project and candidate identity/i,
      label,
    );
  }
  const beforeBinding = structuredClone(
    current.state.meta.promotionAttemptClaims[current.candidate.id],
  );
  const bound = bindPromotionReconciliationReplacementInState(
    current.state,
    claim,
    { ...claimInput, replacement: replacementBinding },
  );

  assert.equal(bound.reconciliationReplacement.candidateId, replacement.id);
  assert.match(bound.reconciliationReplacementDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    assertPromotionAttemptClaimTransitionAttestation(
      bound,
      current.candidate.id,
      beforeBinding,
      current.state,
    ),
    true,
  );
  assert.doesNotThrow(() => assertPromotionAttemptClaimInState(current.state, bound, claimInput));

  replacement.promotionMerge.mergeCommit = "6".repeat(40);
  assert.throws(
    () => assertPromotionAttemptClaimInState(current.state, bound, claimInput),
    /replacement promotion candidate .* changed|replacement identity is internally inconsistent/i,
  );
  assert.throws(
    () => terminalPromotionAttemptClaimInState(current.state, bound, { ...claimInput, outcome: "merged" }),
    /replacement promotion candidate .* changed|replacement identity is internally inconsistent/i,
  );
});

test("multi-task stateVersion drift invalidates the whole candidate claim", () => {
  const { state, tasks } = fixture();
  const claim = claimPromotionAttemptInState(state, input()).claim;
  tasks[1].stateVersion += 1;
  assert.throws(() => assertPromotionAttemptClaimInState(state, claim, input()), /stateVersion|binding changed/i);
});

test("candidate invalidation and validation policy drift reject the claim", () => {
  const invalidated = fixture();
  const invalidationClaim = claimPromotionAttemptInState(invalidated.state, input()).claim;
  invalidateCandidate(invalidated.candidate, { reason: "Source moved.", expected: SHA.sourceA, observed: SHA.sourceB });
  assert.throws(() => assertPromotionAttemptClaimInState(invalidated.state, invalidationClaim, input()), /invalidated/i);

  const drifted = fixture();
  const policyClaim = claimPromotionAttemptInState(drifted.state, input()).claim;
  assert.throws(() => assertPromotionAttemptClaimInState(drifted.state, policyClaim, input({
    policyDigest: `sha256:${"a".repeat(64)}`,
  })), /policy|authorization/i);
});

test("claims require and fence the normalized authoritative candidate QA tuple", () => {
  const missing = fixture({ retry: false, multiTask: false });
  missing.candidate.qaDecision = null;
  assert.throws(
    () => claimPromotionAttemptInState(missing.state, input({ mode: "create" })),
    /no authoritative QA decision/i,
  );

  const legacy = fixture({ retry: false, multiTask: false });
  delete legacy.candidate.qaDecision.ownerQaPacketDigest;
  assert.throws(
    () => claimPromotionAttemptInState(legacy.state, input({ mode: "create" })),
    /owner QA packet digest is required/i,
  );

  const mismatched = fixture({ retry: false, multiTask: false });
  mismatched.candidate.qaDecision.ownerQaPacketDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => claimPromotionAttemptInState(mismatched.state, input({ mode: "create" })),
    /no longer has an authoritative QA decision/i,
  );

  const current = fixture({ retry: false, multiTask: false });
  const claim = claimPromotionAttemptInState(current.state, input({ mode: "create" })).claim;
  assert.deepEqual(claim.qaDecision, {
    outcome: "passed",
    candidateId: current.candidate.id,
    manifestDigest: current.candidate.manifestDigest,
    integrationSha: current.candidate.manifest.integration.sha,
    ownerQaPacketDigest: current.candidate.qaPacket.packetDigest,
    taskIds: ["task_1"],
    author: "Owner QA",
    repositoryVerifiedAt: "2026-09-03T15:45:00.000Z",
    decidedAt: "2026-09-03T15:46:00.000Z",
  });
  current.candidate.qaDecision.decidedAt = "2026-09-03T15:47:00.000Z";
  assert.throws(
    () => assertPromotionAttemptClaimInState(current.state, claim, input({ mode: "create" })),
    /binding changed|QA decision/i,
  );
});

test("promotion dependencies are enforced at claim time and fenced by authoritative state", () => {
  const blocked = fixture({ retry: false, multiTask: false });
  blocked.tasks[0].dependsOnTaskIds = ["task_dependency"];
  blocked.state.tasks.push({
    id: "task_dependency",
    projectId: "project_1",
    status: "needs_changes",
    stateVersion: 4,
  });
  refreshOwnerQaPacket(blocked);
  assert.throws(
    () => claimPromotionAttemptInState(blocked.state, input({ mode: "create" })),
    /dependency .* is not complete/i,
  );

  blocked.state.tasks[1].status = "merged";
  blocked.state.tasks[1].stateVersion += 1;
  const claim = claimPromotionAttemptInState(blocked.state, input({ mode: "create" })).claim;
  blocked.state.tasks[1].status = "needs_changes";
  blocked.state.tasks[1].stateVersion += 1;
  assert.throws(
    () => assertPromotionAttemptClaimInState(blocked.state, claim, input({ mode: "create" })),
    /dependency .* is not complete|binding changed/i,
  );
});

test("a merged reconciliation claim terminally binds PR, merge SHA, and merge time", () => {
  const current = markReleaseCandidateReady(fixture({ retry: false, multiTask: false }));
  const claimInput = input({ mode: "reconcile" });
  const claim = claimPromotionAttemptInState(current.state, claimInput).claim;
  const terminal = terminalPromotionAttemptClaimInState(current.state, claim, {
    ...claimInput,
    outcome: "merged",
    terminalResult: {
      candidateId: current.candidate.id,
      manifestDigest: current.candidate.manifestDigest,
      prUrl: current.candidate.promotion.prUrl,
      mergeCommit: "f".repeat(40),
      mergedAt: "2026-09-03T16:01:00.000Z",
    },
  });
  assert.equal(terminal.terminalResult.prUrl, current.candidate.promotion.prUrl);
  assert.equal(terminal.terminalResult.mergeCommit, "f".repeat(40));
  assert.equal(terminal.ownerQaPacketDigest, current.candidate.qaPacket.packetDigest);
  assert.doesNotThrow(() => assertTerminalMergedPromotionClaimForTask(
    terminal,
    current.tasks[0],
    current.candidate,
    { candidates: current.state.candidates },
  ));
  current.candidate.qaDecision.ownerQaPacketDigest = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => assertTerminalMergedPromotionClaimForTask(
      terminal,
      current.tasks[0],
      current.candidate,
      { candidates: current.state.candidates },
    ),
    /QA or promotion handoff changed|authoritative QA decision/i,
  );
  assert.match(terminal.terminalResultDigest, /^sha256:[a-f0-9]{64}$/);
});

test("claim, renewal, receipt, and terminal operations bind the exact current project promotion policy", () => {
  const mutations = [
    ["repoPath", (project) => { project.repoPath = "/tmp/other"; }],
    ["repoUrl", (project) => { project.repoUrl = "https://github.com/example/other.git"; }],
    ["enabled", (project) => { project.promotion.enabled = false; }],
    ["targetBranch", (project) => { project.promotion.targetBranch = "release"; }],
  ];
  for (const [label, mutate] of mutations) {
    const current = fixture({ multiTask: false });
    const claim = claimPromotionAttemptInState(current.state, input()).claim;
    mutate(current.state.projects[0]);
    assert.throws(
      () => assertPromotionAttemptClaimInState(current.state, claim, input()),
      /project policy changed/i,
      `${label}: assert`,
    );
    assert.throws(
      () => renewPromotionAttemptClaimInState(current.state, claim, input()),
      /project policy changed/i,
      `${label}: renew`,
    );
    assert.throws(
      () => recordPromotionRecoveryReceiptInState(current.state, claim, {
        ...input(),
        validationResults: validation(),
        validationEvidence: recoveryEvidence(current.candidate),
      }),
      /project policy changed/i,
      `${label}: receipt`,
    );
    assert.throws(
      () => terminalPromotionAttemptClaimInState(current.state, claim, {
        ...input(),
        outcome: "pr_failed",
      }),
      /project policy changed/i,
      `${label}: terminal`,
    );
  }
});

test("project policy helper canonicalizes persisted and planned forms identically", () => {
  assert.deepEqual(
    promotionProjectPolicyBinding({
      repoPath: "/tmp/one/../demo",
      repoUrl: ` ${PROJECT_POLICY.repoUrl} `,
      defaultBranch: "main",
      promotion: { enabled: "yes", targetBranch: "refs/heads/main" },
    }),
    promotionProjectPolicyBinding(PROJECT_POLICY),
  );
});

test("retry authorization is exact and durable", () => {
  const { candidate, tasks } = fixture({ multiTask: false });
  const source = candidate.manifest.sources[0];
  assert.equal(validPromotionRetryAuthorization(tasks[0], candidate, source, POLICY), true);
  tasks[0].promotionRetryAuthorization.firstEvidenceDigest = "not-a-digest";
  assert.equal(validPromotionRetryAuthorization(tasks[0], candidate, source, POLICY), false);
});

test("retry authorization fails closed without persisted first-failure evidence", () => {
  const missingValidation = fixture({ multiTask: false });
  const source = missingValidation.candidate.manifest.sources[0];
  delete missingValidation.tasks[0].promotionValidation;
  assert.equal(validPromotionRetryAuthorization(
    missingValidation.tasks[0],
    missingValidation.candidate,
    source,
    POLICY,
  ), false);

  const missingEvidence = fixture({ multiTask: false });
  missingEvidence.tasks[0].promotionValidation.evidence = null;
  assert.equal(validPromotionRetryAuthorization(
    missingEvidence.tasks[0],
    missingEvidence.candidate,
    source,
    POLICY,
  ), false);
});

test("retry authorization rejects fabricated and structurally mismatched first-failure evidence", () => {
  const cases = [
    ["authorization digest", ({ task }) => { task.promotionRetryAuthorization.firstEvidenceDigest = `sha256:${"a".repeat(64)}`; }],
    ["validation status", ({ task }) => { task.promotionValidation.status = "passed"; }],
    ["validation candidate", ({ task }) => { task.promotionValidationCandidateId = "candidate_other"; }],
    ["evidence candidate", ({ evidence }) => { evidence.candidateId = "candidate_other"; }],
    ["manifest", ({ evidence }) => { evidence.manifestDigest = `sha256:${"a".repeat(64)}`; }],
    ["integration SHA", ({ evidence }) => { evidence.integrationSha = "a".repeat(40); }],
    ["policy", ({ evidence }) => { evidence.policyDigest = `sha256:${"a".repeat(64)}`; }],
    ["attempt", ({ evidence }) => { evidence.attempt = 2; }],
    ["evidence digest", ({ evidence }) => { evidence.digest = `sha256:${"a".repeat(64)}`; }],
  ];

  for (const [label, mutate] of cases) {
    const current = fixture({ multiTask: false });
    const task = current.tasks[0];
    mutate({ task, evidence: task.promotionValidation.evidence });
    assert.equal(
      validPromotionRetryAuthorization(
        task,
        current.candidate,
        current.candidate.manifest.sources[0],
        POLICY,
      ),
      false,
      label,
    );
  }
});

test("retry claim rejects a fabricated evidence authorization", () => {
  const { state, tasks } = fixture({ multiTask: false });
  tasks[0].promotionRetryAuthorization.firstEvidenceDigest = `sha256:${"a".repeat(64)}`;
  assert.throws(
    () => claimPromotionAttemptInState(state, input()),
    /lacks an exact promotion retry authorization/i,
  );
});

test("recovery receipt advances every task version and rebinds the claim", () => {
  const { state, candidate, tasks } = fixture();
  const claim = claimPromotionAttemptInState(state, input()).claim;
  const recorded = recordPromotionRecoveryReceiptInState(state, claim, {
    ...input(),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(candidate),
  });
  assert.equal(recorded.reused, false);
  assert.equal(recorded.receipt.candidateId, candidate.id);
  assert.equal(recorded.receipt.manifestDigest, candidate.manifestDigest);
  assert.equal(recorded.receipt.integrationBranch, candidate.manifest.integration.branch);
  assert.equal(recorded.receipt.integrationSha, candidate.manifest.integration.sha);
  assert.equal(recorded.receipt.policyDigest, POLICY);
  assert.match(recorded.receipt.validationResultDigest, /^sha256:/);
  assert.deepEqual(tasks.map((task) => task.stateVersion), [11, 12]);
  assert.deepEqual(recorded.claim.expectedTaskStateVersions, { task_1: 11, task_2: 12 });
  assert.notEqual(recorded.claim.bindingDigest, claim.bindingDigest);
  assert.equal(recorded.claim.attemptSeriesDigest, claim.attemptSeriesDigest);
  assert.doesNotThrow(() => assertPromotionAttemptClaimInState(state, recorded.claim, input()));
});

test("exact receipt is reused after takeover and mismatches are rejected", () => {
  const exact = fixture();
  const first = claimPromotionAttemptInState(exact.state, input()).claim;
  const recorded = recordPromotionRecoveryReceiptInState(exact.state, first, {
    ...input(),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(exact.candidate),
  });
  const expired = claimPromotionAttemptInState(exact.state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(expired.reason, "retry_deferred");
  const takeover = claimPromotionAttemptInState(exact.state, input({
    nowMs: NOW + 70_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  const reused = recordPromotionRecoveryReceiptInState(exact.state, takeover, {
    ...input({ nowMs: NOW + 70_002 }),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(exact.candidate),
  });
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.receipt, recorded.receipt);

  const mismatch = fixture();
  const mismatchClaim = claimPromotionAttemptInState(mismatch.state, input()).claim;
  recordPromotionRecoveryReceiptInState(mismatch.state, mismatchClaim, {
    ...input(),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(mismatch.candidate),
  });
  claimPromotionAttemptInState(mismatch.state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  const mismatchTakeover = claimPromotionAttemptInState(mismatch.state, input({
    nowMs: NOW + 70_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  assert.throws(() => recordPromotionRecoveryReceiptInState(mismatch.state, mismatchTakeover, {
    ...input({ nowMs: NOW + 70_002 }),
    validationResults: [{ command: "npm run check", ok: true, outputDigest: OUTPUT_B }],
    validationEvidence: recoveryEvidence(mismatch.candidate),
  }), /append-only|does not match/i);
});

test("recovery receipt supports an initial validation and requires exact passing evidence", () => {
  const create = fixture({ retry: false, multiTask: false });
  const createClaim = claimPromotionAttemptInState(create.state, input({ mode: "create" })).claim;
  const created = recordPromotionRecoveryReceiptInState(create.state, createClaim, {
    ...input({ mode: "create" }),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(create.candidate, { attempt: 1 }),
  });
  assert.equal(created.reused, false);
  assert.equal(created.receipt.validationEvidence.attempt, 1);

  const retry = fixture({ multiTask: false });
  const retryClaim = claimPromotionAttemptInState(retry.state, input()).claim;
  assert.throws(() => recordPromotionRecoveryReceiptInState(retry.state, retryClaim, {
    ...input(),
    validationResults: [{ command: "npm run check", ok: false, outputDigest: OUTPUT_A }],
    validationEvidence: recoveryEvidence(retry.candidate),
  }), /did not pass/i);
  assert.throws(() => recordPromotionRecoveryReceiptInState(retry.state, retryClaim, {
    ...input(),
    validationResults: validation(),
    validationEvidence: recoveryEvidence(retry.candidate, { policyDigest: `sha256:${"b".repeat(64)}` }),
  }), /mismatched private validation evidence/i);
});

test("only the current claim can become terminal", () => {
  const { state } = fixture({ multiTask: false });
  const claim = claimPromotionAttemptInState(state, input()).claim;
  const terminal = terminalPromotionAttemptClaimInState(state, claim, { ...input(), outcome: "pr_ready" });
  assert.equal(terminal.status, "terminal");
  assert.equal(terminal.outcome, "pr_ready");
  const replay = claimPromotionAttemptInState(state, input({ claimIdFactory: () => "claim_2" }));
  assert.equal(replay.acquired, false);
  assert.equal(replay.reason, "terminal");
});

test("operational promotion failures use deterministic backoff and exhaust after three attempts", () => {
  const retryable = fixture({ retry: false, multiTask: false });
  retryable.tasks[0].status = "promotion_blocked";
  retryable.tasks[0].promotionStatus = "candidate_verification_unavailable";
  const first = claimPromotionAttemptInState(retryable.state, input({ mode: "create" })).claim;
  const firstTerminal = terminalPromotionAttemptClaimInState(retryable.state, first, {
    ...input({ mode: "create" }),
    outcome: "candidate_verification_unavailable",
  });
  assert.equal(firstTerminal.operationalAttempt, 1);
  assert.equal(firstTerminal.retryNotBefore, new Date(NOW + 60_000).toISOString());

  const deferred = claimPromotionAttemptInState(retryable.state, input({
    mode: "create",
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(deferred.acquired, false);
  assert.equal(deferred.reason, "retry_deferred");
  assert.equal(deferred.retryNotBefore, firstTerminal.retryNotBefore);

  const second = claimPromotionAttemptInState(retryable.state, input({
    mode: "create",
    nowMs: NOW + 60_000,
    claimIdFactory: () => "claim_2",
  })).claim;
  assert.equal(second.fence, first.fence + 1);
  assert.equal(second.operationalAttempt, 2);
  const secondTerminal = terminalPromotionAttemptClaimInState(retryable.state, second, {
    ...input({ mode: "create", nowMs: NOW + 60_000 }),
    outcome: "push_failed",
  });
  assert.equal(secondTerminal.retryNotBefore, new Date(NOW + 180_000).toISOString());

  const third = claimPromotionAttemptInState(retryable.state, input({
    mode: "create",
    nowMs: NOW + 180_000,
    claimIdFactory: () => "claim_3",
  })).claim;
  assert.equal(third.operationalAttempt, 3);
  const terminal = terminalPromotionAttemptClaimInState(retryable.state, third, {
    ...input({ mode: "create", nowMs: NOW + 180_000 }),
    outcome: "evidence_failed",
  });
  assert.equal(terminal.retryNotBefore, "");
  assert.equal(terminal.attemptsExhausted, true);
  assert.deepEqual(terminal.circuit, {
    shouldOpen: true,
    reasonCode: "promotion_attempt_budget_exhausted",
    attemptsConsumed: 3,
    maxAttempts: 3,
    attemptSeriesDigest: terminal.attemptSeriesDigest,
    lastOutcome: "evidence_failed",
    retryNotBefore: "",
    detectedAt: new Date(NOW + 180_000).toISOString(),
  });
  const exhausted = claimPromotionAttemptInState(retryable.state, input({
    mode: "create",
    nowMs: NOW + 24 * 60 * 60 * 1_000,
    claimIdFactory: () => "claim_4",
  }));
  assert.equal(exhausted.acquired, false);
  assert.equal(exhausted.reason, "attempt_budget_exhausted");
  assert.equal(exhausted.circuit.attemptsConsumed, 3);
});

test("validation retry preserves validation attempt semantics without consuming an operational retry", () => {
  const current = fixture({ retry: false, multiTask: false });
  const createClaim = claimPromotionAttemptInState(current.state, input({ mode: "create" })).claim;
  terminalPromotionAttemptClaimInState(current.state, createClaim, {
    ...input({ mode: "create" }),
    outcome: "validation_failed",
  });
  const retryFixture = fixture({ retry: true, multiTask: false });
  retryFixture.state.meta = current.state.meta;
  retryFixture.tasks[0].automationAttemptEpoch = current.tasks[0].automationAttemptEpoch || 0;
  current.state.projects = retryFixture.state.projects;
  current.state.tasks = retryFixture.state.tasks;
  current.state.candidates = retryFixture.state.candidates;
  const retryClaim = claimPromotionAttemptInState(current.state, input({
    mode: "retry",
    claimIdFactory: () => "claim_2",
  })).claim;
  assert.equal(retryClaim.attempt, 2);
  assert.equal(retryClaim.operationalAttempt, 1);
  assert.equal(retryClaim.attemptSeriesDigest, createClaim.attemptSeriesDigest);
});

test("expired claims count toward the operational ceiling", () => {
  const current = fixture({ retry: false, multiTask: false });
  current.tasks[0].status = "promotion_blocked";
  current.tasks[0].promotionStatus = "auth_failed";
  const first = claimPromotionAttemptInState(current.state, input({ mode: "create" })).claim;
  const firstExpired = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(firstExpired.reason, "retry_deferred");
  assert.equal(firstExpired.retryNotBefore, new Date(NOW + 70_001).toISOString());
  const second = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    nowMs: NOW + 70_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  const secondExpired = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    nowMs: NOW + 80_002,
    claimIdFactory: () => "claim_3",
  }));
  assert.equal(secondExpired.reason, "retry_deferred");
  assert.equal(secondExpired.retryNotBefore, new Date(NOW + 200_002).toISOString());
  const third = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    nowMs: NOW + 200_002,
    claimIdFactory: () => "claim_3",
  })).claim;
  assert.deepEqual(
    [first.operationalAttempt, second.operationalAttempt, third.operationalAttempt],
    [1, 2, 3],
  );
  const exhausted = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    nowMs: NOW + 210_003,
    claimIdFactory: () => "claim_4",
  }));
  assert.equal(exhausted.acquired, false);
  assert.equal(exhausted.reason, "attempt_budget_exhausted");
  assert.equal(exhausted.claim.status, "terminal");
  assert.equal(exhausted.claim.outcome, "claim_expired");
  assert.equal(exhausted.circuit.attemptsConsumed, 3);
});

test("automation attempt epoch deliberately starts a fresh bounded series", () => {
  const current = fixture({ retry: false, multiTask: false });
  current.tasks[0].status = "promotion_blocked";
  current.tasks[0].promotionStatus = "pr_failed";
  const old = claimPromotionAttemptInState(current.state, input({ mode: "create" })).claim;
  terminalPromotionAttemptClaimInState(current.state, old, {
    ...input({ mode: "create" }),
    outcome: "pr_failed",
  });
  current.tasks[0].automationAttemptEpoch = 1;
  const reset = claimPromotionAttemptInState(current.state, input({
    mode: "create",
    claimIdFactory: () => "claim_reset",
  })).claim;
  assert.equal(reset.operationalAttempt, 1);
  assert.notEqual(reset.attemptSeriesDigest, old.attemptSeriesDigest);
});

test("legacy claim schemas fail closed with owner-circuit metadata", () => {
  for (const status of ["active", "terminal"]) {
    const current = fixture({ retry: false, multiTask: false });
    current.tasks[0].status = "promotion_blocked";
    current.tasks[0].promotionStatus = "pr_failed";
    current.state.meta.promotionAttemptClaims = {
      candidate_1: {
        schemaVersion: "studioops.promotion-attempt-claim.v1",
        claimId: "legacy_claim",
        fence: 1,
        status,
        candidateId: "candidate_1",
        outcome: "pr_failed",
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
    };
    const blocked = claimPromotionAttemptInState(current.state, input({ mode: "create" }));
    assert.equal(blocked.acquired, false, status);
    assert.equal(blocked.reason, "claim_schema_unsupported", status);
    assert.equal(blocked.circuit.shouldOpen, true, status);
    assert.equal(blocked.circuit.reasonCode, "promotion_claim_schema_unsupported", status);
  }

  const closed = fixture({ retry: false, multiTask: false });
  closed.tasks[0].status = "promotion_blocked";
  closed.tasks[0].promotionStatus = "pr_closed";
  assert.throws(
    () => claimPromotionAttemptInState(closed.state, input({ mode: "create" })),
    /no longer matches the promotion candidate/i,
  );
});
