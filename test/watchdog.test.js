import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planWatchdogActions, restartWorker } from "../src/watchdog.js";
import { readWorkerHeartbeats, staleWorkerNames, writeWorkerHeartbeat } from "../src/worker-heartbeat.js";

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
  }));
  const state = {
    runs: [{ id: "run_1", taskId: "task_1", status: "queued", createdAt: "2026-07-21T10:00:00.000Z" }],
    tasks: [{ id: "task_2", status: "queued", updatedAt: "2026-07-21T10:00:00.000Z" }],
  };
  const actions = planWatchdogActions(state, fresh, { nowMs, workWaitMs: 60_000 });
  assert.ok(actions.some((item) => item.worker === "runner" && item.reason === "queued_run_waiting"));
  assert.ok(actions.some((item) => item.worker === "dispatcher" && item.reason === "dispatchable_task_waiting"));
});

test("watchdog does not churn workers while a run budget pause is active", () => {
  const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
  const fresh = ["dispatcher", "runner", "supervisor", "notifier"].map((worker) => ({
    worker,
    updatedAt: new Date(nowMs).toISOString(),
  }));
  const state = {
    meta: {
      budgetPause: {
        active: true,
        resumesAt: new Date(nowMs + 60 * 60 * 1_000).toISOString(),
      },
    },
    runs: [{ id: "run_1", taskId: "task_1", status: "queued", createdAt: "2026-07-21T10:00:00.000Z" }],
    tasks: [{ id: "task_2", status: "queued", updatedAt: "2026-07-21T10:00:00.000Z" }],
    projects: [],
  };

  assert.deepEqual(planWatchdogActions(state, fresh, { nowMs, workWaitMs: 60_000 }), []);
  const afterWindow = planWatchdogActions(state, fresh, {
    nowMs: nowMs + 2 * 60 * 60 * 1_000,
    workWaitMs: 60_000,
    staleAfterMs: 3 * 60 * 60 * 1_000,
  });
  assert.ok(afterWindow.some((item) => item.worker === "runner" && item.reason === "queued_run_waiting"));
  assert.ok(afterWindow.some((item) => item.worker === "dispatcher" && item.reason === "dispatchable_task_waiting"));
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
