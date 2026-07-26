import assert from "node:assert/strict";
import test from "node:test";
import {
  addProject,
  addTask,
  candidateReviewEvidenceForTask,
  readState,
  recordReview,
  updateTask,
} from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);

test("reviews require the exact current candidate cycle and subject SHA", async () => {
  const project = await addProject({
    key: "review-identity",
    name: "Review identity",
    repoPath: "/tmp/review-identity",
    reviewPipeline: [
      {
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      },
      {
        key: "lead",
        label: "Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
      },
    ],
  });
  const task = await addTask({
    project: project.id,
    title: "Commit-bound review",
    status: "in_progress",
    type: "bug",
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/review-identity",
    prUrl: "https://github.com/example/review-identity/pull/1",
    subjectSha: SUBJECT_SHA,
  });

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
});
