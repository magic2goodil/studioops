import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./config.js";
import { missionControlDataDir, missionControlRoot } from "./runtime-paths.js";

const ENTITY_TABLES = ["projects", "tasks", "comments", "reviews", "events", "runs", "qaBundles"];
const TABLE_NAME = { qaBundles: "qa_bundles" };
const MUTABLE_ENTITY_TABLES = new Set(["projects", "tasks", "runs", "qaBundles"]);
const STATE_INTEGRITY_VERSION = 3;
const QA_COMMENT_AUTHORS = new Set(["Mission Control QA Integration", "StudioOps QA Integration"]);
const ACTIVE_QA_COMMENTS_PER_TASK = 20;
const ACTIVE_QA_EVENTS_PER_TASK = 40;
const DATA_DIR = missionControlDataDir();
export const DATABASE_FILE = path.join(DATA_DIR, "mission-control.sqlite3");
export const LEGACY_DATA_FILE = path.join(DATA_DIR, "mission-control.json");

let database = null;
let integrityMigrated = false;
let integrityMigrationPromise = null;

async function secureStoragePaths() {
  await chmod(DATA_DIR, 0o700).catch(() => {});
  for (const filePath of [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, LEGACY_DATA_FILE]) {
    await chmod(filePath, 0o600).catch(() => {});
  }
}

function openDatabase() {
  if (database) return database;
  database = new DatabaseSync(DATABASE_FILE);
  database.exec("PRAGMA busy_timeout = 10000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
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
    CREATE TABLE IF NOT EXISTS operational_archive (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_comments_task_created ON comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_task_created ON reviews(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_runs_task_status ON runs(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_qa_bundles_project_status ON qa_bundles(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_operational_archive_task_created ON operational_archive(task_id, created_at);
  `);
  return database;
}

function archiveOldestBeyondLimit(items, matches, groupKey, limit) {
  const counts = new Map();
  const keep = new Array(items.length).fill(true);
  const archived = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!matches(item)) continue;
    const key = groupKey(item);
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    if (count >= limit) {
      keep[index] = false;
      archived.push(item);
    }
  }
  return {
    active: items.filter((_, index) => keep[index]),
    archived: archived.reverse(),
  };
}

export function compactOperationalHistory(state, input = {}) {
  const commentLimit = Math.max(1, Number(input.commentLimit || ACTIVE_QA_COMMENTS_PER_TASK));
  const eventLimit = Math.max(1, Number(input.eventLimit || ACTIVE_QA_EVENTS_PER_TASK));
  const qaEventEvidence = new Set((Array.isArray(state.events) ? state.events : [])
    .filter((event) => /^qa_integration_/.test(event.type || ""))
    .map((event) => `${event.taskId || ""}|${event.createdAt || ""}`));
  const comments = archiveOldestBeyondLimit(
    Array.isArray(state.comments) ? state.comments : [],
    (comment) => (
      (comment.systemGenerated === true && comment.kind === "qa_integration")
      || (
        QA_COMMENT_AUTHORS.has(comment.author)
        && /^QA integration\b/.test(comment.body || "")
        && qaEventEvidence.has(`${comment.taskId || ""}|${comment.createdAt || ""}`)
      )
    ),
    (comment) => comment.taskId || "unassigned",
    commentLimit,
  );
  const events = archiveOldestBeyondLimit(
    Array.isArray(state.events) ? state.events : [],
    (event) => /^qa_(?:integration|bundle)_/.test(event.type || ""),
    (event) => event.taskId || `${event.projectId || "unassigned"}:${event.type || "qa"}`,
    eventLimit,
  );
  state.comments = comments.active;
  state.events = events.active;
  return { comments: comments.archived, events: events.archived };
}

function archiveOperationalHistory(db, archived, now) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO operational_archive(
      entity_type, entity_id, project_id, task_id, created_at, archived_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [entityType, items] of Object.entries(archived)) {
    for (const item of items) {
      statement.run(
        entityType,
        item.id,
        item.projectId || "",
        item.taskId || "",
        item.createdAt || "",
        now,
        JSON.stringify(item),
      );
    }
  }
}

function archivedItemCount(archived) {
  return Object.values(archived).reduce((count, items) => count + items.length, 0);
}

function recordOperationalArchiveMetadata(state, archived, now, backupPath = "") {
  const previous = state.meta?.operationalArchive || {};
  state.meta.operationalArchive = {
    migratedAt: previous.migratedAt || now,
    updatedAt: now,
    backupPath: backupPath || previous.backupPath || "",
    comments: Number(previous.comments || 0) + archived.comments.length,
    events: Number(previous.events || 0) + archived.events.length,
    activeQaCommentsPerTask: ACTIVE_QA_COMMENTS_PER_TASK,
    activeQaEventsPerTask: ACTIVE_QA_EVENTS_PER_TASK,
  };
}

function parsePayload(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function qaBundleTaskSummary(task) {
  return {
    id: task.id,
    title: task.title || "Untitled task",
    prUrl: task.prUrl || "",
    branchName: task.branchName || "",
    acceptanceCriteria: task.acceptanceCriteria || [],
  };
}

export function reconcileStateIntegrity(state) {
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.qaBundles = Array.isArray(state.qaBundles) ? state.qaBundles : [];

  const projectIds = new Set(state.projects.map((project) => project.id));
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const bundlesById = new Map(state.qaBundles.map((bundle) => [bundle.id, bundle]));

  for (const task of state.tasks) {
    if (!task.qaBundleId) continue;
    const bundle = bundlesById.get(task.qaBundleId);
    if (!bundle || bundle.projectId !== task.projectId) delete task.qaBundleId;
  }

  for (const bundle of state.qaBundles) {
    if (!projectIds.has(bundle.projectId)) bundle.status = "blocked";
    const seenTaskIds = new Set();
    bundle.tasks = (Array.isArray(bundle.tasks) ? bundle.tasks : [])
      .map((entry) => tasksById.get(entry?.id))
      .filter((task) => {
        if (!task || task.projectId !== bundle.projectId || seenTaskIds.has(task.id)) return false;
        if (task.qaBundleId && task.qaBundleId !== bundle.id) return false;
        task.qaBundleId = bundle.id;
        seenTaskIds.add(task.id);
        return true;
      })
      .map(qaBundleTaskSummary);

    for (const task of state.tasks) {
      if (task.projectId !== bundle.projectId || task.qaBundleId !== bundle.id || seenTaskIds.has(task.id)) continue;
      bundle.tasks.push(qaBundleTaskSummary(task));
      seenTaskIds.add(task.id);
    }
  }
  return state;
}

function nextQaBundleId(bundles) {
  const highest = bundles
    .map((bundle) => Number(String(bundle.id || "").match(/^qa_bundle_(\d+)$/)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0);
  return `qa_bundle_${highest + 1}`;
}

function branchUrl(repoUrl, branch) {
  const httpsUrl = String(repoUrl || "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  const branchPath = String(branch || "").split("/").map(encodeURIComponent).join("/");
  return httpsUrl && branchPath ? `${httpsUrl}/tree/${branchPath}` : "";
}

function backfillIntegratedQaBundles(state, now) {
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const groups = new Map();
  for (const task of state.tasks) {
    const preview = task.localQaPreview || {};
    if (
      task.qaBundleId
      || task.status !== "qa_review"
      || !["current", "ready", "updated"].includes(preview.status)
      || !preview.after
    ) continue;
    const key = `${task.projectId}:${preview.branch || ""}:${preview.after}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  for (const tasks of groups.values()) {
    const project = projectsById.get(tasks[0].projectId);
    if (!project) continue;
    const taskPreview = tasks[0].localQaPreview || {};
    const projectPreview = project.localQaPreview || project.qaIntegration?.localPreview || {};
    const integrationBranch = taskPreview.branch || project.reviewPolicy?.integrationBranch || "";
    const bundle = {
      id: nextQaBundleId(state.qaBundles),
      projectId: project.id,
      projectKey: project.key || "",
      projectName: project.name || project.key || "Project",
      status: "ready",
      integrationBranch,
      integrationBranchUrl: branchUrl(project.repoUrl, integrationBranch),
      integrationCommit: taskPreview.after,
      previewUrl: projectPreview.previewUrl || taskPreview.previewUrl || "",
      previewCheckoutPath: projectPreview.checkoutPath || taskPreview.checkoutPath || "",
      validation: [],
      tasks: [],
      createdAt: now,
      readyAt: now,
      updatedAt: now,
      notifiedAt: "",
      notificationAttempts: 0,
      notificationRetryNotBefore: "",
    };
    state.qaBundles.push(bundle);
    for (const task of tasks) task.qaBundleId = bundle.id;
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

async function preMigrationBackup(db) {
  const backupDir = path.join(DATA_DIR, "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(
    backupDir,
    `pre-integrity-v${STATE_INTEGRITY_VERSION}-${timestamp}-${process.pid}-${randomUUID()}.sqlite3`,
  );
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await backup(db, outputPath);
  await chmod(outputPath, 0o600);
  return outputPath;
}

async function runStateIntegrityMigration(db) {
  if (integrityMigrated) return;
  const currentMeta = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
  if (Number(parsePayload(currentMeta?.payload, {}).stateIntegrityVersion || 0) >= STATE_INTEGRITY_VERSION) {
    integrityMigrated = true;
    return;
  }
  // Node's SQLite backup API cannot run on a connection with an active write
  // transaction. Serialize migration attempts in-process, take the recovery
  // snapshot first, then acquire the database write lock before any mutation.
  const backupPath = await preMigrationBackup(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = readStateFromOpenDatabase(db);
    if (Number(state?.meta?.stateIntegrityVersion || 0) >= STATE_INTEGRITY_VERSION) {
      db.exec("COMMIT");
      integrityMigrated = true;
      return;
    }
    const snapshot = mutationSnapshot(state);
    reconcileStateIntegrity(state);
    const now = new Date().toISOString();
    backfillIntegratedQaBundles(state, now);
    reconcileStateIntegrity(state);
    const archived = compactOperationalHistory(state);
    archiveOperationalHistory(db, archived, now);
    state.meta = state.meta || {};
    state.meta.stateIntegrityVersion = STATE_INTEGRITY_VERSION;
    recordOperationalArchiveMetadata(state, archived, now, backupPath);
    state.meta.updatedAt = now;
    writeMutationToOpenDatabase(db, state, snapshot);
    db.exec("COMMIT");
    integrityMigrated = true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function migrateStateIntegrity(db) {
  if (integrityMigrated) return;
  if (!integrityMigrationPromise) {
    integrityMigrationPromise = runStateIntegrityMigration(db).finally(() => {
      integrityMigrationPromise = null;
    });
  }
  return integrityMigrationPromise;
}

async function initialState() {
  const candidates = [
    LEGACY_DATA_FILE,
    path.join(missionControlRoot(), "data", "mission-control.example.json"),
  ];
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    return reconcileStateIntegrity(JSON.parse(await readFile(candidate, "utf8")));
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
  await migrateStateIntegrity(db);
  await secureStoragePaths();
  return db;
}

export async function readDatabaseState() {
  const db = await ensureStateDatabase();
  return readStateFromOpenDatabase(db);
}

export function maintenanceWriteBlocker(state, input = {}) {
  const lease = state?.meta?.selfUpdateLease;
  if (!lease || typeof lease !== "object") return null;
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const expiresAt = Date.parse(lease.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  const ownerPid = String(input.ownerPid || process.pid);
  const authorizedLeaseId = String(
    input.leaseId || process.env.STUDIOOPS_MAINTENANCE_LEASE_ID || "",
  );
  if (String(lease.ownerPid || "") === ownerPid || authorizedLeaseId === String(lease.id || "")) return null;
  return lease;
}

function assertMaintenanceWriteAllowed(state) {
  const lease = maintenanceWriteBlocker(state);
  if (!lease) return;
  const error = new Error(`StudioOps maintenance is in progress until ${lease.expiresAt}.`);
  error.code = "STUDIOOPS_MAINTENANCE";
  throw error;
}

export async function writeDatabaseState(state) {
  const db = await ensureStateDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertMaintenanceWriteAllowed(readStateFromOpenDatabase(db));
    reconcileStateIntegrity(state);
    const archived = compactOperationalHistory(state);
    if (archivedItemCount(archived)) {
      const now = new Date().toISOString();
      archiveOperationalHistory(db, archived, now);
      state.meta = state.meta || {};
      recordOperationalArchiveMetadata(state, archived, now);
    }
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
    assertMaintenanceWriteAllowed(state);
    const snapshot = mutationSnapshot(state);
    reconcileStateIntegrity(state);
    const result = await mutator(state);
    reconcileStateIntegrity(state);
    state.meta = state.meta || {};
    const archived = compactOperationalHistory(state);
    if (archivedItemCount(archived)) {
      const now = new Date().toISOString();
      archiveOperationalHistory(db, archived, now);
      recordOperationalArchiveMetadata(state, archived, now);
    }
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
