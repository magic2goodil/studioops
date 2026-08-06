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
import { completeRun } from "../src/runner.js";

const SUBJECT_SHA = "a".repeat(40);
const REVIEWER_FIX_SHA = "b".repeat(40);

test("cycle-limit backend rejection can be finalized by lead rejection for the exact candidate", async () => {
  const project = await addProject({
    key: "cycle-limit-lead-rejection",
    name: "Cycle-limit lead rejection",
    repoPath: "/tmp/cycle-limit-lead-rejection",
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
    title: "Cycle-limit review decision",
    status: "in_progress",
    type: "bug",
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/cycle-limit-lead-rejection",
    prUrl: "https://github.com/example/cycle-limit-lead-rejection/pull/1",
    subjectSha: SUBJECT_SHA,
  });
  await updateTask(task.id, { status: "needs_changes" });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/cycle-limit-lead-rejection",
    prUrl: "https://github.com/example/cycle-limit-lead-rejection/pull/1",
    subjectSha: SUBJECT_SHA,
  });

  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 2,
  });
  let state = await readState();
  let routed = state.tasks.find((item) => item.id === task.id);
  assert.equal(routed.status, "lead_review");
  assert.equal(routed.assignedAgentRole, "lead-reviewer");
  await updateTask(task.id, {
    status: "backend_review",
    assignedAgentRole: "backend-reviewer",
  });
  await assert.rejects(
    recordReview(task.id, {
      stage: "lead",
      outcome: "changes_requested",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 2,
    }),
    /Backend Review must approve candidate cycle 2/,
  );
  await updateTask(task.id, {
    status: "lead_review",
    assignedAgentRole: "lead-reviewer",
  });
  await assert.rejects(
    recordReview(task.id, {
      stage: "lead",
      outcome: "approved",
      subjectSha: SUBJECT_SHA,
      candidateCycle: 2,
    }),
    /Backend Review must approve candidate cycle 2/,
  );
  await recordReview(task.id, {
    stage: "lead",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 2,
  });

  state = await readState();
  const updated = state.tasks.find((item) => item.id === task.id);
  const leadReview = state.reviews.find((review) => review.taskId === task.id && review.stageKey === "lead");
  assert.equal(updated.status, "user_review");
  assert.equal(updated.assignedAgentRole, "owner");
  assert.equal(leadReview.candidateCycle, 2);
  assert.equal(leadReview.subjectSha, SUBJECT_SHA);

  state.runs.push({
    id: "run_cycle_limit_lead",
    taskId: task.id,
    projectId: project.id,
    group: "reviewer",
    role: "lead-reviewer",
    actionType: "continue_review",
    status: "running",
    candidateCycle: 2,
    reviewSubjectSha: SUBJECT_SHA,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const completed = await completeRun("run_cycle_limit_lead", {
    state,
    status: "completed",
  });
  assert.equal(completed.status, "completed");
  assert.doesNotMatch(completed.notes, /review_outcome_missing/);
});

test("cycle-limit lead rejection remains blocked when only an optional lane rejected", async () => {
  const project = await addProject({
    key: "optional-lane-lead-rejection",
    name: "Optional lane lead rejection",
    repoPath: "/tmp/optional-lane-lead-rejection",
    reviewPipeline: [
      { key: "backend", label: "Backend Review", role: "backend-reviewer", status: "backend_review", required: true },
      { key: "advisory", label: "Advisory Review", role: "advisory-reviewer", status: "advisory_review", required: false },
      { key: "frontend", label: "Frontend Review", role: "frontend-reviewer", status: "frontend_review", required: true },
      { key: "lead", label: "Primary Lead Review", role: "lead-reviewer", status: "lead_review", required: true },
    ],
    reviewPolicy: { maxBuilderReviewCycles: 2, leadOwnsFinalDecisionAtLimit: true },
  });
  const task = await addTask({ project: project.id, title: "Optional lane cannot unlock lead", status: "in_progress", type: "bug" });
  await updateTask(task.id, { status: "builder_review", branchName: "codex/optional-lane-lead-rejection", prUrl: "https://github.com/example/optional-lane-lead-rejection/pull/1", subjectSha: SUBJECT_SHA });
  await updateTask(task.id, { status: "needs_changes" });
  await updateTask(task.id, { status: "builder_review", branchName: "codex/optional-lane-lead-rejection", prUrl: "https://github.com/example/optional-lane-lead-rejection/pull/1", subjectSha: SUBJECT_SHA });
  await recordReview(task.id, { stage: "backend", outcome: "approved", subjectSha: SUBJECT_SHA, candidateCycle: 2 });
  await recordReview(task.id, { stage: "advisory", outcome: "changes_requested", subjectSha: SUBJECT_SHA, candidateCycle: 2 });

  await assert.rejects(
    recordReview(task.id, { stage: "lead", outcome: "changes_requested", subjectSha: SUBJECT_SHA, candidateCycle: 2 }),
    /Frontend Review must approve candidate cycle 2/,
  );
});

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
