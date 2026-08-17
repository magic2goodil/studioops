import assert from "node:assert/strict";
import test from "node:test";
import {
  addProject,
  addTask,
  applyLifecycleTransitionInState,
  capabilityRoutingForTask,
  completionEvidenceForTask,
  dependencyGraphErrors,
  evaluateTaskReadiness,
  updateTask,
} from "../src/store.js";

const SHA = "a".repeat(40);

function readyInput(projectId, overrides = {}) {
  return {
    project: projectId,
    title: "Bounded delivery policy fixture",
    status: "ready",
    architectureRequired: false,
    userStory: "As an owner, I want dispatch to start only complete work.",
    expectedOutcome: "A worker receives an executable task contract.",
    acceptanceCriteria: ["The behavior is proven."],
    workAreas: ["src/policy.js"],
    affectedSurfaces: ["delivery policy"],
    validationPlan: ["npm run check"],
    riskClassification: "medium",
    privacyNotes: "Not applicable; no personal data is processed.",
    securityNotes: "No privilege boundary changes.",
    dependsOnTaskIds: [],
    ...overrides,
  };
}

test("new ready tasks validate themselves in the dependency graph and require nonempty collections", async () => {
  const project = await addProject({ key: "ready-policy", name: "Ready policy" });
  const task = await addTask(readyInput(project.id));
  assert.equal(task.status, "ready");
  assert.equal(evaluateTaskReadiness(task, { tasks: [task] }).ready, true);

  await assert.rejects(
    addTask(readyInput(project.id, { title: "Missing criteria", acceptanceCriteria: [] })),
    /acceptanceCriteria/,
  );
  await assert.rejects(
    addTask(readyInput(project.id, { title: "Missing validation", validationPlan: [] })),
    /validationPlan/,
  );
});

test("dependency validation rejects cycles and cross-project edges", async () => {
  const one = await addProject({ key: "dag-one", name: "DAG one" });
  const two = await addProject({ key: "dag-two", name: "DAG two" });
  const first = await addTask({ project: one.id, title: "First", status: "idea" });
  const second = await addTask({ project: one.id, title: "Second", status: "idea", dependsOnTaskIds: [first.id] });
  const foreign = await addTask({ project: two.id, title: "Foreign", status: "idea" });

  await assert.rejects(updateTask(first.id, { dependsOnTaskIds: [second.id] }), /Dependency cycle/);
  await assert.rejects(updateTask(first.id, { dependsOnTaskIds: [foreign.id] }), /Cross-project dependency/);
  assert.equal(dependencyGraphErrors({ tasks: [first, second] }, first).length, 0);
});

test("done evidence is exact-SHA bound and status labels are not receipts", () => {
  const task = {
    id: "task_1",
    projectId: "project_1",
    type: "feature",
    status: "deployed",
    reviewSubjectSha: SHA,
    reviewSubjectCycle: 1,
    reviewCycle: 1,
    candidateIdentity: { commitSha: SHA, candidateCycle: 1 },
  };
  const reviews = ["backend", "frontend", "accessibility", "lead"].map((stageKey, index) => ({
    id: `review_${index}`,
    taskId: task.id,
    stageKey,
    outcome: "approved",
    cycle: 1,
    subjectSha: SHA,
    candidateCycle: 1,
  }));
  const state = { projects: [{ id: "project_1", workflowMode: "github" }], reviews };
  assert.deepEqual(completionEvidenceForTask(state, task).missing, ["merge", "verification"]);

  task.mergeEvidence = { id: "merge_1", subjectSha: SHA, mergeCommit: "b".repeat(40) };
  task.verificationEvidence = { id: "qa_1", subjectSha: SHA, recordedAt: "2026-08-17T00:00:00.000Z" };
  assert.equal(completionEvidenceForTask(state, task).complete, true);
  task.verificationEvidence.subjectSha = "c".repeat(40);
  assert.equal(completionEvidenceForTask(state, task).complete, false);
});

test("the authoritative lifecycle path refuses done without exact immutable receipts", () => {
  const task = {
    id: "task_done",
    projectId: "project_done",
    title: "Finish only with evidence",
    type: "feature",
    status: "merged",
    stateVersion: 4,
    assignedAgentRole: "owner",
    reviewCycle: 1,
    reviewSubjectCycle: 1,
    reviewSubjectSha: SHA,
  };
  const command = {
    action: "finish_task",
    taskId: task.id,
    expectedStateVersion: task.stateVersion,
    actorContext: { actorId: "owner", actorType: "owner", role: "owner", trusted: true },
    evidence: { targetStatus: "done", candidateCycle: 1, subjectSha: SHA },
  };
  const state = {
    projects: [{ id: task.projectId, workflowMode: "github" }],
    tasks: [task],
    runs: [], reviews: [], candidates: [], comments: [], events: [],
  };
  assert.throws(() => applyLifecycleTransitionInState(state, command), /complete immutable evidence/);

  state.reviews = ["backend", "frontend", "accessibility", "lead"].map((stageKey, index) => ({
    id: `review_done_${index}`,
    taskId: task.id,
    stageKey,
    outcome: "approved",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: SHA,
  }));
  task.mergeEvidence = { id: "merge_done", subjectSha: SHA };
  task.verificationEvidence = { id: "verify_done", subjectSha: SHA };
  const result = applyLifecycleTransitionInState(state, command);
  assert.equal(result.task.status, "done");
  assert.equal(result.decision.evidence.completionEvidence.complete, true);
});

test("standard delivery routes only applicable reviewer capabilities and fails closed on unknown impact", () => {
  const backend = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "standard" } },
    { reviewSubjectSha: SHA, reviewSubjectCycle: 1, impactEvidence: { changedFiles: ["src/store.js"], impact: ["backend"] } },
  );
  assert.deepEqual(backend.required, ["backend", "lead"]);
  assert.deepEqual(backend.skipped.map((item) => item.stageKey), ["frontend", "accessibility"]);

  const unknown = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "standard" } },
    { reviewSubjectSha: SHA, reviewSubjectCycle: 1, impactEvidence: { changedFiles: ["unclassified.xyz"], impact: [] } },
  );
  assert.deepEqual(unknown.required, ["backend", "frontend", "accessibility", "lead"]);
});
