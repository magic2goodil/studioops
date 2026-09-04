import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { integrationBranchName, trustLeadApprovalsEnabled } from "./integration-policy.js";
import { missionControlConfigRoot } from "./runtime-paths.js";
import { normalizeCreditPolicy } from "./credit-policy.js";

export const CONFIG_FILE = "studioops.config.md";
export const LEGACY_CONFIG_FILE = "mission-control.config.md";
export const CONFIG_EXAMPLE_FILE = "studioops.config.example.md";
export const PROJECT_WORKFLOW_MODES = new Set(["auto", "local", "github"]);
export const MODULAR_ARCHITECTURE_STANDARD = "standards/modular-architecture-and-scoped-validation.md";
export const INSTALLED_AUTOMATION_CAPACITY = Object.freeze({
  builderConcurrency: 3,
  reviewerConcurrency: 3,
  runnerLimit: 3,
});
export const DEFAULT_RUN_OUTPUT_GUARD = Object.freeze({
  maxCommandOutputChars: 24_000,
  maxCumulativeCommandOutputChars: 160_000,
});
export const DEFAULT_GLOBAL_RUN_ADMISSION = Object.freeze({
  maxActiveMeteredRuns: 2,
  maxMeteredRunsPerWindow: 0,
  runWindowMinutes: 60,
});
export const DEFAULT_TECHOPS_POLICY = Object.freeze({
  enabled: false,
  healthCheckIntervalSeconds: 60,
  healthTimeoutMs: 5_000,
  commandTimeoutMs: 60_000,
  maxAttempts: 3,
  initialBackoffSeconds: 60,
  maxBackoffSeconds: 15 * 60,
  leaseSeconds: 5 * 60,
  maxConcurrentRecoveries: 1,
  maxCommandsPerAttempt: 8,
  maxOutputChars: 4_000,
  verificationAttempts: 5,
  verificationDelayMs: 1_000,
});
export const TECHOPS_COMMAND_OPERATIONS = Object.freeze({
  docker_compose_ps: Object.freeze({ type: "diagnostic", args: Object.freeze(["ps", "--all"]) }),
  docker_compose_up: Object.freeze({ type: "recovery", args: Object.freeze(["up", "--detach", "--no-deps", "--no-recreate"]) }),
  docker_compose_start: Object.freeze({ type: "recovery", args: Object.freeze(["start"]) }),
  docker_compose_restart: Object.freeze({ type: "recovery", args: Object.freeze(["restart"]) }),
});
const TECHOPS_CONFIGURATION_ERROR_CODES = new Set([
  "duplicate_command_id",
  "invalid_command_id",
  "invalid_command_shape",
  "invalid_service",
  "operation_type_mismatch",
  "unsupported_operation",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function techOpsConfigurationError(item, type, index, code) {
  const candidateId = item && typeof item === "object" && !Array.isArray(item)
    ? String(item.id || "").trim()
    : "";
  return {
    id: /^[a-z][a-z0-9_.-]{0,63}$/i.test(candidateId) ? candidateId : `${type}-${index + 1}`,
    type,
    code,
  };
}

function normalizeTechOpsCommand(item, type, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { error: techOpsConfigurationError(item, type, index, "invalid_command_shape") };
  }
  const id = String(item.id || "").trim();
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(id)) {
    return { error: techOpsConfigurationError(item, type, index, "invalid_command_id") };
  }
  const operation = String(item.operation || "").trim().toLowerCase();
  const definition = TECHOPS_COMMAND_OPERATIONS[operation];
  if (!definition) {
    return { error: techOpsConfigurationError(item, type, index, "unsupported_operation") };
  }
  if (definition.type !== type) {
    return { error: techOpsConfigurationError(item, type, index, "operation_type_mismatch") };
  }
  const services = Array.isArray(item.services)
    ? [...new Set(item.services.map((service) => String(service).trim()))]
    : [];
  if (!services.length || services.some((service) => !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(service))) {
    return { error: techOpsConfigurationError(item, type, index, "invalid_service") };
  }
  return { command: {
    id,
    type,
    operation,
    services,
    ...(item.cwd ? { cwd: expandHome(String(item.cwd)) } : {}),
    timeoutMs: boundedInteger(item.timeoutMs, DEFAULT_TECHOPS_POLICY.commandTimeoutMs, 1_000, 5 * 60_000),
  } };
}

function normalizedTechOpsConfigurationErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const id = String(item?.id || "").trim();
    const type = String(item?.type || "").trim();
    const code = String(item?.code || "").trim();
    if (
      !/^[a-z][a-z0-9_.-]{0,63}$/i.test(id)
      || !["diagnostic", "recovery"].includes(type)
      || !TECHOPS_CONFIGURATION_ERROR_CODES.has(code)
    ) return [];
    return [{ id, type, code }];
  });
}

export function techOpsCommandInvocation(command) {
  const definition = TECHOPS_COMMAND_OPERATIONS[command?.operation];
  if (
    !definition
    || definition.type !== command?.type
    || !Array.isArray(command?.services)
    || !command.services.length
    || command.services.some((service) => !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(String(service)))
  ) {
    throw new Error(`TechOps command ${String(command?.id || "unknown")} is not a supported typed operation.`);
  }
  return { executable: "docker", args: [...definition.args, ...command.services] };
}

/** Canonical local-only policy consumed by the TechOps worker. */
export function normalizeTechOpsPolicy(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const diagnostics = Array.isArray(raw.diagnosticCommands) ? raw.diagnosticCommands : [];
  const recoveries = Array.isArray(raw.recoveryCommands) ? raw.recoveryCommands : [];
  const canonicalCommands = Array.isArray(raw.commands) ? raw.commands : [];
  const normalizedCommands = [
    ...canonicalCommands.map((item, index) => normalizeTechOpsCommand(
      item,
      item?.type === "diagnostic" ? "diagnostic" : "recovery",
      index,
    )),
    ...diagnostics.map((item, index) => normalizeTechOpsCommand(item, "diagnostic", index)),
    ...recoveries.map((item, index) => normalizeTechOpsCommand(item, "recovery", index)),
  ];
  const commands = [];
  const configurationErrors = normalizedTechOpsConfigurationErrors(raw.configurationErrors);
  for (const normalized of normalizedCommands) {
    if (normalized.error) {
      configurationErrors.push(normalized.error);
      continue;
    }
    if (commands.some((candidate) => candidate.id === normalized.command.id)) {
      configurationErrors.push(techOpsConfigurationError(
        normalized.command,
        normalized.command.type,
        commands.length,
        "duplicate_command_id",
      ));
      continue;
    }
    commands.push(normalized.command);
  }
  const initialBackoffSeconds = boundedInteger(
    raw.initialBackoffSeconds,
    DEFAULT_TECHOPS_POLICY.initialBackoffSeconds,
    1,
    24 * 60 * 60,
  );
  return {
    enabled: raw.enabled === true,
    healthCheckIntervalSeconds: boundedInteger(raw.healthCheckIntervalSeconds, DEFAULT_TECHOPS_POLICY.healthCheckIntervalSeconds, 5, 24 * 60 * 60),
    healthTimeoutMs: boundedInteger(raw.healthTimeoutMs, DEFAULT_TECHOPS_POLICY.healthTimeoutMs, 250, 60_000),
    commandTimeoutMs: boundedInteger(raw.commandTimeoutMs, DEFAULT_TECHOPS_POLICY.commandTimeoutMs, 1_000, 5 * 60_000),
    maxAttempts: boundedInteger(raw.maxAttempts, DEFAULT_TECHOPS_POLICY.maxAttempts, 1, 10),
    initialBackoffSeconds,
    maxBackoffSeconds: boundedInteger(raw.maxBackoffSeconds, DEFAULT_TECHOPS_POLICY.maxBackoffSeconds, initialBackoffSeconds, 24 * 60 * 60),
    leaseSeconds: boundedInteger(raw.leaseSeconds, DEFAULT_TECHOPS_POLICY.leaseSeconds, 30, 30 * 60),
    maxConcurrentRecoveries: boundedInteger(raw.maxConcurrentRecoveries, DEFAULT_TECHOPS_POLICY.maxConcurrentRecoveries, 1, 4),
    maxCommandsPerAttempt: boundedInteger(raw.maxCommandsPerAttempt, DEFAULT_TECHOPS_POLICY.maxCommandsPerAttempt, 1, 16),
    maxOutputChars: boundedInteger(raw.maxOutputChars, DEFAULT_TECHOPS_POLICY.maxOutputChars, 256, 24_000),
    verificationAttempts: boundedInteger(raw.verificationAttempts, DEFAULT_TECHOPS_POLICY.verificationAttempts, 1, 10),
    verificationDelayMs: boundedInteger(raw.verificationDelayMs, DEFAULT_TECHOPS_POLICY.verificationDelayMs, 0, 30_000),
    commands,
    configurationErrors,
    restartLaunchAgents: [...new Set((Array.isArray(raw.restartLaunchAgents) ? raw.restartLaunchAgents : [])
      .map((item) => String(item).trim())
      .filter((item) => /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(item)))],
  };
}

export function normalizeRunOutputGuard(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    maxCommandOutputChars: positiveInteger(
      raw.maxCommandOutputChars,
      DEFAULT_RUN_OUTPUT_GUARD.maxCommandOutputChars,
    ),
    maxCumulativeCommandOutputChars: positiveInteger(
      raw.maxCumulativeCommandOutputChars,
      DEFAULT_RUN_OUTPUT_GUARD.maxCumulativeCommandOutputChars,
    ),
  };
}

export function normalizeGlobalRunAdmission(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const configuredWindowLimit = Number(raw.maxMeteredRunsPerWindow ?? raw.globalRunWindowLimit ?? 0);
  const runWindowMinutes = positiveInteger(raw.runWindowMinutes, DEFAULT_GLOBAL_RUN_ADMISSION.runWindowMinutes);
  const priorDiagnostic = raw.deprecatedTotalWindowAdmission
    && typeof raw.deprecatedTotalWindowAdmission === "object"
    && !Array.isArray(raw.deprecatedTotalWindowAdmission)
    ? raw.deprecatedTotalWindowAdmission
    : null;
  const deprecatedTotalWindowAdmission = Number.isSafeInteger(configuredWindowLimit) && configuredWindowLimit > 0
    ? {
      schemaVersion: 1,
      status: "inert",
      configuredMaxRunsPerWindow: configuredWindowLimit,
      configuredRunWindowMinutes: runWindowMinutes,
    }
    : priorDiagnostic;
  return {
    maxActiveMeteredRuns: positiveInteger(raw.maxActiveMeteredRuns ?? raw.globalActiveRunLimit, DEFAULT_GLOBAL_RUN_ADMISSION.maxActiveMeteredRuns),
    maxMeteredRunsPerWindow: 0,
    runWindowMinutes,
    ...(deprecatedTotalWindowAdmission ? { deprecatedTotalWindowAdmission } : {}),
  };
}

export function normalizeProjectRunAdmissionPolicy(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const configuredWindowLimit = Number(raw.maxRunsPerWindow || 0);
  const runWindowMinutes = positiveInteger(raw.runWindowMinutes, 60);
  const priorDiagnostic = raw.deprecatedTotalWindowAdmission
    && typeof raw.deprecatedTotalWindowAdmission === "object"
    && !Array.isArray(raw.deprecatedTotalWindowAdmission)
    ? raw.deprecatedTotalWindowAdmission
    : null;
  const deprecatedTotalWindowAdmission = Number.isSafeInteger(configuredWindowLimit) && configuredWindowLimit > 0
    ? {
      schemaVersion: 1,
      status: "inert",
      configuredMaxRunsPerWindow: configuredWindowLimit,
      configuredRunWindowMinutes: runWindowMinutes,
    }
    : priorDiagnostic;
  return {
    ...raw,
    maxActiveTasks: nonnegativeInteger(raw.maxActiveTasks, 0),
    maxActiveRuns: nonnegativeInteger(raw.maxActiveRuns, 0),
    maxRunsPerWindow: 0,
    runWindowMinutes,
    ...(deprecatedTotalWindowAdmission ? { deprecatedTotalWindowAdmission } : {}),
  };
}

export function normalizeCreditPolicyConfig(value = {}) {
  return normalizeCreditPolicy(value);
}

export function canonicalCreditPolicyConfig(value = {}) {
  const { failClosedTiers: _legacyFailClosedTiers, ...canonical } = normalizeCreditPolicyConfig(value);
  return canonical;
}

export const DEFAULT_WORKSPACE_RETENTION = Object.freeze({
  enabled: true,
  retainForHours: Object.freeze({ completed: 168, failed: 336, cancelled: 168 }),
  pressureMinAgeHours: 24,
  maxRetainedBytes: 53_687_091_200,
  maxDeletesPerSweep: 25,
  sweepIntervalSeconds: 600,
  cleanupLeaseSeconds: 900,
});

const WORKSPACE_RETENTION_STATUSES = new Set(["completed", "failed", "cancelled"]);

function finiteNonNegative(value, fallback) {
  if (
    value === null
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
  ) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveFinite(value, fallback) {
  if (
    value === null
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
  ) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeWorkspaceRetention(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const rawRetainForHours = raw.retainForHours && typeof raw.retainForHours === "object"
    ? raw.retainForHours
    : {};
  const invalidStatusConfiguration = raw.terminalStatuses !== undefined
    && (!Array.isArray(raw.terminalStatuses)
      || raw.terminalStatuses.some((status) => !WORKSPACE_RETENTION_STATUSES.has(String(status).trim().toLowerCase())));
  return {
    enabled: invalidStatusConfiguration ? false : raw.enabled !== false,
    retainForHours: {
      completed: finiteNonNegative(rawRetainForHours.completed, DEFAULT_WORKSPACE_RETENTION.retainForHours.completed),
      failed: finiteNonNegative(rawRetainForHours.failed, DEFAULT_WORKSPACE_RETENTION.retainForHours.failed),
      cancelled: finiteNonNegative(rawRetainForHours.cancelled, DEFAULT_WORKSPACE_RETENTION.retainForHours.cancelled),
    },
    pressureMinAgeHours: finiteNonNegative(raw.pressureMinAgeHours, DEFAULT_WORKSPACE_RETENTION.pressureMinAgeHours),
    maxRetainedBytes: finiteNonNegative(raw.maxRetainedBytes, DEFAULT_WORKSPACE_RETENTION.maxRetainedBytes),
    maxDeletesPerSweep: positiveFinite(raw.maxDeletesPerSweep, DEFAULT_WORKSPACE_RETENTION.maxDeletesPerSweep),
    sweepIntervalSeconds: positiveFinite(raw.sweepIntervalSeconds, DEFAULT_WORKSPACE_RETENTION.sweepIntervalSeconds),
    cleanupLeaseSeconds: positiveFinite(raw.cleanupLeaseSeconds, DEFAULT_WORKSPACE_RETENTION.cleanupLeaseSeconds),
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function effectiveAutomationCapacity(config = {}) {
  const dispatcher = {
    ...(config?.defaults?.supervisor || {}),
    ...(config?.defaults?.dispatcher || {}),
    ...(config?.supervisor || {}),
    ...(config?.dispatcher || {}),
  };
  const runner = {
    ...(config?.defaults?.runner || {}),
    ...(config?.runner || {}),
  };
  const runnerLimit = hasOwnValue(config?.runner, "limit")
    ? config.runner.limit
    : hasOwnValue(config?.runner, "maxRuns")
      ? config.runner.maxRuns
      : runner.limit ?? runner.maxRuns;
  return {
    builderConcurrency: positiveInteger(
      dispatcher.builderConcurrency,
      INSTALLED_AUTOMATION_CAPACITY.builderConcurrency,
    ),
    reviewerConcurrency: positiveInteger(
      dispatcher.reviewerConcurrency,
      INSTALLED_AUTOMATION_CAPACITY.reviewerConcurrency,
    ),
    runnerLimit: positiveInteger(
      runnerLimit,
      INSTALLED_AUTOMATION_CAPACITY.runnerLimit,
    ),
  };
}

export function normalizeConfig(config = {}) {
  const defaults = config.defaults || {};
  const legacySupervisor = defaults.supervisor || {};
  const dispatcher = defaults.dispatcher || {};
  const runner = defaults.runner || {};
  const topLevelRunner = config.runner || {};
  const normalizedTopLevelRunner = (
    hasOwnValue(topLevelRunner, "limit")
    || hasOwnValue(topLevelRunner, "maxRuns")
  ) ? {
      ...topLevelRunner,
      limit: positiveInteger(
        topLevelRunner.limit ?? topLevelRunner.maxRuns,
        INSTALLED_AUTOMATION_CAPACITY.runnerLimit,
      ),
    } : topLevelRunner;
  const hasDefaultCreditPolicy = hasOwnValue(defaults, "creditPolicy");
  const hasTopLevelCreditPolicy = hasOwnValue(config, "creditPolicy");
  const normalizedDefaultCreditPolicy = hasDefaultCreditPolicy
    ? canonicalCreditPolicyConfig(defaults.creditPolicy)
    : null;
  const normalizedTopLevelCreditPolicy = hasTopLevelCreditPolicy
    ? canonicalCreditPolicyConfig({
        ...(defaults.creditPolicy || {}),
        ...(config.creditPolicy || {}),
      })
    : null;
  return {
    ...config,
    ...(hasOwnValue(config, "runner") ? { runner: normalizedTopLevelRunner } : {}),
    ...(hasTopLevelCreditPolicy ? { creditPolicy: normalizedTopLevelCreditPolicy } : {}),
    defaults: {
      ...defaults,
      ...(hasDefaultCreditPolicy ? { creditPolicy: normalizedDefaultCreditPolicy } : {}),
      dispatcher: {
        ...dispatcher,
        builderConcurrency: positiveInteger(
          hasOwnValue(dispatcher, "builderConcurrency")
            ? dispatcher.builderConcurrency
            : legacySupervisor.builderConcurrency,
          INSTALLED_AUTOMATION_CAPACITY.builderConcurrency,
        ),
        reviewerConcurrency: positiveInteger(
          hasOwnValue(dispatcher, "reviewerConcurrency")
            ? dispatcher.reviewerConcurrency
            : legacySupervisor.reviewerConcurrency,
          INSTALLED_AUTOMATION_CAPACITY.reviewerConcurrency,
        ),
      },
      runner: {
        ...runner,
        limit: positiveInteger(
          runner.limit ?? runner.maxRuns,
          INSTALLED_AUTOMATION_CAPACITY.runnerLimit,
        ),
        workspaceRetention: normalizeWorkspaceRetention(runner.workspaceRetention),
        outputGuard: normalizeRunOutputGuard(runner.outputGuard),
      },
      globalRunAdmission: normalizeGlobalRunAdmission(
        config.globalRunAdmission || defaults.globalRunAdmission || {},
      ),
    },
  };
}

export function withDefaultProjectStandards(value) {
  const standards = Array.isArray(value)
    ? value
    : String(value || "").split(/\n|,/);
  return [...new Set([
    MODULAR_ARCHITECTURE_STANDARD,
    ...standards.map((item) => String(item).trim()).filter(Boolean),
  ])];
}

export function normalizeProjectWorkflowMode(value, fallback = "auto") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!PROJECT_WORKFLOW_MODES.has(normalized)) {
    throw new Error(`Invalid project workflow mode: ${value}. Expected auto, local, or github.`);
  }
  return normalized;
}

export function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function extractConfigJson(markdown) {
  const match = markdown.match(/```json (?:studioops|mission-control)-config\s*([\s\S]*?)```/);
  if (!match) {
    throw new Error("No fenced `json studioops-config` block found.");
  }
  return JSON.parse(match[1]);
}

export function renderConfigMarkdown(config) {
  return `# StudioOps Local Configuration

This file was generated by \`studioops setup\`.

Do not paste private keys, API tokens, passwords, customer data, or secrets into this file.

## Security Rules

- StudioOps verifies GitHub access; it does not store private keys.
- Keep this file local. It is ignored by Git.
- Keep secrets in each project's normal secret manager or environment files.

## Credit Admission Configuration

The canonical degraded-telemetry contract is
\`defaults.creditPolicy.degradedTelemetryFallback\`. It is versioned and keyed
by stable execution risk tiers and explicit labels, never model IDs. Existing
\`failClosedTiers\` and \`tierBudgets\` inputs remain readable for one compatibility
release; newly generated configuration uses the canonical fallback contract.

## Machine-Readable Config

\`\`\`json studioops-config
${JSON.stringify(config, null, 2)}
\`\`\`
`;
}

export async function loadConfig(rootDir = missionControlConfigRoot()) {
  const currentPath = path.join(rootDir, CONFIG_FILE);
  const legacyPath = path.join(rootDir, LEGACY_CONFIG_FILE);
  const configPath = await fileExists(currentPath) ? currentPath : legacyPath;
  if (!(await fileExists(configPath))) return null;
  const markdown = await readFile(configPath, "utf8");
  return normalizeConfig(extractConfigJson(markdown));
}

export async function writeConfig(config, rootDir = missionControlConfigRoot()) {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700).catch(() => {});
  const configPath = path.join(rootDir, CONFIG_FILE);
  await writeFile(configPath, renderConfigMarkdown(normalizeConfig(config)), { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});
  return configPath;
}

function hasOwnValue(item, key) {
  return Object.prototype.hasOwnProperty.call(item || {}, key);
}

function reviewPolicyFromConfig(rawProject = {}, defaults = {}) {
  const reviewPolicy = {
    ...(defaults.reviewPolicy || {}),
    ...(rawProject.reviewPolicy || {}),
  };
  if (
    !hasOwnValue(rawProject.reviewPolicy, "trustLeadApprovals")
    && !hasOwnValue(rawProject.reviewPolicy, "trustLeads")
    && hasOwnValue(rawProject, "trustLeadApprovals")
  ) {
    reviewPolicy.trustLeadApprovals = rawProject.trustLeadApprovals;
  }
  if (
    !hasOwnValue(rawProject.reviewPolicy, "integrationBranch")
    && !hasOwnValue(rawProject.reviewPolicy, "reviewBranch")
    && hasOwnValue(rawProject, "integrationBranch")
  ) {
    reviewPolicy.integrationBranch = rawProject.integrationBranch;
  }
  return reviewPolicy;
}

export function projectFromConfig(rawProject, defaults = {}) {
  const reviewPolicy = reviewPolicyFromConfig(rawProject, defaults);
  const configuredStandards = hasOwnValue(rawProject, "standards")
    ? rawProject.standards
    : defaults.standards;
  return {
    key: rawProject.key,
    name: rawProject.name,
    description: rawProject.description || "",
    repoPath: expandHome(rawProject.repoPath || ""),
    repoUrl: rawProject.repoUrl || "",
    workflowMode: normalizeProjectWorkflowMode(rawProject.workflowMode || defaults.workflowMode || "auto"),
    defaultBranch: rawProject.defaultBranch || defaults.defaultBranch || "main",
    validationCommands: rawProject.validationCommands || defaults.validationCommands || [],
    contextLinks: rawProject.contextLinks || [],
    standards: withDefaultProjectStandards(configuredStandards),
    safetyRules: rawProject.safetyRules || defaults.safetyRules || [],
    reviewPipeline: rawProject.reviewPipeline || defaults.reviewPipeline || [],
    wipPolicy: {
      ...(defaults.wipPolicy || {}),
      ...(rawProject.wipPolicy || {}),
    },
    reviewPolicy,
    qaIntegration: {
      ...(defaults.qaIntegration || {}),
      ...(rawProject.qaIntegration || {}),
    },
    promotion: {
      ...(defaults.promotion || {}),
      ...(rawProject.promotion || {}),
    },
    deliveryPolicy: rawProject.deliveryPolicy || defaults.deliveryPolicy || {},
    localQaPreview: rawProject.localQaPreview || rawProject.qaIntegration?.localPreview || null,
    techOps: normalizeTechOpsPolicy({
      ...(defaults.techOps || {}),
      ...(rawProject.techOps || {}),
    }),
    trustLeadApprovals: trustLeadApprovalsEnabled({ ...rawProject, reviewPolicy }),
    integrationBranch: integrationBranchName({ ...rawProject, reviewPolicy }) || integrationBranchName(defaults),
  };
}
