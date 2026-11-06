import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addProject,
  addTask,
  automationTick,
  capabilityRoutingForTask,
  candidateIdentityForTask,
  candidateIdentityIsComplete,
  normalizeDeliveryPolicy,
  readState,
  updateRun,
  updateTask,
} from "../src/store.js";
import { dispatchSupervisorActions, planDispatches } from "../src/dispatcher.js";
import { createSupervisorReport } from "../src/supervisor.js";

async function scopedCandidateFixture(t, key, file) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fast-lane-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = `https://github.com/example/${key}`;
  git("init", "-b", "main"); git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", repository);
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await mkdir(path.join(root, "test")); await mkdir(path.join(root, "docs/architecture"), { recursive: true });
  await writeFile(path.join(root, file), "export const version = 1;\n");
  await writeFile(path.join(root, "test/candidate.test.js"), "// Generic candidate fixture.\n");
  await writeFile(path.join(root, "docs/architecture/components.json"), JSON.stringify({ schemaVersion: 1, project: { key, repository },
    aggregateCommand: "npm run check", components: { candidate: { owner: "fixture-engineering", paths: [file, "test/candidate.test.js"],
      publicContracts: ["candidate value"], services: ["candidate module"], dependsOn: [],
      tests: [{ command: "node --test test/candidate.test.js", layer: "unit" }], reviewOwners: ["lead-reviewer"], rollback: "Restore the prior fixture commit." } } }));
  git("add", "."); git("commit", "-m", "Generic candidate base");
  const baseSha = git("rev-parse", "HEAD");
  const branch = `feature/${key}`;
  git("switch", "-c", branch);
  const project = await addProject({ key, name: "Generic fast-lane fixture", workflowMode: "github", repoPath: root, sourceRepoPath: root, repoUrl: repository,
    deliveryPolicy: { profile: "prototype-fast-lane" } });
  const task = await addTask({ project: project.id, title: "Review real candidate metadata", type: "bug", architectureRequired: false, status: "ready",
    description: "Validate real candidate identity with native frozen edit scope.", userStory: "As a reviewer I need exact candidate metadata.",
    expectedOutcome: "Candidate review cycles retain their intended semantics.", acceptanceCriteria: ["Candidate identity remains exact."], workAreas: [file], branchName: branch,
    affectedSurfaces: [file], validationPlan: ["node --test test/candidate.test.js"], riskClassification: "low",
    privacyNotes: "Generic synthetic source only; no personal data.", securityNotes: "No network access or external executor is used." });
  // Native dispatch freezes the mapped edit authority. The isolated queued run
  // is cancelled before any executor starts; no scope record is injected.
  const report = await dispatchSupervisorActions([{ id: `${task.id}:start_builder`, type: "start_builder", role: "builder", taskId: task.id, projectId: project.id,
    taskStatus: "ready", nextStatus: "in_progress" }], { failureIncidents: [], creditPolicy: { enabled: false } });
  assert.equal(report.runs.length, 1, JSON.stringify(report.skipped));
  await updateRun(report.runs[0].id, { status: "cancelled", completedAt: new Date().toISOString(), notes: "Fixture cancelled before executor launch." });
  await updateTask(task.id, { status: "in_progress" });
  const commit = async (version) => {
    await writeFile(path.join(root, file), `export const version = ${version};\n`);
    git("add", file); git("commit", "-m", `Candidate version ${version}`);
    return { commitSha: git("rev-parse", "HEAD"), treeSha: git("rev-parse", "HEAD^{tree}"), baseSha, branch, candidateCycle: 1 };
  };
  return { task, project, git, commit };
}

test("delivery policy fails closed and never enables merge or deployment", () => {
  assert.equal(normalizeDeliveryPolicy({ profile: "ambiguous" }).profile, "standard");
  assert.deepEqual(
    normalizeDeliveryPolicy({ profile: "prototype-fast-lane" }),
    {
      profile: "prototype-fast-lane",
      automaticMerge: false,
      automaticDeployment: false,
      architectureRequiredForBroadProducts: true,
      primaryLeadRequired: true,
      humanProductionReleaseRequired: true,
    },
  );
});

test("prototype UI impact skips backend but retains accessibility and lead", () => {
  const routing = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "prototype-fast-lane" } },
    { reviewSubjectSha: "a".repeat(40), reviewSubjectCycle: 2, impactEvidence: { changedFiles: ["src/App.jsx"] } },
  );
  assert.deepEqual(routing.required, ["frontend", "accessibility", "lead"]);
  assert.equal(routing.skipped[0].stageKey, "backend");
  assert.equal(routing.skipped[0].candidateCycle, 2);
  assert.equal(routing.skipped[0].subjectSha, "a".repeat(40));
});

test("unknown impact fails closed to backend and all specialist lanes", () => {
  const routing = capabilityRoutingForTask({ deliveryPolicy: { profile: "prototype-fast-lane" } }, {});
  assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
  assert.equal(routing.evidence.unknown, true);
});

test("stale or conflicting impact evidence fails closed to every specialist lane", () => {
  for (const flag of ["stale", "conflicting"]) {
    const routing = capabilityRoutingForTask(
      { deliveryPolicy: { profile: "prototype-fast-lane" } },
      { impactEvidence: { changedFiles: ["src/App.jsx"], [flag]: true } },
    );
    assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
  }
});

test("an unclassified changed path fails closed even when the diff is nonempty", () => {
  const routing = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "prototype-fast-lane" } },
    { impactEvidence: { changedFiles: ["vendor/opaque-surface.bin"] } },
  );
  assert.equal(routing.evidence.unknown, true);
  assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
});

test("an unknown explicit impact label fails closed even when the path is classified", () => {
  const routing = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "prototype-fast-lane" } },
    { impactEvidence: { changedFiles: ["src/App.jsx"], impact: ["mystery"] } },
  );
  assert.equal(routing.evidence.unknown, true);
  assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
});

test("normalized impact classifications remain stable when evidence is reused", () => {
  const routing = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "prototype-fast-lane" } },
    { impactEvidence: { changedFiles: ["src/App.jsx"], classifications: ["backend"] } },
  );
  assert.deepEqual(routing.evidence.classifications, ["backend"]);
  assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
});

test("explicit local mode requires a verified candidate while GitHub requires an exact subject", () => {
  const base = {
    id: "task_1", projectId: "project_1", title: "Candidate", status: "builder_review",
    branchName: "feature/candidate", reviewCycle: 1, reviewSubjectCycle: 1,
  };
  const local = createSupervisorReport({
    projects: [{ id: "project_1", workflowMode: "local", reviewPipeline: [] }],
    tasks: [base], reviews: [], events: [], comments: [],
  });
  assert.equal(local.actions[0].type, "return_to_builder");

  const github = createSupervisorReport({
    projects: [{ id: "project_1", workflowMode: "github", deliveryPolicy: { profile: "prototype-fast-lane" }, reviewPipeline: [] }],
    tasks: [{ ...base, prUrl: "https://github.com/example/repo/pull/1", reviewSubjectSha: "a".repeat(40) }], reviews: [], events: [], comments: [],
  });
  assert.equal(github.actions[0].type, "return_to_builder");
});

test("candidate identity requires immutable repository coordinates", () => {
  const complete = {
    commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/x", candidateCycle: 1,
    impactEvidence: { changedFiles: ["src/App.jsx"] },
  };
  assert.equal(candidateIdentityIsComplete(complete), true);
  assert.equal(candidateIdentityIsComplete({ ...complete, treeSha: "" }), false);
  assert.equal(candidateIdentityIsComplete({ ...complete, impactEvidence: {} }), false);
});

test("custom backend stages are skipped by their actual identity and cannot also dispatch", async () => {
  const sha = "a".repeat(40);
  const state = {
    projects: [{
      id: "project_1", key: "demo", name: "Demo", workflowMode: "github",
      deliveryPolicy: { profile: "prototype-fast-lane" },
      reviewPipeline: [
        { key: "api", label: "API Review", role: "backend-reviewer", status: "backend_review", required: true },
        { key: "frontend", label: "Frontend Review", role: "frontend-reviewer", status: "frontend_review", required: true },
        { key: "lead", label: "Lead Review", role: "lead-reviewer", status: "lead_review", required: true },
      ],
    }],
    tasks: [{
      id: "task_1", projectId: "project_1", title: "UI candidate", type: "feature", status: "builder_review",
      branchName: "feature/ui", prUrl: "https://github.com/example/demo/pull/1", reviewCycle: 1,
      reviewSubjectCycle: 1, reviewSubjectSha: sha, impactEvidence: { changedFiles: ["src/App.jsx"] },
      candidateIdentity: {
        commitSha: sha, treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/ui", candidateCycle: 1,
        impactEvidence: { changedFiles: ["src/App.jsx"] },
      },
    }],
    reviews: [], runs: [], comments: [], events: [],
  };

  await automationTick({ state, nowMs: Date.parse("2026-08-15T12:00:00.000Z") });
  assert.deepEqual(state.reviews.map((review) => [review.stageKey, review.outcome]), [["api", "skipped"]]);
  assert.equal(state.tasks[0].status, "frontend_review");

  const plan = planDispatches(state, [{
    id: "task_1:stale-api-review", type: "start_review", role: "backend-reviewer",
    taskId: "task_1", projectId: "project_1", nextStatus: "backend_review",
    reviewSubjectSha: sha, candidateCycle: 1,
  }]);
  assert.equal(plan.selected.length, 0);
  assert.equal(plan.skipped[0].reason, "review_stage_unknown");
});

test("current impact evidence refreshes identity and unchanged-tree metadata repair keeps both cycles stable", async (t) => {
  const fixture = await scopedCandidateFixture(t, "fast-lane-cycle-stability", "src/App.jsx");
  const { task, git } = fixture;
  const coordinates = await fixture.commit(2);
  const firstSha = coordinates.commitSha;
  const impactEvidence = { changedFiles: ["src/App.jsx"], impact: ["frontend"] };
  const identity = {
    ...coordinates,
    impactEvidence: { changedFiles: ["stale/old.jsx"] },
  };

  await updateTask(task.id, {
    status: "builder_review",
    branchName: identity.branch,
    prUrl: "https://github.com/example/demo/pull/2",
    subjectSha: firstSha,
    impactEvidence,
    candidateIdentity: identity,
  });
  let state = await readState();
  let current = state.tasks.find((item) => item.id === task.id);
  assert.deepEqual(candidateIdentityForTask(current).impactEvidence.changedFiles, ["src/App.jsx"]);
  assert.equal(current.reviewCycle, 1);
  assert.equal(current.reviewSubjectCycle, 1);

  await updateTask(task.id, { status: "needs_changes" });
  git("commit", "--allow-empty", "-m", "Metadata-only candidate repair");
  const metadataSha = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD^{tree}"), coordinates.treeSha);
  await updateTask(task.id, {
    status: "builder_review",
    subjectSha: metadataSha,
    candidateIdentity: { ...identity, commitSha: metadataSha, impactEvidence },
  });
  state = await readState();
  current = state.tasks.find((item) => item.id === task.id);
  assert.equal(current.reviewCycle, 1);
  assert.equal(current.reviewSubjectCycle, 1);
  assert.equal(current.reviewSubjectSha, metadataSha);
  assert.equal(current.candidateIdentity.commitSha, metadataSha);
  assert.deepEqual(current.candidateIdentity.impactEvidence.changedFiles, ["src/App.jsx"]);
});

test("an atomic builder handoff replaces stale candidate coordinates without an intermediate review restart", async (t) => {
  const fixture = await scopedCandidateFixture(t, "atomic-candidate-handoff", "src/store.js");
  const { task } = fixture;
  const original = await fixture.commit(2);
  const originalSha = original.commitSha;
  const identity = {
    ...original,
    impactEvidence: { changedFiles: ["src/store.js"] },
  };

  await updateTask(task.id, {
    status: "builder_review",
    subjectSha: originalSha,
    impactEvidence: identity.impactEvidence,
    candidateIdentity: identity,
  });
  await updateTask(task.id, { status: "in_progress" });
  const corrected = await fixture.commit(3);
  const correctedSha = corrected.commitSha;
  await updateTask(task.id, {
    status: "builder_review",
    subjectSha: correctedSha,
    impactEvidence: identity.impactEvidence,
    candidateIdentity: {
      ...identity,
      ...corrected,
      candidateCycle: 2,
    },
  });

  const state = await readState();
  const current = state.tasks.find((item) => item.id === task.id);
  assert.equal(current.status, "builder_review");
  assert.equal(current.reviewCycle, 2);
  assert.equal(current.reviewSubjectCycle, 2);
  assert.equal(current.reviewSubjectSha, correctedSha);
  assert.equal(current.candidateIdentity.commitSha, correctedSha);
  assert.equal(current.candidateIdentity.treeSha, corrected.treeSha);
  assert.equal(
    state.events.some((event) => event.taskId === task.id && event.type === "review_subject_changed"),
    false,
  );
});

test("material impact changes invalidate same-SHA capability skips and start a new candidate cycle", async (t) => {
  const fixture = await scopedCandidateFixture(t, "fast-lane-impact-reclassification", "src/App.jsx");
  const { task } = fixture;
  const identity = await fixture.commit(2);
  const sha = identity.commitSha;

  await updateTask(task.id, {
    status: "builder_review",
    branchName: identity.branch,
    prUrl: "https://github.com/example/demo/pull/3",
    subjectSha: sha,
    impactEvidence: { changedFiles: ["src/App.jsx"], impact: ["frontend"] },
    candidateIdentity: {
      ...identity,
      impactEvidence: { changedFiles: ["src/App.jsx"], impact: ["frontend"] },
    },
  });
  await automationTick({ nowMs: Date.parse("2026-08-15T12:00:00.000Z") });

  let state = await readState();
  let current = state.tasks.find((item) => item.id === task.id);
  assert.equal(current.status, "frontend_review");
  assert.equal(state.reviews.find((review) => review.taskId === task.id && review.stageKey === "backend")?.outcome, "skipped");

  await updateTask(task.id, {
    impactEvidence: { changedFiles: ["src/App.jsx"], impact: ["backend"] },
  });
  state = await readState();
  current = state.tasks.find((item) => item.id === task.id);
  assert.equal(current.reviewSubjectSha, sha);
  assert.equal(current.reviewCycle, 1);
  assert.equal(current.reviewSubjectCycle, 2);
  assert.equal(current.status, "backend_review");
  assert.equal(current.assignedAgentRole, "backend-reviewer");
  assert.deepEqual(current.candidateIdentity.impactEvidence.changedFiles, ["src/App.jsx"]);
  assert.equal(
    state.reviews.some((review) => (
      review.taskId === task.id
      && review.stageKey === "backend"
      && Number(review.candidateCycle) === 2
    )),
    false,
  );
  assert.equal(
    state.events.some((event) => (
      event.taskId === task.id
      && event.type === "candidate_identity_changed"
    )),
    true,
  );

  await updateTask(task.id, { impactEvidence: {} });
  state = await readState();
  current = state.tasks.find((item) => item.id === task.id);
  assert.equal(current.reviewSubjectSha, sha);
  assert.equal(current.reviewCycle, 1);
  assert.equal(current.reviewSubjectCycle, 3);
  assert.equal(current.status, "needs_changes");
  assert.equal(current.assignedAgentRole, "builder");
  assert.equal(candidateIdentityIsComplete(current.candidateIdentity), false);
  assert.equal(
    state.reviews.some((review) => (
      review.taskId === task.id
      && Number(review.candidateCycle) === 3
    )),
    false,
  );
});
