import assert from "node:assert/strict";
import test from "node:test";
import { successfulHandoffFailure } from "../src/runner.js";
import { createSupervisorReport, formatSupervisorReport } from "../src/supervisor.js";
import { automationTick } from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);

function fixtureState(projectPatch = {}, taskPatch = {}) {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      workflowMode: "local",
      reviewPipeline: [{
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      }],
      ...projectPatch,
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Local review subject",
      status: "builder_review",
      branchName: "codex/demo-local",
      prUrl: "",
      reviewCycle: 1,
      reviewSubjectSha: SUBJECT_SHA,
      ...taskPatch,
    }],
    reviews: [],
    comments: [],
    events: [],
    runs: [],
  };
}

test("local builder review routes without a PR and dispatches the reviewer lane", async () => {
  const state = fixtureState();
  const report = createSupervisorReport(state);

  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "backend-reviewer");
  assert.equal(report.actions[0].prUrl, "");
  assert.equal(report.actions[0].reviewSubjectSha, SUBJECT_SHA);

  const ownerStatus = formatSupervisorReport(report);
  assert.match(ownerStatus, new RegExp(`Branch: codex/demo-local`));
  assert.match(ownerStatus, new RegExp(`Review subject SHA: ${SUBJECT_SHA}`));
  assert.doesNotMatch(ownerStatus, /PR:/);

  await automationTick({ state });
  assert.equal(state.tasks[0].status, "backend_review");
  assert.equal(state.tasks[0].assignedAgentRole, "backend-reviewer");
});

test("GitHub builder review still rejects a missing PR URL", () => {
  const state = fixtureState({ workflowMode: "github" });
  const report = createSupervisorReport(state);

  assert.equal(report.actions[0].type, "return_to_builder");
  assert.equal(report.actions[0].nextStatus, "needs_changes");
  assert.match(report.actions[0].reason, /PR URL/);
});

test("local runner handoff requires the immutable full subject SHA", () => {
  const state = fixtureState();
  state.tasks[0].status = "in_progress";
  const run = { id: "run_1", group: "builder", workflowMode: "local" };

  assert.equal(successfulHandoffFailure(state, run, state.tasks[0]), "");
  state.tasks[0].reviewSubjectSha = SUBJECT_SHA.slice(0, 12);
  assert.equal(successfulHandoffFailure(state, run, state.tasks[0]), "builder_handoff_missing");
});

test("local automation rejects a malformed review subject SHA", async () => {
  const state = fixtureState({}, { reviewSubjectSha: SUBJECT_SHA.slice(0, 12) });
  const report = createSupervisorReport(state);

  assert.equal(report.actions[0].type, "return_to_builder");
  assert.match(report.actions[0].reason, /exact full subject SHA/);

  await automationTick({ state });
  assert.equal(state.tasks[0].status, "needs_changes");
  assert.match(state.comments[0].body, /exact full subject SHA/);
});
