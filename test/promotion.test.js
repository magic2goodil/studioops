import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { planPromotions } from "../src/promotion.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const promotionModuleUrl = pathToFileURL(path.join(process.cwd(), "src/promotion.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

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
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task" }],
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

test("promotion creates a validated release-candidate PR without updating main", async () => {
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
    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: ["test -f feature.txt"],
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
          branchName: "feature/task",
          prUrl: "",
          promotionStatus: "queued",
          qaBundleId: "qa_bundle_1",
          candidateId: candidate.id,
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
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "pr_ready", report.projects[0].output);
    assert.equal(report.projects[0].tasks[0].status, "pr_ready");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.tasks[0].promotionStatus, "pr_ready");
    assert.equal(state.tasks[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.qaBundles[0].status, "release_candidate_ready");
    assert.equal(state.qaBundles[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.candidates[0].status, "release_candidate_ready");
    assert.equal(state.candidates[0].promotion.commitSha, sourceSha);
    assert.ok(report.projects[0].promotionBranch);
    assert.ok(await git(root, ["--git-dir", remotePath, "rev-parse", `refs/heads/${report.projects[0].promotionBranch}`]));
    await assert.rejects(() => git(root, ["--git-dir", remotePath, "show", "refs/heads/main:feature.txt"]));
    assert.equal(state.events.some((event) => event.type === "release_candidate_ready"), true);
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
        branchName: "feature/task",
        promotionStatus: "queued",
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
        branchName: "feature/task",
        promotionStatus: "queued",
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
