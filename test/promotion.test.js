import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { planPromotions, truncateOutput } from "../src/promotion.js";
import { promotionValidationPolicyDigest } from "../src/promotion-validation-evidence.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const promotionModuleUrl = pathToFileURL(path.join(process.cwd(), "src/promotion.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const PROMOTION_ENVIRONMENT_POLICY = "promotion-project-environment-v2-isolated-home";

async function run(command, args, options = {}) {
  const baseEnv = options.cwd && command === process.execPath
    ? await environmentForTestControlRoot(options.cwd)
    : process.env;
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env || {}),
    },
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function git(repoPath, args) {
  const result = await run("git", args, { cwd: repoPath });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function configureRepo(repoPath) {
  await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
}

function baseState(overrides = {}) {
  return {
    meta: {},
    projects: [],
    tasks: [],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
    qaBundles: [],
    candidates: [],
    ...overrides,
  };
}

function candidateFixture({ baseSha, sourceSha, integrationSha, status = "frozen" }) {
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: baseSha },
      sources: [{
        taskId: "task_1",
        sourceRef: "refs/heads/feature/task",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T11:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-demo", sha: integrationSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "test -f feature.txt",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T12:00:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_1"],
        includedTaskIds: ["task_1"],
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-07-25T12:00:00.000Z",
  });
  candidate.qaBundleId = "qa_bundle_1";
  candidate.status = status;
  if (status === "qa_passed") {
    candidate.qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha,
      taskIds: ["task_1"],
      author: "Owner QA",
      notes: "",
      repositoryVerifiedAt: "2026-07-25T12:29:59.000Z",
      decidedAt: "2026-07-25T12:30:00.000Z",
    };
  }
  return candidate;
}

function releaseCandidateFixture({ baseSha, sourceSha, integrationSha, prUrl }) {
  const candidate = candidateFixture({ baseSha, sourceSha, integrationSha, status: "qa_passed" });
  candidate.status = "release_candidate_ready";
  candidate.promotion = {
    branch: "qa/promotion-demo",
    prUrl,
    commitSha: integrationSha,
    manifestDigest: candidate.manifestDigest,
    readyAt: "2026-07-25T12:40:00.000Z",
  };
  return candidate;
}

function mergedCandidateFixture({ baseSha, sourceSha, integrationSha, mergeCommit, prUrl }) {
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_2",
    manifest: {
      candidateId: "candidate_2",
      projectId: "project_1",
      base: { branch: "main", sha: baseSha },
      sources: [{
        taskId: "task_2",
        sourceRef: "refs/heads/feature/replacement",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_2",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T13:05:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-replacement", sha: integrationSha },
      checks: [{
        id: "check_2",
        kind: "local-validation",
        name: "test -f replacement.txt",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"b".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T13:10:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-07-25T13:10:00.000Z",
  });
  candidate.status = "merged";
  candidate.qaDecision = {
    outcome: "passed",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha,
    taskIds: ["task_2"],
    author: "Owner QA",
    notes: "",
    repositoryVerifiedAt: "2026-07-25T13:11:00.000Z",
    decidedAt: "2026-07-25T13:12:00.000Z",
  };
  candidate.promotion = {
    branch: "qa/promotion-replacement",
    prUrl,
    commitSha: integrationSha,
    manifestDigest: candidate.manifestDigest,
    readyAt: "2026-07-25T13:13:00.000Z",
  };
  candidate.promotionMerge = {
    mergeCommit,
    mergedAt: "2026-07-25T13:14:00.000Z",
    reconciledAt: "2026-07-25T13:15:00.000Z",
  };
  candidate.updatedAt = "2026-07-25T13:15:00.000Z";
  return candidate;
}

test("promotion planning requires a complete candidate-level QA pass, not a status label", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const spoofed = candidateFixture(fixture);
  spoofed.status = "qa_passed";
  const valid = candidateFixture({ ...fixture, status: "qa_passed" });
  const state = baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
    }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
    candidates: [spoofed],
  });
  assert.equal(planPromotions(state).projects.length, 0);
  state.candidates = [valid];
  assert.equal(planPromotions(state).projects.length, 1);
  state.projects[0].promotion = { targetBranch: "release" };
  const redirected = planPromotions(state).projects[0];
  assert.equal(redirected.enabled, false);
  assert.equal(redirected.targetBranch, "main");
  assert.match(redirected.skipReason, /does not match candidate base/);
});

test("promotion planning permits one exact-candidate validation retry without discarding QA evidence", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const candidate = candidateFixture({ ...fixture, status: "qa_passed" });
  const policyDigest = promotionValidationPolicyDigest({
    commands: [],
    timeoutMs: 600_000,
    environmentPolicyVersion: PROMOTION_ENVIRONMENT_POLICY,
  });
  const task = {
    id: "task_1",
    projectId: "project_1",
    status: "approved_for_main",
    promotionStatus: "validation_failed",
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: fixture.sourceSha,
    reviewSubjectCycle: 1,
    stateVersion: 1,
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts: 1,
    promotionValidation: {
      status: "validation_failed",
      evidence: {
        path: "/private-evidence/attempt-1.json",
        digest: `sha256:${"d".repeat(64)}`,
        bytes: 512,
        createdAt: "2026-07-25T12:30:00.000Z",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: candidate.manifest.integration.sha,
        attempt: 1,
        policyDigest,
        commandCount: 1,
      },
    },
    promotionRetryAuthorization: {
      schemaVersion: "studioops.promotion-retry-authorization.v1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      policyDigest,
      firstEvidenceDigest: `sha256:${"d".repeat(64)}`,
      independentResult: "validation_failed",
      authorizedBy: "studioops-promotion-worker",
      authorizedAt: "2026-07-25T12:31:00.000Z",
    },
  };
  const state = baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
    }],
    tasks: [task],
    candidates: [candidate],
  });

  const retry = planPromotions(state);
  assert.equal(retry.projects.length, 1);
  assert.equal(retry.projects[0].mode, "retry");
  assert.equal(retry.projects[0].tasks[0].promotionValidationAttempts, 1);
  assert.equal(candidate.status, "qa_passed");
  assert.equal(candidate.invalidation, null);

  task.promotionValidationAttempts = 2;
  assert.equal(planPromotions(state).projects.length, 0);

  task.promotionValidationAttempts = 1;
  task.reviewSubjectSha = "c".repeat(40);
  assert.equal(planPromotions(state).projects.length, 0);
});

test("promotion planning autonomously resumes post-validation operational failures from an exact evidence receipt", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const candidate = candidateFixture({ ...fixture, status: "qa_passed" });
  const policyDigest = promotionValidationPolicyDigest({
    commands: [],
    timeoutMs: 600_000,
    environmentPolicyVersion: PROMOTION_ENVIRONMENT_POLICY,
  });
  candidate.promotionValidationRecoveryReceipt = {
    schemaVersion: "studioops.promotion-validation-recovery.v1",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    policyDigest,
    validationResultDigest: `sha256:${"c".repeat(64)}`,
    validationEvidence: {
      path: "/private-evidence/passed.json",
      digest: `sha256:${"d".repeat(64)}`,
      bytes: 512,
      createdAt: "2026-07-25T12:31:00.000Z",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      attempt: 1,
      policyDigest,
      commandCount: 1,
    },
    validatedAt: "2026-07-25T12:31:00.000Z",
  };
  const task = {
    id: "task_1",
    projectId: "project_1",
    status: "promotion_blocked",
    promotionStatus: "pr_failed",
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: fixture.sourceSha,
    reviewSubjectCycle: 1,
    stateVersion: 2,
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts: 1,
  };
  const state = baseState({
    projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo", defaultBranch: "main" }],
    tasks: [task],
    candidates: [candidate],
  });

  const recovered = planPromotions(state);
  assert.equal(recovered.projects.length, 1);
  assert.equal(recovered.projects[0].mode, "create");
  task.promotionStatus = "pr_closed";
  assert.equal(planPromotions(state).projects.length, 0);
  task.promotionStatus = "pr_failed";
  candidate.promotionValidationRecoveryReceipt.validationEvidence.digest = "malformed";
  assert.equal(planPromotions(state).projects.length, 0);
});

test("promotion output keeps the failure tail when bounded", () => {
  const output = truncateOutput(`START\n${"x".repeat(500)}\nFAILURE SUMMARY`, 160);
  assert.match(output, /^START/);
  assert.match(output, /\.\.\.\[truncated\]\.\.\./);
  assert.match(output, /FAILURE SUMMARY$/);
  assert.equal(output.length, 160);
});

test("promotion planning retains persisted release candidates for reconciliation", () => {
  const prUrl = "https://github.com/example/demo/pull/42";
  const candidate = releaseCandidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    prUrl,
  });
  const state = baseState({
    projects: [{
      id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo", defaultBranch: "main",
    }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
    candidates: [candidate],
  });

  const plan = planPromotions(state);
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.projects[0].mode, "reconcile");
  assert.equal(plan.projects[0].candidate.promotion.prUrl, prUrl);
});

test("promotion planning drops stale release candidates after a source task returns to changes", () => {
  const candidate = releaseCandidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    prUrl: "https://github.com/example/demo/pull/42",
  });
  const state = baseState({
    projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo", defaultBranch: "main" }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "needs_changes" }],
    candidates: [candidate],
  });
  assert.equal(planPromotions(state).projects.length, 0);
});

async function writeState(root, state) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function reconciliationFixture(prState = "OPEN", overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-reconcile-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const prUrl = "https://github.com/example/demo/pull/42";

  await git(root, ["init", "--bare", remotePath]);
  await git(root, ["clone", remotePath, repoPath]);
  await configureRepo(repoPath);
  await git(repoPath, ["checkout", "-b", "main"]);
  await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "app.txt"]);
  await git(repoPath, ["commit", "-m", "base"]);
  const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["push", "-u", "origin", "main"]);
  await git(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
  await git(repoPath, ["add", "feature.txt"]);
  await git(repoPath, ["commit", "-m", "feature"]);
  const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["push", "-u", "origin", "feature/task"]);
  await git(repoPath, ["branch", "qa/candidate-demo"]);
  await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

  let mergeCommit = null;
  let mergedAt = null;
  if (prState === "MERGED") {
    await git(repoPath, ["checkout", "main"]);
    await git(repoPath, ["merge", "--no-ff", sourceSha, "-m", "merge release candidate"]);
    mergeCommit = await git(repoPath, ["rev-parse", "HEAD"]);
    mergedAt = "2026-07-25T13:00:00.000Z";
    await git(repoPath, ["push", "origin", "main"]);
  }

  const candidate = releaseCandidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, prUrl });
  await writeState(root, baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath,
      defaultBranch: "main",
      promotion: { enabled: true, targetBranch: "main" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Feature task",
      status: "user_review",
      stateVersion: 1,
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: sourceSha,
      branchName: "feature/task",
      candidateId: candidate.id,
      qaBundleId: "qa_bundle_1",
      promotionStatus: "pr_ready",
      promotionPrUrl: prUrl,
    }],
    qaBundles: [{
      id: "qa_bundle_1",
      projectId: "project_1",
      projectKey: "demo",
      status: "release_candidate_ready",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      promotionPrUrl: prUrl,
      tasks: [{ id: "task_1", title: "Feature task" }],
    }],
    candidates: [candidate],
  }));

  await mkdir(fakeBin, { recursive: true });
  const pr = {
    state: prState,
    baseRefName: overrides.baseRefName || "main",
    headRefName: "qa/promotion-demo",
    headRefOid: overrides.headRefOid || sourceSha,
    mergeCommit: mergeCommit ? { oid: mergeCommit } : null,
    url: prUrl,
    mergedAt,
  };
  await writeFile(fakeBin + "/gh", `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(pr)}'\n`, "utf8");
  await chmod(fakeBin + "/gh", 0o755);
  return { root, repoPath, fakeBin, candidate, sourceSha, mergeCommit };
}

test("owner QA bundle pass binds browser-shaped input to the immutable candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-decision-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha });
    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          defaultBranch: "main",
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Ready task",
          status: "qa_review",
          integrationStatus: "ready",
          candidateId: candidate.id,
          qaBundleId: "qa_bundle_1",
        },
      ],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        status: "ready",
        tasks: [{ id: "task_1", title: "Ready task" }],
      }],
      candidates: [candidate],
    }));

    const qaDecisionScript = (input) => `
      import { recordQaDecision } from ${JSON.stringify(storeModuleUrl)};
      await recordQaDecision("task_1", ${JSON.stringify({
        outcome: "passed",
        author: "Owner QA",
        body: "Preview looked good.",
        ...input,
      })});
    `;
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: "candidate_wrong",
        manifestDigest: candidate.manifestDigest,
        integrationSha: sourceSha,
      })], { cwd: root }),
      /candidate ID does not match/,
    );
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: candidate.id,
        manifestDigest: `sha256:${"f".repeat(64)}`,
        integrationSha: sourceSha,
      })], { cwd: root }),
      /manifest digest does not match/,
    );
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: baseSha,
      })], { cwd: root }),
      /integration SHA does not match/,
    );
    assert.equal(readPersistedState(root).tasks[0].status, "qa_review");

    const script = `
      import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
      const result = await recordQaBundleDecision("qa_bundle_1", {
        outcome: "passed",
        author: "Owner QA",
        body: "Preview looked good."
      });
      console.log(JSON.stringify(result.decisions[0].task));
    `;
    const result = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const task = JSON.parse(result.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(task.status, "approved_for_main");
    assert.equal(task.assignedAgentRole, "promotion-worker");
    assert.equal(task.promotionStatus, "queued");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(state.candidates[0].qaDecision.manifestDigest, candidate.manifestDigest);
    assert.equal(state.comments[0].author, "Owner QA");
    assert.match(state.comments[0].body, /Local QA passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner QA cannot pass only part of a multi-task candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-atomic-qa-decision-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/one"]);
    await writeFile(path.join(repoPath, "one.txt"), "one\n", "utf8");
    await git(repoPath, ["add", "one.txt"]);
    await git(repoPath, ["commit", "-m", "feature one"]);
    const sourceOneSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/one"]);

    await git(repoPath, ["checkout", "-b", "feature/two"]);
    await writeFile(path.join(repoPath, "two.txt"), "two\n", "utf8");
    await git(repoPath, ["add", "two.txt"]);
    await git(repoPath, ["commit", "-m", "feature two"]);
    const sourceTwoSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/two"]);
    await git(repoPath, ["branch", "qa/candidate-two-tasks"]);
    await git(repoPath, ["push", "origin", "qa/candidate-two-tasks"]);

    const source = (taskId, sourceRef, headSha, reviewId) => ({
      taskId,
      sourceRef,
      headSha,
      candidateCycle: 1,
      reviews: [{
        id: reviewId,
        stageKey: "lead",
        role: "lead-reviewer",
        outcome: "approved",
        subjectSha: headSha,
        candidateCycle: 1,
        reviewedAt: "2026-07-25T11:00:00.000Z",
      }],
    });
    const candidate = createCandidateEnvelope({
      qaBundleId: "qa_bundle_1",
      manifest: {
        candidateId: "candidate_two_tasks",
        projectId: "project_1",
        base: { branch: "main", sha: baseSha },
        sources: [
          source("task_1", "refs/heads/feature/one", sourceOneSha, "review_1"),
          source("task_2", "refs/heads/feature/two", sourceTwoSha, "review_2"),
        ],
        integration: { branch: "qa/candidate-two-tasks", sha: sourceTwoSha },
        checks: [{
          id: "check_1",
          kind: "local-validation",
          name: "npm test",
          outcome: "passed",
          subjectSha: sourceTwoSha,
          evidenceDigest: `sha256:${"a".repeat(64)}`,
        }],
        preview: {
          url: "http://127.0.0.1:4174/",
          status: "healthy",
          commitSha: sourceTwoSha,
          verifiedAt: "2026-07-25T12:00:00.000Z",
          attestation: {
            kind: "header",
            key: "x-studioops-commit",
            observedSha: sourceTwoSha,
          },
        },
        assembly: {
          mode: "atomic",
          requestedTaskIds: ["task_1", "task_2"],
          includedTaskIds: ["task_1", "task_2"],
          excludedTaskIds: [],
        },
      },
    });
    await writeState(root, baseState({
      projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath, defaultBranch: "main" }],
      tasks: ["task_1", "task_2"].map((id) => ({
        id,
        projectId: "project_1",
        title: id,
        status: "qa_review",
        integrationStatus: "ready",
        candidateId: candidate.id,
        qaBundleId: "qa_bundle_1",
      })),
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "ready",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1" }, { id: "task_2" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
      await recordQaBundleDecision("qa_bundle_1", {
        outcome: "passed",
        author: "Owner QA",
        taskIds: ["task_1"],
        candidateId: ${JSON.stringify(candidate.id)},
        manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
        integrationSha: ${JSON.stringify(sourceTwoSha)}
      });
    `;
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", script], { cwd: root }),
      /atomic and must include every manifest task/,
    );
    const state = readPersistedState(root);
    assert.equal(state.candidates[0].status, "frozen");
    assert.deepEqual(state.tasks.map((task) => task.status), ["qa_review", "qa_review"]);

    await git(repoPath, ["remote", "set-url", "origin", path.join(root, "unavailable.git")]);
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", `
        import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        await recordQaBundleDecision("qa_bundle_1", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          integrationSha: ${JSON.stringify(sourceTwoSha)}
        });
      `], { cwd: root }),
      /integrity could not be verified/,
    );
    assert.equal(readPersistedState(root).candidates[0].status, "frozen");
    await git(repoPath, ["remote", "set-url", "origin", remotePath]);

    await run(process.execPath, ["--input-type=module", "-e", `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      import { invalidateCandidate } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/candidate-manifest.js")).href)};
      await mutateState((state) => {
        invalidateCandidate(state.candidates[0], { reason: "Explicit test invalidation." });
      });
    `], { cwd: root });
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", `
        import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        await recordQaBundleDecision("qa_bundle_1", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          integrationSha: ${JSON.stringify(sourceTwoSha)}
        });
      `], { cwd: root }),
      /Invalidated candidate cannot receive a QA decision/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion retries one exact QA candidate with scrubbed validation credentials without updating main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "gh"), "#!/bin/sh\necho https://github.com/example/demo/pull/42\n", "utf8");
    await chmod(path.join(fakeBin, "gh"), 0o755);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const blockedValidationKeys = [
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "GIT_ASKPASS",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_SSH_COMMAND",
      "SSH_AUTH_SOCK",
      "MISSION_CONTROL_GITHUB_APP_AUTH",
      "MISSION_CONTROL_GITHUB_TOKEN",
      "MISSION_CONTROL_GIT_USERNAME",
      "STUDIOOPS_GITHUB_PRIVATE_KEY",
      "GITHUB_APP_ID",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "NPM_TOKEN",
    ];
    const validationProbe = `const blocked = ${JSON.stringify(blockedValidationKeys)}; const home = process.env.HOME || ""; if (blocked.some((key) => process.env[key]) || !home.includes("validation-home-") || process.env.CI !== "1" || process.env.GIT_CONFIG_GLOBAL !== "/dev/null" || process.env.GIT_TERMINAL_PROMPT !== "0" || !String(process.env.GH_CONFIG_DIR || "").startsWith(home)) process.exit(23)`;
    const validationCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(validationProbe)} && test -f feature.txt`;
    const validationPolicyDigest = promotionValidationPolicyDigest({
      commands: [validationCommand],
      timeoutMs: 600_000,
      environmentPolicyVersion: PROMOTION_ENVIRONMENT_POLICY,
    });
    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: [validationCommand],
          promotion: {
            enabled: true,
            targetBranch: "main",
          },
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "approved_for_main",
          stateVersion: 1,
          branchName: "feature/task",
          prUrl: "",
          promotionStatus: "validation_failed",
          reviewSubjectSha: sourceSha,
          reviewSubjectCycle: 1,
          qaBundleId: "qa_bundle_1",
          candidateId: candidate.id,
          promotionValidationCandidateId: candidate.id,
          promotionValidationAttempts: 1,
          promotionValidation: {
            status: "validation_failed",
            evidence: {
              path: "/private-evidence/attempt-1.json",
              digest: `sha256:${"e".repeat(64)}`,
              bytes: 512,
              createdAt: "2026-07-25T12:30:00.000Z",
              candidateId: candidate.id,
              manifestDigest: candidate.manifestDigest,
              integrationSha: candidate.manifest.integration.sha,
              attempt: 1,
              policyDigest: validationPolicyDigest,
              commandCount: 1,
            },
          },
          promotionRetryAuthorization: {
            schemaVersion: "studioops.promotion-retry-authorization.v1",
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
            integrationSha: candidate.manifest.integration.sha,
            policyDigest: validationPolicyDigest,
            firstEvidenceDigest: `sha256:${"e".repeat(64)}`,
            independentResult: "validation_failed",
            authorizedBy: "studioops-promotion-worker",
            authorizedAt: "2026-07-25T12:31:00.000Z",
          },
        },
      ],
      qaBundles: [
        {
          id: "qa_bundle_1",
          projectId: "project_1",
          projectKey: "demo",
          status: "passed",
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          tasks: [{ id: "task_1", title: "Feature task" }],
        },
      ],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        env: {
          PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)},
          GH_TOKEN: "secret-gh-token",
          GH_ENTERPRISE_TOKEN: "secret-gh-enterprise-token",
          GITHUB_TOKEN: "secret-github-token",
          GIT_ASKPASS: "/tmp/secret-askpass",
          GIT_CONFIG_PARAMETERS: "'http.extraheader=secret'",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "secret-helper",
          GIT_SSH_COMMAND: "ssh -i /tmp/secret-key",
          GIT_TERMINAL_PROMPT: "0",
          MISSION_CONTROL_GITHUB_TOKEN: "secret-mission-token",
          MISSION_CONTROL_GITHUB_APP_AUTH: "1",
          MISSION_CONTROL_GIT_USERNAME: "x-access-token",
          STUDIOOPS_GITHUB_PRIVATE_KEY: "secret-private-key",
          GITHUB_APP_ID: "123",
          GITHUB_INSTALLATION_ID: "456",
          GITHUB_PRIVATE_KEY: "secret-github-private-key",
          SSH_AUTH_SOCK: "/tmp/secret-ssh-agent",
          OPENAI_API_KEY: "secret-openai-key",
          AWS_SECRET_ACCESS_KEY: "secret-aws-key",
          NPM_TOKEN: "secret-npm-token",
          HOME: "/tmp/credential-bearing-home"
        }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].mode, "retry");
    assert.equal(report.projects[0].status, "pr_ready", report.projects[0].output);
    assert.equal(report.projects[0].tasks[0].status, "pr_ready");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.tasks[0].promotionStatus, "pr_ready");
    assert.equal(state.tasks[0].promotionValidationCandidateId, candidate.id);
    assert.equal(state.tasks[0].promotionValidationAttempts, 2);
    assert.equal(state.tasks[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.qaBundles[0].status, "release_candidate_ready");
    assert.equal(state.qaBundles[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.candidates[0].status, "release_candidate_ready");
    assert.equal(state.candidates[0].promotionValidationRecoveryReceipt.policyDigest, validationPolicyDigest);
    assert.equal(state.candidates[0].promotion.commitSha, sourceSha);
    assert.ok(report.projects[0].promotionBranch);
    assert.ok(await git(root, ["--git-dir", remotePath, "rev-parse", `refs/heads/${report.projects[0].promotionBranch}`]));
    await assert.rejects(() => git(root, ["--git-dir", remotePath, "show", "refs/heads/main:feature.txt"]));
    assert.equal(state.events.some((event) => event.type === "release_candidate_ready"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion reuses verified validation evidence after a transient PR failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-pr-recovery-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const prAttemptMarker = path.join(root, "pr-attempted");
  const validationCounter = path.join(root, "validation-count");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);

    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ ! -f ${JSON.stringify(prAttemptMarker)} ]; then
    touch ${JSON.stringify(prAttemptMarker)}
    echo 'transient PR service failure' >&2
    exit 7
  fi
  echo 'https://github.com/example/demo/pull/42'
  exit 0
fi
exit 9
`, "utf8");
    await chmod(path.join(fakeBin, "gh"), 0o755);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    const validationProgram = `require("node:fs").appendFileSync(${JSON.stringify(validationCounter)}, "x")`;
    const validationCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(validationProgram)} && test -f feature.txt`;
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: "",
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const firstState = readPersistedState(root);
    assert.equal(first.projects[0].status, "pr_failed", first.projects[0].output);
    assert.equal(firstState.tasks[0].status, "promotion_blocked");
    assert.equal(firstState.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(firstState.tasks[0].promotionValidationAttempts, 1);
    assert.equal(firstState.tasks[0].promotionRetryAuthorization, null);
    assert.ok(firstState.candidates[0].promotionValidationRecoveryReceipt.validationEvidence.digest);
    assert.equal(planPromotions(firstState).projects[0].mode, "create");
    assert.equal(await readFile(validationCounter, "utf8"), "x");

    const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const secondState = readPersistedState(root);
    assert.equal(second.projects[0].status, "pr_ready", second.projects[0].output);
    assert.equal(secondState.tasks[0].status, "user_review");
    assert.equal(secondState.candidates[0].status, "release_candidate_ready");
    assert.equal(await readFile(validationCounter, "utf8"), "x", "validation must not rerun after verified receipt recovery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion never treats a closed exact pull request as release-ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-closed-pr-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const unexpectedCreate = path.join(root, "unexpected-create");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    const promotionBranch = `qa/promotion-demo-${candidate.manifestDigest.replace(/^sha256:/, "").slice(0, 16)}`;
    const closedPr = JSON.stringify([{
      url: "https://github.com/example/demo/pull/41",
      state: "CLOSED",
      headRefName: promotionBranch,
      headRefOid: sourceSha,
    }]);
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' ${JSON.stringify(closedPr)}
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  touch ${JSON.stringify(unexpectedCreate)}
  exit 9
fi
exit 9
`, "utf8");
    await chmod(path.join(fakeBin, "gh"), 0o755);
    await writeState(root, baseState({
      projects: [{
        id: "project_1", key: "demo", name: "Demo", repoPath, repoUrl: "", defaultBranch: "main",
        validationCommands: ["test -f feature.txt"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1", projectId: "project_1", title: "Feature task", status: "approved_for_main",
        stateVersion: 1, branchName: "feature/task", promotionStatus: "queued",
        reviewSubjectSha: sourceSha, reviewSubjectCycle: 1, qaBundleId: "qa_bundle_1", candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1", projectId: "project_1", status: "passed", candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest, tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const state = readPersistedState(root);
    assert.equal(report.projects[0].status, "pr_closed");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/41");
    assert.equal(state.tasks[0].status, "promotion_blocked");
    assert.equal(state.tasks[0].assignedAgentRole, "owner");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(planPromotions(state).projects.length, 0);
    await assert.rejects(() => stat(unexpectedCreate), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion records complete private failure evidence and exhausts one bounded exact-candidate retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-bounded-retry-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const secret = "promotion-output-secret-value";
    const secretPath = path.join(root, "validation-secret.txt");
    await writeFile(secretPath, secret, "utf8");
    const validationProgram = [
      `const { readFileSync } = require("node:fs")`,
      'console.log("HEAD-SENTINEL")',
      `console.log("${"x".repeat(5_000)}")`,
      'console.log("MIDDLE-SENTINEL")',
      `console.log("password=" + readFileSync(${JSON.stringify(secretPath)}, "utf8"))`,
      'console.error("TAIL-SENTINEL")',
      "process.exit(7)",
    ].join(";");
    const validationCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(validationProgram)}`;
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const runScript = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `;
    const firstRun = await run(process.execPath, ["--input-type=module", "-e", runScript], { cwd: root });
    const firstReport = JSON.parse(firstRun.stdout.trim());
    const firstState = readPersistedState(root);
    const evidence = firstState.tasks[0].promotionValidation.evidence;
    const evidenceText = await readFile(evidence.path, "utf8");
    const evidenceInfo = await stat(evidence.path);

    assert.equal(firstReport.projects[0].status, "validation_failed");
    assert.equal(firstState.tasks[0].status, "approved_for_main");
    assert.equal(firstState.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(firstState.tasks[0].promotionValidationAttempts, 1);
    assert.equal(firstState.tasks[0].promotionRetryAuthorization.firstEvidenceDigest, evidence.digest);
    assert.equal(firstState.candidates[0].status, "qa_passed");
    assert.equal(evidenceInfo.mode & 0o777, 0o600);
    assert.match(evidenceText, /HEAD-SENTINEL/);
    assert.match(evidenceText, /MIDDLE-SENTINEL/);
    assert.match(evidenceText, /TAIL-SENTINEL/);
    assert.equal(evidenceText.includes(secret), false);
    assert.equal(JSON.stringify(firstReport).includes(secret), false);
    assert.equal(JSON.stringify(firstState.tasks[0].promotionValidation).includes(secret), false);
    assert.equal(planPromotions(firstState).projects[0].mode, "retry");

    const secondRun = await run(process.execPath, ["--input-type=module", "-e", runScript], { cwd: root });
    const secondReport = JSON.parse(secondRun.stdout.trim());
    const secondState = readPersistedState(root);
    assert.equal(secondReport.projects[0].mode, "retry");
    assert.equal(secondReport.projects[0].status, "validation_failed");
    assert.equal(secondState.tasks[0].promotionValidationAttempts, 2);
    assert.equal(secondState.tasks[0].status, "needs_changes");
    assert.equal(secondState.tasks[0].assignedAgentRole, "builder");
    assert.equal(planPromotions(secondState).projects.length, 0);
    assert.equal(await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion discards a stale claimed result before push when task state changes during validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-claim-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const validationCommand = "test -f feature.txt";
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        beforePromotionPush: async () => {
          await mutateState((state) => {
            state.tasks[0].status = "needs_changes";
            state.tasks[0].assignedAgentRole = "builder";
          });
        }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "stale_result_discarded", JSON.stringify(report.projects[0]));
    assert.match(report.projects[0].output, /without overwriting newer state/);
    assert.equal(state.tasks[0].status, "needs_changes");
    assert.equal(state.tasks[0].assignedAgentRole, "builder");
    assert.equal(state.tasks[0].promotionStatus, "queued");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion closes an exact external PR when the fenced claim becomes stale during creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-stale-pr-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const closedMarker = path.join(root, "stale-pr-closed");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    await writeState(root, baseState({
      projects: [{
        id: "project_1", key: "demo", name: "Demo", repoPath, repoUrl: "", defaultBranch: "main",
        validationCommands: ["test -f feature.txt"], promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1", projectId: "project_1", title: "Feature task", status: "approved_for_main",
        stateVersion: 1, branchName: "feature/task", promotionStatus: "queued",
        reviewSubjectSha: sourceSha, reviewSubjectCycle: 1, qaBundleId: "qa_bundle_1", candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1", projectId: "project_1", status: "passed", candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest, tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));
    const mutationPath = path.join(root, "invalidate-claim.mjs");
    await writeFile(mutationPath, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.tasks[0].status = "needs_changes";
        state.tasks[0].assignedAgentRole = "builder";
      });
    `, "utf8");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(mutationPath)}
  echo 'https://github.com/example/demo/pull/42'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "close" ]; then
  touch ${JSON.stringify(closedMarker)}
  echo 'closed'
  exit 0
fi
exit 9
`, "utf8");
    await chmod(path.join(fakeBin, "gh"), 0o755);

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const state = readPersistedState(root);
    assert.equal(report.projects[0].status, "stale_result_discarded");
    assert.equal(report.projects[0].stalePromotionPrCleanup.attempted, true);
    assert.equal(report.projects[0].stalePromotionPrCleanup.closed, true);
    assert.equal(state.tasks[0].status, "needs_changes");
    assert.equal(state.tasks[0].assignedAgentRole, "builder");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.ok(await stat(closedMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion reconciliation records an exact merged candidate once", async () => {
  const fixture = await reconciliationFixture("MERGED");
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        env: { PATH: ${JSON.stringify(`${fixture.fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(fixture.root);

    assert.equal(report.projects[0].status, "merged");
    assert.equal(state.tasks[0].status, "merged");
    assert.equal(state.tasks[0].promotionStatus, "merged");
    assert.equal(state.tasks[0].mergeEvidence.integrationSha, fixture.sourceSha);
    assert.equal(state.tasks[0].mergeEvidence.mergeCommit, fixture.mergeCommit);
    assert.equal(state.qaBundles[0].status, "merged");
    assert.equal(state.candidates[0].status, "merged");
    assert.equal(state.events.filter((event) => event.type === "release_candidate_merged").length, 1);

    const second = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    assert.equal(JSON.parse(second.stdout.trim()).projects.length, 0);
    assert.equal(readPersistedState(fixture.root).comments.length, state.comments.length);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation preserves a deployed task while backfilling exact merge evidence once", async () => {
  const fixture = await reconciliationFixture("MERGED");
  try {
    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
    state.tasks[0].status = "deployed";
    state.tasks[0].deploymentEvidence = {
      id: `deployment:${fixture.candidate.id}:task_1`,
      candidateId: fixture.candidate.id,
      subjectSha: fixture.sourceSha,
      recordedAt: "2026-07-25T13:05:00.000Z",
    };
    await writeState(fixture.root, state);
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        env: { PATH: ${JSON.stringify(`${fixture.fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;

    const first = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    const report = JSON.parse(first.stdout.trim());
    let persisted = readPersistedState(fixture.root);
    assert.equal(report.projects[0].status, "merged");
    assert.equal(persisted.tasks[0].status, "deployed");
    assert.equal(persisted.tasks[0].mergeEvidence.candidateId, fixture.candidate.id);
    assert.equal(persisted.tasks[0].mergeEvidence.subjectSha, fixture.sourceSha);
    assert.equal(persisted.tasks[0].mergeEvidence.mergeCommit, fixture.mergeCommit);
    assert.equal(persisted.candidates[0].status, "merged");

    const second = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    assert.equal(JSON.parse(second.stdout.trim()).projects.length, 0);
    persisted = readPersistedState(fixture.root);
    assert.equal(persisted.events.filter((event) => event.type === "release_candidate_merged").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation closes a superseded candidate when a trusted merged candidate contains it", async () => {
  const fixture = await reconciliationFixture("CLOSED");
  try {
    await git(fixture.repoPath, ["checkout", "-b", "feature/replacement", fixture.sourceSha]);
    await writeFile(path.join(fixture.repoPath, "replacement.txt"), "replacement\n", "utf8");
    await git(fixture.repoPath, ["add", "replacement.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "replacement candidate"]);
    const replacementSha = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/replacement"]);
    await git(fixture.repoPath, ["push", "origin", "HEAD:qa/candidate-replacement"]);
    await git(fixture.repoPath, ["checkout", "main"]);
    await git(fixture.repoPath, ["merge", "--no-ff", replacementSha, "-m", "merge replacement candidate"]);
    const replacementMerge = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "main"]);

    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
    const replacement = mergedCandidateFixture({
      baseSha: fixture.candidate.manifest.base.sha,
      sourceSha: replacementSha,
      integrationSha: replacementSha,
      mergeCommit: replacementMerge,
      prUrl: "https://github.com/example/demo/pull/43",
    });
    state.tasks.push({
      id: "task_2",
      projectId: "project_1",
      title: "Replacement task",
      status: "merged",
      stateVersion: 2,
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: replacementSha,
    });
    state.candidates.push(replacement);
    await writeState(fixture.root, state);

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        env: { PATH: ${JSON.stringify(`${fixture.fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const persisted = readPersistedState(fixture.root);

    assert.equal(first.projects[0].status, "merged");
    assert.equal(first.projects[0].reconciledByCandidateId, replacement.id);
    assert.equal(persisted.tasks[0].status, "merged");
    assert.equal(persisted.tasks[0].mergeEvidence.subjectSha, fixture.sourceSha);
    assert.equal(persisted.tasks[0].mergeEvidence.reconciledByCandidateId, replacement.id);
    assert.equal(persisted.tasks[0].mergeEvidence.mergeCommit, replacementMerge);
    assert.equal(persisted.candidates[0].promotionMerge.reconciledByCandidateId, replacement.id);

    const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    assert.equal(second.projects.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation leaves open PRs stable without duplicate evidence", async () => {
  const fixture = await reconciliationFixture("OPEN");
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        env: { PATH: ${JSON.stringify(`${fixture.fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const state = readPersistedState(fixture.root);

    assert.equal(first.projects[0].status, "pending");
    assert.equal(second.projects[0].status, "pending");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.comments.length, 0);
    assert.equal(state.events.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation bounds closed and drifted PRs without restarting review", async (t) => {
  for (const scenario of [
    { name: "closed", state: "CLOSED", overrides: {}, expected: "promotion_closed" },
    { name: "target mismatch", state: "OPEN", overrides: { baseRefName: "release" }, expected: "promotion_invalid" },
    { name: "head mismatch", state: "OPEN", overrides: { headRefOid: "f".repeat(40) }, expected: "promotion_invalid" },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await reconciliationFixture(scenario.state, scenario.overrides);
      try {
        const script = `
          import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
          const report = await runPromotion({
            githubAppAuth: false,
            env: { PATH: ${JSON.stringify(`${fixture.fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
          });
          console.log(JSON.stringify(report));
        `;
        const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
        const state = readPersistedState(fixture.root);
        assert.equal(report.projects[0].status, scenario.expected);
        assert.equal(state.tasks[0].status, "promotion_blocked");
        assert.equal(state.tasks[0].reviewCycle, 1);
        assert.equal(state.comments.length, 1);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("promotion rechecks and invalidates a source ref that drifts during validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "reviewed feature"]);
    const reviewedSourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const candidate = candidateFixture({
      baseSha,
      sourceSha: reviewedSourceSha,
      integrationSha: reviewedSourceSha,
      status: "qa_passed",
    });
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        defaultBranch: "main",
        validationCommands: [
          `git --git-dir=${JSON.stringify(remotePath)} update-ref refs/heads/feature/task ${baseSha}`,
          "test -f feature.txt",
        ],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
        reviewSubjectSha: reviewedSourceSha,
        reviewSubjectCycle: 1,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const movedSourceSha = baseSha;

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "blocked");
    assert.match(report.projects[0].output, /source ref drift/);
    assert.equal(report.projects[0].candidateInvalidation.expected, reviewedSourceSha);
    assert.equal(report.projects[0].candidateInvalidation.observed, movedSourceSha);
    assert.equal(state.candidates[0].status, "invalidated");
    assert.equal(state.candidates[0].invalidation.expected, reviewedSourceSha);
    assert.equal(state.candidates[0].invalidation.observed, movedSourceSha);
    assert.equal(state.qaBundles[0].status, "invalidated");
    assert.equal(
      await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion invalidates the candidate when its staged integration branch drifts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-candidate-branch-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "reviewed feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        defaultBranch: "main",
        validationCommands: ["test -f feature.txt"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    await git(repoPath, ["checkout", "qa/candidate-demo"]);
    await writeFile(path.join(repoPath, "unreviewed.txt"), "must not promote\n", "utf8");
    await git(repoPath, ["add", "unreviewed.txt"]);
    await git(repoPath, ["commit", "-m", "move staged candidate"]);
    const movedCandidateSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "blocked");
    assert.match(report.projects[0].output, /Candidate integration ref drift/);
    assert.equal(report.projects[0].candidateInvalidation.expected, sourceSha);
    assert.equal(report.projects[0].candidateInvalidation.observed, movedCandidateSha);
    assert.equal(state.candidates[0].status, "invalidated");
    assert.equal(state.qaBundles[0].status, "invalidated");
    assert.equal(
      await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
