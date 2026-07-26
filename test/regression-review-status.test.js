import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSupervisorActions, planDispatches } from "../src/dispatcher.js";
import { planRunnableRuns } from "../src/runner.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { generatePrompt, normalizeReviewPipeline } from "../src/store.js";

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
