const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  leadReasoningEffort: "xhigh",
  complexReasoningEffort: "xhigh",
  maxAttempts: 2,
  retryBackoffMs: 5 * 60 * 1000,
  staleRunMs: 2 * 60 * 60 * 1000,
});

const COMPLEX_WORK_PATTERN = /\b(architecture|architectural|security|privacy|pii|consent|oauth|authentication|authorization|migration|schema|database|index|deployment|release|production|infrastructure|data loss)\b/i;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedEffort(value, fallback) {
  const effort = String(value || "").trim().toLowerCase();
  return VALID_REASONING_EFFORTS.has(effort) ? effort : fallback;
}

function taskText(task = {}) {
  return [
    task.title,
    task.type,
    task.area,
    task.userStory,
    task.expectedOutcome,
    ...(Array.isArray(task.labels) ? task.labels : []),
  ].filter(Boolean).join(" ");
}

export function resolveExecutionPolicy(task = {}, action = {}, input = {}) {
  const configured = {
    ...DEFAULT_EXECUTION_POLICY,
    ...(input.executionPolicy || input.policy || {}),
  };
  const role = String(action.role || task.assignedAgentRole || "builder").toLowerCase();
  const rolePolicy = configured.roles?.[role] || {};
  const complex = COMPLEX_WORK_PATTERN.test(taskText(task));
  const reasoningEffort = normalizedEffort(
    rolePolicy.reasoningEffort
      || (role.includes("lead") ? configured.leadReasoningEffort : "")
      || (complex ? configured.complexReasoningEffort : "")
      || configured.reasoningEffort,
    DEFAULT_EXECUTION_POLICY.reasoningEffort,
  );

  return {
    model: String(rolePolicy.model || configured.model || DEFAULT_EXECUTION_POLICY.model).trim(),
    reasoningEffort,
    maxAttempts: positiveInteger(rolePolicy.maxAttempts || configured.maxAttempts, DEFAULT_EXECUTION_POLICY.maxAttempts),
    retryBackoffMs: positiveInteger(rolePolicy.retryBackoffMs || configured.retryBackoffMs, DEFAULT_EXECUTION_POLICY.retryBackoffMs),
    staleRunMs: positiveInteger(rolePolicy.staleRunMs || configured.staleRunMs, DEFAULT_EXECUTION_POLICY.staleRunMs),
    selectionReason: role.includes("lead") ? "lead_role" : complex ? "complex_task" : "default_role",
  };
}

export function executionAttemptKey(task, action) {
  const key = [
    task.id,
    Number(task.reviewCycle || 0),
    action.type,
    action.role || "builder",
  ];
  const epoch = Number(task.automationAttemptEpoch || 0);
  if (epoch > 0) key.push(`epoch-${epoch}`);
  return key.join(":");
}
