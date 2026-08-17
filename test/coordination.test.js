import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { digestOperationRequest } from "../src/coordination.js";

const execFileAsync = promisify(execFile);
const coordinationUrl = pathToFileURL(path.join(process.cwd(), "src/coordination.js")).href;

async function run(root, source, clockMs = Date.parse("2026-08-17T00:00:00.000Z"), extraEnv = {}) {
  const env = await environmentForTestControlRoot(root);
  env.STUDIOOPS_COORDINATION_TEST_NOW_MS = String(clockMs);
  Object.assign(env, extraEnv);
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    timeout: 30_000,
  });
}

async function createV1CoordinationFixture(root) {
  await run(root, `
    import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
    const db = await ensureStateDatabase();
    db.exec("DROP INDEX IF EXISTS idx_coordination_leases_aggregate; DROP INDEX IF EXISTS idx_external_operations_aggregate");
    db.exec("ALTER TABLE coordination_leases DROP COLUMN aggregate_type; ALTER TABLE coordination_leases DROP COLUMN aggregate_id");
    db.exec("ALTER TABLE external_operations DROP COLUMN aggregate_type; ALTER TABLE external_operations DROP COLUMN aggregate_id");
    const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get().payload);
    meta.coordinationMigration.schemaVersion = 1;
    db.prepare("UPDATE state_meta SET payload = ? WHERE singleton_id = 1").run(JSON.stringify(meta));
    const task = { id: "task_aggregate", projectId: "project_test", title: "Coordination fixture", status: "in_progress", stateVersion: 7 };
    db.prepare("INSERT INTO tasks(id, sequence, project_id, status, assigned_role, updated_at, state_version, payload) VALUES (?, 1, ?, ?, '', ?, ?, ?)")
      .run(task.id, task.projectId, task.status, new Date().toISOString(), task.stateVersion, JSON.stringify(task));
    db.prepare("INSERT INTO coordination_fence_counters(resource_key, last_fence, updated_at) VALUES ('provider:subject-1', 1, '2026-08-17T00:00:00.000Z')").run();
    db.prepare("INSERT INTO coordination_leases(lease_id, resource_key, fence, owner_process_identity, expected_state_version, status, acquired_at, heartbeat_at, expires_at, terminal_at, detail_json) VALUES ('lease-v1', 'provider:subject-1', 1, 'worker:v1', 7, 'expired', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:01.000Z', '2026-08-17T00:00:01.000Z', '{}')").run();
    db.prepare("INSERT INTO external_operations(operation_key, operation_id, kind, request_digest, subject, expected_remote_state, lease_id, fence, owner_process_identity, expected_state_version, status, prepared_at, terminal_at, evidence_json) VALUES ('operation-v1', 'operation-id-v1', 'write', 'sha256:v1', 'subject-1', 'etag-1', 'lease-v1', 1, 'worker:v1', 7, 'quarantined', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:01.000Z', '{}')").run();
  `);
}

function args(root) {
  return {
    resourceKey: "provider:subject-1",
    aggregateType: "task",
    aggregateId: "task_aggregate",
    ownerProcessIdentity: "worker:test",
    expectedStateVersion: 7,
    leaseTtlMs: 10_000,
  };
}

async function seedAggregate(root, version = 7) {
  await run(root, `
    import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
    const db = await ensureStateDatabase();
    const task = { id: "task_aggregate", projectId: "project_test", title: "Coordination fixture", status: "in_progress", stateVersion: ${version} };
    db.prepare("INSERT OR REPLACE INTO tasks(id, sequence, project_id, status, assigned_role, updated_at, state_version, payload) VALUES (?, 1, ?, ?, '', ?, ?, ?)")
      .run(task.id, task.projectId, task.status, new Date().toISOString(), task.stateVersion, JSON.stringify(task));
  `);
}

test("coordination migration creates durable typed tables and verified backup metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-migration-"));
  try {
    const result = await run(root, `
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      const meta = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
      console.log(meta.payload);
    `);
    const meta = JSON.parse(result.stdout.trim());
    assert.equal(meta.coordinationMigration.schemaVersion, 2);
    assert.equal(meta.coordinationMigration.backupVerified, true);
    assert.equal(meta.lifecycleMigration.backupVerified, true);
    const schema = await run(root, `
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      console.log(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'coordination_%' OR name = 'external_operations'").all()));
    `);
    assert.equal(JSON.parse(schema.stdout.trim()).length, 3);
    const bindings = await run(root, `
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      const columns = (table) => db.prepare(\`PRAGMA table_info(\${table})\`).all().map((column) => column.name);
      console.log(JSON.stringify({ leases: columns("coordination_leases"), operations: columns("external_operations") }));
    `);
    const columns = JSON.parse(bindings.stdout.trim());
    assert.ok(columns.leases.includes("aggregate_type") && columns.leases.includes("aggregate_id"));
    assert.ok(columns.operations.includes("aggregate_type") && columns.operations.includes("aggregate_id"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two processes get one exclusive claim and takeover gets a higher fence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-claim-"));
  try {
    await seedAggregate(root);
    const input = args(root);
    const results = await Promise.all(["worker:a", "worker:b"].map((owner) => run(root, `
      import { claimLease } from ${JSON.stringify(coordinationUrl)};
      console.log(JSON.stringify(await claimLease(${JSON.stringify({ ...input, ownerProcessIdentity: owner })})));
    `)));
    const claims = results.map((result) => JSON.parse(result.stdout.trim()));
    assert.deepEqual(claims.map((claim) => claim.acquired).sort(), [false, true]);
    const winner = claims.find((claim) => claim.acquired).lease;
    const takeover = await run(root, `
      import { claimLease } from ${JSON.stringify(coordinationUrl)};
      console.log(JSON.stringify(await claimLease(${JSON.stringify({ ...input, ownerProcessIdentity: "worker:takeover" })})));
    `, Date.parse("2026-08-17T00:00:20.000Z"));
    const next = JSON.parse(takeover.stdout.trim()).lease;
    assert.equal(next.fence, winner.fence + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired lease release and abandon calls are stale no-ops", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-expiry-"));
  try {
    await seedAggregate(root);
    const input = { ...args(root), leaseTtlMs: 1_000 };
    const claimed = JSON.parse((await run(root, `
      import { claimLease } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      console.log(JSON.stringify((await claimLease(base)).lease));
    `)).stdout.trim());
    const output = JSON.parse((await run(root, `
      import { releaseLease, abandonLease } from ${JSON.stringify(coordinationUrl)};
      const staleInput = ${JSON.stringify({ ...input, ...claimed, nowMs: 1 })};
      console.log(JSON.stringify({ release: await releaseLease(staleInput), abandon: await abandonLease(staleInput) }));
    `, Date.parse("2026-08-17T00:00:01.001Z"))).stdout.trim());
    assert.deepEqual(output, { release: null, abandon: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat and terminal operation CAS reject stale owners; replay and mismatch are safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-cas-"));
  try {
    await seedAggregate(root);
    const input = args(root);
    const source = `
      import { claimLease, renewLease, prepareExternalOperation, completeExternalOperation, digestOperationRequest } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...base, ...lease, operationKey: "op:1", kind: "write", requestDigest: digestOperationRequest({ body: "hello" }), subject: "subject-1", expectedRemoteState: "etag-1" });
      const stale = await renewLease({ ...base, ...lease, ownerProcessIdentity: "worker:stale" });
      const done = await completeExternalOperation({ ...base, ...lease, operationKey: operation.operationKey, requestDigest: operation.requestDigest, evidence: { remoteState: "etag-2" } });
      const replay = await completeExternalOperation({ ...base, ...lease, operationKey: operation.operationKey, requestDigest: operation.requestDigest });
      let staleReplay = "";
      try { await completeExternalOperation({ ...base, ...lease, ownerProcessIdentity: "worker:stale", operationKey: operation.operationKey, requestDigest: operation.requestDigest }); } catch (error) { staleReplay = error.message; }
      let mismatch = "";
      try { await prepareExternalOperation({ ...base, ...lease, operationKey: "op:1", kind: "write", requestDigest: "sha256:wrong", subject: "subject-1", expectedRemoteState: "etag-1" }); } catch (error) { mismatch = error.message; }
      console.log(JSON.stringify({ stale, done, replay, staleReplay, mismatch }));
    `;
    const output = JSON.parse((await run(root, source)).stdout.trim());
    assert.equal(output.stale, null);
    assert.equal(output.done.status, "succeeded");
    assert.equal(output.replay.status, "succeeded");
    assert.match(output.staleReplay, /stale lease tuple/i);
    assert.match(output.mismatch, /mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation request digest is deterministic and storage rejects credential-shaped fields", async () => {
  assert.equal(digestOperationRequest({ b: 2, a: 1 }), digestOperationRequest({ b: 2, a: 1 }));
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-secret-"));
  try {
    await seedAggregate(root);
    const output = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation, completeExternalOperation } from ${JSON.stringify(coordinationUrl)};
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const base = ${JSON.stringify(args(root))};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...lease, ...base, operationKey: "secret", kind: "write", requestDigest: "sha256:safe", subject: "x", expectedRemoteState: "y" });
      let error = "";
      try { await completeExternalOperation({ ...base, ...lease, operationKey: operation.operationKey, requestDigest: operation.requestDigest, evidence: { token: "credential-value" } }); } catch (caught) { error = caught.message; }
      const db = await ensureStateDatabase();
      const row = db.prepare("SELECT evidence_json, status FROM external_operations WHERE operation_key = 'secret'").get();
      console.log(JSON.stringify({ error, row }));
    `)).stdout.trim());
    assert.match(output.error, /sensitive|secret/i);
    assert.deepEqual(output.row, { evidence_json: "{}", status: "prepared" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public caller timestamps cannot renew or complete an expired lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-trusted-clock-"));
  try {
    await seedAggregate(root);
    const input = { ...args(root), leaseTtlMs: 1_000 };
    const prepared = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...base, ...lease, operationKey: "trusted-clock", kind: "write", requestDigest: "sha256:clock", subject: "subject-1", expectedRemoteState: "etag-1" });
      console.log(JSON.stringify({ lease, operation }));
    `)).stdout.trim());
    const stale = JSON.parse((await run(root, `
      import { renewLease, completeExternalOperation } from ${JSON.stringify(coordinationUrl)};
      const input = ${JSON.stringify({ ...input, ...prepared.lease, nowMs: Date.parse("2026-08-17T00:00:00.001Z") })};
      const renewed = await renewLease(input);
      let terminalError = "";
      try { await completeExternalOperation({ ...input, operationKey: "trusted-clock", requestDigest: "sha256:clock" }); } catch (error) { terminalError = error.message; }
      console.log(JSON.stringify({ renewed, terminalError }));
    `, Date.parse("2026-08-17T00:00:01.001Z"))).stdout.trim());
    assert.equal(stale.renewed, null);
    assert.match(stale.terminalError, /unexpired matching lease/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal completion rejects an operation after the authoritative aggregate advances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-aggregate-version-"));
  try {
    await seedAggregate(root);
    const input = args(root);
    const prepared = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...base, ...lease, operationKey: "aggregate-version", kind: "write", requestDigest: "sha256:aggregate", subject: "subject-1", expectedRemoteState: "etag-1" });
      console.log(JSON.stringify({ lease, operation }));
    `)).stdout.trim());
    const output = JSON.parse((await run(root, `
      import { completeExternalOperation } from ${JSON.stringify(coordinationUrl)};
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      db.prepare("UPDATE tasks SET state_version = 8 WHERE id = 'task_aggregate'").run();
      let error = "";
      try { await completeExternalOperation({ ...${JSON.stringify(input)}, ...${JSON.stringify(prepared.lease)}, operationKey: "aggregate-version", requestDigest: "sha256:aggregate" }); } catch (caught) { error = caught.message; }
      const row = db.prepare("SELECT status FROM external_operations WHERE operation_key = 'aggregate-version'").get();
      console.log(JSON.stringify({ error, row }));
    `)).stdout.trim());
    assert.match(output.error, /state version changed from 7 to 8/i);
    assert.equal(output.row.status, "prepared");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new fenced owner can atomically adopt and resolve an expired prepared intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-adoption-"));
  try {
    await seedAggregate(root);
    const input = { ...args(root), leaseTtlMs: 1_000 };
    const original = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...base, ...lease, operationKey: "recoverable", kind: "write", requestDigest: "sha256:recoverable", subject: "subject-1", expectedRemoteState: "etag-1" });
      console.log(JSON.stringify({ lease, operation }));
    `)).stdout.trim());
    const recovered = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation, completeExternalOperation } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify({ ...input, ownerProcessIdentity: "worker:recovery" })};
      const lease = (await claimLease(base)).lease;
      const adopted = await prepareExternalOperation({ ...base, ...lease, operationKey: "recoverable", kind: "write", requestDigest: "sha256:recoverable", subject: "subject-1", expectedRemoteState: "etag-1" });
      const completed = await completeExternalOperation({ ...base, ...lease, operationKey: "recoverable", requestDigest: "sha256:recoverable" });
      console.log(JSON.stringify({ lease, adopted, completed }));
    `, Date.parse("2026-08-17T00:00:01.001Z"))).stdout.trim());
    assert.equal(recovered.lease.fence, original.lease.fence + 1);
    assert.equal(recovered.adopted.leaseId, recovered.lease.leaseId);
    assert.equal(recovered.completed.status, "succeeded");
    const stale = JSON.parse((await run(root, `
      import { completeExternalOperation } from ${JSON.stringify(coordinationUrl)};
      let error = "";
      try { await completeExternalOperation({ ...${JSON.stringify(input)}, ...${JSON.stringify(original.lease)}, operationKey: "recoverable", requestDigest: "sha256:recoverable" }); } catch (caught) { error = caught.message; }
      console.log(JSON.stringify({ error }));
    `, Date.parse("2026-08-17T00:00:01.002Z"))).stdout.trim());
    assert.match(stale.error, /stale lease tuple/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordination schema upgrades v1 rows with a verified backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-v1-upgrade-"));
  try {
    await createV1CoordinationFixture(root);
    const result = JSON.parse((await run(root, `
      import { stat } from "node:fs/promises";
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get().payload);
      const columns = (table) => db.prepare(\`PRAGMA table_info(\${table})\`).all().map((column) => column.name);
      const lease = db.prepare("SELECT lease_id, aggregate_type, aggregate_id FROM coordination_leases WHERE lease_id = 'lease-v1'").get();
      const operation = db.prepare("SELECT operation_key, aggregate_type, aggregate_id FROM external_operations WHERE operation_key = 'operation-v1'").get();
      const backup = await stat(meta.coordinationMigration.backupPath);
      console.log(JSON.stringify({ version: meta.coordinationMigration.schemaVersion, verified: meta.coordinationMigration.backupVerified, backupBytes: backup.size, columns: { leases: columns("coordination_leases"), operations: columns("external_operations") }, lease, operation }));
    `)).stdout.trim());
    assert.equal(result.version, 2);
    assert.equal(result.verified, true);
    assert.ok(result.backupBytes > 0);
    assert.ok(result.columns.leases.includes("aggregate_type") && result.columns.leases.includes("aggregate_id"));
    assert.ok(result.columns.operations.includes("aggregate_type") && result.columns.operations.includes("aggregate_id"));
    assert.deepEqual(result.lease, { lease_id: "lease-v1", aggregate_type: "", aggregate_id: "" });
    assert.deepEqual(result.operation, { operation_key: "operation-v1", aggregate_type: "", aggregate_id: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordination migration rolls schema and metadata back after an injected failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-v1-rollback-"));
  try {
    await createV1CoordinationFixture(root);
    await assert.rejects(
      () => run(root, `
        import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
        await ensureStateDatabase();
      `, Date.parse("2026-08-17T00:00:00.000Z"), { STUDIOOPS_TEST_FAIL_COORDINATION_MIGRATION: "after_schema" }),
      /Injected coordination migration failure/,
    );
    const result = JSON.parse((await run(root, `
      import { DatabaseSync } from "node:sqlite";
      import path from "node:path";
      import { missionControlDataDir } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/runtime-paths.js")).href)};
      const db = new DatabaseSync(path.join(missionControlDataDir(), "mission-control.sqlite3"), { readOnly: true });
      const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get().payload);
      const columns = (table) => db.prepare(\`PRAGMA table_info(\${table})\`).all().map((column) => column.name);
      console.log(JSON.stringify({ version: meta.coordinationMigration.schemaVersion, leases: columns("coordination_leases"), operations: columns("external_operations"), leaseCount: db.prepare("SELECT count(*) count FROM coordination_leases").get().count, operationCount: db.prepare("SELECT count(*) count FROM external_operations").get().count }));
    `)).stdout.trim());
    assert.equal(result.version, 1);
    assert.equal(result.leases.includes("aggregate_type"), false);
    assert.equal(result.operations.includes("aggregate_type"), false);
    assert.equal(result.leaseCount, 1);
    assert.equal(result.operationCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordination history compaction enforces audit retention floors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-retention-"));
  try {
    await seedAggregate(root);
    const initialClock = Date.parse("2026-01-01T00:00:00.000Z");
    const created = JSON.parse((await run(root, `
      import { claimLease, prepareExternalOperation, completeExternalOperation, releaseLease } from ${JSON.stringify(coordinationUrl)};
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const base = ${JSON.stringify(args(root))};
      const lease = (await claimLease(base)).lease;
      const operation = await prepareExternalOperation({ ...base, ...lease, operationKey: "retained", kind: "write", requestDigest: "sha256:retained", subject: "subject-1", expectedRemoteState: "etag-1" });
      await completeExternalOperation({ ...base, ...lease, operationKey: operation.operationKey, requestDigest: operation.requestDigest, evidence: { remoteState: "etag-2" } });
      await releaseLease({ ...base, ...lease });
      const db = await ensureStateDatabase();
      db.prepare("UPDATE coordination_leases SET detail_json = ? WHERE lease_id = ?").run(JSON.stringify({ reason: "released" }), lease.leaseId);
      console.log(JSON.stringify({ leaseId: lease.leaseId }));
    `, initialClock)).stdout.trim());

    const tooEarly = JSON.parse((await run(root, `
      import { compactCoordinationHistory } from ${JSON.stringify(coordinationUrl)};
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      let leaseFloorError = "";
      let operationFloorError = "";
      try { await compactCoordinationHistory({ leaseDetailRetentionMs: 0 }); } catch (error) { leaseFloorError = error.message; }
      try { await compactCoordinationHistory({ operationEvidenceRetentionMs: -1 }); } catch (error) { operationFloorError = error.message; }
      const db = await ensureStateDatabase();
      console.log(JSON.stringify({
        leaseFloorError,
        operationFloorError,
        result: await compactCoordinationHistory(),
        leaseDetail: db.prepare("SELECT detail_json FROM coordination_leases WHERE lease_id = ?").get(${JSON.stringify(created.leaseId)}).detail_json,
        operationEvidence: db.prepare("SELECT evidence_json FROM external_operations WHERE operation_key = 'retained'").get().evidence_json,
      }));
    `, initialClock + 29 * 24 * 60 * 60 * 1_000)).stdout.trim());
    assert.match(tooEarly.leaseFloorError, /at least/);
    assert.match(tooEarly.operationFloorError, /at least/);
    assert.deepEqual(tooEarly.result, { compactedLeases: 0, compactedOperations: 0 });
    assert.notEqual(tooEarly.leaseDetail, "{}");
    assert.notEqual(tooEarly.operationEvidence, "{}");

    const leaseEligible = JSON.parse((await run(root, `
      import { compactCoordinationHistory } from ${JSON.stringify(coordinationUrl)};
      console.log(JSON.stringify(await compactCoordinationHistory()));
    `, initialClock + 31 * 24 * 60 * 60 * 1_000)).stdout.trim());
    assert.deepEqual(leaseEligible, { compactedLeases: 1, compactedOperations: 0 });

    const operationEligible = JSON.parse((await run(root, `
      import { compactCoordinationHistory } from ${JSON.stringify(coordinationUrl)};
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const result = await compactCoordinationHistory();
      const db = await ensureStateDatabase();
      console.log(JSON.stringify({ result, evidence: db.prepare("SELECT evidence_json FROM external_operations WHERE operation_key = 'retained'").get().evidence_json }));
    `, initialClock + 91 * 24 * 60 * 60 * 1_000)).stdout.trim());
    assert.deepEqual(operationEligible.result, { compactedLeases: 0, compactedOperations: 1 });
    assert.equal(operationEligible.evidence, "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
