import assert from "node:assert/strict";
import test from "node:test";
import { compactPromptPacket, executionAttemptKey, normalizeExecutionUsage, resolveExecutionPolicy } from "../src/execution-policy.js";

test("usage accounting keeps cached context visible without double-counting token volume or guessing credits", () => {
  assert.deepEqual(normalizeExecutionUsage({
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 25,
    reasoning_output_tokens: 10,
  }), {
    rawInputTokens: 100,
    inputTokens: 100,
    uncachedInputTokens: 20,
    cachedInputTokens: 80,
    outputTokens: 25,
    reasoningOutputTokens: 10,
    rawTotalTokens: 125,
    effectiveBudgetTokens: 45,
    actualTokens: 125,
    actualCredits: null,
    authoritativeCreditStatus: "unavailable",
    creditTelemetryStatus: "unavailable",
  });
});

test("effective usage excludes cached input while retaining raw replay volume", () => {
  const usage = normalizeExecutionUsage({
    input_tokens: 2_371_308,
    cached_input_tokens: 2_256_384,
    output_tokens: 8_798,
    actual_credits: 4.5,
  });
  assert.equal(usage.rawTotalTokens, 2_380_106);
  assert.equal(usage.cachedInputTokens, 2_256_384);
  assert.equal(usage.uncachedInputTokens, 114_924);
  assert.equal(usage.effectiveBudgetTokens, 123_722);
  assert.equal(usage.authoritativeCreditStatus, "recorded");
});

test("provider credit status stays unavailable when credit telemetry is missing", () => {
  const usage = normalizeExecutionUsage({ input_tokens: 12, output_tokens: 3 });
  assert.equal(usage.actualCredits, null);
  assert.equal(usage.authoritativeCreditStatus, "unavailable");
});

test("oversized prompt packets are compacted deterministically", () => {
  const packet = ("header\n" + "x".repeat(200) + "\nfooter");
  const first = compactPromptPacket(packet, 80);
  const second = compactPromptPacket(packet, 80);
  assert.equal(first.compacted, true);
  assert.equal(first.prompt.length, 80);
  assert.equal(first.prompt, second.prompt);
});

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

test("tiered routing keeps risky work on Sol while using Luna and Terra for routine lanes", () => {
  const executionPolicy = {
    modelTiers: {
      economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      balanced: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
    tierRouting: {
      defaultTier: "economy",
      architectTier: "critical",
      leadTier: "critical",
      complexTier: "critical",
    },
    roles: {
      "frontend-reviewer": {
        tier: "balanced",
      },
    },
  };
  const builder = resolveExecutionPolicy(
    { id: "task_5", title: "Polish event card spacing" },
    { type: "start_builder", role: "builder" },
    { executionPolicy },
  );
  const reviewer = resolveExecutionPolicy(
    { id: "task_6", title: "Review event card spacing" },
    { type: "start_review", role: "frontend-reviewer" },
    { executionPolicy },
  );
  const risky = resolveExecutionPolicy(
    { id: "task_7", title: "Migrate the customer database schema" },
    { type: "start_builder", role: "builder" },
    { executionPolicy },
  );

  assert.equal(builder.model, "gpt-5.6-luna");
  assert.equal(builder.modelTier, "economy");
  assert.equal(builder.reasoningEffort, "medium");
  assert.equal(reviewer.model, "gpt-5.6-terra");
  assert.equal(reviewer.modelTier, "balanced");
  assert.equal(reviewer.reasoningEffort, "high");
  assert.equal(reviewer.selectionReason, "role_policy");
  assert.equal(risky.model, "gpt-5.6-sol");
  assert.equal(risky.reasoningEffort, "high");
  assert.equal(risky.selectionReason, "complex_task");
});

test("exact routine documentation uses proportionate lead review while security documentation remains critical", () => {
  const executionPolicy = {
    modelTiers: {
      balanced: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
    tierRouting: {
      defaultTier: "balanced",
      leadTier: "critical",
      complexTier: "critical",
      routineReviewTier: "balanced",
    },
  };
  const routine = resolveExecutionPolicy(
    {
      id: "task_docs",
      title: "Clarify contributor wording",
      impactEvidence: {
        unknown: false,
        changedFiles: ["docs/contributing.md", "README.md"],
      },
    },
    { type: "start_review", role: "lead-reviewer" },
    { executionPolicy },
  );
  const risky = resolveExecutionPolicy(
    {
      id: "task_security_docs",
      title: "Document OAuth deployment security",
      impactEvidence: {
        unknown: false,
        changedFiles: ["docs/oauth.md"],
      },
    },
    { type: "start_review", role: "lead-reviewer" },
    { executionPolicy },
  );

  assert.equal(routine.modelTier, "balanced");
  assert.equal(routine.model, "gpt-5.6-terra");
  assert.equal(routine.selectionReason, "proportionate_exact_diff");
  assert.equal(risky.modelTier, "critical");
  assert.equal(risky.model, "gpt-5.6-sol");
  assert.equal(risky.selectionReason, "lead_role");
});

test("Spark requires an explicit mechanical label and never overrides risky work", () => {
  const executionPolicy = {
    modelTiers: {
      mechanical: { model: "gpt-5.3-codex-spark", reasoningEffort: "high" },
      economy: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      frontier: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    },
    tierRouting: {
      defaultTier: "economy",
      mechanicalTier: "mechanical",
      complexTier: "critical",
      escalationTier: "frontier",
    },
    mechanicalLabels: ["spark-ok"],
    escalationLabels: ["ultra-review"],
  };
  const mechanical = resolveExecutionPolicy(
    { id: "task_8", title: "Format generated documentation", labels: ["spark-ok"] },
    { type: "start_builder", role: "builder" },
    { executionPolicy },
  );
  const risky = resolveExecutionPolicy(
    { id: "task_9", title: "Format OAuth migration documentation", labels: ["spark-ok"] },
    { type: "start_builder", role: "builder" },
    { executionPolicy },
  );
  const reviewer = resolveExecutionPolicy(
    { id: "task_10", title: "Review generated documentation", labels: ["spark-ok"] },
    { type: "start_review", role: "frontend-reviewer" },
    { executionPolicy },
  );
  const escalated = resolveExecutionPolicy(
    { id: "task_11", title: "Investigate a subtle rendering bug", labels: ["ultra-review"] },
    { type: "start_builder", role: "builder" },
    { executionPolicy },
  );

  assert.equal(mechanical.model, "gpt-5.3-codex-spark");
  assert.equal(mechanical.modelTier, "mechanical");
  assert.equal(mechanical.reasoningEffort, "high");
  assert.equal(mechanical.selectionReason, "mechanical_task");
  assert.equal(risky.model, "gpt-5.6-sol");
  assert.equal(risky.selectionReason, "complex_task");
  assert.equal(reviewer.model, "gpt-5.6-luna");
  assert.equal(reviewer.selectionReason, "default_role");
  assert.equal(escalated.model, "gpt-5.6-sol");
  assert.equal(escalated.modelTier, "frontier");
  assert.equal(escalated.reasoningEffort, "ultra");
  assert.equal(escalated.selectionReason, "explicit_escalation");
});

test("Ultra escalation overrides ordinary tier effort while explicit task budgets remain authoritative", () => {
  const executionPolicy = {
    ultraReasoningEffort: "ultra",
    escalationLabels: ["ultra-review"],
    modelTiers: {
      frontier: { model: "gpt-5.6-sol", reasoningEffort: "high", tokenBudget: 180000 },
    },
    tierRouting: { defaultTier: "frontier", escalationTier: "frontier" },
  };
  const escalated = resolveExecutionPolicy(
    { id: "task_ultra", title: "Review trust boundary", labels: ["ultra-review"] },
    { type: "start_review", role: "lead-reviewer" },
    { executionPolicy },
  );
  assert.equal(escalated.reasoningEffort, "ultra");
  assert.equal(escalated.tokenBudget, 180000);

  const overridden = resolveExecutionPolicy(
    { id: "task_override", title: "Bounded review", labels: ["ultra-review"], reasoningEffort: "xhigh", tokenBudget: 42000, costBudget: 7 },
    { type: "start_review", role: "lead-reviewer" },
    { executionPolicy },
  );
  assert.equal(overridden.reasoningEffort, "xhigh");
  assert.equal(overridden.tokenBudget, 42000);
  assert.equal(overridden.costBudget, 7);
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
