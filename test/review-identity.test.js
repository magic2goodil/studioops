import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addProject,
  addTask,
  candidateReviewEvidenceForTask,
  readState,
  recordReview,
  updateRun,
  updateTask,
} from "../src/store.js";
import { dispatchSupervisorActions } from "../src/dispatcher.js";

async function reviewCandidateFixture(t, key, reviewPipeline) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = `https://github.com/example/${key}`;
  git("init", "-b", "main"); git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", repository);
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, "test")); await mkdir(path.join(root, "docs/architecture"), { recursive: true });
  await writeFile(path.join(root, "src/catalog.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "test/catalog.test.js"), "// Generic owned fixture.\n");
  await writeFile(path.join(root, "docs/architecture/components.json"), JSON.stringify({ schemaVersion: 1, project: { key, repository }, aggregateCommand: "npm run check",
    components: { catalog: { owner: "fixture-engineering", paths: ["src/catalog.js", "test/catalog.test.js"], publicContracts: ["shared client and server catalog value"], services: ["shared catalog module"],
      dependsOn: [], tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }], reviewOwners: ["backend-reviewer"], rollback: "Restore the prior fixture commit." } } }));
  git("add", "."); git("commit", "-m", "Generic review base");
  const baseSha = git("rev-parse", "HEAD"); const branch = `codex/${key}`;
  git("switch", "-c", branch);
  const project = await addProject({ key, name: "Generic review identity", workflowMode: "github", repoPath: root, sourceRepoPath: root, repoUrl: repository, reviewPipeline,
    deliveryPolicy: { profile: "standard" } });
  const task = await addTask({ project: project.id, title: "Commit-bound review", type: "bug", status: "ready", architectureRequired: false, branchName: branch,
    description: "Review exact real candidate coordinates under native edit authority.", userStory: "As a reviewer I need commit-bound review evidence.",
    expectedOutcome: "Stale candidate evidence never approves a new commit.", acceptanceCriteria: ["Reviews bind the exact candidate."], workAreas: ["src/catalog.js"],
    affectedSurfaces: ["src/catalog.js"], validationPlan: ["node --test test/catalog.test.js"], riskClassification: "low",
    privacyNotes: "Generic synthetic source only; no personal data.", securityNotes: "No network access or external executor is used." });
  const dispatch = await dispatchSupervisorActions([{ id: `${task.id}:start_builder`, type: "start_builder", role: "builder", taskId: task.id, projectId: project.id,
    taskStatus: "ready", nextStatus: "in_progress" }], { failureIncidents: [], creditPolicy: { enabled: false } });
  assert.equal(dispatch.runs.length, 1, JSON.stringify(dispatch.skipped));
  await updateRun(dispatch.runs[0].id, { status: "cancelled", completedAt: new Date().toISOString(), notes: "Fixture cancelled before executor launch." });
  await updateTask(task.id, { status: "in_progress" });
  const commit = async version => {
    await writeFile(path.join(root, "src/catalog.js"), `export const version = ${version};\n`);
    git("add", "src/catalog.js"); git("commit", "-m", `Review candidate ${version}`);
    return { commitSha: git("rev-parse", "HEAD"), treeSha: git("rev-parse", "HEAD^{tree}"), baseSha, branch, candidateCycle: 1,
      impactEvidence: { changedFiles: ["src/catalog.js"], impact: ["backend", "frontend", "accessibility"] } };
  };
  const identity = await commit(2);
  await updateTask(task.id, { status: "builder_review", branchName: branch, prUrl: `${repository}/pull/1`, subjectSha: identity.commitSha,
    candidateIdentity: identity, impactEvidence: identity.impactEvidence });
  return { project, task, identity, commit };
}

test("task labels persist through intake and updates for auditable tier routing", async () => {
  const project = await addProject({ key: "tier-routing", name: "Tier Routing" });
  const task = await addTask({
    project: project.id,
    title: "Format generated documentation",
    labels: ["spark-ok"],
    architectureRequired: false,
  });
  assert.deepEqual(task.labels, ["spark-ok"]);

  await updateTask(task.id, { labels: ["ultra-review"] });
  const state = await readState();
  assert.deepEqual(state.tasks.find((item) => item.id === task.id)?.labels, ["ultra-review"]);
});

test("reviews require the exact current candidate cycle and subject SHA", async (t) => {
  const { project, task, identity } = await reviewCandidateFixture(t, "review-identity", [
      {
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      },
    ]);
  const SUBJECT_SHA = identity.commitSha;
  assert.equal(project.reviewPipeline.some((stage) => (
    stage.key === "lead"
    && stage.role === "lead-reviewer"
    && stage.required === true
  )), true);

  await assert.rejects(
    recordReview(task.id, { stage: "backend", outcome: "approved", candidateCycle: 1 }),
    /subject SHA is required/,
  );
  await assert.rejects(
    recordReview(task.id, {
      stage: "backend",
      outcome: "approved",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 2,
    }),
    /does not match current cycle/,
  );
  await assert.rejects(
    recordReview(task.id, {
      stage: "backend",
      outcome: "approved",
      subjectSha: "b".repeat(40),
      candidateCycle: 1,
    }),
    /does not match the current cycle subject/,
  );

  await recordReview(task.id, {
    stage: "backend",
    outcome: "approved",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });
  await assert.rejects(
    recordReview(task.id, {
      stage: "lead",
      outcome: "skipped",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 1,
    }),
    /cannot be skipped/,
  );
  await recordReview(task.id, {
    stage: "lead",
    outcome: "approved",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });

  const state = await readState();
  const updated = state.tasks.find((item) => item.id === task.id);
  const evidence = candidateReviewEvidenceForTask(state, updated);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.subjectSha, SUBJECT_SHA);
  assert.equal(evidence.candidateCycle, 1);
  assert.deepEqual(evidence.reviews.map((review) => review.stageKey), ["backend", "lead"]);
  assert.ok(updated.stateVersion > 1, "review evidence mutations advance the aggregate version");
});

test("reviewer commits restart required lanes without consuming a builder review cycle", async (t) => {
  const fixture = await reviewCandidateFixture(t, "reviewer-fix-identity", [
      {
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      },
      {
        key: "frontend",
        label: "Frontend Review",
        role: "frontend-reviewer",
        status: "frontend_review",
        required: true,
      },
      {
        key: "accessibility",
        label: "Accessibility Review",
        role: "accessibility-reviewer",
        status: "accessibility_review",
        required: true,
      },
      {
        key: "lead",
        label: "Primary Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
      },
    ]);
  const { task } = fixture;
  const SUBJECT_SHA = fixture.identity.commitSha;
  await recordReview(task.id, {
    stage: "backend",
    outcome: "approved",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });

  const corrected = await fixture.commit(3);
  const REVIEWER_FIX_SHA = corrected.commitSha;
  await updateTask(task.id, { subjectSha: REVIEWER_FIX_SHA, candidateIdentity: corrected });
  let state = await readState();
  let updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.status, "backend_review");
  assert.equal(updated.assignedAgentRole, "backend-reviewer");
  assert.equal(updated.reviewCycle, 1);
  assert.equal(updated.reviewSubjectCycle, 2);
  assert.equal(updated.reviewSubjectSha, REVIEWER_FIX_SHA);
  assert.equal(
    state.comments.some((comment) => (
      comment.taskId === task.id
      && /Prior candidate-cycle approvals are stale/.test(comment.body)
      && /builder review cycle remains 1/.test(comment.body)
    )),
    true,
  );
  assert.equal(candidateReviewEvidenceForTask(state, updated).ok, false);

  await assert.rejects(
    recordReview(task.id, {
      stage: "frontend",
      outcome: "approved",
      subjectSha: REVIEWER_FIX_SHA,
      candidateCycle: 1,
    }),
    /does not match current cycle candidate 2/,
  );
  await assert.rejects(
    recordReview(task.id, {
      stage: "frontend",
      outcome: "approved",
      subjectSha: REVIEWER_FIX_SHA,
      candidateCycle: 2,
    }),
    /Backend Review must approve candidate cycle 2/,
  );
  await assert.rejects(
    recordReview(task.id, {
      stage: "backend",
      outcome: "approved",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 2,
    }),
    /does not match the current cycle subject/,
  );

  await recordReview(task.id, {
    stage: "backend",
    outcome: "approved",
    subjectSha: REVIEWER_FIX_SHA,
    candidateCycle: 2,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "approved",
    subjectSha: REVIEWER_FIX_SHA,
    candidateCycle: 2,
    body: "Duplicate delivery was harmless.",
  });
  state = await readState();
  updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.status, "frontend_review");

  for (const stage of ["frontend", "accessibility", "lead"]) {
    await recordReview(task.id, {
      stage,
      outcome: "approved",
      subjectSha: REVIEWER_FIX_SHA,
      candidateCycle: 2,
    });
  }

  state = await readState();
  updated = state.tasks.find((item) => item.id === task.id);
  const evidence = candidateReviewEvidenceForTask(state, updated);
  assert.equal(updated.status, "user_review");
  assert.equal(updated.reviewCycle, 1);
  assert.equal(updated.reviewSubjectCycle, 2);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.subjectSha, REVIEWER_FIX_SHA);
  assert.equal(evidence.candidateCycle, 2);
  assert.deepEqual(
    evidence.reviews.map((review) => review.stageKey),
    ["backend", "frontend", "accessibility", "lead"],
  );
});
