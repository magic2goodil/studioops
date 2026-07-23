import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planWatchdogActions, restartWorker } from "../src/watchdog.js";
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
