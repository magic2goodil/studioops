import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  automationTick,
  diskPressureIncidentIsActive,
  openDiskPressureIncident,
  openDiskPressureIncidentInState,
  readState,
  recoverDiskPressureIncident,
  recoverDiskPressureIncidentInState,
  updateDiskPressureIncident,
  updateDiskPressureIncidentInState,
} from "./store.js";
import { activeRunStaleReason, planRunnableRuns, runWorkspaceCleanup } from "./runner.js";
import { loadConfig } from "./config.js";
import { createSupervisorReport } from "./supervisor.js";
import {
  pipelineLivenessNotificationNeedsUpdate,
  reconcilePipelineLivenessNotification,
} from "./notifier.js";
import {
  defaultStudioOpsWorkspaceRoot,
  missionControlDataDir,
  missionControlRoot,
} from "./runtime-paths.js";
import {
  readDiskAvailability,
  readWorkerHeartbeats,
  staleWorkerNames,
  writeWorkerHeartbeat,
} from "./worker-heartbeat.js";

const execFileAsync = promisify(execFile);
const WORKERS = ["dispatcher", "runner", "supervisor", "notifier"];
const LABEL_PREFIX = "com.codex.mission-control.";
const DEFAULT_WORK_WAIT_MS = 45 * 1000;
const PIPELINE_WORK_ACTIONS = new Set([
  "start_architecture",
  "start_builder",
  "start_builder_fix",
  "return_to_builder",
  "start_review",
  "continue_review",
  "qa_integration_blocked",
  "unblock_task",
]);

function ageMs(value, nowMs) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? nowMs - parsed : Number.POSITIVE_INFINITY;
}

function workerSweepIsOverdue(heartbeats, worker, nowMs, workWaitMs) {
  const heartbeat = (heartbeats || []).find((item) => item.worker === worker);
  if (!heartbeat || heartbeat.invalid || heartbeat.status === "busy") return false;
  const lastSweep = heartbeat.lastSweepStartedAt || heartbeat.lastSweepCompletedAt;
  if (!lastSweep) return false;
  const intervalMs = Math.max(1_000, Number(heartbeat.intervalSeconds || 15) * 1000);
  return ageMs(lastSweep, nowMs) > Math.max(workWaitMs, intervalMs * 2);
}

function deferredCoordination(error) {
  if (!["STUDIOOPS_STATE_CONFLICT", "STALE_STATE_VERSION", "STUDIOOPS_MAINTENANCE"].includes(error?.code)) {
    return null;
  }
  return {
    actions: [],
    deferred: true,
    reason: error.code === "STUDIOOPS_MAINTENANCE" ? "maintenance_in_progress" : "concurrent_state_change",
  };
}

export function assessPipelineLiveness(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const workWaitMs = Math.max(15_000, Number(input.workWaitMs || DEFAULT_WORK_WAIT_MS));
  const selfUpdateExpiresAt = Date.parse(state.meta?.selfUpdateLease?.expiresAt || "");
  if (
    state.meta?.operatorPause?.active
    || diskPressureIncidentIsActive(state.meta?.diskPressureIncident)
    || (Number.isFinite(selfUpdateExpiresAt) && selfUpdateExpiresAt > nowMs)
  ) {
    return { stalled: false, reason: "automation_intentionally_paused" };
  }

  const supervisor = (input.createSupervisorReport || createSupervisorReport)(state, input);
  const eligibleActions = (supervisor.actions || []).filter((action) => {
    if (!PIPELINE_WORK_ACTIONS.has(action.type)) return false;
    const task = (state.tasks || []).find((item) => item.id === action.taskId);
    const project = (state.projects || []).find((item) => item.id === task?.projectId);
    if (!task || task.budgetPause?.runId || task.automationCircuit?.state === "open") return false;
    if (project?.automationCircuit?.state === "open") return false;
    const retryAt = Date.parse(task.retryNotBefore || "");
    return !Number.isFinite(retryAt) || retryAt <= nowMs;
  });
  const activeRuns = (state.runs || []).filter((run) => (
    run.status === "running" && !activeRunStaleReason(run, input)
  ));
  const runPlan = (input.planRunnableRuns || planRunnableRuns)(state, {
    ...input,
    limit: Math.max(1, (state.runs || []).length + 1),
  });
  if (!eligibleActions.length || activeRuns.length || runPlan.runnable.length) {
    return {
      stalled: false,
      eligibleWorkCount: eligibleActions.length,
      activeRunCount: activeRuns.length,
      runnableRunCount: runPlan.runnable.length,
    };
  }

  const action = eligibleActions.find((candidate) => {
    const task = (state.tasks || []).find((item) => item.id === candidate.taskId);
    return task && ageMs(task.updatedAt || task.createdAt, nowMs) > workWaitMs;
  });
  if (!action) {
    return {
      stalled: false,
      reason: "eligible_work_within_grace_period",
      eligibleWorkCount: eligibleActions.length,
      activeRunCount: 0,
      runnableRunCount: 0,
    };
  }

  const task = (state.tasks || []).find((item) => item.id === action.taskId);
  const queuedIds = new Set((state.runs || [])
    .filter((run) => run.taskId === task.id && run.status === "queued")
    .map((run) => run.id));
  const blockedRun = (runPlan.skipped || []).find((item) => queuedIds.has(item.runId));
  const cause = blockedRun?.reason || "no_executable_run_admitted";
  const recoveryAction = blockedRun
    ? `Inspect ${blockedRun.runId} and resolve its ${cause} blocker; then run \`npm run runner -- --plan\` to verify it is executable.`
    : "Run `npm run dispatcher -- --plan`, inspect the reported admission constraint, then run `npm run dispatcher` after correcting it.";
  return {
    stalled: true,
    fingerprint: `${task.id}:${action.type}:${cause}`,
    projectId: task.projectId,
    projectKey: action.projectKey || "",
    taskId: task.id,
    taskTitle: task.title,
    taskUrl: action.taskUrl || "",
    cause,
    recoveryAction,
    eligibleWorkCount: eligibleActions.length,
    activeRunCount: 0,
    runnableRunCount: 0,
  };
}

async function updatePipelineLiveness(state, assessment, input) {
  if (!pipelineLivenessNotificationNeedsUpdate(state, assessment)) return null;
  const update = input.reconcilePipelineLivenessNotification || reconcilePipelineLivenessNotification;
  try {
    return await update(assessment, { ...input, state: input.state });
  } catch (error) {
    const deferred = deferredCoordination(error);
    if (!deferred) throw error;
    return deferred;
  }
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
  for (const unhealthy of input.unhealthyWorkers || []) {
    if (!WORKERS.includes(unhealthy.worker) || actions.some((item) => item.worker === unhealthy.worker)) continue;
    actions.push({ type: "restart_worker", worker: unhealthy.worker, reason: unhealthy.reason });
  }
  const scheduled = new Set(actions.map((item) => item.worker));
  const workWaitMs = Math.max(15_000, Number(input.workWaitMs || DEFAULT_WORK_WAIT_MS));
  const queuedRunWaiting = (state.runs || []).some((run) => run.status === "queued" && ageMs(run.createdAt, nowMs) > workWaitMs);
  if (
    queuedRunWaiting
    && !scheduled.has("runner")
    && workerSweepIsOverdue(heartbeats, "runner", nowMs, workWaitMs)
  ) {
    actions.push({ type: "restart_worker", worker: "runner", reason: "queued_run_waiting" });
    scheduled.add("runner");
  }
  const dispatchWaiting = !state.meta?.operatorPause?.active && (state.tasks || []).some((task) => (
    ["queued", "ready", "needs_changes", "builder_review", "backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review"].includes(task.status)
    && task.automationCircuit?.state !== "open"
    && ageMs(task.updatedAt || task.createdAt, nowMs) > workWaitMs
    && !(state.runs || []).some((run) => run.taskId === task.id && ["queued", "running"].includes(run.status))
  ));
  if (
    dispatchWaiting
    && !scheduled.has("dispatcher")
    && workerSweepIsOverdue(heartbeats, "dispatcher", nowMs, workWaitMs)
  ) {
    actions.push({ type: "restart_worker", worker: "dispatcher", reason: "dispatchable_task_waiting" });
  }
  return actions;
}

export function managedWorkerHealth(heartbeats, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const staleAfterMs = Math.max(60_000, Number(input.staleAfterMs || 3 * 60 * 1000));
  const expectedDataDir = path.resolve(input.dataDir || missionControlDataDir());
  const workers = (input.workers || WORKERS).map((worker) => {
    const heartbeat = (heartbeats || []).find((item) => item.worker === worker);
    let reason = "";
    if (!heartbeat) reason = "heartbeat_missing";
    else if (heartbeat.invalid) reason = "heartbeat_invalid";
    else if (!Number.isFinite(Date.parse(heartbeat.updatedAt || ""))) reason = "heartbeat_timestamp_invalid";
    else if (nowMs - Date.parse(heartbeat.updatedAt) > staleAfterMs) reason = "heartbeat_stale";
    else if (!["idle", "busy"].includes(heartbeat.status)) reason = "worker_status_unhealthy";
    else if (path.resolve(String(heartbeat.dataDir || ".")) !== expectedDataDir) reason = "worker_data_root_mismatch";
    return {
      worker,
      ok: !reason,
      reason,
      status: String(heartbeat?.status || "missing").slice(0, 40),
      updatedAt: String(heartbeat?.updatedAt || ""),
    };
  });
  return {
    ok: workers.every((worker) => worker.ok),
    checkedAt: new Date(nowMs).toISOString(),
    workers,
  };
}

// Scheduled promotion is observable separately from managed builder workers:
// one project's invalid toolchain must not close the global automation gate.
export function promotionWorkerHealth(heartbeats, input = {}) {
  const heartbeat = (heartbeats || []).find((item) => item.worker === "promotion");
  const nowMs = Number(input.nowMs || Date.now());
  const intervalMs = Math.max(1_000, Number(heartbeat?.intervalSeconds || 300) * 1000);
  const staleAfterMs = heartbeat?.status === "busy" ? 3 * 60_000 : Math.max(3 * 60_000, intervalMs * 2);
  let reason = "";
  if (!heartbeat) reason = "heartbeat_missing";
  else if (heartbeat.invalid || !Number.isFinite(Date.parse(heartbeat.updatedAt || ""))) reason = "heartbeat_invalid";
  else if (nowMs - Date.parse(heartbeat.updatedAt) > staleAfterMs) reason = "heartbeat_stale";
  else if (Number(heartbeat.activeFailureCount || 0) > 0 || !["busy", "idle"].includes(heartbeat.status)) reason = "promotion_sweep_failed";
  else if (path.resolve(String(heartbeat.dataDir || ".")) !== path.resolve(input.dataDir || missionControlDataDir())) reason = "worker_data_root_mismatch";
  return {
    worker: "promotion",
    ok: !reason,
    reason,
    status: String(heartbeat?.status || "missing").slice(0, 40),
    updatedAt: heartbeat?.updatedAt || "",
    lastSweepCompletedAt: heartbeat?.lastSweepCompletedAt || "",
    lastSuccessAt: heartbeat?.lastSuccessAt || "",
    activeFailureCount: Number(heartbeat?.activeFailureCount || 0),
    lastFailure: heartbeat?.lastFailure ? {
      fingerprint: heartbeat.lastFailure.fingerprint,
      firstSeenAt: heartbeat.lastFailure.firstSeenAt,
      lastSeenAt: heartbeat.lastFailure.lastSeenAt,
      observations: heartbeat.lastFailure.observations,
      failureCount: heartbeat.lastFailure.failureCount,
      omittedCount: heartbeat.lastFailure.omittedCount,
      ...(heartbeat.lastFailure.resolvedAt ? { resolvedAt: heartbeat.lastFailure.resolvedAt } : {}),
      failures: (heartbeat.lastFailure.failures || []).slice(0, 50).map((failure) => ({
        projectId: failure.projectId,
        projectKey: failure.projectKey,
        candidateId: failure.candidateId,
        taskIds: failure.taskIds,
        status: failure.status,
        code: failure.code,
        reason: failure.code === "PROJECT_VALIDATION_INPUT_INVALID"
          ? "Project validation toolchain is unavailable or unsafe."
          : "Promotion could not complete; inspect the recorded local sweep failure.",
      })),
    } : null,
  };
}

async function readDiskPair(input = {}) {
  if (input.readDiskPair) return input.readDiskPair(input);
  const readDisk = input.readDiskAvailability || readDiskAvailability;
  const dataPath = path.resolve(input.dataDir || missionControlDataDir());
  const workspacePath = path.resolve(input.workspaceRoot || defaultStudioOpsWorkspaceRoot("run"));
  const [data, workspace] = await Promise.all([
    readDisk({ ...input, path: dataPath }),
    readDisk({ ...input, path: workspacePath }),
  ]);
  return { data, workspace };
}

function diskPairHealthy(pair) {
  return Boolean(pair && pair.data?.pressure !== true && pair.workspace?.pressure !== true);
}

function recoveryRemediation(cleanup, health, disksHealthy) {
  if (!disksHealthy) {
    const reasons = Object.keys(cleanup?.selection?.excludedByReason || {}).slice(0, 8).join(", ");
    return reasons
      ? `Disk remains below threshold. Cleanup exclusions: ${reasons}. Free local disk space or adjust verified retention policy.`
      : "Disk remains below threshold. Free local disk space or inspect protected and unaged workspaces.";
  }
  const unhealthy = (health.workers || []).filter((worker) => !worker.ok).map((worker) => worker.worker).join(", ");
  return unhealthy ? `Waiting for healthy managed-worker heartbeats: ${unhealthy}.` : "Waiting for recovery verification.";
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
  const nowMs = Number(input.nowMs || Date.now());
  const startedAt = new Date(nowMs).toISOString();
  const initial = input.diskPair || (input.disk
    ? { data: input.disk, workspace: input.workspaceDisk || input.disk }
    : await readDiskPair(input));
  const initialPressure = !diskPairHealthy(initial);
  const stateReader = input.readState || (() => input.state ? Promise.resolve(input.state) : readState());
  const initialState = await stateReader();
  const activeIncident = initialState.meta?.diskPressureIncident;
  const heartbeatWriter = input.writeWorkerHeartbeat || writeWorkerHeartbeat;
  await heartbeatWriter("watchdog", { status: "busy", lastSweepStartedAt: startedAt }, { ...input, disk: initial.data })
    .catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
  if (!initialPressure && !diskPressureIncidentIsActive(activeIncident)) {
    let reconciliation;
    try {
      reconciliation = await (input.automationTick || automationTick)({ ...input, limit: input.limit || 100 });
    } catch (error) {
      reconciliation = deferredCoordination(error);
      if (!reconciliation) throw error;
      if (error.code === "STUDIOOPS_MAINTENANCE") {
        await heartbeatWriter("watchdog", {
          status: "idle",
          lastError: "",
          lastSweepCompletedAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
        }, { ...input, disk: initial.data }).catch((heartbeatError) => (
          console.error(`[watchdog] heartbeat failed: ${heartbeatError.message}`)
        ));
        return { generatedAt: new Date().toISOString(), disk: initial.data, disks: initial, reconciliation, actions: [] };
      }
    }
    const [state, heartbeats] = await Promise.all([stateReader(), (input.readWorkerHeartbeats || readWorkerHeartbeats)(input)]);
    const promotionHealth = promotionWorkerHealth(heartbeats, input);
    const liveness = assessPipelineLiveness(state, input);
    const livenessNotification = await updatePipelineLiveness(state, liveness, input);
    const actions = planWatchdogActions(state, heartbeats, { ...input, disk: initial.data });
    const results = [];
    for (const action of actions) {
      try {
        results.push({ ...action, ok: true, output: await restartWorker(action.worker, input) });
      } catch (error) {
        results.push({ ...action, ok: false, output: error?.message || String(error) });
      }
    }
    await heartbeatWriter("watchdog", {
      status: "idle",
      lastError: results.filter((item) => !item.ok).map((item) => item.output).join("; "),
      lastSweepCompletedAt: new Date().toISOString(),
      lastSuccessAt: results.every((item) => item.ok) ? new Date().toISOString() : "",
      promotionHealth,
    }, { ...input, disk: initial.data }).catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
    return {
      generatedAt: new Date().toISOString(),
      disk: initial.data,
      disks: initial,
      reconciliation,
      liveness,
      livenessNotification,
      promotionHealth,
      actions: results,
    };
  }

  const openIncident = input.openDiskPressureIncident || (input.state
    ? (args) => openDiskPressureIncidentInState(input.state, args)
    : openDiskPressureIncident);
  const updateIncident = input.updateDiskPressureIncident || (input.state
    ? (args) => updateDiskPressureIncidentInState(input.state, args)
    : updateDiskPressureIncident);
  const recoverIncident = input.recoverDiskPressureIncident || (input.state
    ? (args) => recoverDiskPressureIncidentInState(input.state, args)
    : recoverDiskPressureIncident);
  let incident = initialPressure
    ? await openIncident({ ...input, nowMs, data: initial.data, workspace: initial.workspace })
    : activeIncident;
  let workspaceRetention = input.workspaceRetention;
  if (!workspaceRetention && !input.state) {
    try {
      const config = await loadConfig();
      workspaceRetention = config?.defaults?.runner?.workspaceRetention || config?.runner?.workspaceRetention;
    } catch {
      workspaceRetention = undefined;
    }
  }
  const cleanup = await (input.runWorkspaceCleanup || runWorkspaceCleanup)({
    ...input,
    state: input.state,
    workspaceRoot: input.workspaceRoot || defaultStudioOpsWorkspaceRoot("run"),
    workspaceRetention,
  });
  const postCleanup = cleanup.after || initial;
  let databaseHealth;
  let state;
  try {
    state = await stateReader();
    databaseHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      projectCount: (state.projects || []).length,
      taskCount: (state.tasks || []).length,
      runCount: (state.runs || []).length,
    };
  } catch (error) {
    state = initialState;
    databaseHealth = { ok: false, checkedAt: new Date().toISOString(), reason: "complete_state_read_failed" };
  }
  const heartbeats = await (input.readWorkerHeartbeats || readWorkerHeartbeats)(input).catch(() => []);
  const workerHealth = managedWorkerHealth(heartbeats, { ...input, nowMs });
  const final = await readDiskPair(input);
  const disksHealthy = diskPairHealthy(postCleanup) && diskPairHealthy(final);
  const health = {
    database: databaseHealth,
    workers: workerHealth,
    disksHealthy,
    diskRecovery: {
      recoveredWithoutCleanup: disksHealthy && Number(cleanup.selectedCount || 0) === 0,
      sameVolume: cleanup.sameVolume !== false,
    },
  };
  if (disksHealthy && databaseHealth.ok && workerHealth.ok) {
    const recovered = await recoverIncident({
      ...input,
      incidentId: incident.id,
      expectedGeneration: incident.generation,
      nowMs,
      data: final.data,
      workspace: final.workspace,
      cleanup,
      health,
    });
    let reconciliation;
    try {
      reconciliation = await (input.automationTick || automationTick)({ ...input, limit: input.limit || 100 });
    } catch (error) {
      reconciliation = deferredCoordination(error);
      if (!reconciliation) throw error;
    }
    await heartbeatWriter("watchdog", {
      status: "idle",
      lastError: "",
      lastSweepCompletedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
    }, { ...input, disk: final.data }).catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
    return {
      generatedAt: new Date().toISOString(),
      disk: final.data,
      disks: { initial, postCleanup, final },
      cleanup,
      incident: recovered,
      reconciliation,
      actions: [],
    };
  }

  const alreadyRestarted = new Set(incident.restartedWorkers || []);
  const unhealthyWorkers = workerHealth.workers.filter((worker) => !worker.ok && !alreadyRestarted.has(worker.worker));
  const planned = disksHealthy
    ? planWatchdogActions(state, heartbeats, { ...input, disk: final.data, unhealthyWorkers })
    : planWatchdogActions(state, heartbeats, { ...input, disk: { ...final.data, pressure: true } });
  const results = [];
  const restartAttempts = [];
  for (const action of planned) {
    if (action.type === "report_disk_pressure") {
      results.push({
        ...action,
        ok: false,
        output: `StudioOps paused automation because ${action.path} has ${action.availableBytes} bytes (${action.availablePercent}%) available.`,
      });
      continue;
    }
    restartAttempts.push(action.worker);
    try {
      results.push({ ...action, ok: true, output: await restartWorker(action.worker, input) });
    } catch (error) {
      results.push({ ...action, ok: false, output: error?.message || String(error) });
    }
  }
  incident = await updateIncident({
    ...input,
    incidentId: incident.id,
    expectedGeneration: incident.generation,
    state: databaseHealth.ok ? "awaiting_health" : "degraded",
    nowMs,
    data: final.data,
    workspace: final.workspace,
    cleanup,
    health,
    restartedWorkers: restartAttempts,
    remediation: recoveryRemediation(cleanup, workerHealth, disksHealthy),
  });
  await heartbeatWriter("watchdog", {
    status: "idle",
    lastError: results.filter((item) => !item.ok).map((item) => item.output).join("; "),
    lastSweepCompletedAt: new Date().toISOString(),
    lastSuccessAt: results.every((item) => item.ok) ? new Date().toISOString() : "",
  }, { ...input, disk: final.data }).catch((error) => console.error(`[watchdog] heartbeat failed: ${error.message}`));
  return {
    generatedAt: new Date().toISOString(),
    disk: final.data,
    disks: { initial, postCleanup, final },
    cleanup,
    incident,
    reconciliation: {
      actions: [],
      paused: true,
      reason: "disk_recovery_in_progress",
      pauseReason: "disk_recovery_in_progress",
    },
    actions: results,
  };
}
