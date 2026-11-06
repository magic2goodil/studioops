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
const environment = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
Object.assign(process.env, environment.env);
test.after(async () => environment.cleanup());

const { qaDecisionCoordinatesForState, readState, writeState, addProject, addTask, updateTask, updateRun, recordReview } = await import(
  `../src/store.js?qa-bundle-cli=${Date.now()}`
);

const REPOSITORY_URL = "https://github.com/example/demo";
const { dispatchSupervisorActions } = await import("../src/dispatcher.js");

async function nativeQaFixture(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-auth-candidate-"));
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

function candidateFixture({ candidateId, bundleId, taskIds, native }) {
  const { baseSha: BASE_SHA, sourceSha: SOURCE_SHA, integrationSha: INTEGRATION_SHA } = native;
  return createCandidateEnvelope({
    qaBundleId: bundleId,
    manifest: {
      candidateId,
      projectId: native.nativeProject.id,
      base: { branch: "main", sha: BASE_SHA },
      sources: taskIds.map((taskId, index) => ({
        taskId,
        sourceRef: `refs/heads/${native.nativeTasks.find((task) => task.id === taskId).branchName}`,
        headSha: SOURCE_SHA,
        candidateCycle: 1,
        reviews: native.nativeReviews.filter((review) => review.taskId === taskId),
      })),
      integration: { branch: `qa/${candidateId}`, sha: INTEGRATION_SHA },
      checks: [{
        id: `check_${candidateId}`,
        kind: "local-validation",
        name: "node --test test/catalog.test.js",
        outcome: "passed",
        subjectSha: INTEGRATION_SHA,
        evidenceDigest: native.validationEvidenceDigest,
      }],
      preview: {
        url: `http://127.0.0.1:4393/${candidateId}`,
        status: "healthy",
        commitSha: INTEGRATION_SHA,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: { kind: "json", key: "commitSha", observedSha: INTEGRATION_SHA },
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
}

function fixtureState(native) {
  const { sourceSha: SOURCE_SHA, integrationSha: INTEGRATION_SHA } = native;
  const definitions = [
    { candidateId: "candidate_single", bundleId: "qa_bundle_single", taskIds: [native.nativeTasks[0].id] },
    { candidateId: "candidate_multi", bundleId: "qa_bundle_multi", taskIds: native.nativeTasks.slice(1).map((task) => task.id) },
  ];
  const candidates = definitions.map((definition) => candidateFixture({ ...definition, native }));
  const state = {
    meta: native.nativeState.meta,
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/private/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      workflowMode: "github",
      ...native.nativeProject,
    }],
    tasks: definitions.flatMap((definition) => definition.taskIds.map((taskId) => {
      const candidate = candidates.find((item) => item.id === definition.candidateId);
      return {
        ...native.nativeTasks.find((task) => task.id === taskId),
        id: taskId,
        projectId: native.nativeProject.id,
        title: native.nativeTasks.find((task) => task.id === taskId).title,
        status: "qa_review",
        assignedAgentRole: "owner",
        stateVersion: native.nativeTasks.find((task) => task.id === taskId).stateVersion,
        reviewCycle: 1,
        reviewSubjectSha: SOURCE_SHA,
        reviewSubjectCycle: 1,
        integrationStatus: "ready",
        integrationBranch: candidate.manifest.integration.branch,
        integrationCommit: INTEGRATION_SHA,
        candidateManifestDigest: candidate.manifestDigest,
        candidateId: candidate.id,
        qaBundleId: definition.bundleId,
      };
    })),
    comments: native.nativeState.comments,
    events: native.nativeState.events,
    reviews: native.nativeState.reviews,
    runs: native.nativeState.runs,
    qaBundles: definitions.map((definition) => {
      const candidate = candidates.find((item) => item.id === definition.candidateId);
      return {
        id: definition.bundleId,
        projectId: native.nativeProject.id,
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationBranch: candidate.manifest.integration.branch,
        integrationCommit: INTEGRATION_SHA,
        previewUrl: candidate.manifest.preview.url,
        status: "ready",
        updatedAt: "2026-09-03T12:05:00.000Z",
        tasks: definition.taskIds.map((taskId) => ({ id: taskId, title: `Review ${taskId}` })),
      };
    }),
    candidates,
  };
  for (const candidate of candidates) {
    const bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
    candidate.qaPacket = buildOwnerQaPacket(state, candidate, {
      bundle,
      generatedAt: "2026-09-03T12:05:00.000Z",
    });
    bundle.qaPacket = candidate.qaPacket;
    bundle.packetDigest = candidate.qaPacket.packetDigest;
  }
  return state;
}

function decisionArgs(coordinates, notes) {
  return [
    "--candidate", coordinates.candidateId,
    "--manifest-digest", coordinates.manifestDigest,
    "--integration-sha", coordinates.integrationSha,
    "--owner-qa-packet-digest", coordinates.ownerQaPacketDigest,
    "--body", notes,
  ];
}

test("QA CLI acts on bundle rows atomically and preserves positional task decisions", async (t) => {
  const native = await nativeQaFixture({ testContext: t, taskCount: 3, projectKey: "demo" });
  for (const branch of ["qa/candidate_single", "qa/candidate_multi"]) {
    execFileSync("/usr/bin/git", ["-C", native.nativeProject.repoPath, "branch", branch, native.integrationSha]);
  }
  const state = fixtureState(native);
  const INTEGRATION_SHA = native.integrationSha;
  const singleId = state.candidates[0].manifest.sources[0].taskId;
  const multiIds = state.candidates[1].manifest.sources.map((source) => source.taskId);
  await writeState(state);
  const coordinates = qaDecisionCoordinatesForState(state);
  const cliPath = path.resolve("src/mission-control-cli.js");
  const common = { cwd: process.cwd(), env: process.env };

  const help = await run(process.execPath, [cliPath, "help"], common);
  assert.match(help.stdout, /qa-pass TASK_ID\|--bundle BUNDLE_ID/);
  assert.match(help.stdout, /qa-fail --bundle qa_bundle_ID --candidate candidate_ID/);

  await assert.rejects(
    run(process.execPath, [cliPath, "qa-fail", "--bundle="], common),
    /--bundle requires an exact QA bundle ID/,
  );

  await assert.rejects(
    run(process.execPath, [
      cliPath,
      "qa-fail",
      multiIds[0],
      "--bundle",
      "qa_bundle_multi",
      ...decisionArgs({
        candidateId: "candidate_multi",
        manifestDigest: state.candidates[1].manifestDigest,
        integrationSha: INTEGRATION_SHA,
        ownerQaPacketDigest: coordinates.bundles.qa_bundle_multi,
      }, "Ambiguous selector must not apply."),
    ], common),
    /Choose exactly one QA decision selector/,
  );
  assert.equal((await readState()).candidates.find((item) => item.id === "candidate_multi").status, "frozen");

  const singleResult = await run(process.execPath, [
    cliPath,
    "qa-fail",
    singleId,
    ...decisionArgs({
      candidateId: "candidate_single",
      manifestDigest: state.candidates[0].manifestDigest,
      integrationSha: INTEGRATION_SHA,
      ownerQaPacketDigest: coordinates.tasks[singleId],
    }, "Single-task QA still uses the positional selector."),
  ], common);
  assert.match(singleResult.stdout, /candidate_single: QA failed\. Status now qa_failed\./);

  const bundleResult = await run(process.execPath, [
    cliPath,
    "qa-fail",
    "--bundle",
    "qa_bundle_multi",
    ...decisionArgs({
      candidateId: "candidate_multi",
      manifestDigest: state.candidates[1].manifestDigest,
      integrationSha: INTEGRATION_SHA,
      ownerQaPacketDigest: coordinates.bundles.qa_bundle_multi,
    }, "The complete bundle needs changes."),
  ], common);
  assert.match(bundleResult.stdout, /candidate_multi: QA failed\. Status now qa_failed\./);

  const persisted = await readState();
  assert.equal(persisted.tasks.find((item) => item.id === singleId).status, "needs_changes");
  assert.deepEqual(
    persisted.tasks.filter((item) => multiIds.includes(item.id)).map((item) => item.status),
    ["needs_changes", "needs_changes"],
  );
  assert.equal(persisted.candidates.find((item) => item.id === "candidate_multi").status, "qa_failed");
  assert.equal(persisted.qaBundles.find((item) => item.id === "qa_bundle_multi").status, "failed");
  assert.equal(persisted.comments.filter((comment) => comment.body.includes("The complete bundle needs changes.")).length, 2);
});
