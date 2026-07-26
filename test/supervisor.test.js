import assert from "node:assert/strict";
import test from "node:test";
import { planDispatches } from "../src/dispatcher.js";
import { createSupervisorReport } from "../src/supervisor.js";

function trackingState() {
  return {
    projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo" }],
    tasks: [
      {
        id: "task_epic",
        projectId: "project_1",
        title: "Tracking epic",
        type: "epic",
        status: "ready",
        dependsOnTaskIds: [],
      },
      {
        id: "task_parent",
        projectId: "project_1",
        title: "Tracking parent",
        type: "feature",
        status: "ready",
        dependsOnTaskIds: [],
      },
      {
        id: "task_child",
        projectId: "project_1",
        parentTaskId: "task_parent",
        title: "Child task",
        type: "feature",
        status: "idea",
        dependsOnTaskIds: [],
      },
      {
        id: "task_leaf",
        projectId: "project_1",
        title: "Executable leaf",
        type: "feature",
        status: "ready",
        dependsOnTaskIds: [],
      },
    ],
    runs: [],
    reviews: [],
    comments: [],
    events: [],
  };
}

test("epics and tasks with children never create builder actions or durable dispatches", () => {
  const state = trackingState();
  const report = createSupervisorReport(state);

  assert.deepEqual(report.actions.map((action) => action.taskId), ["task_leaf"]);
  assert.equal(report.actions[0].type, "start_builder");

  const dispatches = planDispatches(state, report.actions);
  assert.deepEqual(dispatches.selected.map((item) => item.taskId), ["task_leaf"]);
  assert.equal(dispatches.selected.some((item) => ["task_epic", "task_parent"].includes(item.taskId)), false);
});

test("supervisor tracks protected QA PRs and routes failed checks back to a builder", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: {
        trustLeadApprovals: true,
        integrationBranch: "qa/integration",
      },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Protected QA task",
      type: "bug",
      status: "qa_review",
      integrationStatus: "pr_waiting",
      integrationCandidateBranch: "studioops/qa-candidate/demo-abc123",
      integrationCandidateCommit: "abc123",
      integrationPrUrl: "https://github.com/example/demo/pull/42",
      integrationPrReviewDecision: "REVIEW_REQUIRED",
      integrationCheckState: { state: "passed", passed: 2, pending: 0, failed: 0 },
      integrationBlocker: "The integration PR is waiting for its required human review.",
      dependsOnTaskIds: [],
    }],
    runs: [],
    reviews: [],
    comments: [],
    events: [],
  };

  const waiting = createSupervisorReport(state);
  assert.equal(waiting.actions[0].type, "track_qa_integration_pr");
  assert.equal(waiting.actions[0].role, "owner");
  assert.equal(waiting.actions[0].integrationPrUrl, "https://github.com/example/demo/pull/42");
  assert.equal(waiting.actions[0].integrationCheckState.state, "passed");

  state.tasks[0].integrationStatus = "checks_failed";
  state.tasks[0].integrationPrReviewDecision = "";
  state.tasks[0].integrationCheckState = { state: "failed", passed: 1, pending: 0, failed: 1 };
  state.tasks[0].integrationBlocker = "A required check failed.";
  const failed = createSupervisorReport(state);
  assert.equal(failed.actions[0].type, "qa_integration_blocked");
  assert.equal(failed.actions[0].role, "builder");
});
