import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const observationTestEnvironment = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
Object.assign(process.env, observationTestEnvironment.env);
test.after(async () => observationTestEnvironment.cleanup());

const {
  assertMergedPromotionRecoveryObservation,
  assertPromotionRemoteObservation,
  inspectMergedPromotionRecovery,
  inspectPromotionRemotePullRequest,
  promotionGitHubApiRequest,
} = await import("../src/promotion-remote-observation.js");
const {
  createMergedPromotionRecoveryTestObservation,
  createPromotionRemoteTestObservation,
  createPromotionTestGitHubApi,
} = await import("./support/promotion-authority-harness.js");

const execFileAsync = promisify(execFile);
const SHA = "1".repeat(40);
const MERGE_SHA = "2".repeat(40);
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const BINDING_DIGEST = `sha256:${"b".repeat(64)}`;
const MODULE_URL = pathToFileURL(path.join(process.cwd(), "src/promotion-remote-observation.js")).href;
const HARNESS_URL = pathToFileURL(path.join(process.cwd(), "test/support/promotion-authority-harness.js")).href;

function authority(overrides = {}) {
  const candidate = overrides.candidate || {
    id: "candidate_1",
    projectId: "project_1",
    manifestDigest: MANIFEST_DIGEST,
    manifest: {
      base: { branch: "main", sha: "0".repeat(40) },
      integration: { branch: "qa/candidate-1", sha: SHA },
    },
  };
  return {
    projectId: "project_1",
    repoUrl: "https://github.com/example/demo",
    targetBranch: "main",
    promotionBranch: "qa/promotion-candidate-1",
    headSha: SHA,
    candidate,
    subjectCandidate: candidate,
    claim: {
      claimId: "claim_1",
      fence: 3,
      bindingDigest: BINDING_DIGEST,
      projectId: "project_1",
      candidateId: candidate.id,
      qaDecision: {
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: candidate.manifest.integration.sha,
      },
    },
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    url: "https://github.com/example/demo/pull/42",
    state: "OPEN",
    mergedAt: "",
    mergeCommit: "",
    baseRefName: "main",
    headRefName: "qa/promotion-candidate-1",
    headRefOid: SHA,
    headRepository: { nameWithOwner: "example/demo" },
    body: `${`<!-- studioops-candidate:candidate_1:${MANIFEST_DIGEST} -->`}\n<!-- studioops-claim:claim_1:3 -->`,
    ...overrides,
  };
}

function mergedRecoveryAuthority(overrides = {}) {
  const candidate = {
    id: "candidate_legacy",
    projectId: "project_1",
    qaBundleId: "qa_bundle_legacy",
    status: "release_candidate_ready",
    manifestDigest: MANIFEST_DIGEST,
    manifest: {
      base: { branch: "main", sha: "0".repeat(40) },
      integration: { branch: "qa/candidate-legacy", sha: SHA },
      sources: [{ taskId: "task_legacy", headSha: "4".repeat(40), candidateCycle: 1 }],
    },
    promotion: {
      branch: "qa/promotion-candidate-legacy",
      prUrl: "https://github.com/example/demo/pull/77",
      commitSha: SHA,
      manifestDigest: MANIFEST_DIGEST,
      readyAt: "2026-08-26T17:36:14.000Z",
    },
  };
  return {
    projectId: "project_1",
    repoUrl: "https://github.com/example/demo",
    targetBranch: "main",
    promotionBranch: candidate.promotion.branch,
    headSha: SHA,
    candidate,
    tasks: [{
      id: "task_legacy",
      projectId: "project_1",
      candidateId: candidate.id,
      qaBundleId: candidate.qaBundleId,
      candidateManifestDigest: candidate.manifestDigest,
      integrationCommit: candidate.manifest.integration.sha,
      reviewSubjectSha: candidate.manifest.sources[0].headSha,
      reviewSubjectCycle: 1,
      stateVersion: 14,
      status: "needs_changes",
      assignedAgentRole: "builder",
      promotionStatus: "validation_failed",
      promotionPrUrl: candidate.promotion.prUrl,
      promotionBranch: candidate.promotion.branch,
      promotionCommit: candidate.manifest.integration.sha,
      promotionUpdatedAt: "2026-08-26T17:36:37.000Z",
      updatedAt: "2026-08-26T17:36:37.000Z",
      promotionValidation: {
        status: "validation_failed",
        commands: [{ command: "npm test", ok: false, output: "synthetic failure" }],
      },
    }],
    bundle: {
      id: candidate.qaBundleId,
      projectId: candidate.projectId,
      status: "release_candidate_ready",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationCommit: candidate.manifest.integration.sha,
      promotionPrUrl: candidate.promotion.prUrl,
      promotionBranch: candidate.promotion.branch,
      promotionCommit: candidate.promotion.commitSha,
      promotedTaskIds: [candidate.manifest.sources[0].taskId],
      packetDigest: `sha256:${"c".repeat(64)}`,
      promotionReadyAt: candidate.promotion.readyAt,
    },
    events: [
      {
        id: "event_ready_legacy",
        type: "promotion_pr_ready",
        taskId: "task_legacy",
        createdAt: candidate.promotion.readyAt,
      },
      {
        id: "event_failed_legacy",
        type: "promotion_validation_failed",
        taskId: "task_legacy",
        createdAt: "2026-08-26T17:36:37.000Z",
      },
    ],
    ...overrides,
  };
}

function mergedRecoveryPullRequest(overrides = {}) {
  return {
    number: 77,
    html_url: "https://github.com/example/demo/pull/77",
    state: "closed",
    merged_at: "2026-08-26T17:36:35.000Z",
    merge_commit_sha: MERGE_SHA,
    base: { ref: "main" },
    head: {
      ref: "qa/promotion-candidate-legacy",
      sha: SHA,
      repo: { full_name: "example/demo" },
    },
    body: [
      "## Immutable StudioOps candidate",
      "",
      "Candidate: candidate_legacy",
      `Manifest: ${MANIFEST_DIGEST}`,
      `Integration SHA: ${SHA}`,
    ].join("\n"),
    ...overrides,
  };
}

function testAdapter(payload) {
  return createPromotionTestGitHubApi(async (request) => {
      assert.equal(request.operation, "list");
      assert.equal(request.repository, "example/demo");
      return { ok: true, status: 200, payload: [payload], output: "" };
    });
}

function githubListRequest(overrides = {}) {
  return {
    operation: "list",
    method: "GET",
    pathname: "/repos/example/demo/pulls",
    query: {
      state: "all",
      base: "main",
      head: "example:qa/promotion-candidate-1",
      per_page: 100,
      sort: "created",
      direction: "desc",
    },
    repository: "example/demo",
    ...overrides,
  };
}

test("promotion GitHub API rejects absolute and protocol-relative URL inputs before transport", async () => {
  for (const pathname of [
    "https://api.github.com/repos/example/demo/pulls",
    "https://attacker.example/repos/example/demo/pulls",
    "//attacker.example/repos/example/demo/pulls",
  ]) {
    const result = await promotionGitHubApiRequest(githubListRequest({ pathname }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.output, /exact relative API path/i);
  }
});

test("promotion GitHub API permits only the authoritative operation method and route pairs", async () => {
  const wrongMethod = await promotionGitHubApiRequest(githubListRequest({ method: "POST" }));
  assert.equal(wrongMethod.ok, false);
  assert.match(wrongMethod.output, /requires GET/i);

  const wrongRoute = await promotionGitHubApiRequest(githubListRequest({
    pathname: "/repos/example/demo/actions/secrets",
  }));
  assert.equal(wrongRoute.ok, false);
  assert.match(wrongRoute.output, /route is not allowed/i);
});

test("promotion GitHub API disables redirects on its captured transport", async () => {
  const script = `
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = { url: String(url), method: options.method, redirect: options.redirect };
      return { ok: true, status: 200, text: async () => "[]" };
    };
    const { promotionGitHubApiRequest } = await import(${JSON.stringify(MODULE_URL)});
    const result = await promotionGitHubApiRequest(${JSON.stringify(githubListRequest())});
    process.stdout.write(JSON.stringify({ captured, result }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", STUDIOOPS_TEST_ISOLATION: "" },
  });
  const report = JSON.parse(stdout);
  const capturedUrl = new URL(report.captured.url);

  assert.equal(report.result.ok, true);
  assert.equal(capturedUrl.origin, "https://api.github.com");
  assert.equal(capturedUrl.hostname, "api.github.com");
  assert.equal(capturedUrl.port, "");
  assert.equal(capturedUrl.username, "");
  assert.equal(capturedUrl.password, "");
  assert.equal(capturedUrl.pathname, "/repos/example/demo/pulls");
  assert.equal(report.captured.method, "GET");
  assert.equal(report.captured.redirect, "error");
});

test("promotion GitHub API ignores post-import global fetch replacement", async () => {
  const script = `
    let capturedCalls = 0;
    let replacementCalls = 0;
    globalThis.fetch = async () => {
      capturedCalls += 1;
      return { ok: true, status: 200, text: async () => "[]" };
    };
    const { promotionGitHubApiRequest } = await import(${JSON.stringify(MODULE_URL)});
    globalThis.fetch = async () => {
      replacementCalls += 1;
      throw new Error("replacement transport must not run");
    };
    const result = await promotionGitHubApiRequest(${JSON.stringify(githubListRequest())});
    process.stdout.write(JSON.stringify({ capturedCalls, replacementCalls, result }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", STUDIOOPS_TEST_ISOLATION: "" },
  });
  const report = JSON.parse(stdout);

  assert.equal(report.result.ok, true);
  assert.equal(report.capturedCalls, 1);
  assert.equal(report.replacementCalls, 0);
});

test("authoritative exact GitHub inspection returns an uncloneable promotion observation seal", async () => {
  const input = authority();
  const inspected = await inspectPromotionRemotePullRequest(input, {
    testGitHubApi: testAdapter(pullRequest()),
    nowMs: Date.parse("2026-09-03T18:00:00.000Z"),
  });

  assert.equal(inspected.status, "exact");
  assert.equal(inspected.remoteObservation.claimId, "claim_1");
  assert.equal(inspected.remoteObservation.claimFence, 3);
  assert.equal(inspected.remoteObservation.claimBindingDigest, BINDING_DIGEST);
  assert.equal(inspected.remoteObservation.pr.candidateMarker, `<!-- studioops-candidate:candidate_1:${MANIFEST_DIGEST} -->`);
  assert.equal(inspected.remoteObservation.pr.claimMarker, "<!-- studioops-claim:claim_1:3 -->");
  assert.equal(
    assertPromotionRemoteObservation(input, inspected.remoteObservation, {
      state: "OPEN",
      prUrl: "https://github.com/example/demo/pull/42",
      prNumber: 42,
    }),
    inspected.remoteObservation,
  );

  assert.throws(
    () => assertPromotionRemoteObservation(input, structuredClone(inspected.remoteObservation), { state: "OPEN" }),
    /not an exact attested GitHub result/i,
  );
  inspected.remoteObservation.pr.url = "https://github.com/example/demo/pull/43";
  assert.throws(
    () => assertPromotionRemoteObservation(input, inspected.remoteObservation),
    /not an exact attested GitHub result/i,
  );
});

test("merged promotion observation binds immutable merge SHA, time, repository, candidate, and claim", async () => {
  const input = authority();
  const mergedAt = "2026-09-03T18:01:00.000Z";
  const observation = createPromotionRemoteTestObservation(input, pullRequest({
    state: "MERGED",
    mergedAt,
    mergeCommit: { oid: MERGE_SHA },
  }), { nowMs: Date.parse("2026-09-03T18:02:00.000Z") });

  assert.equal(
    assertPromotionRemoteObservation(input, observation, {
      state: "MERGED",
      prUrl: "https://github.com/example/demo/pull/42",
      mergeCommit: MERGE_SHA,
      mergedAt,
    }),
    observation,
  );
  assert.throws(
    () => assertPromotionRemoteObservation(
      { ...input, claim: { ...input.claim, fence: 4 } },
      observation,
    ),
    /not an exact attested GitHub result/i,
  );
  assert.throws(
    () => assertPromotionRemoteObservation(input, observation, { mergeCommit: "3".repeat(40) }),
    /does not match the expected pull request outcome/i,
  );
});

test("test-only observation factory fails closed outside the hermetic test capability", async () => {
  const script = `
    await import(${JSON.stringify(MODULE_URL)});
    process.env.NODE_ENV = "test";
    process.env.STUDIOOPS_TEST_ISOLATION = "1";
    await import(${JSON.stringify(HARNESS_URL)});
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production", STUDIOOPS_TEST_ISOLATION: "" },
    }),
    (error) => {
      assert.match(error.stderr, /verified hermetic test root|boot-time isolated authority/i);
      return true;
    },
  );
});

test("merge-only recovery seals an exact persisted legacy handoff without a claim marker", async () => {
  const input = mergedRecoveryAuthority();
  const inspected = await inspectMergedPromotionRecovery(input, {
    testGitHubApi: createPromotionTestGitHubApi(async (request) => {
        assert.equal(request.operation, "get-merged-recovery");
        assert.equal(request.number, 77);
        return { ok: true, status: 200, payload: mergedRecoveryPullRequest(), output: "" };
      }),
    nowMs: Date.parse("2026-09-03T19:00:00.000Z"),
  });

  assert.equal(inspected.status, "exact_merged", inspected.reason);
  assert.equal(inspected.pr.mergeCommit, MERGE_SHA);
  assert.equal(
    assertMergedPromotionRecoveryObservation(input, inspected.remoteObservation),
    inspected.remoteObservation,
  );
  assert.throws(
    () => assertMergedPromotionRecoveryObservation(input, structuredClone(inspected.remoteObservation)),
    /not an exact attested GitHub result/i,
  );
});

test("merge-only recovery rejects open, wrong-body, and tampered observations", async () => {
  const input = mergedRecoveryAuthority();
  const adapter = (payload) => createPromotionTestGitHubApi(
    async () => ({ ok: true, status: 200, payload, output: "" }),
  );
  const open = await inspectMergedPromotionRecovery(input, {
    testGitHubApi: adapter(mergedRecoveryPullRequest({ merged_at: null, merge_commit_sha: null, state: "open" })),
  });
  assert.equal(open.status, "not_merged", open.reason);

  const wrongBody = await inspectMergedPromotionRecovery(input, {
    testGitHubApi: adapter(mergedRecoveryPullRequest({
      body: mergedRecoveryPullRequest().body.replace("candidate_legacy", "candidate_other"),
    })),
  });
  assert.equal(wrongBody.status, "wrong_identity");

  const observation = createMergedPromotionRecoveryTestObservation(
    input,
    mergedRecoveryPullRequest(),
    { nowMs: Date.parse("2026-09-03T19:01:00.000Z") },
  );
  observation.pr.mergeCommit = "3".repeat(40);
  assert.throws(
    () => assertMergedPromotionRecoveryObservation(input, observation),
    /not an exact attested GitHub result/i,
  );
});

test("a normal fenced reconcile claim can re-observe an exact legacy merged handoff", async () => {
  const recovery = mergedRecoveryAuthority();
  const input = {
    ...recovery,
    subjectCandidate: recovery.candidate,
    claim: {
      claimId: "claim_reconcile_legacy",
      fence: 1,
      bindingDigest: BINDING_DIGEST,
      mode: "reconcile",
      projectId: recovery.projectId,
      candidateId: recovery.candidate.id,
      qaDecision: {
        candidateId: recovery.candidate.id,
        manifestDigest: recovery.candidate.manifestDigest,
        integrationSha: recovery.candidate.manifest.integration.sha,
      },
    },
  };
  const inspected = await inspectPromotionRemotePullRequest(input, {
    testGitHubApi: testAdapter(mergedRecoveryPullRequest()),
    nowMs: Date.parse("2026-09-03T19:02:00.000Z"),
  });

  assert.equal(inspected.status, "exact");
  assert.equal(inspected.pr.state, "MERGED");
  assert.equal(inspected.remoteObservation.pr.claimMarker, "");
  assert.equal(
    assertPromotionRemoteObservation(input, inspected.remoteObservation, {
      state: "MERGED",
      prUrl: recovery.candidate.promotion.prUrl,
      mergeCommit: MERGE_SHA,
      mergedAt: "2026-08-26T17:36:35.000Z",
    }),
    inspected.remoteObservation,
  );
});
