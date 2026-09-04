import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeTechOpsPolicy, techOpsCommandInvocation } from "./config.js";
import {
  claimQaTechOpsRecovery,
  finalizeQaTechOpsRecovery,
  readState,
  recordQaTechOpsHealth,
} from "./store.js";

const execFileAsync = promisify(execFile);
const ACTIVE_BUNDLE_STATUSES = new Set(["ready", "partially_reviewed"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_COMMAND_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

function boundedText(value, limit = 4_000) {
  return String(value || "")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED]")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .trim()
    .slice(0, limit);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function techOpsPolicyDigest(policy) {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function summarizeTechOpsAction(action, extra = {}) {
  return {
    type: action.type,
    projectId: action.projectId,
    projectKey: action.projectKey,
    bundleId: action.bundleId,
    candidateId: action.candidateId,
    manifestDigest: action.manifestDigest,
    integrationSha: action.integrationSha,
    policyDigest: action.policyDigest,
    ...extra,
  };
}

function previewConfig(project) {
  return project.localQaPreview
    || project.qaIntegration?.localPreview
    || project.qaIntegration?.localQaPreview
    || {};
}

function projectPolicy(project, input = {}) {
  const configured = input.projectPolicies?.[project.id]
    || input.projectPolicies?.[project.key]
    || project.techOps
    || {};
  return normalizeTechOpsPolicy(configured);
}

function candidateForBundle(state, bundle) {
  return (state.candidates || []).find((candidate) => (
    candidate.id === bundle.candidateId
    && candidate.qaBundleId === bundle.id
    && candidate.projectId === bundle.projectId
    && candidate.status === "frozen"
    && !candidate.invalidation
  ));
}

function healthUrlFor(project, candidate) {
  return String(
    previewConfig(project).healthCheckUrl
    || previewConfig(project).healthUrl
    || candidate?.manifest?.preview?.url
    || "",
  ).trim();
}

function assertLocalHealthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TechOps requires a valid local QA health-check URL.");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("TechOps health checks are restricted to loopback HTTP(S) URLs.");
  }
  return parsed.toString();
}

function dueAt(value, nowMs) {
  const parsed = Date.parse(value || "");
  return !Number.isFinite(parsed) || parsed <= nowMs;
}

/** Read-only, deterministic selection of active ready QA previews due for a health check. */
export function planTechOpsActions(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const actions = [];
  for (const bundle of state.qaBundles || []) {
    if (!ACTIVE_BUNDLE_STATUSES.has(bundle.status)) continue;
    const project = (state.projects || []).find((item) => item.id === bundle.projectId);
    const candidate = candidateForBundle(state, bundle);
    if (!project || !candidate) continue;
    const policy = projectPolicy(project, input);
    if (!policy.enabled) continue;
    const policyDigest = techOpsPolicyDigest(policy);
    const currentBinding = bundle.techOps
      && bundle.techOps.candidateId === candidate.id
      && bundle.techOps.manifestDigest === candidate.manifestDigest
      && bundle.techOps.integrationSha === candidate.manifest.integration.sha
      && bundle.techOps.policyDigest === policyDigest;
    if (currentBinding && (!dueAt(bundle.techOps?.nextCheckAt, nowMs) || !dueAt(bundle.techOps?.retryNotBefore, nowMs))) continue;
    if (currentBinding && bundle.techOps?.state === "circuit_open") continue;
    const leaseExpiry = Date.parse(bundle.techOps?.leaseExpiresAt || "");
    if (currentBinding && bundle.techOps?.state === "recovering" && Number.isFinite(leaseExpiry) && leaseExpiry > nowMs) continue;
    actions.push({
      type: "techops_check_qa_preview",
      projectId: project.id,
      projectKey: project.key,
      bundleId: bundle.id,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      healthCheckUrl: healthUrlFor(project, candidate),
      policy,
      policyDigest,
    });
  }
  return actions;
}

async function limitedBody(response, maxBytes = 64 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Health response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Check both availability and immutable candidate identity. */
export async function checkTechOpsPreviewHealth(action, project, input = {}) {
  const startedAt = Date.now();
  try {
    const url = assertLocalHealthUrl(action.healthCheckUrl);
    const fetchImpl = input.fetch || globalThis.fetch;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(action.policy.healthTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const preview = previewConfig(project);
    const identityHeader = String(preview.identityHeader || "x-studioops-commit").trim().toLowerCase();
    const identityJsonField = String(preview.identityJsonField || "commitSha").trim();
    let observedSha = String(response.headers.get(identityHeader) || "").trim().toLowerCase();
    if (!observedSha) {
      const body = await limitedBody(response);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Health response did not attest ${identityHeader} or JSON field ${identityJsonField}.`);
      }
      observedSha = String(parsed?.[identityJsonField] || "").trim().toLowerCase();
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observedSha)) throw new Error("Health response supplied an invalid candidate SHA.");
    if (observedSha !== action.integrationSha) {
      return {
        status: "identity_mismatch",
        reason: `Expected candidate ${action.integrationSha}, observed ${observedSha}.`,
        observedSha,
        durationMs: Date.now() - startedAt,
      };
    }
    return { status: "healthy", reason: "", observedSha, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unavailable",
      reason: boundedText(error.message, action.policy.maxOutputChars),
      observedSha: "",
      durationMs: Date.now() - startedAt,
    };
  }
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function safeCommandCwd(command, project) {
  const preview = previewConfig(project);
  const configured = path.resolve(command.cwd || project.repoPath || "");
  const roots = [project.repoPath, preview.checkoutPath || preview.path]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  if (!roots.length || !roots.some((root) => pathWithin(configured, root))) {
    throw new Error(`Command ${command.id} cwd is outside this project's approved roots.`);
  }
  const [actual, ...actualRoots] = await Promise.all([realpath(configured), ...roots.map((root) => realpath(root).catch(() => root))]);
  if (!actualRoots.some((root) => pathWithin(actual, root))) {
    throw new Error(`Command ${command.id} cwd resolves outside this project's approved roots.`);
  }
  return actual;
}

function dockerComposeProjectName(project) {
  const slug = String(project.key || project.id || "project")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32) || "project";
  const suffix = createHash("sha256").update(`${project.id}:${project.key || ""}`).digest("hex").slice(0, 10);
  return `studioops-${slug}-${suffix}`;
}

async function executeConfiguredCommand(command, project, policy, input = {}) {
  const startedAt = Date.now();
  try {
    const cwd = await safeCommandCwd(command, project);
    const invocation = techOpsCommandInvocation(command);
    const args = [
      "--context",
      "default",
      "compose",
      "--project-name",
      dockerComposeProjectName(project),
      "--project-directory",
      cwd,
      ...invocation.args,
    ];
    const timeout = Math.min(command.timeoutMs || policy.commandTimeoutMs, policy.commandTimeoutMs);
    const execute = input.execCommand || (async (file, args, options) => execFileAsync(file, args, options));
    const result = await execute(invocation.executable, args, {
      cwd,
      timeout,
      maxBuffer: Math.max(1_024, policy.maxOutputChars * 2),
      env: input.env || Object.fromEntries([
        "HOME",
        "TMPDIR",
      ].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]).concat([["PATH", DEFAULT_COMMAND_PATH]])),
    });
    return {
      id: command.id,
      type: command.type,
      ok: true,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      output: boundedText(`${result?.stdout || ""}${result?.stderr || ""}`, policy.maxOutputChars),
    };
  } catch (error) {
    return {
      id: command.id,
      type: command.type,
      ok: false,
      timedOut: error?.killed === true || error?.code === "ETIMEDOUT",
      durationMs: Date.now() - startedAt,
      output: boundedText(`${error?.stdout || ""}${error?.stderr || ""}${error?.message || ""}`, policy.maxOutputChars),
    };
  }
}

function allowlistedRestartLabels(action, project) {
  const configured = action.policy.restartLaunchAgents;
  const allowed = new Set((previewConfig(project).restartLaunchAgents || []).map((item) => String(item)));
  const denied = configured.filter((label) => !allowed.has(label));
  if (denied.length) throw new Error(`TechOps LaunchAgent is not allowlisted by localQaPreview: ${denied.join(", ")}`);
  return configured;
}

async function restartLaunchAgent(label, input = {}) {
  const startedAt = Date.now();
  try {
    if (input.restartLaunchAgent) return await input.restartLaunchAgent(label);
    const uid = String(os.userInfo().uid);
    const result = await execFileAsync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
      timeout: 15_000,
      maxBuffer: 8_000,
    });
    return { label, ok: true, durationMs: Date.now() - startedAt, output: boundedText(`${result.stdout || ""}${result.stderr || ""}`) };
  } catch (error) {
    return { label, ok: false, durationMs: Date.now() - startedAt, output: boundedText(error.message) };
  }
}

async function executeRecovery(action, project, input = {}) {
  const policy = action.policy;
  if (policy.configurationErrors.length) {
    const commands = policy.configurationErrors.slice(0, policy.maxCommandsPerAttempt).map((error) => ({
      id: error.id,
      type: error.type,
      ok: false,
      timedOut: false,
      durationMs: 0,
      output: `configuration_error:${error.code}`,
    }));
    const blocker = `TechOps recovery policy rejected ${commands.map((command) => `${command.id}:${command.output}`).join(", ")}.`;
    return {
      ok: false,
      commands,
      restartResults: [],
      health: { status: "unavailable", reason: blocker, observedSha: "" },
      blocker,
    };
  }
  const selected = policy.commands.slice(0, policy.maxCommandsPerAttempt);
  const commands = [];
  for (const command of selected.filter((item) => item.type === "diagnostic")) {
    commands.push(await executeConfiguredCommand(command, project, policy, input));
  }
  for (const command of selected.filter((item) => item.type === "recovery")) {
    const result = await executeConfiguredCommand(command, project, policy, input);
    commands.push(result);
    if (!result.ok) break;
  }
  const recoveryFailed = commands.some((item) => item.type === "recovery" && !item.ok);
  const restartResults = [];
  if (!recoveryFailed) {
    let labels;
    try {
      labels = allowlistedRestartLabels(action, project);
    } catch (error) {
      return { ok: false, commands, restartResults, health: { status: "unavailable", reason: error.message }, blocker: error.message };
    }
    for (const label of labels) {
      const result = await restartLaunchAgent(label, input);
      restartResults.push(result);
      if (!result.ok) break;
    }
  }
  const restartFailed = restartResults.some((item) => !item.ok);
  let health = { status: "unavailable", reason: "Recovery command or LaunchAgent restart failed.", observedSha: "" };
  if (!recoveryFailed && !restartFailed) {
    const sleep = input.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    for (let attempt = 1; attempt <= policy.verificationAttempts; attempt += 1) {
      health = await checkTechOpsPreviewHealth(action, project, input);
      if (health.status === "healthy") break;
      if (attempt < policy.verificationAttempts && policy.verificationDelayMs > 0) await sleep(policy.verificationDelayMs);
    }
  }
  const failedCommand = commands.find((item) => item.type === "recovery" && !item.ok);
  const failedRestart = restartResults.find((item) => !item.ok);
  const blocker = failedCommand
    ? `Recovery command ${failedCommand.id} failed: ${failedCommand.output}`
    : failedRestart
      ? `LaunchAgent ${failedRestart.label} failed to restart: ${failedRestart.output}`
      : health.status !== "healthy"
        ? `Exact candidate preview verification failed: ${health.reason}`
        : "";
  return { ok: health.status === "healthy", commands, restartResults, health, blocker };
}

async function runAction(action, state, input = {}) {
  const project = (state.projects || []).find((item) => item.id === action.projectId);
  const nowMs = Number(input.nowMs || Date.now());
  const nextCheckAt = new Date(nowMs + action.policy.healthCheckIntervalSeconds * 1_000).toISOString();
  const health = await checkTechOpsPreviewHealth(action, project, input);
  if (health.status === "healthy") {
    await (input.recordHealth || recordQaTechOpsHealth)({
      ...action,
      health,
      nowMs,
      nextCheckAt,
      maxOutputChars: action.policy.maxOutputChars,
    });
    return summarizeTechOpsAction(action, { outcome: "healthy", health });
  }
  const claim = await (input.claimRecovery || claimQaTechOpsRecovery)({
    ...action,
    health,
    nowMs,
    maxAttempts: action.policy.maxAttempts,
    leaseSeconds: action.policy.leaseSeconds,
    maxOutputChars: action.policy.maxOutputChars,
  });
  if (!claim) return summarizeTechOpsAction(action, { type: "techops_recover_qa_preview", outcome: "deferred", health });
  const result = await executeRecovery(action, project, input);
  const incident = await (input.finalizeRecovery || finalizeQaTechOpsRecovery)(claim, result, {
    nowMs: Number(input.nowMsAfterRecovery || Date.now()),
    nextCheckAt,
    initialBackoffMs: action.policy.initialBackoffSeconds * 1_000,
    maxBackoffMs: action.policy.maxBackoffSeconds * 1_000,
    maxOutputChars: action.policy.maxOutputChars,
  });
  return summarizeTechOpsAction(action, {
    type: "techops_recover_qa_preview",
    outcome: result.ok ? "recovered" : incident?.state || "failed",
    health: result.health,
    claim,
    incident,
  });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Run one bounded local TechOps sweep. */
export async function runTechOps(input = {}) {
  const state = input.state || await (input.readState || readState)();
  const actions = planTechOpsActions(state, input);
  const globalLimit = actions.length
    ? Math.max(1, Math.min(4, ...actions.map((action) => action.policy.maxConcurrentRecoveries)))
    : 1;
  const results = await mapConcurrent(actions, globalLimit, async (action) => {
    try {
      return await runAction(action, state, input);
    } catch (error) {
      return summarizeTechOpsAction(action, {
        outcome: "failed_closed",
        error: boundedText(error.message, action.policy.maxOutputChars),
      });
    }
  });
  return { generatedAt: new Date(Number(input.nowMs || Date.now())).toISOString(), actionCount: actions.length, results };
}

export function formatTechOpsReport(report) {
  const lines = [`StudioOps TechOps (${report.generatedAt})`, `Checked: ${report.actionCount}`];
  for (const item of report.results || []) {
    const detail = item.health?.reason || item.error || item.incident?.blocker || "";
    lines.push(`${item.bundleId}: ${item.outcome}${detail ? ` - ${boundedText(detail, 500)}` : ""}`);
  }
  return lines.join("\n");
}
