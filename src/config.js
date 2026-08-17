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

export function normalizeCreditPolicyConfig(value = {}) {
  return normalizeCreditPolicy(value);
}

export function canonicalCreditPolicyConfig(value = {}) {
  const { failClosedTiers: _legacyFailClosedTiers, ...canonical } = normalizeCreditPolicyConfig(value);
  return canonical;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
      },
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
    trustLeadApprovals: trustLeadApprovalsEnabled({ ...rawProject, reviewPolicy }),
    integrationBranch: integrationBranchName({ ...rawProject, reviewPolicy }) || integrationBranchName(defaults),
  };
}
