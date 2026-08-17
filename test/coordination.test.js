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

async function run(root, source) {
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: await environmentForTestControlRoot(root),
    timeout: 30_000,
  });
}

function args(root) {
  return {
    resourceKey: "provider:subject-1",
    ownerProcessIdentity: "worker:test",
    expectedStateVersion: 7,
    leaseTtlMs: 10_000,
    nowMs: Date.parse("2026-08-17T00:00:00.000Z"),
  };
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
    assert.equal(meta.coordinationMigration.schemaVersion, 1);
    assert.equal(meta.coordinationMigration.backupVerified, true);
    assert.equal(meta.lifecycleMigration.backupVerified, true);
    const schema = await run(root, `
      import { ensureStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      const db = await ensureStateDatabase();
      console.log(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'coordination_%' OR name = 'external_operations'").all()));
    `);
    assert.equal(JSON.parse(schema.stdout.trim()).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two processes get one exclusive claim and takeover gets a higher fence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-claim-"));
  try {
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
      console.log(JSON.stringify(await claimLease(${JSON.stringify({ ...input, ownerProcessIdentity: "worker:takeover", nowMs: input.nowMs + 20_000 })})));
    `);
    const next = JSON.parse(takeover.stdout.trim()).lease;
    assert.equal(next.fence, winner.fence + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired lease release and abandon calls are stale no-ops", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-expiry-"));
  try {
    const input = { ...args(root), leaseTtlMs: 1_000 };
    const output = JSON.parse((await run(root, `
      import { claimLease, releaseLease, abandonLease } from ${JSON.stringify(coordinationUrl)};
      const base = ${JSON.stringify(input)};
      const lease = (await claimLease(base)).lease;
      const staleInput = { ...base, ...lease, nowMs: base.nowMs + 1_001 };
      console.log(JSON.stringify({ release: await releaseLease(staleInput), abandon: await abandonLease(staleInput) }));
    `)).stdout.trim());
    assert.deepEqual(output, { release: null, abandon: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat and terminal operation CAS reject stale owners; replay and mismatch are safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-coordination-cas-"));
  try {
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
