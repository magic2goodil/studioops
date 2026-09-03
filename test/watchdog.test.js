import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessPipelineLiveness,
  managedWorkerHealth,
  planWatchdogActions,
  restartWorker,
  runWatchdog,
} from "../src/watchdog.js";
import {
  automationTick,
  openDiskPressureIncidentInState,
  recoverDiskPressureIncidentInState,
  updateDiskPressureIncidentInState,
} from "../src/store.js";
import {
  createOverlappingSweepStarter,
  readWorkerHeartbeats,
  staleWorkerNames,
  writeWorkerHeartbeat,
} from "../src/worker-heartbeat.js";

test("overlapping sweep starter keeps polling while a prior sweep owns long-running jobs", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const started = [];
  const sweeps = createOverlappingSweepStarter(async () => {
    const index = started.length + 1;
    started.push(index);
    if (index === 1) await firstBlocked;
  });

  const first = sweeps.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweeps.activeCount, 1);

  const second = sweeps.start();
  await second;
  assert.deepEqual(started, [1, 2]);
  assert.equal(sweeps.activeCount, 1);

  releaseFirst();
  await first;
  assert.equal(sweeps.activeCount, 0);
});

test("heartbeats are written atomically and stale workers are identified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-control-heartbeat-"));
  try {
    const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
    await writeWorkerHeartbeat("runner", { status: "idle" }, { dataDir: root, nowMs });
    const heartbeats = await readWorkerHeartbeats({ dataDir: root });
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].worker, "runner");
    assert.equal(heartbeats[0].dataDir, root);
    assert.equal(typeof heartbeats[0].disk.availableBytes, "number");
    assert.deepEqual(staleWorkerNames(heartbeats, ["runner"], { nowMs, staleAfterMs: 60_000 }), []);
    assert.deepEqual(staleWorkerNames(heartbeats, ["runner"], { nowMs: nowMs + 120_000, staleAfterMs: 60_000 }), ["runner"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent heartbeat pulses do not collide or leave temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-heartbeat-concurrency-"));
  try {
    await Promise.all(Array.from({ length: 24 }, (_, index) => writeWorkerHeartbeat(
      "runner",
      { status: index % 2 ? "busy" : "idle" },
      { dataDir: root },
    )));
    const files = await readdir(path.join(root, "heartbeats"));
    assert.deepEqual(files, ["runner.json"]);
    const heartbeats = await readWorkerHeartbeats({ dataDir: root });
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].worker, "runner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog wakes the runner for old queued work and dispatcher for stranded tasks", () => {
  const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
  const fresh = ["dispatcher", "runner", "supervisor", "notifier"].map((worker) => ({
    worker,
    updatedAt: new Date(nowMs).toISOString(),
    status: "idle",
    intervalSeconds: 15,
    lastSweepStartedAt: "2026-07-21T10:00:00.000Z",
  }));
  const state = {
    runs: [{ id: "run_1", taskId: "task_1", status: "queued", createdAt: "2026-07-21T10:00:00.000Z" }],
    tasks: [{ id: "task_2", status: "queued", updatedAt: "2026-07-21T10:00:00.000Z" }],
  };
  const actions = planWatchdogActions(state, fresh, { nowMs, workWaitMs: 60_000 });
  assert.ok(actions.some((item) => item.worker === "runner" && item.reason === "queued_run_waiting"));
  assert.ok(actions.some((item) => item.worker === "dispatcher" && item.reason === "dispatchable_task_waiting"));
});

test("watchdog does not restart healthy workers for queued or capacity-blocked work", () => {
  const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
  const heartbeats = ["dispatcher", "runner", "supervisor", "notifier"].map((worker) => ({
    worker,
    updatedAt: new Date(nowMs).toISOString(),
    status: "idle",
    intervalSeconds: 10,
    lastSweepStartedAt: new Date(nowMs - 5_000).toISOString(),
    lastSweepCompletedAt: new Date(nowMs - 4_000).toISOString(),
  }));
  const state = {
    runs: [{ id: "run_1", taskId: "task_1", status: "queued", createdAt: "2026-07-21T10:00:00.000Z" }],
    tasks: [{ id: "task_2", status: "queued", updatedAt: "2026-07-21T10:00:00.000Z" }],
  };

  assert.deepEqual(planWatchdogActions(state, heartbeats, { nowMs, workWaitMs: 15_000 }), []);
});

test("disk pressure pauses restart planning instead of creating a restart loop", () => {
  const actions = planWatchdogActions(
    { runs: [], tasks: [] },
    [],
    {
      disk: {
        pressure: true,
        path: "/tmp/studioops-data",
        availableBytes: 1024,
        availablePercent: 0.1,
      },
    },
  );

  assert.deepEqual(actions, [{
    type: "report_disk_pressure",
    reason: "disk_space_below_safety_threshold",
    availableBytes: 1024,
    availablePercent: 0.1,
    path: "/tmp/studioops-data",
  }]);
});

test("watchdog refuses to restart a LaunchAgent owned by another runtime root", async () => {
  let restarted = false;
  await assert.rejects(
    restartWorker("runner", {
      rootDir: "/tmp/studioops-current",
      resolveWorkerRoot: async () => "/tmp/studioops-live",
      restartWorker: async () => {
        restarted = true;
      },
    }),
    /does not match current root/,
  );
  assert.equal(restarted, false);
});

function healthyHeartbeats(nowMs, dataDir = "/tmp/studioops-data") {
  return ["dispatcher", "runner", "supervisor", "notifier"].map((worker) => ({
    worker,
    status: "idle",
    dataDir,
    updatedAt: new Date(nowMs).toISOString(),
    lastSweepStartedAt: new Date(nowMs - 1_000).toISOString(),
  }));
}

function disk(pathname, pressure) {
  return {
    path: pathname,
    availableBytes: pressure ? 1 : 1_000_000,
    totalBytes: 2_000_000,
    availablePercent: pressure ? 0.1 : 50,
    minAvailableBytes: 100,
    minAvailablePercent: 2,
    pressure,
  };
}

test("watchdog defers a concurrent automation mutation while preserving worker health checks", async () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  const conflict = Object.assign(new Error("expected test conflict"), { code: "STUDIOOPS_STATE_CONFLICT" });
  const report = await runWatchdog({
    state,
    nowMs,
    diskPair: { data: disk("/tmp/studioops-data", false), workspace: disk("/tmp/studioops-workspaces", false) },
    automationTick: async () => { throw conflict; },
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs),
    writeWorkerHeartbeat: async () => ({}),
  });
  assert.deepEqual(report.reconciliation, {
    actions: [], deferred: true, reason: "concurrent_state_change",
  });
  assert.deepEqual(report.actions, []);
});

test("watchdog treats stale task stateVersion coordination as a deferred sweep", async () => {
  const nowMs = Date.parse("2026-09-03T13:00:00.000Z");
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  const conflict = Object.assign(
    new Error("Stale lifecycle command: expected stateVersion 7, current version is 8."),
    { code: "STALE_STATE_VERSION" },
  );
  const report = await runWatchdog({
    state,
    nowMs,
    diskPair: { data: disk("/tmp/studioops-data", false), workspace: disk("/tmp/studioops-workspaces", false) },
    automationTick: async () => { throw conflict; },
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs),
    writeWorkerHeartbeat: async () => ({}),
  });

  assert.deepEqual(report.reconciliation, {
    actions: [], deferred: true, reason: "concurrent_state_change",
  });
  assert.deepEqual(report.actions, []);
});

test("watchdog detects one sustained no-progress incident and queues one deduplicated owner alert", async () => {
  const nowMs = Date.parse("2026-09-03T13:00:00.000Z");
  const state = {
    meta: {},
    projects: [{ id: "project_1", key: "demo", notificationPolicy: { channels: ["in_app"] } }],
    tasks: [{
      id: "task_waiting",
      projectId: "project_1",
      title: "Waiting builder task",
      status: "ready",
      updatedAt: "2026-09-03T12:00:00.000Z",
    }],
    runs: [],
    events: [],
    comments: [],
    reviews: [],
    qaBundles: [],
    notificationOutbox: [],
  };
  const action = {
    type: "start_builder",
    projectKey: "demo",
    taskId: "task_waiting",
    taskTitle: "Waiting builder task",
    taskUrl: "http://127.0.0.1:4317/tasks/task_waiting",
  };
  const assessment = assessPipelineLiveness(state, {
    nowMs,
    workWaitMs: 60_000,
    createSupervisorReport: () => ({ actions: [action] }),
  });
  assert.equal(assessment.stalled, true);
  assert.equal(assessment.cause, "no_executable_run_admitted");

  const options = {
    state,
    nowMs,
    workWaitMs: 60_000,
    diskPair: { data: disk("/tmp/studioops-data", false), workspace: disk("/tmp/studioops-workspaces", false) },
    automationTick: async () => ({ actions: [] }),
    createSupervisorReport: () => ({ actions: [action] }),
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs),
    writeWorkerHeartbeat: async () => ({}),
  };
  const first = await runWatchdog(options);
  const second = await runWatchdog(options);

  assert.equal(first.liveness.stalled, true);
  assert.equal(first.livenessNotification.notifications.length, 1);
  assert.equal(second.liveness.stalled, true);
  assert.equal(second.livenessNotification, null);
  assert.equal(state.notificationOutbox.length, 1);
  assert.equal(state.events.filter((event) => event.type === "pipeline_stall_detected").length, 1);
});

test("watchdog defers all restart activity during a verified maintenance lease", async () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  const maintenance = Object.assign(new Error("expected maintenance"), { code: "STUDIOOPS_MAINTENANCE" });
  let heartbeatReads = 0;
  const report = await runWatchdog({
    state,
    nowMs,
    diskPair: { data: disk("/tmp/studioops-data", false), workspace: disk("/tmp/studioops-workspaces", false) },
    automationTick: async () => { throw maintenance; },
    readWorkerHeartbeats: async () => { heartbeatReads += 1; return []; },
    writeWorkerHeartbeat: async () => ({}),
    restartWorker: async () => { throw new Error("restart must not run during maintenance"); },
  });
  assert.deepEqual(report.reconciliation, {
    actions: [], deferred: true, reason: "maintenance_in_progress",
  });
  assert.deepEqual(report.actions, []);
  assert.equal(heartbeatReads, 0);
});

test("watchdog still fails loudly for unknown automation errors", async () => {
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  await assert.rejects(
    runWatchdog({
      state,
      diskPair: { data: disk("/tmp/studioops-data", false), workspace: disk("/tmp/studioops-workspaces", false) },
      automationTick: async () => { throw new Error("unexpected corruption"); },
      writeWorkerHeartbeat: async () => ({}),
    }),
    /unexpected corruption/,
  );
});

test("durable disk incidents use compare-and-set generations and bounded observations", async () => {
  const state = { meta: {}, events: [], projects: [], tasks: [], runs: [] };
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const first = openDiskPressureIncidentInState(state, {
    nowMs,
    data: disk("/tmp/data", true),
    workspace: disk("/tmp/workspaces", true),
  });
  const second = openDiskPressureIncidentInState(state, {
    nowMs: nowMs + 1,
    data: disk("/tmp/data", true),
    workspace: disk("/tmp/workspaces", false),
  });
  assert.equal(first.id, second.id);
  assert.equal(second.generation, 2);
  assert.equal(second.observationCount, 2);
  assert.equal(state.events.filter((event) => event.type === "disk_pressure_incident_opened").length, 1);
  assert.throws(() => updateDiskPressureIncidentInState(state, {
    incidentId: second.id,
    expectedGeneration: 1,
  }), /generation mismatch/);
  const awaiting = updateDiskPressureIncidentInState(state, {
    incidentId: second.id,
    expectedGeneration: 2,
    state: "awaiting_health",
    cleanup: { selectedCount: 1, logicalDeletedBytes: 10 },
    health: { database: { ok: true } },
  });
  assert.equal(awaiting.generation, 3);
  const recovered = recoverDiskPressureIncidentInState(state, {
    incidentId: awaiting.id,
    expectedGeneration: 3,
    nowMs: nowMs + 10,
    data: disk("/tmp/data", false),
    workspace: disk("/tmp/workspaces", false),
    health: { database: { ok: true }, workers: { ok: true } },
  });
  assert.equal(recovered.state, "recovered");
  assert.equal(state.events.filter((event) => event.type === "disk_pressure_incident_recovered").length, 1);
});

test("automation remains blocked by an active disk incident without clearing operator controls", async () => {
  const state = {
    meta: {
      diskPressureIncident: { id: "disk_incident_1", state: "awaiting_health", generation: 2 },
      operatorPause: { active: true, reason: "Owner pause" },
    },
    projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [],
  };
  const result = await automationTick({ state });
  assert.equal(result.paused, true);
  assert.equal(result.pauseReason, "disk_recovery_in_progress");
  assert.equal(state.meta.operatorPause.active, true);
});

test("managed worker health rejects stale, error, and wrong-root heartbeats", () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const heartbeats = healthyHeartbeats(nowMs);
  heartbeats[0].dataDir = "/tmp/wrong";
  heartbeats[1].status = "error";
  heartbeats[2].updatedAt = new Date(nowMs - 600_000).toISOString();
  const health = managedWorkerHealth(heartbeats, { nowMs, dataDir: "/tmp/studioops-data" });
  assert.equal(health.ok, false);
  assert.deepEqual(health.workers.map((worker) => worker.reason), [
    "worker_data_root_mismatch",
    "worker_status_unhealthy",
    "heartbeat_stale",
    "",
  ]);
});

test("watchdog recovers once after cleanup, database, and worker checks while preserving owner pause", async () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const dataDir = "/tmp/studioops-data";
  const workspaceRoot = "/tmp/studioops-workspaces";
  const state = {
    meta: { operatorPause: { active: true, reason: "Controlled cutover" } },
    projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [],
  };
  let diskRead = 0;
  const pairs = [
    { data: disk(dataDir, true), workspace: disk(workspaceRoot, true) },
    { data: disk(dataDir, false), workspace: disk(workspaceRoot, false) },
  ];
  const report = await runWatchdog({
    state,
    nowMs,
    dataDir,
    workspaceRoot,
    readDiskPair: async () => pairs[Math.min(diskRead++, pairs.length - 1)],
    runWorkspaceCleanup: async () => ({
      attempted: true,
      after: { data: disk(dataDir, false), workspace: disk(workspaceRoot, false) },
      selection: { excludedByReason: {} },
      selectedCount: 1,
      skippedCount: 0,
      failureCount: 0,
      logicalDeletedBytes: 100,
      actualAvailableByteDelta: 100,
      remainingShortfall: { pressure: false, bytes: 0, percentPoints: 0 },
    }),
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs, dataDir),
    writeWorkerHeartbeat: async () => ({}),
  });
  assert.equal(report.incident.state, "recovered");
  assert.equal(report.reconciliation.paused, true);
  assert.equal(report.reconciliation.pauseReason, "Controlled cutover");
  assert.equal(state.meta.operatorPause.active, true);
  assert.equal(state.events.filter((event) => event.type === "disk_pressure_incident_recovered").length, 1);
});

test("watchdog keeps a flapping or database-degraded incident active", async () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const dataDir = "/tmp/studioops-data";
  const workspaceRoot = "/tmp/studioops-workspaces";
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  let stateReads = 0;
  let diskReads = 0;
  const report = await runWatchdog({
    state,
    nowMs,
    dataDir,
    workspaceRoot,
    readState: async () => {
      stateReads += 1;
      if (stateReads > 1) throw new Error("simulated database read failure");
      return state;
    },
    readDiskPair: async () => {
      diskReads += 1;
      return diskReads === 1
        ? { data: disk(dataDir, true), workspace: disk(workspaceRoot, true) }
        : { data: disk(dataDir, true), workspace: disk(workspaceRoot, false) };
    },
    runWorkspaceCleanup: async () => ({
      attempted: true,
      after: { data: disk(dataDir, false), workspace: disk(workspaceRoot, false) },
      selection: { excludedByReason: { protected_source_repository_path: 1 } },
      selectedCount: 0,
      skippedCount: 1,
      failureCount: 0,
      logicalDeletedBytes: 0,
      actualAvailableByteDelta: 0,
      remainingShortfall: { pressure: true, bytes: 0, percentPoints: 1.9 },
    }),
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs, dataDir),
    writeWorkerHeartbeat: async () => ({}),
  });
  assert.equal(report.incident.state, "degraded");
  assert.equal(report.incident.health.database.ok, false);
  assert.match(report.incident.remediation, /Disk remains below threshold/);
  assert.equal(report.reconciliation.pauseReason, "disk_recovery_in_progress");
});

test("watchdog attempts one root-verified worker restart per incident before later recovery", async () => {
  const nowMs = Date.parse("2026-08-17T00:00:00.000Z");
  const dataDir = "/tmp/studioops-data";
  const workspaceRoot = "/tmp/studioops-workspaces";
  const state = { meta: {}, projects: [], tasks: [], runs: [], events: [], comments: [], reviews: [], qaBundles: [] };
  const pairs = { data: disk(dataDir, false), workspace: disk(workspaceRoot, false) };
  const unhealthy = healthyHeartbeats(nowMs, dataDir);
  unhealthy[1].dataDir = "/tmp/wrong-root";
  const restarts = [];
  const options = {
    state,
    nowMs,
    dataDir,
    workspaceRoot,
    rootDir: "/tmp/studioops-root",
    diskPair: { data: disk(dataDir, true), workspace: disk(workspaceRoot, true) },
    readDiskPair: async () => pairs,
    runWorkspaceCleanup: async () => ({
      attempted: true,
      after: pairs,
      selection: { excludedByReason: {} },
      selectedCount: 1,
      skippedCount: 0,
      failureCount: 0,
      logicalDeletedBytes: 100,
      actualAvailableByteDelta: 100,
      remainingShortfall: { pressure: false, bytes: 0, percentPoints: 0 },
    }),
    readWorkerHeartbeats: async () => unhealthy,
    writeWorkerHeartbeat: async () => ({}),
    resolveWorkerRoot: async () => "/tmp/studioops-root",
    restartWorker: async (worker) => { restarts.push(worker); },
  };
  const first = await runWatchdog(options);
  assert.equal(first.incident.state, "awaiting_health");
  assert.deepEqual(restarts, ["runner"]);
  assert.deepEqual(first.incident.restartedWorkers, ["runner"]);

  const second = await runWatchdog({ ...options, diskPair: pairs });
  assert.equal(second.incident.state, "awaiting_health");
  assert.deepEqual(restarts, ["runner"]);

  const recovered = await runWatchdog({
    ...options,
    diskPair: pairs,
    readWorkerHeartbeats: async () => healthyHeartbeats(nowMs, dataDir),
  });
  assert.equal(recovered.incident.state, "recovered");
});
