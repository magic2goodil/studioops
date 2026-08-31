const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  architectReasoningEffort: "xhigh",
  leadReasoningEffort: "xhigh",
  complexReasoningEffort: "xhigh",
  ultraReasoningEffort: "ultra",
  tokenBudget: 120000,
  costBudget: 0,
  roleTokenBudgets: {
    builder: 120000,
    "backend-reviewer": 100000,
    "frontend-reviewer": 100000,
    "accessibility-reviewer": 90000,
    "lead-reviewer": 140000,
    "systems-architect": 180000,
  },
  mechanicalLabels: ["spark-ok"],
  escalationLabels: ["ultra-review"],
  modelTiers: {},
  tierRouting: {},
  maxAttempts: 2,
  retryBackoffMs: 30 * 1000,
  staleRunMs: 2 * 60 * 60 * 1000,
});

const COMPLEX_WORK_PATTERN = /\b(architecture|architectural|security|privacy|pii|consent|oauth|authentication|authorization|migration|schema|database|index|deployment|release|production|infrastructure|data loss)\b/i;
const ROUTINE_CONFIG_PATTERN = /(^|\/)(?:\.editorconfig|\.prettier(?:rc|ignore)?|\.eslintignore|prettier\.config\.[^/]+|eslint\.config\.[^/]+|markdownlint(?:\.json|\.yaml|\.yml)?|\.markdownlint(?:\.json|\.yaml|\.yml)?)$/i;

function nonNegativeUsageNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

/**
 * Normalize provider telemetry without treating cached tokens as an extra
 * billable input or guessing credits from token volume. Providers report
 * input_tokens as the complete context volume, which can include cached and
 * replayed transcript context; output_tokens is the provider's total output
 * volume, including reasoning when the provider supplies a combined field.
 */
export function normalizeExecutionUsage(value = {}) {
  const inputTokens = nonNegativeUsageNumber(value.input_tokens ?? value.inputTokens);
  const outputTokens = nonNegativeUsageNumber(value.output_tokens ?? value.outputTokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeUsageNumber(value.cached_input_tokens ?? value.cachedInputTokens),
  );
  const reasoningOutputTokens = nonNegativeUsageNumber(value.reasoning_output_tokens ?? value.reasoningOutputTokens);
  const actualCreditsValue = value.actual_credits ?? value.actualCredits;
  const actualCredits = Number.isFinite(Number(actualCreditsValue)) && Number(actualCreditsValue) >= 0
    ? Number(actualCreditsValue)
    : null;
  return {
    inputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    actualTokens: inputTokens + outputTokens,
    actualCredits,
    creditTelemetryStatus: actualCredits === null ? "unavailable" : "recorded",
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

function exactRoutineImpact(task = {}, complex = false) {
  if (complex || task.impactEvidence?.unknown !== false) return false;
  const files = Array.isArray(task.impactEvidence?.changedFiles)
    ? task.impactEvidence.changedFiles.map((file) => String(file).replaceAll("\\", "/"))
    : [];
  if (!files.length) return false;
  return files.every((file) => (
    /(^|\/)(?:docs?\/|readme(?:\.[^/]*)?$|changelog(?:\.[^/]*)?$|contributing(?:\.[^/]*)?$|license(?:\.[^/]*)?$)/i.test(file)
    || /\.mdx?$/i.test(file)
    || ROUTINE_CONFIG_PATTERN.test(file)
  ));
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
  const proportionateReview = lead && exactRoutineImpact(task, complex);
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
        ? proportionateReview
          ? routing.routineReviewTier || "balanced"
          : routing.leadTier
        : complex
          ? routing.complexTier
          : mechanical
            ? routing.mechanicalTier
            : rolePolicy.tier || routing.defaultTier;
  const tierPolicy = configuredTier(configured, selectedTier);
  const reasoningEffort = normalizedEffort(
    task.reasoningEffort
      || task.reasoningBudget?.reasoningEffort
      || (escalated ? configured.ultraReasoningEffort : "")
      || tierPolicy.reasoningEffort
      || (systemsArchitect ? configured.architectReasoningEffort : "")
      || (lead && !proportionateReview ? configured.leadReasoningEffort : "")
      || (complex ? configured.complexReasoningEffort : "")
      || rolePolicy.reasoningEffort
      || configured.reasoningEffort,
    DEFAULT_EXECUTION_POLICY.reasoningEffort,
  );

  return {
    model: String(
      task.model
        || task.reasoningBudget?.model
        || tierPolicy.model
        || (systemsArchitect ? DEFAULT_EXECUTION_POLICY.model : "")
        || rolePolicy.model
        || configured.model
        || DEFAULT_EXECUTION_POLICY.model,
    ).trim(),
    modelTier: String(selectedTier || "").trim(),
    reasoningEffort,
    tokenBudget: positiveInteger(
      task.tokenBudget
        || task.reasoningBudget?.tokenBudget
        || tierPolicy.tokenBudget
        || rolePolicy.tokenBudget
        || configured.roleTokenBudgets?.[role]
        || configured.tokenBudget,
      DEFAULT_EXECUTION_POLICY.tokenBudget,
    ),
    costBudget: nonNegativeNumber(
      task.costBudget
        ?? task.reasoningBudget?.costBudget
        ?? tierPolicy.costBudget
        ?? rolePolicy.costBudget
        ?? configured.costBudget,
      DEFAULT_EXECUTION_POLICY.costBudget,
    ),
    maxAttempts: positiveInteger(rolePolicy.maxAttempts || configured.maxAttempts, DEFAULT_EXECUTION_POLICY.maxAttempts),
    retryBackoffMs: positiveInteger(rolePolicy.retryBackoffMs || configured.retryBackoffMs, DEFAULT_EXECUTION_POLICY.retryBackoffMs),
    staleRunMs: positiveInteger(rolePolicy.staleRunMs || configured.staleRunMs, DEFAULT_EXECUTION_POLICY.staleRunMs),
    selectionReason: escalated
      ? "explicit_escalation"
      : systemsArchitect
        ? "systems_architect_role"
      : lead
          ? proportionateReview ? "proportionate_exact_diff" : "lead_role"
          : complex
            ? "complex_task"
            : mechanical
              ? "mechanical_task"
              : rolePolicy.tier || rolePolicy.model
                ? "role_policy"
                : "default_role",
  };
}

export function reasoningBudgetForTask(task = {}, action = {}, input = {}) {
  const policy = resolveExecutionPolicy(task, action, input);
  return {
    model: policy.model,
    modelTier: policy.modelTier,
    reasoningEffort: policy.reasoningEffort,
    tokenBudget: policy.tokenBudget,
    costBudget: policy.costBudget,
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
