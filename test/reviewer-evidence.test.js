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
const LIMIT_SHA = "b".repeat(40);

async function createCycleLimitTask(key) {
  const project = await addProject({
    key,
    name: key,
    repoPath: `/tmp/${key}`,
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
        label: "Primary Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
      },
    ],
    reviewPolicy: {
      maxBuilderReviewCycles: 2,
      leadOwnsFinalDecisionAtLimit: true,
    },
  });
  const task = await addTask({
    project: project.id,
    title: key,
    status: "in_progress",
    type: "bug",
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: `codex/${key}`,
    prUrl: `https://github.com/example/${key}/pull/1`,
    subjectSha: SUBJECT_SHA,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "The first-cycle backend finding must remain auditable.",
  });
  await updateTask(task.id, {
    status: "builder_review",
    subjectSha: LIMIT_SHA,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: LIMIT_SHA,
    candidateCycle: 2,
    body: "The final-cycle backend finding remains unresolved for lead decision.",
  });
  return task.id;
}

test("cycle-limit lead changes_requested review routes to owner with durable evidence", async () => {
  const taskId = await createCycleLimitTask("cycle-limit-lead-evidence");

  await assert.rejects(
    recordReview(taskId, {
      stage: "lead",
      outcome: "changes_requested",
      subjectSha: LIMIT_SHA,
      candidateCycle: 1,
    }),
    /does not match current cycle candidate 2/,
  );
  await assert.rejects(
    recordReview(taskId, {
      stage: "lead",
      outcome: "changes_requested",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 2,
    }),
    /does not match the current cycle subject/,
  );

  const result = await recordReview(taskId, {
    stage: "lead",
    outcome: "changes_requested",
    subjectSha: LIMIT_SHA,
    candidateCycle: 2,
    body: "Lead confirms the unresolved backend finding for owner review.",
  });
  assert.equal(result.review.outcome, "changes_requested");

  const state = await readState();
  const task = state.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "user_review");
  assert.equal(task.assignedAgentRole, "owner");
  assert.equal(
    state.reviews.some((review) => (
      review.taskId === taskId
      && review.stageKey === "backend"
      && review.outcome === "changes_requested"
      && review.subjectSha === LIMIT_SHA
      && review.candidateCycle === 2
    )),
    true,
  );
  assert.equal(
    candidateReviewEvidenceForTask(state, task).error,
    "Required Backend Review is not complete for the current subject SHA.",
  );
});

test("lead cannot bypass an earlier finding before the configured cycle limit", async () => {
  const project = await addProject({
    key: "lead-before-cycle-limit",
    name: "lead-before-cycle-limit",
    repoPath: "/tmp/lead-before-cycle-limit",
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
        label: "Primary Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
      },
    ],
    reviewPolicy: {
      maxBuilderReviewCycles: 2,
      leadOwnsFinalDecisionAtLimit: true,
    },
  });
  const task = await addTask({ project: project.id, title: "before-limit", status: "in_progress", type: "bug" });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/before-limit",
    prUrl: "https://github.com/example/before-limit/pull/1",
    subjectSha: SUBJECT_SHA,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });

  await assert.rejects(
    recordReview(task.id, {
      stage: "lead",
      outcome: "approved",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 1,
    }),
    /Backend Review must approve candidate cycle 1/,
  );
});
