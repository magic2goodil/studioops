import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCandidateSubject,
  evaluateExactTargetContainment,
  evaluateTrustedCandidateContainment,
  RELEASE_CONTAINMENT_OUTCOMES,
} from "../src/release-containment.js";

const SHA = {
  base: "1".repeat(40),
  source: "2".repeat(40),
  integration: "3".repeat(40),
  replacement: "4".repeat(40),
  merge: "5".repeat(40),
  target: "6".repeat(40),
};

function candidate() {
  return {
    id: "candidate_old",
    manifest: {
      base: { branch: "main", sha: SHA.base },
      integration: { branch: "qa/old", sha: SHA.integration },
      sources: [{
        taskId: "task_1",
        headSha: SHA.source,
        candidateCycle: 2,
      }],
    },
  };
}

function replacement() {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    id: "candidate_new",
    status: "merged",
    manifestDigest: digest,
    manifest: {
      base: { branch: "main", sha: SHA.base },
      integration: { branch: "qa/new", sha: SHA.replacement },
      sources: [{ taskId: "task_2", headSha: SHA.replacement, candidateCycle: 1 }],
    },
    qaDecision: {
      outcome: "passed",
      candidateId: "candidate_new",
      manifestDigest: digest,
      integrationSha: SHA.replacement,
      taskIds: ["task_2"],
      author: "Owner QA",
      repositoryVerifiedAt: "2026-08-30T11:58:00.000Z",
      decidedAt: "2026-08-30T11:59:00.000Z",
    },
    promotion: {
      prUrl: "https://github.com/example/demo/pull/42",
      commitSha: SHA.replacement,
      manifestDigest: digest,
    },
    promotionMerge: {
      mergeCommit: SHA.merge,
      mergedAt: "2026-08-30T12:00:00.000Z",
      reconciledAt: "2026-08-30T12:01:00.000Z",
    },
  };
}

test("exact candidate identity includes task, normalized full SHA, and candidate cycle", () => {
  const exact = compareCandidateSubject(
    { taskId: "task_1", sourceSha: SHA.source.toUpperCase(), candidateCycle: 2 },
    { taskId: "task_1", sourceSha: SHA.source, candidateCycle: "2" },
  );
  assert.equal(exact.outcome, RELEASE_CONTAINMENT_OUTCOMES.EXACT);

  const shaDrift = compareCandidateSubject(
    { taskId: "task_1", sourceSha: SHA.source, candidateCycle: 2 },
    { taskId: "task_1", sourceSha: SHA.integration, candidateCycle: 2 },
  );
  assert.equal(shaDrift.outcome, RELEASE_CONTAINMENT_OUTCOMES.STALE);
  assert.deepEqual(shaDrift.mismatches, ["source_sha"]);

  const cycleDrift = compareCandidateSubject(
    { taskId: "task_1", sourceSha: SHA.source, candidateCycle: 1 },
    { taskId: "task_1", sourceSha: SHA.source, candidateCycle: 2 },
  );
  assert.equal(cycleDrift.outcome, RELEASE_CONTAINMENT_OUTCOMES.STALE);
  assert.deepEqual(cycleDrift.mismatches, ["candidate_cycle"]);

  assert.equal(
    compareCandidateSubject(
      { taskId: "task_1", sourceSha: SHA.source, candidateCycle: 0 },
      { taskId: "task_1", sourceSha: SHA.source, candidateCycle: 2 },
    ).outcome,
    RELEASE_CONTAINMENT_OUTCOMES.UNAVAILABLE,
  );
});

test("exact protected-target containment requires integration and every source SHA", () => {
  const input = {
    candidate: candidate(),
    observedTargetSha: SHA.target,
    reachability: {
      integration: { sha: SHA.integration, reachable: true },
      sources: [{ taskId: "task_1", sha: SHA.source, reachable: true }],
    },
  };
  assert.equal(
    evaluateExactTargetContainment(input).outcome,
    RELEASE_CONTAINMENT_OUTCOMES.CONTAINED,
  );
  assert.equal(
    evaluateExactTargetContainment({
      ...input,
      reachability: {
        ...input.reachability,
        sources: [{ taskId: "task_1", sha: SHA.source, reachable: false }],
      },
    }).outcome,
    RELEASE_CONTAINMENT_OUTCOMES.NOT_CONTAINED,
  );
  assert.equal(
    evaluateExactTargetContainment({
      ...input,
      reachability: { ...input.reachability, sources: [] },
    }).outcome,
    RELEASE_CONTAINMENT_OUTCOMES.UNAVAILABLE,
  );
});

test("trusted replacement containment binds immutable PR, manifest, merge, and target evidence", () => {
  const assessment = evaluateTrustedCandidateContainment({
    candidate: candidate(),
    replacement: replacement(),
    targetBranch: "main",
    observedTargetSha: SHA.target,
    reachability: {
      candidateIntegration: { sha: SHA.integration, reachable: true },
      candidateSources: [{ taskId: "task_1", sha: SHA.source, reachable: true }],
      replacementIntegration: { sha: SHA.replacement, reachable: true },
      replacementMerge: { sha: SHA.merge, reachable: true },
    },
  });
  assert.equal(assessment.outcome, RELEASE_CONTAINMENT_OUTCOMES.CONTAINED);
  assert.equal(assessment.replacementEvidence.candidateId, "candidate_new");
  assert.equal(assessment.observedTargetSha, SHA.target);

  const incomplete = replacement();
  delete incomplete.promotionMerge.mergeCommit;
  assert.equal(
    evaluateTrustedCandidateContainment({
      candidate: candidate(),
      replacement: incomplete,
      targetBranch: "main",
      observedTargetSha: SHA.target,
      reachability: {},
    }).outcome,
    RELEASE_CONTAINMENT_OUTCOMES.UNAVAILABLE,
  );
});
