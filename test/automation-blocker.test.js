import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorReport } from "../src/supervisor.js";
import {
  addProject,
  addTask,
  automationTick,
  mutateState,
  readState,
  updateTask,
} from "../src/store.js";

function fixtureState(taskPatch = {}) {
  return {
    projects: [
      {
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath: "/tmp/demo",
      },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Review the design foundation",
        status: "blocked",
        dependsOnTaskIds: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        ...taskPatch,
      },
    ],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
  };
}

test("automation configuration blockers are not mistaken for completed dependencies", async () => {
  const state = fixtureState({
    assignedAgentRole: "owner",
    automationBlocker: {
      type: "configuration",
      reason: "invalid_github_app_credentials",
      runId: "run_1",
      resumeStatus: "lead_review",
      blockedAt: "2026-07-20T10:00:00.000Z",
    },
  });

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, []);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].assignedAgentRole, "owner");
  assert.equal(state.tasks[0].automationBlocker.resumeStatus, "lead_review");

  const report = createSupervisorReport(state);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "repair_automation_config");
  assert.equal(report.actions[0].role, "owner");
  assert.equal(report.actions[0].nextStatus, "lead_review");
  assert.match(report.actions[0].reason, /invalid_github_app_credentials/);
});

test("explicit configuration repair clears stale retry suppression and assignment", async () => {
  const project = await addProject({ key: "config-repair", name: "Configuration repair" });
  const task = await addTask({
    project: project.id,
    title: "Resume after an output-policy repair",
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
    architectureDecision: "No architecture work is required for this bounded recovery fixture.",
    userStory: "As an operator, I want repaired work to resume without stale suppression.",
    expectedOutcome: "The repaired task is eligible for a fresh dispatch.",
    acceptanceCriteria: ["The old failure fingerprint is cleared."],
    workAreas: ["src/store.js"],
    affectedSurfaces: ["configuration recovery"],
    validationPlan: ["Run the isolated test suite."],
    riskClassification: "medium",
    privacyNotes: "No personal data.",
    securityNotes: "The repair remains an explicit owner action.",
    dependsOnTaskIds: [],
  });
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "blocked";
    stored.assignedAgentRole = "owner";
    stored.retryNotBefore = "2026-09-01T20:00:00.000Z";
    stored.lastAutomationFailure = "command_output_budget_exceeded";
    stored.lastAutomationFailureRunId = "run_old";
    stored.automationAttemptEpoch = 2;
    stored.automationBlocker = {
      type: "configuration",
      reason: "command_output_budget_exceeded",
      runId: "run_old",
      resumeStatus: "queued",
      blockedAt: "2026-09-01T18:00:00.000Z",
    };
  });

  await updateTask(task.id, { status: "queued" });
  const repaired = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(repaired.status, "queued");
  assert.equal(repaired.assignedAgentRole, "");
  assert.equal(repaired.retryNotBefore, "");
  assert.equal(repaired.lastAutomationFailure, "");
  assert.equal(repaired.lastAutomationFailureRunId, "");
  assert.equal(repaired.automationAttemptEpoch, 3);
  assert.equal(repaired.automationBlocker, undefined);
});

test("ordinary dependency blockers still return to the builder queue", async () => {
  const state = fixtureState();

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, ["task_1: unblocked"]);
  assert.equal(state.tasks[0].status, "queued");
});
