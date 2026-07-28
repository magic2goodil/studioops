const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  architectReasoningEffort: "xhigh",
  leadReasoningEffort: "xhigh",
  complexReasoningEffort: "xhigh",
  mechanicalLabels: ["spark-ok"],
  escalationLabels: ["ultra-review"],
  modelTiers: {},
  tierRouting: {},
  maxAttempts: 2,
  retryBackoffMs: 30 * 1000,
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

function normalizedLabels(value) {
  const labels = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(labels.map((label) => String(label).trim().toLowerCase()).filter(Boolean));
}

function configuredTier(configured, name) {
  if (!name) return {};
  const tier = configured.modelTiers?.[name];
  return tier && typeof tier === "object" ? tier : {};
}

export function resolveExecutionPolicy(task = {}, action = {}, input = {}) {
  const configured = {
    ...DEFAULT_EXECUTION_POLICY,
    ...(input.executionPolicy || input.policy || {}),
  };
  const role = String(action.role || task.assignedAgentRole || "builder").toLowerCase();
  const rolePolicy = configured.roles?.[role] || {};
  const systemsArchitect = role.includes("architect");
  const lead = role.includes("lead");
  const complex = COMPLEX_WORK_PATTERN.test(taskText(task));
  const mechanicalLabels = normalizedLabels(configured.mechanicalLabels);
  const escalationLabels = normalizedLabels(configured.escalationLabels);
  const taskLabels = normalizedLabels(task.labels);
  const escalated = [...taskLabels].some((label) => escalationLabels.has(label));
  const mechanical = !systemsArchitect
    && !lead
    && !complex
    && role === "builder"
    && [...taskLabels].some((label) => mechanicalLabels.has(label));
  const routing = configured.tierRouting || {};
  const selectedTier = escalated
    ? routing.escalationTier
    : systemsArchitect
      ? routing.architectTier
      : lead
        ? routing.leadTier
        : complex
          ? routing.complexTier
          : mechanical
            ? routing.mechanicalTier
            : rolePolicy.tier || routing.defaultTier;
  const tierPolicy = configuredTier(configured, selectedTier);
  const reasoningEffort = normalizedEffort(
    tierPolicy.reasoningEffort
      || (systemsArchitect ? configured.architectReasoningEffort : "")
      || (lead ? configured.leadReasoningEffort : "")
      || (complex ? configured.complexReasoningEffort : "")
      || rolePolicy.reasoningEffort
      || configured.reasoningEffort,
    DEFAULT_EXECUTION_POLICY.reasoningEffort,
  );

  return {
    model: String(
      tierPolicy.model
        || (systemsArchitect ? DEFAULT_EXECUTION_POLICY.model : "")
        || rolePolicy.model
        || configured.model
        || DEFAULT_EXECUTION_POLICY.model,
    ).trim(),
    modelTier: String(selectedTier || "").trim(),
    reasoningEffort,
    maxAttempts: positiveInteger(rolePolicy.maxAttempts || configured.maxAttempts, DEFAULT_EXECUTION_POLICY.maxAttempts),
    retryBackoffMs: positiveInteger(rolePolicy.retryBackoffMs || configured.retryBackoffMs, DEFAULT_EXECUTION_POLICY.retryBackoffMs),
    staleRunMs: positiveInteger(rolePolicy.staleRunMs || configured.staleRunMs, DEFAULT_EXECUTION_POLICY.staleRunMs),
    selectionReason: escalated
      ? "explicit_escalation"
      : systemsArchitect
        ? "systems_architect_role"
        : lead
          ? "lead_role"
          : complex
            ? "complex_task"
            : mechanical
              ? "mechanical_task"
              : rolePolicy.tier || rolePolicy.model
                ? "role_policy"
                : "default_role",
  };
}

export function executionAttemptKey(task, action) {
  const key = [
    task.id,
    Number(task.reviewCycle || 0),
  ];
  if (["start_review", "continue_review"].includes(action.type)) {
    const candidateCycle = Number(action.candidateCycle || task.reviewSubjectCycle || 0);
    const subjectSha = String(action.reviewSubjectSha || task.reviewSubjectSha || "").trim();
    if (candidateCycle > 0) key.push(`candidate-${candidateCycle}`);
    if (subjectSha) key.push(`sha-${subjectSha}`);
  }
  key.push(action.type, action.role || "builder");
  const epoch = Number(task.automationAttemptEpoch || 0);
  if (epoch > 0) key.push(`epoch-${epoch}`);
  return key.join(":");
}
