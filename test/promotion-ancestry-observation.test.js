import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);
const ancestryEnvironment = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
Object.assign(process.env, ancestryEnvironment.env);
test.after(async () => ancestryEnvironment.cleanup());

const {
  assertPromotionMergeAncestryObservation,
  inspectPromotionMergeAncestry,
} = await import("../src/promotion-ancestry-observation.js");
const {
  createPromotionMergeAncestryTestObservation,
  createPromotionRemoteTestObservation,
  createPromotionTestGitRunner,
} = await import("./support/promotion-authority-harness.js");

const REPOSITORY_URL = "https://github.com/example/demo";
const PROJECT_ID = "project_1";
const TARGET_BRANCH = "main";
const MERGED_AT = "2026-09-03T12:30:00.000Z";

async function git(cwd, ...args) {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(result.stdout || "").trim();
}

async function createRepositoryGraph() {
  const fixtureRoot = path.join(ancestryEnvironment.testRoot, "promotion-ancestry");
  const remotePath = path.join(fixtureRoot, "remote.git");
  const redirectRemotePath = path.join(fixtureRoot, "redirect.git");
  const seedPath = path.join(fixtureRoot, "seed");
  const workspacePath = path.join(fixtureRoot, "workspace");
  await mkdir(fixtureRoot, { recursive: true });
  await git(fixtureRoot, "init", "--bare", remotePath);
  await git(fixtureRoot, "init", "--bare", redirectRemotePath);
  await git(fixtureRoot, "init", seedPath);
  await git(seedPath, "checkout", "-b", TARGET_BRANCH);
  await git(seedPath, "config", "user.name", "StudioOps Test");
  await git(seedPath, "config", "user.email", "studioops@example.invalid");
  await writeFile(path.join(seedPath, "base.txt"), "base\n");
  await git(seedPath, "add", "base.txt");
  await git(seedPath, "commit", "-m", "base");
  const baseSha = await git(seedPath, "rev-parse", "HEAD");

  await git(seedPath, "checkout", "-b", "candidate");
  await writeFile(path.join(seedPath, "candidate.txt"), "candidate\n");
  await git(seedPath, "add", "candidate.txt");
  await git(seedPath, "commit", "-m", "candidate");
  const candidateSha = await git(seedPath, "rev-parse", "HEAD");

  await git(seedPath, "checkout", TARGET_BRANCH);
  await git(seedPath, "merge", "--no-ff", "candidate", "-m", "merge candidate");
  const targetHead = await git(seedPath, "rev-parse", "HEAD");

  await git(seedPath, "checkout", "-b", "unmerged-candidate", baseSha);
  await writeFile(path.join(seedPath, "unmerged.txt"), "not on main\n");
  await git(seedPath, "add", "unmerged.txt");
  await git(seedPath, "commit", "-m", "unmerged candidate");
  const unmergedCandidateSha = await git(seedPath, "rev-parse", "HEAD");

  await git(seedPath, "checkout", "-b", "unreachable-merge", candidateSha);
  await writeFile(path.join(seedPath, "unreachable-merge.txt"), "not on main\n");
  await git(seedPath, "add", "unreachable-merge.txt");
  await git(seedPath, "commit", "-m", "unreachable merge");
  const unreachableMergeSha = await git(seedPath, "rev-parse", "HEAD");

  await git(seedPath, "remote", "add", "origin", remotePath);
  await git(seedPath, "push", "origin", `${TARGET_BRANCH}:${TARGET_BRANCH}`);
  await git(seedPath, "push", "origin", "candidate:candidate");
  await git(seedPath, "push", "origin", "unmerged-candidate:unmerged-candidate");
  await git(seedPath, "push", "origin", "unreachable-merge:unreachable-merge");
  await git(fixtureRoot, `--git-dir=${remotePath}`, "symbolic-ref", "HEAD", `refs/heads/${TARGET_BRANCH}`);
  await git(fixtureRoot, "clone", remotePath, workspacePath);
  await git(workspacePath, "remote", "set-url", "origin", REPOSITORY_URL);

  return {
    remotePath,
    redirectRemotePath,
    workspacePath,
    baseSha,
    candidateSha,
    targetHead,
    unmergedCandidateSha,
    unreachableMergeSha,
  };
}

const graph = await createRepositoryGraph();
const ancestryGitInvocations = [];

function rewriteFixtureFetch(args, remotePath = graph.remotePath) {
  const effectiveArgs = [...args];
  const repositoryIndex = effectiveArgs.indexOf(REPOSITORY_URL);
  if (repositoryIndex < 0) return effectiveArgs;
  effectiveArgs[repositoryIndex] = pathToFileURL(remotePath).href;
  const filePolicyIndex = effectiveArgs.indexOf("protocol.file.allow=never");
  if (filePolicyIndex >= 0) effectiveArgs[filePolicyIndex] = "protocol.file.allow=always";
  return effectiveArgs;
}

const testGitRunner = createPromotionTestGitRunner(async ({ repoPath, args, execute }) => {
  ancestryGitInvocations.push({ repoPath, args: [...args] });
  return execute(rewriteFixtureFetch(args));
});

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function candidate(id, integrationSha) {
  return {
    id,
    projectId: PROJECT_ID,
    manifestDigest: digest(`manifest:${id}:${integrationSha}`),
    manifest: {
      base: { branch: TARGET_BRANCH, sha: graph.baseSha },
      integration: { branch: `qa/${id}`, sha: integrationSha },
      sources: [{
        taskId: `task_${id}`,
        headSha: integrationSha,
        candidateCycle: 1,
      }],
    },
  };
}

function claimFor(candidateValue, suffix = candidateValue.id) {
  return {
    schemaVersion: "studioops.promotion-attempt-claim.v4",
    claimId: `claim_${suffix}`,
    fence: 3,
    status: "active",
    mode: "reconcile",
    bindingDigest: digest(`claim:${suffix}`),
    renewedAt: new Date(Date.parse(MERGED_AT) - 60_000).toISOString(),
    expiresAt: new Date(Date.parse(MERGED_AT) + 10 * 60_000).toISOString(),
    projectId: PROJECT_ID,
    candidateId: candidateValue.id,
    qaDecision: {
      candidateId: candidateValue.id,
      manifestDigest: candidateValue.manifestDigest,
      integrationSha: candidateValue.manifest.integration.sha,
    },
  };
}

function sealedAuthority({ candidateValue, mergeCommit, number, claim = claimFor(candidateValue) }) {
  const promotionBranch = `qa/promotion-${candidateValue.id}`;
  const prUrl = `${REPOSITORY_URL}/pull/${number}`;
  const remoteAuthority = {
    projectId: PROJECT_ID,
    repoUrl: REPOSITORY_URL,
    targetBranch: TARGET_BRANCH,
    promotionBranch,
    headSha: candidateValue.manifest.integration.sha,
    candidate: candidateValue,
    subjectCandidate: candidateValue,
    claim,
  };
  const remoteObservation = createPromotionRemoteTestObservation(remoteAuthority, {
    number,
    url: prUrl,
    state: "MERGED",
    mergedAt: MERGED_AT,
    mergeCommit,
    baseRefName: TARGET_BRANCH,
    headRefName: promotionBranch,
    headRefOid: candidateValue.manifest.integration.sha,
    headRepository: { nameWithOwner: "example/demo" },
    body: [
      `<!-- studioops-candidate:${candidateValue.id}:${candidateValue.manifestDigest} -->`,
      `<!-- studioops-claim:${claim.claimId}:${claim.fence} -->`,
    ].join("\n"),
  }, { nowMs: Date.parse(MERGED_AT) + 1_000 });
  return {
    projectId: PROJECT_ID,
    repoUrl: REPOSITORY_URL,
    repoPath: graph.workspacePath,
    targetBranch: TARGET_BRANCH,
    promotionBranch,
    subjectCandidate: candidateValue,
    remoteCandidate: candidateValue,
    claim,
    prUrl,
    mergeCommit,
    mergedAt: MERGED_AT,
    remoteObservation,
  };
}

async function inspect(input, nowMs = Date.parse(MERGED_AT) + 2_000) {
  return inspectPromotionMergeAncestry(input, { testGitRunner, nowMs });
}

test("direct merged candidate receives an exact Git ancestry seal", async () => {
  const invocationStart = ancestryGitInvocations.length;
  const input = sealedAuthority({
    candidateValue: candidate("candidate_direct", graph.candidateSha),
    mergeCommit: graph.targetHead,
    number: 41,
  });
  const observation = await inspect(input);
  assert.equal(observation.targetHead, graph.targetHead);
  assert.equal(observation.subjectIntegrationSha, graph.candidateSha);
  assert.equal(observation.remoteIntegrationSha, graph.candidateSha);
  assert.equal(observation.mergeCommit, graph.targetHead);
  assert.strictEqual(assertPromotionMergeAncestryObservation(input, observation, {
    nowMs: Date.parse(MERGED_AT) + 3_000,
  }), observation);

  const fetchInvocation = ancestryGitInvocations
    .slice(invocationStart)
    .find((invocation) => invocation.args.includes("fetch"));
  assert.ok(fetchInvocation, "ancestry verifier should fetch the protected target");
  assert.ok(fetchInvocation.args.includes(REPOSITORY_URL));
  assert.equal(fetchInvocation.args.includes("origin"), false);
  assert.ok(fetchInvocation.args.includes("protocol.file.allow=never"));
  assert.ok(fetchInvocation.args.includes("protocol.ext.allow=never"));
  assert.notEqual(fetchInvocation.repoPath, graph.workspacePath);
  const runtimeRelative = path.relative(await realpath(ancestryEnvironment.runtimeRoot), fetchInvocation.repoPath);
  assert.ok(runtimeRelative && !runtimeRelative.startsWith("..") && !path.isAbsolute(runtimeRelative));
  await assert.rejects(lstat(fetchInvocation.repoPath), { code: "ENOENT" });
});

test("ancestry authority binds the current claim lease generation and bounded freshness", async () => {
  const input = sealedAuthority({
    candidateValue: candidate("candidate_freshness", graph.candidateSha),
    mergeCommit: graph.targetHead,
    number: 47,
  });
  const observedAt = Date.parse(MERGED_AT) + 2_000;
  const observation = await inspect(input, observedAt);
  const renewedInput = {
    ...input,
    claim: {
      ...input.claim,
      renewedAt: new Date(observedAt + 1_000).toISOString(),
      expiresAt: new Date(observedAt + 10 * 60_000).toISOString(),
    },
  };
  assert.throws(
    () => assertPromotionMergeAncestryObservation(renewedInput, observation, { nowMs: observedAt + 2_000 }),
    /not an exact attested Git result/,
  );

  const renewedObservation = createPromotionMergeAncestryTestObservation(renewedInput, {
    targetHead: graph.targetHead,
    nowMs: observedAt + 2_000,
  });
  assert.strictEqual(
    assertPromotionMergeAncestryObservation(renewedInput, renewedObservation, { nowMs: observedAt + 3_000 }),
    renewedObservation,
  );

  assert.throws(
    () => assertPromotionMergeAncestryObservation(input, observation, { nowMs: observedAt + 60_001 }),
    /not an exact attested Git result/,
  );
  const futureObservation = createPromotionMergeAncestryTestObservation(input, {
    targetHead: graph.targetHead,
    nowMs: observedAt + 10_000,
  });
  assert.throws(
    () => assertPromotionMergeAncestryObservation(input, futureObservation, { nowMs: observedAt }),
    /not an exact attested Git result/,
  );
});

test("cloned, mutated, remote-cloned, and wrong-claim observations are rejected", async () => {
  const input = sealedAuthority({
    candidateValue: candidate("candidate_seal", graph.candidateSha),
    mergeCommit: graph.targetHead,
    number: 42,
  });
  const observation = await inspect(input);
  assert.throws(
    () => assertPromotionMergeAncestryObservation(input, structuredClone(observation)),
    /not an exact attested Git result/,
  );

  observation.targetHead = graph.candidateSha;
  assert.throws(
    () => assertPromotionMergeAncestryObservation(input, observation),
    /not an exact attested Git result/,
  );

  await assert.rejects(
    () => inspect({ ...input, remoteObservation: structuredClone(input.remoteObservation) }),
    /not an exact attested GitHub result/,
  );

  const validInput = sealedAuthority({
    candidateValue: candidate("candidate_wrong_claim", graph.candidateSha),
    mergeCommit: graph.targetHead,
    number: 43,
  });
  const validObservation = await inspect(validInput);
  assert.throws(
    () => assertPromotionMergeAncestryObservation({
      ...validInput,
      claim: { ...validInput.claim, claimId: "claim_wrong" },
    }, validObservation),
    /not an exact attested GitHub result/,
  );
});

test("a remote candidate that is not reachable from the protected target is rejected", async () => {
  const input = sealedAuthority({
    candidateValue: candidate("candidate_unmerged", graph.unmergedCandidateSha),
    mergeCommit: graph.unmergedCandidateSha,
    number: 44,
  });
  await assert.rejects(
    () => inspect(input),
    /remote candidate is not reachable from the protected target/,
  );
});

test("a reported merge commit that is not reachable from the protected target is rejected", async () => {
  const input = sealedAuthority({
    candidateValue: candidate("candidate_bad_merge", graph.candidateSha),
    mergeCommit: graph.unreachableMergeSha,
    number: 45,
  });
  await assert.rejects(
    () => inspect(input),
    /merge commit is not reachable from the protected target/,
  );
});

test("caller-local insteadOf configuration cannot redirect the protected-target fetch", async () => {
  const redirectUrl = pathToFileURL(graph.redirectRemotePath).href;
  const rewriteKey = `url.${redirectUrl}.insteadOf`;
  await git(graph.workspacePath, "config", "--local", rewriteKey, REPOSITORY_URL);
  assert.equal(await git(graph.workspacePath, "config", "--local", "--get", rewriteKey), REPOSITORY_URL);

  const invocations = [];
  const redirectResistantRunner = createPromotionTestGitRunner(async ({ repoPath, args, execute }) => {
    invocations.push({ repoPath, args: [...args] });
    return execute(rewriteFixtureFetch(args));
  });
  const input = sealedAuthority({
    candidateValue: candidate("candidate_redirect_resistant", graph.candidateSha),
    mergeCommit: graph.targetHead,
    number: 46,
  });
  const observation = await inspectPromotionMergeAncestry(input, {
    testGitRunner: redirectResistantRunner,
    nowMs: Date.parse(MERGED_AT) + 2_000,
  });

  assert.equal(observation.targetHead, graph.targetHead);
  const fetchInvocation = invocations.find((invocation) => invocation.args.includes("fetch"));
  assert.ok(fetchInvocation, "ancestry verifier should execute an explicit fetch");
  assert.ok(fetchInvocation.args.includes(REPOSITORY_URL));
  assert.equal(fetchInvocation.args.includes("origin"), false);
  assert.notEqual(fetchInvocation.repoPath, graph.workspacePath);
  assert.equal(invocations.some((invocation) => invocation.repoPath === graph.workspacePath), false);
  await assert.rejects(lstat(fetchInvocation.repoPath), { code: "ENOENT" });
});
