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

test("supervisor honors configured age promotion and project dispatch weight", () => {
  const state = {
    projects: [
      { id: "project_1", key: "one", name: "One", repoPath: "/tmp/one", wipPolicy: { agePromotionMs: 1_000, weight: 1 } },
      { id: "project_2", key: "two", name: "Two", repoPath: "/tmp/two", wipPolicy: { agePromotionMs: 60_000, weight: 4 } },
    ],
    tasks: [
      { id: "task_old", projectId: "project_1", title: "Old", type: "feature", status: "ready", priority: "medium", createdAt: "2026-08-17T00:00:00.000Z", dependsOnTaskIds: [] },
      { id: "task_weighted", projectId: "project_2", title: "Weighted", type: "feature", status: "ready", priority: "medium", createdAt: "2026-08-17T00:00:01.500Z", dependsOnTaskIds: [] },
    ],
    runs: [], reviews: [], comments: [], events: [],
  };
  const report = createSupervisorReport(state, { nowMs: Date.parse("2026-08-17T00:00:02.000Z") });
  assert.equal(report.actions[0].taskId, "task_old");
  assert.equal(report.actions[0].agePromotion, true);
  assert.equal(report.actions[1].projectWeight, 4);
});

test("weighted fairness accounts for recent service without starving age-promoted work", () => {
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  const state = {
    projects: [
      { id: "project_busy", key: "busy", name: "Busy", repoPath: "/tmp/busy", wipPolicy: { agePromotionMs: 60_000, weight: 1 } },
      { id: "project_waiting", key: "waiting", name: "Waiting", repoPath: "/tmp/waiting", wipPolicy: { agePromotionMs: 60_000, weight: 2 } },
    ],
    tasks: [
      { id: "task_busy", projectId: "project_busy", title: "Busy", type: "feature", status: "ready", priority: "high", createdAt: "2026-08-17T11:59:30.000Z", dependsOnTaskIds: [] },
      { id: "task_waiting", projectId: "project_waiting", title: "Waiting", type: "feature", status: "ready", priority: "medium", createdAt: "2026-08-17T11:59:30.000Z", dependsOnTaskIds: [] },
    ],
    runs: Array.from({ length: 4 }, (_, index) => ({ id: `run_busy_${index}`, projectId: "project_busy", createdAt: "2026-08-17T11:59:45.000Z" })),
    reviews: [], comments: [], events: [],
  };
  const report = createSupervisorReport(state, { nowMs });
  assert.equal(report.actions[0].taskId, "task_waiting");

  state.tasks[0].createdAt = "2026-08-17T11:58:00.000Z";
  const promoted = createSupervisorReport(state, { nowMs });
  assert.equal(promoted.actions[0].taskId, "task_busy");
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

  state.tasks.push({
    id: "task_2",
    projectId: "project_1",
    title: "Later QA task",
    type: "feature",
    status: "qa_review",
    dependsOnTaskIds: [],
  });
  const serialized = createSupervisorReport(state, { includeWaiting: true });
  const deferred = serialized.actions.find((action) => action.taskId === "task_2");
  assert.equal(deferred.type, "waiting_on_qa_integration_handoff");
  assert.match(deferred.reason, /task_1 integration PR/);

  state.tasks[0].integrationStatus = "checks_failed";
  state.tasks[0].integrationPrReviewDecision = "";
  state.tasks[0].integrationCheckState = { state: "failed", passed: 1, pending: 0, failed: 1 };
  state.tasks[0].integrationBlocker = "A required check failed.";
  const failed = createSupervisorReport(state);
  assert.equal(failed.actions[0].type, "qa_integration_blocked");
  assert.equal(failed.actions[0].role, "builder");

  state.tasks[0].integrationStatus = "changes_requested";
  state.tasks[0].integrationPrReviewDecision = "CHANGES_REQUESTED";
  state.tasks[0].integrationBlocker = "The integration PR has requested changes.";
  const requestedChanges = createSupervisorReport(state);
  assert.equal(requestedChanges.actions[0].type, "qa_integration_blocked");
  assert.equal(requestedChanges.actions[0].role, "builder");
});
