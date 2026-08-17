import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertCandidateEnvelope } from "./candidate-manifest.js";
import { lifecycleEvidenceChanged, positiveStateVersion } from "./lifecycle-policy.js";
import { fileExists } from "./config.js";
import {
  assertIsolatedTestEnvironment,
  missionControlDataDir,
  missionControlRoot,
} from "./runtime-paths.js";

const ENTITY_TABLES = ["projects", "tasks", "comments", "reviews", "events", "runs", "qaBundles", "candidates", "notificationOutbox"];
const TABLE_NAME = { qaBundles: "qa_bundles", notificationOutbox: "notification_outbox" };
const MUTABLE_ENTITY_TABLES = new Set(["projects", "tasks", "reviews", "runs", "qaBundles", "candidates", "notificationOutbox"]);
const STATE_INTEGRITY_VERSION = 5;
const LIFECYCLE_SCHEMA_VERSION = 1;
export const COORDINATION_SCHEMA_VERSION = 2;
const QA_COMMENT_AUTHORS = new Set(["Mission Control QA Integration", "StudioOps QA Integration"]);
const ACTIVE_QA_COMMENTS_PER_TASK = 20;
const ACTIVE_QA_EVENTS_PER_TASK = 40;
const ACTIVE_STALE_REVIEW_RUNS_PER_DISPATCH = 3;
const SQLITE_BUSY_TIMEOUT_MS = 250;
const DEFAULT_MUTATION_RETRIES = 4;
const MAX_MUTATION_RETRIES = 8;
const CONTENTION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CONTENTION_EVENTS = 1_000;
const VALID_TASK_STATUSES = new Set([
  "idea", "architecture_pending", "architecture_in_progress", "architecture_ready",
  "ready", "queued", "in_progress", "blocked", "builder_review", "backend_review",
  "frontend_review", "accessibility_review", "regression_review", "lead_review", "qa_review",
  "approved_for_main", "promotion_blocked", "needs_changes", "user_review", "approved",
  "merged", "deployed", "done", "closed", "legacy_untrusted",
]);
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
  assertIsolatedTestEnvironment();
  database = new DatabaseSync(DATABASE_FILE);
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  // Two fresh worker processes can open the same database before either has
  // finished switching the journal mode. Retry only this initialization pragma;
  // all later writes retain SQLite's normal busy-timeout/error behavior.
  const retryUntil = Date.now() + 10_000;
  while (true) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (error) {
      if (!/locked/i.test(error.message || "") || Date.now() >= retryUntil) throw error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 25);
    }
  }
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
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
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
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      manifest_digest TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS database_contention_events (
      id TEXT PRIMARY KEY,
      operation_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      wait_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_comments_task_created ON comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_task_created ON reviews(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_runs_task_status ON runs(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_qa_bundles_project_status ON qa_bundles(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_candidates_project_status ON candidates(project_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_manifest_digest ON candidates(manifest_digest);
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_operational_archive_task_created ON operational_archive(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_database_contention_created ON database_contention_events(created_at);
  `);
  const contentionColumns = new Set(
    database.prepare("PRAGMA table_info(database_contention_events)").all().map((column) => column.name),
  );
  if (!contentionColumns.has("duration_ms")) {
    database.exec("ALTER TABLE database_contention_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0");
  }
  return database;
}

function isSqliteBusy(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(text);
}

function boundedOperationName(value) {
  const normalized = String(value || "state_mutation")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120);
  return normalized || "state_mutation";
}

function mutationRetryPolicy(options = {}) {
  const idempotent = options.idempotent === true;
  const requested = Number(options.maxBusyRetries ?? DEFAULT_MUTATION_RETRIES);
  return {
    idempotent,
    maxRetries: idempotent
      ? Math.min(MAX_MUTATION_RETRIES, Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MUTATION_RETRIES))
      : 0,
  };
}

function retryDelayMs(attempt) {
  const exponential = Math.min(400, 20 * (2 ** Math.max(0, attempt - 1)));
  return exponential + Math.floor(Math.random() * 31);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordContentionEvent(db, input = {}) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO database_contention_events(id, operation_name, outcome, wait_ms, duration_ms, retry_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    boundedOperationName(input.operationName),
    String(input.outcome || "committed").slice(0, 40),
    Math.max(0, Math.round(Number(input.waitMs) || 0)),
    Math.max(0, Math.round(Number(input.durationMs) || 0)),
    Math.max(0, Math.floor(Number(input.retryCount) || 0)),
    createdAt,
  );
  const retentionCutoff = new Date(Date.now() - CONTENTION_EVENT_RETENTION_MS).toISOString();
  db.prepare("DELETE FROM database_contention_events WHERE created_at < ?").run(retentionCutoff);
  db.prepare(`
    DELETE FROM database_contention_events
    WHERE id IN (
      SELECT id FROM database_contention_events
      ORDER BY created_at DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `).run(MAX_CONTENTION_EVENTS);
}

function readStateSnapshot(db) {
  db.exec("BEGIN");
  try {
    const state = readStateFromOpenDatabase(db);
    const version = Number(db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get()?.version || 0);
    db.exec("COMMIT");
    return { state, version };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureCoordinationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_fence_counters (
      resource_key TEXT PRIMARY KEY,
      last_fence INTEGER NOT NULL CHECK (last_fence > 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordination_leases (
      lease_id TEXT PRIMARY KEY,
      resource_key TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence > 0),
      owner_process_identity TEXT NOT NULL,
      expected_state_version INTEGER NOT NULL CHECK (expected_state_version > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'abandoned', 'released')),
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      terminal_at TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_coordination_leases_resource_expiry
      ON coordination_leases(resource_key, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_coordination_leases_expiry
      ON coordination_leases(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_leases_active_resource
      ON coordination_leases(resource_key) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS external_operations (
      operation_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      subject TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      expected_remote_state TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence > 0),
      owner_process_identity TEXT NOT NULL,
      expected_state_version INTEGER NOT NULL CHECK (expected_state_version > 0),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'succeeded', 'quarantined')),
      prepared_at TEXT NOT NULL,
      terminal_at TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_external_operations_status_prepared
      ON external_operations(status, prepared_at);
    CREATE INDEX IF NOT EXISTS idx_external_operations_due
      ON external_operations(status, terminal_at, prepared_at);
    CREATE INDEX IF NOT EXISTS idx_external_operations_lease
      ON external_operations(lease_id, fence, expected_state_version);
  `);
  const leaseColumns = new Set(db.prepare("PRAGMA table_info(coordination_leases)").all().map((column) => column.name));
  if (!leaseColumns.has("aggregate_type")) db.exec("ALTER TABLE coordination_leases ADD COLUMN aggregate_type TEXT NOT NULL DEFAULT ''");
  if (!leaseColumns.has("aggregate_id")) db.exec("ALTER TABLE coordination_leases ADD COLUMN aggregate_id TEXT NOT NULL DEFAULT ''");
  const operationColumns = new Set(db.prepare("PRAGMA table_info(external_operations)").all().map((column) => column.name));
  if (!operationColumns.has("aggregate_type")) db.exec("ALTER TABLE external_operations ADD COLUMN aggregate_type TEXT NOT NULL DEFAULT ''");
  if (!operationColumns.has("aggregate_id")) db.exec("ALTER TABLE external_operations ADD COLUMN aggregate_id TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coordination_leases_aggregate
      ON coordination_leases(aggregate_type, aggregate_id, expected_state_version);
    CREATE INDEX IF NOT EXISTS idx_external_operations_aggregate
      ON external_operations(aggregate_type, aggregate_id, expected_state_version, status);
  `);
}

function coordinationSchemaIsCurrent(db, meta = {}) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const leaseColumns = tables.has("coordination_leases")
    ? new Set(db.prepare("PRAGMA table_info(coordination_leases)").all().map((column) => column.name))
    : new Set();
  const operationColumns = tables.has("external_operations")
    ? new Set(db.prepare("PRAGMA table_info(external_operations)").all().map((column) => column.name))
    : new Set();
  return Number(meta.coordinationMigration?.schemaVersion || 0) >= COORDINATION_SCHEMA_VERSION
    && tables.has("coordination_fence_counters")
    && tables.has("coordination_leases")
    && tables.has("external_operations")
    && leaseColumns.has("aggregate_type")
    && leaseColumns.has("aggregate_id")
    && operationColumns.has("aggregate_type")
    && operationColumns.has("aggregate_id");
}

function ensureLifecycleSchema(db) {
  const taskColumns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
  if (!taskColumns.has("state_version")) {
    db.exec("ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_state_version ON tasks(id, state_version)");
}

function lifecycleSchemaIsCurrent(db, meta = {}) {
  const taskColumns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
  const taskIndexes = new Set(db.prepare("PRAGMA index_list(tasks)").all().map((index) => index.name));
  return Number(meta.lifecycleMigration?.schemaVersion || 0) >= LIFECYCLE_SCHEMA_VERSION
    && taskColumns.has("state_version")
    && taskIndexes.has("idx_tasks_state_version");
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
  const staleReviewRunLimit = Math.max(
    1,
    Number(input.staleReviewRunLimit || ACTIVE_STALE_REVIEW_RUNS_PER_DISPATCH),
  );
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
  const runs = archiveOldestBeyondLimit(
    Array.isArray(state.runs) ? state.runs : [],
    (run) => (
      run.status === "cancelled"
      && run.actionType === "continue_review"
      && (
        String(run.exitCode || "").startsWith("task_status_changed:")
        || String(run.notes || "").includes("dispatch-loop incident")
      )
    ),
    (run) => run.dispatchKey || `${run.taskId || "unassigned"}:${run.role || "reviewer"}`,
    staleReviewRunLimit,
  );
  state.comments = comments.active;
  state.events = events.active;
  state.runs = runs.active;
  return { comments: comments.archived, events: events.archived, runs: runs.archived };
}

function archivePayload(entityType, item) {
  if (entityType !== "runs") return item;
  const {
    prompt: _prompt,
    ...auditRecord
  } = item;
  return {
    ...auditRecord,
    promptOmitted: true,
  };
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
        JSON.stringify(archivePayload(entityType, item)),
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
    comments: Number(previous.comments || 0) + (archived.comments || []).length,
    events: Number(previous.events || 0) + (archived.events || []).length,
    runs: Number(previous.runs || 0) + (archived.runs || []).length,
    activeQaCommentsPerTask: ACTIVE_QA_COMMENTS_PER_TASK,
    activeQaEventsPerTask: ACTIVE_QA_EVENTS_PER_TASK,
    activeStaleReviewRunsPerDispatch: ACTIVE_STALE_REVIEW_RUNS_PER_DISPATCH,
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
  state.candidates = Array.isArray(state.candidates) ? state.candidates : [];
  state.notificationOutbox = Array.isArray(state.notificationOutbox) ? state.notificationOutbox : [];

  const projectIds = new Set(state.projects.map((project) => project.id));
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const bundlesById = new Map(state.qaBundles.map((bundle) => [bundle.id, bundle]));
  const candidatesById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of state.candidates) {
    try {
      assertCandidateEnvelope(candidate);
    } catch (error) {
      candidate.status = "invalidated";
      candidate.integrityError = error.message;
    }
  }

  for (const task of state.tasks) {
    const version = Number(task.stateVersion);
    task.stateVersion = Number.isSafeInteger(version) && version > 0 ? version : 1;
    const candidate = candidatesById.get(task.candidateId);
    const decision = candidate?.qaDecision;
    const hasTrustedApproval = Boolean(
      candidate
      && !candidate.integrityError
      && ["qa_passed", "release_candidate_ready"].includes(candidate.status)
      && decision?.outcome === "passed"
      && decision.candidateId === candidate.id
      && decision.manifestDigest === candidate.manifestDigest
      && decision.integrationSha === candidate.manifest?.integration?.sha
      && candidate.manifest?.sources?.some((source) => source.taskId === task.id),
    );
    if (task.qaDecision?.outcome === "passed" && !hasTrustedApproval) {
      task.legacyQaDecisionUntrusted = true;
    }
    if (task.status === "approved_for_main" && !hasTrustedApproval) {
      task.legacyStatus = task.legacyStatus || task.status;
      task.status = "legacy_untrusted";
      task.promotionStatus = "";
      task.integrityBlocker = "Legacy task-level QA approval is not bound to an immutable candidate.";
    }
  }

  for (const task of state.tasks) {
    if (!task.qaBundleId) continue;
    const bundle = bundlesById.get(task.qaBundleId);
    if (!bundle || bundle.projectId !== task.projectId) delete task.qaBundleId;
  }

  for (const bundle of state.qaBundles) {
    if (!projectIds.has(bundle.projectId)) bundle.status = "blocked";
    if (bundle.candidateId) {
      const candidate = candidatesById.get(bundle.candidateId);
      if (!candidate || candidate.projectId !== bundle.projectId || candidate.qaBundleId !== bundle.id) {
        bundle.status = "blocked";
        bundle.candidateIntegrityError = "QA bundle candidate link is invalid.";
      }
    } else if (["ready", "passed", "partially_reviewed", "release_candidate_ready"].includes(bundle.status)) {
      bundle.legacyStatus = bundle.legacyStatus || bundle.status;
      bundle.status = "legacy_untrusted";
    }
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
      INSERT INTO tasks(id, sequence, project_id, status, state_version, assigned_role, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        status = excluded.status, state_version = excluded.state_version,
        assigned_role = excluded.assigned_role, updated_at = excluded.updated_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.projectId || "", item.status || "", Number(item.stateVersion || 1), item.assignedAgentRole || "", item.updatedAt || "", payload);
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
  if (table === "candidates") {
    db.prepare(`
      INSERT INTO candidates(id, sequence, project_id, status, manifest_digest, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        status = excluded.status, manifest_digest = excluded.manifest_digest,
        updated_at = excluded.updated_at, payload = excluded.payload
    `)
      .run(
        item.id,
        sequence,
        item.projectId || "",
        item.status || "",
        item.manifestDigest || "",
        item.updatedAt || "",
        payload,
      );
    return;
  }
  if (table === "notificationOutbox") {
    db.prepare(`
      INSERT INTO notification_outbox(id, sequence, project_id, status, kind, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, project_id = excluded.project_id,
        status = excluded.status, kind = excluded.kind, updated_at = excluded.updated_at, payload = excluded.payload
    `)
      .run(item.id, sequence, item.projectId || "", item.status || "", item.kind || "", item.updatedAt || "", payload);
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
  assertFullCandidateHistoryPreserved(db, state.candidates || []);
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

function normalizeTaskStateVersions(state, snapshot) {
  const externalEvidenceTaskIds = new Set();
  const previousReviewIds = snapshot.tables.reviews;
  for (const review of state.reviews || []) {
    const prior = previousReviewIds.get(review.id);
    if (!prior || prior.payload !== JSON.stringify(review)) externalEvidenceTaskIds.add(review.taskId);
  }
  for (const candidate of state.candidates || []) {
    const prior = snapshot.tables.candidates.get(candidate.id);
    if (prior?.payload === JSON.stringify(candidate)) continue;
    for (const source of candidate.manifest?.sources || []) externalEvidenceTaskIds.add(source.taskId);
  }
  for (const task of state.tasks || []) {
    const priorPayload = snapshot.tables.tasks.get(task.id)?.payload;
    if (!priorPayload) {
      task.stateVersion = 1;
      continue;
    }
    const previous = JSON.parse(priorPayload);
    const priorVersion = positiveStateVersion(previous.stateVersion);
    const lifecycleOrEvidenceChanged = previous.status !== task.status
      || lifecycleEvidenceChanged(previous, task)
      || externalEvidenceTaskIds.has(task.id);
    const suppliedVersion = positiveStateVersion(task.stateVersion);
    if (lifecycleOrEvidenceChanged) {
      if (suppliedVersion === priorVersion) task.stateVersion = priorVersion + 1;
      else if (suppliedVersion !== priorVersion + 1) {
        throw new Error(`Task ${task.id} stateVersion must increment exactly once for a lifecycle or evidence mutation.`);
      }
    } else if (suppliedVersion !== priorVersion) {
      throw new Error(`Task ${task.id} stateVersion cannot change for a metadata-only mutation.`);
    } else {
      task.stateVersion = priorVersion;
    }
  }
}

function assertAppendOnlyCandidateFields(previousCandidate, candidate) {
  for (const field of ["invalidation", "qaDecision", "promotion", "promotionMerge"]) {
    if (
      previousCandidate[field]
      && JSON.stringify(previousCandidate[field]) !== JSON.stringify(candidate[field])
    ) {
      throw new Error(`Candidate ${candidate.id} ${field} record is append-only.`);
    }
  }
  if (candidate.invalidation && candidate.status !== "invalidated") {
    throw new Error(`Candidate ${candidate.id} cannot leave invalidated status.`);
  }
}

function assertCandidateTransition(previousCandidate, candidate) {
  assertCandidateEnvelope(candidate);
  for (const field of ["id", "projectId", "qaBundleId", "createdAt"]) {
    if (previousCandidate[field] !== candidate[field]) {
      throw new Error(`Candidate ${previousCandidate.id} ${field} is immutable.`);
    }
  }
  if (
    JSON.stringify(previousCandidate.manifest) !== JSON.stringify(candidate.manifest)
    || previousCandidate.manifestDigest !== candidate.manifestDigest
  ) {
    throw new Error(`Candidate ${candidate.id} manifest is immutable.`);
  }
  assertAppendOnlyCandidateFields(previousCandidate, candidate);
}

function assertReviewTransition(previousReview, review) {
  const mutable = new Set(["invalidatedAt", "invalidation"]);
  for (const key of new Set([...Object.keys(previousReview), ...Object.keys(review)])) {
    if (mutable.has(key)) continue;
    if (JSON.stringify(previousReview[key]) !== JSON.stringify(review[key])) {
      throw new Error(`Review ${previousReview.id} history is immutable.`);
    }
  }
  if (previousReview.invalidatedAt && JSON.stringify(previousReview) !== JSON.stringify(review)) {
    throw new Error(`Review ${previousReview.id} invalidation is append-only.`);
  }
  if (review.invalidatedAt && !review.invalidation) {
    throw new Error(`Review ${review.id} invalidation metadata is incomplete.`);
  }
}

function assertFullCandidateHistoryPreserved(db, candidates) {
  const currentById = new Map((candidates || []).map((candidate) => [candidate.id, candidate]));
  for (const row of db.prepare("SELECT id, payload FROM candidates").all()) {
    const previousCandidate = parsePayload(row.payload, null);
    const candidate = currentById.get(row.id);
    if (!candidate) throw new Error(`Candidate ${row.id} cannot be deleted.`);
    assertCandidateTransition(previousCandidate, candidate);
  }
  for (const candidate of candidates || []) assertCandidateEnvelope(candidate);
}

function assertValidTaskStatuses(state) {
  for (const task of state.tasks || []) {
    const status = typeof task.status === "string" ? task.status.trim() : "";
    if (task.status === status && VALID_TASK_STATUSES.has(status)) continue;
    throw new Error(`Task ${task.id} has invalid workflow status: ${task.status || "(missing)"}. Repair it with an explicit canonical status before writing other fields.`);
  }
}

function writeMutationToOpenDatabase(db, state, snapshot, options = {}) {
  normalizeTaskStateVersions(state, snapshot);
  if (options.validateTaskStatuses !== false) {
    if (options.repairTaskId) {
      const repairTaskId = String(options.repairTaskId);
      const target = (state.tasks || []).find((task) => task.id === repairTaskId);
      const previousPayload = snapshot.tables.tasks.get(repairTaskId)?.payload;
      const previousTask = previousPayload ? JSON.parse(previousPayload) : null;
      const previousStatus = typeof previousTask?.status === "string" ? previousTask.status.trim() : "";
      const currentStatus = typeof target?.status === "string" ? target.status.trim() : "";
      if (!target || !previousTask || (previousStatus && VALID_TASK_STATUSES.has(previousStatus))) {
        assertValidTaskStatuses(state);
      } else if (!VALID_TASK_STATUSES.has(currentStatus)) {
        throw new Error(`Task ${repairTaskId} repair must transition an existing invalid workflow status to a canonical status.`);
      } else {
        for (const task of state.tasks || []) {
          if (task.id === repairTaskId) continue;
          const status = typeof task.status === "string" ? task.status.trim() : "";
          if (task.status === status && VALID_TASK_STATUSES.has(status)) continue;
          const priorPayload = snapshot.tables.tasks.get(task.id)?.payload;
          if (!priorPayload || priorPayload !== JSON.stringify(task)) {
            throw new Error(`Task ${task.id} has invalid workflow status and cannot be changed during repair of ${repairTaskId}.`);
          }
        }
      }
    } else {
      assertValidTaskStatuses(state);
    }
  }
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
      if (table === "candidates") {
        assertCandidateEnvelope(item);
        if (prior) {
          const previousCandidate = JSON.parse(prior.payload);
          assertCandidateTransition(previousCandidate, item);
        }
      }
      if (table === "reviews" && prior) {
        assertReviewTransition(JSON.parse(prior.payload), item);
      }
      const changed = !prior
        || prior.sequence !== sequence
        || (MUTABLE_ENTITY_TABLES.has(table) && prior.payload !== JSON.stringify(item));
      if (changed) upsertEntity(db, table, item, sequence);
    }
    const tableName = TABLE_NAME[table] || table;
    for (const id of previousItems.keys()) {
      if (!currentIds.has(id)) {
        if (["candidates", "reviews"].includes(table)) throw new Error(`${table === "candidates" ? "Candidate" : "Review"} ${id} cannot be deleted.`);
        db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
      }
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
  const verification = new DatabaseSync(outputPath, { readOnly: true });
  try {
    const integrity = verification.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error(`Pre-migration backup integrity check failed: ${integrity?.integrity_check || "unknown"}`);
    for (const table of ["state_meta", ...ENTITY_TABLES.map((name) => TABLE_NAME[name] || name)]) {
      const sourceCount = Number(db.prepare(`SELECT count(*) count FROM ${table}`).get()?.count || 0);
      const backupCount = Number(verification.prepare(`SELECT count(*) count FROM ${table}`).get()?.count || 0);
      if (sourceCount !== backupCount) throw new Error(`Pre-migration backup verification failed for ${table}.`);
    }
  } finally {
    verification.close();
  }
  return outputPath;
}

async function runStateIntegrityMigration(db) {
  if (integrityMigrated) return;
  const currentMeta = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
  const parsedMeta = parsePayload(currentMeta?.payload, {});
  if (
    Number(parsedMeta.stateIntegrityVersion || 0) >= STATE_INTEGRITY_VERSION
    && lifecycleSchemaIsCurrent(db, parsedMeta)
    && coordinationSchemaIsCurrent(db, parsedMeta)
  ) {
    integrityMigrated = true;
    return;
  }
  // Node's SQLite backup API cannot run on a connection with an active write
  // transaction. Serialize migration attempts in-process, take the recovery
  // snapshot first, then acquire the database write lock before any mutation.
  const backupPath = await preMigrationBackup(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const lockedMetaRow = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
    const lockedMeta = parsePayload(lockedMetaRow?.payload, {});
    if (
      Number(lockedMeta.stateIntegrityVersion || 0) >= STATE_INTEGRITY_VERSION
      && lifecycleSchemaIsCurrent(db, lockedMeta)
      && coordinationSchemaIsCurrent(db, lockedMeta)
    ) {
      db.exec("COMMIT");
      integrityMigrated = true;
      return;
    }
    ensureLifecycleSchema(db);
    ensureCoordinationSchema(db);
    if (process.env.STUDIOOPS_TEST_FAIL_COORDINATION_MIGRATION === "after_schema") {
      if (!process.env.NODE_TEST_CONTEXT && !process.env.STUDIOOPS_TEST_ISOLATION) {
        throw new Error("Coordination migration fault injection is restricted to isolated tests.");
      }
      assertIsolatedTestEnvironment();
      throw new Error("Injected coordination migration failure after schema change.");
    }
    const state = readStateFromOpenDatabase(db);
    const snapshot = mutationSnapshot(state);
    reconcileStateIntegrity(state);
    const now = new Date().toISOString();
    backfillIntegratedQaBundles(state, now);
    reconcileStateIntegrity(state);
    const archived = compactOperationalHistory(state);
    archiveOperationalHistory(db, archived, now);
    state.meta = state.meta || {};
    state.meta.stateIntegrityVersion = Math.max(
      Number(state.meta.stateIntegrityVersion || 0),
      STATE_INTEGRITY_VERSION,
    );
    state.meta.lifecycleMigration = {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      integrityVersion: STATE_INTEGRITY_VERSION,
      migratedAt: now,
      backupPath,
      backupVerified: true,
    };
    state.meta.coordinationMigration = {
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      migratedAt: now,
      backupPath,
      backupVerified: true,
    };
    recordOperationalArchiveMetadata(state, archived, now, backupPath);
    state.meta.updatedAt = now;
    writeMutationToOpenDatabase(db, state, snapshot, { validateTaskStatuses: false });
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
  return {
    meta: {},
    projects: [],
    tasks: [],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [],
    candidates: [],
    notificationOutbox: [],
  };
}

export async function ensureStateDatabase() {
  assertIsolatedTestEnvironment();
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

export async function readDatabaseStateReadOnly() {
  assertIsolatedTestEnvironment();
  if (!(await fileExists(DATABASE_FILE))) {
    throw new Error("StudioOps state database is not initialized; read-only inspection cannot initialize it.");
  }
  let walHasFrames = false;
  try {
    walHasFrames = (await stat(`${DATABASE_FILE}-wal`)).size > 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const db = new DatabaseSync(
    walHasFrames
      ? `file:${DATABASE_FILE}?mode=ro`
      : `file:${DATABASE_FILE}?mode=ro&immutable=1`,
    {
    readOnly: true,
    uri: true,
    },
  );
  try {
    const state = readStateFromOpenDatabase(db);
    if (!state) throw new Error("StudioOps state database is not initialized; read-only inspection cannot initialize it.");
    return state;
  } finally {
    db.close();
  }
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
    const previousState = readStateFromOpenDatabase(db);
    assertMaintenanceWriteAllowed(previousState);
    const snapshot = mutationSnapshot(previousState);
    reconcileStateIntegrity(state);
    normalizeTaskStateVersions(state, snapshot);
    assertValidTaskStatuses(state);
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

export async function mutateDatabaseState(mutator, options = {}) {
  const db = await ensureStateDatabase();
  const operationName = boundedOperationName(options.operationName);
  const retryPolicy = mutationRetryPolicy(options);
  const startedAt = Date.now();
  let retryCount = 0;
  let lockWaitMs = 0;

  while (true) {
    const { state, version: expectedVersion } = readStateSnapshot(db);
    assertMaintenanceWriteAllowed(state);
    const snapshot = mutationSnapshot(state);
    reconcileStateIntegrity(state);

    // Mutators run before the write transaction. They must only transform the
    // supplied snapshot or perform retry-safe reads; external writes belong in
    // the fenced operation-intent workflow.
    const result = await mutator(state);
    reconcileStateIntegrity(state);
    state.meta = state.meta || {};
    const archived = compactOperationalHistory(state);
    const now = new Date().toISOString();
    if (archivedItemCount(archived)) recordOperationalArchiveMetadata(state, archived, now);
    state.meta.updatedAt = now;
    state.meta.storageBackend = "sqlite";

    let transactionStarted = false;
    try {
      const lockAttemptStartedAt = Date.now();
      try {
        db.exec("BEGIN IMMEDIATE");
      } finally {
        lockWaitMs += Date.now() - lockAttemptStartedAt;
      }
      transactionStarted = true;
      const currentVersion = Number(
        db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get()?.version || 0,
      );
      if (currentVersion !== expectedVersion) {
        const conflict = new Error(
          `StudioOps state changed during ${operationName}; expected version ${expectedVersion}, observed ${currentVersion}.`,
        );
        conflict.code = "STUDIOOPS_STATE_CONFLICT";
        throw conflict;
      }
      const currentMeta = parsePayload(
        db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get()?.payload,
        {},
      );
      assertMaintenanceWriteAllowed({ meta: currentMeta });
      if (archivedItemCount(archived)) archiveOperationalHistory(db, archived, now);
      writeMutationToOpenDatabase(db, state, snapshot, options);
      recordContentionEvent(db, {
        operationName,
        outcome: "committed",
        waitMs: lockWaitMs,
        durationMs: Date.now() - startedAt,
        retryCount,
      });
      db.exec("COMMIT");
      transactionStarted = false;
      await secureStoragePaths();
      return result;
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      const retryableConflict = error.code === "STUDIOOPS_STATE_CONFLICT" || isSqliteBusy(error);
      if (!retryableConflict || !retryPolicy.idempotent || retryCount >= retryPolicy.maxRetries) {
        error.operationName = operationName;
        error.retryCount = retryCount;
        throw error;
      }
      retryCount += 1;
      await sleep(retryDelayMs(retryCount));
    }
  }
}

export async function databaseContentionHealth(input = {}) {
  const db = await ensureStateDatabase();
  const windowMinutes = Math.min(1_440, Math.max(1, Number(input.windowMinutes) || 15));
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const aggregate = db.prepare(`
    SELECT
      count(*) AS operation_count,
      coalesce(sum(retry_count), 0) AS retry_count,
      coalesce(max(wait_ms), 0) AS max_wait_ms,
      coalesce(round(avg(wait_ms)), 0) AS average_wait_ms,
      coalesce(max(duration_ms), 0) AS max_duration_ms,
      coalesce(round(avg(duration_ms)), 0) AS average_duration_ms,
      max(created_at) AS last_operation_at
    FROM database_contention_events
    WHERE created_at >= ?
  `).get(cutoff);
  const recent = db.prepare(`
    SELECT operation_name, outcome, wait_ms, duration_ms, retry_count, created_at
    FROM database_contention_events
    WHERE created_at >= ? AND (retry_count > 0 OR wait_ms >= ?)
    ORDER BY created_at DESC
    LIMIT 20
  `).all(cutoff, SQLITE_BUSY_TIMEOUT_MS);
  return {
    windowMinutes,
    operationCount: Number(aggregate.operation_count || 0),
    retryCount: Number(aggregate.retry_count || 0),
    maxWaitMs: Number(aggregate.max_wait_ms || 0),
    averageWaitMs: Number(aggregate.average_wait_ms || 0),
    maxDurationMs: Number(aggregate.max_duration_ms || 0),
    averageDurationMs: Number(aggregate.average_duration_ms || 0),
    lastOperationAt: aggregate.last_operation_at || "",
    recent: recent.map((event) => ({
      operation: event.operation_name,
      outcome: event.outcome,
      waitMs: Number(event.wait_ms || 0),
      durationMs: Number(event.duration_ms || 0),
      retries: Number(event.retry_count || 0),
      createdAt: event.created_at,
    })),
  };
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
