import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTechOpsPolicy } from "../src/config.js";
import {
  checkTechOpsPreviewHealth,
  planTechOpsActions,
  runTechOps,
} from "../src/techops.js";
import {
  claimQaTechOpsRecoveryInState,
  finalizeQaTechOpsRecoveryInState,
} from "../src/store.js";

const SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

function fixture(overrides = {}) {
  const project = {
    id: "project_1",
    key: "sample",
    repoPath: process.cwd(),
    localQaPreview: {
      healthCheckUrl: "http://127.0.0.1:9876/health",
      identityHeader: "x-studioops-commit",
      restartLaunchAgents: ["com.example.sample-preview"],
    },
    techOps: {
      enabled: true,
      healthCheckIntervalSeconds: 60,
      healthTimeoutMs: 1_000,
      commandTimeoutMs: 1_000,
      maxAttempts: 2,
      initialBackoffSeconds: 10,
      maxBackoffSeconds: 20,
      maxConcurrentRecoveries: 1,
      maxCommandsPerAttempt: 4,
      maxOutputChars: 1_000,
      verificationAttempts: 1,
      verificationDelayMs: 0,
      diagnosticCommands: [{ id: "postgres-status", argv: ["docker", "compose", "ps", "postgres"] }],
      recoveryCommands: [{ id: "postgres-start", argv: ["docker", "compose", "up", "-d", "postgres"] }],
      restartLaunchAgents: ["com.example.sample-preview"],
    },
  };
  const candidate = {
    id: "candidate_1",
    projectId: project.id,
    qaBundleId: "qa_bundle_1",
    status: "frozen",
    manifestDigest: DIGEST,
    manifest: {
      integration: { sha: SHA },
      preview: { url: project.localQaPreview.healthCheckUrl },
    },
  };
  const bundle = {
    id: "qa_bundle_1",
    projectId: project.id,
    candidateId: candidate.id,
    status: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    meta: {},
    projects: [project],
    tasks: [],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [bundle],
    candidates: [candidate],
    notificationOutbox: [],
    ...overrides,
  };
}

function responseFor(sha = SHA, status = 200) {
  return new Response("", { status, headers: { "x-studioops-commit": sha } });
}

test("TechOps policy normalization is stable and ignores shell strings", () => {
  const raw = fixture().projects[0].techOps;
  const first = normalizeTechOpsPolicy({ ...raw, recoveryCommands: [...raw.recoveryCommands, "rm -rf data"] });
  assert.deepEqual(normalizeTechOpsPolicy(first), first);
  assert.deepEqual(first.commands.map((command) => command.id), ["postgres-status", "postgres-start"]);
});

test("plans periodic checks only for current active ready QA bundles", () => {
  const state = fixture();
  const actions = planTechOpsActions(state, { nowMs: Date.parse("2026-01-01T00:01:00Z") });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "techops_check_qa_preview");
  assert.equal(actions[0].integrationSha, SHA);

  state.qaBundles[0].techOps = {
    candidateId: actions[0].candidateId,
    manifestDigest: actions[0].manifestDigest,
    integrationSha: actions[0].integrationSha,
    policyDigest: actions[0].policyDigest,
    nextCheckAt: "2026-01-01T00:02:00Z",
  };
  assert.equal(planTechOpsActions(state, { nowMs: Date.parse("2026-01-01T00:01:00Z") }).length, 0);
  state.qaBundles[0].status = "passed";
  assert.equal(planTechOpsActions(state, { nowMs: Date.parse("2026-01-01T00:03:00Z") }).length, 0);
});

test("health check rejects stale candidate identity", async () => {
  const state = fixture();
  const [action] = planTechOpsActions(state);
  const health = await checkTechOpsPreviewHealth(action, state.projects[0], {
    fetch: async () => responseFor(STALE_SHA),
  });
  assert.equal(health.status, "identity_mismatch");
  assert.equal(health.observedSha, STALE_SHA);
  assert.match(health.reason, new RegExp(SHA));
});

test("stopped dependency is recovered and exact candidate health clears the incident", async () => {
  const state = fixture();
  let healthCalls = 0;
  const executed = [];
  const report = await runTechOps({
    state,
    nowMs: Date.parse("2026-01-01T00:01:00Z"),
    nowMsAfterRecovery: Date.parse("2026-01-01T00:01:02Z"),
    fetch: async () => {
      healthCalls += 1;
      if (healthCalls === 1) throw new Error("connect ECONNREFUSED");
      return responseFor();
    },
    execCommand: async (file, args) => {
      executed.push([file, ...args]);
      return { stdout: "ok", stderr: "" };
    },
    restartLaunchAgent: async (label) => ({ label, ok: true, output: "restarted" }),
    claimRecovery: async (input) => claimQaTechOpsRecoveryInState(state, input),
    finalizeRecovery: async (claim, result, input) => finalizeQaTechOpsRecoveryInState(state, claim, result, input),
    recordHealth: async () => assert.fail("initial health should be unavailable"),
  });
  assert.equal(report.results[0].outcome, "recovered");
  assert.deepEqual(executed, [
    ["docker", "compose", "ps", "postgres"],
    ["docker", "compose", "up", "-d", "postgres"],
  ]);
  assert.equal(state.qaBundles[0].techOps.state, "healthy");
  assert.equal(state.qaBundles[0].techOps.health.observedSha, SHA);
  assert.deepEqual(
    state.qaBundles[0].techOps.attempts[0].commands.map((item) => item.id),
    ["postgres-status", "postgres-start"],
  );
});

test("recovery claims deduplicate, back off exponentially, and open a durable circuit", () => {
  const state = fixture();
  const [action] = planTechOpsActions(state);
  const base = Date.parse("2026-01-01T00:00:00Z");
  const input = { ...action, health: { status: "unavailable", reason: "stopped" }, maxAttempts: 2, leaseSeconds: 60 };
  const first = claimQaTechOpsRecoveryInState(state, { ...input, nowMs: base });
  assert.ok(first?.leaseId);
  assert.equal(claimQaTechOpsRecoveryInState(state, { ...input, nowMs: base + 1_000 }), null, "live lease suppresses duplicate recovery");
  const failed = finalizeQaTechOpsRecoveryInState(state, first, {
    ok: false,
    blocker: "postgres did not start",
    health: { status: "unavailable", reason: "ECONNREFUSED" },
    commands: [{ id: "postgres-start", type: "recovery", ok: false, output: "token=supersecret" }],
  }, { nowMs: base + 2_000, initialBackoffMs: 10_000, maxBackoffMs: 20_000 });
  assert.equal(failed.state, "backoff");
  assert.equal(failed.retryNotBefore, new Date(base + 12_000).toISOString());
  assert.match(failed.attempts[0].commands[0].output, /\[REDACTED\]/);
  assert.equal(claimQaTechOpsRecoveryInState(state, { ...input, nowMs: base + 11_999 }), null, "backoff suppresses early retry");

  const second = claimQaTechOpsRecoveryInState(state, { ...input, nowMs: base + 12_000 });
  const circuit = finalizeQaTechOpsRecoveryInState(state, second, {
    ok: false,
    blocker: "dependency remains stopped",
    health: { status: "unavailable", reason: "ECONNREFUSED" },
  }, { nowMs: base + 13_000, initialBackoffMs: 10_000, maxBackoffMs: 20_000 });
  assert.equal(circuit.state, "circuit_open");
  assert.equal(circuit.attemptCount, 2);
  assert.match(circuit.blocker, /dependency remains stopped/);
  assert.equal(claimQaTechOpsRecoveryInState(state, { ...input, nowMs: base + 60_000 }), null);
  assert.equal(state.events.filter((event) => event.type === "techops_recovery_circuit_opened").length, 1);
});

test("failed recovery command does not restart a LaunchAgent", async () => {
  const state = fixture();
  let healthCalls = 0;
  let restartCalls = 0;
  const report = await runTechOps({
    state,
    fetch: async () => {
      healthCalls += 1;
      throw new Error("preview stopped");
    },
    execCommand: async (file, args) => {
      if (args.includes("up")) throw new Error("container failed");
      return { stdout: "diagnosed", stderr: "" };
    },
    restartLaunchAgent: async () => {
      restartCalls += 1;
      return { ok: true };
    },
    claimRecovery: async (input) => claimQaTechOpsRecoveryInState(state, input),
    finalizeRecovery: async (claim, result, input) => finalizeQaTechOpsRecoveryInState(state, claim, result, input),
  });
  assert.equal(report.results[0].outcome, "backoff");
  assert.equal(healthCalls, 1);
  assert.equal(restartCalls, 0);
  assert.match(state.qaBundles[0].techOps.blocker, /postgres-start/);
});

test("non-allowlisted LaunchAgents fail closed", async () => {
  const state = fixture();
  state.projects[0].techOps.restartLaunchAgents = ["com.example.other-project"];
  const report = await runTechOps({
    state,
    fetch: async () => { throw new Error("preview stopped"); },
    execCommand: async () => ({ stdout: "ok", stderr: "" }),
    restartLaunchAgent: async () => assert.fail("denied LaunchAgent must not restart"),
    claimRecovery: async (input) => claimQaTechOpsRecoveryInState(state, input),
    finalizeRecovery: async (claim, result, input) => finalizeQaTechOpsRecoveryInState(state, claim, result, input),
  });
  assert.equal(report.results[0].outcome, "backoff");
  assert.match(state.qaBundles[0].techOps.blocker, /not allowlisted/);
});
