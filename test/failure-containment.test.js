import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  claimPaidFailureAttempt,
  createFailureIncident,
  failureEvidence,
  failureFingerprint,
  failureIncidentCompatibilityCircuit,
  recordFailureRecoveryActivity,
  scheduleFailureBackoff,
} from "../src/failure-containment.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { applyFailureIncidentCompatibilityReadModelInState } from "../src/store.js";

const execFileAsync = promisify(execFile);
const stateDatabaseModuleUrl = pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const NOW = "2026-09-04T12:00:00.000Z";

function fingerprintInput(overrides = {}) {
  return {
    taskId: "task_953",
    action: "start_builder",
    provider: "codex-sdk",
    reasonCode: "execution_failed",
    candidateIdentity: {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      candidateCycle: 3,
    },
    ...overrides,
  };
}

function evidenceInput(overrides = {}) {
  return {
    repository: {
      branch: "codex/studioops-task_953",
      prUrl: "https://github.com/magic2goodil/studioops/pull/141",
      commitSha: "a".repeat(40),
    },
    dependencies: [
      { taskId: "task_957", stateVersion: 9, status: "merged" },
      { taskId: "task_952", stateVersion: 4, status: "architecture_ready" },
    ],
    credentialClass: "available",
    configurationDigest: `sha256:${"d".repeat(64)}`,
    policyDigest: `sha256:${"e".repeat(64)}`,
    componentMapDigest: `sha256:${"f".repeat(64)}`,
    serviceHealth: { github: "healthy", codex: "degraded" },
    ...overrides,
  };
}

test("canonical failure hashing is deterministic bounded and excludes volatile or secret input", () => {
  const sdk = failureFingerprint(fingerprintInput({ provider: "codex-sdk", rawMessage: "first wording" }));
  const cli = failureFingerprint(fingerprintInput({ provider: "codex-cli", rawMessage: "different wording" }));
  assert.equal(sdk.digest, cli.digest);
  assert.equal(sdk.value.provider, "codex");
  assert.equal(sdk.value.taskId, "task_953");
  assert.equal(sdk.canonical.includes("wording"), false);

  const left = failureEvidence(evidenceInput({
    observedAt: "2026-09-04T12:00:00.000Z",
    rawLog: "Authorization: Bearer secret-one",
    accessToken: "secret-one",
  }));
  const right = failureEvidence({
    ...evidenceInput(),
    dependencies: [...evidenceInput().dependencies].reverse(),
    serviceHealth: { codex: "degraded", github: "healthy" },
    observedAt: "2030-01-01T00:00:00.000Z",
    rawLog: "volatile message",
    accessToken: "secret-two",
  });
  assert.equal(left.digest, right.digest);
  assert.equal(left.canonical.includes("secret"), false);
  assert.equal(left.canonical.includes("2030"), false);
  assert.throws(() => failureFingerprint(fingerprintInput({ reasonCode: "raw exception text" })), /not allowlisted/);
  assert.throws(() => failureFingerprint(fingerprintInput({ provider: "unbounded-provider-name" })), /not allowlisted/);
});

test("one incident generation shares two paid attempts across SDK CLI and watchdog paths", () => {
  const fingerprint = failureFingerprint(fingerprintInput());
  const evidence = failureEvidence(evidenceInput());
  let incident = createFailureIncident({ fingerprint, evidence, now: NOW });

  const sdk = claimPaidFailureAttempt(incident, {
    evidence,
    initiator: "runner",
    transport: "sdk",
    now: "2026-09-04T12:00:01.000Z",
  });
  assert.equal(sdk.admitted, true);
  incident = sdk.incident;
  const cli = claimPaidFailureAttempt(incident, {
    evidence,
    initiator: "runner",
    transport: "cli",
    now: "2026-09-04T12:00:02.000Z",
  });
  assert.equal(cli.admitted, true);
  incident = cli.incident;
  const watchdog = claimPaidFailureAttempt(incident, {
    evidence,
    initiator: "watchdog",
    transport: "cli",
    now: "2026-09-04T12:00:03.000Z",
  });
  assert.equal(watchdog.admitted, false);
  assert.equal(watchdog.reason, "attempt_budget_exhausted");
  assert.equal(watchdog.incident.state, "open");
  assert.equal(watchdog.incident.paidAttempts, 2);
  assert.equal(watchdog.incident.avoidedRetries, 1);

  const repeated = claimPaidFailureAttempt(watchdog.incident, {
    evidence,
    initiator: "dispatcher",
    now: "2026-09-04T12:00:04.000Z",
  });
  assert.equal(repeated.admitted, false);
  assert.equal(repeated.incident.notificationKey, watchdog.incident.notificationKey);
  assert.equal(repeated.incident.avoidedRetries, 2);
});

test("time alone cannot rearm a circuit and changed evidence needs its reason verifier", () => {
  const fingerprint = failureFingerprint(fingerprintInput());
  const originalEvidence = failureEvidence(evidenceInput());
  let incident = createFailureIncident({ fingerprint, evidence: originalEvidence, now: NOW });
  incident = claimPaidFailureAttempt(incident, { evidence: originalEvidence, now: "2026-09-04T12:00:01.000Z" }).incident;
  incident = claimPaidFailureAttempt(incident, { evidence: originalEvidence, now: "2026-09-04T12:00:02.000Z" }).incident;
  incident = claimPaidFailureAttempt(incident, { evidence: originalEvidence, now: "2026-09-04T12:00:03.000Z" }).incident;
  assert.equal(incident.state, "open");

  const timeOnly = failureEvidence({ ...evidenceInput(), observedAt: "2040-01-01T00:00:00.000Z" });
  assert.equal(timeOnly.digest, originalEvidence.digest);
  assert.equal(claimPaidFailureAttempt(incident, { evidence: timeOnly, now: "2040-01-01T00:00:00.000Z" }).admitted, false);

  const changed = failureEvidence(evidenceInput({ serviceHealth: { github: "healthy", codex: "healthy" } }));
  assert.throws(
    () => claimPaidFailureAttempt(incident, { evidence: changed, now: "2040-01-01T00:00:01.000Z" }),
    /allowlisted verifier/,
  );
  const verified = claimPaidFailureAttempt(incident, {
    evidence: changed,
    verifier: { id: "service_health_probe", outcome: "passed", evidenceDigest: changed.digest },
    now: "2040-01-01T00:00:02.000Z",
  });
  assert.equal(verified.admitted, true);
  assert.equal(verified.incident.generation, 2);
  assert.equal(verified.incident.paidAttempts, 1);
  assert.notEqual(verified.incident.incidentId, incident.incidentId);
});

test("cheap probes repairs backoff and the legacy circuit projection are separately auditable", () => {
  const fingerprint = failureFingerprint(fingerprintInput());
  const evidence = failureEvidence(evidenceInput());
  let incident = createFailureIncident({ fingerprint, evidence, now: NOW });
  incident = recordFailureRecoveryActivity(incident, {
    type: "cheap_probe",
    evidence,
    verifier: { id: "service_health_probe" },
    outcome: "failed",
    now: "2026-09-04T12:00:01.000Z",
  });
  incident = recordFailureRecoveryActivity(incident, {
    type: "repair",
    evidence,
    verifier: { id: "deterministic_repair" },
    outcome: "passed",
    now: "2026-09-04T12:00:02.000Z",
  });
  incident = scheduleFailureBackoff(incident, {
    delayMs: 60_000,
    now: "2026-09-04T12:00:03.000Z",
  });
  const blocked = claimPaidFailureAttempt(incident, {
    evidence,
    now: "2026-09-04T12:00:04.000Z",
  });
  assert.equal(blocked.reason, "backoff");
  assert.equal(blocked.incident.cheapProbeAttempts, 1);
  assert.equal(blocked.incident.repairAttempts, 1);
  assert.equal(blocked.incident.paidAttempts, 0);
  assert.equal(blocked.incident.avoidedRetries, 1);
  const compatibility = failureIncidentCompatibilityCircuit(blocked.incident, { status: "queued" });
  assert.equal(compatibility.failureFingerprint, fingerprint.digest);
  assert.equal(compatibility.maxAttempts, 2);
  assert.equal(compatibility.snapshot.status, "queued");
});

test("task automationCircuit remains a deduplicated compatibility projection", () => {
  const fingerprint = failureFingerprint(fingerprintInput());
  const evidence = failureEvidence(evidenceInput());
  let incident = createFailureIncident({ fingerprint, evidence, now: NOW });
  incident = claimPaidFailureAttempt(incident, { evidence, now: "2026-09-04T12:00:01.000Z" }).incident;
  incident = claimPaidFailureAttempt(incident, { evidence, now: "2026-09-04T12:00:02.000Z" }).incident;
  incident = claimPaidFailureAttempt(incident, { evidence, now: "2026-09-04T12:00:03.000Z" }).incident;
  const task = { id: "task_953", projectId: "project_6", status: "queued", stateVersion: 1 };
  const state = { tasks: [task], events: [] };
  const first = applyFailureIncidentCompatibilityReadModelInState(state, task, incident);
  const second = applyFailureIncidentCompatibilityReadModelInState(state, task, incident);
  assert.deepEqual(second, first);
  assert.equal(task.automationBlocker.incidentId, incident.incidentId);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].failureCircuitEventKey, incident.notificationKey);
});

async function writeLegacyState(root, state) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runDatabaseScript(root, source) {
  const env = await environmentForTestControlRoot(root);
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    timeout: 30_000,
  });
}

function legacyState(task = {}) {
  return {
    meta: {},
    projects: [{ id: "project_1", key: "demo", name: "Demo" }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Failure task",
      status: "blocked",
      stateVersion: 2,
      branchName: "codex/demo-task",
      lastAutomationFailure: "repository access failed",
      lastAutomationFailureRunId: "run_1",
      automationCircuit: {
        state: "open",
        reasonCode: "repository access failed",
        attemptsConsumed: 2,
        recoveryCount: 1,
        openedAt: NOW,
      },
      ...task,
    }],
    comments: [],
    reviews: [],
    events: [],
    runs: [{
      id: "run_1",
      projectId: "project_1",
      taskId: "task_1",
      status: "failed",
      actionType: "start_builder",
      provider: "codex-cli",
      updatedAt: NOW,
    }],
    qaBundles: [],
    candidates: [],
    notificationOutbox: [],
  };
}

test("SQLite migration backfills legacy circuits and indexed incident queries avoid run payload scans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-failure-migration-"));
  try {
    await writeLegacyState(root, legacyState());
    const output = await runDatabaseScript(root, `
      import { readFailureIncidents } from ${JSON.stringify(stateDatabaseModuleUrl)};
      console.log(JSON.stringify(await readFailureIncidents({ taskId: "task_1", state: "open" })));
    `);
    const incidents = JSON.parse(output.stdout.trim());
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].state, "open");
    assert.equal(incidents[0].paidAttempts, 2);
    assert.equal(incidents[0].provider, "codex");

    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get().payload);
      assert.equal(meta.failureContainmentMigration.schemaVersion, 1);
      assert.equal(meta.failureContainmentMigration.backupVerified, true);
      assert.equal(meta.failureContainmentMigration.migratedIncidentCount, 1);
      const indexes = db.prepare("PRAGMA index_list(failure_incidents)").all().map((entry) => entry.name);
      assert.ok(indexes.includes("idx_failure_incidents_task_fingerprint_state"));
      const queryPlan = db.prepare(`
        EXPLAIN QUERY PLAN SELECT * FROM failure_incidents
        WHERE task_id = ? AND fingerprint_digest = ? AND state = ?
      `).all("task_1", incidents[0].fingerprintDigest, "open");
      assert.match(queryPlan.map((entry) => entry.detail).join(" "), /idx_failure_incidents_task_fingerprint_state/);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite paid-attempt claims serialize SDK CLI and watchdog callers into one budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-failure-claims-"));
  try {
    const cleanState = legacyState({
      status: "ready",
      lastAutomationFailure: "",
      lastAutomationFailureRunId: "",
      automationCircuit: null,
    });
    cleanState.runs = [];
    await writeLegacyState(root, cleanState);
    await runDatabaseScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    const claimScript = (provider, initiator, transport, now) => `
      import { claimFailureContainmentPaidAttempt } from ${JSON.stringify(stateDatabaseModuleUrl)};
      const result = await claimFailureContainmentPaidAttempt({
        taskId: "task_1",
        action: "start_builder",
        provider: ${JSON.stringify(provider)},
        reasonCode: "execution_failed",
        evidence: { credentialClass: "unknown", serviceHealth: {} },
        initiator: ${JSON.stringify(initiator)},
        transport: ${JSON.stringify(transport)},
        now: ${JSON.stringify(now)}
      });
      console.log(JSON.stringify({ admitted: result.admitted, reason: result.reason, incident: result.incident }));
    `;
    const [sdk, cli] = await Promise.all([
      runDatabaseScript(root, claimScript("codex-sdk", "runner", "sdk", "2026-09-04T12:00:01.000Z")),
      runDatabaseScript(root, claimScript("codex-cli", "runner", "cli", "2026-09-04T12:00:02.000Z")),
    ]);
    assert.equal(JSON.parse(sdk.stdout).admitted, true);
    assert.equal(JSON.parse(cli.stdout).admitted, true);

    const watchdog = await runDatabaseScript(root, claimScript(
      "codex",
      "watchdog",
      "cli",
      "2026-09-04T12:00:03.000Z",
    ));
    const denied = JSON.parse(watchdog.stdout);
    assert.equal(denied.admitted, false);
    assert.equal(denied.reason, "attempt_budget_exhausted");
    assert.equal(denied.incident.paidAttempts, 2);
    assert.equal(denied.incident.state, "open");

    const rows = await runDatabaseScript(root, `
      import { readFailureIncidents } from ${JSON.stringify(stateDatabaseModuleUrl)};
      console.log(JSON.stringify(await readFailureIncidents({ taskId: "task_1" })));
    `);
    const incidents = JSON.parse(rows.stdout);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].notificationKey, incidents[0].circuitEventKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
