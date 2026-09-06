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
  selectFailureIncident,
} from "../src/failure-containment.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { applyFailureIncidentCompatibilityReadModelInState } from "../src/store.js";

const execFileAsync = promisify(execFile);
const stateDatabaseModuleUrl = pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const NOW = "2026-09-04T12:00:00.000Z";

test("retry admission recognizes action aliases and metadata-only candidate changes", () => {
  const input = fingerprintInput();
  let incident = createFailureIncident({...input, now: NOW});
  incident = claimPaidFailureAttempt(incident, {evidence: incident.evidence, now: NOW}).incident;
  const changed = {...input, action: "return_to_builder", provider: "codex-cli", candidateIdentity: {...input.candidateIdentity, candidateId: "new-label", candidateCycle: 77, commitSha: "d".repeat(40)}};
  assert.equal(selectFailureIncident([incident], changed).paidAttempts, 1);
  assert.equal(selectFailureIncident([incident], {...changed, candidateIdentity: {...changed.candidateIdentity, treeSha: "e".repeat(40)}}), null);
  assert.equal(selectFailureIncident([incident], {...changed, taskId: "task_unrelated"}), null);
});

test("output and provider failures retain their cap across changed candidates and worker stages", () => {
  for (const reasonCode of ["output_guard_exceeded", "provider_unavailable"]) {
    const input = fingerprintInput({reasonCode});
    const incident = createFailureIncident({...input, now: NOW});
    const changed = {...input, action: "continue_review", provider: "codex-cli", candidateIdentity: {commitSha: "e".repeat(40)}};
    assert.equal(selectFailureIncident([incident], changed).incident.incidentId, incident.incidentId);
  }
});

test("legacy alias attempts are summed and only verified repairs reset the allowance", () => {
  const input = fingerprintInput({reasonCode: "output_guard_exceeded"});
  const used = (action) => {
    const incident = createFailureIncident({...input, action, now: NOW});
    return claimPaidFailureAttempt(incident, {evidence: incident.evidence, now: NOW}).incident;
  };
  const first = used("start_builder"), second = used("continue_review");
  assert.equal(selectFailureIncident([first, second], input).paidAttempts, 2);
  const evidence = failureEvidence({configurationDigest: `sha256:${"f".repeat(64)}`});
  const repaired = claimPaidFailureAttempt(first, {evidence, now: "2026-09-04T12:01:00.000Z", verifier: {id:"policy_probe",outcome:"passed",evidenceDigest:evidence.digest}}).incident;
  assert.equal(selectFailureIncident([first, second, repaired], input).paidAttempts, 1);
});

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

test("SQLite caps aliases atomically and waits through transient external write contention", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-failure-alias-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const result = await runDatabaseScript(root, `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    import {claimFailureContainmentPaidAttempt, ensureStateDatabase, DATABASE_FILE, readFailureIncidents} from ${JSON.stringify(stateDatabaseModuleUrl)};
    await ensureStateDatabase();
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(()=>{db.exec('COMMIT');db.close()},800)", DATABASE_FILE], {stdio:['ignore','pipe','pipe']});
    const exit = new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code)=>code===0?resolve():reject(new Error('lock child failed')))});
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)});
    const base = {taskId:'task_alias',action:'start_builder',provider:'codex-sdk',reasonCode:'output_guard_exceeded',candidateIdentity:{commitSha:'a'.repeat(40)}};
    const first = await claimFailureContainmentPaidAttempt(base);
    await exit;
    const second = await claimFailureContainmentPaidAttempt({...base, action:'continue_review', provider:'codex-cli',candidateIdentity:{commitSha:'b'.repeat(40),candidateCycle:42}});
    const third = await claimFailureContainmentPaidAttempt({...base, action:'qa_integration_blocked', candidateIdentity:{commitSha:'c'.repeat(40)}});
    assert.equal(first.admitted,true);assert.equal(second.admitted,true);assert.equal(third.admitted,false);
    assert.equal(first.incident.incidentId,second.incident.incidentId);
    assert.equal(third.incident.state,'open');
    const rows = await readFailureIncidents({taskId:'task_alias'});
    assert.equal(rows.length,1);assert.equal(rows[0].paidAttempts,2);
    console.log(JSON.stringify({attempts:rows[0].paidAttempts,state:rows[0].state}));
  `);
  assert.equal(JSON.parse(result.stdout.trim()).state, "open");
});

test("legacy aggregate cap requires an actual verified evidence change, not a verifier label", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-failure-verifier-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const failureModule = pathToFileURL(path.join(process.cwd(), "src/failure-containment.js")).href;
  await runDatabaseScript(root, `
    import assert from 'node:assert/strict';
    import {withStateDatabaseConnection,claimFailureContainmentPaidAttempt} from ${JSON.stringify(stateDatabaseModuleUrl)};
    import {createFailureIncident,claimPaidFailureAttempt,failureEvidence} from ${JSON.stringify(failureModule)};
    const base={taskId:'legacy_alias',provider:'codex',reasonCode:'output_guard_exceeded'};
    const rows=['start_builder','continue_review'].map(action=>{
      const incident=createFailureIncident({...base,action,now:'2026-09-04T12:00:00.000Z'});
      return claimPaidFailureAttempt(incident,{evidence:incident.evidence,now:'2026-09-04T12:00:01.000Z'}).incident;
    });
    await withStateDatabaseConnection(db=>{
      const insert=db.prepare('INSERT INTO failure_incidents (incident_id,task_id,fingerprint_digest,state,generation,evidence_digest,paid_attempts,updated_at,payload) VALUES (?,?,?,?,?,?,?,?,?)');
      for(const r of rows)insert.run(r.incidentId,r.taskId,r.fingerprintDigest,r.state,r.generation,r.evidenceDigest,r.paidAttempts,r.updatedAt,JSON.stringify(r));
    });
    const denied=await claimFailureContainmentPaidAttempt({...base,action:'qa_integration_blocked',evidence:rows[0].evidence,verifier:{id:'policy_probe',outcome:'passed',evidenceDigest:rows[0].evidenceDigest}});
    assert.equal(denied.admitted,false);assert.equal(denied.incident.generation,1);
    const changed=failureEvidence({configurationDigest:'sha256:'+ 'f'.repeat(64)});
    await assert.rejects(claimFailureContainmentPaidAttempt({...base,action:'qa_integration_blocked',evidence:changed.value,verifier:{id:'untrusted',outcome:'passed',evidenceDigest:changed.digest}}),/allowlisted verifier/);
    const resumed=await claimFailureContainmentPaidAttempt({...base,action:'qa_integration_blocked',evidence:changed.value,verifier:{id:'policy_probe',outcome:'passed',evidenceDigest:changed.digest}});
    assert.equal(resumed.admitted,true);assert.equal(resumed.incident.generation,2);assert.equal(resumed.incident.paidAttempts,1);
  `);
});

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

    const pageOutput = await runDatabaseScript(root, `
      import { readFailureIncidentPage, readFailureIncidentTotals } from ${JSON.stringify(stateDatabaseModuleUrl)};
      console.log(JSON.stringify({
        page: await readFailureIncidentPage({ projectId: "project_1", limit: 1 }),
        totals: await readFailureIncidentTotals({ projectId: "project_1", updatedAfter: "2026-09-04T00:00:00.000Z" })
      }));
    `);
    const { page, totals } = JSON.parse(pageOutput.stdout.trim());
    assert.equal(page.limit, 1);
    assert.equal(page.incidents.length, 1);
    assert.equal(page.incidents[0].incidentId, incidents[0].incidentId);
    assert.equal(page.nextCursor, "");
    assert.equal(totals.containedFingerprintGenerations, 1);
    assert.equal(totals.paidModelAttempts, 2);
    assert.equal(totals.cheapProbesAndRepairs, 1);

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
