import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { canonicalJson, createCandidateEnvelope } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { planPromotions, promotionSweepHealthPatch, truncateOutput } from "../src/promotion.js";
import { promotionProjectPolicyBinding, validPromotionRecoveryReceipt } from "../src/promotion-attempt-claim.js";
import { promotionValidationPolicyDigest } from "../src/promotion-validation-evidence.js";
import {
  DEFAULT_PROJECT_VALIDATION_PATH,
  PROJECT_VALIDATION_SANDBOX_ISOLATION,
  PROJECT_VALIDATION_SANDBOX_POLICY_ID,
} from "../src/project-validation-sandbox.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const TRUSTED_LEGACY_AUTHORITY_FIXTURE_MARKER = ".studioops-trusted-legacy-authority-fixture";
const promotionModuleUrl = pathToFileURL(path.join(process.cwd(), "src/promotion.js")).href;
const promotionAuthorityHarnessModuleUrl = pathToFileURL(
  path.join(process.cwd(), "test/support/promotion-authority-harness.js"),
).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const candidateRepositoryModuleUrl = pathToFileURL(path.join(process.cwd(), "src/candidate-repository.js")).href;
const PROMOTION_ENVIRONMENT_POLICY = "promotion-project-environment-v3-disposable-seatbelt";
const PROMOTION_TOOLCHAIN_SCHEMA = "studioops.promotion-validation-toolchain.v4";
const GITHUB_REPO_URL = "https://github.com/example/demo";
const VALIDATION_SYSTEM_TOOL_ROOTS = [
  "/System", "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share",
  "/usr/local/bin", "/usr/local/sbin", "/usr/local/lib", "/usr/local/share", "/usr/local/Cellar", "/usr/local/opt",
  "/opt/homebrew/bin", "/opt/homebrew/sbin", "/opt/homebrew/lib", "/opt/homebrew/share", "/opt/homebrew/Cellar", "/opt/homebrew/opt",
  "/Applications/Xcode.app/Contents", "/Library/Developer/CommandLineTools", "/Library/Apple/usr/libexec/oah",
];

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function expectedPathProvenance(value, expectedType) {
  const requestedPath = path.resolve(String(value || ""));
  try {
    const resolvedPath = realpathSync(requestedPath);
    const info = lstatSync(resolvedPath);
    const expected = expectedType === "directory" ? info.isDirectory() : info.isFile();
    if (!expected) return { path: requestedPath, type: expectedType, available: false };
    return {
      path: resolvedPath,
      type: expectedType,
      available: true,
      device: Number(info.dev),
      inode: Number(info.ino),
      mode: Number(info.mode & 0o7777),
      uid: Number(info.uid),
      gid: Number(info.gid),
      ...(expectedType === "file" ? {
        bytes: Number(info.size),
        digest: `sha256:${createHash("sha256").update(readFileSync(resolvedPath)).digest("hex")}`,
      } : {}),
    };
  } catch {
    return { path: requestedPath, type: expectedType, available: false };
  }
}

function testPathWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trustedValidationNodePath() {
  const approvedRoots = [...new Set(VALIDATION_SYSTEM_TOOL_ROOTS.flatMap((entry) => {
    try { return [realpathSync(entry)]; } catch { return []; }
  }))];
  for (const entry of DEFAULT_PROJECT_VALIDATION_PATH.split(path.delimiter)) {
    const provenance = expectedPathProvenance(path.join(entry, "node"), "file");
    if (
      provenance.available
      && (lstatSync(provenance.path).mode & 0o111) !== 0
      && approvedRoots.some((root) => testPathWithin(root, provenance.path))
    ) return provenance.path;
  }
  throw new Error("The test host has no trusted Node executable on the project validation PATH.");
}

const TRUSTED_VALIDATION_NODE = trustedValidationNodePath();

function expectedValidationCommandExecutables(commands, pathEntries) {
  const approvedRoots = [...new Set(VALIDATION_SYSTEM_TOOL_ROOTS.flatMap((entry) => {
    try { return [realpathSync(entry)]; } catch { return []; }
  }))];
  const candidates = new Set();
  for (const command of commands) {
    for (const rawToken of String(command).match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()<>]+/g) || []) {
      let token = rawToken.trim();
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
      token = token.replace(/^!+/, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) token = token.slice(token.indexOf("=") + 1);
      if (token && !token.startsWith("-")) candidates.add(token);
    }
  }
  const resolved = [];
  for (const token of [...candidates].sort()) {
    const requestedPaths = path.isAbsolute(token)
      ? [token]
      : /^[A-Za-z0-9_.+-]+$/.test(token)
        ? pathEntries.map((entry) => path.join(entry, token))
        : [];
    for (const requestedPath of requestedPaths) {
      const provenance = expectedPathProvenance(requestedPath, "file");
      if (!provenance.available || (lstatSync(provenance.path).mode & 0o111) === 0) continue;
      assert.equal(approvedRoots.some((root) => testPathWithin(root, provenance.path)), true);
      resolved.push({ command: token, ...provenance });
      break;
    }
  }
  return resolved;
}

function expectedPromotionValidationPolicyDigest(
  project,
  commands = [],
  timeoutMs = 600_000,
  validationPath = DEFAULT_PROJECT_VALIDATION_PATH,
) {
  const projectPolicy = promotionProjectPolicyBinding(project);
  const requestedEntries = String(validationPath)
    .split(path.delimiter)
    .map((entry) => expectedPathProvenance(entry, "directory"));
  const pathRoots = [...new Map(requestedEntries.map((entry) => [entry.path, entry])).values()];
  const pathEntries = pathRoots.map((entry) => entry.path);
  const toolchain = {
    schemaVersion: PROMOTION_TOOLCHAIN_SCHEMA,
    path: pathEntries.join(path.delimiter),
    pathEntries,
    pathRoots,
    commandExecutables: expectedValidationCommandExecutables(commands, pathEntries),
    sandboxPolicyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    processPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
    trustedExecutables: {
      sandbox: expectedPathProvenance("/usr/bin/sandbox-exec", "file"),
      shell: expectedPathProvenance("/bin/bash", "file"),
      git: expectedPathProvenance("/usr/bin/git", "file"),
      verifier: expectedPathProvenance(process.execPath, "file"),
    },
  };
  return promotionValidationPolicyDigest({
    commands,
    timeoutMs,
    environmentPolicyVersion: `${PROMOTION_ENVIRONMENT_POLICY}:${sha256(JSON.stringify(toolchain))}`,
    projectPolicyDigest: sha256(JSON.stringify(projectPolicy)),
    sandboxPolicyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    validationStrategy: "disposable_full_clone",
    networkPolicy: "deny_all",
  });
}

async function bindOriginToGitHub(repoPath) {
  await git(repoPath, ["remote", "set-url", "origin", GITHUB_REPO_URL]);
}

async function installLocalGitHubTransport(binPath, remotePath) {
  await mkdir(binPath, { recursive: true });
  const rewrite = `url.file://${path.resolve(remotePath)}.insteadOf=${GITHUB_REPO_URL}`;
  await writeFile(
    path.join(binPath, "git"),
    `#!/bin/sh\nexec /usr/bin/git -c protocol.file.allow=always -c ${JSON.stringify(rewrite)} "$@"\n`,
    "utf8",
  );
  await chmod(path.join(binPath, "git"), 0o755);
}

function localPromotionGitRunnerExpression(remotePath, repositoryUrl = GITHUB_REPO_URL) {
  const rewrite = `url.file://${path.resolve(remotePath)}.insteadOf=${repositoryUrl}`;
  return `(await import(${JSON.stringify(promotionAuthorityHarnessModuleUrl)})).createPromotionTestGitRunner(
    ({ args, execute }) => execute([
      "-c",
      "protocol.file.allow=always",
      "-c",
      ${JSON.stringify(rewrite)},
      ...args
    ])
  )`;
}

async function writePromotionGitHubApiState(root, state = {}) {
  const statePath = path.join(root, "promotion-github-api.json");
  await writeFile(statePath, `${JSON.stringify({
    pulls: [],
    nextNumber: 42,
    createFailuresRemaining: 0,
    listFailuresRemaining: 0,
    ...state,
  }, null, 2)}\n`, "utf8");
  return statePath;
}

function localPromotionGitHubApiExpression(statePath) {
  return `(await import(${JSON.stringify(promotionAuthorityHarnessModuleUrl)})).createPromotionTestGitHubApi(
    async (request) => {
      const fs = await import("node:fs/promises");
      if (Object.keys(request).some((key) => /authorization|credential|secret|token/i.test(key))) {
        throw new Error("Promotion leaked authentication material into its GitHub API adapter request.");
      }
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      state.requests = state.requests || [];
      state.requests.push({
        operation: request.operation,
        repository: request.repository,
        number: request.number || 0,
        body: request.body || null
      });
      if (state.requestLogPath) {
        await fs.appendFile(state.requestLogPath, request.operation + "\\n", "utf8");
      }
      if (request.operation === "list") {
        if (Number(state.listFailuresRemaining || 0) > 0) {
          state.listFailuresRemaining -= 1;
          await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
          return { ok: false, status: 503, payload: null, output: "synthetic GitHub API outage" };
        }
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
        const pulls = (state.pulls || []).filter((pull) => (
          (!request.baseRefName || (pull.baseRefName || pull.base?.ref) === request.baseRefName)
          && (!request.headRefName || (pull.headRefName || pull.head?.ref) === request.headRefName)
        ));
        return { ok: true, status: 200, payload: pulls };
      }
      if (request.operation === "get-merged-recovery") {
        const pull = (state.pulls || []).find((item) => Number(item.number) === Number(request.number));
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
        return pull
          ? { ok: true, status: 200, payload: pull, output: "" }
          : { ok: false, status: 404, payload: null, output: "pull request missing" };
      }
      if (request.operation === "create") {
        if (state.unexpectedCreateMarker) await fs.writeFile(state.unexpectedCreateMarker, "unexpected", "utf8");
        if (state.beforeCreateImportUrl) await import(state.beforeCreateImportUrl + "?run=" + Date.now());
        if (Number(state.createFailuresRemaining || 0) > 0) {
          state.createFailuresRemaining -= 1;
          await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
          return { ok: false, status: 503, payload: null, output: "transient PR service failure" };
        }
        const number = Number(state.nextNumber || 42);
        const pull = {
          number,
          url: "https://github.com/" + request.repository + "/pull/" + number,
          state: "OPEN",
          mergedAt: "",
          mergeCommit: null,
          baseRefName: request.baseRefName,
          headRefName: request.headRefName,
          headRefOid: request.headRefOid,
          headRepository: { nameWithOwner: request.repository },
          body: request.body.body
        };
        state.pulls = [pull];
        state.nextNumber = number + 1;
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
        return { ok: true, status: 201, payload: pull, output: pull.url };
      }
      if (request.operation === "close") {
        const pull = (state.pulls || []).find((item) => Number(item.number) === Number(request.number));
        if (!pull) return { ok: false, status: 404, payload: null, output: "pull request missing" };
        pull.state = "CLOSED";
        pull.mergedAt = "";
        if (state.closedMarker) await fs.writeFile(state.closedMarker, "closed", "utf8");
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
        return { ok: true, status: 200, payload: pull, output: "closed" };
      }
      if (request.operation === "comment") {
        await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
        return { ok: true, status: 201, payload: { id: 1 }, output: "commented" };
      }
      return { ok: false, status: 400, payload: null, output: "unexpected GitHub API operation" };
    }
  )`;
}

function candidateRepositoryTestRunnerPrelude(remotePath, repositoryUrl = GITHUB_REPO_URL) {
  return `
    import { createCandidateRepositoryTestGitRunner } from ${JSON.stringify(candidateRepositoryModuleUrl)};
    const candidateTestGitRunner = createCandidateRepositoryTestGitRunner(
      ${JSON.stringify(path.resolve(remotePath))},
      ${JSON.stringify(repositoryUrl)}
    );
  `;
}

const nestedValidationSandboxTest = process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX
  ? { skip: "The outer release sandbox cannot run nested validation or local Git remote transport fixtures; these suites run in builder validation." }
  : {};

async function run(command, args, options = {}) {
  const baseEnv = options.cwd && command === process.execPath
    ? await environmentForTestControlRoot(options.cwd)
    : process.env;
  let trustedLegacyAuthorityBootstrap = false;
  if (options.cwd && command === process.execPath) {
    try {
      trustedLegacyAuthorityBootstrap = (await stat(
        path.join(options.cwd, TRUSTED_LEGACY_AUTHORITY_FIXTURE_MARKER),
      )).isFile();
    } catch {
      trustedLegacyAuthorityBootstrap = false;
    }
  }
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: "0",
      ...(trustedLegacyAuthorityBootstrap
        ? { STUDIOOPS_TEST_TRUST_LEGACY_AUTHORITY_BOOTSTRAP: "1" }
        : {}),
      ...(options.env || {}),
    },
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function git(repoPath, args) {
  const result = await run("git", args, { cwd: repoPath });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function configureRepo(repoPath) {
  await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
}

function baseState(overrides = {}) {
  return attachOwnerQaPackets({
    meta: {},
    projects: [],
    tasks: [],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
    qaBundles: [],
    candidates: [],
    ...overrides,
  });
}

function attachOwnerQaPackets(state) {
  state.qaBundles ||= [];
  for (const candidate of state.candidates || []) {
    for (const source of candidate.manifest?.sources || []) {
      const task = (state.tasks || []).find((item) => item.id === source.taskId);
      if (!task) continue;
      task.candidateId ??= candidate.id;
      task.qaBundleId ??= candidate.qaBundleId;
      task.candidateManifestDigest ??= candidate.manifestDigest;
      task.integrationCommit ??= candidate.manifest.integration.sha;
      if (!task.assignedAgentRole) {
        if (candidate.status === "qa_passed") task.assignedAgentRole = "promotion-worker";
        if (candidate.status === "release_candidate_ready") {
          task.assignedAgentRole = task.status === "promotion_blocked" ? "promotion-worker" : "owner";
        }
      }
    }
    if (candidate.qaPacket || !candidate.qaBundleId) continue;
    let bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
    if (!bundle) {
      bundle = {
        id: candidate.qaBundleId,
        projectId: candidate.projectId,
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationBranch: candidate.manifest.integration.branch,
        integrationCommit: candidate.manifest.integration.sha,
        previewUrl: candidate.manifest.preview.url,
        tasks: candidate.manifest.sources.map((source) => ({ id: source.taskId })),
        status: candidate.status === "release_candidate_ready"
          ? "release_candidate_ready"
          : candidate.status === "qa_passed"
            ? "passed"
            : candidate.status === "merged" ? "merged" : "ready",
      };
      state.qaBundles.push(bundle);
    } else {
      bundle.projectId ||= candidate.projectId;
      bundle.candidateId ||= candidate.id;
      bundle.manifestDigest ||= candidate.manifestDigest;
      bundle.integrationBranch ||= candidate.manifest.integration.branch;
      bundle.integrationCommit ||= candidate.manifest.integration.sha;
      bundle.previewUrl ||= candidate.manifest.preview.url;
      bundle.tasks ||= candidate.manifest.sources.map((source) => ({ id: source.taskId }));
    }
    if (candidate.status === "release_candidate_ready" && candidate.promotion) {
      bundle.status = "release_candidate_ready";
      bundle.promotionPrUrl ??= candidate.promotion.prUrl;
      bundle.promotionBranch ??= candidate.promotion.branch;
      bundle.promotionCommit ??= candidate.promotion.commitSha;
      bundle.promotedTaskIds ??= candidate.manifest.sources.map((source) => source.taskId);
      bundle.promotionReadyAt ??= candidate.promotion.readyAt;
    }
    try {
      const packet = buildOwnerQaPacket(state, candidate, {
        bundle,
        generatedAt: candidate.createdAt || "2026-07-25T12:00:00.000Z",
      });
      candidate.qaPacket = structuredClone(packet);
      bundle.qaPacket = structuredClone(packet);
      bundle.packetDigest = packet.packetDigest;
      if (candidate.qaDecision) {
        candidate.qaDecision.ownerQaPacketDigest = packet.packetDigest;
        bundle.qaDecision = structuredClone(candidate.qaDecision);
      }
    } catch {
      // Deliberately corrupt fixtures remain corrupt so production gates fail closed.
    }
  }
  return state;
}

function productionOwnerQaPacketV1(state, candidate) {
  const project = state.projects.find((item) => item.id === candidate.projectId) || {};
  const currentPacket = candidate.qaPacket;
  const currentPacketTasks = new Map((currentPacket?.tasks || []).map((task) => [task.id, task]));
  const base = {
    schemaVersion: "studioops.owner-qa-packet.v1",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    projectId: candidate.projectId,
    projectKey: project.key || "",
    projectName: project.name || project.key || "",
    taskUrlBase: currentPacket?.taskUrlBase || "",
    candidateUrl: currentPacket?.candidateUrl || "",
    previewUrl: candidate.manifest.preview.url,
    integration: {
      branch: candidate.manifest.integration.branch,
      sha: candidate.manifest.integration.sha,
    },
    tasks: candidate.manifest.sources.map((source) => {
      const task = state.tasks.find((item) => item.id === source.taskId);
      const currentPacketTask = currentPacketTasks.get(source.taskId) || {};
      return {
        id: task.id,
        title: task.title,
        expectedOutcome: task.expectedOutcome || task.title,
        taskUrl: currentPacketTask.taskUrl || `/tasks/${encodeURIComponent(task.id)}`,
        prUrl: task.prUrl || "",
        affectedSurfaces: Array.isArray(task.affectedSurfaces) ? task.affectedSurfaces : (task.workAreas || []),
        orderedTests: currentPacketTask.orderedTests || [],
        accountsOrFixtures: task.accountsOrFixtures || task.fixtures || [],
        resetSteps: task.resetSteps || ["Reset the preview data or fixture state before the next criterion."],
        evidence: task.evidence || task.verificationEvidence || [],
        knownRisks: task.knownRisks || task.risks || [],
        migrations: task.migrations || [],
        featureFlags: task.featureFlags || [],
        rollback: task.rollback || "Revert the candidate commit and disable its feature flag, if applicable.",
      };
    }),
    actions: ["pass", "fail", "request_changes", "defer", "open_candidate"].map((action) => ({
      action,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
    })),
    generatedAt: currentPacket.generatedAt,
  };
  return { ...base, packetDigest: sha256(canonicalJson(base)) };
}

function candidateFixture({ baseSha, sourceSha, integrationSha, status = "frozen", projectId = "project_1", taskId = "task_1", candidateId = "candidate_1", bundleId = "qa_bundle_1" }) {
  const candidate = createCandidateEnvelope({
    qaBundleId: bundleId,
    manifest: {
      candidateId,
      projectId,
      base: { branch: "main", sha: baseSha },
      sources: [{
        taskId,
        sourceRef: "refs/heads/feature/task",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T11:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-demo", sha: integrationSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "test -f feature.txt",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T12:00:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: [taskId],
        includedTaskIds: [taskId],
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-07-25T12:00:00.000Z",
  });
  candidate.qaBundleId = bundleId;
  candidate.status = status;
  if (status === "qa_passed") {
    candidate.qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha,
      taskIds: [taskId],
      author: "Owner QA",
      notes: "",
      repositoryVerifiedAt: "2026-07-25T12:29:59.000Z",
      decidedAt: "2026-07-25T12:30:00.000Z",
    };
  }
  return candidate;
}

function releaseCandidateFixture({ baseSha, sourceSha, integrationSha, prUrl, ...identifiers }) {
  const candidate = candidateFixture({ baseSha, sourceSha, integrationSha, status: "qa_passed", ...identifiers });
  candidate.status = "release_candidate_ready";
  candidate.promotion = {
    branch: "qa/promotion-demo",
    prUrl,
    commitSha: integrationSha,
    manifestDigest: candidate.manifestDigest,
    readyAt: "2026-07-25T12:40:00.000Z",
  };
  return candidate;
}

function mergedCandidateFixture({ baseSha, sourceSha, integrationSha, mergeCommit, prUrl }) {
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_2",
    manifest: {
      candidateId: "candidate_2",
      projectId: "project_1",
      base: { branch: "main", sha: baseSha },
      sources: [{
        taskId: "task_2",
        sourceRef: "refs/heads/feature/replacement",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_2",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T13:05:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-replacement", sha: integrationSha },
      checks: [{
        id: "check_2",
        kind: "local-validation",
        name: "test -f replacement.txt",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"b".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T13:10:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_2"],
        includedTaskIds: ["task_2"],
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-07-25T13:10:00.000Z",
  });
  candidate.status = "merged";
  candidate.qaDecision = {
    outcome: "passed",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha,
    taskIds: ["task_2"],
    author: "Owner QA",
    notes: "",
    repositoryVerifiedAt: "2026-07-25T13:11:00.000Z",
    decidedAt: "2026-07-25T13:12:00.000Z",
  };
  candidate.promotion = {
    branch: "qa/promotion-replacement",
    prUrl,
    commitSha: integrationSha,
    manifestDigest: candidate.manifestDigest,
    readyAt: "2026-07-25T13:13:00.000Z",
  };
  candidate.promotionMerge = {
    mergeCommit,
    mergedAt: "2026-07-25T13:14:00.000Z",
    reconciledAt: "2026-07-25T13:15:00.000Z",
  };
  candidate.updatedAt = "2026-07-25T13:15:00.000Z";
  return candidate;
}

test("promotion planning requires a complete candidate-level QA pass, not a status label", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const spoofed = candidateFixture(fixture);
  spoofed.status = "qa_passed";
  const valid = candidateFixture({ ...fixture, status: "qa_passed" });
  const state = baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
    }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
    candidates: [spoofed],
  });
  assert.equal(planPromotions(state).projects.length, 0);
  const legacyApproval = structuredClone(valid);
  delete legacyApproval.qaDecision.ownerQaPacketDigest;
  state.candidates = [legacyApproval];
  assert.equal(planPromotions(state).projects.length, 0);
  const mismatchedApproval = structuredClone(valid);
  mismatchedApproval.qaDecision.ownerQaPacketDigest = `sha256:${"f".repeat(64)}`;
  state.candidates = [mismatchedApproval];
  assert.equal(planPromotions(state).projects.length, 0);
  state.candidates = [valid];
  attachOwnerQaPackets(state);
  assert.equal(planPromotions(state).projects.length, 1);
  state.projects[0].promotion = { targetBranch: "release" };
  delete valid.qaPacket;
  delete state.qaBundles[0].qaPacket;
  delete state.qaBundles[0].packetDigest;
  delete state.qaBundles[0].qaDecision;
  attachOwnerQaPackets(state);
  const redirected = planPromotions(state).projects[0];
  assert.equal(redirected.enabled, false);
  assert.equal(redirected.targetBranch, "main");
  assert.match(redirected.skipReason, /does not match candidate base/);
});

test("promotion planning blocks an atomic candidate until external dependencies are complete", () => {
  const candidate = candidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    status: "qa_passed",
  });
  const sourceTask = {
    id: "task_1",
    projectId: "project_1",
    title: "Candidate task",
    status: "approved_for_main",
    stateVersion: 3,
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: candidate.manifest.integration.sha,
    reviewSubjectCycle: 1,
    dependsOnTaskIds: ["task_dependency"],
  };
  const dependency = {
    id: "task_dependency",
    projectId: "project_1",
    title: "External dependency",
    status: "needs_changes",
    stateVersion: 8,
  };
  const state = baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: GITHUB_REPO_URL,
      defaultBranch: "main",
      validationCommands: ["npm run check"],
      promotion: { enabled: true, targetBranch: "main" },
    }],
    tasks: [sourceTask, dependency],
    candidates: [candidate],
  });

  const blocked = planPromotions(state);
  assert.equal(blocked.projects.length, 1);
  assert.equal(blocked.projects[0].dependencyBlocked, true);
  assert.deepEqual(blocked.projects[0].tasks, []);
  assert.deepEqual(blocked.projects[0].blockedTasks.map((task) => task.taskId), ["task_1"]);

  dependency.status = "merged";
  dependency.stateVersion += 1;
  const released = planPromotions(state);
  assert.equal(released.projects[0].dependencyBlocked, false);
  assert.deepEqual(released.projects[0].tasks.map((task) => task.id), ["task_1"]);
});

test("promotion validation policy binds the canonical effective PATH and executable provenance", () => {
  const candidate = candidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    status: "qa_passed",
  });
  const project = {
    id: "project_1",
    key: "demo",
    name: "Demo",
    repoPath: "/tmp/demo",
    repoUrl: GITHUB_REPO_URL,
    defaultBranch: "main",
    validationCommands: ["npm run check"],
    promotion: { enabled: true, targetBranch: "main" },
  };
  const task = {
    id: "task_1",
    projectId: "project_1",
    title: "Candidate task",
    status: "approved_for_main",
    stateVersion: 4,
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: candidate.manifest.integration.sha,
    reviewSubjectCycle: 1,
  };
  const state = baseState({ projects: [project], tasks: [task], candidates: [candidate] });
  const pathA = "/usr/bin:/bin";
  const pathB = "/usr/bin:/usr/sbin";
  const planA = planPromotions(state, { validationPath: pathA }).projects[0];
  const planB = planPromotions(state, { validationPath: pathB }).projects[0];
  const defaultPlan = planPromotions(state).projects[0];

  assert.notEqual(planA.validationPolicyDigest, planB.validationPolicyDigest);
  assert.equal(planA.validationToolchain.schemaVersion, PROMOTION_TOOLCHAIN_SCHEMA);
  assert.ok(planA.validationToolchain.pathRoots.every((entry) => path.isAbsolute(entry.path)));
  assert.match(planA.validationToolchain.trustedExecutables.git.digest || "", /^sha256:[a-f0-9]{64}$/);
  assert.match(planA.validationToolchain.trustedExecutables.verifier.digest || "", /^sha256:[a-f0-9]{64}$/);
  assert.match(
    defaultPlan.validationToolchain.commandExecutables.find((entry) => entry.command === "npm")?.digest || "",
    /^sha256:[a-f0-9]{64}$/,
  );
  for (const [validationPath, reason] of [
    ["", /non-empty absolute directories/i],
    ["relative/bin", /non-empty absolute directories/i],
    [path.join(process.cwd(), "does-not-exist"), /not an existing directory/i],
    [path.join(process.cwd(), "package.json"), /not an existing directory/i],
    [os.tmpdir(), /unsafe promotion validation PATH entry/i],
  ]) {
    const invalid = planPromotions(state, { validationPath });
    assert.equal(invalid.projects.length, 0);
    assert.equal(invalid.planningFailures[0].code, "PROJECT_VALIDATION_INPUT_INVALID");
    assert.match(invalid.planningFailures[0].reason, reason);
  }

  candidate.promotionValidationRecoveryReceipt = {
    schemaVersion: "studioops.promotion-validation-recovery.v1",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    policyDigest: planA.validationPolicyDigest,
    validationResultDigest: `sha256:${"c".repeat(64)}`,
    validationEvidence: {
      path: "/private-evidence/passed.json",
      digest: `sha256:${"d".repeat(64)}`,
      bytes: 512,
      createdAt: "2026-07-25T12:31:00.000Z",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      attempt: 1,
      policyDigest: planA.validationPolicyDigest,
      commandCount: 1,
    },
    validatedAt: "2026-07-25T12:31:00.000Z",
  };
  task.status = "promotion_blocked";
  task.promotionStatus = "pr_failed";
  task.promotionValidationCandidateId = candidate.id;
  task.promotionValidationAttempts = 1;
  assert.equal(validPromotionRecoveryReceipt(candidate, planA.validationPolicyDigest), true);
  assert.equal(validPromotionRecoveryReceipt(candidate, planB.validationPolicyDigest), false);
  assert.equal(planPromotions(state, { validationPath: pathB }).projects.length, 0);
});

test("promotion planning permits one exact-candidate validation retry without discarding QA evidence", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const candidate = candidateFixture({ ...fixture, status: "qa_passed" });
  const project = {
    id: "project_1",
    key: "demo",
    name: "Demo",
    repoPath: "/tmp/demo",
    defaultBranch: "main",
  };
  const policyDigest = expectedPromotionValidationPolicyDigest(project);
  const task = {
    id: "task_1",
    projectId: "project_1",
    status: "approved_for_main",
    promotionStatus: "validation_failed",
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: fixture.sourceSha,
    reviewSubjectCycle: 1,
    stateVersion: 1,
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts: 1,
    promotionValidation: {
      status: "validation_failed",
      evidence: {
        path: "/private-evidence/attempt-1.json",
        digest: `sha256:${"d".repeat(64)}`,
        bytes: 512,
        createdAt: "2026-07-25T12:30:00.000Z",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: candidate.manifest.integration.sha,
        attempt: 1,
        policyDigest,
        commandCount: 1,
      },
    },
    promotionRetryAuthorization: {
      schemaVersion: "studioops.promotion-retry-authorization.v1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      policyDigest,
      firstEvidenceDigest: `sha256:${"d".repeat(64)}`,
      independentResult: "validation_failed",
      authorizedBy: "studioops-promotion-worker",
      authorizedAt: "2026-07-25T12:31:00.000Z",
    },
  };
  const state = baseState({
    projects: [project],
    tasks: [task],
    candidates: [candidate],
  });

  const retry = planPromotions(state);
  assert.equal(retry.projects.length, 1);
  assert.equal(retry.projects[0].mode, "retry");
  assert.equal(retry.projects[0].validationPolicyDigest, policyDigest);
  assert.deepEqual(retry.projects[0].projectPolicy, promotionProjectPolicyBinding(project));
  assert.equal(retry.projects[0].tasks[0].promotionValidationAttempts, 1);
  assert.equal(candidate.status, "qa_passed");
  assert.equal(candidate.invalidation, null);

  task.promotionValidationAttempts = 2;
  assert.equal(planPromotions(state).projects.length, 0);

  task.promotionValidationAttempts = 1;
  task.reviewSubjectSha = "c".repeat(40);
  assert.equal(planPromotions(state).projects.length, 0);
  task.reviewSubjectSha = fixture.sourceSha;
  project.repoUrl = GITHUB_REPO_URL;
  assert.equal(planPromotions(state).projects.length, 0);
});

test("promotion planning autonomously resumes post-validation operational failures from an exact evidence receipt", () => {
  const fixture = {
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
  };
  const candidate = candidateFixture({ ...fixture, status: "qa_passed" });
  const project = {
    id: "project_1",
    key: "demo",
    name: "Demo",
    repoPath: "/tmp/demo",
    defaultBranch: "main",
  };
  const policyDigest = expectedPromotionValidationPolicyDigest(project);
  candidate.promotionValidationRecoveryReceipt = {
    schemaVersion: "studioops.promotion-validation-recovery.v1",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: candidate.manifest.integration.branch,
    integrationSha: candidate.manifest.integration.sha,
    policyDigest,
    validationResultDigest: `sha256:${"c".repeat(64)}`,
    validationEvidence: {
      path: "/private-evidence/passed.json",
      digest: `sha256:${"d".repeat(64)}`,
      bytes: 512,
      createdAt: "2026-07-25T12:31:00.000Z",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      attempt: 1,
      policyDigest,
      commandCount: 1,
    },
    validatedAt: "2026-07-25T12:31:00.000Z",
  };
  const task = {
    id: "task_1",
    projectId: "project_1",
    status: "promotion_blocked",
    promotionStatus: "pr_failed",
    candidateId: candidate.id,
    qaBundleId: candidate.qaBundleId,
    reviewSubjectSha: fixture.sourceSha,
    reviewSubjectCycle: 1,
    stateVersion: 2,
    promotionValidationCandidateId: candidate.id,
    promotionValidationAttempts: 1,
  };
  const state = baseState({
    projects: [project],
    tasks: [task],
    candidates: [candidate],
  });

  const recovered = planPromotions(state);
  assert.equal(recovered.projects.length, 1);
  assert.equal(recovered.projects[0].mode, "create");
  assert.equal(recovered.projects[0].validationPolicyDigest, policyDigest);
  task.promotionStatus = "pr_closed";
  assert.equal(planPromotions(state).projects.length, 0);
  task.promotionStatus = "pr_failed";
  project.repoUrl = GITHUB_REPO_URL;
  assert.equal(planPromotions(state).projects.length, 0);
  project.repoUrl = "";
  candidate.promotionValidationRecoveryReceipt.validationEvidence.digest = "malformed";
  assert.equal(planPromotions(state).projects.length, 0);
});

test("promotion output keeps the failure tail when bounded", () => {
  const output = truncateOutput(`START\n${"x".repeat(500)}\nFAILURE SUMMARY`, 160);
  assert.match(output, /^START/);
  assert.match(output, /\.\.\.\[truncated\]\.\.\./);
  assert.match(output, /FAILURE SUMMARY$/);
  assert.equal(output.length, 160);
});

test("promotion planning retains persisted release candidates for reconciliation", () => {
  const prUrl = "https://github.com/example/demo/pull/42";
  const candidate = releaseCandidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    prUrl,
  });
  const state = baseState({
    projects: [{
      id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo", defaultBranch: "main",
    }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
    candidates: [candidate],
  });

  const plan = planPromotions(state);
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.projects[0].mode, "reconcile");
  assert.equal(plan.projects[0].candidate.promotion.prUrl, prUrl);
});

test("promotion reconciliation binds declared validation policy without resolving an unsafe executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-reconciliation-policy-"));
  try {
    const unsafeTarget = path.join(root, "group-writable-python");
    const virtualenvBin = path.join(root, "creator-venv", "bin");
    const virtualenvPython = path.join(virtualenvBin, "python");
    await mkdir(virtualenvBin, { recursive: true });
    await writeFile(unsafeTarget, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(unsafeTarget, 0o775);
    await symlink(unsafeTarget, virtualenvPython);
    assert.equal((await stat(unsafeTarget)).mode & 0o022, 0o020);

    const validationCommand = `${virtualenvPython} -m pytest`;
    const project = {
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: GITHUB_REPO_URL,
      defaultBranch: "main",
      validationCommands: [validationCommand],
      promotion: { enabled: true, targetBranch: "main" },
    };
    const releaseCandidate = releaseCandidateFixture({
      baseSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      integrationSha: "b".repeat(40),
      prUrl: "https://github.com/example/demo/pull/42",
    });
    const reconciliationState = baseState({
      projects: [project],
      tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
      candidates: [releaseCandidate],
    });

    const reconciliation = planPromotions(reconciliationState).projects[0];
    assert.equal(reconciliation.mode, "reconcile");
    assert.deepEqual(reconciliation.validationCommands, [validationCommand]);
    assert.deepEqual(reconciliation.projectPolicy, promotionProjectPolicyBinding(project));
    assert.equal(
      reconciliation.validationToolchain.schemaVersion,
      "studioops.promotion-reconciliation-validation-policy.v1",
    );
    assert.equal(reconciliation.validationToolchain.validationExecution, "disabled");
    assert.equal(reconciliation.validationToolchain.executableResolution, "disabled");
    assert.equal(reconciliation.validationToolchain.declaredCommandsDigest, sha256(JSON.stringify([validationCommand])));
    assert.deepEqual(reconciliation.validationToolchain.commandExecutables, []);

    const receiptPolicyDigest = `sha256:${"e".repeat(64)}`;
    releaseCandidate.promotionValidationRecoveryReceipt = {
      schemaVersion: "studioops.promotion-validation-recovery.v1",
      candidateId: releaseCandidate.id,
      manifestDigest: releaseCandidate.manifestDigest,
      integrationBranch: releaseCandidate.manifest.integration.branch,
      integrationSha: releaseCandidate.manifest.integration.sha,
      policyDigest: receiptPolicyDigest,
      validationResultDigest: `sha256:${"c".repeat(64)}`,
      validationEvidence: {
        path: "/private-evidence/passed.json",
        digest: `sha256:${"d".repeat(64)}`,
        bytes: 512,
        createdAt: "2026-07-25T12:31:00.000Z",
        candidateId: releaseCandidate.id,
        manifestDigest: releaseCandidate.manifestDigest,
        integrationSha: releaseCandidate.manifest.integration.sha,
        attempt: 1,
        policyDigest: receiptPolicyDigest,
        commandCount: 1,
      },
      validatedAt: "2026-07-25T12:31:00.000Z",
    };
    const receiptBoundReconciliation = planPromotions(reconciliationState).projects[0];
    assert.equal(receiptBoundReconciliation.mode, "reconcile");
    assert.equal(receiptBoundReconciliation.validationPolicyDigest, receiptPolicyDigest);

    const alternateReconciliationPlan = (projectOverrides) => {
      const alternateCandidate = releaseCandidateFixture({
        baseSha: "a".repeat(40),
        sourceSha: "b".repeat(40),
        integrationSha: "b".repeat(40),
        prUrl: "https://github.com/example/demo/pull/42",
      });
      const alternateState = baseState({
        projects: [{ ...structuredClone(project), ...projectOverrides }],
        tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "user_review" }],
        candidates: [alternateCandidate],
      });
      return planPromotions(alternateState).projects[0];
    };
    assert.notEqual(
      alternateReconciliationPlan({ validationCommands: [`${validationCommand} --version`] }).validationPolicyDigest,
      reconciliation.validationPolicyDigest,
    );
    assert.notEqual(
      alternateReconciliationPlan({ repoPath: "/tmp/alternate-demo" }).validationPolicyDigest,
      reconciliation.validationPolicyDigest,
    );

    const createCandidate = candidateFixture({
      baseSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      integrationSha: "b".repeat(40),
      status: "qa_passed",
    });
    const createState = baseState({
      projects: [structuredClone(project)],
      tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "approved_for_main" }],
      candidates: [createCandidate],
    });
    const invalidCreate = planPromotions(createState);
    assert.equal(invalidCreate.projects.length, 0);
    assert.match(invalidCreate.planningFailures[0].reason, /unsafe writable promotion validation executable/i);

    const safeProject = { ...structuredClone(project), validationCommands: ["/bin/sh -c true"] };
    const retryCandidate = candidateFixture({
      baseSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      integrationSha: "b".repeat(40),
      status: "qa_passed",
    });
    const retryTask = {
      id: "task_1",
      projectId: "project_1",
      title: "Task",
      status: "approved_for_main",
      promotionStatus: "validation_failed",
      reviewSubjectSha: "b".repeat(40),
      reviewSubjectCycle: 1,
      stateVersion: 1,
    };
    const retryState = baseState({
      projects: [safeProject],
      tasks: [retryTask],
      candidates: [retryCandidate],
    });
    const safePolicyDigest = planPromotions(retryState).projects[0].validationPolicyDigest;
    retryTask.promotionValidationCandidateId = retryCandidate.id;
    retryTask.promotionValidationAttempts = 1;
    retryTask.promotionValidation = {
      status: "validation_failed",
      evidence: {
        path: "/private-evidence/attempt-1.json",
        digest: `sha256:${"d".repeat(64)}`,
        bytes: 512,
        createdAt: "2026-07-25T12:30:00.000Z",
        candidateId: retryCandidate.id,
        manifestDigest: retryCandidate.manifestDigest,
        integrationSha: retryCandidate.manifest.integration.sha,
        attempt: 1,
        policyDigest: safePolicyDigest,
        commandCount: 1,
      },
    };
    retryTask.promotionRetryAuthorization = {
      schemaVersion: "studioops.promotion-retry-authorization.v1",
      candidateId: retryCandidate.id,
      manifestDigest: retryCandidate.manifestDigest,
      integrationSha: retryCandidate.manifest.integration.sha,
      policyDigest: safePolicyDigest,
      firstEvidenceDigest: `sha256:${"d".repeat(64)}`,
      independentResult: "validation_failed",
      authorizedBy: "studioops-promotion-worker",
      authorizedAt: "2026-07-25T12:31:00.000Z",
    };
    assert.equal(planPromotions(retryState).projects[0].mode, "retry");

    safeProject.validationCommands = [validationCommand];
    delete retryCandidate.qaPacket;
    delete retryCandidate.qaDecision.ownerQaPacketDigest;
    retryState.qaBundles = [];
    attachOwnerQaPackets(retryState);
    const invalidRetry = planPromotions(retryState);
    assert.equal(invalidRetry.projects.length, 0);
    assert.match(invalidRetry.planningFailures[0].reason, /unsafe writable promotion validation executable/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion planning contains invalid project tooling after checking task eligibility", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-planning-containment-"));
  try {
    const unsafePython = path.join(root, "unsafe-python");
    await writeFile(unsafePython, "#!/bin/sh\nexit 0\n", { mode: 0o775 });
    await chmod(unsafePython, 0o775);
    const coordinates = { baseSha: "a".repeat(40), sourceSha: "b".repeat(40), integrationSha: "b".repeat(40) };
    const unsafe = candidateFixture({ ...coordinates, status: "qa_passed" });
    const healthy = candidateFixture({
      ...coordinates, status: "qa_passed", projectId: "project_2", taskId: "task_2", candidateId: "candidate_2", bundleId: "qa_bundle_2",
    });
    const reconciling = releaseCandidateFixture({
      ...coordinates, taskId: "task_3", candidateId: "candidate_3", bundleId: "qa_bundle_3",
      prUrl: "https://github.com/example/demo/pull/43",
    });
    const state = baseState({
      projects: [
        { id: "project_1", key: "unsafe", name: "Unsafe", repoPath: "/tmp/unsafe", repoUrl: GITHUB_REPO_URL, defaultBranch: "main", validationCommands: [`${unsafePython} -m pytest`] },
        { id: "project_2", key: "healthy", name: "Healthy", repoPath: "/tmp/healthy", repoUrl: "https://github.com/example/healthy", defaultBranch: "main", validationCommands: ["/bin/sh -c true"] },
      ],
      tasks: [
        { id: "task_1", projectId: "project_1", title: "Blocked", status: "blocked" },
        { id: "task_2", projectId: "project_2", title: "Healthy", status: "approved_for_main" },
        { id: "task_3", projectId: "project_1", title: "Reconcile", status: "user_review" },
      ],
      candidates: [unsafe, healthy, reconciling],
    });
    const blocked = planPromotions(state);
    assert.deepEqual(blocked.planningFailures, []);
    assert.deepEqual(blocked.projects.map((project) => [project.candidate.id, project.mode]), [
      ["candidate_3", "reconcile"], ["candidate_2", "create"],
    ]);

    state.tasks[0].status = "approved_for_main";
    const eligible = planPromotions(state);
    assert.deepEqual(eligible.projects.map((project) => [project.candidate.id, project.mode]), [
      ["candidate_3", "reconcile"], ["candidate_2", "create"],
    ]);
    assert.equal(eligible.planningFailures.length, 1);
    assert.equal(eligible.planningFailures[0].candidateId, "candidate_1");
    assert.equal(eligible.planningFailures[0].code, "PROJECT_VALIDATION_INPUT_INVALID");
    assert.match(eligible.planningFailures[0].reason, /unsafe writable/i);
    assert.equal(eligible.projects[0].validationToolchain.executableResolution, "disabled");
    assert.ok(eligible.projects[1].validationToolchain.commandExecutables.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion sweep health deduplicates failures and preserves the last failure after recovery", async () => {
  const { writeWorkerHeartbeat, readWorkerHeartbeats } = await import("../src/worker-heartbeat.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-health-"));
  try {
    const report = {
      projects: [{ projectId: "project_2", status: "pr_ready" }],
      planningFailures: [{ projectId: "project_1", projectKey: "unsafe", candidateId: "candidate_1", taskIds: ["task_1"], code: "PROJECT_VALIDATION_INPUT_INVALID", reason: "Unsafe executable", status: "planning_failed" }],
    };
    const first = promotionSweepHealthPatch({}, report, { nowMs: Date.parse("2026-09-06T00:00:00.000Z") });
    await writeWorkerHeartbeat("promotion", first, { dataDir: root });
    const persisted = (await readWorkerHeartbeats({ dataDir: root }))[0];
    const second = promotionSweepHealthPatch(persisted, report, { nowMs: Date.parse("2026-09-06T00:05:00.000Z") });
    assert.equal(second.status, "degraded");
    assert.equal(second.lastFailure.fingerprint, first.lastFailure.fingerprint);
    assert.equal(second.lastFailure.firstSeenAt, first.lastFailure.firstSeenAt);
    assert.equal(second.lastFailure.observations, 2);
    assert.equal(second.lastSuccessAt, "");
    const recovered = promotionSweepHealthPatch(second, { projects: [] }, { nowMs: Date.parse("2026-09-06T00:10:00.000Z") });
    assert.equal(recovered.status, "idle");
    assert.equal(recovered.activeFailureCount, 0);
    assert.equal(recovered.lastFailure.resolvedAt, "2026-09-06T00:10:00.000Z");
    assert.equal(recovered.lastSuccessAt, recovered.lastSweepCompletedAt);
    assert.equal(recovered.lastFailure.failures[0].candidateId, "candidate_1");
    const failed = promotionSweepHealthPatch(recovered, {}, { error: new Error("Authorization: Bearer abc123secret") });
    assert.equal(failed.status, "degraded");
    assert.doesNotMatch(failed.lastError, /abc123secret/);
    assert.equal(failed.lastSuccessAt, recovered.lastSuccessAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion sweep health preserves recovery-only failures and clears only completed recoveries", () => {
  const previous = { lastSuccessAt: "2026-09-06T00:00:00.000Z" };
  const recovery = { projectId: "project_1", projectKey: "demo", candidateId: "candidate_1", taskIds: ["task_1"] };
  for (const [field, status, code] of [
    ["mergedAdmissionRecoveries", "unavailable", "merged_admission_unavailable"],
    ["mergedAdmissionRecoveries", "invalid", "merged_admission_invalid"],
    ["qaRevocations", "failed", "qa_revocation_failed"],
    ["qaRevocations", "pending", "qa_revocation_pending"],
  ]) {
    const report = { projects: [], [field]: [{ ...recovery, status, reason: "token=private-secret remote unavailable" }] };
    const failed = promotionSweepHealthPatch(previous, report);
    assert.equal(failed.status, "degraded");
    assert.equal(failed.activeFailureCount, 1);
    assert.equal(failed.lastSuccessAt, previous.lastSuccessAt);
    assert.equal(failed.lastFailure.failures[0].code, code);
    assert.equal(failed.lastFailure.failures[0].projectId, recovery.projectId);
    assert.deepEqual(failed.lastFailure.failures[0].taskIds, recovery.taskIds);
    assert.doesNotMatch(JSON.stringify(failed), /private-secret/);
    assert.equal(promotionSweepHealthPatch(failed, report).lastFailure.observations, 2);
    const healthy = promotionSweepHealthPatch(failed, {
      projects: [],
      mergedAdmissionRecoveries: ["recovered", "already_safe"].map((status) => ({ ...recovery, status })),
      qaRevocations: ["revoked", "already_invalidated", "merged", "completed"].map((status) => ({ ...recovery, status })),
    });
    assert.equal(healthy.status, "idle");
    assert.equal(healthy.activeFailureCount, 0);
    assert.ok(healthy.lastFailure.resolvedAt);
    assert.equal(healthy.lastSuccessAt, healthy.lastSweepCompletedAt);
  }
});

test("promotion planning drops stale release candidates after a source task returns to changes", () => {
  const candidate = releaseCandidateFixture({
    baseSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    integrationSha: "b".repeat(40),
    prUrl: "https://github.com/example/demo/pull/42",
  });
  const state = baseState({
    projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath: "/tmp/demo", defaultBranch: "main" }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "needs_changes" }],
    candidates: [candidate],
  });
  assert.equal(planPromotions(state).projects.length, 0);
});

test("promotion circuit publication CAS preserves validation-policy and attempt-epoch races", async (t) => {
  for (const scenario of [
    {
      name: "validation commands drift",
      mutate: "state.projects[0].validationCommands = ['npm run changed-check'];",
      expectedImmediateFailure: /Owner QA packet no longer matches current project or task definitions/,
    },
    {
      name: "automation attempt epoch advances",
      mutate: "state.tasks[0].automationAttemptEpoch += 1;",
      expectedReason: "task_drift:task_1",
    },
    {
      name: "dependency lifecycle advances",
      dependency: true,
      mutate: "state.tasks[1].status = 'done'; state.tasks[1].stateVersion += 1;",
      expectedReason: "task_drift:task_1",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-circuit-cas-"));
      try {
        const candidate = candidateFixture({
          baseSha: "a".repeat(40),
          sourceSha: "b".repeat(40),
          integrationSha: "b".repeat(40),
          status: "qa_passed",
        });
        const legacyClaim = {
          schemaVersion: "studioops.promotion-attempt-claim.v1",
          claimId: "legacy-claim",
          fence: 3,
          status: "terminal",
          operationalAttempt: 3,
          candidateId: candidate.id,
        };
        const sourceTask = {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "approved_for_main",
          stateVersion: 7,
          automationAttemptEpoch: 2,
          reviewSubjectSha: candidate.manifest.integration.sha,
          reviewSubjectCycle: 1,
          qaBundleId: candidate.qaBundleId,
          candidateId: candidate.id,
          promotionStatus: "queued",
          ...(scenario.dependency ? { dependsOnTaskIds: ["task_dependency"] } : {}),
        };
        const dependencyTasks = scenario.dependency ? [{
          id: "task_dependency",
          projectId: "project_1",
          title: "Completed dependency",
          status: "merged",
          stateVersion: 4,
        }] : [];
        await writeState(root, baseState({
          meta: { promotionAttemptClaims: { [candidate.id]: legacyClaim } },
          projects: [{
            id: "project_1",
            key: "demo",
            name: "Demo",
            repoPath: path.join(root, "repo"),
            repoUrl: GITHUB_REPO_URL,
            defaultBranch: "main",
            validationCommands: ["npm run check"],
            promotion: { enabled: true, targetBranch: "main" },
          }],
          tasks: [sourceTask, ...dependencyTasks],
          qaBundles: [{
            id: candidate.qaBundleId,
            projectId: "project_1",
            status: "passed",
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
          }],
          candidates: [candidate],
        }));
        const script = `
          import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
          import { mutateState } from ${JSON.stringify(storeModuleUrl)};
          const report = await runPromotion({
            githubAppAuth: false,
            beforePromotionCircuitPublication: async () => mutateState((state) => {
              ${scenario.mutate}
            })
          });
          console.log(JSON.stringify(report));
        `;
        const invocation = run(
          process.execPath,
          ["--input-type=module", "-e", script],
          { cwd: root },
        );
        if (scenario.expectedImmediateFailure) {
          const report = JSON.parse((await invocation).stdout.trim());
          assert.equal(report.projects[0].status, "project_failed");
          assert.match(report.projects[0].output, scenario.expectedImmediateFailure);
          const state = readPersistedState(root);
          assert.equal(state.tasks[0].status, "approved_for_main");
          assert.equal(state.tasks[0].promotionStatus, "queued");
          assert.equal(state.tasks[0].automationCircuit, undefined);
          assert.equal(state.comments.length, 0);
          assert.equal(state.events.length, 0);
          assert.deepEqual(state.meta.promotionAttemptClaims[candidate.id], legacyClaim);
          return;
        }
        const report = JSON.parse((await invocation).stdout.trim());
        const state = readPersistedState(root);

        assert.equal(report.projects[0].status, "claim_stale");
        assert.match(report.projects[0].output, new RegExp(scenario.expectedReason));
        assert.equal(state.tasks[0].status, scenario.expectedTaskStatus || "approved_for_main");
        assert.equal(state.tasks[0].promotionStatus, scenario.expectedPromotionStatus ?? "queued");
        assert.equal(state.tasks[0].automationCircuit, undefined);
        assert.equal(state.comments.length, 0);
        assert.equal(state.events.length, 0);
        assert.deepEqual(state.meta.promotionAttemptClaims[candidate.id], legacyClaim);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("promotion circuit publication advances lifecycle state with an auditable transition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-circuit-publication-"));
  try {
    const candidate = candidateFixture({
      baseSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      integrationSha: "b".repeat(40),
      status: "qa_passed",
    });
    await writeState(root, baseState({
      meta: {
        promotionAttemptClaims: {
          [candidate.id]: {
            schemaVersion: "studioops.promotion-attempt-claim.v1",
            claimId: "legacy-claim",
            fence: 3,
            status: "terminal",
            operationalAttempt: 3,
            candidateId: candidate.id,
          },
        },
      },
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath: path.join(root, "repo"),
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: ["npm run check"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 7,
        automationAttemptEpoch: 2,
        reviewSubjectSha: candidate.manifest.integration.sha,
        reviewSubjectCycle: 1,
        qaBundleId: candidate.qaBundleId,
        candidateId: candidate.id,
        promotionStatus: "queued",
      }],
      qaBundles: [{
        id: candidate.qaBundleId,
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      console.log(JSON.stringify(await runPromotion({ githubAppAuth: false })));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root },
    )).stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "claim_circuit_open");
    assert.equal(state.tasks[0].status, "blocked");
    assert.equal(state.tasks[0].stateVersion, 8);
    assert.equal(state.tasks[0].automationCircuit.state, "open");
    assert.equal(
      state.events.some((event) => event.type === "lifecycle_transition" && event.action === "open_promotion_circuit"),
      true,
    );
    assert.equal(state.candidates[0].qaDecision.outcome, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion configuration failures open an audited circuit without mutating immutable QA evidence", async (t) => {
  for (const scenario of [
    {
      name: "missing validation commands",
      repoUrl: GITHUB_REPO_URL,
      validationCommands: [],
      githubAppAuth: false,
      outcome: "validation_missing",
      reasonCode: "promotion_validation_commands_missing",
    },
    {
      name: "noncanonical GitHub repository URL",
      repoUrl: `${GITHUB_REPO_URL}.git`,
      validationCommands: ["npm run check"],
      githubAppAuth: true,
      outcome: "remote_policy_invalid",
      reasonCode: "promotion_remote_policy_invalid",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-config-circuit-"));
      try {
        const candidate = candidateFixture({
          baseSha: "a".repeat(40),
          sourceSha: "b".repeat(40),
          integrationSha: "b".repeat(40),
          status: "qa_passed",
        });
        await writeState(root, baseState({
          projects: [{
            id: "project_1",
            key: "demo",
            name: "Demo",
            repoPath: path.join(root, "repo-does-not-need-to-exist"),
            repoUrl: scenario.repoUrl,
            defaultBranch: "main",
            validationCommands: scenario.validationCommands,
            promotion: { enabled: true, targetBranch: "main" },
          }],
          tasks: [{
            id: "task_1",
            projectId: "project_1",
            title: "Feature task",
            status: "approved_for_main",
            stateVersion: 5,
            automationAttemptEpoch: 2,
            reviewSubjectSha: candidate.manifest.integration.sha,
            reviewSubjectCycle: 1,
            qaBundleId: candidate.qaBundleId,
            candidateId: candidate.id,
          }],
          qaBundles: [{
            id: candidate.qaBundleId,
            projectId: "project_1",
            status: "passed",
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
          }],
          candidates: [candidate],
        }));
        const originalQaDecision = structuredClone(candidate.qaDecision);

        const script = `
          import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
          console.log(JSON.stringify(await runPromotion({ githubAppAuth: ${JSON.stringify(scenario.githubAppAuth)} })));
        `;
        const report = JSON.parse((await run(
          process.execPath,
          ["--input-type=module", "-e", script],
          { cwd: root },
        )).stdout.trim());
        const state = readPersistedState(root);

        assert.equal(report.projects[0].status, scenario.outcome);
        assert.equal(state.tasks[0].status, "blocked");
        assert.equal(state.tasks[0].stateVersion, 6);
        assert.equal(state.tasks[0].promotionStatus, scenario.outcome);
        assert.equal(state.tasks[0].automationCircuit.reasonCode, scenario.reasonCode);
        assert.equal(
          state.events.some((event) => (
            event.type === "lifecycle_transition"
            && event.action === "open_promotion_circuit"
            && event.fromStatus === "approved_for_main"
            && event.toStatus === "blocked"
          )),
          true,
        );
        assert.deepEqual(state.candidates[0].qaDecision, originalQaDecision);
        assert.equal(state.meta.promotionAttemptClaims[candidate.id].status, "terminal");
        assert.equal(state.meta.promotionAttemptClaims[candidate.id].outcome, scenario.outcome);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

async function writeState(root, state) {
  attachOwnerQaPackets(state);
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, TRUSTED_LEGACY_AUTHORITY_FIXTURE_MARKER), "test fixture only\n", "utf8");
}

async function reconciliationFixture(prState = "OPEN", overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-reconcile-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const prUrl = "https://github.com/example/demo/pull/42";

  await git(root, ["init", "--bare", remotePath]);
  await git(root, ["clone", remotePath, repoPath]);
  await configureRepo(repoPath);
  await git(repoPath, ["checkout", "-b", "main"]);
  await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "app.txt"]);
  await git(repoPath, ["commit", "-m", "base"]);
  const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["push", "-u", "origin", "main"]);
  await git(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
  await git(repoPath, ["add", "feature.txt"]);
  await git(repoPath, ["commit", "-m", "feature"]);
  const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["push", "-u", "origin", "feature/task"]);
  await git(repoPath, ["branch", "qa/candidate-demo"]);
  await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

  let mergeCommit = null;
  let mergedAt = null;
  if (prState === "MERGED") {
    await git(repoPath, ["checkout", "main"]);
    await git(repoPath, ["merge", "--no-ff", sourceSha, "-m", "merge release candidate"]);
    mergeCommit = await git(repoPath, ["rev-parse", "HEAD"]);
    mergedAt = overrides.mergedAt || "2026-07-25T13:00:00.000Z";
    await git(repoPath, ["push", "origin", "main"]);
  }

  const candidate = releaseCandidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, prUrl });
  await bindOriginToGitHub(repoPath);
  await installLocalGitHubTransport(fakeBin, remotePath);
  const initialState = baseState({
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath,
      repoUrl: GITHUB_REPO_URL,
      defaultBranch: "main",
      promotion: { enabled: true, targetBranch: "main" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Feature task",
      status: "user_review",
      stateVersion: 1,
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: sourceSha,
      branchName: "feature/task",
      candidateId: candidate.id,
      qaBundleId: "qa_bundle_1",
      promotionStatus: "pr_ready",
      promotionBranch: candidate.promotion.branch,
      promotionPrUrl: prUrl,
      promotionCommit: candidate.promotion.commitSha,
    }],
    qaBundles: [{
      id: "qa_bundle_1",
      projectId: "project_1",
      projectKey: "demo",
      status: "release_candidate_ready",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      promotionPrUrl: prUrl,
      tasks: [{ id: "task_1", title: "Feature task" }],
    }],
    candidates: [candidate],
  });
  await writeState(root, initialState);

  const pr = [{
    number: 42,
    state: prState,
    mergedAt: mergedAt || "",
    mergeCommit: mergeCommit ? { oid: mergeCommit } : null,
    baseRefName: overrides.baseRefName || "main",
    headRefName: "qa/promotion-demo",
    headRefOid: overrides.headRefOid || sourceSha,
    headRepository: { nameWithOwner: "example/demo" },
    url: prUrl,
    body: overrides.legacyBody
      ? [
          "## Immutable StudioOps candidate",
          `Candidate: ${candidate.id}`,
          `Manifest: ${candidate.manifestDigest}`,
          `Integration SHA: ${candidate.manifest.integration.sha}`,
        ].join("\n")
      : `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
  }];
  const githubApiStatePath = await writePromotionGitHubApiState(root, { pulls: pr });
  if (overrides.stalePostMerge || overrides.legacyOwnerQaPacket) {
    await run(process.execPath, ["--input-type=module", "-e", `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      await readState();
    `], { cwd: root });
    const database = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"));
    try {
      database.exec("BEGIN IMMEDIATE");
      if (overrides.legacyOwnerQaPacket) {
        const legacyPacket = productionOwnerQaPacketV1(initialState, candidate);
        const candidateRow = database.prepare("SELECT payload FROM candidates WHERE id = ?").get(candidate.id);
        const storedCandidate = JSON.parse(candidateRow.payload);
        storedCandidate.qaPacket = structuredClone(legacyPacket);
        delete storedCandidate.qaDecision.ownerQaPacketDigest;
        database.prepare("UPDATE candidates SET payload = ? WHERE id = ?")
          .run(JSON.stringify(storedCandidate), candidate.id);

        const bundleRow = database.prepare("SELECT payload FROM qa_bundles WHERE id = ?").get(candidate.qaBundleId);
        const storedBundle = JSON.parse(bundleRow.payload);
        storedBundle.qaPacket = structuredClone(legacyPacket);
        storedBundle.packetDigest = legacyPacket.packetDigest;
        storedBundle.qaDecision = structuredClone(storedCandidate.qaDecision);
        database.prepare("UPDATE qa_bundles SET payload = ? WHERE id = ?")
          .run(JSON.stringify(storedBundle), candidate.qaBundleId);
      }
      if (overrides.stalePostMerge) {
        const row = database.prepare("SELECT payload FROM tasks WHERE id = 'task_1'").get();
        const task = JSON.parse(row.payload);
        Object.assign(task, {
          status: "needs_changes",
          assignedAgentRole: "builder",
          promotionStatus: "validation_failed",
          promotionCommit: candidate.manifest.integration.sha,
          promotionUpdatedAt: "2026-07-25T13:00:02.000Z",
          promotionValidation: {
            status: "validation_failed",
            commands: [{ command: "npm test", ok: false, output: "synthetic late failure" }],
          },
          lastAutomationFailure: "stale validation result after remote merge",
          stateVersion: Number(task.stateVersion) + 1,
          updatedAt: "2026-07-25T13:00:02.000Z",
        });
        database.prepare(`
          UPDATE tasks
          SET status = ?, state_version = ?, assigned_role = ?, updated_at = ?, payload = ?
          WHERE id = ?
        `).run(
          task.status,
          task.stateVersion,
          task.assignedAgentRole,
          task.updatedAt,
          JSON.stringify(task),
          task.id,
        );
        const insertEvent = database.prepare(`
          INSERT INTO events (id, sequence, project_id, task_id, type, created_at, payload)
          VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events), ?, ?, ?, ?, ?)
        `);
        const readyEvent = {
          id: "event_legacy_promotion_ready_task_1",
          type: "promotion_pr_ready",
          projectId: task.projectId,
          taskId: task.id,
          message: "Historical release handoff.",
          createdAt: candidate.promotion.readyAt,
        };
        insertEvent.run(
          readyEvent.id,
          task.projectId,
          task.id,
          readyEvent.type,
          readyEvent.createdAt,
          JSON.stringify(readyEvent),
        );
        const failureEvent = {
          id: "event_legacy_promotion_failure_task_1",
          type: "promotion_validation_failed",
          projectId: task.projectId,
          taskId: task.id,
          message: "Historical validation result recorded after merge.",
          createdAt: task.promotionUpdatedAt,
        };
        insertEvent.run(
          failureEvent.id,
          task.projectId,
          task.id,
          failureEvent.type,
          failureEvent.createdAt,
          JSON.stringify(failureEvent),
        );
      }
      database.prepare("UPDATE state_meta SET version = version + 1 WHERE singleton_id = 1").run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }
  return { root, remotePath, repoPath, fakeBin, githubApiStatePath, candidate, sourceSha, mergeCommit };
}

test("promotion GitHub API test adapter is rejected outside isolated test mode", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("OPEN");
  const adapterMarker = path.join(fixture.root, "github-api-adapter-ran");
  try {
    const script = `
      import { writeFile } from "node:fs/promises";
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      await runPromotion({ githubAppAuth: false, dryRun: true });
      process.env.NODE_ENV = "production";
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(fixture.root, "promotion-workspaces"))},
        testGitHubApi: {
          run: async () => {
            await writeFile(${JSON.stringify(adapterMarker)}, "ran", "utf8");
            return { ok: true, status: 200, payload: [] };
          }
        }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());

    assert.equal(report.projects[0].status, "reconciliation_unavailable");
    assert.match(report.projects[0].output, /test GitHub API adapter was rejected/i);
    await assert.rejects(() => stat(adapterMarker), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("owner QA bundle pass binds browser-shaped input to the immutable candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-decision-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha });
    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: GITHUB_REPO_URL,
          defaultBranch: "main",
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Ready task",
          status: "qa_review",
          assignedAgentRole: "owner",
          integrationStatus: "ready",
          integrationCommit: sourceSha,
          candidateManifestDigest: candidate.manifestDigest,
          candidateId: candidate.id,
          qaBundleId: "qa_bundle_1",
          reviewSubjectSha: sourceSha,
          reviewSubjectCycle: 1,
        },
      ],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationCommit: sourceSha,
        status: "ready",
        tasks: [{ id: "task_1", title: "Ready task" }],
      }],
      candidates: [candidate],
    }));

    const qaDecisionScript = (input) => `
      ${candidateRepositoryTestRunnerPrelude(remotePath)}
      import { recordQaDecision } from ${JSON.stringify(storeModuleUrl)};
      await recordQaDecision("task_1", { ...${JSON.stringify({
        outcome: "passed",
        author: "Owner QA",
        body: "Preview looked good.",
        ...input,
      })}, testGitRunner: candidateTestGitRunner });
    `;
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: "candidate_wrong",
        manifestDigest: candidate.manifestDigest,
        integrationSha: sourceSha,
      })], { cwd: root }),
      /candidate ID does not match/,
    );
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: candidate.id,
        manifestDigest: `sha256:${"f".repeat(64)}`,
        integrationSha: sourceSha,
      })], { cwd: root }),
      /manifest digest does not match/,
    );
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", qaDecisionScript({
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationSha: baseSha,
      })], { cwd: root }),
      /integration SHA does not match/,
    );
    assert.equal(readPersistedState(root).tasks[0].status, "qa_review");

    const script = `
      ${candidateRepositoryTestRunnerPrelude(remotePath)}
      import { qaDecisionCoordinatesForState, readState, recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
      const qaState = await readState();
      const result = await recordQaBundleDecision("qa_bundle_1", {
        outcome: "passed",
        author: "Owner QA",
        body: "Preview looked good.",
        candidateId: ${JSON.stringify(candidate.id)},
        manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
        integrationSha: ${JSON.stringify(sourceSha)},
        ownerQaPacketDigest: qaDecisionCoordinatesForState(qaState).bundles.qa_bundle_1,
        testGitRunner: candidateTestGitRunner
      });
      console.log(JSON.stringify(result.decisions[0].task));
    `;
    const result = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const task = JSON.parse(result.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(task.status, "approved_for_main");
    assert.equal(task.assignedAgentRole, "promotion-worker");
    assert.equal(task.promotionStatus, "queued");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(state.candidates[0].qaDecision.manifestDigest, candidate.manifestDigest);
    assert.equal(state.comments[0].author, "Owner QA");
    assert.match(state.comments[0].body, /Local QA passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner QA cannot pass only part of a multi-task candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-atomic-qa-decision-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/one"]);
    await writeFile(path.join(repoPath, "one.txt"), "one\n", "utf8");
    await git(repoPath, ["add", "one.txt"]);
    await git(repoPath, ["commit", "-m", "feature one"]);
    const sourceOneSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/one"]);

    await git(repoPath, ["checkout", "-b", "feature/two"]);
    await writeFile(path.join(repoPath, "two.txt"), "two\n", "utf8");
    await git(repoPath, ["add", "two.txt"]);
    await git(repoPath, ["commit", "-m", "feature two"]);
    const sourceTwoSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/two"]);
    await git(repoPath, ["branch", "qa/candidate-two-tasks"]);
    await git(repoPath, ["push", "origin", "qa/candidate-two-tasks"]);
    await bindOriginToGitHub(repoPath);

    const source = (taskId, sourceRef, headSha, reviewId) => ({
      taskId,
      sourceRef,
      headSha,
      candidateCycle: 1,
      reviews: [{
        id: reviewId,
        stageKey: "lead",
        role: "lead-reviewer",
        outcome: "approved",
        subjectSha: headSha,
        candidateCycle: 1,
        reviewedAt: "2026-07-25T11:00:00.000Z",
      }],
    });
    const candidate = createCandidateEnvelope({
      qaBundleId: "qa_bundle_1",
      manifest: {
        candidateId: "candidate_two_tasks",
        projectId: "project_1",
        base: { branch: "main", sha: baseSha },
        sources: [
          source("task_1", "refs/heads/feature/one", sourceOneSha, "review_1"),
          source("task_2", "refs/heads/feature/two", sourceTwoSha, "review_2"),
        ],
        integration: { branch: "qa/candidate-two-tasks", sha: sourceTwoSha },
        checks: [{
          id: "check_1",
          kind: "local-validation",
          name: "npm test",
          outcome: "passed",
          subjectSha: sourceTwoSha,
          evidenceDigest: `sha256:${"a".repeat(64)}`,
        }],
        preview: {
          url: "http://127.0.0.1:4174/",
          status: "healthy",
          commitSha: sourceTwoSha,
          verifiedAt: "2026-07-25T12:00:00.000Z",
          attestation: {
            kind: "header",
            key: "x-studioops-commit",
            observedSha: sourceTwoSha,
          },
        },
        assembly: {
          mode: "atomic",
          requestedTaskIds: ["task_1", "task_2"],
          includedTaskIds: ["task_1", "task_2"],
          excludedTaskIds: [],
        },
      },
    });
    await writeState(root, baseState({
      projects: [{ id: "project_1", key: "demo", name: "Demo", repoPath, repoUrl: GITHUB_REPO_URL, defaultBranch: "main" }],
      tasks: ["task_1", "task_2"].map((id) => ({
        id,
        projectId: "project_1",
        title: id,
        status: "qa_review",
        assignedAgentRole: "owner",
        integrationStatus: "ready",
        integrationCommit: sourceTwoSha,
        candidateManifestDigest: candidate.manifestDigest,
        candidateId: candidate.id,
        qaBundleId: "qa_bundle_1",
      })),
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "ready",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationCommit: sourceTwoSha,
        tasks: [{ id: "task_1" }, { id: "task_2" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      ${candidateRepositoryTestRunnerPrelude(remotePath)}
      import { qaDecisionCoordinatesForState, readState, recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
      const qaState = await readState();
      await recordQaBundleDecision("qa_bundle_1", {
        outcome: "passed",
        author: "Owner QA",
        taskIds: ["task_1"],
        candidateId: ${JSON.stringify(candidate.id)},
        manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
        integrationSha: ${JSON.stringify(sourceTwoSha)},
        ownerQaPacketDigest: qaDecisionCoordinatesForState(qaState).bundles.qa_bundle_1,
        testGitRunner: candidateTestGitRunner
      });
    `;
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", script], { cwd: root }),
      /atomic and must include every manifest task/,
    );
    const state = readPersistedState(root);
    assert.equal(state.candidates[0].status, "frozen");
    assert.deepEqual(state.tasks.map((task) => task.status), ["qa_review", "qa_review"]);

    await git(repoPath, ["remote", "set-url", "origin", path.join(root, "unavailable.git")]);
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", `
        import { qaDecisionCoordinatesForState, readState, recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        const qaState = await readState();
        await recordQaBundleDecision("qa_bundle_1", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          integrationSha: ${JSON.stringify(sourceTwoSha)},
          ownerQaPacketDigest: qaDecisionCoordinatesForState(qaState).bundles.qa_bundle_1
        });
      `], { cwd: root }),
      /integrity could not be verified/,
    );
    assert.equal(readPersistedState(root).candidates[0].status, "frozen");
    await bindOriginToGitHub(repoPath);

    await run(process.execPath, ["--input-type=module", "-e", `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      import { invalidateCandidate } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/candidate-manifest.js")).href)};
      await mutateState((state) => {
        invalidateCandidate(state.candidates[0], { reason: "Explicit test invalidation." });
      });
    `], { cwd: root });
    await assert.rejects(
      () => run(process.execPath, ["--input-type=module", "-e", `
        ${candidateRepositoryTestRunnerPrelude(remotePath)}
        import { qaDecisionCoordinatesForState, readState, recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        const qaState = await readState();
        await recordQaBundleDecision("qa_bundle_1", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: ${JSON.stringify(candidate.id)},
          manifestDigest: ${JSON.stringify(candidate.manifestDigest)},
          integrationSha: ${JSON.stringify(sourceTwoSha)},
          ownerQaPacketDigest: qaDecisionCoordinatesForState(qaState).bundles.qa_bundle_1,
          testGitRunner: candidateTestGitRunner
        });
      `], { cwd: root }),
      /Invalidated candidate cannot receive a QA decision/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion Git ignores caller PATH and URL rewrite injection before remote access", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-git-isolation-"));
  const remoteA = path.join(root, "remote-a.git");
  const remoteB = path.join(root, "remote-b.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "malicious-bin");
  const fakeHome = path.join(root, "malicious-home");
  const wrapperMarker = path.join(root, "wrapper-ran");
  const helperMarker = path.join(root, "git-helper-ran");
  const remoteObservation = path.join(root, "remote-observation");
  try {
    await git(root, ["init", "--bare", remoteA]);
    await git(root, ["init", "--bare", remoteB]);
    await git(root, ["clone", remoteA, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    await git(repoPath, [
      "config",
      "--local",
      `url.file://${path.resolve(remoteB)}.insteadOf`,
      GITHUB_REPO_URL,
    ]);

    await mkdir(fakeBin, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    await writeFile(
      path.join(fakeBin, "git"),
      `#!/bin/sh\nprintf wrapper > ${JSON.stringify(wrapperMarker)}\nexit 97\n`,
      "utf8",
    );
    await writeFile(
      path.join(fakeBin, "git-upload-pack"),
      `#!/bin/sh\nprintf helper > ${JSON.stringify(helperMarker)}\nexit 98\n`,
      "utf8",
    );
    await chmod(path.join(fakeBin, "git"), 0o755);
    await chmod(path.join(fakeBin, "git-upload-pack"), 0o755);
    const rewrite = `url.file://${path.resolve(remoteB)}.insteadOf=${GITHUB_REPO_URL}`;
    await writeFile(path.join(fakeHome, ".gitconfig"), `[url "file://${path.resolve(remoteB)}"]\n\tinsteadOf = ${GITHUB_REPO_URL}\n`, "utf8");

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: ["test -f feature.txt"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: candidate.qaBundleId,
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: candidate.qaBundleId,
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
      }],
      candidates: [candidate],
    }));

    const script = `
      import { appendFile } from "node:fs/promises";
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        // Keep the separately fenced validation toolchain canonical while
        // exercising an adversarial ordinary caller environment against Git.
        validationPath: "/usr/bin:/bin",
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        testGitRunner: (await import(${JSON.stringify(promotionAuthorityHarnessModuleUrl)})).createPromotionTestGitRunner(
          async ({ args, execute }) => {
            const commandIndex = args.findIndex((arg) => ["ls-remote", "fetch", "push"].includes(arg));
            if (commandIndex >= 0) {
              const resolved = await execute([
                ...args.slice(0, commandIndex),
                "remote",
                "get-url",
                "origin"
              ]);
              await appendFile(
                ${JSON.stringify(remoteObservation)},
                args[commandIndex] + ":" + resolved.stdout.trim() + "\\n",
                "utf8"
              );
              return { ok: false, stdout: "", stderr: "network stopped by test", output: "network stopped by test" };
            }
            return execute(args);
          }
        ),
        env: {
          PATH: ${JSON.stringify(`${fakeBin}:/usr/bin:/bin`)},
          HOME: ${JSON.stringify(fakeHome)},
          GIT_EXEC_PATH: ${JSON.stringify(fakeBin)},
          GIT_CONFIG_GLOBAL: ${JSON.stringify(path.join(fakeHome, ".gitconfig"))},
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: ${JSON.stringify(rewrite.split("=")[0])},
          GIT_CONFIG_VALUE_0: ${JSON.stringify(GITHUB_REPO_URL)},
          GIT_CONFIG_KEY_1: "protocol.file.allow",
          GIT_CONFIG_VALUE_1: "always"
        }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root },
    )).stdout.trim());
    const observation = await readFile(remoteObservation, "utf8");
    const persisted = readPersistedState(root);

    assert.equal(report.projects[0].status, "candidate_verification_unavailable");
    assert.equal(persisted.tasks[0].status, "promotion_blocked");
    assert.equal(persisted.tasks[0].promotionStatus, "candidate_verification_unavailable");
    assert.equal(persisted.tasks[0].stateVersion, 2);
    assert.equal(persisted.candidates[0].status, "qa_passed");
    assert.equal(persisted.candidates[0].qaDecision.outcome, "passed");
    assert.equal(persisted.meta.promotionAttemptClaims[candidate.id].outcome, "candidate_verification_unavailable");
    assert.ok(persisted.meta.promotionAttemptClaims[candidate.id].retryNotBefore);
    assert.equal(
      persisted.events.some((event) => event.type === "lifecycle_transition" && event.action === "record_promotion_outcome"),
      true,
    );
    assert.equal(observation, `ls-remote:${GITHUB_REPO_URL}\n`);
    await assert.rejects(() => stat(wrapperMarker), /ENOENT/);
    await assert.rejects(() => stat(helperMarker), /ENOENT/);
    assert.equal(
      await git(remoteB, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
    assert.equal(
      await git(remoteA, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion retries one exact QA candidate with scrubbed validation credentials without updating main", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const forbiddenHostWrite = path.join(root, "validation-must-not-write-here");
  const fakeGhMarker = path.join(root, "path-gh-was-executed");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);
    await writeFile(
      path.join(fakeBin, "gh"),
      `#!/bin/sh\nif [ -n "$GH_TOKEN$GITHUB_TOKEN$MISSION_CONTROL_GITHUB_TOKEN" ]; then printf token-bearing > ${JSON.stringify(fakeGhMarker)}; else printf invoked > ${JSON.stringify(fakeGhMarker)}; fi\nexit 97\n`,
      "utf8",
    );
    await chmod(path.join(fakeBin, "gh"), 0o755);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const blockedValidationKeys = [
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "GIT_ASKPASS",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_SSH_COMMAND",
      "SSH_AUTH_SOCK",
      "MISSION_CONTROL_GITHUB_APP_AUTH",
      "MISSION_CONTROL_GITHUB_TOKEN",
      "MISSION_CONTROL_GIT_USERNAME",
      "STUDIOOPS_GITHUB_PRIVATE_KEY",
      "GITHUB_APP_ID",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "NPM_TOKEN",
    ];
    const validationProbe = `const fs = require("node:fs"); const path = require("node:path"); const blocked = ${JSON.stringify(blockedValidationKeys)}; const home = process.env.HOME || ""; if (blocked.some((key) => Object.hasOwn(process.env, key)) || Object.hasOwn(process.env, "STUDIOOPS_TEST_MARKER") || !home.includes("validation-sandbox-") || path.basename(home) !== "home" || process.env.TMPDIR !== path.join(home, "tmp") || process.env.XDG_CONFIG_HOME !== path.join(home, ".config") || process.env.XDG_CACHE_HOME !== path.join(home, ".cache") || process.env.GH_CONFIG_DIR !== path.join(home, ".config", "gh") || process.env.npm_config_cache !== path.join(home, ".npm-cache") || process.env.CI !== "1" || process.env.GIT_CONFIG_NOSYSTEM !== "1" || process.env.GIT_CONFIG_GLOBAL !== "/dev/null" || process.env.GIT_TERMINAL_PROMPT !== "0") process.exit(23); try { fs.writeFileSync(${JSON.stringify(forbiddenHostWrite)}, "forbidden") } catch (error) { if (!["EACCES", "EPERM"].includes(error.code)) process.exit(24); process.exit(0) } process.exit(25)`;
    const validationCommand = `${JSON.stringify(TRUSTED_VALIDATION_NODE)} -e ${JSON.stringify(validationProbe)} && test -f feature.txt`;
    const project = {
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath,
      repoUrl: GITHUB_REPO_URL,
      defaultBranch: "main",
      validationCommands: [validationCommand],
      promotion: {
        enabled: true,
        targetBranch: "main",
      },
    };
    const validationPolicyDigest = expectedPromotionValidationPolicyDigest(project, [validationCommand]);
    const promotionBranch = `qa/promotion-demo-${candidate.manifestDigest.replace(/^sha256:/, "").slice(0, 16)}`;
    const exactPr = [{
      number: 42,
      url: "https://github.com/example/demo/pull/42",
      state: "OPEN",
      mergedAt: "",
      mergeCommit: null,
      baseRefName: "main",
      headRefName: promotionBranch,
      headRefOid: sourceSha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
    }];
    const githubApiStatePath = await writePromotionGitHubApiState(root, { pulls: exactPr });
    await writeState(root, baseState({
      projects: [project],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "approved_for_main",
          stateVersion: 1,
          branchName: "feature/task",
          prUrl: "",
          promotionStatus: "validation_failed",
          reviewSubjectSha: sourceSha,
          reviewSubjectCycle: 1,
          qaBundleId: "qa_bundle_1",
          candidateId: candidate.id,
          promotionValidationCandidateId: candidate.id,
          promotionValidationAttempts: 1,
          promotionValidation: {
            status: "validation_failed",
            evidence: {
              path: "/private-evidence/attempt-1.json",
              digest: `sha256:${"e".repeat(64)}`,
              bytes: 512,
              createdAt: "2026-07-25T12:30:00.000Z",
              candidateId: candidate.id,
              manifestDigest: candidate.manifestDigest,
              integrationSha: candidate.manifest.integration.sha,
              attempt: 1,
              policyDigest: validationPolicyDigest,
              commandCount: 1,
            },
          },
          promotionRetryAuthorization: {
            schemaVersion: "studioops.promotion-retry-authorization.v1",
            candidateId: candidate.id,
            manifestDigest: candidate.manifestDigest,
            integrationSha: candidate.manifest.integration.sha,
            policyDigest: validationPolicyDigest,
            firstEvidenceDigest: `sha256:${"e".repeat(64)}`,
            independentResult: "validation_failed",
            authorizedBy: "studioops-promotion-worker",
            authorizedAt: "2026-07-25T12:31:00.000Z",
          },
        },
      ],
      qaBundles: [
        {
          id: "qa_bundle_1",
          projectId: "project_1",
          projectKey: "demo",
          status: "passed",
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          tasks: [{ id: "task_1", title: "Feature task" }],
        },
      ],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(githubApiStatePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: {
          PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)},
          STUDIOOPS_TEST_MARKER: "caller-only",
          GH_TOKEN: "secret-gh-token",
          GH_ENTERPRISE_TOKEN: "secret-gh-enterprise-token",
          GITHUB_TOKEN: "secret-github-token",
          GIT_ASKPASS: "/tmp/secret-askpass",
          GIT_CONFIG_PARAMETERS: "'http.extraheader=secret'",
          GIT_CONFIG_COUNT: "3",
          GIT_CONFIG_KEY_0: ${JSON.stringify(`url.file://${path.resolve(remotePath)}.insteadOf`)},
          GIT_CONFIG_VALUE_0: ${JSON.stringify(GITHUB_REPO_URL)},
          GIT_CONFIG_KEY_1: "protocol.file.allow",
          GIT_CONFIG_VALUE_1: "always",
          GIT_CONFIG_KEY_2: "credential.helper",
          GIT_CONFIG_VALUE_2: "secret-helper",
          GIT_SSH_COMMAND: "ssh -i /tmp/secret-key",
          GIT_TERMINAL_PROMPT: "0",
          MISSION_CONTROL_GITHUB_TOKEN: "secret-mission-token",
          MISSION_CONTROL_GITHUB_APP_AUTH: "1",
          MISSION_CONTROL_GIT_USERNAME: "x-access-token",
          STUDIOOPS_GITHUB_PRIVATE_KEY: "secret-private-key",
          GITHUB_APP_ID: "123",
          GITHUB_INSTALLATION_ID: "456",
          GITHUB_PRIVATE_KEY: "secret-github-private-key",
          SSH_AUTH_SOCK: "/tmp/secret-ssh-agent",
          OPENAI_API_KEY: "secret-openai-key",
          AWS_SECRET_ACCESS_KEY: "secret-aws-key",
          NPM_TOKEN: "secret-npm-token",
          HOME: "/tmp/credential-bearing-home"
        }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].mode, "retry");
    assert.equal(report.projects[0].status, "pr_ready", report.projects[0].output);
    assert.equal(report.projects[0].validationSandboxPolicy, PROJECT_VALIDATION_SANDBOX_POLICY_ID);
    assert.equal(report.projects[0].validationWorkspaceStrategy, "disposable_full_clone");
    assert.equal(report.projects[0].validationNetworkPolicy, "deny_all");
    assert.deepEqual(report.projects[0].validationProcessPolicy, PROJECT_VALIDATION_SANDBOX_ISOLATION);
    assert.equal(report.projects[0].tasks[0].status, "pr_ready");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.tasks[0].promotionStatus, "pr_ready");
    assert.deepEqual(state.tasks[0].promotionValidationProcessPolicy, PROJECT_VALIDATION_SANDBOX_ISOLATION);
    assert.equal(state.tasks[0].promotionValidationCandidateId, candidate.id);
    assert.equal(state.tasks[0].promotionValidationAttempts, 2);
    assert.equal(state.tasks[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.qaBundles[0].status, "release_candidate_ready");
    assert.equal(state.qaBundles[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.candidates[0].status, "release_candidate_ready");
    assert.equal(state.candidates[0].promotionValidationRecoveryReceipt.policyDigest, validationPolicyDigest);
    assert.equal(state.candidates[0].promotion.commitSha, sourceSha);
    assert.ok(report.projects[0].promotionBranch);
    assert.ok(await git(root, ["--git-dir", remotePath, "rev-parse", `refs/heads/${report.projects[0].promotionBranch}`]));
    await assert.rejects(() => git(root, ["--git-dir", remotePath, "show", "refs/heads/main:feature.txt"]));
    await assert.rejects(() => stat(forbiddenHostWrite), /ENOENT/);
    await assert.rejects(() => stat(fakeGhMarker), /ENOENT/);
    assert.equal(state.events.some((event) => event.type === "release_candidate_ready"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion reuses verified validation evidence after a transient PR failure", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-pr-recovery-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const prAttemptMarker = path.join(root, "pr-attempted");
  const createdPrBody = path.join(root, "created-pr-body");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    const githubApiStatePath = await writePromotionGitHubApiState(root, {
      pulls: [],
      nextNumber: 42,
      createFailuresRemaining: 2,
    });

    const validationCommand = "test -f feature.txt";
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        nowMs: Number(process.env.STUDIOOPS_TEST_NOW_MS || 0) || undefined,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(githubApiStatePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: {
          PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)}
        }
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const firstState = readPersistedState(root);
    assert.equal(first.projects[0].status, "pr_failed", first.projects[0].output);
    assert.equal(firstState.tasks[0].status, "promotion_blocked");
    assert.equal(firstState.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(firstState.tasks[0].promotionValidationAttempts, 1);
    assert.equal(firstState.tasks[0].promotionRetryAuthorization, null);
    assert.ok(firstState.candidates[0].promotionValidationRecoveryReceipt.validationEvidence.digest);
    assert.equal(planPromotions(firstState).projects[0].mode, "create");
    assert.equal(firstState.meta.promotionAttemptClaims[candidate.id].operationalAttempt, 1);
    assert.equal(
      Date.parse(firstState.meta.promotionAttemptClaims[candidate.id].retryNotBefore)
        - Date.parse(firstState.meta.promotionAttemptClaims[candidate.id].terminalAt),
      60_000,
    );
    const firstEvidenceDigest = firstState.candidates[0].promotionValidationRecoveryReceipt.validationEvidence.digest;

    const deferred = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    assert.equal(deferred.projects[0].status, "claim_retry_deferred");
    assert.equal(deferred.projects[0].retryNotBefore, firstState.meta.promotionAttemptClaims[candidate.id].retryNotBefore);

    const secondFailure = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { STUDIOOPS_TEST_NOW_MS: String(Date.parse(firstState.meta.promotionAttemptClaims[candidate.id].retryNotBefore) + 1) },
    })).stdout.trim());
    const secondFailureState = readPersistedState(root);
    assert.equal(secondFailure.projects[0].status, "pr_failed", secondFailure.projects[0].output);
    assert.equal(secondFailure.projects[0].validation[0].command, "[exact promotion recovery receipt]");
    assert.equal(secondFailureState.meta.promotionAttemptClaims[candidate.id].operationalAttempt, 2);
    assert.equal(
      Date.parse(secondFailureState.meta.promotionAttemptClaims[candidate.id].retryNotBefore)
        - Date.parse(secondFailureState.meta.promotionAttemptClaims[candidate.id].terminalAt),
      120_000,
    );
    assert.equal(secondFailureState.candidates[0].promotionValidationRecoveryReceipt.validationEvidence.digest, firstEvidenceDigest);

    const deferredAgain = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    assert.equal(deferredAgain.projects[0].status, "claim_retry_deferred");
    assert.equal(deferredAgain.projects[0].retryNotBefore, secondFailureState.meta.promotionAttemptClaims[candidate.id].retryNotBefore);

    const recovered = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { STUDIOOPS_TEST_NOW_MS: String(Date.parse(secondFailureState.meta.promotionAttemptClaims[candidate.id].retryNotBefore) + 1) },
    })).stdout.trim());
    const recoveredState = readPersistedState(root);
    assert.equal(recovered.projects[0].status, "pr_ready", recovered.projects[0].output);
    assert.equal(recovered.projects[0].validation[0].command, "[exact promotion recovery receipt]");
    assert.equal(recoveredState.tasks[0].status, "user_review");
    assert.equal(recoveredState.tasks[0].promotionValidationAttempts, 1);
    assert.equal(recoveredState.candidates[0].status, "release_candidate_ready");
    assert.equal(recoveredState.candidates[0].promotionValidationRecoveryReceipt.validationEvidence.digest, firstEvidenceDigest);
    assert.equal(recoveredState.meta.promotionAttemptClaims[candidate.id].operationalAttempt, 3);
    assert.equal(await git(repoPath, ["status", "--porcelain"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion never treats a closed exact pull request as release-ready", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-closed-pr-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const unexpectedCreate = path.join(root, "unexpected-create");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    const promotionBranch = `qa/promotion-demo-${candidate.manifestDigest.replace(/^sha256:/, "").slice(0, 16)}`;
    const closedPr = [{
      number: 41,
      url: "https://github.com/example/demo/pull/41",
      state: "CLOSED",
      mergedAt: "",
      mergeCommit: null,
      baseRefName: "main",
      headRefName: promotionBranch,
      headRefOid: sourceSha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
    }];
    const githubApiStatePath = await writePromotionGitHubApiState(root, {
      pulls: closedPr,
      unexpectedCreateMarker: unexpectedCreate,
    });
    await writeState(root, baseState({
      projects: [{
        id: "project_1", key: "demo", name: "Demo", repoPath, repoUrl: GITHUB_REPO_URL, defaultBranch: "main",
        validationCommands: ["test -f feature.txt"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1", projectId: "project_1", title: "Feature task", status: "approved_for_main",
        stateVersion: 1, branchName: "feature/task", promotionStatus: "queued",
        reviewSubjectSha: sourceSha, reviewSubjectCycle: 1, qaBundleId: "qa_bundle_1", candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1", projectId: "project_1", status: "passed", candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest, tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(githubApiStatePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: {
          PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)}
        }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const state = readPersistedState(root);
    assert.equal(report.projects[0].status, "pr_closed");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/41");
    assert.equal(state.tasks[0].status, "promotion_blocked");
    assert.equal(state.tasks[0].assignedAgentRole, "owner");
    assert.equal(state.tasks[0].stateVersion, 3);
    assert.equal(state.tasks[0].promotionEvidence.outcome, "pr_closed");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(planPromotions(state).projects.length, 0);
    await assert.rejects(() => stat(unexpectedCreate), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion records complete private failure evidence and exhausts one bounded exact-candidate retry", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-bounded-retry-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const secret = "promotion-output-secret-value";
    const validationProgram = [
      'console.log("HEAD-SENTINEL")',
      `console.log("${"x".repeat(5_000)}")`,
      'console.log("MIDDLE-SENTINEL")',
      'console.log("password=" + ["promotion", "output", "secret", "value"].join("-"))',
      'console.error("TAIL-SENTINEL")',
      "process.exit(7)",
    ].join(";");
    const validationCommand = `${JSON.stringify(TRUSTED_VALIDATION_NODE)} -e ${JSON.stringify(validationProgram)}`;
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const runScript = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const firstRun = await run(process.execPath, ["--input-type=module", "-e", runScript], { cwd: root });
    const firstReport = JSON.parse(firstRun.stdout.trim());
    const firstState = readPersistedState(root);
    const evidence = firstState.tasks[0].promotionValidation.evidence;
    const evidenceText = await readFile(evidence.path, "utf8");
    const evidenceInfo = await stat(evidence.path);

    assert.equal(firstReport.projects[0].status, "validation_failed");
    assert.equal(firstState.tasks[0].status, "approved_for_main");
    assert.equal(firstState.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(firstState.tasks[0].promotionValidationAttempts, 1);
    assert.equal(firstState.tasks[0].promotionRetryAuthorization.firstEvidenceDigest, evidence.digest);
    assert.equal(firstState.candidates[0].status, "qa_passed");
    assert.equal(evidenceInfo.mode & 0o777, 0o600);
    assert.match(evidenceText, /HEAD-SENTINEL/);
    assert.match(evidenceText, /MIDDLE-SENTINEL/);
    assert.match(evidenceText, /TAIL-SENTINEL/);
    assert.equal(evidenceText.includes(secret), false);
    assert.equal(JSON.stringify(firstReport).includes(secret), false);
    assert.equal(JSON.stringify(firstState.tasks[0].promotionValidation).includes(secret), false);
    assert.equal(planPromotions(firstState).projects[0].mode, "retry");

    const secondRun = await run(process.execPath, ["--input-type=module", "-e", runScript], { cwd: root });
    const secondReport = JSON.parse(secondRun.stdout.trim());
    const secondState = readPersistedState(root);
    assert.equal(secondReport.projects[0].mode, "retry");
    assert.equal(secondReport.projects[0].status, "validation_failed");
    assert.equal(secondState.tasks[0].promotionValidationAttempts, 2);
    assert.equal(secondState.tasks[0].status, "needs_changes");
    assert.equal(secondState.tasks[0].assignedAgentRole, "builder");
    assert.equal(secondState.candidates[0].status, "invalidated");
    assert.match(secondState.candidates[0].invalidation.reason, /bounded retry/i);
    assert.equal(secondState.qaBundles[0].status, "invalidated");
    assert.equal(planPromotions(secondState).projects.length, 0);
    assert.equal(await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion blocks unsupported task ownership drift before push", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-claim-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const unexpectedCreate = path.join(root, "unexpected-pr-create");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    const githubApiStatePath = await writePromotionGitHubApiState(root, {
      unexpectedCreateMarker: unexpectedCreate,
    });
    const validationCommand = "test -f feature.txt";
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: [validationCommand],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(githubApiStatePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} },
        beforePromotionPush: async () => {
          await mutateState((state) => {
            state.tasks[0].assignedAgentRole = "builder";
          });
        }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "candidate_verification_unavailable", JSON.stringify(report.projects[0]));
    assert.match(report.projects[0].output, /exact authority links and assignments/i);
    assert.equal(state.tasks[0].status, "promotion_blocked");
    assert.equal(state.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(state.tasks[0].promotionStatus, "candidate_verification_unavailable");
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]), "");
    const githubApiState = JSON.parse(await readFile(githubApiStatePath, "utf8"));
    assert.deepEqual(githubApiState.pulls, []);
    assert.equal((githubApiState.requests || []).some((request) => request.operation === "create"), false);
    await assert.rejects(() => stat(unexpectedCreate), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion closes an exact external PR when the fenced claim becomes stale during creation", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-stale-pr-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const closedMarker = path.join(root, "stale-pr-closed");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await git(repoPath, ["checkout", "main"]);
    await bindOriginToGitHub(repoPath);

    const candidate = candidateFixture({ baseSha, sourceSha, integrationSha: sourceSha, status: "qa_passed" });
    await writeState(root, baseState({
      projects: [{
        id: "project_1", key: "demo", name: "Demo", repoPath, repoUrl: GITHUB_REPO_URL, defaultBranch: "main",
        validationCommands: ["test -f feature.txt"], promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1", projectId: "project_1", title: "Feature task", status: "approved_for_main",
        stateVersion: 1, branchName: "feature/task", promotionStatus: "queued",
        reviewSubjectSha: sourceSha, reviewSubjectCycle: 1, qaBundleId: "qa_bundle_1", candidateId: candidate.id,
      }],
      qaBundles: [{
        id: "qa_bundle_1", projectId: "project_1", status: "passed", candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest, tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));
    const mutationPath = path.join(root, "invalidate-claim.mjs");
    await writeFile(mutationPath, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.tasks[0].automationAttemptEpoch = Number(state.tasks[0].automationAttemptEpoch || 0) + 1;
      });
    `, "utf8");
    const promotionBranch = `qa/promotion-demo-${candidate.manifestDigest.replace(/^sha256:/, "").slice(0, 16)}`;
    const githubApiStatePath = await writePromotionGitHubApiState(root, {
      pulls: [],
      beforeCreateImportUrl: pathToFileURL(mutationPath).href,
      closedMarker,
    });

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(githubApiStatePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })).stdout.trim());
    const state = readPersistedState(root);
    assert.equal(report.projects[0].status, "stale_result_discarded", JSON.stringify(report.projects[0]));
    assert.equal(report.projects[0].stalePromotionPrCleanup.attempted, true);
    assert.equal(report.projects[0].stalePromotionPrCleanup.closed, true);
    assert.equal(state.tasks[0].status, "approved_for_main");
    assert.equal(state.tasks[0].assignedAgentRole, "promotion-worker");
    assert.equal(state.tasks[0].automationAttemptEpoch, 1);
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.ok(await stat(closedMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion reconciliation records an exact merged candidate once", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("MERGED");
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(fixture.root);

    assert.equal(report.projects[0].status, "merged", JSON.stringify(report.projects[0]));
    assert.equal(report.projects[0].workspaceStrategy, "reconciliation_isolated_clone");
    await assert.rejects(() => stat(report.projects[0].workspacePath), /ENOENT/);
    assert.equal(state.tasks[0].status, "merged");
    assert.equal(state.tasks[0].promotionStatus, "merged");
    assert.equal(state.tasks[0].stateVersion, 2);
    assert.equal(state.tasks[0].promotionEvidence.outcome, "merged");
    assert.equal(state.tasks[0].mergeEvidence.integrationSha, fixture.sourceSha);
    assert.equal(state.tasks[0].mergeEvidence.mergeCommit, fixture.mergeCommit);
    assert.equal(state.qaBundles[0].status, "merged");
    assert.equal(state.candidates[0].status, "merged");
    assert.equal(state.events.filter((event) => event.type === "release_candidate_merged").length, 1);

    const second = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    assert.equal(JSON.parse(second.stdout.trim()).projects.length, 0);
    assert.equal(readPersistedState(fixture.root).comments.length, state.comments.length);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion self-recovers a legacy merged PR overwritten by a stale validation result", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("MERGED", {
    legacyBody: true,
    stalePostMerge: true,
  });
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());
    const state = readPersistedState(fixture.root);

    assert.equal(report.mergedAdmissionRecoveries.length, 1);
    assert.equal(report.mergedAdmissionRecoveries[0].status, "recovered");
    assert.equal(report.projects[0].status, "merged", report.projects[0].output);
    assert.equal(state.tasks[0].status, "merged");
    assert.equal(state.tasks[0].promotionStatus, "merged_with_validation_warning");
    assert.equal(state.tasks[0].promotionEvidence.validationWarning.preserved, true);
    assert.equal(state.tasks[0].stateVersion, 4);
    assert.equal(state.candidates[0].status, "merged");
    assert.equal(state.candidates[0].promotionMerge.mergeCommit, fixture.mergeCommit);
    assert.equal(
      state.events.filter((event) => event.type === "merged_promotion_admission_recovered").length,
      1,
    );
    const apiState = JSON.parse(await readFile(fixture.githubApiStatePath, "utf8"));
    assert.deepEqual(
      apiState.requests.map((request) => request.operation).filter((operation) => (
        operation === "get-merged-recovery" || operation === "list"
      )),
      ["get-merged-recovery", "list"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("merged admission recovery accepts a production v1 owner QA packet and legacy decision", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("MERGED", {
    legacyBody: true,
    legacyOwnerQaPacket: true,
    stalePostMerge: true,
    mergedAt: "2026-07-25T13:00:00Z",
  });
  try {
    const before = readPersistedState(fixture.root);
    const historicalCandidate = before.candidates.find((item) => item.id === fixture.candidate.id);
    const historicalBundle = before.qaBundles.find((item) => item.id === historicalCandidate.qaBundleId);
    assert.equal(historicalCandidate.qaPacket.schemaVersion, "studioops.owner-qa-packet.v1");
    assert.equal(historicalBundle.qaPacket.schemaVersion, "studioops.owner-qa-packet.v1");
    assert.equal(historicalBundle.packetDigest, historicalCandidate.qaPacket.packetDigest);
    assert.equal(Object.hasOwn(historicalCandidate.qaDecision, "ownerQaPacketDigest"), false);
    assert.equal(Object.hasOwn(historicalBundle.qaDecision, "ownerQaPacketDigest"), false);

    // Production was still on integrity v5 when this stale post-merge record
    // had to cross the v6 migration before its attested recovery could run.
    const database = new DatabaseSync(path.join(fixture.root, "data", "mission-control.sqlite3"));
    try {
      const row = database.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
      const meta = JSON.parse(row.payload);
      meta.stateIntegrityVersion = 5;
      database.prepare("UPDATE state_meta SET payload = ? WHERE singleton_id = 1")
        .run(JSON.stringify(meta));
    } finally {
      database.close();
    }

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());
    const state = readPersistedState(fixture.root);
    const candidate = state.candidates.find((item) => item.id === fixture.candidate.id);
    const task = state.tasks.find((item) => item.id === "task_1");

    assert.equal(report.mergedAdmissionRecoveries.length, 1);
    assert.equal(report.mergedAdmissionRecoveries[0].status, "recovered");
    assert.equal(report.projects[0].status, "merged", report.projects[0].output);
    assert.equal(task.status, "merged");
    assert.equal(task.promotionStatus, "merged_with_validation_warning");
    assert.equal(task.promotionEvidence.validationWarning.preserved, true);
    assert.equal(candidate.status, "merged");
    assert.equal(candidate.promotionMerge.mergedAt, "2026-07-25T13:00:00.000Z");
    assert.equal(candidate.promotionMerge.mergeCommit, fixture.mergeCommit);
    assert.equal(candidate.qaPacket.schemaVersion, "studioops.owner-qa-packet.v1");
    assert.equal(Object.hasOwn(candidate.qaDecision, "ownerQaPacketDigest"), false);
    assert.equal(
      state.events.filter((event) => event.type === "merged_promotion_admission_recovered").length,
      1,
    );
    assert.equal(
      state.events.filter((event) => event.type === "release_candidate_merged").length,
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation preserves a deployed task while backfilling exact merge evidence once", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("MERGED");
  try {
    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
    state.tasks[0].status = "deployed";
    state.tasks[0].deploymentEvidence = {
      id: `deployment:${fixture.candidate.id}:task_1`,
      candidateId: fixture.candidate.id,
      subjectSha: fixture.sourceSha,
      recordedAt: "2026-07-25T13:05:00.000Z",
    };
    await writeState(fixture.root, state);
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;

    const first = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    const report = JSON.parse(first.stdout.trim());
    let persisted = readPersistedState(fixture.root);
    assert.equal(report.projects[0].status, "merged");
    assert.equal(persisted.tasks[0].status, "deployed");
    assert.equal(persisted.tasks[0].stateVersion, 2);
    assert.equal(persisted.tasks[0].promotionEvidence.outcome, "merged");
    assert.equal(persisted.tasks[0].mergeEvidence.candidateId, fixture.candidate.id);
    assert.equal(persisted.tasks[0].mergeEvidence.subjectSha, fixture.sourceSha);
    assert.equal(persisted.tasks[0].mergeEvidence.mergeCommit, fixture.mergeCommit);
    assert.equal(persisted.candidates[0].status, "merged");

    const second = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root });
    assert.equal(JSON.parse(second.stdout.trim()).projects.length, 0);
    persisted = readPersistedState(fixture.root);
    assert.equal(persisted.events.filter((event) => event.type === "release_candidate_merged").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation closes a superseded candidate when a trusted merged candidate contains it", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("CLOSED");
  try {
    await git(fixture.repoPath, ["checkout", "-b", "feature/replacement", fixture.sourceSha]);
    await writeFile(path.join(fixture.repoPath, "replacement.txt"), "replacement\n", "utf8");
    await git(fixture.repoPath, ["add", "replacement.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "replacement candidate"]);
    const replacementSha = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "feature/replacement"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "HEAD:qa/candidate-replacement"]);
    await git(fixture.repoPath, ["checkout", "main"]);
    await git(fixture.repoPath, ["merge", "--no-ff", replacementSha, "-m", "merge replacement candidate"]);
    const replacementMerge = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "main"]);

    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
    const replacement = mergedCandidateFixture({
      baseSha: fixture.candidate.manifest.base.sha,
      sourceSha: replacementSha,
      integrationSha: replacementSha,
      mergeCommit: replacementMerge,
      prUrl: "https://github.com/example/demo/pull/43",
    });
    state.tasks.push({
      id: "task_2",
      projectId: "project_1",
      title: "Replacement task",
      status: "merged",
      stateVersion: 2,
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: replacementSha,
    });
    state.candidates.push(replacement);
    await writeState(fixture.root, state);

    const replacementPr = [{
      number: 43,
      url: replacement.promotion.prUrl,
      state: "MERGED",
      mergedAt: replacement.promotionMerge.mergedAt,
      mergeCommit: { oid: replacement.promotionMerge.mergeCommit },
      baseRefName: "main",
      headRefName: replacement.promotion.branch,
      headRefOid: replacement.manifest.integration.sha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${replacement.id}:${replacement.manifestDigest} -->`,
    }];
    const originalPr = [{
      number: 42,
      url: fixture.candidate.promotion.prUrl,
      state: "CLOSED",
      mergedAt: "",
      mergeCommit: null,
      baseRefName: "main",
      headRefName: fixture.candidate.promotion.branch,
      headRefOid: fixture.candidate.manifest.integration.sha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${fixture.candidate.id}:${fixture.candidate.manifestDigest} -->`,
    }];
    await writeFile(
      fixture.githubApiStatePath,
      `${JSON.stringify({ pulls: [...replacementPr, ...originalPr], nextNumber: 44 }, null, 2)}\n`,
      "utf8",
    );

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const persisted = readPersistedState(fixture.root);

    assert.equal(first.projects[0].status, "merged", JSON.stringify(first.projects[0]));
    assert.equal(first.projects[0].reconciledByCandidateId, replacement.id);
    assert.equal(first.projects[0].reconciliationReplacement.candidateId, replacement.id);
    assert.equal(
      first.projects[0].promotionClaim.reconciliationReplacementDigest,
      first.projects[0].reconciliationReplacementDigest,
    );
    assert.equal(persisted.tasks[0].status, "merged");
    assert.equal(persisted.tasks[0].mergeEvidence.subjectSha, fixture.sourceSha);
    assert.equal(persisted.tasks[0].mergeEvidence.reconciledByCandidateId, replacement.id);
    assert.equal(persisted.tasks[0].mergeEvidence.mergeCommit, replacementMerge);
    assert.equal(persisted.candidates[0].promotionMerge.reconciledByCandidateId, replacement.id);
    assert.equal(
      persisted.meta.promotionAttemptClaims[fixture.candidate.id].reconciliationReplacement.candidateId,
      replacement.id,
    );
    assert.equal(
      persisted.meta.promotionAttemptClaims[fixture.candidate.id].reconciliationReplacement.qaDecision.manifestDigest,
      replacement.manifestDigest,
    );
    assert.equal(
      persisted.meta.promotionAttemptClaims[fixture.candidate.id].reconciliationReplacement.observedPromotionPr.state,
      "MERGED",
    );
    assert.equal(
      persisted.meta.promotionAttemptClaims[fixture.candidate.id].terminalResult.prUrl,
      replacement.promotion.prUrl,
    );

    const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    assert.equal(second.projects.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("superseded reconciliation discards replacement metadata drift before merge recording", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("CLOSED");
  try {
    await git(fixture.repoPath, ["checkout", "-b", "feature/replacement", fixture.sourceSha]);
    await writeFile(path.join(fixture.repoPath, "replacement.txt"), "replacement\n", "utf8");
    await git(fixture.repoPath, ["add", "replacement.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "replacement candidate"]);
    const replacementSha = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "feature/replacement"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "HEAD:qa/candidate-replacement"]);
    await git(fixture.repoPath, ["checkout", "main"]);
    await git(fixture.repoPath, ["merge", "--no-ff", replacementSha, "-m", "merge replacement candidate"]);
    const replacementMerge = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "main"]);

    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
    const replacement = mergedCandidateFixture({
      baseSha: fixture.candidate.manifest.base.sha,
      sourceSha: replacementSha,
      integrationSha: replacementSha,
      mergeCommit: replacementMerge,
      prUrl: "https://github.com/example/demo/pull/43",
    });
    state.tasks.push({
      id: "task_2",
      projectId: "project_1",
      title: "Replacement task",
      status: "merged",
      stateVersion: 2,
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: replacementSha,
    });
    state.candidates.push(replacement);
    await writeState(fixture.root, state);

    const driftedMerge = "f".repeat(40);
    const replacementPr = [{
      number: 43,
      url: replacement.promotion.prUrl,
      state: "MERGED",
      mergedAt: replacement.promotionMerge.mergedAt,
      mergeCommit: { oid: replacement.promotionMerge.mergeCommit },
      baseRefName: "main",
      headRefName: replacement.promotion.branch,
      headRefOid: replacement.manifest.integration.sha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${replacement.id}:${replacement.manifestDigest} -->`,
    }];
    const originalPr = [{
      number: 42,
      url: fixture.candidate.promotion.prUrl,
      state: "CLOSED",
      mergedAt: "",
      mergeCommit: null,
      baseRefName: "main",
      headRefName: fixture.candidate.promotion.branch,
      headRefOid: fixture.candidate.manifest.integration.sha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${fixture.candidate.id}:${fixture.candidate.manifestDigest} -->`,
    }];
    await writeFile(
      fixture.githubApiStatePath,
      `${JSON.stringify({ pulls: [...replacementPr, ...originalPr], nextNumber: 44 }, null, 2)}\n`,
      "utf8",
    );

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      import { DatabaseSync } from "node:sqlite";
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        beforeReconciliationReplacementBinding: async () => {
          const database = new DatabaseSync(${JSON.stringify(path.join(fixture.root, "data", "mission-control.sqlite3"))});
          const row = database.prepare("SELECT payload FROM candidates WHERE id = ?").get("candidate_2");
          const replacement = JSON.parse(row.payload);
          replacement.promotionMerge.mergeCommit = ${JSON.stringify(driftedMerge)};
          database.prepare("UPDATE candidates SET payload = ? WHERE id = ?")
            .run(JSON.stringify(replacement), "candidate_2");
          database.close();
        }
      });
      console.log(JSON.stringify(report));
    `;
    const report = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());
    const persisted = readPersistedState(fixture.root);

    assert.equal(report.projects[0].status, "reconciliation_unavailable");
    assert.match(
      report.projects[0].output,
      /replacement (?:promotion candidate .* changed|identity is internally inconsistent)/i,
    );
    assert.equal(report.projects[0].reconciledByCandidateId, undefined);
    assert.equal(persisted.tasks[0].status, "user_review");
    assert.equal(persisted.tasks[0].mergeEvidence, undefined);
    assert.equal(persisted.candidates[0].status, "release_candidate_ready");
    assert.equal(persisted.candidates[1].promotionMerge.mergeCommit, driftedMerge);
    assert.equal(persisted.comments.length, 0);
    assert.equal(persisted.events.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation leaves open PRs stable without duplicate evidence", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("OPEN");
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
    const state = readPersistedState(fixture.root);

    assert.equal(first.projects[0].status, "pending");
    assert.equal(second.projects[0].status, "pending");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.comments.length, 0);
    assert.equal(state.events.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation records a later exact merge after first observing the PR closed", nestedValidationSandboxTest, async () => {
  const fixture = await reconciliationFixture("CLOSED");
  try {
    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
        testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
      });
      console.log(JSON.stringify(report));
    `;
    const closedReport = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());
    let state = readPersistedState(fixture.root);
    assert.equal(closedReport.projects[0].status, "promotion_closed");
    assert.equal(state.tasks[0].status, "promotion_blocked");
    assert.equal(state.tasks[0].promotionStatus, "promotion_closed");
    assert.equal(state.tasks[0].stateVersion, 2);
    assert.equal(state.candidates[0].status, "release_candidate_ready");

    await git(fixture.repoPath, ["checkout", "main"]);
    await git(fixture.repoPath, ["merge", "--no-ff", fixture.sourceSha, "-m", "merge release candidate after close"]);
    const mergeCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", fixture.remotePath, "main"]);
    const mergedAt = "2026-07-25T13:30:00.000Z";
    const mergedPr = [{
      number: 42,
      url: fixture.candidate.promotion.prUrl,
      state: "MERGED",
      mergedAt,
      mergeCommit: { oid: mergeCommit },
      baseRefName: "main",
      headRefName: fixture.candidate.promotion.branch,
      headRefOid: fixture.candidate.manifest.integration.sha,
      headRepository: { nameWithOwner: "example/demo" },
      body: `<!-- studioops-candidate:${fixture.candidate.id}:${fixture.candidate.manifestDigest} -->`,
    }];
    await writeFile(
      fixture.githubApiStatePath,
      `${JSON.stringify({ pulls: mergedPr, nextNumber: 43, createFailuresRemaining: 0, listFailuresRemaining: 0 }, null, 2)}\n`,
      "utf8",
    );

    const mergedReport = JSON.parse((await run(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: fixture.root },
    )).stdout.trim());
    state = readPersistedState(fixture.root);
    assert.equal(mergedReport.projects[0].status, "merged", mergedReport.projects[0].output);
    assert.equal(state.tasks[0].status, "merged");
    assert.equal(state.tasks[0].promotionStatus, "merged");
    assert.equal(state.tasks[0].stateVersion, 3);
    assert.equal(state.tasks[0].mergeEvidence.mergeCommit, mergeCommit);
    assert.equal(state.candidates[0].status, "merged");
    assert.equal(state.candidates[0].promotionMerge.mergeCommit, mergeCommit);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("promotion reconciliation bounds closed and drifted PRs without restarting review", nestedValidationSandboxTest, async (t) => {
  for (const scenario of [
    { name: "closed", state: "CLOSED", overrides: {}, expected: "promotion_closed" },
    { name: "target mismatch", state: "OPEN", overrides: { baseRefName: "release" }, expected: "promotion_invalid" },
    { name: "head mismatch", state: "OPEN", overrides: { headRefOid: "f".repeat(40) }, expected: "promotion_invalid" },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await reconciliationFixture(scenario.state, scenario.overrides);
      try {
        const script = `
          import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
          const report = await runPromotion({
            githubAppAuth: false,
            testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
            testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
            validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
          });
          console.log(JSON.stringify(report));
        `;
        const report = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.root })).stdout.trim());
        const state = readPersistedState(fixture.root);
        assert.equal(report.projects[0].status, scenario.expected);
        assert.equal(state.tasks[0].status, "promotion_blocked");
        assert.equal(state.tasks[0].reviewCycle, 1);
        assert.equal(state.comments.length, 1);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("closed reconciliation preserves terminal task states while auditing the observation", nestedValidationSandboxTest, async (t) => {
  for (const terminalStatus of ["merged", "deployed", "done"]) {
    await t.test(terminalStatus, async () => {
      const fixture = await reconciliationFixture("CLOSED");
      try {
        const initial = JSON.parse(await readFile(path.join(fixture.root, "data", "mission-control.json"), "utf8"));
        initial.tasks[0].status = terminalStatus;
        initial.tasks[0].stateVersion = 4;
        initial.tasks[0].assignedAgentRole = "";
        await writeState(fixture.root, initial);
        const script = `
          import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
          const report = await runPromotion({
            githubAppAuth: false,
            testGitRunner: ${localPromotionGitRunnerExpression(fixture.remotePath)},
            testGitHubApi: ${localPromotionGitHubApiExpression(fixture.githubApiStatePath)},
            validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)}
          });
          console.log(JSON.stringify(report));
        `;
        const report = JSON.parse((await run(
          process.execPath,
          ["--input-type=module", "-e", script],
          { cwd: fixture.root },
        )).stdout.trim());
        const state = readPersistedState(fixture.root);

        assert.equal(report.projects[0].status, "promotion_closed");
        assert.equal(state.tasks[0].status, terminalStatus);
        assert.equal(state.tasks[0].stateVersion, 5);
        assert.equal(state.tasks[0].promotionStatus, "promotion_closed");
        assert.equal(state.candidates[0].status, "release_candidate_ready");
        assert.equal(
          state.events.some((event) => (
            event.type === "lifecycle_transition"
            && event.action === "record_promotion_outcome"
            && event.fromStatus === terminalStatus
            && event.toStatus === terminalStatus
          )),
          true,
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("promotion validation cannot mutate a host source ref", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "reviewed feature"]);
    const reviewedSourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const candidate = candidateFixture({
      baseSha,
      sourceSha: reviewedSourceSha,
      integrationSha: reviewedSourceSha,
      status: "qa_passed",
    });
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: [
          `git --git-dir=${JSON.stringify(remotePath)} update-ref refs/heads/feature/task ${baseSha}`,
          "test -f feature.txt",
        ],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
        reviewSubjectSha: reviewedSourceSha,
        reviewSubjectCycle: 1,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "validation_failed");
    assert.equal(report.projects[0].candidateInvalidation, undefined);
    assert.equal(state.tasks[0].status, "approved_for_main");
    assert.equal(state.tasks[0].promotionValidationAttempts, 1);
    assert.equal(state.candidates[0].status, "qa_passed");
    assert.equal(state.candidates[0].invalidation, null);
    assert.equal(state.qaBundles[0].status, "passed");
    assert.equal(
      await git(remotePath, ["rev-parse", "refs/heads/feature/task"]),
      reviewedSourceSha,
    );
    assert.equal(
      await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion invalidates the candidate when its staged integration branch drifts", nestedValidationSandboxTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-candidate-branch-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "reviewed feature"]);
    const sourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["branch", "qa/candidate-demo"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);

    const candidate = candidateFixture({
      baseSha,
      sourceSha,
      integrationSha: sourceSha,
      status: "qa_passed",
    });
    await writeState(root, baseState({
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: GITHUB_REPO_URL,
        defaultBranch: "main",
        validationCommands: ["test -f feature.txt"],
        promotion: { enabled: true, targetBranch: "main" },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "approved_for_main",
        stateVersion: 1,
        branchName: "feature/task",
        promotionStatus: "queued",
        qaBundleId: "qa_bundle_1",
        candidateId: candidate.id,
        reviewSubjectSha: sourceSha,
        reviewSubjectCycle: 1,
      }],
      qaBundles: [{
        id: "qa_bundle_1",
        projectId: "project_1",
        status: "passed",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        tasks: [{ id: "task_1", title: "Feature task" }],
      }],
      candidates: [candidate],
    }));

    await git(repoPath, ["checkout", "qa/candidate-demo"]);
    await writeFile(path.join(repoPath, "unreviewed.txt"), "must not promote\n", "utf8");
    await git(repoPath, ["add", "unreviewed.txt"]);
    await git(repoPath, ["commit", "-m", "move staged candidate"]);
    const movedCandidateSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "origin", "qa/candidate-demo"]);
    await bindOriginToGitHub(repoPath);
    await installLocalGitHubTransport(fakeBin, remotePath);

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        testGitRunner: ${localPromotionGitRunnerExpression(remotePath)},
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        validationPath: ${JSON.stringify(DEFAULT_PROJECT_VALIDATION_PATH)},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "blocked");
    assert.match(report.projects[0].output, /Candidate integration ref drift/);
    assert.equal(report.projects[0].candidateInvalidation.expected, sourceSha);
    assert.equal(report.projects[0].candidateInvalidation.observed, movedCandidateSha);
    assert.equal(state.candidates[0].status, "invalidated");
    assert.equal(state.qaBundles[0].status, "invalidated");
    assert.equal(
      await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/promotion-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
