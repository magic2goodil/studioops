import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertCandidateEnvelope, normalizeGitSha } from "./candidate-manifest.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
  registerIsolatedTestAdapter,
} from "./test-authority-realm.js";

const execFileAsync = promisify(execFile);
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
let trustedGitValidation = null;
const verifiedRepositoryObservations = new WeakMap();
const candidateRepositoryTestAuthority = consumeIsolatedTestAuthority((capability) => capability);

function requireCandidateRepositoryTestAuthority() {
  if (!candidateRepositoryTestAuthority) {
    throw new Error("Candidate repository test authority is unavailable.");
  }
  assertCurrentIsolatedTestAuthority(candidateRepositoryTestAuthority);
  return candidateRepositoryTestAuthority;
}

function bindVerifiedRepositoryObservation(project, candidate, observation, testAuthority = null) {
  verifiedRepositoryObservations.set(observation, {
    projectId: candidate.projectId,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    repository: assertCanonicalCandidateRepositoryAuthority(project).repository,
    observation: JSON.stringify(observation),
    testAuthority,
  });
  return observation;
}

export function assertCandidateRepositoryVerificationObservation(project, candidate, observation) {
  assertCandidateEnvelope(candidate);
  const attested = observation && verifiedRepositoryObservations.get(observation);
  const repository = assertCanonicalCandidateRepositoryAuthority(project).repository;
  if (attested?.testAuthority) {
    assertCurrentIsolatedTestAuthority(attested.testAuthority);
  }
  if (
    !attested
    || observation.ok !== true
    || observation.status !== "verified"
    || !Number.isFinite(Date.parse(observation.verifiedAt || ""))
    || attested.projectId !== candidate.projectId
    || attested.candidateId !== candidate.id
    || attested.manifestDigest !== candidate.manifestDigest
    || attested.integrationSha !== candidate.manifest.integration.sha
    || attested.repository !== repository
    || attested.observation !== JSON.stringify(observation)
  ) {
    throw new Error("Candidate repository verification observation is not an exact attested result.");
  }
  return observation;
}

export function createCandidateRepositoryTestVerificationObservation(project, candidate, observation) {
  const testAuthority = requireCandidateRepositoryTestAuthority();
  if (observation?.ok !== true || observation?.status !== "verified") {
    return observation;
  }
  return bindVerifiedRepositoryObservation(project, candidate, observation, testAuthority);
}

function requiredRepositoryPath(project) {
  const repoPath = String(project?.repoPath || "").trim();
  if (!path.isAbsolute(repoPath)) throw new Error("Candidate verification requires an absolute project repoPath.");
  return repoPath;
}

function githubRepositorySlug(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
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
    || segments.some((segment) => segment === "." || segment === "..")
    || segments[1].toLowerCase().endsWith(".git")
  ) {
    return "";
  }
  const canonical = `https://github.com/${segments[0]}/${segments[1]}`;
  return raw === canonical ? `${segments[0]}/${segments[1]}` : "";
}

function validGitHubRepositorySegments(owner, repository) {
  return [owner, repository].every((segment) => (
    /^[A-Za-z0-9_.-]+$/.test(segment)
    && segment !== "."
    && segment !== ".."
  ));
}

export function equivalentGitHubOriginSlug(value) {
  const raw = String(value || "");
  const scpStyle = raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/);
  if (scpStyle) {
    const [, owner, repository] = scpStyle;
    return validGitHubRepositorySegments(owner, repository)
      ? `${owner}/${repository}`.toLowerCase()
      : "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.hostname !== "github.com"
    || parsed.port
    || parsed.password
    || parsed.search
    || parsed.hash
    || segments.length !== 2
  ) {
    return "";
  }

  if (parsed.protocol === "https:" && !parsed.username) {
    const repository = segments[1].endsWith(".git")
      ? segments[1].slice(0, -".git".length)
      : segments[1];
    if (!validGitHubRepositorySegments(segments[0], repository)) return "";
    const canonical = `https://github.com/${segments[0]}/${repository}${segments[1].endsWith(".git") ? ".git" : ""}`;
    return raw === canonical ? `${segments[0]}/${repository}`.toLowerCase() : "";
  }

  if (parsed.protocol === "ssh:" && parsed.username === "git" && segments[1].endsWith(".git")) {
    const repository = segments[1].slice(0, -".git".length);
    if (!validGitHubRepositorySegments(segments[0], repository)) return "";
    const canonical = `ssh://git@github.com/${segments[0]}/${repository}.git`;
    return raw === canonical ? `${segments[0]}/${repository}`.toLowerCase() : "";
  }
  return "";
}

export function assertCanonicalCandidateRepositoryAuthority(project) {
  const transportUrl = String(project?.repoUrl || "").trim();
  const repository = githubRepositorySlug(transportUrl).toLowerCase();
  if (!repository) {
    throw new Error("Candidate verification requires a configured canonical GitHub repository URL.");
  }
  return { repository, transportUrl };
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trustedGitEnvironment(input = {}) {
  const auth = input.gitAuthEnv || {};
  const isolatedTestRoot = process.env.NODE_ENV === "test"
    && process.env.STUDIOOPS_TEST_ISOLATION === "1"
    && path.isAbsolute(String(process.env.STUDIOOPS_TEST_ROOT || ""))
    ? String(process.env.STUDIOOPS_TEST_ROOT)
    : "";
  const env = {
    PATH: TRUSTED_GIT_PATH,
    HOME: "/",
    TMPDIR: isolatedTestRoot || "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (path.isAbsolute(String(auth.GIT_ASKPASS || ""))) env.GIT_ASKPASS = String(auth.GIT_ASKPASS);
  if (auth.MISSION_CONTROL_GITHUB_TOKEN) {
    env.MISSION_CONTROL_GITHUB_TOKEN = String(auth.MISSION_CONTROL_GITHUB_TOKEN);
  }
  if (auth.MISSION_CONTROL_GIT_USERNAME) {
    env.MISSION_CONTROL_GIT_USERNAME = String(auth.MISSION_CONTROL_GIT_USERNAME);
  }
  return env;
}

async function validateTrustedGitExecutable() {
  if (!trustedGitValidation) {
    trustedGitValidation = (async () => {
      const resolved = await realpath(TRUSTED_GIT_EXECUTABLE).catch(() => "");
      if (resolved !== TRUSTED_GIT_EXECUTABLE) {
        throw new Error("Candidate verification requires the system /usr/bin/git executable.");
      }
      const info = await lstat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error("The candidate-verification Git executable has unsafe ownership or permissions.");
      }
      return resolved;
    })().catch((error) => {
      trustedGitValidation = null;
      throw error;
    });
  }
  return trustedGitValidation;
}

function testGitRunner(input = {}) {
  const adapter = input.testGitRunner;
  if (!adapter) return null;
  const runner = isolatedTestAdapterRun(adapter, "candidate-repository-git");
  if (!runner) {
    throw new Error("Candidate-verification test Git runner was rejected outside its isolated test capability.");
  }
  return runner;
}

export function createCandidateRepositoryTestGitRunner(
  remotePath,
  repositoryUrl = "https://github.com/example/demo",
  observe = null,
) {
  const testAuthority = requireCandidateRepositoryTestAuthority();
  const testRoot = realpathSync(String(process.env.STUDIOOPS_TEST_ROOT || ""));
  let resolvedRemotePath = "";
  try {
    resolvedRemotePath = realpathSync(String(remotePath || ""));
  } catch {
    resolvedRemotePath = "";
  }
  if (
    !resolvedRemotePath
    || !path.isAbsolute(String(remotePath || ""))
    || !pathContains(testRoot, resolvedRemotePath)
    || !githubRepositorySlug(repositoryUrl)
    || (observe !== null && typeof observe !== "function")
  ) {
    throw new Error("The candidate-verification test transport requires an isolated test, an absolute remote path, and a canonical GitHub URL.");
  }
  const rewrite = `url.file://${resolvedRemotePath}.insteadOf=${repositoryUrl}`;
  return registerIsolatedTestAdapter(
    testAuthority,
    "candidate-repository-git",
    async (payload) => {
      assertCurrentIsolatedTestAuthority(testAuthority);
      if (observe) observe(payload);
      const result = await payload.execute([
        "-c",
        "protocol.file.allow=always",
        "-c",
        rewrite,
        ...payload.args,
      ]);
      assertCurrentIsolatedTestAuthority(testAuthority);
      return result;
    },
  );
}

async function trustedGit(repoPath, args, input = {}) {
  await validateTrustedGitExecutable();
  const trustedArgs = [
    "--no-replace-objects",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "push.gpgSign=false",
    ...(repoPath ? ["-C", repoPath] : []),
    ...args,
  ];
  const execute = async (effectiveArgs = trustedArgs) => execFileAsync(
    TRUSTED_GIT_EXECUTABLE,
    effectiveArgs,
    {
      cwd: "/",
      env: trustedGitEnvironment(input),
      timeout: Number(input.timeoutMs || 60_000),
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const runner = testGitRunner(input);
  return runner
    ? runner({ executable: TRUSTED_GIT_EXECUTABLE, repoPath, args: trustedArgs, execute })
    : execute();
}

function splitConfigValues(result) {
  return String(result?.stdout || "")
    .split("\0")
    .filter(Boolean);
}

async function readLocalConfig(repoPath, key, input) {
  try {
    return await trustedGit(
      repoPath,
      ["config", "--local", "--no-includes", "--null", "--get-all", key],
      input,
    );
  } catch (error) {
    if (Number(error?.code) === 1) return { stdout: "", stderr: "" };
    throw error;
  }
}

async function candidateRemotePolicy(project, input = {}) {
  const repoPath = requiredRepositoryPath(project);
  const localInspectionInput = { ...input, gitAuthEnv: undefined };
  const authority = assertCanonicalCandidateRepositoryAuthority(project);
  const fetch = await readLocalConfig(repoPath, "remote.origin.url", localInspectionInput);
  const push = await readLocalConfig(repoPath, "remote.origin.pushurl", localInspectionInput);
  const localKeys = await trustedGit(
    repoPath,
    ["config", "--local", "--no-includes", "--null", "--name-only", "--list"],
    localInspectionInput,
  );
  const unsafeKey = splitConfigValues(localKeys).map((item) => item.toLowerCase()).find((key) => (
    key.startsWith("include.")
    || (key.startsWith("url.") && (key.endsWith(".insteadof") || key.endsWith(".pushinsteadof")))
    || /^remote\.origin\.(?:mirror|proxy|uploadpack|receivepack|vcs)$/.test(key)
    || key === "http.proxy"
    || key.startsWith("http.")
    || key.startsWith("https.")
    || key.startsWith("credential.")
    || key === "core.gitproxy"
    || key === "core.sshcommand"
    || key === "core.worktree"
    || key === "core.askpass"
    || key === "core.alternaterefscommand"
    || key === "core.editor"
    || key === "core.excludesfile"
    || key === "core.hookspath"
    || key === "core.pager"
    || key.startsWith("filter.")
    || key.startsWith("diff.")
    || (key.startsWith("merge.") && key.endsWith(".driver"))
    || key.startsWith("gpg.")
    || key === "commit.gpgsign"
    || key === "tag.gpgsign"
    || key.startsWith("push.")
    || key === "remote.origin.pushoption"
  ));
  if (unsafeKey) {
    throw new Error(`Candidate verification refuses unsafe local Git configuration key ${unsafeKey}.`);
  }
  const fetchUrls = splitConfigValues(fetch);
  const explicitPushUrls = splitConfigValues(push);
  if (fetchUrls.length !== 1) {
    throw new Error("Candidate verification requires exactly one configured origin fetch URL.");
  }
  if (explicitPushUrls.length > 1) {
    throw new Error("Candidate verification refuses an origin with multiple push URLs.");
  }
  const pushUrls = explicitPushUrls.length ? explicitPushUrls : fetchUrls;
  for (const [label, url] of [["fetch", fetchUrls[0]], ["push", pushUrls[0]]]) {
    if (equivalentGitHubOriginSlug(url) !== authority.repository) {
      throw new Error(
        `Candidate verification ${label} remote does not match configured repository ${authority.repository}.`,
      );
    }
  }
  return authority;
}

function expectedRefs(candidate) {
  const manifest = candidate.manifest;
  return [
    {
      kind: "base",
      label: manifest.base.branch,
      ref: `refs/heads/${manifest.base.branch}`,
      expectedSha: manifest.base.sha,
    },
    {
      kind: "integration",
      label: manifest.integration.branch,
      ref: `refs/heads/${manifest.integration.branch}`,
      expectedSha: manifest.integration.sha,
    },
    ...manifest.sources.map((source) => ({
      kind: "source",
      label: source.taskId,
      ref: source.sourceRef,
      expectedSha: source.headSha,
    })),
  ];
}

export async function verifyCandidateRepositoryState(project, candidate, input = {}) {
  assertCandidateEnvelope(candidate);
  const observationTestAuthority = input.testGitRunner
    ? requireCandidateRepositoryTestAuthority()
    : null;
  const refs = expectedRefs(candidate);
  const uniqueRefs = [...new Set(refs.map((item) => item.ref))];
  let stdout = "";
  try {
    const remotePolicy = await candidateRemotePolicy(project, input);
    const result = await trustedGit(
      undefined,
      ["ls-remote", "--refs", "--", remotePolicy.transportUrl, ...uniqueRefs],
      input,
    );
    stdout = result.stdout || "";
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Candidate refs could not be verified: ${String(error.stderr || error.message || "git ls-remote failed").trim()}`,
      expected: "",
      observed: "",
      observations: [],
    };
  }
  const observedByRef = new Map();
  for (const line of stdout.split("\n")) {
    const [rawSha, ref] = line.trim().split(/\s+/);
    if (!rawSha || !ref) continue;
    try {
      observedByRef.set(ref, normalizeGitSha(rawSha, `observed SHA for ${ref}`));
    } catch {
      return {
        ok: false,
        status: "unavailable",
        reason: `Candidate refs returned an invalid SHA for ${ref}.`,
        expected: "",
        observed: rawSha,
        observations: [],
      };
    }
  }
  const observations = refs.map((item) => ({
    ...item,
    observedSha: observedByRef.get(item.ref) || "",
  }));
  const drift = observations.find((item) => item.observedSha !== item.expectedSha);
  if (drift) {
    return {
      ok: false,
      status: "drift",
      reason: `Candidate ${drift.kind} ref drift for ${drift.label}.`,
      expected: drift.expectedSha,
      observed: drift.observedSha || "missing",
      observations,
    };
  }
  return bindVerifiedRepositoryObservation(project, candidate, {
    ok: true,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    observations,
  }, observationTestAuthority);
}
