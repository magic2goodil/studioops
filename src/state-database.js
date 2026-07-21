import { backup, DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./config.js";
import { missionControlDataDir, missionControlRoot } from "./runtime-paths.js";

const ENTITY_TABLES = ["projects", "tasks", "comments", "reviews", "events", "runs", "qaBundles"];
const TABLE_NAME = { qaBundles: "qa_bundles" };
const MUTABLE_ENTITY_TABLES = new Set(["projects", "tasks", "runs", "qaBundles"]);
const DATA_DIR = missionControlDataDir();
export const DATABASE_FILE = path.join(DATA_DIR, "mission-control.sqlite3");
export const LEGACY_DATA_FILE = path.join(DATA_DIR, "mission-control.json");

let database = null;

async function secureStoragePaths() {
  await chmod(DATA_DIR, 0o700).catch(() => {});
  for (const filePath of [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, LEGACY_DATA_FILE]) {
    await chmod(filePath, 0o600).catch(() => {});
  }
}

function openDatabase() {
  if (database) return database;
  database = new DatabaseSync(DATABASE_FILE);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 10000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      payload TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      key TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      assigned_role TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_bundles (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      integration_commit TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_comments_task_created ON comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_task_created ON reviews(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_runs_task_status ON runs(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_qa_bundles_project_status ON qa_bundles(project_id, status, updated_at);
  `);
  return database;
}

function parsePayload(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readStateFromOpenDatabase(db) {
  const metaRow = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
  if (!metaRow) return null;
  const state = { meta: parsePayload(metaRow.payload, {}) };
  for (const table of ENTITY_TABLES) {
    const tableName = TABLE_NAME[table] || table;
    state[table] = db.prepare(`SELECT payload FROM ${tableName} ORDER BY sequence ASC`)
      .all()
      .map((row) => parsePayload(row.payload, {}));
  }
  return state;
}

function upsertEntity(db, table, item, sequence) {
  const payload = JSON.stringify(item);
  if (table === "projects") {
    db.prepare(`
      INSERT INTO projects(id, sequence, key, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, key = excluded.key, payload = excluded.payload
    `)
      .run(item.id, sequence, item.key || "", payload);
    return;
  }
  if (table === "tasks") {
    db.prepare(`
      INSERT INTO tasks(id, sequence, project_id, status, assigned_role, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        status = excluded.status, assigned_role = excluded.assigned_role, updated_at = excluded.updated_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.projectId || "", item.status || "", item.assignedAgentRole || "", item.updatedAt || "", payload);
    return;
  }
  if (table === "comments") {
    db.prepare(`
      INSERT INTO comments(id, sequence, task_id, created_at, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, task_id = excluded.task_id, created_at = excluded.created_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.taskId || "", item.createdAt || "", payload);
    return;
  }
  if (table === "reviews") {
    db.prepare(`
      INSERT INTO reviews(id, sequence, task_id, outcome, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, task_id = excluded.task_id,
        outcome = excluded.outcome, created_at = excluded.created_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.taskId || "", item.outcome || "", item.createdAt || "", payload);
    return;
  }
  if (table === "events") {
    db.prepare(`
      INSERT INTO events(id, sequence, project_id, task_id, type, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        task_id = excluded.task_id, type = excluded.type, created_at = excluded.created_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.projectId || "", item.taskId || "", item.type || "", item.createdAt || "", payload);
    return;
  }
  if (table === "runs") {
    db.prepare(`
      INSERT INTO runs(id, sequence, project_id, task_id, status, role, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        task_id = excluded.task_id, status = excluded.status, role = excluded.role, updated_at = excluded.updated_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.projectId || "", item.taskId || "", item.status || "", item.role || "", item.updatedAt || "", payload);
    return;
  }
  db.prepare(`
    INSERT INTO qa_bundles(id, sequence, project_id, status, integration_commit, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
      status = excluded.status, integration_commit = excluded.integration_commit, updated_at = excluded.updated_at, payload = excluded.payload
  `)
    .run(item.id, sequence, item.projectId || "", item.status || "", item.integrationCommit || "", item.updatedAt || "", payload);
}

function writeStateToOpenDatabase(db, state) {
  const previous = db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get();
  const version = Number(previous?.version || 0) + 1;
  const updatedAt = state.meta?.updatedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO state_meta(singleton_id, payload, version, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET
      payload = excluded.payload,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(state.meta || {}), version, updatedAt);
  for (const table of ENTITY_TABLES) {
    db.exec(`DELETE FROM ${TABLE_NAME[table] || table}`);
    for (const [sequence, item] of (state[table] || []).entries()) {
      upsertEntity(db, table, item, sequence);
    }
  }
}

function mutationSnapshot(state) {
  const snapshot = { meta: JSON.stringify(state.meta || {}), tables: {} };
  for (const table of ENTITY_TABLES) {
    snapshot.tables[table] = new Map();
    for (const [sequence, item] of (state[table] || []).entries()) {
      snapshot.tables[table].set(item.id, {
        sequence,
        payload: MUTABLE_ENTITY_TABLES.has(table) ? JSON.stringify(item) : "",
      });
      if (!MUTABLE_ENTITY_TABLES.has(table)) Object.freeze(item);
    }
  }
  return snapshot;
}

function writeMutationToOpenDatabase(db, state, snapshot) {
  const previous = db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get();
  const version = Number(previous?.version || 0) + 1;
  const updatedAt = state.meta?.updatedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO state_meta(singleton_id, payload, version, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET
      payload = excluded.payload,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(state.meta || {}), version, updatedAt);

  for (const table of ENTITY_TABLES) {
    const previousItems = snapshot.tables[table];
    const currentIds = new Set();
    for (const [sequence, item] of (state[table] || []).entries()) {
      currentIds.add(item.id);
      const prior = previousItems.get(item.id);
      const changed = !prior
        || prior.sequence !== sequence
        || (MUTABLE_ENTITY_TABLES.has(table) && prior.payload !== JSON.stringify(item));
      if (changed) upsertEntity(db, table, item, sequence);
    }
    const tableName = TABLE_NAME[table] || table;
    for (const id of previousItems.keys()) {
      if (!currentIds.has(id)) db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
    }
  }
}

async function initialState() {
  const candidates = [
    LEGACY_DATA_FILE,
    path.join(missionControlRoot(), "data", "mission-control.example.json"),
  ];
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    return JSON.parse(await readFile(candidate, "utf8"));
  }
  return { meta: {}, projects: [], tasks: [], comments: [], reviews: [], events: [], runs: [], qaBundles: [] };
}

export async function ensureStateDatabase() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await secureStoragePaths();
  const db = openDatabase();
  if (!readStateFromOpenDatabase(db)) {
    const state = await initialState();
    state.meta = {
      ...(state.meta || {}),
      storageBackend: "sqlite",
      migratedAt: new Date().toISOString(),
      migratedFrom: await fileExists(LEGACY_DATA_FILE) ? LEGACY_DATA_FILE : "fresh",
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!readStateFromOpenDatabase(db)) writeStateToOpenDatabase(db, state);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  await secureStoragePaths();
  return db;
}

export async function readDatabaseState() {
  const db = await ensureStateDatabase();
  return readStateFromOpenDatabase(db);
}

export async function writeDatabaseState(state) {
  const db = await ensureStateDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    writeStateToOpenDatabase(db, state);
    db.exec("COMMIT");
    await secureStoragePaths();
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function mutateDatabaseState(mutator) {
  const db = await ensureStateDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = readStateFromOpenDatabase(db);
    const snapshot = mutationSnapshot(state);
    const result = await mutator(state);
    state.meta = state.meta || {};
    state.meta.updatedAt = new Date().toISOString();
    state.meta.storageBackend = "sqlite";
    writeMutationToOpenDatabase(db, state, snapshot);
    db.exec("COMMIT");
    await secureStoragePaths();
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function backupStateDatabase(destination = "") {
  const db = await ensureStateDatabase();
  const backupDir = path.join(DATA_DIR, "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.resolve(destination || path.join(backupDir, `mission-control-${timestamp}.sqlite3`));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await backup(db, outputPath);
  await chmod(outputPath, 0o600);
  return outputPath;
}
