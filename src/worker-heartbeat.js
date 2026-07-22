import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { missionControlDataDir } from "./runtime-paths.js";

const DEFAULT_HEARTBEAT_SECONDS = 30;

function heartbeatDir(input = {}) {
  return path.resolve(input.dataDir || missionControlDataDir(), "heartbeats");
}

function safeWorkerName(value) {
  const name = String(value || "worker").trim().replace(/[^a-z0-9-]+/gi, "-");
  return name || "worker";
}

export async function writeWorkerHeartbeat(worker, patch = {}, input = {}) {
  const dir = heartbeatDir(input);
  const name = safeWorkerName(worker);
  const target = path.join(dir, `${name}.json`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let current = {};
  try {
    current = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // A missing or interrupted heartbeat is replaced atomically below.
  }
  const now = new Date(Number(input.nowMs || Date.now())).toISOString();
  const heartbeat = {
    worker: name,
    pid: process.pid,
    startedAt: current.startedAt || now,
    ...current,
    ...patch,
    updatedAt: now,
  };
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return heartbeat;
}

export async function readWorkerHeartbeats(input = {}) {
  const dir = heartbeatDir(input);
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const heartbeats = [];
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    try {
      heartbeats.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
    } catch {
      heartbeats.push({ worker: file.replace(/\.json$/, ""), invalid: true, updatedAt: "" });
    }
  }
  return heartbeats;
}

export function staleWorkerNames(heartbeats, expectedWorkers, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const staleAfterMs = Math.max(60_000, Number(input.staleAfterMs || 3 * 60 * 1000));
  const byName = new Map((heartbeats || []).map((item) => [item.worker, item]));
  return (expectedWorkers || []).filter((worker) => {
    const heartbeat = byName.get(worker);
    const updatedAt = Date.parse(heartbeat?.updatedAt || "");
    return !heartbeat || heartbeat.invalid || !Number.isFinite(updatedAt) || nowMs - updatedAt > staleAfterMs;
  });
}

export async function runResilientWorkerLoop(input) {
  const worker = safeWorkerName(input.worker);
  const intervalSeconds = Math.max(1, Number(input.intervalSeconds || 300));
  const heartbeatSeconds = Math.max(5, Number(input.heartbeatSeconds || DEFAULT_HEARTBEAT_SECONDS));
  let status = "starting";
  let lastError = "";
  let lastSweepStartedAt = "";
  let lastSweepCompletedAt = "";
  let lastSuccessAt = "";

  const pulse = async () => writeWorkerHeartbeat(worker, {
    status,
    intervalSeconds,
    lastError,
    lastSweepStartedAt,
    lastSweepCompletedAt,
    lastSuccessAt,
  }, input);
  await pulse();
  const timer = setInterval(() => {
    pulse().catch((error) => console.error(`[${worker}] heartbeat failed: ${error.message}`));
  }, heartbeatSeconds * 1000);
  timer.unref();

  while (true) {
    status = "busy";
    lastSweepStartedAt = new Date().toISOString();
    await pulse();
    try {
      await input.runOnce();
      status = "idle";
      lastError = "";
      lastSuccessAt = new Date().toISOString();
    } catch (error) {
      status = "error";
      lastError = error?.stack || error?.message || String(error);
      console.error(`[${worker}] sweep failed; the worker will retry: ${error?.message || error}`);
    }
    lastSweepCompletedAt = new Date().toISOString();
    await pulse().catch((error) => console.error(`[${worker}] heartbeat failed: ${error.message}`));
    await sleep(intervalSeconds * 1000);
  }
}
