#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultRuntimeRoot,
  deployRuntime,
  planSourceRemoteMigration,
  sourceCheckoutSafetyError,
} from "../src/runtime-install.js";
import {
  acquireStudioOpsMaintenanceLease,
  migrateLegacyStudioOpsHome,
  migrateLocalStudioOpsState,
  releaseStudioOpsMaintenanceLease,
} from "../src/local-state-migration.js";
import {
  defaultStudioOpsCredentialsRoot,
  defaultStudioOpsSourceRoot,
  defaultStudioOpsWorkingRoot,
  expandLocalPath,
  studioOpsHome,
} from "../src/runtime-paths.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const workingRoot = path.resolve(
  expandLocalPath(
    process.env.STUDIOOPS_WORKING_ROOT
      || process.env.MISSION_CONTROL_WORKING_ROOT
      || defaultStudioOpsWorkingRoot(),
  ),
);
const templateDir = path.join(repoRoot, "deploy", "local");
const launchAgentDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logDir = path.join(workingRoot, "data", "launch-agents");
const uid = String(process.getuid?.() || "");
const defaultHost = process.env.STUDIOOPS_HOST || process.env.MISSION_CONTROL_HOST || "127.0.0.1";
const defaultPort = process.env.STUDIOOPS_PORT || process.env.MISSION_CONTROL_PORT || "4317";
const runtimeRoot = process.env.STUDIOOPS_RUNTIME_ROOT || process.env.MISSION_CONTROL_RUNTIME_ROOT || defaultRuntimeRoot();
const sourceRoot = path.resolve(
  expandLocalPath(
    process.env.STUDIOOPS_SOURCE_ROOT
      || process.env.MISSION_CONTROL_SOURCE_ROOT
      || defaultStudioOpsSourceRoot(),
  ),
);
const sourceBranch = process.env.STUDIOOPS_SOURCE_BRANCH || process.env.MISSION_CONTROL_SOURCE_BRANCH || "main";

function usage() {
  console.log(`StudioOps LaunchAgent installer

Usage:
  npm run install-agents
  npm run uninstall-agents
  npm run status-agents

Optional environment:
  STUDIOOPS_HOME=~/.codex/studioops  Local-only root for all StudioOps operational state
  STUDIOOPS_HOST=0.0.0.0        Bind web UI to the local network
  STUDIOOPS_PORT=4317           Web UI port
  STUDIOOPS_WORKING_ROOT=...    Persistent config and SQLite state root
  STUDIOOPS_MIGRATE_FROM=...    Legacy working root to migrate after active runs finish
  STUDIOOPS_LEGACY_HOME=...     Legacy operational workspace root; defaults to ~/.mission-control
  STUDIOOPS_RUNTIME_ROOT=...    Immutable installed runtime root
  STUDIOOPS_SOURCE_ROOT=...     Clean main checkout used by self-update
  MISSION_CONTROL_HOST=0.0.0.0   Bind web UI to the local network
  MISSION_CONTROL_PORT=4317      Web UI port
  MISSION_CONTROL_NODE_PATH=...  Stable Node.js binary for every LaunchAgent
  MISSION_CONTROL_RUNTIME_ROOT=...  Legacy alias for STUDIOOPS_RUNTIME_ROOT
  MISSION_CONTROL_WORKING_ROOT=... Use a separate source/config/data checkout
  MISSION_CONTROL_SOURCE_ROOT=... Legacy alias for STUDIOOPS_SOURCE_ROOT
`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkingRoot() {
  await mkdir(studioOpsHome(), { recursive: true, mode: 0o700 });
  await chmod(studioOpsHome(), 0o700).catch(() => {});
  await mkdir(workingRoot, { recursive: true, mode: 0o700 });
  await chmod(workingRoot, 0o700).catch(() => {});
  if (workingRoot === repoRoot) return;

  const configNames = ["studioops.config.md", "mission-control.config.md"];
  for (const name of configNames) {
    if (await pathExists(path.join(workingRoot, name))) return;
  }
  for (const name of configNames) {
    const source = path.join(repoRoot, name);
    if (!(await pathExists(source))) continue;
    const destination = path.join(workingRoot, name);
    await copyFile(source, destination);
    await chmod(destination, 0o600).catch(() => {});
    console.log(`Copied local StudioOps configuration to ${destination}.`);
    return;
  }
  throw new Error(
    `No StudioOps configuration found. Run \`studioops setup\` in ${repoRoot} before installing agents, or place studioops.config.md in ${workingRoot}.`,
  );
}

async function installedWorkingRoot() {
  const webPlist = targetPathForLabel("com.codex.mission-control.web");
  if (!(await pathExists(webPlist))) return "";
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", "WorkingDirectory", "raw", "-o", "-", webPlist],
      { timeout: 10_000 },
    );
    return path.resolve(String(stdout || "").trim());
  } catch {
    return "";
  }
}

async function rootHasLocalState(root) {
  if (!root) return false;
  for (const candidate of [
    path.join(root, "data", "mission-control.sqlite3"),
    path.join(root, "studioops.config.md"),
    path.join(root, "mission-control.config.md"),
  ]) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

async function snapshotLaunchAgentFiles(templateList) {
  const snapshots = new Map();
  for (const template of templateList) {
    const target = targetPathForLabel(template.label);
    snapshots.set(target, (await pathExists(target)) ? await readFile(target, "utf8") : null);
  }
  return snapshots;
}

async function restoreLaunchAgentFiles(snapshots) {
  for (const [target, contents] of snapshots) {
    if (contents === null) await rm(target, { force: true });
    else await writeFile(target, contents, "utf8");
  }
}

function ensureMac() {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent installation is only supported on macOS. Use npm run dispatcher/runner/notifier manually on other systems.");
  }
}

function labelFromTemplate(fileName) {
  return fileName.replace(/\.plist\.example$/, "");
}

function targetPathForLabel(label) {
  return path.join(launchAgentDir, `${label}.plist`);
}

async function launchctl(args, options = {}) {
  try {
    const result = await execFileAsync("launchctl", args, { timeout: 15_000 });
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    if (options.ignoreErrors) return `${error.stdout || ""}${error.stderr || error.message}`.trim();
    throw error;
  }
}

async function templates() {
  const files = await readdir(templateDir);
  return files
    .filter((file) => file.endsWith(".plist.example"))
    .sort()
    .map((file) => ({
      file,
      label: labelFromTemplate(file),
      source: path.join(templateDir, file),
    }));
}

async function nodeCandidates() {
  const candidates = [
    process.execPath,
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const root of [
    path.join(os.homedir(), ".nvm", "versions", "node"),
    path.join(os.homedir(), "Library", "Application Support", "Herd", "config", "nvm", "versions", "node"),
  ]) {
    try {
      for (const version of await readdir(root)) candidates.push(path.join(root, version, "bin", "node"));
    } catch {
      // Optional Node managers are not required.
    }
  }
  return [...new Set(candidates)];
}

async function resolveNodePath() {
  const configured = process.env.STUDIOOPS_NODE_PATH || process.env.MISSION_CONTROL_NODE_PATH;
  if (configured) return path.resolve(configured);
  const supported = [];
  for (const candidate of await nodeCandidates()) {
    try {
      await access(candidate);
      const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      const match = String(stdout).trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;
      const major = Number(match[1]);
      if (major >= 22) supported.push({ candidate, major, minor: Number(match[2]), patch: Number(match[3]) });
    } catch {
      // Ignore invalid candidates and continue looking for a stable runtime.
    }
  }
  supported.sort((left, right) => {
    const leftLts = left.major % 2 === 0 ? 1 : 0;
    const rightLts = right.major % 2 === 0 ? 1 : 0;
    return rightLts - leftLts || right.major - left.major || right.minor - left.minor || right.patch - left.patch;
  });
  if (!supported.length) throw new Error("StudioOps requires Node.js 22.5 or newer.");
  return supported[0].candidate;
}

async function ensureSourceCheckout() {
  if (sourceRoot === repoRoot) return sourceRoot;
  const { stdout: originOutput } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    timeout: 15_000,
  });
  const desiredOrigin = originOutput.trim();
  const gitMarker = path.join(sourceRoot, ".git");
  try {
    await access(gitMarker);
  } catch {
    // Create the canonical checkout below.
    try {
      await access(sourceRoot);
      throw new Error(`StudioOps source root exists but is not a Git checkout: ${sourceRoot}`);
    } catch (error) {
      if (!String(error?.message || "").includes("ENOENT") && error?.code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(sourceRoot), { recursive: true, mode: 0o700 });
    await execFileAsync("git", ["clone", "--no-tags", "--branch", sourceBranch, desiredOrigin, sourceRoot], {
      timeout: 5 * 60_000,
    });
    return sourceRoot;
  }

  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
    timeout: 15_000,
  });
  const { stdout: branchOutput } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: sourceRoot,
    timeout: 15_000,
  }).catch(() => ({ stdout: "" }));
  const currentBranch = branchOutput.trim();
  const initialSafetyError = sourceCheckoutSafetyError({ statusOutput, currentBranch, sourceBranch });
  if (initialSafetyError) throw new Error(`StudioOps source checkout ${initialSafetyError}: ${sourceRoot}`);

  const { stdout: existingOriginOutput } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: sourceRoot,
    timeout: 15_000,
  });
  const existingOrigin = existingOriginOutput.trim();
  const migration = planSourceRemoteMigration(existingOrigin, desiredOrigin);
  if (migration.action === "reject") {
    throw new Error(`StudioOps source checkout uses an unrelated origin and will not be rewritten: ${sourceRoot}`);
  }

  if (migration.action === "migrate") {
    await execFileAsync("git", ["remote", "set-url", "origin", desiredOrigin], {
      cwd: sourceRoot,
      timeout: 15_000,
    });
  }

  try {
    await execFileAsync("git", ["fetch", "--no-tags", "origin", sourceBranch], {
      cwd: sourceRoot,
      timeout: 5 * 60_000,
    });
    const { stdout: divergenceOutput } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...origin/${sourceBranch}`],
      { cwd: sourceRoot, timeout: 15_000 },
    );
    const [ahead, behind] = divergenceOutput.trim().split(/\s+/).map(Number);
    const divergenceError = sourceCheckoutSafetyError({ currentBranch, sourceBranch, ahead });
    if (divergenceError) throw new Error(`StudioOps source checkout ${divergenceError}: ${sourceRoot}`);
    if (behind > 0) {
      await execFileAsync("git", ["merge", "--ff-only", `origin/${sourceBranch}`], {
        cwd: sourceRoot,
        timeout: 60_000,
      });
    }
  } catch (error) {
    if (migration.action === "migrate") {
      await execFileAsync("git", ["remote", "set-url", "origin", existingOrigin], {
        cwd: sourceRoot,
        timeout: 15_000,
      }).catch(() => {});
    }
    throw error;
  }

  if (migration.action === "migrate") {
    console.log(`Migrated StudioOps self-update source from ${migration.existing} to ${migration.desired}.`);
  }
  return sourceRoot;
}

function renderTemplate(raw, runtime, canonicalSourceRoot, nodePath) {
  return raw
    .replaceAll("__NODE_PATH__", nodePath)
    .replaceAll("__MISSION_CONTROL_REPO__", workingRoot)
    .replaceAll("__MISSION_CONTROL_RUNTIME__", runtime.currentPath)
    .replaceAll("__MISSION_CONTROL_SOURCE_REPO__", canonicalSourceRoot)
    .replaceAll("__LOG_DIR__", logDir)
    .replaceAll("__HOST__", defaultHost)
    .replaceAll("__PORT__", defaultPort);
}

async function install() {
  ensureMac();
  const nodePath = await resolveNodePath();
  await access(nodePath);
  await mkdir(launchAgentDir, { recursive: true });
  const templateList = await templates();
  const previousWorkingRoot = await installedWorkingRoot();
  const explicitMigrationRoot = expandLocalPath(process.env.STUDIOOPS_MIGRATE_FROM || "");
  const repoHasState = await rootHasLocalState(repoRoot);
  const migrationRoot = explicitMigrationRoot
    ? path.resolve(explicitMigrationRoot)
    : previousWorkingRoot || (repoHasState ? repoRoot : "");
  const maintenanceId = `local_root_install_${process.pid}_${Date.now()}`;
  const maintenanceRoots = [...new Set([migrationRoot, workingRoot].filter(Boolean).map((item) => path.resolve(item)))];
  const installed = [];
  let previousPlists = null;
  let agentsStopped = false;
  let maintenanceReleased = false;

  const releaseMaintenance = async () => {
    if (maintenanceReleased) return;
    for (const root of [...new Set([...maintenanceRoots, workingRoot])]) {
      await releaseStudioOpsMaintenanceLease(root, maintenanceId).catch(() => {});
    }
    maintenanceReleased = true;
  };

  try {
    for (const root of maintenanceRoots) {
      await acquireStudioOpsMaintenanceLease(root, { id: maintenanceId });
    }
    const canonicalSourceRoot = await ensureSourceCheckout();
    const runtime = await deployRuntime({ sourceRoot: repoRoot, runtimeRoot });
    previousPlists = await snapshotLaunchAgentFiles(templateList);
    for (const template of templateList) {
      await launchctl(["bootout", `gui/${uid}`, targetPathForLabel(template.label)], { ignoreErrors: true });
    }
    agentsStopped = true;

    const legacyHome = path.resolve(expandLocalPath(
      process.env.STUDIOOPS_LEGACY_HOME || path.join(os.homedir(), ".mission-control"),
    ));
    const homeMigration = await migrateLegacyStudioOpsHome({
      sourceHome: legacyHome,
      targetHome: studioOpsHome(),
    });
    if (homeMigration.copied.length) {
      console.log(`Migrated legacy StudioOps workspace directories: ${homeMigration.copied.join(", ")}.`);
    }
    let migration = null;
    if (migrationRoot && path.resolve(migrationRoot) !== workingRoot) {
      migration = await migrateLocalStudioOpsState({
        sourceRoot: migrationRoot,
        targetRoot: workingRoot,
        credentialsRoot: defaultStudioOpsCredentialsRoot(),
      });
      console.log(`Migrated StudioOps working state from ${migrationRoot} to ${workingRoot}.`);
      if (migration.backupPath) console.log(`Migration backup: ${migration.backupPath}`);
    }
    await ensureWorkingRoot();
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await chmod(logDir, 0o700).catch(() => {});
    for (const template of templateList) {
      const target = targetPathForLabel(template.label);
      const rendered = renderTemplate(await readFile(template.source, "utf8"), runtime, canonicalSourceRoot, nodePath);
      await writeFile(target, rendered, "utf8");
    }
    await releaseMaintenance();
    for (const template of templateList) {
      const target = targetPathForLabel(template.label);
      await launchctl(["bootstrap", `gui/${uid}`, target]);
      await launchctl(["enable", `gui/${uid}/${template.label}`], { ignoreErrors: true });
      installed.push(template.label);
    }
  } catch (error) {
    if (agentsStopped && previousPlists) {
      for (const template of templateList) {
        await launchctl(["bootout", `gui/${uid}`, targetPathForLabel(template.label)], { ignoreErrors: true });
      }
      await restoreLaunchAgentFiles(previousPlists);
    }
    await releaseMaintenance();
    if (agentsStopped && previousPlists) {
      for (const template of templateList) {
        const target = targetPathForLabel(template.label);
        if (previousPlists.get(target) === null) continue;
        await launchctl(["bootstrap", `gui/${uid}`, target], { ignoreErrors: true });
        await launchctl(["enable", `gui/${uid}/${template.label}`], { ignoreErrors: true });
      }
    }
    throw error;
  } finally {
    await releaseMaintenance();
  }

  console.log(`Installed ${installed.length} StudioOps LaunchAgents:`);
  for (const label of installed) console.log(`- ${label}`);
  console.log(`Logs: ${logDir}`);
  console.log(`Runtime: ${runtimeRoot}`);
  console.log(`Node: ${nodePath}`);
  console.log(`Self-update source: ${sourceRoot}`);
}

async function uninstall() {
  ensureMac();
  const removed = [];
  for (const template of await templates()) {
    const target = targetPathForLabel(template.label);
    await launchctl(["bootout", `gui/${uid}`, target], { ignoreErrors: true });
    await rm(target, { force: true });
    removed.push(template.label);
  }
  console.log(`Removed ${removed.length} StudioOps LaunchAgents:`);
  for (const label of removed) console.log(`- ${label}`);
}

async function status() {
  ensureMac();
  const output = await launchctl(["list"]);
  const labels = (await templates()).map((template) => template.label);
  for (const label of labels) {
    const line = output.split("\n").find((item) => item.includes(label));
    console.log(line || `-       -       ${label} (not loaded)`);
  }
}

async function main() {
  const command = process.argv[2] || "install";
  if (command === "--help" || command === "help") {
    usage();
    return;
  }
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command === "status") return status();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
