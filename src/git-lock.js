import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultStudioOpsGitLockRoot } from "./runtime-paths.js";

const DEFAULT_LOCK_ROOT = defaultStudioOpsGitLockRoot();
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 750;

function expandHome(value) {
  const raw = String(value || DEFAULT_LOCK_ROOT);
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function lockPathFor(repoPath, options = {}) {
  const root = expandHome(
    options.lockRoot
      || process.env.STUDIOOPS_GIT_LOCK_ROOT
      || process.env.MISSION_CONTROL_GIT_LOCK_ROOT
      || DEFAULT_LOCK_ROOT,
  );
  const digest = createHash("sha256").update(path.resolve(repoPath)).digest("hex").slice(0, 20);
  return path.join(root, `${digest}.lock`);
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeLockOwner(lockPath, repoPath) {
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    repoPath: path.resolve(repoPath),
    acquiredAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

function ownerAgeMs(owner, nowMs) {
  const acquiredMs = Date.parse(owner?.acquiredAt || "");
  return Number.isFinite(acquiredMs) ? nowMs - acquiredMs : Infinity;
}

function ownerSummary(owner) {
  if (!owner) return "unknown owner";
  return `pid ${owner.pid || "unknown"} acquired ${owner.acquiredAt || "unknown time"}`;
}

export async function withGitRepositoryLock(repoPath, callback, options = {}) {
  if (!repoPath) return callback();

  const timeoutMs = Math.max(1, Number(options.timeoutMs || process.env.MISSION_CONTROL_GIT_LOCK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const staleMs = Math.max(1, Number(options.staleMs || process.env.MISSION_CONTROL_GIT_LOCK_STALE_MS || DEFAULT_STALE_MS));
  const pollMs = Math.max(25, Number(options.pollMs || process.env.MISSION_CONTROL_GIT_LOCK_POLL_MS || DEFAULT_POLL_MS));
  const lockPath = lockPathFor(repoPath, options);
  const startedMs = Date.now();

  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeLockOwner(lockPath, repoPath);
      try {
        return await callback();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const nowMs = Date.now();
      const owner = await readLockOwner(lockPath);
      if (ownerAgeMs(owner, nowMs) > staleMs) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (nowMs - startedMs > timeoutMs) {
        throw new Error(`Timed out waiting for Git repository lock for ${path.resolve(repoPath)} (${ownerSummary(owner)}).`);
      }

      await sleep(pollMs);
    }
  }
}
