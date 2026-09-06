import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
const {
  createCandidateRepositoryTestGitRunner,
} = await import("../src/candidate-repository.js");

const execFileAsync = promisify(execFile);

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

function candidateFixture(options = {}) {
  const baseSha = options.baseSha || BASE_SHA;
  const headSha = options.headSha || HEAD_SHA;
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: baseSha },
      sources: [{
        taskId: "task_1",
        sourceRef: "refs/heads/feature/task",
        headSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: headSha,
          candidateCycle: 1,
          reviewedAt: "2026-09-03T12:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/demo", sha: headSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: headSha,
        evidenceDigest: DIGEST,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: headSha,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: { kind: "json", key: "commitSha", observedSha: headSha },
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
    commitSha: headSha,
    manifestDigest: candidate.manifestDigest,
  };
  return candidate;
}

async function git(cwd, args, env = {}) {
  return execFileAsync("/usr/bin/git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function legacyPromotionRepository(options = {}) {
  const root = await mkdtemp(path.join(process.env.STUDIOOPS_TEST_ROOT, "qa-revocation-ancestry-"));
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");
  const repoPath = path.join(root, "repo");
  await mkdir(seedPath);
  await git(root, ["init", "--bare", "--quiet", remotePath]);
  await git(seedPath, ["init", "--quiet", "--initial-branch=main"]);
  await git(seedPath, ["config", "user.name", "StudioOps Test"]);
  await git(seedPath, ["config", "user.email", "studioops-test@example.invalid"]);
  await writeFile(path.join(seedPath, "base.txt"), "base\n", "utf8");
  await git(seedPath, ["add", "base.txt"]);
  await git(seedPath, ["commit", "--quiet", "-m", "base"]);
  const baseSha = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
  await git(seedPath, ["switch", "--quiet", "-c", "qa/demo"]);
  await writeFile(path.join(seedPath, "candidate.txt"), "candidate\n", "utf8");
  await git(seedPath, ["add", "candidate.txt"]);
  await git(seedPath, ["commit", "--quiet", "-m", "candidate"]);
  const integrationSha = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
  const integrationTree = (await git(seedPath, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  await git(seedPath, ["switch", "--quiet", "main"]);
  await writeFile(path.join(seedPath, "main.txt"), "main advanced\n", "utf8");
  await git(seedPath, ["add", "main.txt"]);
  await git(seedPath, ["commit", "--quiet", "-m", "advance main"]);
  const mainSha = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
  let promotionTree = integrationTree;
  if (options.changedTree) {
    await git(seedPath, ["switch", "--quiet", "qa/demo"]);
    await writeFile(path.join(seedPath, "candidate.txt"), "changed after QA\n", "utf8");
    await git(seedPath, ["add", "candidate.txt"]);
    promotionTree = (await git(seedPath, ["write-tree"])).stdout.trim();
  }
  const promotionSha = (await git(seedPath, [
    "commit-tree",
    promotionTree,
    "-p",
    options.unrelated ? baseSha : integrationSha,
    "-p",
    mainSha,
    "-m",
    "legacy promotion merge",
  ], {
    GIT_AUTHOR_NAME: "StudioOps Test",
    GIT_AUTHOR_EMAIL: "studioops-test@example.invalid",
    GIT_COMMITTER_NAME: "StudioOps Test",
    GIT_COMMITTER_EMAIL: "studioops-test@example.invalid",
  })).stdout.trim();
  await git(seedPath, ["update-ref", "refs/heads/qa/promotion-demo", promotionSha]);
  await git(seedPath, ["remote", "add", "origin", remotePath]);
  await git(seedPath, ["push", "--quiet", "origin", "main", "qa/demo", "qa/promotion-demo"]);
  await git(root, ["clone", "--quiet", remotePath, repoPath]);
  await git(repoPath, ["remote", "set-url", "origin", "https://github.com/example/demo"]);
  return { remotePath, repoPath, baseSha, integrationSha, promotionSha };
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

test("a merged pull request never uses the legacy descendant revocation path", async () => {
  const candidate = candidateFixture();
  const transport = createQaRevocationTestTransport(async () => ({
    ok: true,
    status: 200,
    payload: pullPayload(candidate, {
      state: "closed",
      merged_at: "2026-09-03T12:30:00.000Z",
      merge_commit_sha: "d".repeat(40),
      head: {
        ref: candidate.promotion.branch,
        sha: BASE_SHA,
        repo: { full_name: "example/demo" },
      },
    }),
  }));
  const result = await settleReleaseCandidatePullRequestForRevocation(PROJECT, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
  });
  assert.equal(result.status, "invalid");
});

test("closed legacy promotion revocation verifies an unchanged-tree descendant with real Git", async () => {
  const fixture = await legacyPromotionRepository();
  const candidate = candidateFixture({ baseSha: fixture.baseSha, headSha: fixture.integrationSha });
  const transport = createQaRevocationTestTransport(async () => ({
    ok: true,
    status: 200,
    payload: pullPayload(candidate, {
      state: "closed",
      head: {
        ref: candidate.promotion.branch,
        sha: fixture.promotionSha,
        repo: { full_name: "example/demo" },
      },
    }),
  }));
  const result = await settleReleaseCandidatePullRequestForRevocation({
    ...PROJECT,
    repoPath: fixture.repoPath,
  }, candidate, {
    githubToken: "ghs_test_token",
    testTransport: transport,
    testGitRunner: createCandidateRepositoryTestGitRunner(fixture.remotePath),
  });
  assert.equal(result.status, "closed");
});

test("closed legacy promotion revocation rejects unrelated or changed-tree heads", async (t) => {
  for (const variant of [
    ["unrelated", { unrelated: true }],
    ["changed tree", { changedTree: true }],
  ]) {
    await t.test(variant[0], async () => {
      const fixture = await legacyPromotionRepository(variant[1]);
      const candidate = candidateFixture({ baseSha: fixture.baseSha, headSha: fixture.integrationSha });
      const transport = createQaRevocationTestTransport(async () => ({
        ok: true,
        status: 200,
        payload: pullPayload(candidate, {
          state: "closed",
          head: {
            ref: candidate.promotion.branch,
            sha: fixture.promotionSha,
            repo: { full_name: "example/demo" },
          },
        }),
      }));
      const result = await settleReleaseCandidatePullRequestForRevocation({
        ...PROJECT,
        repoPath: fixture.repoPath,
      }, candidate, {
        githubToken: "ghs_test_token",
        testTransport: transport,
        testGitRunner: createCandidateRepositoryTestGitRunner(fixture.remotePath),
      });
      assert.equal(result.status, "invalid");
    });
  }
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
