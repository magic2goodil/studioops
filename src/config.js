import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { integrationBranchName, trustLeadApprovalsEnabled } from "./integration-policy.js";
import { missionControlConfigRoot } from "./runtime-paths.js";

export const CONFIG_FILE = "studioops.config.md";
export const LEGACY_CONFIG_FILE = "mission-control.config.md";
export const CONFIG_EXAMPLE_FILE = "studioops.config.example.md";
export const PROJECT_WORKFLOW_MODES = new Set(["auto", "local", "github"]);
export const MODULAR_ARCHITECTURE_STANDARD = "standards/modular-architecture-and-scoped-validation.md";
export const STANDING_RELEASE_AUTHORIZATION_ACTIONS = new Set(["grant", "revoke"]);
export const INSTALLED_AUTOMATION_CAPACITY = Object.freeze({
  builderConcurrency: 3,
  reviewerConcurrency: 3,
  runnerLimit: 3,
});

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9.-]{2,63}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const SIMPLE_COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKFLOW_COORDINATE_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,159}$/;
const ROLLBACK_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,191}$/;
const HEALTH_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CREDENTIAL_SHAPE_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bnpm_[A-Za-z0-9]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/i,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/i,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i,
];
const LOCAL_PATH_PATTERNS = [
  /^file:\/\//i,
  /^[A-Za-z]:[\\/]/,
  /^\\\\/,
  /^~[\\/]/,
  /^(?:Users|home|tmp|var|private|Volumes|etc|opt|usr|root)[\\/]/i,
  /^[\\/](?:Users|home|tmp|var|private|Volumes|etc|opt|usr|root)[\\/]/i,
  /(?:^|[\\/])[A-Za-z]:[\\/]/,
  /[\\/]\.(?:ssh|aws)[\\/]/i,
  /[\\/]\.codex[\\/]/i,
];

function requiredString(value, label) {
  const raw = String(value || "");
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
  const normalized = raw.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function normalizeOpaqueId(value, label) {
  const normalized = requiredString(value, label);
  if (!OPAQUE_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an opaque 8-128 character identifier using only letters, numbers, _ or -.`);
  }
  return normalized;
}

function normalizeIsoTimestamp(value, label) {
  const normalized = requiredString(value, label);
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i,
  );
  const timestamp = Date.parse(normalized);
  if (
    !match
    || !Number.isFinite(timestamp)
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp with a timezone.`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = zone === "Z" ? null : zone.slice(1).split(":").map(Number);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || (offset && (offset[0] > 23 || offset[1] > 59))
  ) {
    throw new Error(`${label} must name a real calendar instant.`);
  }
  return new Date(timestamp).toISOString();
}

function assertNonSensitiveReleaseCoordinate(value, label) {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
  if (CREDENTIAL_SHAPE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} cannot contain a credential-shaped or secret-assignment value.`);
  }
  if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} cannot contain a local filesystem path.`);
  }
}

function boundedCoordinate(value, label, pattern) {
  const normalized = requiredString(value, label);
  assertNonSensitiveReleaseCoordinate(normalized, label);
  if (
    !pattern.test(normalized)
    || normalized.includes("..")
    || normalized.startsWith("/")
    || normalized.endsWith("/")
  ) {
    throw new Error(`${label} is not a valid bounded non-sensitive coordinate.`);
  }
  return normalized;
}

export function normalizeGitHubRepository(value) {
  const raw = requiredString(value, "Standing release repository");
  const match = raw.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)?([^/:?#\s]+)\/([^/#?\s]+?)(?:\.git)?$/i,
  );
  if (!match) {
    throw new Error("Standing release repository must be an exact GitHub owner/repository coordinate.");
  }
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
    throw new Error("Standing release repository must be a valid GitHub owner/repository coordinate.");
  }
  return repository;
}

function normalizeTargetHostname(value) {
  const raw = requiredString(value, "Standing release target hostname").toLowerCase();
  if (
    raw.length > 253
    || raw.includes(":")
    || raw.includes("/")
    || raw.endsWith(".")
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)
  ) {
    throw new Error("Standing release target hostname must be one exact DNS hostname without a scheme, port, path, or wildcard.");
  }
  return raw;
}

function normalizeHealthPath(value) {
  const raw = requiredString(value, "Standing release health path");
  assertNonSensitiveReleaseCoordinate(raw, "Standing release health path");
  if (
    raw.length > 256
    || !raw.startsWith("/")
    || raw.startsWith("//")
    || raw.includes("?")
    || raw.includes("#")
    || raw.includes("\\")
  ) {
    throw new Error("Standing release health path must be one bounded absolute URL path without a host, query, or fragment.");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("Standing release health path contains invalid URL encoding.");
  }
  assertNonSensitiveReleaseCoordinate(decoded, "Standing release health path");
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Standing release health path cannot contain traversal segments.");
  }
  if (raw.includes("%") || !HEALTH_PATH_PATTERN.test(raw)) {
    throw new Error(
      "Standing release health path must use bounded unencoded ASCII path segments.",
    );
  }
  return raw;
}

function normalizeRevocation(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Standing release revocation must be an object.");
  }
  const reasonCode = requiredString(value.reasonCode, "Standing release revocation reason code").toLowerCase();
  if (!REASON_CODE_PATTERN.test(reasonCode)) {
    throw new Error("Standing release revocation reason code must be 3-64 lowercase letters, numbers, or underscores.");
  }
  return {
    revokedByActorId: normalizeOpaqueId(value.revokedByActorId, "Standing release revocation actor ID"),
    revokedAt: normalizeIsoTimestamp(value.revokedAt, "Standing release revocation timestamp"),
    reasonCode,
  };
}

export function assertStandingReleaseRevocationChronology(grantedAt, revokedAt) {
  const normalizedGrant = normalizeIsoTimestamp(grantedAt, "Standing release grant timestamp");
  const normalizedRevocation = normalizeIsoTimestamp(revokedAt, "Standing release revocation timestamp");
  if (Date.parse(normalizedRevocation) < Date.parse(normalizedGrant)) {
    throw new Error("Standing release revocation timestamp cannot precede its grant timestamp.");
  }
}

export function normalizeStandingReleaseAuthorizationGrant(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Standing release authorization grant must be an object.");
  }
  const grant = {
    authorizationId: normalizeOpaqueId(value.authorizationId, "Standing release authorization ID"),
    ownerActorId: normalizeOpaqueId(value.ownerActorId, "Standing release owner actor ID"),
    grantedAt: normalizeIsoTimestamp(value.grantedAt, "Standing release grant timestamp"),
    repository: normalizeGitHubRepository(value.repository),
    targetHostname: normalizeTargetHostname(value.targetHostname),
    deploymentWorkflow: boundedCoordinate(
      value.deploymentWorkflow,
      "Standing release deployment workflow",
      WORKFLOW_COORDINATE_PATTERN,
    ),
    environment: boundedCoordinate(value.environment, "Standing release environment", SIMPLE_COORDINATE_PATTERN),
    artifactName: boundedCoordinate(value.artifactName, "Standing release artifact name", SIMPLE_COORDINATE_PATTERN),
    healthPath: normalizeHealthPath(value.healthPath),
    rollbackWorkflow: boundedCoordinate(
      value.rollbackWorkflow,
      "Standing release rollback workflow",
      WORKFLOW_COORDINATE_PATTERN,
    ),
    rollbackReference: boundedCoordinate(
      value.rollbackReference,
      "Standing release rollback reference",
      ROLLBACK_REFERENCE_PATTERN,
    ),
    revocation: value.revocation == null ? null : normalizeRevocation(value.revocation),
  };
  if (grant.revocation) {
    assertStandingReleaseRevocationChronology(grant.grantedAt, grant.revocation.revokedAt);
  }
  return grant;
}

export function normalizeStandingReleaseAuthorizationHistory(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Standing release authorization history must be an array.");
  }
  const history = value.map((record) => normalizeStandingReleaseAuthorizationGrant(record));
  const authorizationIds = new Set();
  let activeCount = 0;
  for (const record of history) {
    if (authorizationIds.has(record.authorizationId)) {
      throw new Error(`Duplicate standing release authorization ID: ${record.authorizationId}`);
    }
    authorizationIds.add(record.authorizationId);
    if (!record.revocation) activeCount += 1;
  }
  if (activeCount > 1) {
    throw new Error("A project cannot have more than one active standing release authorization.");
  }
  return history;
}

export function activeStandingReleaseAuthorization(project = {}) {
  const history = normalizeStandingReleaseAuthorizationHistory(
    project.standingReleaseAuthorizationHistory,
  );
  return history.find((record) => !record.revocation) || null;
}

export function standingReleaseAuthorizationState(project = {}) {
  const history = normalizeStandingReleaseAuthorizationHistory(
    project.standingReleaseAuthorizationHistory,
  );
  const activeAuthorization = history.find((record) => !record.revocation) || null;
  return {
    enabled: Boolean(activeAuthorization),
    activeAuthorization,
    history,
  };
}

export function normalizeStandingReleaseAuthorizationCommand(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Standing release authorization update must be an object.");
  }
  const action = String(value.action || "").trim().toLowerCase();
  if (!STANDING_RELEASE_AUTHORIZATION_ACTIONS.has(action)) {
    throw new Error("Standing release authorization action must be grant or revoke.");
  }
  if (action === "grant") {
    const grant = normalizeStandingReleaseAuthorizationGrant(value.grant || value);
    if (grant.revocation) {
      throw new Error("A new standing release authorization grant cannot include a revocation record.");
    }
    return { action, grant };
  }
  return {
    action,
    authorizationId: normalizeOpaqueId(value.authorizationId, "Standing release authorization ID"),
    revocation: normalizeRevocation(value.revocation || value),
  };
}

export function normalizeOperationalCapabilityBlockers(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Operational capability blockers must be an array.");
  }
  const seen = new Set();
  return value.map((item) => {
    const source = typeof item === "string" ? { capabilityKey: item } : item;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Each operational capability blocker must be a capability key or object.");
    }
    const capabilityKey = String(source.capabilityKey || "").trim().toLowerCase();
    const governingTaskId = String(source.governingTaskId || "").trim();
    if (!capabilityKey && !governingTaskId) {
      throw new Error("An operational capability blocker requires a capability key or governing task ID.");
    }
    if (capabilityKey && !CAPABILITY_KEY_PATTERN.test(capabilityKey)) {
      throw new Error("Operational capability keys must be 3-64 lowercase letters, numbers, dots, or hyphens.");
    }
    if (governingTaskId && !TASK_ID_PATTERN.test(governingTaskId)) {
      throw new Error("Operational capability governing task ID must be an opaque identifier.");
    }
    const normalized = {
      scope: "release",
      capabilityKey,
      governingTaskId,
    };
    const key = `${capabilityKey}\u0000${governingTaskId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return normalized;
  }).filter(Boolean);
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
  return {
    ...config,
    ...(hasOwnValue(config, "runner") ? { runner: normalizedTopLevelRunner } : {}),
    defaults: {
      ...defaults,
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
    standingReleaseAuthorizationHistory: normalizeStandingReleaseAuthorizationHistory(
      rawProject.standingReleaseAuthorizationHistory,
    ),
    localQaPreview: rawProject.localQaPreview || rawProject.qaIntegration?.localPreview || null,
    trustLeadApprovals: trustLeadApprovalsEnabled({ ...rawProject, reviewPolicy }),
    integrationBranch: integrationBranchName({ ...rawProject, reviewPolicy }) || integrationBranchName(defaults),
  };
}
