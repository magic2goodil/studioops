import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { extractConfigJson, renderConfigMarkdown } from "./config.js";

const DATABASE_NAME = "mission-control.sqlite3";
const DATABASE_SIDECARS = new Set([
  DATABASE_NAME,
  `${DATABASE_NAME}-wal`,
  `${DATABASE_NAME}-shm`,
]);
const CONFIG_NAMES = ["studioops.config.md", "mission-control.config.md"];
const LEGACY_OPERATIONAL_DIRECTORIES = [
  "dev-workspaces",
  "git-ref-backups",
  "local-qa",
  "local-routing",
  "local-state",
  "locks",
  "promotion-workspaces",
  "qa-workspaces",
  "run-workspaces",
  "workspaces",
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function openReadOnlyDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

export async function activeStudioOpsRuns(workingRoot) {
  const databasePath = path.join(path.resolve(workingRoot), "data", DATABASE_NAME);
  if (!(await exists(databasePath))) return [];
  const db = openReadOnlyDatabase(databasePath);
  try {
    const runsTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    ).get();
    if (!runsTable) return [];
    return db.prepare(
      "SELECT id, task_id AS taskId, project_id AS projectId, role, status, updated_at AS updatedAt FROM runs WHERE status = 'running' ORDER BY sequence",
    ).all();
  } finally {
    db.close();
  }
}

export async function assertNoActiveStudioOpsRuns(workingRoots) {
  for (const root of [...new Set(workingRoots.filter(Boolean).map((item) => path.resolve(item)))]) {
    const runs = await activeStudioOpsRuns(root);
    if (!runs.length) continue;
    const summary = runs.map((run) => `${run.id} (${run.role || "worker"}, task ${run.taskId || "unknown"})`).join(", ");
    throw new Error(`Refusing to restart StudioOps while active runs exist in ${root}: ${summary}`);
  }
}

function currentLease(meta, nowMs = Date.now()) {
  const lease = meta?.selfUpdateLease;
  const expiresAt = Date.parse(lease?.expiresAt || "");
  return lease && Number.isFinite(expiresAt) && expiresAt > nowMs ? lease : null;
}

export async function acquireStudioOpsMaintenanceLease(workingRoot, input = {}) {
  const root = path.resolve(workingRoot);
  const databasePath = path.join(root, "data", DATABASE_NAME);
  if (!(await exists(databasePath))) return null;
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const runs = db.prepare(
      "SELECT id, task_id AS taskId, role FROM runs WHERE status = 'running' ORDER BY sequence",
    ).all();
    if (runs.length) {
      const summary = runs.map((run) => `${run.id} (${run.role || "worker"}, task ${run.taskId || "unknown"})`).join(", ");
      throw new Error(`Refusing to restart StudioOps while active runs exist in ${root}: ${summary}`);
    }
    const row = db.prepare("SELECT payload, version FROM state_meta WHERE singleton_id = 1").get();
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const meta = JSON.parse(row.payload || "{}");
    const activeLease = currentLease(meta, input.nowMs);
    if (activeLease) {
      throw new Error(`StudioOps maintenance is already in progress until ${activeLease.expiresAt}.`);
    }
    const nowMs = Number(input.nowMs || Date.now());
    const lease = {
      id: String(input.id || `local_root_migration_${process.pid}_${randomUUID()}`),
      ownerPid: String(process.pid),
      repoPath: root,
      branch: "",
      remoteRef: "",
      startedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + Number(input.durationMs || 2 * 60 * 60 * 1000)).toISOString(),
      reason: "StudioOps local-root installation and migration",
    };
    meta.selfUpdateLease = lease;
    db.prepare(
      "UPDATE state_meta SET payload = ?, version = ?, updated_at = ? WHERE singleton_id = 1",
    ).run(JSON.stringify(meta), Number(row.version || 0) + 1, lease.startedAt);
    db.exec("COMMIT");
    return { root, databasePath, lease };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export async function releaseStudioOpsMaintenanceLease(workingRoot, leaseId) {
  const root = path.resolve(workingRoot);
  const databasePath = path.join(root, "data", DATABASE_NAME);
  if (!leaseId || !(await exists(databasePath))) return false;
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT payload, version FROM state_meta WHERE singleton_id = 1").get();
    if (!row) {
      db.exec("COMMIT");
      return false;
    }
    const meta = JSON.parse(row.payload || "{}");
    if (meta.selfUpdateLease?.id !== leaseId) {
      db.exec("COMMIT");
      return false;
    }
    delete meta.selfUpdateLease;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE state_meta SET payload = ?, version = ?, updated_at = ? WHERE singleton_id = 1",
    ).run(JSON.stringify(meta), Number(row.version || 0) + 1, now);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function secureTree(root) {
  if (!(await exists(root))) return;
  await chmod(root, 0o700).catch(() => {});
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await secureTree(entryPath);
    else await chmod(entryPath, 0o600).catch(() => {});
  }
}

async function secureDirectoryTree(root) {
  if (!(await exists(root))) return;
  await chmod(root, 0o700).catch(() => {});
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await secureDirectoryTree(path.join(root, entry.name));
  }
}

async function copyConfig(sourceRoot, targetRoot) {
  for (const name of CONFIG_NAMES) {
    const destination = path.join(targetRoot, name);
    if (await exists(destination)) return destination;
  }
  for (const name of CONFIG_NAMES) {
    const source = path.join(sourceRoot, name);
    if (!(await exists(source))) continue;
    const destination = path.join(targetRoot, name);
    await copyFile(source, destination);
    await chmod(destination, 0o600).catch(() => {});
    return destination;
  }
  return "";
}

function replacePathPrefix(value, mappings) {
  const raw = String(value || "");
  for (const mapping of mappings) {
    if (!mapping.from) continue;
    if (raw === mapping.from) return mapping.to;
    if (raw.startsWith(`${mapping.from}${path.sep}`)) {
      return path.join(mapping.to, raw.slice(mapping.from.length + 1));
    }
  }
  return raw;
}

function rewriteConfigValue(value, mappings, credentialsRoot) {
  if (Array.isArray(value)) return value.map((item) => rewriteConfigValue(item, mappings, credentialsRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteConfigValue(item, mappings, credentialsRoot)]),
    );
  }
  if (typeof value !== "string") return value;
  if ([".mission-control/github-apps", "~/.mission-control/github-apps"].includes(value)) {
    return credentialsRoot;
  }
  return replacePathPrefix(value, mappings);
}

async function migrateConfigPaths(input) {
  if (!input.configPath) return "";
  try {
    const config = extractConfigJson(await readFile(input.configPath, "utf8"));
    const mappings = [
      { from: input.sourceRoot, to: input.targetRoot },
      { from: input.legacyHome, to: input.studioHome },
      { from: "~/.mission-control", to: input.studioHome },
    ];
    const migrated = rewriteConfigValue(config, mappings, input.credentialsRoot);
    const destination = path.join(input.targetRoot, "studioops.config.md");
    await writeFile(destination, renderConfigMarkdown(migrated), { encoding: "utf8", mode: 0o600 });
    await chmod(destination, 0o600).catch(() => {});
    return destination;
  } catch {
    return input.configPath;
  }
}

async function copyDataExceptDatabase(sourceRoot, targetRoot) {
  const sourceData = path.join(sourceRoot, "data");
  const targetData = path.join(targetRoot, "data");
  if (!(await exists(sourceData))) return;
  await mkdir(targetData, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sourceData, { withFileTypes: true })) {
    if (DATABASE_SIDECARS.has(entry.name)) continue;
    await cp(path.join(sourceData, entry.name), path.join(targetData, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}

async function migrateCredentials(sourceRoot, credentialsRoot) {
  const candidates = [
    path.join(sourceRoot, "credentials", "github-apps"),
    path.join(sourceRoot, ".mission-control", "github-apps"),
  ];
  let source = "";
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    source = candidate;
    break;
  }
  if (!source) return "";
  if (await exists(credentialsRoot)) {
    const entries = await readdir(credentialsRoot);
    if (entries.length) return credentialsRoot;
  }
  await mkdir(path.dirname(credentialsRoot), { recursive: true, mode: 0o700 });
  await cp(source, credentialsRoot, { recursive: true, force: false, errorOnExist: false });
  await secureTree(credentialsRoot);
  return credentialsRoot;
}

export async function migrateLocalStudioOpsState(input) {
  const sourceRoot = path.resolve(input.sourceRoot);
  const targetRoot = path.resolve(input.targetRoot);
  const credentialsRoot = path.resolve(input.credentialsRoot);
  if (sourceRoot === targetRoot) {
    return { status: "already_local", sourceRoot, targetRoot, credentialsRoot };
  }

  const sourceDatabase = path.join(sourceRoot, "data", DATABASE_NAME);
  const targetData = path.join(targetRoot, "data");
  const targetDatabase = path.join(targetData, DATABASE_NAME);
  if (await exists(targetDatabase)) {
    throw new Error(`Refusing to overwrite an existing StudioOps database at ${targetDatabase}.`);
  }

  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(targetRoot, 0o700).catch(() => {});
  const copiedConfigPath = await copyConfig(sourceRoot, targetRoot);
  await copyDataExceptDatabase(sourceRoot, targetRoot);

  let backupPath = "";
  if (await exists(sourceDatabase)) {
    const backupDir = path.join(targetData, "backups");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupDir, `pre-local-root-migration-${timestamp}-${process.pid}.sqlite3`);
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const db = openReadOnlyDatabase(sourceDatabase);
    try {
      await backup(db, backupPath);
    } finally {
      db.close();
    }
    await chmod(backupPath, 0o600);
    await copyFile(backupPath, targetDatabase);
    await chmod(targetDatabase, 0o600);
    await rm(`${targetDatabase}-wal`, { force: true });
    await rm(`${targetDatabase}-shm`, { force: true });
  }

  const migratedCredentials = await migrateCredentials(sourceRoot, credentialsRoot);
  const configPath = await migrateConfigPaths({
    configPath: copiedConfigPath,
    sourceRoot,
    targetRoot,
    legacyHome: path.resolve(input.legacyHome || path.join(path.dirname(credentialsRoot), "..", "..", "..", ".mission-control")),
    studioHome: path.resolve(input.studioHome || path.join(targetRoot, "..")),
    credentialsRoot,
  });
  await secureTree(targetData);
  return {
    status: "migrated",
    sourceRoot,
    targetRoot,
    databasePath: (await exists(targetDatabase)) ? targetDatabase : "",
    backupPath,
    configPath,
    credentialsRoot: migratedCredentials,
  };
}

export async function migrateLegacyStudioOpsHome(input) {
  const sourceHome = path.resolve(input.sourceHome);
  const targetHome = path.resolve(input.targetHome);
  if (sourceHome === targetHome || !(await exists(sourceHome))) {
    return { status: "not_needed", sourceHome, targetHome, copied: [] };
  }
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  await chmod(targetHome, 0o700).catch(() => {});
  const copied = [];
  for (const name of LEGACY_OPERATIONAL_DIRECTORIES) {
    const source = path.join(sourceHome, name);
    const destination = path.join(targetHome, name);
    if (!(await exists(source)) || await exists(destination)) continue;
    await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
    await secureDirectoryTree(destination);
    copied.push(name);
  }
  return { status: copied.length ? "migrated" : "not_needed", sourceHome, targetHome, copied };
}
