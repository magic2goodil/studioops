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

async function run(root, source, clockMs = Date.parse("2026-08-17T00:00:00.000Z")) {
  const env = await environmentForTestControlRoot(root);
  env.STUDIOOPS_COORDINATION_TEST_NOW_MS = String(clockMs);
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    timeout: 30_000,
  });
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
