import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNTIME_ITEMS = ["src", "public", "scripts", "deploy", "package.json", "package-lock.json"];

function safeSegment(value) {
  return String(value || "runtime").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

async function sourceVersion(sourceRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, timeout: 15_000 });
    return safeSegment(stdout.trim());
  } catch {
    return safeSegment(new Date().toISOString());
  }
}

async function copyWithRetry(source, destination, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cp(source, destination, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = error?.errno === -11 || error?.code === "EAGAIN" || /Unknown system error -11/i.test(error?.message || "");
      if (!transient || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** (attempt - 1))));
    }
  }
}

async function swapCurrentLink(runtimeRoot, releasePath) {
  const currentPath = path.join(runtimeRoot, "current");
  const nextPath = path.join(runtimeRoot, `.current-${process.pid}-${Date.now()}`);
  await symlink(releasePath, nextPath, "dir");
  await rename(nextPath, currentPath).catch(async (error) => {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    await rm(currentPath, { force: true, recursive: true });
    await rename(nextPath, currentPath);
  });
}

async function pruneOldReleases(runtimeRoot, currentRelease, keep = 3) {
  const releasesRoot = path.join(runtimeRoot, "releases");
  const entries = await readdir(releasesRoot, { withFileTypes: true });
  const releases = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  const keepNames = new Set([path.basename(currentRelease), ...releases.slice(0, keep)]);
  for (const name of releases) {
    if (!keepNames.has(name)) await rm(path.join(releasesRoot, name), { recursive: true, force: true });
  }
}

export function defaultRuntimeRoot() {
  return path.join(os.homedir(), ".mission-control", "runtime");
}

export async function deployRuntime(input = {}) {
  const sourceRoot = path.resolve(input.sourceRoot || process.cwd());
  const runtimeRoot = path.resolve(input.runtimeRoot || process.env.MISSION_CONTROL_RUNTIME_ROOT || defaultRuntimeRoot());
  const version = await sourceVersion(sourceRoot);
  const releasesRoot = path.join(runtimeRoot, "releases");
  const releasePath = path.join(releasesRoot, version);
  const stagePath = path.join(releasesRoot, `.stage-${version}-${process.pid}-${Date.now()}`);
  await mkdir(releasesRoot, { recursive: true });

  let ready = false;
  try {
    const stat = await lstat(path.join(releasePath, "src", "server.js"));
    ready = stat.isFile();
  } catch {
    ready = false;
  }

  if (!ready) {
    await rm(stagePath, { recursive: true, force: true });
    await mkdir(stagePath, { recursive: true });
    for (const item of RUNTIME_ITEMS) {
      await copyWithRetry(path.join(sourceRoot, item), path.join(stagePath, item));
    }
    const npmBin = input.npmBin || process.env.MISSION_CONTROL_NPM_PATH || "npm";
    await execFileAsync(npmBin, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: stagePath,
      timeout: Number(input.installTimeoutMs || 5 * 60 * 1000),
      env: process.env,
    });
    await rename(stagePath, releasePath).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await rm(stagePath, { recursive: true, force: true });
    });
  }

  await swapCurrentLink(runtimeRoot, releasePath);
  await pruneOldReleases(runtimeRoot, releasePath, Number(input.keepReleases || 3));
  const currentPath = path.join(runtimeRoot, "current");
  return {
    sourceRoot,
    runtimeRoot,
    releasePath,
    currentPath,
    currentTarget: await readlink(currentPath),
    version,
  };
}

