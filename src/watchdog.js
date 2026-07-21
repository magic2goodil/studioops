import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { automationTick, readState } from "./store.js";
import { readWorkerHeartbeats, staleWorkerNames, writeWorkerHeartbeat } from "./worker-heartbeat.js";

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
  const actions = staleWorkerNames(heartbeats, WORKERS, input)
    .map((worker) => ({ type: "restart_worker", worker, reason: "heartbeat_stale_or_missing" }));
  const scheduled = new Set(actions.map((item) => item.worker));
  const workWaitMs = Math.max(60_000, Number(input.workWaitMs || DEFAULT_WORK_WAIT_MS));
  const queuedRunWaiting = (state.runs || []).some((run) => run.status === "queued" && ageMs(run.createdAt, nowMs) > workWaitMs);
  if (queuedRunWaiting && !scheduled.has("runner")) {
    actions.push({ type: "restart_worker", worker: "runner", reason: "queued_run_waiting" });
    scheduled.add("runner");
  }
  const dispatchWaiting = (state.tasks || []).some((task) => (
    ["queued", "ready", "needs_changes", "builder_review", "backend_review", "frontend_review", "accessibility_review", "lead_review"].includes(task.status)
    && ageMs(task.updatedAt || task.createdAt, nowMs) > workWaitMs
    && !(state.runs || []).some((run) => run.taskId === task.id && ["queued", "running"].includes(run.status))
  ));
  if (dispatchWaiting && !scheduled.has("dispatcher")) {
    actions.push({ type: "restart_worker", worker: "dispatcher", reason: "dispatchable_task_waiting" });
  }
  return actions;
}

async function restartWorker(worker, input = {}) {
  if (input.restartWorker) return input.restartWorker(worker);
  if (process.platform !== "darwin") return `Skipped ${worker}; launchctl is only available on macOS.`;
  const domain = `gui/${process.getuid()}/${LABEL_PREFIX}${worker}`;
  await execFileAsync("launchctl", ["kickstart", "-k", domain], { timeout: 15_000 });
  return `Restarted ${worker}`;
}

export async function runWatchdog(input = {}) {
  const startedAt = new Date().toISOString();
  await writeWorkerHeartbeat("watchdog", { status: "busy", lastSweepStartedAt: startedAt }, input);
  const reconciliation = await automationTick({ ...input, limit: input.limit || 100 });
  const [state, heartbeats] = await Promise.all([readState(), readWorkerHeartbeats(input)]);
  const actions = planWatchdogActions(state, heartbeats, input);
  const results = [];
  for (const action of actions) {
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
  }, input);
  return { generatedAt: new Date().toISOString(), reconciliation, actions: results };
}
