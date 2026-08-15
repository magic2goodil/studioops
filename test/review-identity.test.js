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
const REVIEWER_FIX_SHA = "b".repeat(40);

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
    ],
  });
  assert.equal(project.reviewPipeline.some((stage) => (
    stage.key === "lead"
    && stage.role === "lead-reviewer"
    && stage.required === true
  )), true);
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

test("reviewer commits restart required lanes without consuming a builder review cycle", async () => {
  const project = await addProject({
    key: "reviewer-fix-identity",
    name: "Reviewer fix identity",
    repoPath: "/tmp/reviewer-fix-identity",
    reviewPipeline: [
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
    ],
  });
  const task = await addTask({
    project: project.id,
    title: "Restart after reviewer commit",
    status: "in_progress",
    type: "bug",
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/reviewer-fix-identity",
    prUrl: "https://github.com/example/reviewer-fix-identity/pull/1",
    subjectSha: SUBJECT_SHA,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "approved",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });

  await updateTask(task.id, { subjectSha: REVIEWER_FIX_SHA });
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

async function createCycleLimitLeadDecisionTask(key) {
  const project = await addProject({
    key,
    name: "Cycle-limit lead decisions",
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
      maxBuilderReviewCycles: 1,
      leadOwnsFinalDecisionAtLimit: true,
    },
  });
  const task = await addTask({
    project: project.id,
    title: "Cycle-limit lead decision",
    status: "in_progress",
    type: "bug",
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: `codex/${key}`,
    prUrl: `https://github.com/example/${key}/pull/1`,
    subjectSha: SUBJECT_SHA,
  });
  return task;
}

test("cycle-limit lead changes_requested is accepted after backend changes_requested", async () => {
  const task = await createCycleLimitLeadDecisionTask("lead-cycle-limit-changes");

  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "Backend finding remains unresolved.",
  });

  let state = await readState();
  let updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.status, "lead_review");

  await recordReview(task.id, {
    stage: "lead",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "Human owner should decide whether to accept the residual risk.",
  });

  state = await readState();
  updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.status, "user_review");
  assert.equal(updated.assignedAgentRole, "owner");
  assert.deepEqual(
    state.reviews.filter((review) => review.taskId === task.id).map((review) => review.stageKey),
    ["backend", "lead"],
  );
  assert.equal(
    state.reviews.find((review) => review.taskId === task.id && review.stageKey === "lead")?.outcome,
    "changes_requested",
  );
});

test("cycle-limit lead approval is accepted with residual risk after backend changes_requested", async () => {
  const task = await createCycleLimitLeadDecisionTask("lead-cycle-limit-approval");

  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  });
  await recordReview(task.id, {
    stage: "lead",
    outcome: "approved",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "Approved with residual risk documented for the owner.",
  });

  const state = await readState();
  const updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.status, "user_review");
  assert.equal(updated.assignedAgentRole, "owner");
  const leadReview = state.reviews.find((review) => review.taskId === task.id && review.stageKey === "lead");
  assert.equal(leadReview?.outcome, "approved");
  assert.equal(leadReview?.subjectSha, SUBJECT_SHA);
  assert.equal(leadReview?.candidateCycle, 1);
  assert.match(leadReview?.body || "", /residual risk/);
});
