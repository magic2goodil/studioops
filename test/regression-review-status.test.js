import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/dispatcher.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { normalizeReviewPipeline } from "../src/store.js";

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

test("dispatcher skips actions generated for an older task status", () => {
  const state = fixtureState({ status: "lead_review" });
  const report = planDispatches(state, [{
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
  }]);

  assert.equal(report.selected.length, 0);
  assert.equal(report.skipped[0].reason, "task_status_changed:regression_review->lead_review");
});
