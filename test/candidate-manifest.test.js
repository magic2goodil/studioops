import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateEnvelope,
  buildCandidateManifest,
  canonicalJson,
  createCandidateEnvelope,
  invalidateCandidate,
  manifestDigest,
} from "../src/candidate-manifest.js";

const SHA = {
  base: "1".repeat(40),
  sourceA: "2".repeat(40),
  sourceB: "3".repeat(40),
  integration: "4".repeat(40),
};

function review(id, stageKey, subjectSha, candidateCycle = 2) {
  return {
    id,
    stageKey,
    role: `${stageKey}-reviewer`,
    outcome: "approved",
    subjectSha,
    candidateCycle,
    reviewedAt: "2026-07-25T11:00:00.000Z",
  };
}

function manifestInput(overrides = {}) {
  return {
    candidateId: "candidate_test",
    projectId: "project_test",
    base: { branch: "main", sha: SHA.base },
    sources: [
      {
        taskId: "task_2",
        sourceRef: "refs/heads/codex/two",
        headSha: SHA.sourceB,
        candidateCycle: 2,
        reviews: [review("review_4", "lead", SHA.sourceB), review("review_3", "backend", SHA.sourceB)],
      },
      {
        taskId: "task_1",
        sourceRef: "refs/heads/codex/one",
        headSha: SHA.sourceA,
        candidateCycle: 2,
        reviews: [review("review_2", "lead", SHA.sourceA), review("review_1", "backend", SHA.sourceA)],
      },
    ],
    integration: { branch: "qa/candidate-test", sha: SHA.integration },
    checks: [
      {
        id: "check_1",
        kind: "local-validation",
        name: "npm run check",
        outcome: "passed",
        subjectSha: SHA.integration,
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      },
    ],
    preview: {
      url: "http://127.0.0.1:4174/",
      status: "healthy",
      commitSha: SHA.integration,
      verifiedAt: "2026-07-25T12:00:00.000Z",
      attestation: {
        kind: "header",
        key: "x-studioops-commit",
        observedSha: SHA.integration,
      },
    },
    assembly: {
      mode: "atomic",
      requestedTaskIds: ["task_2", "task_1"],
      includedTaskIds: ["task_1", "task_2"],
      excludedTaskIds: [],
    },
    ...overrides,
  };
}

test("candidate manifest canonicalizes stable arrays and object keys", () => {
  const first = buildCandidateManifest(manifestInput());
  const reordered = manifestInput({
    ...manifestInput(),
    sources: [...manifestInput().sources].reverse(),
    checks: [...manifestInput().checks].reverse(),
  });
  const second = buildCandidateManifest(reordered);
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.equal(manifestDigest(first), manifestDigest(second));
  assert.deepEqual(first.sources.map((source) => source.taskId), ["task_1", "task_2"]);
  assert.deepEqual(first.sources[0].reviews.map((item) => item.id), ["review_1", "review_2"]);
});

test("security-relevant manifest drift changes the digest", () => {
  const base = manifestInput();
  const originalDigest = manifestDigest(buildCandidateManifest(base));
  const changedInputs = [
    { ...base, base: { ...base.base, sha: "5".repeat(40) } },
    {
      ...base,
      sources: [
        { ...base.sources[0], sourceRef: "refs/heads/codex/moved" },
        base.sources[1],
      ],
    },
    {
      ...base,
      sources: [
        {
          ...base.sources[0],
          reviews: [
            { ...base.sources[0].reviews[0], role: "security-reviewer" },
            base.sources[0].reviews[1],
          ],
        },
        base.sources[1],
      ],
    },
    {
      ...base,
      checks: [{ ...base.checks[0], evidenceDigest: `sha256:${"b".repeat(64)}` }],
    },
    {
      ...base,
      preview: { ...base.preview, url: "http://127.0.0.1:5000/" },
    },
    {
      ...base,
      preview: { ...base.preview, verifiedAt: "2026-07-25T12:01:00.000Z" },
    },
    {
      ...base,
      integration: { branch: "qa/candidate-test", sha: "5".repeat(40) },
      preview: {
        ...base.preview,
        commitSha: "5".repeat(40),
        attestation: {
          ...base.preview.attestation,
          observedSha: "5".repeat(40),
        },
      },
      checks: [{ ...base.checks[0], subjectSha: "5".repeat(40) }],
    },
  ];
  for (const changedInput of changedInputs) {
    assert.notEqual(manifestDigest(buildCandidateManifest(changedInput)), originalDigest);
  }
});

test("reviews fail closed on malformed SHA, wrong subject, or wrong cycle", () => {
  const base = manifestInput();
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{ ...base.sources[0], headSha: "short" }],
    }),
    /full Git object SHA/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        reviews: [review("review_wrong", "lead", SHA.sourceA)],
      }],
    }),
    /does not apply/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        reviews: [review("review_wrong", "lead", SHA.sourceB, 3)],
      }],
    }),
    /wrong candidate cycle/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        reviews: [{
          ...review("review_wrong", "lead", SHA.sourceB),
          reviewedAt: "not-a-date",
        }],
      }],
    }),
    /time must be an ISO-8601 timestamp/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [base.sources[0], { ...base.sources[0] }],
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: [],
      },
    }),
    /Duplicate source task ID/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        reviews: [base.sources[0].reviews[0], { ...base.sources[0].reviews[0] }],
      }],
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: [],
      },
    }),
    /Duplicate review ID/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      checks: [base.checks[0], { ...base.checks[0] }],
    }),
    /Duplicate check ID/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      checks: [{ ...base.checks[0], subjectSha: SHA.sourceA }],
    }),
    /not bound to the integration SHA/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        sourceRef: "refs/heads/safe:refs/heads/overwrite",
      }],
    }),
    /not a safe Git branch name/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      preview: { ...base.preview, url: "javascript:alert(1)" },
    }),
    /absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      preview: { ...base.preview, url: "http://127.0.0.1:4174/?token=secret" },
    }),
    /query parameters/,
  );
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [{
        ...base.sources[0],
        reviews: [{
          ...review("review_skipped_lead", "lead", SHA.sourceB),
          outcome: "skipped",
        }],
      }],
    }),
    /must be approved/,
  );
});

test("partial candidates require exact membership and explicit authorization", () => {
  const base = manifestInput();
  const partial = buildCandidateManifest({
    ...base,
    sources: [base.sources[0]],
    assembly: {
      mode: "authorized_partial",
      requestedTaskIds: ["task_1", "task_2"],
      includedTaskIds: ["task_2"],
      excludedTaskIds: ["task_1"],
      authorization: { author: "Release owner", reason: "Ship the independent repair first." },
    },
  });
  assert.equal(partial.assembly.mode, "authorized_partial");
  assert.deepEqual(partial.assembly.includedTaskIds, ["task_2"]);
  assert.throws(
    () => buildCandidateManifest({
      ...base,
      sources: [base.sources[0]],
      assembly: {
        mode: "authorized_partial",
        requestedTaskIds: ["task_1", "task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: ["task_1"],
      },
    }),
    /partial-candidate author/,
  );
});

test("candidate envelope detects mutation and invalidation is irreversible", () => {
  const candidate = createCandidateEnvelope({ manifest: manifestInput(), createdAt: "2026-07-25T12:00:00.000Z" });
  assertCandidateEnvelope(candidate);
  candidate.manifest.unboundSecret = "must-not-be-ignored";
  assert.throws(() => assertCandidateEnvelope(candidate), /unsupported or non-canonical fields/);
  delete candidate.manifest.unboundSecret;
  candidate.manifest.preview.url = "http://127.0.0.1:9999/";
  assert.throws(() => assertCandidateEnvelope(candidate), /digest mismatch/);

  const valid = createCandidateEnvelope({ manifest: manifestInput(), createdAt: "2026-07-25T12:00:00.000Z" });
  invalidateCandidate(valid, {
    reason: "Source ref moved.",
    expected: SHA.sourceA,
    observed: "6".repeat(40),
    invalidatedAt: "2026-07-25T13:00:00.000Z",
  });
  invalidateCandidate(valid, {
    reason: "A second reason must not replace the first.",
    invalidatedAt: "2026-07-25T14:00:00.000Z",
  });
  assert.equal(valid.status, "invalidated");
  assert.equal(valid.invalidation.reason, "Source ref moved.");
});
