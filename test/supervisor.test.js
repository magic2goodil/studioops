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
