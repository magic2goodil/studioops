import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSupervisorActions, planDispatches } from "../src/dispatcher.js";
import { planRunnableRuns } from "../src/runner.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { generatePrompt, normalizeReviewPipeline } from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);
const REVIEWER_FIX_SHA = "b".repeat(40);

function fixtureState(taskPatch = {}, reviews = []) {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      reviewPipeline: [
        {
          key: "regression",
          label: "Regression QA",
          role: "qa-reviewer",
          status: "regression_review",
          required: true,
          description: "Run the release regression checklist against the exact candidate commit.",
        },
        {
          key: "lead",
          label: "Primary Lead Review",
          role: "lead-reviewer",
          status: "lead_review",
          required: true,
        },
      ],
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Review candidate",
      type: "feature",
      status: "builder_review",
      priority: "high",
      branchName: "codex/demo-task_1",
      prUrl: "https://github.com/example/demo/pull/1",
      reviewCycle: 1,
      ...taskPatch,
    }],
    runs: [],
    reviews,
    comments: [],
    events: [],
  };
}

test("automated regression review has a distinct state before lead review", () => {
  const state = fixtureState();
  const report = createSupervisorReport(state);

  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "qa-reviewer");
  assert.equal(report.actions[0].nextStatus, "regression_review");
});

test("human local QA is not interpreted as an automated regression stage", () => {
  const state = fixtureState({
    status: "qa_review",
    assignedAgentRole: "owner",
    integrationStatus: "ready",
  });
  state.projects[0].reviewPolicy = {
    trustLeadApprovals: true,
    integrationBranch: "qa/demo",
  };

  const report = createSupervisorReport(state);

  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "qa_bundle_ready");
  assert.equal(report.actions[0].role, "owner");
});

test("review pipelines reject the human QA status", () => {
  assert.throws(
    () => normalizeReviewPipeline([{
      key: "regression",
      label: "Regression QA",
      role: "qa-reviewer",
      status: "qa_review",
    }]),
    /reserved for human local QA/,
  );
});

test("regression reviewer prompts preserve the custom stage and checklist", () => {
  const state = fixtureState({ status: "regression_review" });
  const prompt = generatePrompt(state, "task_1", "qa-reviewer");

  assert.match(prompt, /You are the Regression QA reviewer/);
  assert.match(prompt, /Run the release regression checklist against the exact candidate commit/);
  assert.match(prompt, /--stage regression/);
  assert.doesNotMatch(prompt, /--stage lead/);
  assert.match(prompt, /missing, skipped, stale, fixture-only/);
});

test("dispatcher skips actions generated for an older task status without creating a run", async () => {
  const state = fixtureState({ status: "lead_review" });
  const action = {
    id: "task_1:continue_review",
    type: "continue_review",
    role: "qa-reviewer",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_1",
    taskTitle: "Review candidate",
    taskStatus: "regression_review",
    priority: "high",
    reason: "Regression review has not recorded an outcome.",
  };
  const plan = planDispatches(state, [action]);
  const dispatch = await dispatchSupervisorActions([action], { state });

  assert.equal(plan.selected.length, 0);
  assert.equal(plan.skipped[0].reason, "task_status_changed:regression_review->lead_review");
  assert.equal(dispatch.runs.length, 0);
  assert.equal(state.runs.length, 0);
});

test("repeated automation sweeps create one regression run and no local-QA reviewer runs", async () => {
  const regressionState = fixtureState();

  for (let sweep = 0; sweep < 3; sweep += 1) {
    const supervisor = createSupervisorReport(regressionState);
    await dispatchSupervisorActions(supervisor.actions, { state: regressionState });
    planRunnableRuns(regressionState, { limit: 3 });
  }

  assert.equal(regressionState.tasks[0].status, "regression_review");
  assert.equal(regressionState.runs.length, 1);
  assert.equal(regressionState.runs[0].role, "qa-reviewer");
  assert.equal(planRunnableRuns(regressionState, { limit: 3 }).runnable.length, 1);

  const localQaState = fixtureState({
    status: "qa_review",
    assignedAgentRole: "owner",
    integrationStatus: "ready",
  });
  localQaState.projects[0].reviewPolicy = {
    trustLeadApprovals: true,
    integrationBranch: "qa/demo",
  };

  for (let sweep = 0; sweep < 3; sweep += 1) {
    const supervisor = createSupervisorReport(localQaState);
    assert.equal(supervisor.actions[0].type, "qa_bundle_ready");
    await dispatchSupervisorActions(supervisor.actions, { state: localQaState });
    assert.equal(planRunnableRuns(localQaState, { limit: 3 }).runnable.length, 0);
  }

  assert.equal(localQaState.tasks[0].status, "qa_review");
  assert.equal(localQaState.tasks[0].assignedAgentRole, "owner");
  assert.equal(localQaState.runs.length, 0);
});

test("supervisor restarts the earliest exact-SHA lane despite stale duplicate approvals", () => {
  const state = fixtureState({
    status: "accessibility_review",
    reviewSubjectSha: REVIEWER_FIX_SHA,
    reviewSubjectCycle: 2,
  }, [
    {
      id: "review_1",
      taskId: "task_1",
      stageKey: "backend",
      role: "backend-reviewer",
      cycle: 1,
      candidateCycle: 1,
      subjectSha: SUBJECT_SHA,
      outcome: "approved",
      createdAt: "2026-07-26T10:00:00.000Z",
    },
    {
      id: "review_2",
      taskId: "task_1",
      stageKey: "backend",
      role: "backend-reviewer",
      cycle: 1,
      candidateCycle: 1,
      subjectSha: SUBJECT_SHA,
      outcome: "approved",
      createdAt: "2026-07-26T10:01:00.000Z",
    },
    {
      id: "review_3",
      taskId: "task_1",
      stageKey: "frontend",
      role: "frontend-reviewer",
      cycle: 1,
      candidateCycle: 2,
      subjectSha: REVIEWER_FIX_SHA,
      outcome: "approved",
      createdAt: "2026-07-26T10:02:00.000Z",
    },
  ]);
  state.projects[0].reviewPipeline = [
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
  ];

  const report = createSupervisorReport(state);

  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "backend-reviewer");
  assert.equal(report.actions[0].nextStatus, "backend_review");
  assert.equal(report.actions[0].reviewSubjectSha, REVIEWER_FIX_SHA);
  assert.equal(report.actions[0].candidateCycle, 2);
  assert.match(report.actions[0].reason, /later review and owner\/QA handoff are blocked/);
});

test("dispatcher rejects stale identity and later-lane actions for an incomplete candidate", () => {
  const state = fixtureState({
    status: "backend_review",
    reviewSubjectSha: REVIEWER_FIX_SHA,
    reviewSubjectCycle: 2,
  }, [
    {
      id: "review_1",
      taskId: "task_1",
      stageKey: "backend",
      role: "backend-reviewer",
      cycle: 1,
      candidateCycle: 1,
      subjectSha: SUBJECT_SHA,
      outcome: "approved",
      createdAt: "2026-07-26T10:00:00.000Z",
    },
  ]);
  state.projects[0].reviewPipeline = [
    {
      key: "backend",
      label: "Backend Review",
      role: "backend-reviewer",
      status: "backend_review",
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
  ];
  const actionBase = {
    id: "task_1:start_review",
    type: "start_review",
    projectId: "project_1",
    projectKey: "demo",
    projectName: "Demo",
    taskId: "task_1",
    taskTitle: "Review candidate",
    taskStatus: "backend_review",
    priority: "high",
  };

  const staleIdentity = planDispatches(state, [{
    ...actionBase,
    role: "backend-reviewer",
    nextStatus: "backend_review",
    reviewSubjectSha: SUBJECT_SHA,
    candidateCycle: 1,
  }]);
  const laterLane = planDispatches(state, [{
    ...actionBase,
    role: "accessibility-reviewer",
    nextStatus: "accessibility_review",
    reviewSubjectSha: REVIEWER_FIX_SHA,
    candidateCycle: 2,
  }]);
  const ownerHandoff = planDispatches(state, [{
    ...actionBase,
    id: "task_1:notify_owner",
    type: "notify_owner",
    role: "owner",
    nextStatus: "user_review",
    reviewSubjectSha: REVIEWER_FIX_SHA,
    candidateCycle: 2,
  }]);

  assert.equal(staleIdentity.selected.length, 0);
  assert.equal(staleIdentity.skipped[0].reason, "review_subject_changed");
  assert.equal(laterLane.selected.length, 0);
  assert.equal(laterLane.skipped[0].reason, "earlier_review_incomplete:backend");
  assert.equal(ownerHandoff.selected.length, 0);
  assert.equal(ownerHandoff.skipped[0].reason, "earlier_review_incomplete:backend");
});
