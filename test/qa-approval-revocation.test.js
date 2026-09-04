import assert from "node:assert/strict";
import test from "node:test";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const testEnvironment = await createHermeticTestEnvironment();
Object.assign(process.env, testEnvironment.env);
test.after(async () => testEnvironment.cleanup());

const {
  createQaRevocationTestTransport,
  settleReleaseCandidatePullRequestForRevocation,
} = await import(`../src/qa-approval-revocation.js?test=${Date.now()}`);

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const PROJECT = {
  id: "project_1",
  key: "demo",
  repoPath: "/tmp/example",
  repoUrl: "https://github.com/example/demo",
  defaultBranch: "main",
};

function candidateFixture() {
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: BASE_SHA },
      sources: [{
        taskId: "task_1",
        sourceRef: "refs/heads/feature/task",
        headSha: HEAD_SHA,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: HEAD_SHA,
          candidateCycle: 1,
          reviewedAt: "2026-09-03T12:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/demo", sha: HEAD_SHA },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: HEAD_SHA,
        evidenceDigest: DIGEST,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: HEAD_SHA,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: { kind: "json", key: "commitSha", observedSha: HEAD_SHA },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_1"],
        includedTaskIds: ["task_1"],
        excludedTaskIds: [],
      },
    },
  });
  candidate.status = "release_candidate_ready";
  candidate.promotion = {
    branch: "qa/promotion-demo",
    prUrl: "https://github.com/example/demo/pull/42",
    commitSha: HEAD_SHA,
    manifestDigest: candidate.manifestDigest,
  };
  return candidate;
}

function qaPassedCandidateFixture() {
  const candidate = candidateFixture();
  candidate.status = "qa_passed";
  delete candidate.promotion;
  return candidate;
}

function deterministicPromotionBranch(candidate) {
  return `qa/promotion-demo-${candidate.manifestDigest.replace(/^sha256:/, "").slice(0, 16)}`;
}

function pullPayload(candidate, overrides = {}) {
  const branch = candidate.promotion?.branch || deterministicPromotionBranch(candidate);
  return {
    number: 42,
    html_url: candidate.promotion?.prUrl || "https://github.com/example/demo/pull/42",
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    body: `Release\n\n<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
    base: { ref: "main", repo: { full_name: "example/demo" } },
    head: { ref: branch, sha: HEAD_SHA, repo: { full_name: "example/demo" } },
    ...overrides,
  };
}

test("release-candidate revocation closes and then verifies the exact pull request", async () => {
  const candidate = candidateFixture();
  const calls = [];
  const transport = createQaRevocationTestTransport(async (request) => {
    calls.push({ method: request.method, body: request.body });
    if (calls.length === 1) return { ok: true, status: 200, payload: pullPayload(candidate) };
    if (calls.length === 2) return { ok: true, status: 200, payload: pullPayload(candidate, { state: "closed", merge_commit_sha: "d".repeat(40) }) };
    return { ok: true, status: 200, payload: pullPayload(candidate, { state: "closed", merge_commit_sha: "d".repeat(40) }) };
  });
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "closed");
  assert.equal(result.mergeCommit, "");
  assert.equal(result.mergedAt, "");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PATCH", "GET"]);
  assert.deepEqual(calls[1].body, { state: "closed" });
});

test("QA-passed revocation discovers, closes, and verifies an unpersisted deterministic promotion PR", async () => {
  const candidate = qaPassedCandidateFixture();
  const calls = [];
  const transport = createQaRevocationTestTransport(async (request) => {
    calls.push({ pathname: request.pathname, method: request.method, body: request.body });
    if (calls.length === 1) return { ok: true, status: 200, payload: [pullPayload(candidate)] };
    if (calls.length === 2) return { ok: true, status: 200, payload: pullPayload(candidate) };
    if (calls.length === 3) return { ok: true, status: 200, payload: pullPayload(candidate, { state: "closed" }) };
    return { ok: true, status: 200, payload: pullPayload(candidate, { state: "closed" }) };
  });

  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });

  assert.equal(result.status, "closed");
  assert.equal(result.prUrl, "https://github.com/example/demo/pull/42");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "PATCH", "GET"]);
  assert.match(calls[0].pathname, /^\/repos\/example\/demo\/pulls\?/);
  const query = new URL(calls[0].pathname, "https://api.github.com").searchParams;
  assert.equal(query.get("state"), "all");
  assert.equal(query.get("base"), "main");
  assert.equal(query.get("head"), `example:${deterministicPromotionBranch(candidate)}`);
  assert.equal(query.get("per_page"), "100");
  assert.equal(query.get("page"), "1");
  assert.equal(calls[2].pathname, "/repos/example/demo/pulls/42");
  assert.deepEqual(calls[2].body, { state: "closed" });
});

test("QA-passed revocation returns authoritative absence when deterministic promotion PR discovery is empty", async () => {
  const candidate = qaPassedCandidateFixture();
  let calls = 0;
  const transport = createQaRevocationTestTransport(async () => {
    calls += 1;
    return { ok: true, status: 200, payload: [] };
  });
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "absent");
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.equal(calls, 1);
});

test("QA-passed discovery targets the project promotion branch rather than the candidate base branch", async () => {
  const candidate = qaPassedCandidateFixture();
  let pathname = "";
  const transport = createQaRevocationTestTransport(async (request) => {
    pathname = request.pathname;
    return { ok: true, status: 200, payload: [] };
  });
  const result = await settleReleaseCandidatePullRequestForRevocation({
    ...PROJECT,
    defaultBranch: "release",
  }, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "absent");
  assert.equal(new URL(pathname, "https://api.github.com").searchParams.get("base"), "release");
});

test("QA-passed revocation fails closed for ambiguous or wrongly identified discovery", async (t) => {
  const candidate = qaPassedCandidateFixture();
  const variants = [
    ["ambiguous", [pullPayload(candidate), pullPayload(candidate, { number: 43, html_url: "https://github.com/example/demo/pull/43" })]],
    ["wrong marker", [pullPayload(candidate, { body: "missing immutable candidate marker" })]],
    ["wrong full integration SHA", [pullPayload(candidate, {
      head: { ref: deterministicPromotionBranch(candidate), sha: BASE_SHA, repo: { full_name: "example/demo" } },
    })]],
  ];
  for (const [label, payload] of variants) {
    await t.test(label, async () => {
      let calls = 0;
      const transport = createQaRevocationTestTransport(async () => {
        calls += 1;
        return { ok: true, status: 200, payload };
      });
      const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
        githubToken: "ghs_test_token",
        testTransport: transport,
      });
      assert.equal(result.status, "invalid");
      assert.equal(calls, 1);
    });
  }
});

test("QA-passed revocation treats failed discovery as unavailable rather than absent", async () => {
  const candidate = qaPassedCandidateFixture();
  const transport = createQaRevocationTestTransport(async () => ({
    ok: false,
    status: 503,
    payload: null,
    reason: "GitHub unavailable",
  }));
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /unavailable/i);
});

test("release-candidate revocation detects a merge before changing local authority", async () => {
  const candidate = candidateFixture();
  const mergedAt = "2026-09-03T12:30:00.000Z";
  const transport = createQaRevocationTestTransport(async () => ({
    ok: true,
    status: 200,
    payload: pullPayload(candidate, {
      state: "closed",
      merged_at: mergedAt,
      merge_commit_sha: "d".repeat(40),
    }),
  }));
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "merged");
  assert.equal(result.mergedAt, mergedAt);
});

test("release-candidate revocation rejects every mismatched pull-request identity field", async (t) => {
  const candidate = candidateFixture();
  const variants = [
    ["URL", { html_url: "https://github.com/example/demo/pull/43" }],
    ["body", { body: "missing immutable candidate marker" }],
    ["base", { base: { ref: "production", repo: { full_name: "example/demo" } } }],
    ["head", { head: { ref: "other", sha: HEAD_SHA, repo: { full_name: "example/demo" } } }],
    ["SHA", { head: { ref: candidate.promotion.branch, sha: BASE_SHA, repo: { full_name: "example/demo" } } }],
    ["repository", { head: { ref: candidate.promotion.branch, sha: HEAD_SHA, repo: { full_name: "attacker/demo" } } }],
  ];
  for (const [label, overrides] of variants) {
    await t.test(label, async () => {
      const transport = createQaRevocationTestTransport(async () => ({
        ok: true,
        status: 200,
        payload: pullPayload(candidate, overrides),
      }));
      const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
        githubToken: "ghs_test_token",
        testTransport: transport,
      });
      assert.equal(result.status, "invalid");
    });
  }
});

test("failed close remains unavailable and credential text is redacted", async () => {
  const candidate = candidateFixture();
  const token = "ghs_secret_revocation_token";
  let call = 0;
  const transport = createQaRevocationTestTransport(async () => {
    call += 1;
    if (call === 1 || call === 3) return { ok: true, status: 200, payload: pullPayload(candidate) };
    return { ok: false, status: 500, payload: null, reason: `failure included ${token}` };
  });
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: token,
    testTransport: transport,
  });
  assert.equal(result.status, "unavailable");
  assert.doesNotMatch(result.reason, new RegExp(token));
});
