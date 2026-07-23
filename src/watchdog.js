import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { automationTick, readState } from "./store.js";
import { missionControlDataDir, missionControlRoot } from "./runtime-paths.js";
import {
  readDiskAvailability,
  readWorkerHeartbeats,
  staleWorkerNames,
  writeWorkerHeartbeat,
} from "./worker-heartbeat.js";

const execFileAsync = promisify(execFile);
const WORKERS = ["dispatcher", "runner", "supervisor", "notifier"];
const LABEL_PREFIX = "com.codex.mission-control.";
const DEFAULT_WORK_WAIT_MS = 12 * 60 * 1000;

function ageMs(value, nowMs) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? nowMs - parsed : Number.POSITIVE_INFINITY;
}

export function planWatchdogActions(state, heartbeats, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const disk = input.disk || {};
  if (disk.pressure) {
    return [{
      type: "report_disk_pressure",
      reason: "disk_space_below_safety_threshold",
      availableBytes: disk.availableBytes,
      availablePercent: disk.availablePercent,
      path: disk.path,
    }];
  }
  const actions = staleWorkerNames(heartbeats, WORKERS, input)
    .map((worker) => ({ type: "restart_worker", worker, reason: "heartbeat_stale_or_missing" }));
  const scheduled = new Set(actions.map((item) => item.worker));
  const workWaitMs = Math.max(60_000, Number(input.workWaitMs || DEFAULT_WORK_WAIT_MS));
  const queuedRunWaiting = (state.runs || []).some((run) => run.status === "queued" && ageMs(run.createdAt, nowMs) > workWaitMs);
  if (queuedRunWaiting && !scheduled.has("runner")) {
    actions.push({ type: "restart_worker", worker: "runner", reason: "queued_run_waiting" });
    scheduled.add("runner");
  }
  const dispatchWaiting = !state.meta?.operatorPause?.active && (state.tasks || []).some((task) => (
    ["queued", "ready", "needs_changes", "builder_review", "backend_review", "frontend_review", "accessibility_review", "lead_review"].includes(task.status)
    && task.automationCircuit?.state !== "open"
    && ageMs(task.updatedAt || task.createdAt, nowMs) > workWaitMs
    && !(state.runs || []).some((run) => run.taskId === task.id && ["queued", "running"].includes(run.status))
  ));
  if (dispatchWaiting && !scheduled.has("dispatcher")) {
    actions.push({ type: "restart_worker", worker: "dispatcher", reason: "dispatchable_task_waiting" });
  }
  return actions;
}

async function installedWorkerRoot(worker, input = {}) {
  if (input.resolveWorkerRoot) return input.resolveWorkerRoot(worker);
  const domain = `gui/${process.getuid()}/${LABEL_PREFIX}${worker}`;
  const result = await execFileAsync("launchctl", ["print", domain], { timeout: 15_000 });
  const match = String(result.stdout || "").match(/^\s*working directory = (.+)$/m);
  if (!match) throw new Error(`Cannot verify the installed StudioOps root for ${worker}.`);
  return match[1].trim();
}

export async function restartWorker(worker, input = {}) {
  if (!input.restartWorker && process.platform !== "darwin") {
    return `Skipped ${worker}; launchctl is only available on macOS.`;
  }
  const expectedRoot = path.resolve(input.rootDir || missionControlRoot());
  const managedRoot = path.resolve(await installedWorkerRoot(worker, input));
  if (managedRoot !== expectedRoot) {
    throw new Error(
      `Refusing to restart ${worker}: installed root ${managedRoot} does not match current root ${expectedRoot}.`,
    );
  }
  if (input.restartWorker) return input.restartWorker(worker);
  const domain = `gui/${process.getuid()}/${LABEL_PREFIX}${worker}`;
  await execFileAsync("launchctl", ["kickstart", "-k", domain], { timeout: 15_000 });
  return `Restarted ${worker}`;
}

export async function runWatchdog(input = {}) {
  const startedAt = new Date().toISOString();
  const disk = input.disk || await readDiskAvailability({
    ...input,
    path: input.dataDir || missionControlDataDir(),
  });
  await writeWorkerHeartbeat("watchdog", { status: "busy", lastSweepStartedAt: startedAt }, { ...input, disk })
    .catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
  const reconciliation = disk.pressure
    ? { actions: [], paused: true, reason: "disk_space_below_safety_threshold" }
    : await automationTick({ ...input, limit: input.limit || 100 });
  const [state, heartbeats] = await Promise.all([readState(), readWorkerHeartbeats(input)]);
  const actions = planWatchdogActions(state, heartbeats, { ...input, disk });
  const results = [];
  for (const action of actions) {
    if (action.type === "report_disk_pressure") {
      results.push({
        ...action,
        ok: false,
        output: `StudioOps paused automation because ${action.path} has ${action.availableBytes} bytes (${action.availablePercent}%) available.`,
      });
      continue;
    }
    try {
      results.push({ ...action, ok: true, output: await restartWorker(action.worker, input) });
    } catch (error) {
      results.push({ ...action, ok: false, output: error?.message || String(error) });
    }
  }
  await writeWorkerHeartbeat("watchdog", {
    status: "idle",
    lastError: results.filter((item) => !item.ok).map((item) => item.output).join("; "),
    lastSweepCompletedAt: new Date().toISOString(),
    lastSuccessAt: results.every((item) => item.ok) ? new Date().toISOString() : "",
  }, { ...input, disk }).catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
  return { generatedAt: new Date().toISOString(), disk, reconciliation, actions: results };
}
