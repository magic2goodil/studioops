import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createStudioOpsServer, livenessReport, readinessReport } from "../src/server.js";
import { compactOperationalHistory, operationalRetentionPolicy } from "../src/state-database.js";
import { runOperationalSoak } from "../scripts/operational-soak.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const stateDatabaseUrl = pathToFileURL(path.join(repositoryRoot, "src", "state-database.js")).href;

test("liveness is process-only and readiness reports every bounded dependency", async () => {
  const live = livenessReport({ now: "2026-08-01T00:00:00.000Z" });
  assert.equal(live.live, true);
  assert.equal(live.status, "ok");

  const nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const health = await readinessReport({
    nowMs,
    latencySloMs: 250,
    requiredWorkers: ["runner"],
    databaseReadinessHealth: async () => ({
      ok: true,
      database: { ok: true, latencyMs: 2, latencySloMs: 100 },
      queue: { ok: true, queuedCount: 0, oldestAgeMs: 0, maxAgeMs: 300_000 },
      leases: { ok: true, activeCount: 1, expiredCount: 0, oldestAgeMs: 10, oldestHeartbeatAgeMs: 5 },
    }),
    readWorkerHeartbeats: async () => [{
      worker: "runner", status: "idle", updatedAt: new Date(nowMs).toISOString(), dataDir: process.env.STUDIOOPS_DATA_DIR,
    }],
    readDiskAvailability: async ({ path: target }) => ({ path: target, pressure: false, availableBytes: 1_000_000, availablePercent: 50 }),
    loadConfig: async () => ({ projects: [] }),
  });
  assert.equal(health.ready, true);
  assert.equal(health.latency.sloMs, 250);
  assert.equal(health.database.ok, true);
  assert.equal(health.queue.ok, true);
  assert.equal(health.workers.ok, true);
  assert.equal(health.dependencies.config.ok, true);
  assert.equal(health.dependencies.disk.ok, true);
});

test("health HTTP routes preserve liveness, readiness status, metrics, and incident controls", async () => {
  const updates = [];
  const server = createStudioOpsServer({
    services: {
      readinessReport: async () => ({ ready: false, status: "not_ready", database: { ok: false }, queue: { ok: true }, workers: { ok: true }, dependencies: { ok: true } }),
      metricsReport: async () => ({ queue: { oldestAgeMs: 10 }, tokens: { input: 20 }, diskPressure: { ok: true } }),
      listOperationalIncidents: async () => [{ id: "incident_1", status: "open" }],
      updateOperationalIncident: async (id, patch) => {
        updates.push({ id, patch });
        return { id, status: patch.acknowledge ? "acknowledged" : "resolved" };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const live = await fetch(`${base}/api/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).live, true);
    const ready = await fetch(`${base}/api/ready`);
    assert.equal(ready.status, 503);
    const metrics = await (await fetch(`${base}/api/metrics`)).json();
    assert.equal(metrics.tokens.input, 20);
    const incidents = await (await fetch(`${base}/api/incidents`)).json();
    assert.equal(incidents.incidents[0].id, "incident_1");
    const acknowledged = await fetch(`${base}/api/incidents/incident_1/acknowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator", note: "Investigating" }),
    });
    assert.equal(acknowledged.status, 200);
    assert.equal(updates[0].patch.acknowledge, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("event, comment, run, and notification retention is configurable", () => {
  const nowMs = Date.parse("2026-08-30T00:00:00.000Z");
  const state = {
    comments: Array.from({ length: 8 }, (_, index) => ({
      id: `comment_${index}`, taskId: "task_1", systemGenerated: true, kind: "run_update", createdAt: new Date(nowMs - index).toISOString(),
    })),
    events: Array.from({ length: 8 }, (_, index) => ({
      id: `event_${index}`, taskId: "task_1", type: "automation_tick", executionKey: "same", createdAt: new Date(nowMs - index).toISOString(),
    })),
    runs: Array.from({ length: 8 }, (_, index) => ({
      id: `run_${index}`, taskId: "task_1", role: "builder", actionType: "builder", status: "completed", maxAttempts: 1, createdAt: new Date(nowMs - index).toISOString(),
    })),
    notificationOutbox: Array.from({ length: 8 }, (_, index) => ({
      id: `notification_${index}`, status: "acknowledged", acknowledgedAt: new Date(nowMs - index).toISOString(),
    })),
  };
  const archived = compactOperationalHistory(state, {
    nowMs,
    machineCommentsPerTask: 2,
    eventsPerStream: 3,
    terminalRunsPerWorkflowAction: 2,
    notificationMaxRows: 2,
  });
  assert.deepEqual({
    comments: state.comments.length,
    events: state.events.length,
    runs: state.runs.length,
    notifications: state.notificationOutbox.length,
  }, { comments: 2, events: 3, runs: 2, notifications: 2 });
  assert.deepEqual(Object.fromEntries(Object.entries(archived).map(([key, items]) => [key, items.length])), {
    comments: 6, events: 5, runs: 6, notificationOutbox: 6,
  });
  const policy = operationalRetentionPolicy({}, {
    STUDIOOPS_RETENTION_ARCHIVE_DAYS: "7",
    STUDIOOPS_RETENTION_RUN_OUTPUT_DAYS: "3",
    STUDIOOPS_RETENTION_NOTIFICATION_MAX_ROWS: "40",
  });
  assert.equal(policy.archiveDays, 7);
  assert.equal(policy.runOutputDays, 3);
  assert.equal(policy.notificationMaxRows, 40);
});

test("incidents, metrics, run-output retention, backup, and compaction survive a persistence cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-operational-health-"));
  const outputDir = path.join(root, "run-outputs");
  const env = await environmentForTestControlRoot(root);
  const script = `
    import { mkdir, utimes, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import {
      DATABASE_FILE, compactStateDatabase, ensureStateDatabase, listOperationalIncidents,
      operationalMetrics, pruneRunOutputFiles, readDatabaseState, updateOperationalIncident,
      upsertOperationalIncident, writeDatabaseState
    } from ${JSON.stringify(stateDatabaseUrl)};
    const nowMs = Date.parse('2026-08-30T00:00:00.000Z');
    await ensureStateDatabase();
    const state = await readDatabaseState();
    state.events.push({ id: 'event_loop', type: 'automation_tick', createdAt: new Date(nowMs).toISOString() });
    state.runs.push({
      id: 'run_metrics', status: 'completed', role: 'builder', taskId: 'task_1', actionType: 'builder', attempt: 3,
      createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(),
      costTelemetry: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, reasoningOutputTokens: 10 }
    });
    state.notificationOutbox.push({ id: 'notification_metrics', status: 'delivered', attempts: 2, createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() });
    await writeDatabaseState(state);
    const opened = await upsertOperationalIncident({ identityKey: 'worker:runner', kind: 'worker', severity: 'critical', actor: 'watchdog', detail: { reason: 'heartbeat_stale' } });
    await updateOperationalIncident(opened.id, { acknowledge: true, owner: 'operator', actor: 'operator', note: 'Investigating' });
    const resolved = await updateOperationalIncident(opened.id, { resolve: true, actor: 'operator', resolutionEvidence: 'Heartbeat restored and two sweeps completed.' });
    const incidents = await listOperationalIncidents();
    const metrics = await operationalMetrics({ nowMs });

    await mkdir(${JSON.stringify(outputDir)}, { recursive: true });
    const old = path.join(${JSON.stringify(outputDir)}, 'old.log');
    const active = path.join(${JSON.stringify(outputDir)}, 'active.log');
    await writeFile(old, 'old output');
    await writeFile(active, 'active output');
    await utimes(old, new Date(nowMs - 10 * 86400000), new Date(nowMs - 10 * 86400000));
    await utimes(active, new Date(nowMs - 10 * 86400000), new Date(nowMs - 10 * 86400000));
    const next = await readDatabaseState();
    next.runs.push({ id: 'run_active_output', status: 'running', outputPath: active, createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() });
    await writeDatabaseState(next);
    const output = await pruneRunOutputFiles({ outputDir: ${JSON.stringify(outputDir)}, nowMs, runOutputDays: 1, runOutputMaxFiles: 1 });

    const filler = new DatabaseSync(DATABASE_FILE);
    const insert = filler.prepare('INSERT INTO database_contention_events(id, operation_name, outcome, wait_ms, duration_ms, retry_count, created_at) VALUES (?, ?, ?, 0, 0, 0, ?)');
    for (let index = 0; index < 300; index += 1) insert.run('filler_' + index, 'x'.repeat(8000), 'committed', new Date(nowMs).toISOString());
    filler.exec("DELETE FROM database_contention_events WHERE id LIKE 'filler_%'");
    filler.close();
    const compacted = await compactStateDatabase({ backupPath: path.join(${JSON.stringify(root)}, 'backup.sqlite3') });
    console.log(JSON.stringify({ resolved, incidents, metrics, output, compacted }));
  `;
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repositoryRoot,
      env,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const report = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(report.resolved.status, "resolved");
    assert.equal(report.resolved.owner, "operator");
    assert.equal(report.resolved.timeline.some((item) => item.type === "acknowledged"), true);
    assert.equal(report.resolved.timeline.some((item) => item.type === "resolved"), true);
    assert.equal(report.metrics.retries.runRetries, 2);
    assert.equal(report.metrics.tokens.input, 100);
    assert.equal(report.metrics.notifications.delivered.count, 1);
    assert.equal(report.output.removed.some((item) => item.endsWith("old.log")), true);
    assert.equal(report.output.removed.some((item) => item.endsWith("active.log")), false);
    assert.equal(report.compacted.integrity, "ok");
    assert.equal(report.compacted.after.pageCount <= report.compacted.before.pageCount, true);
    assert.equal(report.compacted.reclaimedBytes > 0, true, JSON.stringify(report.compacted));
    assert.equal(report.compacted.physicalReclaimedBytes > 0, true, JSON.stringify(report.compacted));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accelerated 24-hour soak keeps state bounded and recovers injected failures", () => {
  const report = runOperationalSoak({ hours: 24 });
  assert.equal(report.simulatedHours, 24);
  assert.equal(report.bounded, true);
  assert.equal(report.recovered, true);
  assert.deepEqual(report.injectedFailures.map((failure) => failure.kind), ["queue_stall", "worker_loss", "disk_pressure"]);
});
