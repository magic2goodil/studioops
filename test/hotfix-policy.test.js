import assert from "node:assert/strict";
import test from "node:test";
import {
  HOTFIX_PROHIBITED_CHANGE_FLAGS,
  classifyHotfixScope,
  evaluateHotfixEligibility,
  parseHotfixAuthorizationPhrase,
} from "../src/hotfix-policy.js";
import {
  authorizeProductionHotfixInState,
  candidateReviewEvidenceForTask,
  transitionHotfixReleaseInState,
} from "../src/store.js";

const SHA = "a".repeat(40);
const NOW = "2026-07-29T12:00:00.000Z";

function safeAssessment(overrides = {}) {
  return {
    kind: "narrow_production_fix",
    subjectSha: SHA,
    prohibitedChanges: {
      ...Object.fromEntries(HOTFIX_PROHIBITED_CHANGE_FLAGS.map((flag) => [flag, false])),
      ...overrides,
    },
  };
}

function textFile(overrides = {}) {
  return {
    path: "src/fix.js",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+fixed\n+tested",
    ...overrides,
  };
}

function fixture() {
  const project = {
    id: "project_1",
    key: "demo",
    name: "Demo",
    repoUrl: "https://github.com/example/demo.git",
    defaultBranch: "main",
    hotfixPolicy: {
      enabled: true,
      maxFiles: 4,
      maxChangedLines: 40,
      blockedPaths: ["infra/production", "vendor/**"],
      requireCompleteTextPatches: true,
    },
    reviewPipeline: [
      { key: "backend", role: "backend-reviewer", status: "backend_review", required: true },
      { key: "lead", role: "lead-reviewer", status: "lead_review", required: true },
    ],
  };
  const task = {
    id: "task_1",
    projectId: project.id,
    title: "Repair production bug",
    type: "bug",
    labels: ["production-hotfix"],
    status: "qa_review",
    prUrl: "https://github.com/example/demo/pull/17",
    reviewCycle: 1,
    reviewSubjectCycle: 1,
    reviewSubjectSha: SHA,
  };
  const reviews = [
    {
      id: "review_1",
      taskId: task.id,
      projectId: project.id,
      cycle: 1,
      candidateCycle: 1,
      subjectSha: SHA,
      stageKey: "backend",
      role: "backend-reviewer",
      outcome: "approved",
      createdAt: "2026-07-29T10:00:00.000Z",
    },
    {
      id: "review_2",
      taskId: task.id,
      projectId: project.id,
      cycle: 1,
      candidateCycle: 1,
      subjectSha: SHA,
      stageKey: "lead",
      role: "lead-reviewer",
      outcome: "approved",
      releaseAssessment: safeAssessment(),
      createdAt: "2026-07-29T11:00:00.000Z",
    },
  ];
  const pullRequest = {
    number: 17,
    url: "https://github.com/example/demo/pull/17",
    repositoryUrl: "https://github.com/example/demo",
    state: "open",
    isDraft: false,
    baseRefName: "main",
    headRefOid: SHA,
    files: [textFile()],
  };
  return {
    state: {
      meta: {},
      projects: [project],
      tasks: [task],
      reviews,
      comments: [],
      events: [],
      runs: [],
      qaBundles: [],
      candidates: [],
      hotfixReleases: [],
    },
    project,
    task,
    pullRequest,
  };
}

function eligibilityFor(data, overrides = {}) {
  return evaluateHotfixEligibility(data.state, {
    phrase: "green-light demo hotfix PR #17 for production",
    pullRequests: [data.pullRequest],
    candidateReviewEvidenceForTask,
    ...overrides,
  });
}

test("canonical owner hotfix phrases normalize case and whitespace but reject fuzzy language", () => {
  assert.deepEqual(
    parseHotfixAuthorizationPhrase("  GREEN-LIGHT   Demo HOTFIX pr #17 FOR production \n"),
    {
      requestedPhrase: "  GREEN-LIGHT   Demo HOTFIX pr #17 FOR production \n",
      normalizedPhrase: "green-light demo hotfix pr #17 for production",
      projectKey: "demo",
      subject: { kind: "pull_request", pullRequestNumber: 17 },
    },
  );
  assert.equal(
    parseHotfixAuthorizationPhrase(`green-light demo hotfix commit ${SHA.toUpperCase()} for production`)?.subject.commitSha,
    SHA,
  );
  for (const phrase of [
    "please green-light demo hotfix PR #17 for production",
    "green-light demo hotfix PR #17 for production now",
    "green light demo hotfix PR #17 for production",
    "green-light demo hotfix #17 for production",
    `green-light demo hotfix commit ${"a".repeat(39)} for production`,
  ]) assert.equal(parseHotfixAuthorizationPhrase(phrase), null);
});

test("exact reviewed candidate with a narrow lead assessment and bounded text patch is eligible", () => {
  const data = fixture();
  const result = eligibilityFor(data);
  assert.equal(result.ok, true);
  assert.equal(result.resolved.task.id, "task_1");
  assert.equal(result.resolved.candidateSha, SHA);
  assert.equal(result.scopeEvidence.changedLines, 3);

  const commitForm = eligibilityFor(data, {
    phrase: `green-light demo hotfix commit ${SHA} for production`,
  });
  assert.equal(commitForm.ok, true);
  assert.equal(commitForm.resolved.pullRequestNumber, 17);
});

test("candidate mapping fails closed for stale SHA, missing lane, duplicate task, and disabled policy", () => {
  {
    const data = fixture();
    data.pullRequest.headRefOid = "b".repeat(40);
    assert.equal(eligibilityFor(data).code, "stale_review_subject");
  }
  {
    const data = fixture();
    data.state.reviews = data.state.reviews.filter((review) => review.stageKey !== "backend");
    assert.equal(eligibilityFor(data).code, "incomplete_candidate_review");
  }
  {
    const data = fixture();
    data.state.tasks.push({ ...data.task, id: "task_2" });
    assert.equal(eligibilityFor(data).code, "duplicate_or_mixed_task_mapping");
  }
  {
    const data = fixture();
    data.project.hotfixPolicy.enabled = false;
    assert.equal(eligibilityFor(data).code, "hotfix_policy_disabled");
  }
  {
    const data = fixture();
    delete data.state.reviews.find((review) => review.stageKey === "lead").releaseAssessment;
    assert.equal(eligibilityFor(data).code, "missing_narrow_lead_assessment");
  }
});

test("scope classification rejects broad, binary, unavailable, and every prohibited change class", () => {
  const data = fixture();
  const policy = data.project.hotfixPolicy;
  assert.equal(classifyHotfixScope([textFile({ additions: 41, deletions: 0 })], policy).prohibitedChanges.broadScope, true);
  assert.equal(classifyHotfixScope([textFile({ binary: true, patch: "" })], policy).prohibitedChanges.binaryOrUninspectable, true);
  assert.equal(classifyHotfixScope([textFile({ truncated: true })], policy).prohibitedChanges.binaryOrUninspectable, true);

  const cases = {
    mixedScope: { files: [textFile({ classification: "mixed" })] },
    broadScope: { files: [textFile({ path: "infra/production/deploy.js" })] },
    binaryOrUninspectable: { files: [textFile({ patchAvailable: false })] },
    migrationChanges: { files: [textFile({ path: "db/migrations/001.sql" })] },
    workflowChanges: { files: [textFile({ path: ".github/workflows/deploy.yml" })] },
    secretMaterial: { files: [textFile({ path: ".env.production" })] },
    stateDeletion: { files: [textFile({ status: "removed" })] },
    unrelatedFeatureChanges: { files: [textFile({ relatedToTask: false })] },
  };
  for (const [flag, change] of Object.entries(cases)) {
    const result = eligibilityFor(fixture(), { ...change, scope: {} });
    assert.equal(result.ok, false, flag);
    assert.equal(result.scopeEvidence.prohibitedChanges[flag], true, flag);
  }
});

test("authorization attempts and exact execution claims are append-only and idempotent in state", () => {
  const data = fixture();
  const input = {
    invocationId: "owner-invocation-1",
    phrase: "green-light demo hotfix PR #17 for production",
    owner: { id: "owner_123", provider: "local" },
    pullRequests: [data.pullRequest],
    now: NOW,
  };
  const record = authorizeProductionHotfixInState(data.state, input);
  assert.equal(record.status, "authorized");
  assert.equal(record.reviewEvidence.subjectSha, SHA);
  assert.equal(record.scopeEvidence.paths[0], "src/fix.js");
  assert.equal(record.scopeEvidence.patch, undefined);
  assert.equal(data.state.events.at(-1).type, "hotfix_release_authorized");
  assert.equal(authorizeProductionHotfixInState(data.state, input), record);

  const claimed = transitionHotfixReleaseInState(data.state, record.id, {
    status: "executing",
    executionId: "execution-1",
    now: "2026-07-29T12:01:00.000Z",
  });
  assert.equal(claimed.status, "executing");
  assert.equal(claimed.transitions.length, 2);
  assert.equal(transitionHotfixReleaseInState(data.state, record.id, {
    status: "executing",
    executionId: "execution-1",
  }), record);
  assert.throws(
    () => transitionHotfixReleaseInState(data.state, record.id, {
      status: "succeeded",
      executionId: "execution-2",
    }),
    /another execution/,
  );
  transitionHotfixReleaseInState(data.state, record.id, {
    status: "succeeded",
    executionId: "execution-1",
    now: "2026-07-29T12:02:00.000Z",
  });
  assert.throws(
    () => transitionHotfixReleaseInState(data.state, record.id, {
      status: "executing",
      executionId: "execution-3",
    }),
    /new explicit owner invocation/,
  );

  const rerelease = authorizeProductionHotfixInState(data.state, {
    ...input,
    invocationId: "owner-invocation-2",
    now: "2026-07-29T12:03:00.000Z",
  });
  assert.equal(rerelease.status, "authorized");
  assert.notEqual(rerelease.id, record.id);
});

test("rejected authorization attempts remain durable without retaining arbitrary owner text", () => {
  const data = fixture();
  const rejected = authorizeProductionHotfixInState(data.state, {
    invocationId: "invalid-owner-invocation",
    phrase: "please deploy customer alice with token=github_pat_not_a_real_token",
    owner: "owner_123",
    pullRequests: [data.pullRequest],
    now: NOW,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.eligibility.code, "invalid_owner_phrase");
  assert.equal(rejected.requestedPhrase, "[REDACTED NON-CANONICAL OWNER PHRASE]");
  assert.match(rejected.requestFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(data.state.hotfixReleases.length, 1);
  assert.equal(data.state.events.at(-1).type, "hotfix_release_rejected");
});
