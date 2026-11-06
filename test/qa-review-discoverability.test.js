import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const run = promisify(execFile);
const qaReviewEnvironment = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
Object.assign(process.env, qaReviewEnvironment.env);
test.after(async () => qaReviewEnvironment.cleanup());
const OUTER_VALIDATION_SANDBOX = Boolean(process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX);

const { writeState, readState, addProject, addTask, updateTask, updateRun, recordReview } = await import(`../src/store.js?qa-review-discoverability=${Date.now()}`);
const { createStudioOpsServer } = await import(`../src/server.js?qa-review-discoverability=${Date.now()}`);
const { buildQaReviewList } = await import(`../src/qa-review-list.js?qa-review-discoverability=${Date.now()}`);

const { dispatchSupervisorActions } = await import("../src/dispatcher.js");
const REPOSITORY_URL = "https://github.com/example/demo";

async function nativeQaFixture(options) {
  const root = await mkdtemp(path.join(options.tempParent || os.tmpdir(), "qa-auth-candidate-"));
  options.testContext.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const key = options.projectKey || `qa-auth-${path.basename(root).toLowerCase()}`;
  const repository = options.repoUrl || REPOSITORY_URL;
  git("init", "-b", "main");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", repository);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await mkdir(path.join(root, "docs/architecture"), { recursive: true });
  await writeFile(path.join(root, "src/catalog.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "test/catalog.test.js"), 'import assert from "node:assert/strict";\nimport { version } from "../src/catalog.js";\nassert.ok(Number.isSafeInteger(version) && version > 0);\n');
  await writeFile(path.join(root, "docs/architecture/components.json"), JSON.stringify({
    schemaVersion: 1, project: { key, repository }, aggregateCommand: "node --test",
    components: { catalog: {
      owner: "fixture-engineering", paths: ["src/catalog.js", "test/catalog.test.js"],
      publicContracts: ["catalog value"], services: ["catalog module"], dependsOn: [],
      tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }],
      reviewOwners: ["backend-reviewer", "lead-reviewer"], rollback: "Restore the prior fixture commit.",
    } },
  }));
  git("add", ".");
  git("commit", "-m", "Generic QA candidate base");
  const baseSha = git("rev-parse", "HEAD");
  const nativeProject = await addProject({
    key, name: options.projectName || "Demo", workflowMode: "github", defaultBranch: "main",
    repoPath: root, sourceRepoPath: root, repoUrl: repository,
    reviewPipeline: [
      { key: "backend", label: "Backend Review", role: "backend-reviewer", status: "backend_review", required: true },
      { key: "lead", label: "Primary Lead Review", role: "lead-reviewer", status: "lead_review", required: true },
    ],
  });
  const taskIds = [];
  const branches = [];
  for (let index = 0; index < Number(options.taskCount || 1); index += 1) {
    const branch = `feature/task-${index + 1}`;
    branches.push(branch);
    git("branch", branch, baseSha);
    const task = await addTask({
      project: nativeProject.id, title: options.taskTitle || "Exact owner QA", type: "bug", status: "ready", architectureRequired: false,
      description: "Review a real candidate under native frozen edit authority.",
      userStory: "As an owner I need exact QA decisions and immutable audit evidence.",
      expectedOutcome: "QA authority remains bound to the exact candidate.",
      acceptanceCriteria: ["Candidate QA decisions remain immutable."], workAreas: ["src/catalog.js"], branchName: branch,
      candidateIdentity: { baseSha },
      affectedSurfaces: ["src/catalog.js"], validationPlan: ["node --test test/catalog.test.js"], riskClassification: "low",
      privacyNotes: "Generic synthetic source only; no personal data.", securityNotes: "No external executor or network request is used.",
    });
    // Native dispatch freezes the scope. Cancel before any executor starts.
    const dispatch = await dispatchSupervisorActions([{
      id: `${task.id}:start_builder`, type: "start_builder", role: "builder", taskId: task.id,
      projectId: nativeProject.id, taskStatus: "ready", nextStatus: "in_progress",
    }], { failureIncidents: [], creditPolicy: { enabled: false } });
    assert.equal(dispatch.runs.length, 1, JSON.stringify(dispatch.skipped));
    await updateRun(dispatch.runs[0].id, {
      status: "cancelled", completedAt: new Date().toISOString(), notes: "Fixture cancelled before executor launch.",
    });
    await updateTask(task.id, { status: "in_progress" });
    taskIds.push(task.id);
  }
  git("checkout", branches[0]);
  await writeFile(path.join(root, "src/catalog.js"), "export const version = 2;\n");
  git("add", "src/catalog.js");
  git("commit", "-m", "Generic exact QA source");
  const sourceSha = git("rev-parse", "HEAD");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const impactEvidence = { changedFiles: ["src/catalog.js"], unknown: false, backendRequired: true };
  for (const [index, taskId] of taskIds.entries()) {
    git("checkout", branches[index]);
    git("merge", "--ff-only", sourceSha);
    await updateTask(taskId, {
      status: "builder_review", subjectSha: sourceSha, branchName: branches[index],
      prUrl: `${REPOSITORY_URL}/pull/${index + 1}`,
      candidateIdentity: { commitSha: sourceSha, treeSha, baseSha, branch: branches[index], candidateCycle: 1 }, impactEvidence,
    });
    for (const stage of nativeProject.reviewPipeline.filter((item) => item.required)) {
      await recordReview(taskId, {
        stage: stage.key, outcome: "approved", subjectSha: sourceSha, candidateCycle: 1,
        author: "Fixture Reviewer", body: "Reviewed the exact generic fixture commit.",
      });
    }
  }
  git("branch", "qa/demo", sourceSha);
  const validationEnv = { ...process.env };
  delete validationEnv.NODE_TEST_CONTEXT;
  const validationOutput = execFileSync(process.execPath, ["--test", "test/catalog.test.js"], {
    cwd: root, env: validationEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(validationOutput.toString(), /# pass 1\b/);
  const frozen = await readState();
  const nativeTasks = taskIds.map((id) => frozen.tasks.find((task) => task.id === id));
  for (const task of nativeTasks) {
    assert.equal(task.impactScopePlan.status, "mapped");
    assert.equal(task.impactScopePlan.sourceCommit, baseSha);
    assert.equal(task.reviewSubjectSha, sourceSha);
  }
  return {
    nativeProject, nativeTasks, nativeState: frozen, baseSha, sourceSha, integrationSha: sourceSha,
    nativeReviews: frozen.reviews.filter((review) => taskIds.includes(review.taskId)),
    validationEvidenceDigest: `sha256:${createHash("sha256").update(validationOutput).digest("hex")}`,
    handoff: async (index) => {
      git("checkout", branches[index]);
      await writeFile(path.join(root, "src/catalog.js"), `export const version = ${index + 3};\n`);
      git("add", "src/catalog.js");
      git("commit", "-m", `Generic sibling ${index + 1} remediation`);
      const commitSha = git("rev-parse", "HEAD");
      return {
        status: "builder_review", subjectSha: commitSha, branchName: branches[index],
        candidateIdentity: { commitSha, treeSha: git("rev-parse", "HEAD^{tree}"), baseSha, branch: branches[index], candidateCycle: 2 },
        impactEvidence,
      };
    },
  };
}

const BASE_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);

function fixtureState(options = {}) {
  const native = options.native;
  const baseSha = native?.baseSha || BASE_SHA;
  const sourceSha = native?.sourceSha || SOURCE_SHA;
  const integrationSha = native?.integrationSha || INTEGRATION_SHA;
  const candidateStatus = options.candidateStatus || "frozen";
  const taskIds = options.taskIds || native?.nativeTasks.map((task) => task.id) || ["task_1"];
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: baseSha },
      sources: taskIds.map((taskId, index) => ({
        taskId,
        sourceRef: `refs/heads/${native ? native.nativeTasks[index].branchName : `feature/${taskId}`}`,
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: native ? native.nativeReviews.filter((review) => review.taskId === taskId) : [{
          id: `review_${index + 1}`,
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-09-03T12:00:00.000Z",
        }],
      })),
      integration: { branch: "qa/demo", sha: integrationSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: native ? "node --test test/catalog.test.js" : "npm test",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: native?.validationEvidenceDigest || `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4393/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: { kind: "json", key: "commitSha", observedSha: integrationSha },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: taskIds,
        includedTaskIds: taskIds,
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-09-03T12:05:00.000Z",
  });
  candidate.status = candidateStatus;
  candidate.updatedAt = "2026-09-03T12:05:00.000Z";
  if (candidateStatus === "release_candidate_ready") {
    candidate.promotion = {
      branch: "qa/promotion-demo",
      prUrl: "https://github.com/example/demo/pull/42",
      commitSha: integrationSha,
      manifestDigest: candidate.manifestDigest,
      readyAt: "2026-09-03T12:15:00.000Z",
    };
  }
  const taskStatus = candidateStatus === "release_candidate_ready"
    ? "user_review"
    : candidateStatus === "qa_passed" ? "approved_for_main" : "qa_review";
  const assignedAgentRole = candidateStatus === "qa_passed"
    ? "promotion-worker"
    : "owner";
  const bundleStatus = candidateStatus === "release_candidate_ready"
    ? "release_candidate_ready"
    : candidateStatus === "qa_passed" ? "passed" : "ready";
  const state = {
    meta: native?.nativeState.meta || {},
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/private/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      workflowMode: "github",
      ...native?.nativeProject,
    }],
    tasks: taskIds.map((taskId, index) => ({
      ...native?.nativeTasks[index],
      id: taskId,
      projectId: "project_1",
      title: native?.nativeTasks[index].title || "Discover exact owner QA coordinates",
      status: taskStatus,
      assignedAgentRole,
      stateVersion: native?.nativeTasks[index].stateVersion || options.stateVersion || 7,
      reviewSubjectSha: sourceSha,
      reviewSubjectCycle: 1,
      integrationStatus: "ready",
      integrationBranch: "qa/demo",
      integrationCommit: integrationSha,
      candidateManifestDigest: candidate.manifestDigest,
      candidateId: candidate.id,
      qaBundleId: "qa_bundle_1",
    })),
    comments: native?.nativeState.comments || [],
    events: native?.nativeState.events || [],
    reviews: native?.nativeState.reviews || [],
    runs: native?.nativeState.runs || [],
    qaBundles: [{
      id: "qa_bundle_1",
      projectId: "project_1",
      projectKey: "demo",
      projectName: "Demo",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationBranch: "qa/demo",
      integrationCommit: integrationSha,
      previewUrl: "http://127.0.0.1:4393/",
      status: bundleStatus,
      ...(candidateStatus === "release_candidate_ready" ? {
        promotionPrUrl: candidate.promotion.prUrl,
        promotionBranch: candidate.promotion.branch,
        promotionCommit: candidate.promotion.commitSha,
        promotedTaskIds: taskIds,
      } : {}),
      updatedAt: "2026-09-03T12:05:00.000Z",
      tasks: taskIds.map((taskId, index) => ({
        id: taskId,
        title: native?.nativeTasks[index].title || "Discover exact owner QA coordinates",
      })),
    }],
    candidates: [candidate],
  };
  const bundle = state.qaBundles[0];
  candidate.qaPacket = buildOwnerQaPacket(state, candidate, {
    bundle,
    generatedAt: "2026-09-03T12:05:00.000Z",
  });
  bundle.qaPacket = candidate.qaPacket;
  bundle.packetDigest = candidate.qaPacket.packetDigest;
  if (["qa_passed", "release_candidate_ready"].includes(candidateStatus)) {
    candidate.qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: integrationSha,
      ownerQaPacketDigest: candidate.qaPacket.packetDigest,
      taskIds,
      repositoryVerifiedAt: "2026-09-03T12:06:00.000Z",
      author: "Owner QA",
      notes: "Initially passed.",
      decidedAt: "2026-09-03T12:06:00.000Z",
    };
    bundle.qaDecision = structuredClone(candidate.qaDecision);
    for (const task of state.tasks) task.qaDecision = structuredClone(candidate.qaDecision);
  }
  return state;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

function assertCoordinates(item, candidate) {
  assert.equal(item.actionable, true);
  assert.equal(item.candidateId, candidate.id);
  assert.equal(item.manifestDigest, candidate.manifestDigest);
  assert.equal(item.integrationSha, candidate.manifest.integration.sha);
  assert.equal(item.ownerQaPacketDigest, candidate.qaPacket.packetDigest);
}

function bootstrapLifecycleFixture(state) {
  const initial = structuredClone(state);
  const candidate = initial.candidates[0];
  const sourceTaskIds = new Set(candidate.manifest.sources.map((source) => source.taskId));
  candidate.status = "frozen";
  delete candidate.qaDecision;
  delete candidate.promotion;
  delete candidate.promotionMerge;
  delete candidate.promotionValidationRecoveryReceipt;

  for (const task of initial.tasks.filter((item) => sourceTaskIds.has(item.id))) {
    task.status = "qa_review";
    task.assignedAgentRole = "owner";
    delete task.qaDecision;
    delete task.promotionStatus;
    delete task.promotionPrUrl;
    delete task.promotionBranch;
    delete task.promotionCommit;
  }

  const bundle = initial.qaBundles.find((item) => item.id === candidate.qaBundleId);
  bundle.status = "ready";
  delete bundle.qaDecision;
  delete bundle.promotionPrUrl;
  delete bundle.promotionBranch;
  delete bundle.promotionCommit;
  delete bundle.promotedTaskIds;
  delete bundle.promotionReadyAt;
  delete bundle.promotionMergedAt;
  delete bundle.promotionMergeCommit;
  return initial;
}

async function reviewListsFromFreshLifecycleFixture(options) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "qa-review-child-"));
  const isolated = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
  try {
    const script = `
      import { execFile, execFileSync } from "node:child_process";
      import { createHash } from "node:crypto";
      import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import { promisify } from "node:util";
      import { readState, writeState, addProject, addTask, updateTask, updateRun, recordReview } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
      import {
        mutateCandidatePromotionState,
        mutateCandidateQaDecisionState,
        mutatePromotionAttemptClaimState,
      } from ${JSON.stringify(new URL("../src/state-database.js", import.meta.url).href)};
      import {
        claimPromotionAttemptInState,
        promotionProjectPolicyBinding,
        terminalPromotionAttemptClaimInState,
      } from ${JSON.stringify(new URL("../src/promotion-attempt-claim.js", import.meta.url).href)};
      import { createCandidateRepositoryTestVerificationObservation } from ${JSON.stringify(new URL("../src/candidate-repository.js", import.meta.url).href)};
      import { createPromotionRemoteTestObservation } from ${JSON.stringify(new URL("./support/promotion-authority-harness.js", import.meta.url).href)};
      import { createStudioOpsServer } from ${JSON.stringify(new URL("../src/server.js", import.meta.url).href)};
      const run = promisify(execFile);
      const { dispatchSupervisorActions } = await import(${JSON.stringify(new URL("../src/dispatcher.js", import.meta.url).href)});
      const { createCandidateEnvelope } = await import(${JSON.stringify(new URL("../src/candidate-manifest.js", import.meta.url).href)});
      const { buildOwnerQaPacket } = await import(${JSON.stringify(new URL("../src/owner-qa-packet.js", import.meta.url).href)});
      const REPOSITORY_URL = "https://github.com/example/demo";
      const BASE_SHA = "a".repeat(40), SOURCE_SHA = "b".repeat(40), INTEGRATION_SHA = "c".repeat(40);
      ${nativeQaFixture.toString()}
      ${fixtureState.toString()}
      ${bootstrapLifecycleFixture.toString()}
      const native = await nativeQaFixture({ testContext: {after() {}}, projectKey: "demo", tempParent: ${JSON.stringify(fixtureRoot)} });
      const desiredState = fixtureState({ ...${JSON.stringify(options)}, native });
      const desiredCandidate = desiredState.candidates[0];
      const desiredStatus = desiredCandidate.status;
      await writeState(bootstrapLifecycleFixture(desiredState));

      if (desiredStatus !== "frozen") {
        let snapshot = await readState();
        let candidate = snapshot.candidates.find((item) => item.id === desiredCandidate.id);
        const project = snapshot.projects.find((item) => item.id === candidate.projectId);
        const verification = createCandidateRepositoryTestVerificationObservation(project, candidate, {
          ok: true,
          status: "verified",
          verifiedAt: desiredCandidate.qaDecision.repositoryVerifiedAt,
        });
        await mutateCandidateQaDecisionState(candidate.id, verification, (next) => {
          const currentCandidate = next.candidates.find((item) => item.id === candidate.id);
          const decision = structuredClone(desiredCandidate.qaDecision);
          currentCandidate.qaDecision = decision;
          currentCandidate.status = "qa_passed";
          currentCandidate.updatedAt = decision.decidedAt;
          const bundle = next.qaBundles.find((item) => item.id === currentCandidate.qaBundleId);
          bundle.status = "passed";
          bundle.qaDecision = structuredClone(decision);
          bundle.updatedAt = decision.decidedAt;
          for (const source of currentCandidate.manifest.sources) {
            const task = next.tasks.find((item) => item.id === source.taskId);
            task.status = "approved_for_main";
            task.assignedAgentRole = "promotion-worker";
            task.qaDecision = structuredClone(decision);
            task.updatedAt = decision.decidedAt;
          }
        }, { operationName: "test.qa_review_discoverability.grant_qa" });
      }

      if (desiredStatus === "release_candidate_ready") {
        const policyDigest = "sha256:${"e".repeat(64)}";
        let snapshot = await readState();
        let candidate = snapshot.candidates.find((item) => item.id === desiredCandidate.id);
        let project = snapshot.projects.find((item) => item.id === candidate.projectId);
        const acquired = await mutatePromotionAttemptClaimState(candidate.id, (next) => (
          claimPromotionAttemptInState(next, {
            projectId: project.id,
            candidateId: candidate.id,
            mode: "create",
            policyDigest,
            projectPolicy: promotionProjectPolicyBinding(project),
            nowMs: Date.now(),
            ttlMs: 60 * 60 * 1_000,
            claimIdFactory: () => "claim_qa_review_discoverability",
          })
        ), { operationName: "test.qa_review_discoverability.claim_promotion" });
        if (!acquired.acquired) throw new Error("Expected promotion fixture claim to be acquired.");

        snapshot = await readState();
        candidate = snapshot.candidates.find((item) => item.id === desiredCandidate.id);
        project = snapshot.projects.find((item) => item.id === candidate.projectId);
        const claim = acquired.claim;
        const promotion = structuredClone(desiredCandidate.promotion);
        const repository = new URL(project.repoUrl).pathname.split("/").filter(Boolean).join("/");
        const promotionRemoteObservation = createPromotionRemoteTestObservation({
          projectId: project.id,
          repoUrl: project.repoUrl,
          targetBranch: candidate.manifest.base.branch,
          promotionBranch: promotion.branch,
          headSha: candidate.manifest.integration.sha,
          candidate,
          subjectCandidate: candidate,
          claim,
        }, {
          number: Number(new URL(promotion.prUrl).pathname.split("/").at(-1)),
          url: promotion.prUrl,
          state: "OPEN",
          mergedAt: "",
          mergeCommit: "",
          baseRefName: candidate.manifest.base.branch,
          headRefName: promotion.branch,
          headRefOid: candidate.manifest.integration.sha,
          headRepository: { nameWithOwner: repository },
          body: [
            "<!-- studioops-candidate:" + candidate.id + ":" + candidate.manifestDigest + " -->",
            "<!-- studioops-claim:" + claim.claimId + ":" + claim.fence + " -->",
          ].join("\\n"),
        }, { nowMs: Date.now() });
        const terminalAtMs = Date.now();
        await mutateCandidatePromotionState(candidate.id, claim, (next) => {
          const currentProject = next.projects.find((item) => item.id === project.id);
          const terminalClaim = terminalPromotionAttemptClaimInState(next, claim, {
            projectId: currentProject.id,
            candidateId: candidate.id,
            mode: "create",
            policyDigest,
            projectPolicy: promotionProjectPolicyBinding(currentProject),
            nowMs: terminalAtMs,
            outcome: "pr_ready",
          });
          const currentCandidate = next.candidates.find((item) => item.id === candidate.id);
          const taskIds = currentCandidate.manifest.sources.map((source) => source.taskId);
          currentCandidate.status = "release_candidate_ready";
          currentCandidate.promotion = structuredClone(promotion);
          currentCandidate.updatedAt = promotion.readyAt;
          const bundle = next.qaBundles.find((item) => item.id === currentCandidate.qaBundleId);
          Object.assign(bundle, {
            status: "release_candidate_ready",
            promotionPrUrl: promotion.prUrl,
            promotionBranch: promotion.branch,
            promotionCommit: promotion.commitSha,
            promotedTaskIds: taskIds,
            promotionReadyAt: promotion.readyAt,
            updatedAt: promotion.readyAt,
          });
          for (const taskId of taskIds) {
            const task = next.tasks.find((item) => item.id === taskId);
            Object.assign(task, {
              status: "user_review",
              assignedAgentRole: "owner",
              promotionStatus: "pr_ready",
              promotionPrUrl: promotion.prUrl,
              promotionBranch: promotion.branch,
              promotionCommit: promotion.commitSha,
              updatedAt: promotion.readyAt,
            });
          }
          return terminalClaim;
        }, {
          operationName: "test.qa_review_discoverability.grant_promotion",
          promotionRemoteObservation,
        });
      }

      const server = createStudioOpsServer({ host: "127.0.0.1", port: 0 });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      let result;
      try {
        const address = server.address();
        const response = await fetch(\`http://127.0.0.1:\${address.port}/api/qa/review-list?project=demo\`);
        const apiReviewList = await response.json();
        const cliResult = await run(process.execPath, [
          ${JSON.stringify(path.resolve("src/mission-control-cli.js"))},
          "qa-list",
          "--project",
          "demo",
          "--json",
        ], { cwd: ${JSON.stringify(process.cwd())}, env: process.env });
        result = {
          candidate: desiredCandidate,
          apiStatus: response.status,
          apiReviewList,
          cliReviewList: JSON.parse(cliResult.stdout),
        };
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      console.log(JSON.stringify(result));
    `;
    const result = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: isolated.env,
    });
    return JSON.parse(result.stdout);
  } finally {
    await isolated.cleanup();
    await rm(fixtureRoot, {recursive: true, force: true});
  }
}

test("owner QA review discovery returns exact canonical task and bundle coordinates", {
  skip: OUTER_VALIDATION_SANDBOX
    ? "The outer release sandbox intentionally prohibits every loopback listener; this API/CLI parity suite runs in builder validation."
    : false,
}, async (t) => {
  const native = await nativeQaFixture({ testContext: t, projectKey: "demo" });
  const state = fixtureState({ native });
  await writeState(state);
  const candidate = state.candidates[0];

  const server = createStudioOpsServer({ host: "127.0.0.1", port: 0 });
  const origin = await listen(server);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const response = await fetch(`${origin}/api/qa/review-list?project=demo`);
  assert.equal(response.status, 200);
  const reviewList = await response.json();
  assert.equal(reviewList.tasks.length, 1);
  assert.equal(reviewList.bundles.length, 1);
  assertCoordinates(reviewList.tasks[0], candidate);
  assertCoordinates(reviewList.bundles[0], candidate);
  assert.deepEqual(reviewList.tasks[0].decisionSelector, { kind: "task", id: "task_1" });
  assert.deepEqual(reviewList.bundles[0].decisionSelector, { kind: "bundle", id: "qa_bundle_1" });

  const cliPath = path.resolve("src/mission-control-cli.js");
  const jsonResult = await run(process.execPath, [cliPath, "qa-list", "--project", "demo", "--json"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const cliReviewList = JSON.parse(jsonResult.stdout);
  assertCoordinates(cliReviewList.tasks[0], candidate);
  assertCoordinates(cliReviewList.bundles[0], candidate);

  const tableResult = await run(process.execPath, [cliPath, "qa-list", "--project", "demo"], {
    cwd: process.cwd(),
    env: process.env,
  });
  for (const value of [
    "candidateId",
    "manifestDigest",
    "integrationSha",
    "ownerQaPacketDigest",
    candidate.id,
    candidate.manifestDigest,
    candidate.manifest.integration.sha,
    candidate.qaPacket.packetDigest,
  ]) {
    assert.match(tableResult.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("passed and release-candidate QA rows retain exact revocation coordinates", {
  skip: OUTER_VALIDATION_SANDBOX
    ? "The outer release sandbox intentionally prohibits every loopback listener; this API/CLI parity suite runs in builder validation."
    : false,
}, async () => {
  for (const lifecycle of [
    {
      candidateStatus: "qa_passed",
      taskStatus: "approved_for_main",
      bundleStatus: "passed",
      stateVersion: 1,
    },
    {
      candidateStatus: "release_candidate_ready",
      taskStatus: "user_review",
      bundleStatus: "release_candidate_ready",
      stateVersion: 2,
    },
  ]) {
    const {
      candidate,
      apiStatus,
      apiReviewList: reviewList,
      cliReviewList,
    } = await reviewListsFromFreshLifecycleFixture({ candidateStatus: lifecycle.candidateStatus, stateVersion: lifecycle.stateVersion });

    assert.equal(apiStatus, 200);
    assert.equal(reviewList.tasks.length, 1);
    assert.equal(reviewList.bundles.length, 1);
    assert.equal(reviewList.tasks[0].status, lifecycle.taskStatus);
    assert.equal(reviewList.bundles[0].status, lifecycle.bundleStatus);
    assertCoordinates(reviewList.tasks[0], candidate);
    assertCoordinates(reviewList.bundles[0], candidate);
    assert.deepEqual(reviewList.tasks[0].decisionSelector, { kind: "task", id: "task_1" });
    assert.deepEqual(reviewList.bundles[0].decisionSelector, { kind: "bundle", id: "qa_bundle_1" });

    assert.equal(cliReviewList.tasks[0].status, lifecycle.taskStatus);
    assert.equal(cliReviewList.bundles[0].status, lifecycle.bundleStatus);
    assertCoordinates(cliReviewList.tasks[0], candidate);
    assertCoordinates(cliReviewList.bundles[0], candidate);
    assert.deepEqual(cliReviewList.tasks[0].decisionSelector, { kind: "task", id: "task_1" });
    assert.deepEqual(cliReviewList.bundles[0].decisionSelector, { kind: "bundle", id: "qa_bundle_1" });
  }
});

test("multi-task post-approval rows route revocation through the atomic bundle selector", () => {
  for (const candidateStatus of ["qa_passed", "release_candidate_ready"]) {
    const state = fixtureState({ candidateStatus, taskIds: ["task_1", "task_2"] });
    const candidate = state.candidates[0];
    const reviewList = buildQaReviewList(state);
    assert.equal(reviewList.tasks.length, 2);
    assert.equal(reviewList.bundles.length, 1);
    for (const task of reviewList.tasks) {
      assertCoordinates(task, candidate);
      assert.deepEqual(task.decisionSelector, { kind: "bundle", id: "qa_bundle_1" });
    }
    assertCoordinates(reviewList.bundles[0], candidate);
    assert.deepEqual(reviewList.bundles[0].decisionSelector, { kind: "bundle", id: "qa_bundle_1" });
  }
});

test("CLI help requires review-list coordinates for owner QA decisions", async () => {
  const cliPath = path.resolve("src/mission-control-cli.js");
  const result = await run(process.execPath, [cliPath, "help"], {
    cwd: process.cwd(),
    env: process.env,
  });
  assert.match(result.stdout, /qa-list --json/);
  assert.match(result.stdout, /qa-pass task_1 --candidate candidate_ID --manifest-digest .* --integration-sha .* --owner-qa-packet-digest/);
  assert.doesNotMatch(result.stdout, /qa-pass task_1 --body/);
});

test("review discovery never exposes stale or corrupt packet authority as actionable", () => {
  for (const candidateStatus of ["frozen", "qa_passed", "release_candidate_ready"]) {
    for (const corrupt of [
      (state) => { state.qaBundles[0].packetDigest = `sha256:${"f".repeat(64)}`; },
      (state) => { state.tasks[0].title = "Changed after the immutable packet was generated"; },
    ]) {
      const state = fixtureState({ candidateStatus });
      corrupt(state);
      const reviewList = buildQaReviewList(state);
      assert.equal(reviewList.tasks.length, 1);
      assert.equal(reviewList.tasks[0].actionable, false);
      assert.equal(reviewList.tasks[0].ownerQaPacketDigest, "");
      assert.equal(reviewList.tasks[0].decisionSelector, null);
      assert.deepEqual(reviewList.bundles, []);
    }
  }
});
