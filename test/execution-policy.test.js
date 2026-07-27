import assert from "node:assert/strict";
import test from "node:test";
import { executionAttemptKey, resolveExecutionPolicy } from "../src/execution-policy.js";

test("execution policy pins Sol high reasoning for ordinary builder work", () => {
  const policy = resolveExecutionPolicy(
    { id: "task_1", title: "Improve event cards" },
    { type: "start_builder", role: "builder" },
  );

  assert.equal(policy.model, "gpt-5.6-sol");
  assert.equal(policy.reasoningEffort, "high");
  assert.equal(policy.maxAttempts, 2);
  assert.equal(policy.selectionReason, "default_role");
});

test("lead and security-sensitive work receive xhigh reasoning", () => {
  const lead = resolveExecutionPolicy(
    { id: "task_2", title: "Polish navigation" },
    { type: "start_review", role: "lead-reviewer" },
  );
  const security = resolveExecutionPolicy(
    { id: "task_3", title: "Harden OAuth and PII storage" },
    { type: "start_builder", role: "backend-builder" },
  );

  assert.equal(lead.reasoningEffort, "xhigh");
  assert.equal(lead.selectionReason, "lead_role");
  assert.equal(security.reasoningEffort, "xhigh");
  assert.equal(security.selectionReason, "complex_task");
});

test("architecture reasoning can be reduced by local execution policy", () => {
  const policy = resolveExecutionPolicy(
    { id: "task_4", title: "Review the system architecture" },
    { type: "start_architecture", role: "systems-architect" },
    {
      executionPolicy: {
        architectReasoningEffort: "high",
      },
    },
  );

  assert.equal(policy.reasoningEffort, "high");
  assert.equal(policy.selectionReason, "systems_architect_role");
});

test("execution attempts are scoped to workflow cycle, action, and role", () => {
  assert.equal(
    executionAttemptKey(
      { id: "task_4", reviewCycle: 2 },
      { type: "continue_review", role: "frontend-reviewer" },
    ),
    "task_4:2:continue_review:frontend-reviewer",
  );
});

test("reviewer execution attempts are scoped to exact candidate identity", () => {
  const oldCandidate = executionAttemptKey(
    {
      id: "task_5",
      reviewCycle: 2,
      reviewSubjectCycle: 3,
      reviewSubjectSha: "a".repeat(40),
    },
    { type: "continue_review", role: "frontend-reviewer" },
  );
  const newCandidate = executionAttemptKey(
    {
      id: "task_5",
      reviewCycle: 2,
      reviewSubjectCycle: 4,
      reviewSubjectSha: "b".repeat(40),
    },
    { type: "continue_review", role: "frontend-reviewer" },
  );

  assert.equal(
    oldCandidate,
    `task_5:2:candidate-3:sha-${"a".repeat(40)}:continue_review:frontend-reviewer`,
  );
  assert.notEqual(oldCandidate, newCandidate);
});
