import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_ACTION_MATRIX,
  evaluateLifecycleTransition,
} from "../src/lifecycle-policy.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { applyLifecycleTransitionInState } from "../src/store.js";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const SHA = "a".repeat(40);

function builderFixture() {
  const workflowLease = {
    id: "lease_builder_1",
    expiresAt: new Date(NOW + 60_000).toISOString(),
  };
  const task = {
    id: "task_1",
    projectId: "project_1",
    title: "Versioned transition",
    status: "in_progress",
    stateVersion: 3,
    assignedAgentRole: "builder",
    reviewCycle: 0,
    reviewSubjectCycle: 0,
    reviewSubjectSha: "",
  };
  const run = {
    id: "run_1",
    taskId: task.id,
    role: "builder",
    status: "running",
    workflowLease,
  };
  const command = {
    action: "submit_builder_review",
    taskId: task.id,
    expectedStateVersion: 3,
    actorContext: {
      actorId: "builder-app-7",
      actorType: "worker",
      role: "builder",
      runId: run.id,
      leaseId: workflowLease.id,
      trusted: true,
      bearerToken: "must-not-be-audited",
    },
    evidence: {
      targetStatus: "builder_review",
      candidateCycle: 1,
      subjectSha: SHA,
    },
  };
  return { task, run, command };
}

function candidateFixture() {
  return createCandidateEnvelope({
    createdAt: "2026-08-17T11:00:00.000Z",
    qaBundleId: "qa_bundle_1",
    manifest: {
      candidateId: "candidate_1",
      projectId: "project_1",
      base: { branch: "main", sha: "b".repeat(40) },
      sources: [{
        taskId: "task_1", sourceRef: "refs/heads/codex/task-1", headSha: SHA, candidateCycle: 2,
        reviews: [{
          id: "review_1", stageKey: "lead", role: "lead-reviewer", outcome: "approved",
          subjectSha: SHA, candidateCycle: 2, reviewedAt: "2026-08-17T10:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-1", sha: "c".repeat(40) },
      checks: [{
        id: "check_1", kind: "full-regression", name: "npm run check", outcome: "passed",
        subjectSha: "c".repeat(40), evidenceDigest: `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4317/", status: "healthy", commitSha: "c".repeat(40),
        verifiedAt: "2026-08-17T11:00:00.000Z",
        attestation: { kind: "header", key: "x-studioops-commit", observedSha: "c".repeat(40) },
      },
      assembly: { mode: "atomic", requestedTaskIds: ["task_1"], includedTaskIds: ["task_1"], excludedTaskIds: [] },
    },
  });
}

test("the action matrix is explicit and every status participates in a fail-closed edge", () => {
  assert.equal(Object.isFrozen(LIFECYCLE_ACTION_MATRIX), true);
  for (const [action, entry] of Object.entries(LIFECYCLE_ACTION_MATRIX)) {
    assert.ok(action);
    assert.ok(entry.from.length, `${action} needs from states`);
    assert.ok(entry.to.length, `${action} needs to states`);
    assert.ok(entry.edges.length, `${action} needs explicit edges`);
    assert.ok(entry.actorTypes.length, `${action} needs actor types`);
    assert.ok(entry.roles.length, `${action} needs roles`);
    assert.ok(entry.actors.length, `${action} needs actor type/role pairs`);
    assert.equal(typeof entry.assignment, "string");
    assert.equal(typeof entry.activeRun, "boolean");
    assert.equal(typeof entry.workflowLease, "boolean");
    assert.equal(typeof entry.candidateCycle, "boolean");
    assert.equal(typeof entry.subjectBinding, "string");
    assert.ok(Array.isArray(entry.invalidates));
  }
});

test("a valid transition is pure and increments the aggregate version exactly once", () => {
  const { task, run, command } = builderFixture();
  const result = evaluateLifecycleTransition(command, task, { runs: [run], candidates: [], nowMs: NOW });
  assert.equal(task.status, "in_progress");
  assert.equal(task.stateVersion, 3);
  assert.equal(result.task.status, "builder_review");
  assert.equal(result.task.stateVersion, 4);
  assert.equal(result.task.reviewCycle, 1);
  assert.equal(result.task.reviewSubjectCycle, 1);
  assert.equal(result.task.reviewSubjectSha, SHA);
  assert.deepEqual({
    action: result.decision.action,
    from: result.decision.from,
    to: result.decision.to,
    fromVersion: result.decision.fromVersion,
    toVersion: result.decision.toVersion,
    role: result.decision.actor.role,
    runId: result.decision.actor.runId,
    leaseId: result.decision.actor.leaseId,
  }, {
    action: "submit_builder_review",
    from: "in_progress",
    to: "builder_review",
    fromVersion: 3,
    toVersion: 4,
    role: "builder",
    runId: "run_1",
    leaseId: "lease_builder_1",
  });
});

test("stale, untrusted, unassigned, wrong-role, wrong-run, expired-lease, wrong-cycle, wrong-SHA, and prohibited edges fail closed", () => {
  const cases = [
    ["stale", ({ command }) => { command.expectedStateVersion = 2; }, /Stale lifecycle command/],
    ["untrusted", ({ command }) => { command.actorContext.trusted = false; }, /not trusted/],
    ["unassigned", ({ task }) => { task.assignedAgentRole = "someone-else"; }, /not assigned/],
    ["wrong role", ({ command }) => { command.actorContext.role = "lead-reviewer"; }, /cannot perform/],
    ["mismatched actor pair", ({ command }) => { command.actorContext.actorType = "owner"; }, /cannot perform/],
    ["wrong run", ({ command }) => { command.actorContext.runId = "run_other"; }, /active task run/],
    ["expired lease", ({ run }) => { run.workflowLease.expiresAt = new Date(NOW - 1).toISOString(); }, /unexpired workflow lease/],
    ["wrong cycle", ({ command }) => { command.evidence.candidateCycle = 2; }, /does not match current cycle/],
    ["wrong SHA", ({ task, command, run }) => {
      task.status = "backend_review";
      task.assignedAgentRole = "backend-reviewer";
      task.reviewSubjectCycle = 1;
      task.reviewSubjectSha = SHA;
      command.action = "record_review_approval";
      command.actorContext.role = "backend-reviewer";
      command.evidence.targetStatus = "backend_review";
      command.evidence.subjectSha = "b".repeat(40);
      run.role = "backend-reviewer";
    }, /exact current subject SHA/],
    ["prohibited edge", ({ task }) => { task.status = "idea"; }, /prohibits idea -> builder_review/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const fixture = builderFixture();
    mutate(fixture);
    const before = structuredClone(fixture.task);
    assert.throws(
      () => evaluateLifecycleTransition(fixture.command, fixture.task, { runs: [fixture.run], candidates: [], nowMs: NOW }),
      pattern,
      label,
    );
    assert.deepEqual(fixture.task, before, `${label} mutated the aggregate`);
  }
});

test("QA transitions require the exact immutable candidate digest", () => {
  const candidate = candidateFixture();
  const task = {
    id: "task_1", status: "qa_review", stateVersion: 6, assignedAgentRole: "owner",
    reviewSubjectSha: SHA, reviewSubjectCycle: 2, candidateId: candidate.id,
  };
  const command = {
    action: "pass_qa",
    taskId: task.id,
    expectedStateVersion: 6,
    actorContext: {
      actorId: "local-owner", actorType: "owner", role: "owner", trusted: true,
      bearerToken: "must-not-be-audited",
    },
    evidence: {
      targetStatus: "approved_for_main", candidateCycle: 2, subjectSha: SHA,
      candidateId: candidate.id, manifestDigest: candidate.manifestDigest,
    },
  };
  assert.equal(evaluateLifecycleTransition(command, task, { candidates: [candidate], nowMs: NOW }).task.stateVersion, 7);
  assert.throws(
    () => evaluateLifecycleTransition({
      ...command,
      evidence: { ...command.evidence, manifestDigest: `sha256:${"e".repeat(64)}` },
    }, task, { candidates: [candidate], nowMs: NOW }),
    /immutable current candidate/,
  );
  assert.equal(task.stateVersion, 6);
});

test("owner override requires bounded justification and invalidates incompatible evidence without deleting history", () => {
  const candidate = candidateFixture();
  const state = {
    projects: [{ id: "project_1" }],
    tasks: [{
      id: "task_1", projectId: "project_1", title: "Override me", status: "qa_review", stateVersion: 8,
      assignedAgentRole: "owner", reviewSubjectSha: SHA, reviewSubjectCycle: 2,
      candidateId: candidate.id, qaBundleId: candidate.qaBundleId,
      qaDecision: { outcome: "passed" }, promotionStatus: "queued",
    }],
    runs: [],
    reviews: [{ id: "review_1", taskId: "task_1", outcome: "approved" }],
    candidates: [candidate],
    qaBundles: [{ id: "qa_bundle_1", status: "ready" }],
    events: [],
  };
  const base = {
    action: "owner_override",
    taskId: "task_1",
    expectedStateVersion: 8,
    actorContext: {
      actorId: "local-owner", actorType: "owner", role: "owner", trusted: true,
      bearerToken: "must-not-be-audited",
    },
    evidence: { targetStatus: "needs_changes" },
  };
  assert.throws(() => applyLifecycleTransitionInState(structuredClone(state), base, { nowMs: NOW }), /reasonCode/);
  const result = applyLifecycleTransitionInState(state, {
    ...base,
    evidence: {
      ...base.evidence,
      reasonCode: "accept_residual_risk",
      reason: "The candidate must return to the builder after an owner-only exception.",
      risk: "Prior approvals are no longer compatible with the requested state.",
    },
  }, { nowMs: NOW });
  assert.equal(result.task.status, "needs_changes");
  assert.equal(result.task.stateVersion, 9);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.candidates[0].status, "invalidated");
  assert.equal(state.qaBundles[0].status, "invalidated");
  assert.equal(result.task.candidateId, "");
  assert.deepEqual(result.decision.invalidationIds.sort(), ["candidate_1", "qa_bundle_1", "review_1"]);
  const event = state.events.at(-1);
  assert.equal(event.actor.role, "owner");
  assert.equal(JSON.stringify(event).includes("must-not-be-audited"), false);
});
