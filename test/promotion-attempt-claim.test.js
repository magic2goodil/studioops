import assert from "node:assert/strict";
import test from "node:test";
import { createCandidateEnvelope, invalidateCandidate } from "../src/candidate-manifest.js";
import {
  assertPromotionAttemptClaimInState,
  claimPromotionAttemptInState,
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
  const tasks = sources.map((source, index) => ({
    id: source.taskId,
    projectId: "project_1",
    status: "approved_for_main",
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
  return {
    state: { meta: {}, projects: [{ id: "project_1" }], tasks, candidates: [candidate] },
    candidate,
    tasks,
  };
}

function input(overrides = {}) {
  return {
    projectId: "project_1",
    candidateId: "candidate_1",
    mode: "retry",
    policyDigest: POLICY,
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
  const { state } = fixture();
  const first = claimPromotionAttemptInState(state, input());
  const second = claimPromotionAttemptInState(state, input({ claimIdFactory: () => "claim_2" }));
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.claim.claimId, first.claim.claimId);
  assert.deepEqual(first.claim.expectedTaskStateVersions, { task_1: 10, task_2: 11 });
});

test("expired claim takeover increments the fence", () => {
  const { state } = fixture();
  const first = claimPromotionAttemptInState(state, input()).claim;
  const takeover = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.claim.fence, first.fence + 1);
  assert.equal(takeover.claim.claimId, "claim_2");
});

test("stale owner cannot assert, renew, record, or terminalize", () => {
  const { state } = fixture();
  const stale = claimPromotionAttemptInState(state, input()).claim;
  const current = claimPromotionAttemptInState(state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  const later = input({ nowMs: NOW + 10_002 });
  assert.throws(() => assertPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.throws(() => renewPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.throws(() => recordPromotionRecoveryReceiptInState(state, stale, { ...later, validationResults: validation() }), /stale/i);
  assert.throws(() => terminalPromotionAttemptClaimInState(state, stale, later), /stale/i);
  assert.doesNotThrow(() => assertPromotionAttemptClaimInState(state, current, later));
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
  const takeover = claimPromotionAttemptInState(exact.state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  const reused = recordPromotionRecoveryReceiptInState(exact.state, takeover, {
    ...input({ nowMs: NOW + 10_002 }),
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
  const mismatchTakeover = claimPromotionAttemptInState(mismatch.state, input({
    nowMs: NOW + 10_001,
    claimIdFactory: () => "claim_2",
  })).claim;
  assert.throws(() => recordPromotionRecoveryReceiptInState(mismatch.state, mismatchTakeover, {
    ...input({ nowMs: NOW + 10_002 }),
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
  assert.equal(claimPromotionAttemptInState(state, input({ claimIdFactory: () => "claim_2" })).acquired, false);
});

test("operational promotion failures can reacquire a fenced create claim but human-closed gates cannot", () => {
  const retryable = fixture({ retry: false, multiTask: false });
  retryable.tasks[0].status = "promotion_blocked";
  retryable.tasks[0].promotionStatus = "pr_failed";
  const first = claimPromotionAttemptInState(retryable.state, input({ mode: "create" })).claim;
  terminalPromotionAttemptClaimInState(retryable.state, first, {
    ...input({ mode: "create" }),
    outcome: "pr_failed",
  });
  const replay = claimPromotionAttemptInState(retryable.state, input({
    mode: "create",
    claimIdFactory: () => "claim_2",
  }));
  assert.equal(replay.acquired, true);
  assert.equal(replay.claim.fence, first.fence + 1);

  const closed = fixture({ retry: false, multiTask: false });
  closed.tasks[0].status = "promotion_blocked";
  closed.tasks[0].promotionStatus = "pr_closed";
  assert.throws(
    () => claimPromotionAttemptInState(closed.state, input({ mode: "create" })),
    /no longer matches the promotion candidate/i,
  );
});
