import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "./candidate-manifest.js";
import { redactSecrets } from "./github-app-auth.js";
import { assertPromotionRemoteObservation } from "./promotion-remote-observation.js";
import { defaultStudioOpsRuntimeRoot, expandLocalPath } from "./runtime-paths.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
} from "./test-authority-realm.js";

const execFileAsync = promisify(execFile);
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const COMMAND_TIMEOUT_MS = 120_000;
const SCHEMA_VERSION = "studioops.promotion-ancestry-observation.v1";
const CLAIM_SCHEMA_VERSION = "studioops.promotion-attempt-claim.v4";
const MAX_OBSERVATION_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const ANCESTRY_TEMP_PREFIX = "verify-";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const verifiedPromotionAncestryObservations = new WeakMap();
const testAuthorityRegistration = consumeIsolatedTestAuthority((capability) => ({ capability }));
let trustedGitValidated = false;

function requiredString(value, label, max = 4_096) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return normalized;
}

function requiredDigest(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function requiredGitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full Git SHA.`);
  return normalized;
}

function exactIsoTime(value, label) {
  const raw = requiredString(value, label, 128);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error(`${label} must be an exact ISO timestamp.`);
  }
  return raw;
}

function canonicalGitHubRepository(value) {
  const raw = requiredString(value, "promotion repository URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Promotion ancestry requires an exact canonical HTTPS GitHub repository URL.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || segments.length !== 2
    || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))
    || segments[1].toLowerCase().endsWith(".git")
    || raw !== `https://github.com/${segments[0]}/${segments[1]}`
  ) {
    throw new Error("Promotion ancestry requires an exact canonical HTTPS GitHub repository URL.");
  }
  return { url: raw, repository: `${segments[0]}/${segments[1]}` };
}

function normalizedCandidate(candidate, label, projectId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${label} is required.`);
  }
  const id = requiredString(candidate.id, `${label} ID`, 256);
  if (String(candidate.projectId || "") !== projectId) throw new Error(`${label} project binding changed.`);
  const manifestDigest = requiredDigest(candidate.manifestDigest, `${label} manifest digest`);
  const integrationSha = requiredGitSha(candidate.manifest?.integration?.sha, `${label} integration SHA`);
  const baseBranch = requiredString(candidate.manifest?.base?.branch, `${label} base branch`, 1_024);
  const sources = (candidate.manifest?.sources || []).map((source) => ({
    taskId: requiredString(source?.taskId, `${label} source task ID`, 256),
    headSha: requiredGitSha(source?.headSha, `${label} source head SHA`),
    candidateCycle: Number(source?.candidateCycle),
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (!sources.length || new Set(sources.map((source) => source.taskId)).size !== sources.length) {
    throw new Error(`${label} source bindings must be non-empty and unique.`);
  }
  if (sources.some((source) => !Number.isSafeInteger(source.candidateCycle) || source.candidateCycle < 1)) {
    throw new Error(`${label} source candidate cycles must be positive integers.`);
  }
  return { id, manifestDigest, integrationSha, baseBranch, sources };
}

function normalizedClaim(claim, projectId, subject) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw new Error("Promotion ancestry requires the final fenced claim.");
  }
  const fence = Number(claim.fence);
  const renewedAt = exactIsoTime(claim.renewedAt, "promotion ancestry claim renewal time");
  const expiresAt = exactIsoTime(claim.expiresAt, "promotion ancestry claim expiry time");
  const replacementDigest = claim.reconciliationReplacementDigest
    ? requiredDigest(claim.reconciliationReplacementDigest, "promotion ancestry replacement digest")
    : "";
  if (
    claim.schemaVersion !== CLAIM_SCHEMA_VERSION
    || !["active", "terminal"].includes(claim.status)
    || claim.mode !== "reconcile"
    || String(claim.projectId || "") !== projectId
    || String(claim.candidateId || "") !== subject.id
    || !Number.isSafeInteger(fence)
    || fence < 1
    || claim.qaDecision?.candidateId !== subject.id
    || String(claim.qaDecision?.manifestDigest || "").toLowerCase() !== subject.manifestDigest
    || String(claim.qaDecision?.integrationSha || "").toLowerCase() !== subject.integrationSha
    || Date.parse(expiresAt) <= Date.parse(renewedAt)
  ) {
    throw new Error("Promotion ancestry claim binding changed.");
  }
  return {
    claimId: requiredString(claim.claimId, "promotion ancestry claim ID", 256),
    fence,
    bindingDigest: requiredDigest(claim.bindingDigest, "promotion ancestry claim binding digest"),
    mode: claim.mode,
    renewedAt,
    expiresAt,
    reconciliationReplacementDigest: replacementDigest,
  };
}

function normalizedAuthority(input = {}) {
  const projectId = requiredString(input.projectId, "promotion ancestry project ID", 256);
  const repository = canonicalGitHubRepository(input.repoUrl);
  const subject = normalizedCandidate(input.subjectCandidate, "promotion ancestry subject candidate", projectId);
  const remote = normalizedCandidate(
    input.remoteCandidate || input.subjectCandidate,
    "promotion ancestry remote candidate",
    projectId,
  );
  const claim = normalizedClaim(input.claim, projectId, subject);
  const targetBranch = requiredString(input.targetBranch, "promotion ancestry target branch", 1_024);
  const promotionBranch = requiredString(input.promotionBranch, "promotion ancestry head branch", 1_024);
  const prUrl = requiredString(input.prUrl, "promotion ancestry pull request URL");
  const mergeCommit = requiredGitSha(input.mergeCommit, "promotion ancestry merge commit");
  const mergedAt = new Date(requiredString(input.mergedAt, "promotion ancestry merge time")).toISOString();
  if (targetBranch !== remote.baseBranch) {
    throw new Error("Promotion ancestry target branch changed.");
  }
  if ((remote.id !== subject.id) !== Boolean(claim.reconciliationReplacementDigest)) {
    throw new Error("Promotion ancestry replacement claim binding changed.");
  }
  const remoteAuthority = {
    projectId,
    repoUrl: repository.url,
    targetBranch,
    promotionBranch,
    headSha: remote.integrationSha,
    candidate: input.remoteCandidate || input.subjectCandidate,
    subjectCandidate: input.subjectCandidate,
    claim: input.claim,
  };
  assertPromotionRemoteObservation(remoteAuthority, input.remoteObservation, {
    state: "MERGED",
    prUrl,
    mergeCommit,
    mergedAt,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    repositoryUrl: repository.url,
    repository: repository.repository,
    targetBranch,
    promotionBranch,
    subject,
    remote,
    claim,
    prUrl,
    mergeCommit,
    mergedAt,
    remoteObservation: canonicalJson(input.remoteObservation),
  };
}

function validateTrustedGitExecutable() {
  if (trustedGitValidated) return;
  const resolved = realpathSync(TRUSTED_GIT_EXECUTABLE);
  const info = lstatSync(resolved);
  if (
    resolved !== TRUSTED_GIT_EXECUTABLE
    || !info.isFile()
    || Number(info.uid) !== 0
    || (Number(info.mode) & 0o022) !== 0
  ) {
    throw new Error("Promotion ancestry requires the root-owned, non-writable system /usr/bin/git executable.");
  }
  trustedGitValidated = true;
}

function trustedGitEnvironment(options = {}) {
  const auth = options.gitAuthEnv || {};
  const env = {
    PATH: TRUSTED_GIT_PATH,
    HOME: "/",
    TMPDIR: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (path.isAbsolute(String(auth.GIT_ASKPASS || ""))) env.GIT_ASKPASS = String(auth.GIT_ASKPASS);
  if (auth.MISSION_CONTROL_GITHUB_TOKEN) env.MISSION_CONTROL_GITHUB_TOKEN = String(auth.MISSION_CONTROL_GITHUB_TOKEN);
  if (auth.MISSION_CONTROL_GIT_USERNAME) env.MISSION_CONTROL_GIT_USERNAME = String(auth.MISSION_CONTROL_GIT_USERNAME);
  return env;
}

async function runGit(repoPath, args, options = {}) {
  validateTrustedGitExecutable();
  const trustedPrefix = [
    "--no-replace-objects",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "http.followRedirects=false",
    "-c", "http.sslVerify=true",
    "-c", "http.proxy=",
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "core.attributesFile=/dev/null",
  ];
  const trustedArgs = [...trustedPrefix, ...args];
  const secrets = [...new Set((options.secrets || []).map(String).filter(Boolean))];
  const execute = async (effectiveArgs = trustedArgs) => {
    // Existing isolated-test adapters prepend their fixture transport config to
    // the trusted invocation. Move only that exact prefix behind our defaults,
    // where Git's last-value-wins rules let the hermetic adapter opt into its
    // local fixture. Production never receives this callback.
    const injectedLength = effectiveArgs.length - trustedArgs.length;
    const hasTrustedSuffix = injectedLength > 0 && trustedArgs.every(
      (value, index) => effectiveArgs[injectedLength + index] === value,
    );
    const executionArgs = hasTrustedSuffix
      ? [...trustedPrefix, ...effectiveArgs.slice(0, injectedLength), ...args]
      : effectiveArgs;
    try {
      const result = await execFileAsync(TRUSTED_GIT_EXECUTABLE, executionArgs, {
        cwd: repoPath,
        env: trustedGitEnvironment(options),
        timeout: Number(options.timeoutMs || COMMAND_TIMEOUT_MS),
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        ok: true,
        stdout: redactSecrets(result.stdout || "", secrets),
        stderr: redactSecrets(result.stderr || "", secrets),
      };
    } catch (error) {
      return {
        ok: false,
        stdout: redactSecrets(error.stdout || "", secrets),
        stderr: redactSecrets(error.stderr || error.message || "", secrets),
      };
    }
  };
  const testRunner = options.testGitRunner
    ? isolatedTestAdapterRun(options.testGitRunner, "promotion-git")
    : null;
  if (options.testGitRunner && !testRunner) {
    throw new Error("Promotion ancestry test Git runner was rejected outside its isolated test capability.");
  }
  const result = testRunner
    ? await testRunner({ executable: TRUSTED_GIT_EXECUTABLE, repoPath, args: trustedArgs, execute })
    : await execute();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Promotion ancestry Git runner returned an invalid result.");
  }
  return {
    ok: result.ok === true,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.output || "").trim(),
  };
}

async function requireGit(repoPath, args, label, options = {}) {
  const result = await runGit(repoPath, args, options);
  if (!result.ok) throw new Error(`${label}: ${result.stderr || "Git verification failed."}`);
  return result.stdout;
}

async function requireAncestor(repoPath, ancestor, descendant, label, options = {}) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], options);
  if (!result.ok) throw new Error(label);
}

function pathContains(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function configuredRuntimeRoot() {
  return path.resolve(expandLocalPath(
    process.env.STUDIOOPS_RUNTIME_ROOT
      || process.env.MISSION_CONTROL_RUNTIME_ROOT
      || defaultStudioOpsRuntimeRoot(),
  ));
}

async function preparePrivateAncestryRepository() {
  const requestedRuntimeRoot = configuredRuntimeRoot();
  await mkdir(requestedRuntimeRoot, { recursive: true, mode: 0o700 });
  const runtimeRoot = await realpath(requestedRuntimeRoot);
  const requestedTempParent = path.join(runtimeRoot, "tmp", "promotion-ancestry");
  await mkdir(requestedTempParent, { recursive: true, mode: 0o700 });
  const tempParent = await realpath(requestedTempParent);
  if (!pathContains(runtimeRoot, tempParent)) {
    throw new Error("Promotion ancestry temporary parent escaped the StudioOps runtime root.");
  }
  const parentInfo = await lstat(tempParent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!parentInfo.isDirectory() || (currentUid !== null && Number(parentInfo.uid) !== currentUid)) {
    throw new Error("Promotion ancestry temporary parent is not a private StudioOps directory.");
  }
  await chmod(tempParent, 0o700);
  const securedParentInfo = await lstat(tempParent);
  if ((Number(securedParentInfo.mode) & 0o077) !== 0) {
    throw new Error("Promotion ancestry temporary parent permissions are not private.");
  }

  const repoPath = await mkdtemp(path.join(tempParent, ANCESTRY_TEMP_PREFIX));
  await chmod(repoPath, 0o700);
  return { repoPath, tempParent };
}

async function removePrivateAncestryRepository(repoPath, tempParent) {
  const resolvedRepoPath = path.resolve(repoPath);
  const relative = path.relative(path.resolve(tempParent), resolvedRepoPath);
  if (
    !relative
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
    || !path.basename(relative).startsWith(ANCESTRY_TEMP_PREFIX)
  ) {
    throw new Error("Refusing to remove an unsafe promotion ancestry repository path.");
  }
  await rm(resolvedRepoPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

function bindPromotionAncestryObservation(authority, targetHeadInput, options = {}, testCapability = null) {
  if (testCapability) assertCurrentIsolatedTestAuthority(testCapability);
  const targetHead = requiredGitSha(targetHeadInput, "promotion ancestry target head");
  const observedAtMs = Number(options.nowMs ?? Date.now());
  if (
    !Number.isFinite(observedAtMs)
    || observedAtMs < Date.parse(authority.claim.renewedAt)
    || observedAtMs > Date.parse(authority.claim.expiresAt)
  ) {
    throw new Error("Promotion ancestry observation is outside the final claim lease generation.");
  }
  const observation = {
    schemaVersion: SCHEMA_VERSION,
    observedAt: new Date(observedAtMs).toISOString(),
    projectId: authority.projectId,
    repositoryUrl: authority.repositoryUrl,
    repository: authority.repository,
    targetBranch: authority.targetBranch,
    targetHead,
    subjectCandidateId: authority.subject.id,
    subjectManifestDigest: authority.subject.manifestDigest,
    subjectIntegrationSha: authority.subject.integrationSha,
    subjectSources: authority.subject.sources,
    remoteCandidateId: authority.remote.id,
    remoteManifestDigest: authority.remote.manifestDigest,
    remoteIntegrationSha: authority.remote.integrationSha,
    claimId: authority.claim.claimId,
    claimFence: authority.claim.fence,
    claimBindingDigest: authority.claim.bindingDigest,
    claimMode: authority.claim.mode,
    claimRenewedAt: authority.claim.renewedAt,
    claimExpiresAt: authority.claim.expiresAt,
    reconciliationReplacementDigest: authority.claim.reconciliationReplacementDigest,
    claimStatusAtObservation: "active",
    prUrl: authority.prUrl,
    mergeCommit: authority.mergeCommit,
    mergedAt: authority.mergedAt,
    remoteObservationDigest: `sha256:${createHash("sha256")
      .update(authority.remoteObservation)
      .digest("hex")}`,
  };
  verifiedPromotionAncestryObservations.set(observation, {
    authority: canonicalJson(authority),
    observation: canonicalJson(observation),
    testCapability,
  });
  return observation;
}

/**
 * Fetch the protected target with trusted Git and seal exact reachability under
 * the final claim and exact already-attested GitHub merge observation.
 */
export async function inspectPromotionMergeAncestry(input = {}, options = {}) {
  const authority = normalizedAuthority(input);
  if (input.claim?.status !== "active") {
    throw new Error("Promotion ancestry inspection requires the active final claim lease.");
  }
  if (/^[.-]|\.\.|[\x00-\x20~^:?*[\\]/.test(authority.targetBranch)) {
    throw new Error("Promotion ancestry target branch is not a safe Git ref.");
  }
  const { repoPath, tempParent } = await preparePrivateAncestryRepository();
  let targetHead;
  try {
    await requireGit(
      repoPath,
      ["init", "--bare", "--quiet", "."],
      "Promotion ancestry could not initialize its private repository",
      options,
    );
    await requireGit(
      repoPath,
      ["check-ref-format", "--branch", authority.targetBranch],
      "Promotion ancestry target branch is invalid",
      options,
    );
    const authorityRef = "refs/studioops/promotion-authority/target";
    await requireGit(
      repoPath,
      [
        "fetch",
        "--force",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--",
        authority.repositoryUrl,
        `+refs/heads/${authority.targetBranch}:${authorityRef}`,
      ],
      "Promotion ancestry could not fetch the exact protected target",
      options,
    );
    targetHead = requiredGitSha(
      await requireGit(repoPath, ["rev-parse", "--verify", `${authorityRef}^{commit}`], "Promotion ancestry target head is unavailable", options),
      "promotion ancestry target head",
    );
    await requireAncestor(
      repoPath,
      authority.remote.integrationSha,
      targetHead,
      "Promotion ancestry remote candidate is not reachable from the protected target.",
      options,
    );
    await requireAncestor(
      repoPath,
      authority.mergeCommit,
      targetHead,
      "Promotion ancestry merge commit is not reachable from the protected target.",
      options,
    );
    await requireAncestor(
      repoPath,
      authority.subject.integrationSha,
      authority.remote.integrationSha,
      "Promotion ancestry subject integration is not included by the remote candidate.",
      options,
    );
    for (const source of authority.subject.sources) {
      await requireAncestor(
        repoPath,
        source.headSha,
        authority.remote.integrationSha,
        `Promotion ancestry source ${source.taskId} is not included by the remote candidate.`,
        options,
      );
    }
  } finally {
    await removePrivateAncestryRepository(repoPath, tempParent);
  }

  return bindPromotionAncestryObservation(authority, targetHead, options);
}

/** Require the exact uncloneable ancestry result at the database boundary. */
export function assertPromotionMergeAncestryObservation(input, observation, options = {}) {
  const authority = normalizedAuthority(input);
  const attested = observation && verifiedPromotionAncestryObservations.get(observation);
  if (attested?.testCapability) assertCurrentIsolatedTestAuthority(attested.testCapability);
  const nowMs = Number(options.nowMs ?? Date.now());
  const observedAtMs = Date.parse(observation?.observedAt || "");
  const expiresAtMs = Date.parse(authority.claim.expiresAt);
  if (
    !attested
    || attested.authority !== canonicalJson(authority)
    || attested.observation !== canonicalJson(observation)
    || observation.schemaVersion !== SCHEMA_VERSION
    || !GIT_SHA_PATTERN.test(String(observation.targetHead || ""))
    || !Number.isFinite(nowMs)
    || !Number.isFinite(observedAtMs)
    || observedAtMs < Date.parse(authority.claim.renewedAt)
    || observedAtMs > expiresAtMs
    || observedAtMs > nowMs + MAX_FUTURE_SKEW_MS
    || nowMs - observedAtMs > MAX_OBSERVATION_AGE_MS
    || nowMs > expiresAtMs
    || observation.claimStatusAtObservation !== "active"
  ) {
    throw new Error("Promotion merge ancestry is not an exact attested Git result.");
  }
  return observation;
}

/** Register a synchronous seal factory available only to the hermetic tests. */
export function registerPromotionAncestryTestHarness(capability) {
  assertCurrentIsolatedTestAuthority(capability);
  if (!testAuthorityRegistration || capability !== testAuthorityRegistration.capability) {
    throw new Error("Promotion ancestry test harness requires boot-time isolated authority.");
  }
  return Object.freeze({
    createPromotionMergeAncestryTestObservation(input, options = {}) {
      assertCurrentIsolatedTestAuthority(capability);
      const authority = normalizedAuthority(input);
      if (input.claim?.status !== "active") {
        throw new Error("Promotion ancestry test observation requires an active claim lease.");
      }
      return bindPromotionAncestryObservation(
        authority,
        options.targetHead || authority.mergeCommit,
        options,
        capability,
      );
    },
  });
}
