import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planWatchdogActions } from "../src/watchdog.js";
import { readWorkerHeartbeats, staleWorkerNames, writeWorkerHeartbeat } from "../src/worker-heartbeat.js";

test("heartbeats are written atomically and stale workers are identified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-control-heartbeat-"));
  try {
    const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
    await writeWorkerHeartbeat("runner", { status: "idle" }, { dataDir: root, nowMs });
    const heartbeats = await readWorkerHeartbeats({ dataDir: root });
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].worker, "runner");
    assert.deepEqual(staleWorkerNames(heartbeats, ["runner"], { nowMs, staleAfterMs: 60_000 }), []);
    assert.deepEqual(staleWorkerNames(heartbeats, ["runner"], { nowMs: nowMs + 120_000, staleAfterMs: 60_000 }), ["runner"]);
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
