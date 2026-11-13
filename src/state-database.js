import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { validPrepaidCreditLedger } from "./credit-admission-evidence.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCandidateEnvelope, canonicalJson } from "./candidate-manifest.js";
import {
  assertCandidateRepositoryVerificationObservation,
  assertCanonicalCandidateRepositoryAuthority,
} from "./candidate-repository.js";
import {
  assertCurrentOwnerQaPacket,
  assertOwnerQaPacket,
  LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION,
} from "./owner-qa-packet.js";
import {
  assertQaRevocationIntent,
  assertCandidateQaRevocationRecords,
  normalizeQaRevocationSettlement,
  qaRevocationIntentCoordinates,
} from "./qa-revocation-records.js";
import { assertQaRevocationRemoteObservation } from "./qa-approval-revocation.js";
import {
  assertPromotionAttemptClaimInState,
  assertPromotionAttemptClaimTransitionAttestation,
} from "./promotion-attempt-claim.js";
import {
  assertMergedPromotionRecoveryObservation,
  assertPromotionRemoteObservation,
  mergedPromotionRecoveryAuthorityForState,
} from "./promotion-remote-observation.js";
import { assertPromotionMergeAncestryObservation } from "./promotion-ancestry-observation.js";
import { lifecycleEvidenceChanged, positiveStateVersion } from "./lifecycle-policy.js";
import { verifyScopedBuilderHandoff } from "./impact-planner.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
} from "./test-authority-realm.js";
import { fileExists } from "./config.js";
import {
  assertFailureIncident,
  claimPaidFailureAttempt,
  createFailureIncident,
  failureEvidence,
  failureFingerprint,
  failureWorkIdentity,
  FAILURE_CONTAINMENT_MIGRATION_VERSION,
  FAILURE_CONTAINMENT_SCHEMA_VERSION,
  MAX_PAID_ATTEMPTS_PER_GENERATION,
  openFailureCircuit,
  recordFailureRecoveryActivity,
  scheduleFailureBackoff,
  selectFailureIncident,
} from "./failure-containment.js";
import {
  assertIsolatedTestEnvironment,
  missionControlDataDir,
  missionControlRoot,
} from "./runtime-paths.js";

const ENTITY_TABLES = ["projects", "tasks", "comments", "reviews", "events", "runs", "qaBundles", "candidates", "notificationOutbox"];
const TABLE_NAME = { qaBundles: "qa_bundles", notificationOutbox: "notification_outbox" };
const MUTABLE_ENTITY_TABLES = new Set(["projects", "tasks", "reviews", "runs", "qaBundles", "candidates", "notificationOutbox"]);
const STATE_INTEGRITY_VERSION = 7;
const LIFECYCLE_SCHEMA_VERSION = 1;
export const COORDINATION_SCHEMA_VERSION = 2;
const QA_COMMENT_AUTHORS = new Set(["Mission Control QA Integration", "StudioOps QA Integration"]);
const ACTIVE_QA_COMMENTS_PER_TASK = 20;
const ACTIVE_QA_EVENTS_PER_TASK = 40;
const ACTIVE_MACHINE_COMMENTS_PER_TASK = 12;
const ACTIVE_TERMINAL_RUNS_PER_WORKFLOW_ACTION = 3;
const SQLITE_BUSY_TIMEOUT_MS = 250;
const DEFAULT_MUTATION_RETRIES = 4;
const MAX_MUTATION_RETRIES = 8;
const SERIALIZED_REPLAY_LOCK_DEADLINE_MS = 10_000;
const CONTENTION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CONTENTION_EVENTS = 1_000;
const FAILURE_TELEMETRY_DIR = path.join(missionControlDataDir(), "database-contention-failures");
const FAILURE_TELEMETRY_FILE = /^(\d{13})-[a-f0-9-]{36}\.(json|tmp)$/;
const QA_REVOCATION_SETTLEMENT_WRITE = Symbol("studioops.qa-revocation-settlement-write");
const QA_REVOCATION_INTENT_WRITE = Symbol("studioops.qa-revocation-intent-write");
const CANDIDATE_QA_DECISION_WRITE = Symbol("studioops.candidate-qa-decision-write");
const CANDIDATE_PROMOTION_WRITE = Symbol("studioops.candidate-promotion-write");
const PROMOTION_CLAIM_WRITE = Symbol("studioops.promotion-claim-write");
const MERGED_PROMOTION_RECOVERY_WRITE = Symbol("studioops.merged-promotion-recovery-write");
const STATE_INTEGRITY_MIGRATION_WRITE = Symbol("studioops.state-integrity-migration-write");
const OPERATOR_CANDIDATE_WRITE = Symbol("studioops.operator-candidate-write");
const SCOPED_DISPATCH_WRITE = Symbol("studioops.scoped-dispatch-write");
const PREPAID_RUN_CLAIM_WRITE = Symbol("studioops.prepaid-run-claim-write");
const NATIVE_WORKSPACE_WRITE = Symbol("studioops.native-workspace-write");
const NATIVE_WORKSPACE_FIELDS = ["workspacePath", "executionRepoPath", "workspaceStrategy", "gitHooksPath"];
const NATIVE_WORKSPACE_AUTHORITY_FIELDS = [...NATIVE_WORKSPACE_FIELDS, "workspaceProvenanceUntrusted"];
const NATIVE_WORKSPACE_IDENTITY_FIELDS = ["taskId", "projectId", "role", "group", "branchName"];
const TEST_FIXTURE_LEGACY_AUTHORITY_BOOTSTRAP = (() => {
  if (process.env.STUDIOOPS_TEST_TRUST_LEGACY_AUTHORITY_BOOTSTRAP !== "1") return null;
  if (process.env.NODE_ENV !== "test" || process.env.STUDIOOPS_TEST_ISOLATION !== "1") {
    throw new Error("Trusted legacy-authority fixture bootstrap is restricted to an exact isolated test environment.");
  }
  const registration = consumeIsolatedTestAuthority((testAuthority) => Object.freeze({
    databaseCapability: Symbol("studioops.test-fixture-legacy-authority-bootstrap"),
    testAuthority,
  }));
  if (!registration) {
    throw new Error("Trusted legacy-authority fixture bootstrap has no isolated test authority.");
  }
  return registration;
})();

function hasTrustedTestFixtureLegacyAuthorityBootstrap(options = {}) {
  const matches = Boolean(
    TEST_FIXTURE_LEGACY_AUTHORITY_BOOTSTRAP
    && options.testFixtureLegacyAuthorityCapability
      === TEST_FIXTURE_LEGACY_AUTHORITY_BOOTSTRAP.databaseCapability,
  );
  if (!matches) return false;
  assertCurrentIsolatedTestAuthority(TEST_FIXTURE_LEGACY_AUTHORITY_BOOTSTRAP.testAuthority);
  return true;
}
const ACTIONABLE_CANDIDATE_QA_BUNDLE_STATUSES = new Set([
  "ready",
  "partially_reviewed",
  "passed",
  "release_candidate_ready",
]);
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
let databaseReadyPromise = null;
let readerDatabase = null;
let cachedReadSnapshot = null;
let connectionLeased = false;
const connectionWaiters = [];
const connectionLeaseContext = new AsyncLocalStorage();
let failureTelemetryCache = null;
let failureTelemetryWriteErrors = 0;
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
    CREATE TABLE IF NOT EXISTS failure_incidents (
      incident_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      fingerprint_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'backoff', 'open', 'closed', 'superseded')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      evidence_digest TEXT NOT NULL,
      paid_attempts INTEGER NOT NULL DEFAULT 0 CHECK (paid_attempts >= 0),
      cheap_probe_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cheap_probe_attempts >= 0),
      repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempts >= 0),
      avoided_retries INTEGER NOT NULL DEFAULT 0 CHECK (avoided_retries >= 0),
      backoff_until TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(task_id, fingerprint_digest, generation)
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
    CREATE INDEX IF NOT EXISTS idx_failure_incidents_task_fingerprint_state
      ON failure_incidents(task_id, fingerprint_digest, state);
    CREATE INDEX IF NOT EXISTS idx_failure_incidents_state_backoff
      ON failure_incidents(state, backoff_until);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_incidents_active_generation
      ON failure_incidents(task_id, fingerprint_digest)
      WHERE state IN ('active', 'backoff', 'open');
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

async function pruneFailureTelemetry() {
  const cutoff = Date.now() - CONTENTION_EVENT_RETENTION_MS;
  const names = (await readdir(FAILURE_TELEMETRY_DIR)).filter((name) => FAILURE_TELEMETRY_FILE.test(name)).sort().reverse();
  const obsolete = names.filter((name, index) => index >= MAX_CONTENTION_EVENTS || Number(name.slice(0, 13)) < cutoff);
  for (let index = 0; index < obsolete.length; index += 32) {
    await Promise.all(obsolete.slice(index, index + 32).map((name) => unlink(path.join(FAILURE_TELEMETRY_DIR, name)).catch(() => {})));
  }
}

function safeMutationFailureCode(error) {
  if (isSqliteBusy(error)) return "SQLITE_BUSY";
  return new Set([
    "STUDIOOPS_STATE_CONFLICT", "STUDIOOPS_SERIALIZED_REPLAY_TIMEOUT",
    "STUDIOOPS_DATABASE_CONNECTION_TIMEOUT", "STUDIOOPS_DATABASE_TRANSACTION_REENTRY",
    "STUDIOOPS_MAINTENANCE", "STUDIOOPS_TASK_RECORDING_TIMEOUT",
  ]).has(error?.code) ? error.code : "MUTATION_FAILED";
}

// The failure path cannot rely on obtaining the SQLite lock that just failed.
// Atomically publish bounded, payload-free events so a CLI exit cannot hide a failure.
async function recordFailedContentionEvent(input, error) {
  const now = Date.now();
  const basename = `${now}-${randomUUID()}`;
  const temporaryPath = path.join(FAILURE_TELEMETRY_DIR, `${basename}.tmp`);
  const event = {
    operation_name: boundedOperationName(input.operationName),
    outcome: "failed",
    failure_code: safeMutationFailureCode(error),
    wait_ms: Math.max(0, Math.round(input.waitMs)),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    retry_count: Math.max(0, Math.floor(input.retryCount)),
    created_at: new Date(now).toISOString(),
  };
  try {
    await mkdir(FAILURE_TELEMETRY_DIR, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(event), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path.join(FAILURE_TELEMETRY_DIR, `${basename}.json`));
    await pruneFailureTelemetry();
    failureTelemetryCache = null;
  } catch {
    failureTelemetryWriteErrors += 1;
    await unlink(temporaryPath).catch(() => {});
  }
}

async function readFailedContentionEvents() {
  try {
    const directory = await stat(FAILURE_TELEMETRY_DIR, { bigint: true });
    const signature = `${directory.mtimeNs}:${directory.ctimeNs}`;
    if (failureTelemetryCache?.signature === signature) return failureTelemetryCache;
    const names = (await readdir(FAILURE_TELEMETRY_DIR))
      .filter((name) => FAILURE_TELEMETRY_FILE.test(name) && name.endsWith(".json"))
      .sort().reverse().slice(0, MAX_CONTENTION_EVENTS);
    const events = [];
    let available = true;
    for (let index = 0; index < names.length; index += 32) {
      const batch = await Promise.all(names.slice(index, index + 32).map(async (name) => {
        try {
          const filename = path.join(FAILURE_TELEMETRY_DIR, name);
          if ((await stat(filename)).size > 2_048) {
            available = false;
            return null;
          }
          const event = JSON.parse(await readFile(filename, "utf8"));
          if (
            event.outcome !== "failed" || !Number.isFinite(Date.parse(event.created_at))
            || ![event.wait_ms, event.duration_ms, event.retry_count].every((value) => Number.isFinite(value) && value >= 0)
          ) {
            available = false;
            return null;
          }
          return { ...event, operation_name: boundedOperationName(event.operation_name), failure_code: safeMutationFailureCode({ code: event.failure_code }) };
        } catch (error) {
          if (error.code !== "ENOENT") available = false;
          return null;
        }
      }));
      events.push(...batch.filter(Boolean));
    }
    failureTelemetryCache = { signature, events, available };
    return failureTelemetryCache;
  } catch (error) {
    return { events: [], available: error.code === "ENOENT" };
  }
}

const completedReviewCreditAdmissions = new WeakMap();
const prepaidCreditRetirementAdmissions = new WeakMap();

function taskHasUnresolvedFailureIncident(db, taskId) {
  return Boolean(db.prepare("SELECT 1 FROM failure_incidents WHERE task_id = ? AND state NOT IN ('closed', 'superseded') LIMIT 1").get(taskId));
}

// Only this executable snapshot reader can establish ledger absence. The
// independent failure ledger does not advance state_meta.version, so every
// admitted retirement is also checked inside the eventual writer transaction.
export function admitCompletedReviewCreditRetirement(state, taskId) {
  const admission = completedReviewCreditAdmissions.get(state);
  if (!admission?.eligible.has(taskId)) return false;
  admission.retirements.add(taskId);
  return true;
}

export function admitPrepaidCreditRetirement(state, taskId) {
  const admission = prepaidCreditRetirementAdmissions.get(state);
  if (!admission?.eligible.has(taskId)) return false;
  admission.retirements.add(taskId);
  return true;
}

function readStateSnapshot(db) {
  db.exec("BEGIN");
  try {
    const state = readStateFromOpenDatabase(db);
    const version = Number(db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get()?.version || 0);
    const eligible = new Set((state?.tasks || []).filter(task => task.operatorIntake
      && task.status === "blocked" && task.automationCircuit?.state === "open"
      && task.automationCircuit.reasonCode === "credit_budget_insufficient"
      && !taskHasUnresolvedFailureIncident(db, task.id)).map(task => task.id));
    if (state) completedReviewCreditAdmissions.set(state, { eligible, retirements: new Set() });
    const prepaidEligible = new Set((state?.tasks || []).filter(task => task.status === "blocked"
      && task.automationCircuit?.state === "open" && task.automationCircuit.reasonCode === "credit_budget_insufficient"
      && task.automationCircuit.attemptsConsumed === 0 && task.automationCircuit.maxAttempts === 0
      && !taskHasUnresolvedFailureIncident(db, task.id)).map(task => task.id));
    if (state) prepaidCreditRetirementAdmissions.set(state, { eligible: prepaidEligible, retirements: new Set() });
    db.exec("COMMIT");
    return { state, version };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function serializedReplayDeadlineError(operationName, retryCount, phase = "lock") {
  const error = new Error(
    `StudioOps mutation retry deadline exceeded during ${operationName} (${phase}).`,
  );
  error.code = "STUDIOOPS_SERIALIZED_REPLAY_TIMEOUT";
  error.operationName = operationName;
  error.retryCount = retryCount;
  return error;
}

function beginSerializedReplayTransaction(db, operationName, deadlineAt, retryCount) {
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs <= 0) throw serializedReplayDeadlineError(operationName, retryCount);
  const busyTimeoutMs = Math.max(1, Math.min(SQLITE_BUSY_TIMEOUT_MS, remainingMs));
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  try {
    db.exec("BEGIN IMMEDIATE");
  } finally {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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

function ensureFailureContainmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_incidents (
      incident_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      fingerprint_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'backoff', 'open', 'closed', 'superseded')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      evidence_digest TEXT NOT NULL,
      paid_attempts INTEGER NOT NULL DEFAULT 0 CHECK (paid_attempts >= 0),
      cheap_probe_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cheap_probe_attempts >= 0),
      repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempts >= 0),
      avoided_retries INTEGER NOT NULL DEFAULT 0 CHECK (avoided_retries >= 0),
      backoff_until TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(task_id, fingerprint_digest, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_failure_incidents_task_fingerprint_state
      ON failure_incidents(task_id, fingerprint_digest, state);
    CREATE INDEX IF NOT EXISTS idx_failure_incidents_state_backoff
      ON failure_incidents(state, backoff_until);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_incidents_active_generation
      ON failure_incidents(task_id, fingerprint_digest)
      WHERE state IN ('active', 'backoff', 'open');
  `);
}

function failureContainmentSchemaIsCurrent(db, meta = {}) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has("failure_incidents")) return false;
  const indexes = new Set(db.prepare("PRAGMA index_list(failure_incidents)").all().map((index) => index.name));
  return Number(meta.failureContainmentMigration?.schemaVersion || 0) >= FAILURE_CONTAINMENT_MIGRATION_VERSION
    && meta.failureContainmentMigration?.contract === FAILURE_CONTAINMENT_SCHEMA_VERSION
    && indexes.has("idx_failure_incidents_task_fingerprint_state")
    && indexes.has("idx_failure_incidents_state_backoff")
    && indexes.has("idx_failure_incidents_active_generation");
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
    const itemLimit = typeof limit === "function" ? Math.max(1, Number(limit(item) || 1)) : limit;
    if (count >= itemLimit) {
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
  const machineCommentLimit = Math.max(
    1,
    Number(input.machineCommentLimit || ACTIVE_MACHINE_COMMENTS_PER_TASK),
  );
  const eventLimit = Math.max(1, Number(input.eventLimit || ACTIVE_QA_EVENTS_PER_TASK));
  const qaEventEvidence = new Set((Array.isArray(state.events) ? state.events : [])
    .filter((event) => /^qa_integration_/.test(event.type || ""))
    .map((event) => `${event.taskId || ""}|${event.createdAt || ""}`));
  const isQaIntegrationComment = (comment) => (
    (comment.systemGenerated === true && comment.kind === "qa_integration")
    || (
      QA_COMMENT_AUTHORS.has(comment.author)
      && /^QA integration\b/.test(comment.body || "")
      && qaEventEvidence.has(`${comment.taskId || ""}|${comment.createdAt || ""}`)
    )
  );
  const comments = archiveOldestBeyondLimit(
    Array.isArray(state.comments) ? state.comments : [],
    (comment) => (
      isQaIntegrationComment(comment)
      || (
        comment.systemGenerated === true
        && comment.kind !== "qa_integration"
      )
    ),
    (comment) => isQaIntegrationComment(comment)
      ? `qa:${comment.taskId || "unassigned"}`
      : `machine:${comment.taskId || "unassigned"}`,
    (comment) => isQaIntegrationComment(comment) ? commentLimit : machineCommentLimit,
  );
  const events = archiveOldestBeyondLimit(
    Array.isArray(state.events) ? state.events : [],
    (event) => (
      event.machineGenerated !== false
    ),
    (event) => event.executionKey
      || event.attemptKey
      || event.dispatchKey
      || `${event.taskId || event.projectId || "unassigned"}:${event.type || "machine"}`,
    eventLimit,
  );
  const runs = archiveOldestBeyondLimit(
    Array.isArray(state.runs) ? state.runs : [],
    (run) => ["completed", "failed", "cancelled"].includes(run.status),
    (run) => `${run.taskId || "unassigned"}:${run.actionType || "run"}:${run.role || "worker"}`,
    (run) => Math.max(
      1,
      Number(input.terminalRunLimit || ACTIVE_TERMINAL_RUNS_PER_WORKFLOW_ACTION),
      Number(run.maxAttempts || 0) + 1,
    ),
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

function prepareArchiveRows(archived, now) {
  return Object.entries(archived).flatMap(([entityType, items]) => items.map((item) => [
    entityType, item.id, item.projectId || "", item.taskId || "", item.createdAt || "",
    now, JSON.stringify(archivePayload(entityType, item)),
  ]));
}

function writeArchiveRows(db, rows) {
  if (!rows.length) return;
  const statement = db.prepare(`
    INSERT OR IGNORE INTO operational_archive(
      entity_type, entity_id, project_id, task_id, created_at, archived_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) statement.run(...row);
}

function archiveOperationalHistory(db, archived, now) {
  writeArchiveRows(db, prepareArchiveRows(archived, now));
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
    activeMachineCommentsPerTask: ACTIVE_MACHINE_COMMENTS_PER_TASK,
    activeTerminalRunsPerWorkflowAction: ACTIVE_TERMINAL_RUNS_PER_WORKFLOW_ACTION,
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
      assertCandidateQaRevocationRecords(candidate);
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
    let ownerQaPacket = null;
    try {
      ownerQaPacket = candidate
        ? assertCurrentOwnerQaPacket(state, candidate, bundlesById.get(candidate.qaBundleId))
        : null;
    } catch {
      ownerQaPacket = null;
    }
    const hasTrustedApproval = Boolean(
      candidate
      && !candidate.integrityError
      && ["qa_passed", "release_candidate_ready"].includes(candidate.status)
      && decision?.outcome === "passed"
      && decision.candidateId === candidate.id
      && decision.manifestDigest === candidate.manifestDigest
      && decision.integrationSha === candidate.manifest?.integration?.sha
      && decision.ownerQaPacketDigest === ownerQaPacket?.packetDigest
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
    let candidate = null;
    if (bundle.candidateId) {
      candidate = candidatesById.get(bundle.candidateId);
      if (!candidate || candidate.projectId !== bundle.projectId || candidate.qaBundleId !== bundle.id) {
        bundle.status = "blocked";
        bundle.candidateIntegrityError = "QA bundle candidate link is invalid.";
      }
    } else if (["ready", "passed", "partially_reviewed", "release_candidate_ready"].includes(bundle.status)) {
      bundle.legacyStatus = bundle.legacyStatus || bundle.status;
      bundle.status = "legacy_untrusted";
    }
    const actionableCandidateBundle = Boolean(
      candidate
      && !candidate.invalidation
      && ACTIONABLE_CANDIDATE_QA_BUNDLE_STATUSES.has(bundle.status),
    );
    if (!actionableCandidateBundle) {
      if (!bundle.qaPacket) {
        const seenTaskIds = new Set();
        bundle.tasks = (Array.isArray(bundle.tasks) ? bundle.tasks : [])
          .map((entry) => tasksById.get(entry?.id))
          .filter((task) => {
            if (!task || task.projectId !== bundle.projectId || seenTaskIds.has(task.id)) return false;
            seenTaskIds.add(task.id);
            return true;
          })
          .map(qaBundleTaskSummary);
      }
      for (const task of state.tasks) {
        if (task.qaBundleId === bundle.id) delete task.qaBundleId;
      }
      continue;
    }
    const seenTaskIds = new Set();
    bundle.tasks = (Array.isArray(bundle.tasks) ? bundle.tasks : [])
      .map((entry) => tasksById.get(entry?.id))
      .filter((task) => {
        if (!task || task.projectId !== bundle.projectId || seenTaskIds.has(task.id)) return false;
        if (task.qaBundleId !== bundle.id || task.candidateId !== candidate.id) return false;
        seenTaskIds.add(task.id);
        return true;
      })
      .map(qaBundleTaskSummary);

    for (const task of state.tasks) {
      if (
        task.projectId !== bundle.projectId
        || task.qaBundleId !== bundle.id
        || task.candidateId !== candidate.id
        || seenTaskIds.has(task.id)
      ) continue;
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
      tasks: tasks.map(qaBundleTaskSummary),
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

function stateDatabaseInitialized(db) {
  return Boolean(
    db.prepare("SELECT 1 AS initialized FROM state_meta WHERE singleton_id = 1").get()?.initialized,
  );
}

function upsertEntity(db, table, item, sequence, payload = JSON.stringify(item)) {
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

function writeStateToOpenDatabase(db, state, options = {}) {
  assertFullCandidateHistoryPreserved(db, state.candidates || [], options);
  assertFullReviewHistoryPreserved(db, state.reviews || []);
  assertFullQaAuthorityPreserved(db, state, options);
  assertOwnerQaPacketMirrors(state);
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

function operatorCandidateError(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function prerequisiteRecordDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function replayPrerequisiteRepair(ancestor, current, reject) {
  const offset = current.paidAttempts === 1 ? 3 : 2;
  const proof = current.history.at(-offset), activity = current.history.at(1 - offset);
  if (ancestor.state !== "superseded" || current.generation !== ancestor.generation + 1
    || canonicalJson(current.fingerprint) !== canonicalJson(ancestor.fingerprint)
    || current.evidenceDigest === ancestor.evidenceDigest || current.state !== "active"
    || current.cheapProbeAttempts !== 1 || current.repairAttempts !== 0 || current.backoffUntil || current.openedAt
    || proof?.type !== "evidence_verified" || proof.priorEvidenceDigest !== ancestor.evidenceDigest
    || proof.evidenceDigest !== current.evidenceDigest || activity?.type !== "cheap_probe" || activity.outcome !== "passed"
    || proof.verifier !== activity.verifier || proof.recordedAt !== current.createdAt || activity.recordedAt !== current.createdAt) reject();
  let expected;
  try {
    expected = recordFailureRecoveryActivity(ancestor, { evidence: current.evidence, type: "cheap_probe", outcome: "passed",
      verifier: { id: proof.verifier, outcome: "passed", evidenceDigest: current.evidenceDigest }, now: current.createdAt });
    if (current.paidAttempts === 1) {
      const claim = current.history.at(-1);
      if (claim?.type !== "paid_attempt_claimed" || claim.attempt !== 1
        || claim.initiator !== "runner" || claim.transport !== "codex_sdk") reject();
      expected = claimPaidFailureAttempt(expected, { evidence: current.evidence, initiator: claim.initiator,
        transport: claim.transport, now: claim.recordedAt }).incident;
    }
  } catch { reject(); }
  if (canonicalJson(expected) !== canonicalJson(current)) reject();
  return proof;
}

function historicalPrerequisiteAdmission(db, task, incidents, ancestor, provider, reject) {
  // The runner overwrites the admission claim when a different reason fails.
  // Corroborate that historical admission; never invent a recovered claim link.
  if (ancestor.reasonCode !== "output_guard_exceeded" || provider.reasonCode !== "provider_unavailable"
    || provider.paidAttempts !== 1 || provider.fingerprint.action !== "start_builder"
    || canonicalJson({ ...provider.fingerprint, reasonCode: ancestor.reasonCode }) !== canonicalJson(ancestor.fingerprint)
    || canonicalJson(provider.evidence.repository) !== canonicalJson(ancestor.evidence.repository)
    || provider.evidence.componentMapDigest !== ancestor.evidence.componentMapDigest) reject();
  const prior = incidents.find((item) => item.fingerprintDigest === provider.fingerprintDigest
    && item.generation === provider.generation - 1);
  if (!prior) reject();
  const proof = replayPrerequisiteRepair(prior, provider, reject);
  const claim = provider.history.at(-1);
  const rows = db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY sequence, id LIMIT 501").all(task.id);
  if (rows.length > 500) reject();
  const runs = rows.map((row) => {
    const run = parsePayload(row.payload, null);
    if (!run || run.id !== row.id || run.taskId !== row.task_id || run.projectId !== row.project_id
      || run.status !== row.status || run.role !== row.role) reject();
    return run;
  });
  const run = runs.find((item) => item.id === task.lastAutomationFailureRunId);
  if (!run || task.lastAutomationFailure !== ancestor.reasonCode || task.automationCircuit?.snapshot?.runId !== run.id
    || task.automationCircuit?.incidentId !== ancestor.incidentId || run.projectId !== task.projectId
    || run.status !== "failed" || run.role !== "builder" || run.actionType !== "start_builder" || run.provider !== "codex-sdk"
    || run.rawFailureCode !== "command_output_budget_exceeded" || run.exitCode !== ancestor.reasonCode
    || run.failureContainmentError || canonicalJson(run.failureContainmentProbe) !== canonicalJson({ applicable: false, ok: true, code: "not_infrastructure" })) reject();
  const nativeAdmission = (admission) => admission?.consulted === true && admission.decision === "admitted"
    && admission.authority === "dispatcher_read_only" && admission.claimBoundary === "runner_pre_provider_launch"
    && admission.actionIdentity === ancestor.action && admission.provider === ancestor.provider;
  if (!nativeAdmission(run.failureContainmentAdmission)) reject();
  const identity = run.candidateIdentity || {};
  let fingerprint;
  try {
    fingerprint = failureFingerprint({ taskId: run.taskId, action: run.actionType, provider: run.provider, reasonCode: ancestor.reasonCode,
      candidate: { candidateId: run.candidateId, commitSha: identity.commitSha || run.reviewSubjectSha || run.executionCommitSha,
        treeSha: identity.treeSha, baseSha: identity.baseSha || run.preflightBaseCommit, manifestDigest: run.candidateManifestDigest,
        candidateCycle: identity.candidateCycle || run.candidateCycle || 0 } }).value;
  } catch { reject(); }
  if (canonicalJson(fingerprint) !== canonicalJson(ancestor.fingerprint)) reject();
  const terminal = run.failureContainmentClaim, lastAttempt = ancestor.history.at(-1);
  if (!terminal || terminal.incidentId !== ancestor.incidentId || terminal.generation !== ancestor.generation
    || terminal.fingerprintDigest !== ancestor.fingerprintDigest || terminal.evidenceDigest !== ancestor.evidenceDigest
    || terminal.reasonCode !== ancestor.reasonCode || terminal.paidAttempt !== ancestor.paidAttempts
    || lastAttempt?.type !== "paid_attempt_claimed" || lastAttempt.initiator !== "runner" || lastAttempt.transport !== "codex_sdk"
    || terminal.claimedAt !== lastAttempt.recordedAt) reject();
  const nativeTime = (value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
  };
  const times = [proof.recordedAt, run.startedAt, claim.recordedAt, run.completedAt, terminal.claimedAt, ancestor.openedAt]
    .map(nativeTime);
  if (times.some((value) => !Number.isFinite(value)) || times.some((value, i) => i && value < times[i - 1])) reject();
  // Unknown, overlapping or later work cannot be attributed to this admission.
  for (const other of runs) {
    if (other.id === run.id) continue;
    const started = nativeTime(other.startedAt), completed = nativeTime(other.completedAt);
    if (other.projectId !== task.projectId || !["failed", "completed", "cancelled"].includes(other.status)) reject();
    if (!Object.hasOwn(other, "startedAt")) {
      // Native queue admission can cancel an exhausted CLI attempt before any
      // start or paid claim exists. Its actual lifetime bounds that absence.
      const created = nativeTime(other.createdAt);
      if (other.status !== "cancelled" || other.provider !== "codex-cli" || other.role !== "builder"
        || other.actionType !== ancestor.action || other.exitCode !== "attempt_budget_exhausted"
        || Object.hasOwn(other, "failureContainmentClaim") || !nativeAdmission(other.failureContainmentAdmission)
        || !Number.isFinite(created) || !Number.isFinite(completed) || created > completed
        || other.updatedAt !== other.completedAt || completed > times[1] || completed >= times[2]) reject();
      continue;
    }
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started
      || completed >= times[2] || started >= times[1]) reject();
  }
  return { reasonCode: provider.reasonCode, ancestorIncidentId: prior.incidentId, ancestorRecordDigest: prerequisiteRecordDigest(prior),
    successorIncidentId: provider.incidentId, successorRecordDigest: prerequisiteRecordDigest(provider),
    verifier: proof.verifier, verifiedAt: proof.recordedAt, admissionRecordedAt: claim.recordedAt,
    terminalRunId: run.id, terminalRunRecordDigest: prerequisiteRecordDigest(run),
    runInventoryRecordDigest: prerequisiteRecordDigest(runs),
    taskRunBindingDigest: prerequisiteRecordDigest({ lastAutomationFailure: task.lastAutomationFailure,
      lastAutomationFailureRunId: task.lastAutomationFailureRunId, circuit: task.automationCircuit }),
    association: "corroborated_native_admission_with_overwritten_prior_claim" };
}

function prerequisiteFailureRecovery(db, task) {
  const reject = () => operatorCandidateError("operator_prerequisite_failure_unresolved");
  // These rows have an independent transaction/version. Never use a task JSON
  // projection, supplied incident or an earlier read as commit authority.
  const rows = db.prepare("SELECT * FROM failure_incidents WHERE task_id = ? ORDER BY generation DESC, incident_id LIMIT 501").all(task.id);
  if (rows.length > 500 || task.automationCircuit?.state === "open") reject();
  const incidents = rows.map((row) => {
    const incident = failureIncidentFromRow(row);
    if (incident.incidentId !== `failure_${incident.fingerprintDigest.slice(7, 31)}-g${incident.generation}`
      || row.paid_attempts !== incident.paidAttempts || row.cheap_probe_attempts !== incident.cheapProbeAttempts
      || row.repair_attempts !== incident.repairAttempts || row.avoided_retries !== incident.avoidedRetries
      || row.backoff_until !== incident.backoffUntil || row.opened_at !== incident.openedAt
      || row.updated_at !== incident.updatedAt) reject();
    return incident;
  });
  const currentFaults = incidents.filter((incident) => !["closed", "superseded"].includes(incident.state));
  const blocker = task.automationBlocker;
  if (!blocker) {
    if (currentFaults.length) reject();
    return null;
  }
  if (!["circuit", "failure_containment"].includes(blocker.type)) reject();
  const native = blocker.type === "failure_containment";
  const keys = native ? ["type", "reason", "incidentId", "resource", "retryAt", "blockedAt", "incidentGeneration", "evidenceDigest"]
    : ["type", "reason", "resumeStatus", "attempts", "retryAt", "incidentId", "incidentGeneration", "evidenceDigest"];
  if (Object.keys(blocker).some((key) => !keys.includes(key))
    || (native && (blocker.resource !== `${task.projectId}:${task.id}` || blocker.retryAt !== ""
      || typeof blocker.blockedAt !== "string" || !Number.isFinite(Date.parse(blocker.blockedAt))
      || new Date(blocker.blockedAt).toISOString() !== blocker.blockedAt))
    || (!native && (!Object.hasOwn(blocker, "incidentGeneration") || !Object.hasOwn(blocker, "evidenceDigest")))) reject();
  const ancestor = incidents.find((incident) => incident.incidentId === blocker.incidentId);
  if (!ancestor || ancestor.state !== "superseded" || ancestor.taskId !== task.id
    || ancestor.paidAttempts !== MAX_PAID_ATTEMPTS_PER_GENERATION || !ancestor.openedAt || !ancestor.circuitEventKey
    || blocker.reason !== ancestor.reasonCode
    || (Object.hasOwn(blocker, "incidentGeneration") && blocker.incidentGeneration !== ancestor.generation)
    || (Object.hasOwn(blocker, "evidenceDigest") && blocker.evidenceDigest !== ancestor.evidenceDigest)) reject();
  const current = incidents.filter((incident) => incident.fingerprintDigest === ancestor.fingerprintDigest)
    .sort((a, b) => b.generation - a.generation)[0];
  if (!current || current.generation !== ancestor.generation + 1 || current.state !== "active"
    || current.taskId !== task.id || canonicalJson(current.fingerprint) !== canonicalJson(ancestor.fingerprint)
    || current.evidenceDigest === ancestor.evidenceDigest || current.paidAttempts !== 0
    || current.cheapProbeAttempts !== 1 || current.repairAttempts !== 0 || current.backoffUntil || current.openedAt) reject();
  const proof = replayPrerequisiteRepair(ancestor, current, reject);
  if (Date.parse(current.createdAt) < Date.parse(ancestor.openedAt)
    || (native && (Date.parse(blocker.blockedAt) < Date.parse(ancestor.openedAt)
      || Date.parse(blocker.blockedAt) > Date.parse(current.createdAt)))) reject();
  const groups = new Map();
  for (const incident of incidents) {
    const key = canonicalJson(failureWorkIdentity(incident.fingerprint));
    if (!groups.has(key)) groups.set(key, selectFailureIncident(incidents, incident.fingerprint));
  }
  const supportingAdmissions = [];
  for (const group of groups.values()) {
    if (!group) continue;
    if (group.incident.incidentId === current.incidentId) {
      if (group.paidAttempts !== 0) reject();
    } else {
      if (group.paidAttempts !== 1) reject();
      supportingAdmissions.push(historicalPrerequisiteAdmission(db, task, incidents, ancestor, group.incident, reject));
    }
  }
  if (supportingAdmissions.length > 1 || currentFaults.length !== 1 + supportingAdmissions.length) reject();
  return { schemaVersion: 1, taskId: task.id, previousBlocker: structuredClone(blocker), fingerprintDigest: ancestor.fingerprintDigest,
    ancestorIncidentId: ancestor.incidentId, ancestorGeneration: ancestor.generation, ancestorEvidenceDigest: ancestor.evidenceDigest,
    ancestorRecordDigest: prerequisiteRecordDigest(ancestor), successorIncidentId: current.incidentId, successorGeneration: current.generation,
    successorEvidenceDigest: current.evidenceDigest, successorRecordDigest: prerequisiteRecordDigest(current), verifier: proof.verifier,
    ledgerRecordDigest: prerequisiteRecordDigest(incidents), supportingAdmissions,
    verifiedAt: proof.recordedAt, outcome: "passed" };
}

/** Read-only preparation; the operator writer rechecks this binding under its SQL fence. */
export async function readPrerequisiteFailureRecovery(task) {
  return prerequisiteFailureRecovery(await ensureReadOnlyStateDatabase(), task);
}

function freezeOperatorVerification(input) {
  const sha = /^[a-f0-9]{40,64}$/;
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.taskId !== "string" || !input.taskId
    || !digest.test(input.requestDigest) || !digest.test(input.scopeDigest)
    || !input.candidate || !["baseSha", "commitSha", "treeSha"].every((key) => sha.test(input.candidate[key]))
    || typeof input.candidate.branch !== "string" || !input.candidate.branch
    || !input.frozenScopePlan || typeof input.frozenScopePlan !== "object"
    || !Array.isArray(input.frozenScopePlan.allowedFileScope) || !input.frozenScopePlan.allowedFileScope.length
    || !Array.isArray(input.dispositionTaskIds) || input.dispositionTaskIds.length > 32
    || input.dispositionTaskIds.some((id) => typeof id !== "string" || !id || id === input.taskId)
    || new Set(input.dispositionTaskIds).size !== input.dispositionTaskIds.length
    || (input.dispositions !== undefined && (!Array.isArray(input.dispositions)
      || input.dispositions.length !== input.dispositionTaskIds.length
      || input.dispositions.some((item) => !item || !input.dispositionTaskIds.includes(item.taskId)
        || !Number.isSafeInteger(item.expectedStateVersion) || item.expectedStateVersion < 1
        || !digest.test(item.evidenceDigest) || !sha.test(item.sourceSha))
      || new Set(input.dispositions.map((item) => item.taskId)).size !== input.dispositions.length))
    || (input.conflictTaskIds !== undefined && (!Array.isArray(input.conflictTaskIds) || input.conflictTaskIds.length > 4096
      || input.conflictTaskIds.some((id) => typeof id !== "string" || !id)
      || new Set(input.conflictTaskIds).size !== input.conflictTaskIds.length))) {
    operatorCandidateError("operator_candidate_verification_invalid");
  }
  const verification = structuredClone(input);
  const freeze = (value) => {
    if (!value || typeof value !== "object") return value;
    for (const item of Object.values(value)) freeze(item);
    return Object.freeze(value);
  };
  return freeze(verification);
}

function assertOperatorCandidateIdle(state, verification, nowMs = Date.now()) {
  const ids = new Set([verification.taskId, ...verification.dispositionTaskIds, ...(verification.conflictTaskIds || [])]);
  if ((state.runs || []).some((run) => ids.has(run.taskId) && ["queued", "running"].includes(run.status))) {
    operatorCandidateError("operator_candidate_active_run");
  }
  const tasks = new Map((state.tasks || []).map((task) => [task.id, task]));
  for (const id of ids) {
    const task = tasks.get(id);
    if (!task) operatorCandidateError("operator_candidate_task_missing");
    for (const claim of [task.workflowLease, task.assignmentClaim]) {
      if (claim && (!Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) > nowMs)) {
        operatorCandidateError("operator_candidate_active_ownership");
      }
    }
  }
}

function assertNativeWorkspaceIngress(state, snapshot, options = {}) {
  for (const run of state.runs || []) {
    const prior = snapshot.tables.runs.get(run.id)?.payload;
    const previous = prior ? JSON.parse(prior) : null;
    const workspaceChanged = NATIVE_WORKSPACE_AUTHORITY_FIELDS.some((field) => JSON.stringify(previous?.[field]) !== JSON.stringify(run[field]));
    const hadWorkspace = previous && NATIVE_WORKSPACE_AUTHORITY_FIELDS.some((field) => Object.hasOwn(previous, field));
    if ((hadWorkspace || workspaceChanged) && previous
      && NATIVE_WORKSPACE_IDENTITY_FIELDS.some((field) => previous[field] !== run[field])) {
      operatorCandidateError("native_workspace_run_identity_immutable");
    }
    if (workspaceChanged && (!previous || options.nativeWorkspaceCapability !== NATIVE_WORKSPACE_WRITE
      || options.nativeWorkspaceRunId !== run.id)) {
      operatorCandidateError("native_workspace_verified_writer_required");
    }
  }
}

function assertOperatorCandidateIngress(state, snapshot, options = {}, verifyOrdinaryHandoff = false) {
  const verification = options.operatorCandidateCapability === OPERATOR_CANDIDATE_WRITE
    ? options.operatorCandidateVerification : null;
  const tasks = new Map((state.tasks || []).map((task) => [task.id, task]));
  for (const disposition of verification?.dispositions || []) {
    if (!disposition.failureRecovery) continue;
    const previousRuns = [...snapshot.tables.runs.values()].map((item) => JSON.parse(item.payload))
      .filter((run) => run.taskId === disposition.taskId).sort((a, b) => a.id.localeCompare(b.id));
    const proposedRuns = (state.runs || []).filter((run) => run.taskId === disposition.taskId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (canonicalJson(previousRuns) !== canonicalJson(proposedRuns)) operatorCandidateError("operator_prerequisite_run_changed");
  }
  let persistedRuns;
  for (const [id, prior] of snapshot.tables.tasks) {
    const previous = JSON.parse(prior.payload);
    if (previous.operatorIntake && !tasks.has(id)) operatorCandidateError("operator_intake_history_immutable");
    if (previous.preexistingWorkDisposition && !tasks.has(id)) operatorCandidateError("preexisting_work_disposition_immutable");
  }
  for (const task of state.tasks || []) {
    const prior = snapshot.tables.tasks.get(task.id)?.payload;
    const previous = prior ? JSON.parse(prior) : null;
    const oldScope = previous?.impactScopePlan || previous?.impactPlan;
    const nextScope = task.impactScopePlan || task.impactPlan;
    const scopeAuthorityChanged = JSON.stringify(oldScope) !== JSON.stringify(nextScope)
      || (previous?.impactScopePlan && JSON.stringify(previous.impactScopePlan) !== JSON.stringify(task.impactScopePlan));
    const adoptionAuthorized = verification?.taskId === task.id;
    if (canonicalJson(previous?.preexistingWorkDisposition || null) !== canonicalJson(task.preexistingWorkDisposition || null)) {
      if (previous?.preexistingWorkDisposition) operatorCandidateError("preexisting_work_disposition_immutable");
      const disposition = verification?.dispositions?.find((item) => item.taskId === task.id);
      const receipt = task.preexistingWorkDisposition;
      if (!disposition || !verification.dispositionTaskIds.includes(task.id) || task.status !== "closed"
        || receipt?.kind !== "preexisting_work_verified" || receipt.schemaVersion !== 1
        || Object.entries(disposition).some(([key, value]) => canonicalJson(receipt[key] ?? null) !== canonicalJson(value ?? null))
        || (previous?.automationBlocker && !disposition.failureRecovery)) {
        operatorCandidateError("preexisting_work_disposition_verified_writer_required");
      }
    }
    const intakeChanged = JSON.stringify(previous?.operatorIntake) !== JSON.stringify(task.operatorIntake);
    if (intakeChanged) {
      if (!adoptionAuthorized) operatorCandidateError(previous?.operatorIntake ? "operator_intake_history_immutable" : "operator_intake_verified_writer_required");
      if (previous?.operatorIntake) {
        if (previous.operatorIntake.candidate?.treeSha === verification.candidate.treeSha) {
          operatorCandidateError("operator_candidate_unchanged_material");
        }
        const receipt = (state.events || []).find((event) => !snapshot.tables.events.has(event.id)
          && event.type === "operator_candidate_superseded" && event.taskId === task.id
          && event.replacementRequestDigest === verification.requestDigest
          && JSON.stringify(event.previousOperatorIntake) === JSON.stringify(previous.operatorIntake));
        if (!receipt) operatorCandidateError("operator_intake_history_receipt_required");
      }
      const intake = task.operatorIntake;
      if (!intake || intake.requestDigest !== verification.requestDigest || intake.scopeDigest !== verification.scopeDigest
        || canonicalJson(intake.candidate) !== canonicalJson(verification.candidate)
        || !["baseSha", "commitSha", "treeSha", "branch"].every((key) => task.candidateIdentity?.[key] === verification.candidate[key])
        || task.status !== "builder_review" || task.reviewSubjectSha !== verification.candidate.commitSha) {
        operatorCandidateError("operator_candidate_binding_mismatch");
      }
      const scope = task.impactScopePlan || task.impactPlan;
      if (JSON.stringify(scope) !== JSON.stringify(verification.frozenScopePlan)
        || (oldScope && (JSON.stringify(previous.impactScopePlan) !== JSON.stringify(task.impactScopePlan)
          || JSON.stringify(previous.impactPlan) !== JSON.stringify(task.impactPlan)))) {
        operatorCandidateError("operator_candidate_frozen_scope_mismatch");
      }
    }
    if (scopeAuthorityChanged && options.scopedDispatchCapability !== SCOPED_DISPATCH_WRITE && !adoptionAuthorized) {
      operatorCandidateError("frozen_scope_verified_writer_required");
    }
    const candidateChanged = !previous || previous.reviewSubjectSha !== task.reviewSubjectSha
      || Number(previous.reviewSubjectCycle || 0) !== Number(task.reviewSubjectCycle || 0)
      || canonicalJson(previous.candidateIdentity || {}) !== canonicalJson(task.candidateIdentity || {})
      || canonicalJson(previous.impactEvidence || {}) !== canonicalJson(task.impactEvidence || {});
    const reviewCandidateChanged = ["backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review", "qa_review", "user_review"]
      .includes(task.status) && task.reviewSubjectSha && candidateChanged;
    const handoff = reviewCandidateChanged || (task.status === "builder_review" && (!previous || previous.status !== task.status
      || previous.reviewSubjectSha !== task.reviewSubjectSha
      || Number(previous.reviewSubjectCycle || 0) !== Number(task.reviewSubjectCycle || 0)
      || candidateChanged));
    if (handoff && !(adoptionAuthorized && intakeChanged)) {
      if (!oldScope) operatorCandidateError("builder_handoff_frozen_scope_required");
      if (!verifyOrdinaryHandoff) operatorCandidateError("builder_handoff_verified_mutation_required");
      const project = (state.projects || []).find((item) => item.id === task.projectId);
      if (!project) operatorCandidateError("builder_handoff_project_missing");
      // New or edited run rows in this proposal cannot authorize another source
      // root. Only the prior persisted snapshot supplies native run provenance.
      persistedRuns ||= [...snapshot.tables.runs.values()].map((run) => JSON.parse(run.payload));
      verifyScopedBuilderHandoff(project, task, oldScope, { persistedRuns });
    }
  }
}

// Coordination writers do not all change the global state version. Recheck
// their authoritative rows while holding the final SQLite transaction lock.
function assertOperatorCandidateCommitFence(db, verification) {
  if (!verification) return;
  const ids = [...new Set([verification.taskId, ...verification.dispositionTaskIds, ...(verification.conflictTaskIds || [])])];
  const nowMs = Date.now();
  const placeholders = ids.map(() => "?").join(", ");
  const leases = db.prepare(`SELECT expires_at FROM coordination_leases WHERE aggregate_id IN (${placeholders}) AND status = 'active'`).all(...ids);
  if (leases.some((lease) => !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) > nowMs)) {
    operatorCandidateError("operator_candidate_coordination_lease_active");
  }
  const tasks = db.prepare(`SELECT payload FROM tasks WHERE id IN (${placeholders})`).all(...ids).map((row) => parsePayload(row.payload, {}));
  const runs = db.prepare(`SELECT payload FROM runs WHERE task_id IN (${placeholders}) AND status IN ('queued', 'running')`).all(...ids).map((row) => parsePayload(row.payload, {}));
  assertOperatorCandidateIdle({ tasks, runs }, verification, nowMs);
  for (const disposition of verification.dispositions || []) {
    const task = tasks.find((item) => item.id === disposition.taskId);
    if (!task || positiveStateVersion(task.stateVersion) !== disposition.expectedStateVersion) {
      operatorCandidateError("operator_prerequisite_state_changed");
    }
    const current = prerequisiteFailureRecovery(db, task);
    if (canonicalJson(current) !== canonicalJson(disposition.failureRecovery || null)) {
      operatorCandidateError("operator_prerequisite_failure_changed");
    }
  }
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
  for (const field of [
    "qaPacket",
    "invalidation",
    "qaDecision",
    "qaRevocationIntent",
    "qaRevocationSettlement",
    "promotion",
    "promotionMerge",
    "promotionValidationRecoveryReceipt",
  ]) {
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

function exactIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : "";
}

function assertDurableCandidateInvalidation(candidate) {
  const invalidation = candidate?.invalidation;
  if (!invalidation || typeof invalidation !== "object" || Array.isArray(invalidation)) {
    throw new Error(`Candidate ${candidate?.id || "(missing)"} invalidation record is incomplete.`);
  }
  const keys = Object.keys(invalidation).sort();
  const expectedKeys = ["expected", "observed", "observedAt", "reason"];
  if (
    canonicalJson(keys) !== canonicalJson(expectedKeys)
    || typeof invalidation.reason !== "string"
    || !invalidation.reason.trim()
    || invalidation.reason !== invalidation.reason.trim()
    || typeof invalidation.expected !== "string"
    || invalidation.expected !== invalidation.expected.trim()
    || typeof invalidation.observed !== "string"
    || invalidation.observed !== invalidation.observed.trim()
    || !exactIsoTimestamp(invalidation.observedAt)
    || candidate.updatedAt !== invalidation.observedAt
  ) {
    throw new Error(`Candidate ${candidate.id} invalidation record must use the exact durable invalidation schema.`);
  }
  return invalidation;
}

function assertCandidateStatusTransition(previousCandidate, candidate, options = {}) {
  if (previousCandidate.status === candidate.status) return;

  // Invalidation is the one intentionally fail-closed transition available to
  // generic writers. It must add the durable invalidation record atomically so
  // a status-only rewrite cannot later be bounced back into active authority.
  if (
    candidate.status === "invalidated"
    && !previousCandidate.invalidation
    && candidate.invalidation
  ) {
    assertDurableCandidateInvalidation(candidate);
    return;
  }

  const exactInitialQaDecision = (
    previousCandidate.status === "frozen"
    && !previousCandidate.qaDecision
    && candidate.qaDecision
    && ["passed", "failed"].includes(candidate.qaDecision.outcome)
    && candidate.status === (candidate.qaDecision.outcome === "passed" ? "qa_passed" : "qa_failed")
    && options.candidateQaDecisionCapability === CANDIDATE_QA_DECISION_WRITE
    && options.candidateQaDecisionCandidateId === candidate.id
    && JSON.stringify(options.candidateQaDecisionRecord) === JSON.stringify(candidate.qaDecision)
  );
  if (exactInitialQaDecision) return;

  const exactPromotionHandoff = (
    previousCandidate.status === "qa_passed"
    && candidate.status === "release_candidate_ready"
    && !previousCandidate.promotion
    && candidate.promotion
    && options.candidatePromotionCapability === CANDIDATE_PROMOTION_WRITE
    && options.candidatePromotionCandidateId === candidate.id
    && JSON.stringify(options.candidatePromotionRecord) === JSON.stringify(candidate.promotion)
  );
  if (exactPromotionHandoff) return;

  const exactPromotionMerge = (
    previousCandidate.status === "release_candidate_ready"
    && candidate.status === "merged"
    && !previousCandidate.promotionMerge
    && candidate.promotionMerge
    && options.candidatePromotionCapability === CANDIDATE_PROMOTION_WRITE
    && options.candidatePromotionCandidateId === candidate.id
    && JSON.stringify(options.candidatePromotionMergeRecord) === JSON.stringify(candidate.promotionMerge)
  );
  if (exactPromotionMerge) return;

  throw new Error(
    `Candidate ${candidate.id} status transition ${previousCandidate.status} -> ${candidate.status} requires its exact fenced lifecycle writer.`,
  );
}

function assertCandidateTransition(previousCandidate, candidate, options = {}) {
  assertCandidateEnvelope(candidate);
  assertCandidateQaRevocationRecords(candidate);
  if (!previousCandidate.qaRevocationIntent && candidate.qaRevocationIntent) {
    if (!["qa_passed", "release_candidate_ready"].includes(candidate.status)) {
      throw new Error(`Candidate ${candidate.id} QA revocation intent can only begin while QA-passed or release-candidate ready.`);
    }
    if (
      options.qaRevocationIntentCapability !== QA_REVOCATION_INTENT_WRITE
      || options.qaRevocationIntentCandidateId !== candidate.id
      || JSON.stringify(options.qaRevocationIntentRecord) !== JSON.stringify(candidate.qaRevocationIntent)
    ) {
      throw new Error(`Candidate ${candidate.id} QA revocation intent requires the fenced owner-QA writer.`);
    }
  }
  if (!previousCandidate.qaRevocationSettlement && candidate.qaRevocationSettlement && !previousCandidate.qaRevocationIntent) {
    throw new Error(`Candidate ${candidate.id} QA revocation settlement requires a previously durable intent.`);
  }
  if (
    !previousCandidate.qaRevocationSettlement
    && candidate.qaRevocationSettlement
    && (
      options.qaRevocationSettlementCapability !== QA_REVOCATION_SETTLEMENT_WRITE
      || options.qaRevocationSettlementCandidateId !== candidate.id
      || JSON.stringify(options.qaRevocationSettlementRecord) !== JSON.stringify(candidate.qaRevocationSettlement)
    )
  ) {
    throw new Error(`Candidate ${candidate.id} QA revocation settlement requires the fenced remote-observation writer.`);
  }
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
  if (
    !previousCandidate.qaDecision
    && candidate.qaDecision
    && (
      options.candidateQaDecisionCapability !== CANDIDATE_QA_DECISION_WRITE
      || options.candidateQaDecisionCandidateId !== candidate.id
      || JSON.stringify(options.candidateQaDecisionRecord) !== JSON.stringify(candidate.qaDecision)
    )
  ) {
    throw new Error(`Candidate ${candidate.id} initial QA decision requires the fenced owner-QA writer.`);
  }
  for (const field of ["promotion", "promotionMerge", "promotionValidationRecoveryReceipt"]) {
    if (
      !previousCandidate[field]
      && candidate[field]
      && (
        options.candidatePromotionCapability !== CANDIDATE_PROMOTION_WRITE
        || options.candidatePromotionCandidateId !== candidate.id
        || JSON.stringify(options[`candidate${field[0].toUpperCase()}${field.slice(1)}Record`])
          !== JSON.stringify(candidate[field])
      )
    ) {
      throw new Error(`Candidate ${candidate.id} initial ${field} authority requires the fenced promotion writer.`);
    }
  }
  assertAppendOnlyCandidateFields(previousCandidate, candidate);
  assertCandidateStatusTransition(previousCandidate, candidate, options);
}

function assertNewCandidateHasNoGrantedAuthority(candidate) {
  if (candidate.status !== "frozen") {
    throw new Error(`Candidate ${candidate.id} must begin in exactly frozen status.`);
  }
  if (candidate.qaRevocationIntent || candidate.qaRevocationSettlement) {
    throw new Error(`Candidate ${candidate.id} cannot begin with QA revocation records.`);
  }
  if (candidate.qaDecision || candidate.promotion || candidate.promotionMerge) {
    throw new Error(`Candidate ${candidate.id} cannot begin with QA, promotion, or merge authority.`);
  }
  if (candidate.promotionValidationRecoveryReceipt) {
    throw new Error(`Candidate ${candidate.id} cannot begin with promotion validation authority.`);
  }
}

function assertNewOwnerQaPacketIsCurrent(state, candidate) {
  if (!candidate.qaPacket) return;
  const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  assertCurrentOwnerQaPacket(state, candidate, bundle);
}

const CANDIDATE_QA_DECISION_FIELDS = [
  "author",
  "candidateId",
  "decidedAt",
  "integrationSha",
  "manifestDigest",
  "notes",
  "outcome",
  "ownerQaPacketDigest",
  "repositoryVerifiedAt",
  "taskIds",
];

function exactQaDecisionMirror(record, decision) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (canonicalJson(record) === canonicalJson(decision)) return true;
  const { taskIds: _taskIds, ...taskDecision } = decision;
  return canonicalJson(record) === canonicalJson(taskDecision);
}

function assertInitialCandidateQaDecisionAuthority(state, candidate, verification, expectedPacket) {
  const decision = candidate?.qaDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`Candidate ${candidate?.id || "(missing)"} QA decision record is required.`);
  }
  if (canonicalJson(Object.keys(decision).sort()) !== canonicalJson(CANDIDATE_QA_DECISION_FIELDS)) {
    throw new Error(`Candidate ${candidate.id} QA decision record has unsupported or missing fields.`);
  }
  const expectedTaskIds = candidate.manifest.sources.map((source) => String(source.taskId)).sort();
  const decisionTaskIds = Array.isArray(decision.taskIds)
    ? decision.taskIds.map((taskId) => String(taskId).trim()).sort()
    : [];
  const expectedStatus = decision.outcome === "passed" ? "qa_passed" : "qa_failed";
  const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  const packet = assertOwnerQaPacket(candidate.qaPacket, candidate, bundle);
  if (
    !["passed", "failed"].includes(decision.outcome)
    || candidate.status !== expectedStatus
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || decision.integrationSha !== candidate.manifest.integration.sha
    || decision.ownerQaPacketDigest !== packet.packetDigest
    || canonicalJson(packet) !== canonicalJson(expectedPacket)
    || bundle?.packetDigest !== packet.packetDigest
    || canonicalJson(bundle?.qaPacket) !== canonicalJson(packet)
    || canonicalJson(decisionTaskIds) !== canonicalJson(expectedTaskIds)
    || decisionTaskIds.length !== decision.taskIds.length
    || typeof decision.author !== "string"
    || !decision.author.trim()
    || decision.author !== decision.author.trim()
    || typeof decision.notes !== "string"
    || decision.notes !== decision.notes.trim()
    || !exactIsoTimestamp(decision.decidedAt)
    || candidate.updatedAt !== decision.decidedAt
    || !bundle
    || bundle.status !== decision.outcome
    || bundle.updatedAt !== decision.decidedAt
    || canonicalJson(bundle.qaDecision) !== canonicalJson(decision)
  ) {
    throw new Error(`Candidate ${candidate.id} QA decision is not completely bound to its immutable candidate, tasks, packet, author, and time.`);
  }
  if (decision.outcome === "passed") {
    const project = (state.projects || []).find((item) => item.id === candidate.projectId);
    if (!project) throw new Error(`Candidate ${candidate.id} QA decision has no project authority.`);
    assertCandidateRepositoryVerificationObservation(project, candidate, verification);
    if (
      !exactIsoTimestamp(decision.repositoryVerifiedAt)
      || decision.repositoryVerifiedAt !== verification.verifiedAt
      || Date.parse(decision.decidedAt) < Date.parse(decision.repositoryVerifiedAt)
    ) {
      throw new Error(`Candidate ${candidate.id} QA decision does not bind the attested repository verification time.`);
    }
  } else if (decision.repositoryVerifiedAt !== "" || verification !== null) {
    throw new Error(`Candidate ${candidate.id} failed QA decision cannot claim repository verification.`);
  }
  for (const source of candidate.manifest.sources) {
    const task = (state.tasks || []).find((item) => item.id === source.taskId);
    const expectedTaskStatus = decision.outcome === "passed" ? "approved_for_main" : "needs_changes";
    const expectedRole = decision.outcome === "passed" ? "promotion-worker" : "builder";
    if (
      !task
      || task.projectId !== candidate.projectId
      || task.candidateId !== candidate.id
      || task.qaBundleId !== candidate.qaBundleId
      || task.candidateManifestDigest !== candidate.manifestDigest
      || task.integrationCommit !== candidate.manifest.integration.sha
      || String(task.reviewSubjectSha || "").toLowerCase() !== source.headSha
      || Number(task.reviewSubjectCycle) !== Number(source.candidateCycle)
      || task.status !== expectedTaskStatus
      || task.assignedAgentRole !== expectedRole
      || task.updatedAt !== decision.decidedAt
      || !exactQaDecisionMirror(task.qaDecision, decision)
    ) {
      throw new Error(`Candidate ${candidate.id} QA decision task ${source.taskId} is not an exact authority mirror.`);
    }
  }
  return decision;
}

function taskHasExactPromotionCircuit(task, candidate, claim) {
  const circuit = task?.automationCircuit;
  const blocker = task?.automationBlocker;
  if (
    task?.status !== "blocked"
    || task.assignedAgentRole !== "owner"
    || circuit?.state !== "open"
    || circuit?.scope !== "task"
    || circuit?.snapshot?.status !== "promotion_blocked"
    || circuit?.snapshot?.assignedAgentRole !== "promotion-worker"
    || blocker?.type !== "circuit"
    || blocker?.resumeStatus !== "promotion_blocked"
    || !claim
    || !String(claim.claimId || "")
    || !Number.isSafeInteger(Number(claim.fence))
    || Number(claim.fence) < 1
  ) return false;
  const evidence = task.promotionEvidence;
  return !evidence || (
    evidence.candidateId === candidate.id
    && evidence.manifestDigest === candidate.manifestDigest
    && evidence.claimId === claim.claimId
    && Number(evidence.claimFence) === Number(claim.fence)
  );
}

function taskHasPromotionExposureAuthority(task, candidate, status, claim) {
  if (
    !task
    || task.projectId !== candidate.projectId
    || task.candidateId !== candidate.id
    || task.qaBundleId !== candidate.qaBundleId
    || task.candidateManifestDigest !== candidate.manifestDigest
    || task.integrationCommit !== candidate.manifest.integration.sha
  ) return false;
  if (status === "blocked") return taskHasExactPromotionCircuit(task, candidate, claim);
  if (candidate.status === "qa_passed") {
    if (status === "approved_for_main") return task.assignedAgentRole === "promotion-worker";
    if (status === "promotion_blocked") {
      return ["owner", "promotion-worker"].includes(task.assignedAgentRole);
    }
    return false;
  }
  if (status === "user_review") return task.assignedAgentRole === "owner";
  if (status === "promotion_blocked") {
    return ["owner", "promotion-worker"].includes(task.assignedAgentRole);
  }
  return ["merged", "deployed", "done"].includes(status);
}

function exactIntegrityMigrationPreservation(state, candidate, bundle, options = {}) {
  const snapshot = options.stateIntegrityMigrationSnapshot;
  if (
    options.stateIntegrityMigrationCapability !== STATE_INTEGRITY_MIGRATION_WRITE
    || !snapshot?.tables
    || snapshot.tables.candidates.get(candidate.id)?.payload !== JSON.stringify(candidate)
    || snapshot.tables.qaBundles.get(bundle.id)?.payload !== JSON.stringify(bundle)
  ) return false;
  const tasks = new Map((state.tasks || []).map((task) => [task.id, task]));
  return candidate.manifest.sources.every((source) => (
    snapshot.tables.tasks.get(source.taskId)?.payload === JSON.stringify(tasks.get(source.taskId))
  ));
}

/**
 * Older retention passes emptied summaries on already-merged bundles. Validate
 * that terminal history against its frozen packet, without rewriting storage or
 * granting it fresh QA/promotion authority. All packet digest/identity checks and
 * append-only lifecycle guards still run. Active or incomplete history gets no
 * compatibility treatment.
 */
function historicalOwnerQaBundle(candidate, bundle) {
  if (
    candidate.status !== "merged" || bundle?.status !== "merged"
    || !Array.isArray(bundle.tasks) || bundle.tasks.length !== 0
    || candidate.qaPacket?.schemaVersion !== "studioops.owner-qa-packet.v2"
  ) return bundle;
  const packet = candidate.qaPacket;
  const decision = candidate.qaDecision;
  const promotion = candidate.promotion;
  const merge = candidate.promotionMerge;
  const taskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  if (
    !taskIds.length
    || decision?.outcome !== "passed"
    || typeof decision.author !== "string" || !decision.author.trim()
    || !exactIsoTimestamp(decision.decidedAt)
    || !exactIsoTimestamp(decision.repositoryVerifiedAt)
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || decision.integrationSha !== candidate.manifest.integration.sha
    || decision.ownerQaPacketDigest !== packet.packetDigest
    || canonicalJson(decision.taskIds) !== canonicalJson(taskIds)
    || canonicalJson(bundle.qaDecision) !== canonicalJson(decision)
    || !promotion || promotion.manifestDigest !== candidate.manifestDigest
    || typeof promotion.branch !== "string" || !promotion.branch.trim()
    || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(promotion.prUrl || "")
    || promotion.commitSha !== candidate.manifest.integration.sha
    || bundle.promotionCommit !== promotion.commitSha
    || bundle.promotionBranch !== promotion.branch
    || bundle.promotionPrUrl !== promotion.prUrl
    || !exactIsoTimestamp(promotion.readyAt)
    || bundle.promotionReadyAt !== promotion.readyAt
    || canonicalJson([...(bundle.promotedTaskIds || [])].sort()) !== canonicalJson(taskIds)
    || !merge || !/^[a-f0-9]{40}$/.test(merge.mergeCommit || "")
    || !exactIsoTimestamp(merge.mergedAt)
    || !exactIsoTimestamp(merge.reconciledAt)
    || bundle.promotionMergeCommit !== merge.mergeCommit
    || bundle.promotionMergedAt !== merge.mergedAt
    || canonicalJson(packet) !== canonicalJson(bundle.qaPacket)
    || bundle.packetDigest !== packet.packetDigest
  ) return bundle;
  // This temporary view never escapes validation and is never persisted.
  return { ...bundle, tasks: packet.tasks };
}

function assertOwnerQaPacketMirrors(state, options = {}) {
  const candidatesById = new Map((state.candidates || []).map((candidate) => [candidate.id, candidate]));
  const bundlesById = new Map((state.qaBundles || []).map((bundle) => [bundle.id, bundle]));
  for (const candidate of state.candidates || []) {
    if (!candidate.qaPacket) continue;
    // A durable invalidation permanently revokes this packet's authority. Older
    // compaction passes could remove the bundle's task summaries afterwards,
    // so only active packets need to satisfy the current bundle-shape mirror.
    // Append-only transition guards still protect the historical packet itself.
    if (candidate.invalidation) continue;
    const bundle = bundlesById.get(candidate.qaBundleId);
    if (!bundle) throw new Error(`Candidate ${candidate.id} owner QA packet has no immutable bundle.`);
    const packet = assertOwnerQaPacket(candidate.qaPacket, candidate, historicalOwnerQaBundle(candidate, bundle));
    if (
      bundle.packetDigest !== packet.packetDigest
      || JSON.stringify(bundle.qaPacket) !== JSON.stringify(packet)
    ) {
      throw new Error(`Candidate ${candidate.id} and QA bundle ${bundle.id} owner packet mirrors differ.`);
    }
    // A migration may carry a pre-existing legacy release handoff through to
    // the new schema only when the candidate, bundle, and every source task are
    // byte-for-byte unchanged from the locked database snapshot. The dedicated
    // recovery writer must still reconcile that unsafe lifecycle afterwards.
    if (
      candidate.status === "release_candidate_ready"
      && packet.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION
      && exactIntegrityMigrationPreservation(state, candidate, bundle, options)
    ) continue;
    if (
      !candidate.invalidation
      && ["frozen", "qa_passed", "release_candidate_ready"].includes(candidate.status)
    ) {
      const legacyPacket = packet.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION;
      if (!legacyPacket) {
        assertCurrentOwnerQaPacket(state, candidate, bundle);
      } else if (candidate.status === "release_candidate_ready") {
        const exactRecoveryWriter = options.mergedPromotionRecoveryCapability === MERGED_PROMOTION_RECOVERY_WRITE
          && options.mergedPromotionRecoveryCandidateId === candidate.id;
        const exactClaimWriter = options.promotionClaimCapability === PROMOTION_CLAIM_WRITE
          && options.promotionClaimCandidateId === candidate.id;
        const exactPromotionWriter = options.candidatePromotionCapability === CANDIDATE_PROMOTION_WRITE
          && options.candidatePromotionCandidateId === candidate.id;
        if (!exactRecoveryWriter && !exactClaimWriter && !exactPromotionWriter) {
          throw new Error(
            `Legacy release candidate ${candidate.id} is fenced to its attested reconciliation writers.`,
          );
        }
      }
      const hasPromotionClaim = candidate.status === "qa_passed"
        && Boolean(state.meta?.promotionAttemptClaims?.[candidate.id]);
      if (legacyPacket && hasPromotionClaim) {
        throw new Error(`Legacy QA-passed candidate ${candidate.id} cannot acquire new promotion authority.`);
      }
      if (candidate.status === "release_candidate_ready" || hasPromotionClaim) {
        const promotionClaim = state.meta?.promotionAttemptClaims?.[candidate.id];
        const expectedBundleStatus = candidate.status === "release_candidate_ready"
          ? "release_candidate_ready"
          : "passed";
        if (candidate.status === "release_candidate_ready") {
          const project = (state.projects || []).find((item) => item.id === candidate.projectId);
          const repository = project
            ? assertCanonicalCandidateRepositoryAuthority(project).repository
            : "";
          const promotion = candidate.promotion;
          const sourceTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
          const promotedTaskIds = (bundle.promotedTaskIds || []).map(String).sort();
          if (
            !promotion
            || githubPullRequestRepository(promotion.prUrl) !== repository
            || !String(promotion.branch || "").trim()
            || promotion.prUrl !== bundle.promotionPrUrl
            || promotion.branch !== bundle.promotionBranch
            || promotion.commitSha !== candidate.manifest.integration.sha
            || promotion.commitSha !== bundle.promotionCommit
            || promotion.manifestDigest !== candidate.manifestDigest
            || !Number.isFinite(Date.parse(promotion.readyAt || ""))
            || JSON.stringify(promotedTaskIds) !== JSON.stringify(sourceTaskIds)
          ) {
            throw new Error(`Release candidate ${candidate.id} must preserve an exact same-repository promotion handoff and bundle mirror.`);
          }
        }
        if (
          bundle.status !== expectedBundleStatus
          || candidate.manifest.sources.some((source) => {
            const task = (state.tasks || []).find((item) => item.id === source.taskId);
            return !taskHasPromotionExposureAuthority(task, candidate, task?.status, promotionClaim);
          })
        ) {
          throw new Error(`Promotion-exposed candidate ${candidate.id} must remain in a reconciliation-safe task and bundle lifecycle with exact authority links and assignments.`);
        }
      }
    }
  }
  for (const bundle of state.qaBundles || []) {
    const hasPacket = Boolean(bundle.qaPacket);
    const hasDigest = Boolean(bundle.packetDigest);
    if (hasPacket !== hasDigest) {
      throw new Error(`QA bundle ${bundle.id} owner packet and digest must be persisted together.`);
    }
    if (!hasPacket) continue;
    const candidate = candidatesById.get(bundle.candidateId);
    if (!candidate?.qaPacket) {
      throw new Error(`QA bundle ${bundle.id} owner packet has no matching candidate packet.`);
    }
    if (candidate.invalidation) continue;
    const packet = assertOwnerQaPacket(bundle.qaPacket, candidate, historicalOwnerQaBundle(candidate, bundle));
    if (
      candidate.qaPacket.packetDigest !== packet.packetDigest
      || bundle.packetDigest !== packet.packetDigest
      || JSON.stringify(candidate.qaPacket) !== JSON.stringify(packet)
    ) {
      throw new Error(`QA bundle ${bundle.id} and candidate ${candidate.id} owner packet mirrors differ.`);
    }
  }
}

function assertActiveCandidatesDoNotUseInvalidatedReviews(state) {
  const invalidatedReviewIds = new Set(
    (state.reviews || [])
      .filter((review) => review.invalidatedAt || review.invalidation)
      .map((review) => review.id),
  );
  if (!invalidatedReviewIds.size) return;
  for (const candidate of state.candidates || []) {
    if (
      candidate.invalidation
      || !["frozen", "qa_passed", "release_candidate_ready"].includes(candidate.status)
    ) continue;
    const invalidatedReview = candidate.manifest?.sources
      ?.flatMap((source) => source.reviews || [])
      .find((review) => invalidatedReviewIds.has(review.id));
    if (invalidatedReview) {
      throw new Error(
        `Candidate ${candidate.id} still grants authority from invalidated review ${invalidatedReview.id}; invalidate the candidate in the same transaction.`,
      );
    }
  }
}

function quarantineLegacyCandidatesWithInvalidatedReviews(state, migratedAt) {
  const invalidatedReviews = new Map(
    (state.reviews || [])
      .filter((review) => review.invalidatedAt || review.invalidation)
      .map((review) => [review.id, review]),
  );
  const quarantined = [];
  for (const candidate of state.candidates || []) {
    if (
      candidate.invalidation
      || !["frozen", "qa_passed", "release_candidate_ready"].includes(candidate.status)
    ) continue;
    const review = (candidate.manifest?.sources || [])
      .flatMap((source) => source.reviews || [])
      .map((entry) => invalidatedReviews.get(entry.id))
      .filter(Boolean)
      .sort((left, right) => (
        String(left.invalidatedAt || left.invalidation?.invalidatedAt || "")
          .localeCompare(String(right.invalidatedAt || right.invalidation?.invalidatedAt || ""))
        || String(left.id).localeCompare(String(right.id))
      ))[0];
    if (!review) continue;
    const observedAt = exactIsoTimestamp(review.invalidatedAt)
      || exactIsoTimestamp(review.invalidation?.invalidatedAt)
      || exactIsoTimestamp(candidate.updatedAt)
      || exactIsoTimestamp(candidate.createdAt)
      || migratedAt;
    const reasonCode = typeof review.invalidation?.reasonCode === "string"
      && review.invalidation.reasonCode.trim()
      ? review.invalidation.reasonCode.trim()
      : "legacy_review_invalidated";
    candidate.status = "invalidated";
    candidate.invalidation = {
      reason: `Integrity migration quarantined candidate ${candidate.id} because source review ${review.id} was already invalidated.`,
      expected: `review:${review.id}:valid`,
      observed: `review:${review.id}:invalidated:${reasonCode}`,
      observedAt,
    };
    candidate.updatedAt = observedAt;
    const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
    if (bundle) {
      bundle.status = "invalidated";
      bundle.updatedAt = observedAt;
    }
    quarantined.push({ candidateId: candidate.id, reviewId: review.id, observedAt });
  }
  if (quarantined.length) {
    state.meta = state.meta || {};
    state.meta.candidateReviewIntegrityQuarantine = {
      schemaVersion: 1,
      integrityVersion: STATE_INTEGRITY_VERSION,
      candidateIds: quarantined.map((item) => item.candidateId),
      records: quarantined,
      migratedAt,
    };
  }
  return quarantined;
}

function exactCandidateQaDecisionWriter(options, candidate) {
  return Boolean(
    candidate
    && (
      (
        options.candidateQaDecisionCapability === CANDIDATE_QA_DECISION_WRITE
        && options.candidateQaDecisionCandidateId === candidate.id
        && canonicalJson(options.candidateQaDecisionRecord) === canonicalJson(candidate.qaDecision)
      )
      || hasTrustedTestFixtureLegacyAuthorityBootstrap(options)
    ),
  );
}

function assertQaBundleTransition(state, previousBundle, bundle, options = {}) {
  const authorityFields = [
    "projectId",
    "candidateId",
    "manifestDigest",
    "integrationBranch",
    "integrationCommit",
    "previewUrl",
    "tasks",
    "qaPacket",
    "packetDigest",
  ];
  if (previousBundle?.qaPacket) {
    for (const field of authorityFields) {
      if (JSON.stringify(previousBundle[field]) !== JSON.stringify(bundle[field])) {
        throw new Error(`QA bundle ${bundle.id} ${field} authority is append-only after its owner packet is frozen.`);
      }
    }
  }
  if (!previousBundle?.qaPacket && bundle.qaPacket) {
    const candidate = (state.candidates || []).find((item) => item.id === bundle.candidateId);
    if (!candidate?.qaPacket) throw new Error(`QA bundle ${bundle.id} owner packet has no matching candidate packet.`);
    assertNewOwnerQaPacketIsCurrent(state, candidate);
  }
  if (
    previousBundle?.qaDecision
    && canonicalJson(previousBundle.qaDecision) !== canonicalJson(bundle.qaDecision)
  ) {
    throw new Error(`QA bundle ${bundle.id} qaDecision authority mirror is append-only.`);
  }
  if (!previousBundle?.qaDecision && bundle.qaDecision) {
    const candidate = (state.candidates || []).find((item) => item.id === bundle.candidateId);
    if (
      !exactCandidateQaDecisionWriter(options, candidate)
      || canonicalJson(bundle.qaDecision) !== canonicalJson(candidate.qaDecision)
    ) {
      throw new Error(`QA bundle ${bundle.id} initial qaDecision authority mirror requires the fenced owner-QA writer.`);
    }
  }
}

function assertTaskQaDecisionTransitions(state, snapshot, options = {}) {
  const currentTasks = new Map((state.tasks || []).map((task) => [task.id, task]));
  const currentCandidates = new Map((state.candidates || []).map((candidate) => [candidate.id, candidate]));
  for (const [taskId, previousRecord] of snapshot.tables.tasks) {
    const previousTask = JSON.parse(previousRecord.payload);
    const task = currentTasks.get(taskId);
    if (!task) {
      if (previousTask.qaDecision) {
        throw new Error(`Task ${taskId} QA decision authority mirror cannot be deleted with its task.`);
      }
      continue;
    }
    if (canonicalJson(previousTask.qaDecision || null) === canonicalJson(task.qaDecision || null)) continue;
    const previousCandidateRecord = previousTask.candidateId
      ? snapshot.tables.candidates.get(previousTask.candidateId)
      : null;
    const previousCandidate = previousCandidateRecord
      ? JSON.parse(previousCandidateRecord.payload)
      : null;
    const previousWasMirror = Boolean(
      previousTask.qaDecision
      && previousCandidate?.qaDecision
      && exactQaDecisionMirror(previousTask.qaDecision, previousCandidate.qaDecision),
    );
    if (previousWasMirror) {
      const candidate = currentCandidates.get(previousCandidate.id);
      // Siblings may submit in separate transactions after the first source
      // invalidates their shared candidate. Detach only the task mirror; the
      // candidate decision and durable invalidation remain append-only above.
      const detachesInvalidatedCandidate = Boolean(
        candidate?.invalidation
        && candidate.status === "invalidated"
        && canonicalJson(candidate.qaDecision) === canonicalJson(previousCandidate.qaDecision)
        && task.qaDecision === null
        && !task.candidateId
        && !task.qaBundleId,
      );
      if (detachesInvalidatedCandidate) continue;
      throw new Error(`Task ${taskId} qaDecision authority mirror is append-only while its candidate remains linked.`);
    }
    if (task.qaDecision) {
      const candidate = currentCandidates.get(task.candidateId);
      if (
        !exactCandidateQaDecisionWriter(options, candidate)
        || !(candidate.manifest?.sources || []).some((source) => source.taskId === task.id)
        || !exactQaDecisionMirror(task.qaDecision, candidate.qaDecision)
      ) {
        throw new Error(`Task ${taskId} initial qaDecision authority mirror requires the fenced owner-QA writer.`);
      }
    }
  }
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
  const newlyInvalidated = !previousReview.invalidatedAt
    && JSON.stringify(previousReview) !== JSON.stringify(review)
    && Boolean(review.invalidatedAt || review.invalidation);
  if (newlyInvalidated) {
    const invalidation = review.invalidation;
    const exactKeys = invalidation && typeof invalidation === "object" && !Array.isArray(invalidation)
      ? Object.keys(invalidation).sort()
      : [];
    if (
      canonicalJson(exactKeys) !== canonicalJson(["action", "invalidatedAt", "reasonCode"])
      || typeof invalidation.action !== "string"
      || !invalidation.action.trim()
      || invalidation.action !== invalidation.action.trim()
      || typeof invalidation.reasonCode !== "string"
      || !invalidation.reasonCode.trim()
      || invalidation.reasonCode !== invalidation.reasonCode.trim()
      || !exactIsoTimestamp(invalidation.invalidatedAt)
      || review.invalidatedAt !== invalidation.invalidatedAt
    ) {
      throw new Error(`Review ${review.id} invalidation must use the exact durable review-invalidation schema.`);
    }
  }
}

function assertFullCandidateHistoryPreserved(db, candidates, options = {}) {
  const currentById = new Map((candidates || []).map((candidate) => [candidate.id, candidate]));
  const previousIds = new Set();
  for (const row of db.prepare("SELECT id, payload FROM candidates").all()) {
    previousIds.add(row.id);
    const previousCandidate = parsePayload(row.payload, null);
    const candidate = currentById.get(row.id);
    if (!candidate) throw new Error(`Candidate ${row.id} cannot be deleted.`);
    assertCandidateTransition(previousCandidate, candidate);
  }
  for (const candidate of candidates || []) {
    assertCandidateEnvelope(candidate);
    assertCandidateQaRevocationRecords(candidate);
    const trustedTestFixtureBootstrap = hasTrustedTestFixtureLegacyAuthorityBootstrap(options);
    if (!previousIds.has(candidate.id) && !trustedTestFixtureBootstrap) {
      assertNewCandidateHasNoGrantedAuthority(candidate);
    }
  }
}

function assertFullReviewHistoryPreserved(db, reviews) {
  const currentById = new Map((reviews || []).map((review) => [review.id, review]));
  for (const row of db.prepare("SELECT id, payload FROM reviews").all()) {
    const previousReview = parsePayload(row.payload, null);
    const review = currentById.get(row.id);
    if (!review) throw new Error(`Review ${row.id} cannot be deleted.`);
    assertReviewTransition(previousReview, review);
  }
}

function assertFullQaAuthorityPreserved(db, state, options = {}) {
  const currentBundles = new Map((state.qaBundles || []).map((bundle) => [bundle.id, bundle]));
  const previousBundles = new Map(
    db.prepare("SELECT id, payload FROM qa_bundles").all()
      .map((row) => [row.id, parsePayload(row.payload, null)]),
  );
  for (const [id, previousBundle] of previousBundles) {
    if (previousBundle?.qaPacket && !currentBundles.has(id)) {
      throw new Error(`QA bundle ${id} owner packet authority cannot be deleted.`);
    }
  }
  for (const bundle of state.qaBundles || []) {
    assertQaBundleTransition(state, previousBundles.get(bundle.id) || null, bundle, options);
  }
  const previousCandidates = new Map(
    db.prepare("SELECT id, payload FROM candidates").all()
      .map((row) => [row.id, parsePayload(row.payload, null)]),
  );
  for (const candidate of state.candidates || []) {
    const previousCandidate = previousCandidates.get(candidate.id);
    if (candidate.qaPacket && !previousCandidate?.qaPacket) {
      assertNewOwnerQaPacketIsCurrent(state, candidate);
    }
  }
}

function promotionClaims(meta) {
  const claims = meta?.promotionAttemptClaims;
  return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
}

function assertPromotionClaimChanges(state, snapshot, options = {}) {
  const previousMeta = JSON.parse(snapshot.meta || "{}");
  const previousClaims = promotionClaims(previousMeta);
  const currentClaims = promotionClaims(state.meta);
  const candidateIds = new Set([...Object.keys(previousClaims), ...Object.keys(currentClaims)]);
  for (const candidateId of candidateIds) {
    const previousPresent = Object.prototype.hasOwnProperty.call(previousClaims, candidateId);
    const currentPresent = Object.prototype.hasOwnProperty.call(currentClaims, candidateId);
    const unchanged = previousPresent === currentPresent
      && (!previousPresent || JSON.stringify(previousClaims[candidateId]) === JSON.stringify(currentClaims[candidateId]));
    if (unchanged) continue;
    const authorizedPresent = options.promotionClaimRecordPresent === true;
    if (
      options.promotionClaimCapability !== PROMOTION_CLAIM_WRITE
      || options.promotionClaimCandidateId !== candidateId
      || authorizedPresent !== currentPresent
      || (currentPresent
        && JSON.stringify(options.promotionClaimRecord) !== JSON.stringify(currentClaims[candidateId]))
    ) {
      throw new Error(`Promotion attempt claim ${candidateId} requires the private claim-transition writer.`);
    }
  }
}

function releaseCandidateHasSafePromotionLifecycle(candidate, tasksById, claim) {
  if (candidate?.status !== "release_candidate_ready" || candidate.invalidation) return false;
  return (candidate.manifest?.sources || []).every((source) => {
    const task = tasksById.get(source.taskId);
    return taskHasPromotionExposureAuthority(task, candidate, task?.status, claim);
  });
}

function assertMergedPromotionRecoveryTransitions(state, snapshot, options = {}) {
  const previousMeta = JSON.parse(snapshot.meta || "{}");
  const previousClaims = promotionClaims(previousMeta);
  const currentClaims = promotionClaims(state.meta);
  const currentCandidates = new Map((state.candidates || []).map((candidate) => [candidate.id, candidate]));
  const currentTasks = new Map((state.tasks || []).map((task) => [task.id, task]));
  for (const [candidateId, previousRecord] of snapshot.tables.candidates) {
    const previousCandidate = JSON.parse(previousRecord.payload);
    if (previousCandidate.status !== "release_candidate_ready" || previousCandidate.invalidation) continue;
    const previousTasks = new Map();
    for (const source of previousCandidate.manifest?.sources || []) {
      const taskRecord = snapshot.tables.tasks.get(source.taskId);
      if (taskRecord) previousTasks.set(source.taskId, JSON.parse(taskRecord.payload));
    }
    if (releaseCandidateHasSafePromotionLifecycle(
      previousCandidate,
      previousTasks,
      previousClaims[candidateId],
    )) continue;
    const currentCandidate = currentCandidates.get(candidateId);
    if (
      !currentCandidate
      || currentCandidate.status !== "release_candidate_ready"
      || currentCandidate.invalidation
      || !releaseCandidateHasSafePromotionLifecycle(
        currentCandidate,
        currentTasks,
        currentClaims[candidateId],
      )
    ) continue;
    const currentSourceTasks = currentCandidate.manifest.sources
      .map((source) => currentTasks.get(source.taskId));
    if (
      options.mergedPromotionRecoveryCapability !== MERGED_PROMOTION_RECOVERY_WRITE
      || options.mergedPromotionRecoveryCandidateId !== candidateId
      || JSON.stringify(options.mergedPromotionRecoveryTaskRecords)
        !== JSON.stringify(currentSourceTasks)
    ) {
      throw new Error(
        `Release candidate ${candidateId} unsafe lifecycle can only regain promotion authority through an attested merged-PR recovery.`,
      );
    }
  }
}

function assertProposedQaAuthorityPreserved(state, snapshot, options = {}) {
  assertHostedRcProtectedState(state, snapshot);
  const candidates = new Map((state.candidates || []).map((candidate) => [candidate.id, candidate]));
  for (const [id, previous] of snapshot.tables.candidates) {
    const candidate = candidates.get(id);
    if (!candidate) throw new Error(`Candidate ${id} cannot be deleted.`);
    assertCandidateTransition(JSON.parse(previous.payload), candidate, options);
  }
  for (const candidate of state.candidates || []) {
    if (snapshot.tables.candidates.has(candidate.id)) continue;
    assertCandidateEnvelope(candidate);
    assertCandidateQaRevocationRecords(candidate);
    assertNewCandidateHasNoGrantedAuthority(candidate);
  }

  const bundles = new Map((state.qaBundles || []).map((bundle) => [bundle.id, bundle]));
  for (const [id, previous] of snapshot.tables.qaBundles) {
    const previousBundle = JSON.parse(previous.payload);
    const bundle = bundles.get(id);
    if (!bundle) {
      if (previousBundle.qaPacket) throw new Error(`QA bundle ${id} owner packet authority cannot be deleted.`);
      continue;
    }
    assertQaBundleTransition(state, previousBundle, bundle, options);
  }
  for (const bundle of state.qaBundles || []) {
    if (!snapshot.tables.qaBundles.has(bundle.id)) assertQaBundleTransition(state, null, bundle, options);
  }
  const reviews = new Map((state.reviews || []).map((review) => [review.id, review]));
  for (const [id, previous] of snapshot.tables.reviews) {
    const review = reviews.get(id);
    if (!review) throw new Error(`Review ${id} cannot be deleted.`);
    assertReviewTransition(JSON.parse(previous.payload), review);
  }
  assertTaskQaDecisionTransitions(state, snapshot, options);
  assertPromotionClaimChanges(state, snapshot, options);
  assertMergedPromotionRecoveryTransitions(state, snapshot, options);
  assertActiveCandidatesDoNotUseInvalidatedReviews(state);
  assertOwnerQaPacketMirrors(state, options);
}

function assertValidTaskStatuses(state) {
  for (const task of state.tasks || []) {
    const status = typeof task.status === "string" ? task.status.trim() : "";
    if (task.status === status && VALID_TASK_STATUSES.has(status)) continue;
    throw new Error(`Task ${task.id} has invalid workflow status: ${task.status || "(missing)"}. Repair it with an explicit canonical status before writing other fields.`);
  }
}

// Validate and serialize before taking SQLite's writer lock. The version fence
// at commit makes these checks authoritative for exactly the snapshot prepared.
function prepareMutationWrite(state, snapshot, options = {}) {
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
  assertOwnerQaPacketMirrors(state, options);
  const plan = { metaPayload: JSON.stringify(state.meta || {}), updatedAt: state.meta?.updatedAt, upserts: [], deletes: [] };
  for (const table of ENTITY_TABLES) {
    const previousItems = snapshot.tables[table];
    const currentIds = new Set();
    for (const [sequence, item] of (state[table] || []).entries()) {
      currentIds.add(item.id);
      const prior = previousItems.get(item.id);
      if (table === "candidates") {
        assertCandidateEnvelope(item);
        assertCandidateQaRevocationRecords(item);
        if (prior) {
          const previousCandidate = JSON.parse(prior.payload);
          assertCandidateTransition(previousCandidate, item, options);
          if (!previousCandidate.qaPacket && item.qaPacket) assertNewOwnerQaPacketIsCurrent(state, item);
        } else {
          assertNewCandidateHasNoGrantedAuthority(item);
          if (item.qaPacket) assertNewOwnerQaPacketIsCurrent(state, item);
        }
      }
      if (table === "qaBundles") {
        assertQaBundleTransition(state, prior ? JSON.parse(prior.payload) : null, item, options);
      }
      if (table === "reviews" && prior) {
        assertReviewTransition(JSON.parse(prior.payload), item);
      }
      const payload = !prior || MUTABLE_ENTITY_TABLES.has(table) || prior.sequence !== sequence
        ? JSON.stringify(item) : "";
      const changed = !prior
        || prior.sequence !== sequence
        || (MUTABLE_ENTITY_TABLES.has(table) && prior.payload !== payload);
      // Detach indexed fields from the mutator's objects as well as freezing the
      // payload bytes; delayed callbacks must not change the prepared SQL values.
      if (changed) plan.upserts.push({ table, item: JSON.parse(payload), sequence, payload });
    }
    const tableName = TABLE_NAME[table] || table;
    for (const id of previousItems.keys()) {
      if (!currentIds.has(id)) {
        if (["candidates", "reviews"].includes(table)) throw new Error(`${table === "candidates" ? "Candidate" : "Review"} ${id} cannot be deleted.`);
        plan.deletes.push({ tableName, id });
      }
    }
  }
  plan.hasChanges = plan.metaPayload !== snapshot.meta || plan.upserts.length > 0 || plan.deletes.length > 0;
  return plan;
}

function applyMutationWrite(db, plan) {
  if (!plan.hasChanges) return;
  const previous = db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get();
  const version = Number(previous?.version || 0) + 1;
  db.prepare(`
    INSERT INTO state_meta(singleton_id, payload, version, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET
      payload = excluded.payload,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(plan.metaPayload, version, plan.updatedAt || new Date().toISOString());
  for (const { table, item, sequence, payload } of plan.upserts) upsertEntity(db, table, item, sequence, payload);
  for (const { tableName, id } of plan.deletes) db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
}

function writeMutationToOpenDatabase(db, state, snapshot, options = {}) {
  applyMutationWrite(db, prepareMutationWrite(state, snapshot, options));
}

function upsertFailureIncidentRow(db, incidentInput) {
  const incident = assertFailureIncident(incidentInput);
  db.prepare(`
    INSERT INTO failure_incidents(
      incident_id, task_id, fingerprint_digest, state, generation, evidence_digest,
      paid_attempts, cheap_probe_attempts, repair_attempts, avoided_retries,
      backoff_until, opened_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(incident_id) DO UPDATE SET
      state = excluded.state,
      evidence_digest = excluded.evidence_digest,
      paid_attempts = excluded.paid_attempts,
      cheap_probe_attempts = excluded.cheap_probe_attempts,
      repair_attempts = excluded.repair_attempts,
      avoided_retries = excluded.avoided_retries,
      backoff_until = excluded.backoff_until,
      opened_at = excluded.opened_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    incident.incidentId,
    incident.taskId,
    incident.fingerprintDigest,
    incident.state,
    incident.generation,
    incident.evidenceDigest,
    incident.paidAttempts,
    incident.cheapProbeAttempts,
    incident.repairAttempts,
    incident.avoidedRetries,
    incident.backoffUntil || "",
    incident.openedAt || "",
    incident.updatedAt,
    JSON.stringify(incident),
  );
  return incident;
}

function legacyFailureReasonCode(value) {
  const raw = String(value || "").toLowerCase();
  if (/rate.?limit|quota|credit/.test(raw)) return "provider_rate_limited";
  if (/auth|credential|permission/.test(raw)) return "provider_auth_failed";
  if (/repository|remote|git|github/.test(raw)) return "repository_unavailable";
  if (/config|policy/.test(raw)) return "configuration_invalid";
  if (/dependency/.test(raw)) return "dependency_unavailable";
  if (/validation|test|qa/.test(raw)) return "validation_failed";
  if (/output|character|token/.test(raw)) return "output_guard_exceeded";
  if (/service|health|database|postgres/.test(raw)) return "service_unhealthy";
  if (/attempt|exhaust/.test(raw)) return "attempt_budget_exhausted";
  return "execution_failed";
}

function legacyFailureProvider(value) {
  const raw = String(value || "").toLowerCase();
  if (/codex|openai|sdk|cli/.test(raw)) return "codex";
  if (/github|git/.test(raw)) return "github";
  return "local";
}

function failureCandidateIdentity(task = {}) {
  const candidate = task.candidateIdentity || {};
  return {
    candidateId: task.candidateId || "",
    commitSha: candidate.commitSha || task.reviewSubjectSha || "",
    treeSha: candidate.treeSha || "",
    baseSha: candidate.baseSha || "",
    manifestDigest: task.candidateManifestDigest || "",
    candidateCycle: candidate.candidateCycle || task.reviewSubjectCycle || 0,
  };
}

function failureDependencyEvidence(state, task = {}) {
  const tasks = new Map((state.tasks || []).map((item) => [item.id, item]));
  return [...new Set((task.dependsOnTaskIds || []).map(String))]
    .map((taskId) => tasks.get(taskId))
    .filter(Boolean)
    .map((dependency) => ({
      taskId: dependency.id,
      stateVersion: Number(dependency.stateVersion || 1),
      status: dependency.status || "unknown",
    }));
}

function legacyIncidentForTask(state, task, now) {
  const relatedRuns = (state.runs || [])
    .filter((run) => run.taskId === task.id && ["failed", "cancelled"].includes(run.status))
    .sort((left, right) => String(right.updatedAt || right.completedAt || "").localeCompare(String(left.updatedAt || left.completedAt || "")));
  const sourceRun = relatedRuns.find((run) => run.id === task.lastAutomationFailureRunId) || relatedRuns[0];
  const circuit = task.automationCircuit?.state === "open" ? task.automationCircuit : null;
  if (!circuit && !task.lastAutomationFailureRunId && !task.lastAutomationFailure) return null;
  const reasonCode = legacyFailureReasonCode(circuit?.reasonCode || task.lastAutomationFailure || sourceRun?.exitCode);
  const provider = legacyFailureProvider(sourceRun?.provider || sourceRun?.runnerProvider);
  const action = sourceRun?.actionType || sourceRun?.reviewStage || task.status || "unknown";
  const fingerprint = failureFingerprint({
    taskId: task.id,
    action,
    candidateIdentity: failureCandidateIdentity(task),
    provider,
    reasonCode,
  });
  const evidence = failureEvidence({
    repository: {
      branch: task.branchName || "",
      prUrl: task.prUrl || "",
      commitSha: task.reviewSubjectSha || "",
    },
    dependencies: failureDependencyEvidence(state, task),
    credentialClass: "unknown",
    serviceHealth: {},
  });
  let incident = createFailureIncident({ fingerprint, evidence, now });
  incident.paidAttempts = Math.min(2, Math.max(
    Number(circuit?.attemptsConsumed || 0),
    relatedRuns.filter((run) => (
      (run.actionType || run.reviewStage || task.status || "unknown") === action
    )).length,
  ));
  incident.cheapProbeAttempts = Math.max(0, Number(circuit?.cheapProbeCount || 0));
  incident.repairAttempts = Math.max(0, Number(circuit?.recoveryCount || 0));
  incident.avoidedRetries = Math.max(0, Number(circuit?.avoidedRetries || 0));
  if (circuit) incident = openFailureCircuit(incident, { now: circuit.openedAt || now });
  return assertFailureIncident(incident);
}

function backfillFailureIncidents(db, state, now) {
  let migrated = 0;
  for (const task of state.tasks || []) {
    const incident = legacyIncidentForTask(state, task, now);
    if (!incident) continue;
    const existing = db.prepare(`
      SELECT incident_id FROM failure_incidents
      WHERE task_id = ? AND fingerprint_digest = ? AND generation = ?
    `).get(incident.taskId, incident.fingerprintDigest, incident.generation);
    if (existing) continue;
    upsertFailureIncidentRow(db, incident);
    migrated += 1;
  }
  return migrated;
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
    for (const table of ["state_meta", ...ENTITY_TABLES.map((name) => TABLE_NAME[name] || name), "failure_incidents"]) {
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
    && failureContainmentSchemaIsCurrent(db, parsedMeta)
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
      && failureContainmentSchemaIsCurrent(db, lockedMeta)
    ) {
      db.exec("COMMIT");
      integrityMigrated = true;
      return;
    }
    ensureLifecycleSchema(db);
    ensureCoordinationSchema(db);
    ensureFailureContainmentSchema(db);
    if (process.env.STUDIOOPS_TEST_FAIL_COORDINATION_MIGRATION === "after_schema") {
      if (!process.env.NODE_TEST_CONTEXT && !process.env.STUDIOOPS_TEST_ISOLATION) {
        throw new Error("Coordination migration fault injection is restricted to isolated tests.");
      }
      assertIsolatedTestEnvironment();
      throw new Error("Injected coordination migration failure after schema change.");
    }
    const state = readStateFromOpenDatabase(db);
    const snapshot = mutationSnapshot(state);
    const now = new Date().toISOString();
    reconcileStateIntegrity(state);
    quarantineLegacyCandidatesWithInvalidatedReviews(state, now);
    backfillIntegratedQaBundles(state, now);
    reconcileStateIntegrity(state);
    const archived = compactOperationalHistory(state);
    archiveOperationalHistory(db, archived, now);
    const migratedFailureIncidents = backfillFailureIncidents(db, state, now);
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
    state.meta.failureContainmentMigration = {
      schemaVersion: FAILURE_CONTAINMENT_MIGRATION_VERSION,
      contract: FAILURE_CONTAINMENT_SCHEMA_VERSION,
      migratedAt: now,
      migratedIncidentCount: migratedFailureIncidents,
      backupPath,
      backupVerified: true,
    };
    recordOperationalArchiveMetadata(state, archived, now, backupPath);
    state.meta.updatedAt = now;
    writeMutationToOpenDatabase(db, state, snapshot, {
      validateTaskStatuses: false,
      stateIntegrityMigrationCapability: STATE_INTEGRITY_MIGRATION_WRITE,
      stateIntegrityMigrationSnapshot: snapshot,
    });
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

async function initializeStateDatabase() {
  assertIsolatedTestEnvironment();
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await secureStoragePaths();
  const db = openDatabase();
  if (!stateDatabaseInitialized(db)) {
    const state = await initialState();
    state.meta = {
      ...(state.meta || {}),
      storageBackend: "sqlite",
      migratedAt: new Date().toISOString(),
      migratedFrom: await fileExists(LEGACY_DATA_FILE) ? LEGACY_DATA_FILE : "fresh",
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!stateDatabaseInitialized(db)) {
        if ((state.tasks || []).some((task) => task.operatorIntake !== undefined)) {
          operatorCandidateError("operator_intake_verified_writer_required");
        }
        // Serialized legacy paths remain audit data, but a cold import cannot
        // manufacture native workspace authority. The producer must revalidate.
        for (const run of state.runs || []) {
          if (NATIVE_WORKSPACE_FIELDS.some((field) => Object.hasOwn(run, field))) run.workspaceProvenanceUntrusted = true;
        }
        writeStateToOpenDatabase(db, state, {
          testFixtureLegacyAuthorityCapability:
            TEST_FIXTURE_LEGACY_AUTHORITY_BOOTSTRAP?.databaseCapability || null,
        });
      }
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

export async function ensureStateDatabase() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeStateDatabase().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }
  return databaseReadyPromise;
}

function connectionWaitError(operationName) {
  const error = new Error(`StudioOps database connection wait deadline exceeded during ${operationName}.`);
  error.code = "STUDIOOPS_DATABASE_CONNECTION_TIMEOUT";
  return error;
}

function releaseDatabaseConnection() {
  let waiter;
  while ((waiter = connectionWaiters.shift())) {
    clearTimeout(waiter.timer);
    if (Date.now() >= waiter.deadlineAt) {
      waiter.reject(connectionWaitError(waiter.operationName));
      continue;
    }
    waiter.resolve(releaseDatabaseConnection);
    return;
  }
  connectionLeased = false;
}

function acquireDatabaseConnection(operationName, deadlineAt, optimisticRetryCount = 0) {
  if (connectionLeaseContext.getStore()) {
    const error = new Error("State mutators must not start another database write while holding a transaction.");
    error.code = "STUDIOOPS_DATABASE_TRANSACTION_REENTRY";
    throw error;
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    // Initialization may have yielded after the caller checked its retry budget.
    // No connection wait has started yet; queued waiters retain their own error.
    if (Number.isSafeInteger(optimisticRetryCount) && optimisticRetryCount > 0) {
      throw serializedReplayDeadlineError(operationName, optimisticRetryCount, "preparation");
    }
    throw connectionWaitError(operationName);
  }
  if (!connectionLeased) {
    connectionLeased = true;
    return Promise.resolve(releaseDatabaseConnection);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, operationName, deadlineAt, timer: null };
    waiter.timer = setTimeout(() => {
      const index = connectionWaiters.indexOf(waiter);
      if (index >= 0) connectionWaiters.splice(index, 1);
      reject(connectionWaitError(operationName));
    }, remainingMs);
    connectionWaiters.push(waiter);
  });
}

/** Own the process-wide write connection until the callback has settled. */
export async function withStateDatabaseConnection(callback, input = {}) {
  const db = await ensureStateDatabase();
  const release = await acquireDatabaseConnection(
    boundedOperationName(input.operationName),
    input.deadlineAt || Date.now() + SERIALIZED_REPLAY_LOCK_DEADLINE_MS,
    input.optimisticRetryCount,
  );
  try {
    return await connectionLeaseContext.run(true, () => callback(db));
  } finally {
    release();
  }
}

async function ensureReadOnlyStateDatabase() {
  await ensureStateDatabase();
  assertIsolatedTestEnvironment();
  if (!readerDatabase) {
    readerDatabase = new DatabaseSync(DATABASE_FILE, { readOnly: true });
    readerDatabase.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }
  return readerDatabase;
}

/** Read callbacks are synchronous and use a connection that cannot see uncommitted writes. */
export async function withStateDatabaseRead(callback) {
  const result = callback(await ensureReadOnlyStateDatabase());
  if (result && typeof result.then === "function") {
    throw new Error("Database read callbacks must be synchronous.");
  }
  return result;
}

function freezeReadSnapshot(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeReadSnapshot(child);
  return Object.freeze(value);
}

/** A display-only snapshot, reused only while the committed database version is unchanged. */
export async function readDatabaseStateCached() {
  return withStateDatabaseRead((db) => {
    db.exec("BEGIN");
    try {
      const version = Number(db.prepare("SELECT version FROM state_meta WHERE singleton_id = 1").get()?.version);
      if (!Number.isFinite(version)) throw new Error("StudioOps state database is not initialized.");
      if (!cachedReadSnapshot || cachedReadSnapshot.version !== version) {
        cachedReadSnapshot = { version, state: freezeReadSnapshot(readStateFromOpenDatabase(db)) };
      }
      db.exec("COMMIT");
      return cachedReadSnapshot.state;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function readDatabaseState() {
  return withStateDatabaseRead((db) => readStateSnapshot(db).state);
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
    const state = readStateSnapshot(db).state;
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
  await withStateDatabaseConnection((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const previousState = readStateFromOpenDatabase(db);
      assertMaintenanceWriteAllowed(previousState);
      const snapshot = mutationSnapshot(previousState);
      assertPrepaidLedgerTransition(state, snapshot);
      assertNativeWorkspaceIngress(state, snapshot);
      assertOperatorCandidateIngress(state, snapshot);
      assertProposedQaAuthorityPreserved(state, snapshot);
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
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, { operationName: "state.replace" });
  await secureStoragePaths();
}

async function prepareDatabaseMutation(state, mutator, options) {
  assertMaintenanceWriteAllowed(state);
  const snapshot = mutationSnapshot(state);
  reconcileStateIntegrity(state);

  // Mutators must only transform the supplied snapshot or perform retry-safe
  // reads. External writes belong in the fenced operation-intent workflow.
  const result = await mutator(state);
  assertPrepaidLedgerTransition(state, snapshot, options);
  assertNativeWorkspaceIngress(state, snapshot, options);
  assertOperatorCandidateIngress(state, snapshot, options, true);
  assertProposedQaAuthorityPreserved(state, snapshot, options);
  reconcileStateIntegrity(state);
  state.meta = state.meta || {};
  const archived = compactOperationalHistory(state);
  const now = new Date().toISOString();
  if (archivedItemCount(archived)) recordOperationalArchiveMetadata(state, archived, now);
  state.meta.storageBackend = "sqlite";
  const plan = prepareMutationWrite(state, snapshot, options);
  const archiveRows = prepareArchiveRows(archived, now);
  if (plan.hasChanges || archiveRows.length) {
    plan.hasChanges = true;
    state.meta.updatedAt = now;
    plan.updatedAt = now;
    plan.metaPayload = JSON.stringify(state.meta);
  }
  const operatorVerification = options.operatorCandidateCapability === OPERATOR_CANDIDATE_WRITE
    ? options.operatorCandidateVerification : null;
  const reviewCreditRetirements = [...new Set([...(completedReviewCreditAdmissions.get(state)?.retirements || []),
    ...(prepaidCreditRetirementAdmissions.get(state)?.retirements || [])])];
  return { result, plan, archiveRows, operatorVerification, reviewCreditRetirements };
}

function assertPrepaidLedgerTransition(state, snapshot, options = {}) {
  const previousMeta = JSON.parse(snapshot.meta || "{}");
  const previous = previousMeta.prepaidCreditLedger;
  const next = state.meta?.prepaidCreditLedger;
  const reject = () => { throw new Error("Prepaid cumulative ledger changes require the native bounded run claim; history cannot be reset."); };
  const retained = new Map((state.runs || []).map(run => [run.id, run]));
  for (const [id, row] of snapshot.tables.runs) {
    const prior = JSON.parse(row.payload);
    if (prior.creditClaimAdmission?.fundingMode !== "prepaid") continue;
    const current = retained.get(id);
    if (!current) {
      if (!["completed", "failed", "cancelled"].includes(prior.status)) reject();
      continue; // Terminal archive compaction keeps its cumulative charge in meta.
    }
    if (current.taskId !== prior.taskId || current.projectId !== prior.projectId || current.startedAt !== prior.startedAt
      || current.status === "queued" || canonicalJson(current.creditClaimAdmission ?? null) !== canonicalJson(prior.creditClaimAdmission)) reject();
  }
  const claims = (state.runs || []).filter(run => {
    if (run.creditClaimAdmission?.fundingMode !== "prepaid") return false;
    const prior = snapshot.tables.runs.get(run.id);
    const oldRun = prior ? JSON.parse(prior.payload) : null;
    return !oldRun || (oldRun.status !== "running" && run.status === "running")
      || (oldRun.startedAt !== run.startedAt)
      || canonicalJson(oldRun.creditClaimAdmission ?? null) !== canonicalJson(run.creditClaimAdmission);
  }).sort((a, b) => a.creditClaimAdmission.prepaidClaimSequence - b.creditClaimAdmission.prepaidClaimSequence);
  if (!claims.length && Object.hasOwn(previousMeta, "prepaidCreditLedger") === Object.hasOwn(state.meta || {}, "prepaidCreditLedger")
    && canonicalJson(previous ?? null) === canonicalJson(next ?? null)) return;
  if (options.prepaidRunClaimCapability !== PREPAID_RUN_CLAIM_WRITE || !claims.length
    || (Object.hasOwn(previousMeta, "prepaidCreditLedger") && !validPrepaidCreditLedger(previous)) || !validPrepaidCreditLedger(next)) reject();
  let total = previous?.committedEstimatedCredits || 0, count = previous?.claimCount || 0;
  for (const run of claims) {
    const oldRun = JSON.parse(snapshot.tables.runs.get(run.id)?.payload || "null");
    const evidence = run.creditClaimAdmission;
    if (!oldRun || oldRun.status !== "queued" || oldRun.creditClaimAdmission?.fundingMode === "prepaid"
      || run.status !== "running" || oldRun.taskId !== run.taskId
      || evidence.allowed !== true || evidence.fallbackUsed !== false || evidence.ruleId !== "authorized-prepaid-v1"
      || evidence.reservationBinding?.taskId !== run.taskId || evidence.reservationBinding?.runId !== run.id
      || evidence.prepaidClaimSequence !== count + 1 || typeof evidence.estimatedCredits !== "number"
      || !Number.isFinite(evidence.estimatedCredits) || evidence.estimatedCredits <= 0
      || !Number.isFinite(Date.parse(run.startedAt || ""))) reject();
    const updated = total + evidence.estimatedCredits;
    if (!Number.isFinite(updated) || updated <= total || updated > evidence.prepaidCreditLimit
      || evidence.prepaidCreditLimit > evidence.maxEstimatedCredits
      || !Number.isFinite(evidence.prepaidCreditLimit) || !Number.isFinite(evidence.maxEstimatedCredits)
      || evidence.prepaidCommittedCreditsAfterClaim !== updated) reject();
    total = updated; count++;
  }
  if (next.committedEstimatedCredits !== total || next.claimCount !== count
    || next.lastClaimedAt !== claims.at(-1).startedAt) reject();
}

/** The existing atomic run claim is the only cumulative prepaid writer. */
export const mutateRunClaimState = (mutator, options = {}) => mutateDatabaseState(mutator,
  { idempotent: true, ...options, prepaidRunClaimCapability: PREPAID_RUN_CLAIM_WRITE });

export async function mutateDatabaseState(mutator, options = {}) {
  await ensureStateDatabase();
  const operationName = boundedOperationName(options.operationName);
  const retryPolicy = mutationRetryPolicy(options);
  const startedAt = Date.now();
  let retryCount = 0;
  let lockWaitMs = 0;
  let retryDeadlineAt = 0;
  let expectedVersion = 0;
  let prepared = null;

  while (true) {
    try {
      if (!prepared) {
        const snapshot = await withStateDatabaseRead(readStateSnapshot);
        expectedVersion = snapshot.version;
        prepared = await prepareDatabaseMutation(snapshot.state, mutator, options);
      }
      // Rebuilding a conflicted plan consumes the same finite retry budget.
      // Expiry here is not evidence that the write connection was queued/busy.
      if (retryDeadlineAt && Date.now() >= retryDeadlineAt) {
        throw serializedReplayDeadlineError(operationName, retryCount, "preparation");
      }
      const lockAttemptStartedAt = Date.now();
      let acquired = false;
      const result = await withStateDatabaseConnection((db) => {
        let transactionStarted = false;
        try {
          if (retryDeadlineAt) {
            beginSerializedReplayTransaction(db, operationName, retryDeadlineAt, retryCount);
          } else {
            db.exec("BEGIN IMMEDIATE");
          }
          transactionStarted = true;
          lockWaitMs += Date.now() - lockAttemptStartedAt;
          acquired = true;
          const { result: mutationResult, plan, archiveRows } = prepared;
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
          assertOperatorCandidateCommitFence(db, prepared.operatorVerification);
          for (const taskId of prepared.reviewCreditRetirements) {
            if (!taskHasUnresolvedFailureIncident(db, taskId)) continue;
            const conflict = new Error("A durable failure incident appeared during credit-hold reconciliation.");
            conflict.code = "STUDIOOPS_STATE_CONFLICT";
            throw conflict;
          }
          writeArchiveRows(db, archiveRows);
          applyMutationWrite(db, plan);
          recordContentionEvent(db, {
            operationName,
            outcome: !plan.hasChanges ? "noop" : retryCount ? "optimistic_replay" : "committed",
            waitMs: lockWaitMs,
            durationMs: Date.now() - startedAt,
            retryCount,
          });
          db.exec("COMMIT");
          transactionStarted = false;
          return mutationResult;
        } catch (error) {
          if (transactionStarted) db.exec("ROLLBACK");
          throw error;
        }
      }, {
        operationName,
        ...(retryDeadlineAt ? { deadlineAt: retryDeadlineAt, optimisticRetryCount: retryCount } : {}),
      }).finally(() => {
        if (!acquired) lockWaitMs += Date.now() - lockAttemptStartedAt;
      });
      await secureStoragePaths();
      return result;
    } catch (error) {
      const retryableConflict = error.code === "STUDIOOPS_STATE_CONFLICT" || isSqliteBusy(error);
      const lockCanWait = retryDeadlineAt
        && isSqliteBusy(error)
        && Date.now() < retryDeadlineAt;
      if (
        !retryableConflict
        || !retryPolicy.idempotent
        || (!lockCanWait && retryCount >= retryPolicy.maxRetries)
      ) {
        error.operationName = operationName;
        error.retryCount = retryCount;
        await recordFailedContentionEvent({
          operationName, waitMs: lockWaitMs, durationMs: Date.now() - startedAt, retryCount,
        }, error);
        throw error;
      }
      retryCount += 1;
      // A busy lock alone does not invalidate a prepared plan. A version
      // conflict always requires a fresh snapshot, with all preparation outside
      // the SQL transaction. Never fall back to lock-held replay.
      if (error.code === "STUDIOOPS_STATE_CONFLICT") prepared = null;
      if (!retryDeadlineAt) retryDeadlineAt = Date.now() + SERIALIZED_REPLAY_LOCK_DEADLINE_MS;
      const delayMs = Math.min(
        retryDelayMs(retryCount),
        Math.max(1, retryDeadlineAt - Date.now()),
      );
      await sleep(delayMs);
    }
  }
}


// Closed workflow-state recording operations. No caller callback or serialized
// purity/role flag can execute work while the SQLite writer is held.
const TASK_RECORDING_UNSUPPORTED = Symbol("task-recording-unsupported");
const TASK_RECORDING_TRANSACTION_MS = 1000;
const TASK_RECORDING_MAX_ROWS = 50000;

function recordingTaskById(state, taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

export function dependencyGraphErrorsInState(state = { tasks: [] }, task = {}) {
  const errors = [];
  const tasks = task.id
    ? [...(state.tasks || []).filter((item) => item.id !== task.id), task]
    : state.tasks || [];
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path = []) {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle detected: ${[...path, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    const current = byId.get(id);
    if (!current) {
      errors.push(`Unknown dependency task: ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependencyId of current.dependsOnTaskIds || []) {
      const dependency = byId.get(dependencyId);
      if (dependency && current.projectId !== dependency.projectId) {
        errors.push(`Cross-project dependency is not allowed: ${current.id} -> ${dependency.id}`);
      }
      visit(dependencyId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  visit(task.id, []);
  return [...new Set(errors)];
}

export function validateTaskRelationshipsInState(state, taskId, parentTaskId, dependsOnTaskIds) {
  if (parentTaskId) {
    if (parentTaskId === taskId) throw new Error("A task cannot be its own parent.");
    if (!recordingTaskById(state, parentTaskId)) throw new Error(`Unknown parent task: ${parentTaskId}`);
    const seen = new Set([taskId]);
    let currentParentId = parentTaskId;
    while (currentParentId) {
      if (seen.has(currentParentId)) throw new Error("Task parent relationship would create a cycle.");
      seen.add(currentParentId);
      currentParentId = recordingTaskById(state, currentParentId)?.parentTaskId || "";
    }
  }
  for (const dependencyId of dependsOnTaskIds || []) {
    if (dependencyId === taskId) throw new Error("A task cannot depend on itself.");
    const dependency = recordingTaskById(state, dependencyId);
    if (!dependency) throw new Error(`Unknown dependency task: ${dependencyId}`);
    const task = taskId ? recordingTaskById(state, taskId) : null;
    if (task && task.projectId !== dependency.projectId) {
      throw new Error(`Cross-project dependency is not allowed: ${taskId} -> ${dependencyId}`);
    }
  }
  if (taskId) {
    const errors = dependencyGraphErrorsInState(state, {
      ...recordingTaskById(state, taskId),
      dependsOnTaskIds,
    });
    if (errors.length) throw new Error(errors[0]);
  }
}

function taskRecordingInput(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError("Invalid task recording operation.");
  const properties = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(properties);
  if (keys.some((key) => typeof key !== "string" || !Object.hasOwn(properties[key], "value"))) throw new TypeError("Task recording requires inert data values.");
  const value = Object.fromEntries(keys.map((key) => [key, properties[key].value]));
  const allowed = value.kind === "add_comment" ? ["kind", "taskId", "body", "author"]
    : value.kind === "set_pr_url" ? ["kind", "taskId", "prUrl"] : [];
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))
    || typeof value.taskId !== "string" || value.taskId.length > 1024
    || (value.kind === "add_comment" && (typeof value.body !== "string" || value.body.length > 65536
      || value.body !== value.body.trim() || typeof value.author !== "string" || value.author.length > 1024))
    || (value.kind === "set_pr_url" && (typeof value.prUrl !== "string" || value.prUrl.length > 8192))) {
    throw new TypeError("Invalid task recording operation.");
  }
  if (value.kind === "set_pr_url") value.prUrl = value.prUrl.trim();
  return value;
}

function recordingDeadline(deadlineAt, operationName) {
  if (Date.now() < deadlineAt) return;
  const error = new Error(`Bounded task recording exceeded its transaction deadline during ${operationName}.`);
  error.code = "STUDIOOPS_TASK_RECORDING_TIMEOUT";
  throw error;
}

function recordingNextId(db, table, prefix, check) {
  // Match nextId's active-namespace Number(id.split('_')[1]) semantics exactly.
  // Historical archive IDs are not an authorization to change ID policy.
  const rows = db.prepare(`SELECT id FROM ${table} LIMIT ?`).all(TASK_RECORDING_MAX_ROWS + 1);
  if (rows.length > TASK_RECORDING_MAX_ROWS) throw TASK_RECORDING_UNSUPPORTED;
  let highest = 0;
  for (const row of rows) {
    check();
    const id = String(row.id || "");
    if (!id.startsWith(`${prefix}_`)) continue;
    const value = Number(id.split("_")[1]);
    if (Number.isFinite(value)) highest = Math.max(highest, value);
  }
  return `${prefix}_${highest + 1}`;
}

function recordingRelationships(db, task, check) {
  const rows = new Map([[task.id, task]]);
  const read = (id) => {
    check();
    if (typeof id !== "string") throw TASK_RECORDING_UNSUPPORTED;
    if (!rows.has(id)) {
      if (rows.size >= 1024) throw TASK_RECORDING_UNSUPPORTED;
      const row = db.prepare("SELECT id, project_id, payload FROM tasks WHERE id = ?").get(id);
      const value = row ? parsePayload(row.payload, null) : null;
      if (value && (value.id !== row.id || value.projectId !== row.project_id)) throw TASK_RECORDING_UNSUPPORTED;
      rows.set(id, value);
    }
    return rows.get(id);
  };
  const parents = new Set();
  let parent = task.parentTaskId;
  while (parent && !parents.has(parent)) {
    parents.add(parent); parent = read(parent)?.parentTaskId;
  }
  const pending = [task], seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.dependsOnTaskIds !== undefined && !Array.isArray(current.dependsOnTaskIds)) throw TASK_RECORDING_UNSUPPORTED;
    for (const id of current.dependsOnTaskIds || []) {
      if (typeof id !== "string") throw TASK_RECORDING_UNSUPPORTED;
      pending.push(read(id));
    }
  }
  const state = { tasks: [...rows.values()].filter(Boolean) };
  validateTaskRelationshipsInState(state, task.id, task.parentTaskId, task.dependsOnTaskIds || []);
}

function currentPrUrlRecordingEligible(task) {
  const identity = task.candidateIdentity || {};
  return ["idea", "ready", "queued", "blocked", "needs_changes"].includes(task.status)
    && Number(task.reviewCycle || 0) === 0 && Number(task.reviewSubjectCycle || 0) === 0
    && !task.reviewSubjectSha && !task.candidateId && !task.qaBundleId && !task.operatorIntake
    && !task.branchName && !task.operationalLocalArtifactRef && !task.workflowLease && !task.assignmentClaim
    && !task.automationCircuit && task.automationBlocker?.type !== "circuit"
    && !identity.commitSha && !identity.treeSha && !identity.baseSha && !identity.branch && Number(identity.candidateCycle || 0) === 0;
}

function retainRecordedEventGroup(db, event, meta, now, check) {
  const rows = db.prepare("SELECT id, payload FROM events WHERE task_id = ? AND type = ? ORDER BY sequence LIMIT ?")
    .all(event.taskId, event.type, TASK_RECORDING_MAX_ROWS + 1);
  if (rows.length > TASK_RECORDING_MAX_ROWS) throw TASK_RECORDING_UNSUPPORTED;
  const group = rows.map((row) => {
    check();
    const value = parsePayload(row.payload, null);
    if (!value || value.id !== row.id) throw TASK_RECORDING_UNSUPPORTED;
    return value;
  }).filter((value) => value.machineGenerated !== false && !value.executionKey && !value.attemptKey && !value.dispatchKey);
  const archived = group.slice(0, Math.max(0, group.length - ACTIVE_QA_EVENTS_PER_TASK));
  if (!archived.length) return;
  archiveOperationalHistory(db, { comments: [], events: archived, runs: [] }, now);
  const remove = db.prepare("DELETE FROM events WHERE id = ?");
  for (const value of archived) { check(); remove.run(value.id); }
  recordOperationalArchiveMetadata({ meta }, { comments: [], events: archived, runs: [] }, now);
}

/** Two audited current-row operations; all generic/async/Git work remains off-lock. */
export async function recordCurrentTaskOperation(input) {
  const operation = taskRecordingInput(input);
  const operationName = operation.kind === "add_comment" ? "task.add_comment" : "task.update";
  const startedAt = Date.now(), lockDeadlineAt = startedAt + SERIALIZED_REPLAY_LOCK_DEADLINE_MS;
  let retryCount = 0, lockWaitMs = 0;
  try {
    while (true) {
      const lockStartedAt = Date.now();
      let acquired = false;
      try {
        const result = await withStateDatabaseConnection((db) => {
          let transactionStarted = false;
          try {
            beginSerializedReplayTransaction(db, operationName, lockDeadlineAt, retryCount);
            transactionStarted = true; acquired = true; lockWaitMs += Date.now() - lockStartedAt;
            const deadlineAt = Date.now() + TASK_RECORDING_TRANSACTION_MS;
            const check = () => recordingDeadline(deadlineAt, operationName);
            const meta = parsePayload(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get()?.payload, {});
            assertMaintenanceWriteAllowed({ meta }); check();
            const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(operation.taskId);
            if (!row) throw new Error(`Unknown task: ${operation.taskId}`);
            const task = parsePayload(row.payload, null);
            if (!task || task.id !== row.id || task.projectId !== row.project_id || task.status !== row.status
              || task.stateVersion !== row.state_version || !VALID_TASK_STATUSES.has(task.status)
              || typeof task.title !== "string") throw TASK_RECORDING_UNSUPPORTED;
            const projectRow = db.prepare("SELECT id, payload FROM projects WHERE id = ?").get(task.projectId);
            const project = projectRow ? parsePayload(projectRow.payload, null) : null;
            if (!project || project.id !== projectRow.id) throw TASK_RECORDING_UNSUPPORTED;
            if (operation.kind === "set_pr_url") {
              if (!currentPrUrlRecordingEligible(task)) throw TASK_RECORDING_UNSUPPORTED;
              recordingRelationships(db, task, check);
            } else if (QA_COMMENT_AUTHORS.has(operation.author) && /^QA integration\b/.test(operation.body)) {
              throw TASK_RECORDING_UNSUPPORTED;
            }
            if (operation.kind === "add_comment" && !operation.body) throw new Error("Comment body is required.");
            check();
            const now = new Date().toISOString();
            const event = { id: recordingNextId(db, "events", "event", check),
              type: operation.kind === "add_comment" ? "comment_created" : "task_updated",
              projectId: task.projectId, taskId: task.id,
              message: operation.kind === "add_comment" ? `Comment added to ${task.title}` : `Task updated: ${task.title}`,
              createdAt: now };
            let value;
            if (operation.kind === "add_comment") {
              value = { id: recordingNextId(db, "comments", "comment", check), taskId: task.id,
                author: operation.author, body: operation.body, createdAt: now };
              const sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM comments").get().value);
              db.prepare("INSERT INTO comments(id, sequence, task_id, created_at, payload) VALUES (?, ?, ?, ?, ?)")
                .run(value.id, sequence, task.id, now, JSON.stringify(value));
            } else {
              task.prUrl = operation.prUrl; task.updatedAt = now; value = task;
              // prUrl is not lifecycle evidence: preserve the current task version.
              db.prepare("UPDATE tasks SET updated_at = ?, payload = ? WHERE id = ?")
                .run(now, JSON.stringify(task), task.id);
            }
            check();
            const sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM events").get().value);
            db.prepare("INSERT INTO events(id, sequence, project_id, task_id, type, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run(event.id, sequence, task.projectId, task.id, event.type, now, JSON.stringify(event));
            retainRecordedEventGroup(db, event, meta, now, check); check();
            meta.updatedAt = now; meta.storageBackend = "sqlite";
            db.prepare("UPDATE state_meta SET payload = ?, version = version + 1, updated_at = ? WHERE singleton_id = 1")
              .run(JSON.stringify(meta), now);
            check();
            recordContentionEvent(db, { operationName, outcome: "current_record_committed", waitMs: lockWaitMs,
              durationMs: Date.now() - startedAt, retryCount });
            check(); db.exec("COMMIT"); transactionStarted = false; cachedReadSnapshot = null;
            return { handled: true, value };
          } catch (error) {
            if (transactionStarted) db.exec("ROLLBACK");
            if (error === TASK_RECORDING_UNSUPPORTED) return { handled: false };
            throw error;
          }
        }, { operationName, deadlineAt: lockDeadlineAt }).finally(() => { if (!acquired) lockWaitMs += Date.now() - lockStartedAt; });
        await secureStoragePaths(); return result;
      } catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= lockDeadlineAt) throw error;
        retryCount += 1;
        await sleep(Math.min(retryDelayMs(retryCount), Math.max(1, lockDeadlineAt - Date.now())));
      }
    }
  } catch (error) {
    error.operationName = operationName; error.retryCount = retryCount;
    await recordFailedContentionEvent({ operationName, waitMs: lockWaitMs, durationMs: Date.now() - startedAt, retryCount }, error);
    throw error;
  }
}

// Fixed adoption read footprint. No caller supplies selectors, preimage digests,
// SQL callbacks or permission flags. Directory projections include membership so
// new/missing conflict owners cannot borrow an earlier no-conflict observation.
const OPERATOR_ADOPTION_MAX_ROWS = 10000;
const OPERATOR_ADOPTION_MAX_BYTES = 64 * 1024 * 1024;
const ADOPTION_TASK_DIRECTORY_FIELDS = ["id", "projectId", "lane", "type", "area", "title", "description", "userStory", "expectedOutcome", "workAreas"];
const ADOPTION_PROJECT_DIRECTORY_FIELDS = ["id", "repoUrl", "repositoryUrl", "repository", "remoteUrl", "sourceRepoPath", "repoPath"];
const ADOPTION_MATERIAL_EVENTS = ["operator_candidate_adopted", "operator_candidate_superseded"];

function adoptionProjection(value, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function adoptionFootprint(state, verification, check = () => {}) {
  const byId = new Map(), childrenByParent = new Map();
  for (const task of state.tasks) {
    check(); byId.set(task.id, task);
    if (task.architectureParentTaskId) {
      const children = childrenByParent.get(task.architectureParentTaskId) || [];
      children.push(task.id); childrenByParent.set(task.architectureParentTaskId, children);
    }
  }
  const roots = [verification.taskId, ...verification.dispositionTaskIds, ...(verification.conflictTaskIds || [])];
  const ids = new Set(roots), pending = [...roots];
  while (pending.length) {
    check(); const id = pending.pop(), task = byId.get(id);
    if (!task) continue; // Absence is part of the footprint, never dropped.
    const links = [...(task.dependsOnTaskIds || []), ...(task.architectureDecisionTaskIds || []),
      ...(childrenByParent.get(id) || []), task.architectureParentTaskId, task.parentTaskId];
    for (const link of links.filter(Boolean)) if (!ids.has(link)) {
      ids.add(link); pending.push(link);
      if (ids.size > 4096) operatorCandidateError("adoption_preimage_bound_exceeded");
    }
  }
  const sorted = (rows) => rows.slice().sort((a, b) => a.id.localeCompare(b.id));
  const linkedCandidateIds = new Set([...ids].map((id) => byId.get(id)?.candidateId).filter(Boolean));
  const linkedBundleIds = new Set([...ids].map((id) => byId.get(id)?.qaBundleId).filter(Boolean));
  const candidates = state.candidates.filter((candidate) => { check(); return linkedCandidateIds.has(candidate.id)
    || (candidate.manifest?.sources || []).some((source) => ids.has(source.taskId)); });
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const task = byId.get(verification.taskId);
  return {
    taskDirectory: sorted(state.tasks).map((item) => adoptionProjection(item, ADOPTION_TASK_DIRECTORY_FIELDS)),
    projectDirectory: sorted(state.projects).map((item) => adoptionProjection(item, ADOPTION_PROJECT_DIRECTORY_FIELDS)),
    tasks: [...ids].sort().map((id) => ({ id, value: byId.get(id) || null })),
    project: state.projects.find((item) => item.id === task?.projectId) || null,
    activeRuns: sorted(state.runs.filter((run) => ["queued", "running"].includes(run.status)))
      .map((run) => adoptionProjection(run, ["id", "taskId", "projectId", "status", "role", "group"])),
    runs: sorted(state.runs.filter((run) => ids.has(run.taskId))),
    reviews: sorted(state.reviews.filter((review) => ids.has(review.taskId))),
    candidates: sorted(candidates),
    qaBundles: sorted(state.qaBundles.filter((bundle) => { check(); return candidateIds.has(bundle.candidateId)
      || linkedBundleIds.has(bundle.id) || (bundle.tasks || []).some((item) => ids.has(item.id)); })),
    materialHistory: sorted(state.events.filter((event) => event.taskId === verification.taskId && ADOPTION_MATERIAL_EVENTS.includes(event.type))),
    promotionClaims: [...candidateIds].sort().map((id) => ({ id, value: state.meta?.promotionAttemptClaims?.[id] || null })),
  };
}

// Stream each fixed selector once. A byte-count aggregate followed by a second
// full payload query doubled cold-page work while the writer was held.
function* boundedAdoptionRows(db, query, args, check) {
  let count = 0, bytes = 0;
  for (const row of db.prepare(query).iterate(...args)) {
    check(); bytes += Number(row.payload_bytes);
    if (++count > OPERATOR_ADOPTION_MAX_ROWS || !Number.isSafeInteger(bytes) || bytes > OPERATOR_ADOPTION_MAX_BYTES) {
      operatorCandidateError("adoption_preimage_bound_exceeded");
    }
    yield row;
  }
}

function readAdoptionRows(db, table, check, where = "", args = []) {
  const query = `SELECT *, length(CAST(payload AS BLOB)) AS payload_bytes FROM ${table} ${where} LIMIT ${OPERATOR_ADOPTION_MAX_ROWS + 1}`;
  const values = [];
  for (const row of boundedAdoptionRows(db, query, args, check)) {
    const value = parsePayload(row.payload, null);
    if (!value || value.id !== row.id) operatorCandidateError("adoption_preimage_invalid");
    for (const [column, key] of [["project_id", "projectId"], ["task_id", "taskId"], ["status", "status"], ["role", "role"], ["key", "key"], ["manifest_digest", "manifestDigest"], ["integration_commit", "integrationCommit"]]) {
      if (Object.hasOwn(row, column) && String(value[key] || "") !== row[column]) operatorCandidateError("adoption_preimage_invalid");
    }
    if (Object.hasOwn(row, "state_version") && Number(value.stateVersion || 1) !== row.state_version) operatorCandidateError("adoption_preimage_invalid");
    values.push(value);
  }
  return values;
}

function readAdoptionDirectory(db, table, fields, check) {
  const keys = [...new Set([...fields, ...(table === "tasks" ? ["architectureParentTaskId", "status", "stateVersion"] : ["key"])])];
  const paths = keys.map((key) => `'$.${key}'`).join(", ");
  const types = keys.map((key) => `json_type(payload, '$.${key}')`).join(", ");
  const bytes = "length(CAST(payload AS BLOB))";
  const query = `SELECT id, ${table === "tasks" ? "project_id, status, state_version" : "key"}, ${bytes} AS payload_bytes,
    CASE WHEN ${bytes} <= ${OPERATOR_ADOPTION_MAX_BYTES} THEN json_extract(payload, ${paths}) END AS projection,
    CASE WHEN ${bytes} <= ${OPERATOR_ADOPTION_MAX_BYTES} THEN json_array(${types}) END AS types
    FROM ${table} LIMIT ${OPERATOR_ADOPTION_MAX_ROWS + 1}`;
  const values = [];
  for (const row of boundedAdoptionRows(db, query, [], check)) {
    const data = parsePayload(row.projection, null), present = parsePayload(row.types, null);
    if (!Array.isArray(data) || !Array.isArray(present) || data.length !== keys.length || present.length !== keys.length) operatorCandidateError("adoption_preimage_invalid");
    // json_type distinguishes an absent key from an explicit JSON null. Preserve
    // that distinction along with arrays, booleans and raw directory field types.
    const value = Object.fromEntries(keys.flatMap((key, index) => present[index] === null ? [] : [[key, data[index]]]));
    if (value.id !== row.id || (table === "tasks" ? (String(value.projectId || "") !== row.project_id
      || String(value.status || "") !== row.status || Number(value.stateVersion || 1) !== row.state_version) : String(value.key || "") !== row.key)) {
      operatorCandidateError("adoption_preimage_invalid");
    }
    values.push(value);
  }
  return values;
}

function readAdoptionLinkedIds(db, table, taskIds, directIds, candidateIds, check) {
  const candidate = table === "candidates", links = candidate ? "$.manifest.sources" : "$.tasks";
  const field = candidate ? "taskId" : "id", bytes = "length(CAST(payload AS BLOB))";
  const material = candidate ? "manifestDigest" : "integrationCommit", column = candidate ? "manifest_digest" : "integration_commit";
  const query = `SELECT id, project_id, status, ${column}, ${bytes} AS payload_bytes,
    json_extract(payload, '$.id', '$.projectId', '$.status', '$.${material}') AS identity,
    json_type(payload, '${links}') AS links_type, json_extract(payload, '$.candidateId') AS candidate_id,
    CASE WHEN ${bytes} <= ${OPERATOR_ADOPTION_MAX_BYTES} AND json_type(payload, '${links}') = 'array' THEN
      (SELECT json_object('ids', json_group_array(json_extract(entry.value, '$.${field}')),
        'nulls', COALESCE(SUM(entry.type = 'null'), 0)) FROM json_each(payload, '${links}') AS entry)
      ELSE '{"ids":[],"nulls":0}' END AS linked FROM ${table} LIMIT ${OPERATOR_ADOPTION_MAX_ROWS + 1}`;
  const result = [];
  for (const row of boundedAdoptionRows(db, query, [], check)) {
    const identity = parsePayload(row.identity, null), linked = parsePayload(row.linked, null);
    if (!identity || identity[0] !== row.id || String(identity[1] || "") !== row.project_id
      || String(identity[2] || "") !== row.status || String(identity[3] || "") !== row[column]
      || ![null, "null", "array"].includes(row.links_type) || !Array.isArray(linked?.ids) || linked.nulls) operatorCandidateError("adoption_preimage_invalid");
    if (directIds.has(row.id) || candidateIds.has(row.candidate_id) || linked.ids.some((id) => taskIds.has(id))) result.push(row.id);
  }
  return result;
}

function currentAdoptionFootprint(db, verification, meta, check) {
  // Only conflict/ownership fields and graph-child membership require a global
  // task directory. Full task records are loaded by primary key for the current
  // transitive graph, including missing-row/child/parent/dependency races.
  const tasks = readAdoptionDirectory(db, "tasks", ADOPTION_TASK_DIRECTORY_FIELDS, check);
  const projects = readAdoptionDirectory(db, "projects", ADOPTION_PROJECT_DIRECTORY_FIELDS, check);
  const byId = new Map(tasks.map((task) => [task.id, task])), children = new Map();
  for (const task of tasks) if (task.architectureParentTaskId) {
    const ids = children.get(task.architectureParentTaskId) || [];
    ids.push(task.id); children.set(task.architectureParentTaskId, ids);
  }
  const ids = new Set([verification.taskId, ...verification.dispositionTaskIds, ...(verification.conflictTaskIds || [])]);
  let pending = [...ids];
  while (pending.length) {
    check(); if (ids.size > 4096) operatorCandidateError("adoption_preimage_bound_exceeded");
    const placeholders = pending.map(() => "?").join(",");
    const rows = readAdoptionRows(db, "tasks", check, `WHERE id IN (${placeholders})`, pending);
    pending = [];
    for (const task of rows) {
      byId.set(task.id, task);
      const links = [...(task.dependsOnTaskIds || []), ...(task.architectureDecisionTaskIds || []),
        ...(children.get(task.id) || []), task.architectureParentTaskId, task.parentTaskId];
      for (const id of links.filter(Boolean)) if (!ids.has(id)) { ids.add(id); pending.push(id); }
    }
  }
  const graph = [...ids].map((id) => byId.get(id)).filter(Boolean);
  const projectId = byId.get(verification.taskId)?.projectId;
  const project = readAdoptionRows(db, "projects", check, "WHERE id = ?", [projectId || ""])[0];
  const candidateIds = readAdoptionLinkedIds(db, "candidates", ids, new Set(graph.map((task) => task.candidateId).filter(Boolean)), new Set(), check);
  const bundleIds = readAdoptionLinkedIds(db, "qa_bundles", ids, new Set(graph.map((task) => task.qaBundleId).filter(Boolean)), new Set(candidateIds), check);
  const selectIds = (table, selected) => selected.length ? readAdoptionRows(db, table, check, `WHERE id IN (${selected.map(() => "?").join(",")})`, selected) : [];
  const placeholders = [...ids].map(() => "?").join(",");
  const state = { meta, tasks: tasks.map((task) => byId.get(task.id)), projects: projects.map((item) => item.id === project?.id ? project : item),
    candidates: selectIds("candidates", candidateIds), qaBundles: selectIds("qa_bundles", bundleIds),
    runs: readAdoptionRows(db, "runs", check, `WHERE task_id IN (${placeholders}) OR status IN ('queued','running')`, [...ids]),
    reviews: readAdoptionRows(db, "reviews", check, `WHERE task_id IN (${placeholders})`, [...ids]),
    events: readAdoptionRows(db, "events", check, "WHERE task_id = ? AND type IN ('operator_candidate_adopted','operator_candidate_superseded')", [verification.taskId]) };
  check(); return adoptionFootprint(state, verification, check);
}

function assertAdoptionPreimage(expected, current, verification) {
  const before = new Map(expected.tasks.map((item) => [item.id, item.value]));
  const after = new Map(current.tasks.map((item) => [item.id, item.value]));
  if (canonicalJson(before.get(verification.taskId)) !== canonicalJson(after.get(verification.taskId))) operatorCandidateError("adoption_task_stale");
  for (const id of verification.dispositionTaskIds) if (canonicalJson(before.get(id)) !== canonicalJson(after.get(id))) operatorCandidateError("adoption_prerequisite_stale");
  if (canonicalJson(expected) !== canonicalJson(current)) operatorCandidateError("adoption_preimage_stale");
}

/** Audited adoption delta only. All executable verification/confirmation and
 * lifecycle transformation run before BEGIN IMMEDIATE; SQL accepts no callback.
 * Unrelated global writes do not invalidate these exact relevant preimages.
 */
export async function commitOperatorCandidateAdoption(taskId, verifySnapshot, mutator) {
  if (typeof taskId !== "string" || !taskId || typeof verifySnapshot !== "function" || typeof mutator !== "function") {
    throw new Error("Operator adoption requires a task and executable off-lock verification and transformation.");
  }
  await ensureStateDatabase();
  const startedAt = Date.now(), operationName = "task.adopt_operator_candidate";
  const state = (await withStateDatabaseRead(readStateSnapshot)).state;
  assertMaintenanceWriteAllowed(state);
  const before = structuredClone(state), snapshot = mutationSnapshot(state);
  const verification = freezeOperatorVerification(await verifySnapshot(state));
  if (verification.taskId !== taskId) operatorCandidateError("operator_candidate_verification_invalid");
  assertOperatorCandidateIdle(state, verification);
  const result = await mutator(state, verification);
  const authority = { operatorCandidateCapability: OPERATOR_CANDIDATE_WRITE, operatorCandidateVerification: verification };
  assertNativeWorkspaceIngress(state, snapshot, authority);
  assertOperatorCandidateIngress(state, snapshot, authority, true);
  assertProposedQaAuthorityPreserved(state, snapshot, authority);
  reconcileStateIntegrity(state);
  const plan = prepareMutationWrite(state, snapshot, authority);
  const footprint = JSON.parse(canonicalJson(adoptionFootprint(before, verification)));
  const taskIds = new Set([taskId, ...verification.dispositionTaskIds]);
  const allowed = { tasks: taskIds, reviews: new Set(footprint.reviews.map((row) => row.id)),
    candidates: new Set(footprint.candidates.map((row) => row.id)), qaBundles: new Set(footprint.qaBundles.map((row) => row.id)) };
  if (plan.deletes.length || plan.metaPayload !== snapshot.meta) operatorCandidateError("adoption_delta_invalid");
  const updates = [], events = [];
  for (const row of plan.upserts) {
    if (row.table === "events") {
      if (snapshot.tables.events.has(row.item.id) || !taskIds.has(row.item.taskId)
        || !["lifecycle_transition", ...ADOPTION_MATERIAL_EVENTS].includes(row.item.type)) operatorCandidateError("adoption_delta_invalid");
      const { id: _preparedId, ...event } = row.item; events.push(event);
    } else {
      if (!allowed[row.table]?.has(row.item.id) || !snapshot.tables[row.table].has(row.item.id)) operatorCandidateError("adoption_delta_invalid");
      updates.push({ table: row.table, item: JSON.parse(row.payload), payload: row.payload });
    }
  }
  if (verification.replay) {
    if (updates.length || events.length) operatorCandidateError("adoption_delta_invalid");
    return result;
  }
  if (!updates.some((row) => row.table === "tasks" && row.item.id === taskId)
    || events.filter((event) => event.type === "operator_candidate_adopted" && event.taskId === taskId).length !== 1
    || events.length > 2 * taskIds.size + 1) operatorCandidateError("adoption_delta_invalid");
  // Detach every prevalidated payload before waiting for SQLite ownership.
  const write = structuredClone({ updates, events }), lockDeadlineAt = Date.now() + SERIALIZED_REPLAY_LOCK_DEADLINE_MS;
  let retryCount = 0, lockWaitMs = 0;
  try {
    while (true) {
      const lockStartedAt = Date.now(); let acquired = false;
      try {
        const committed = await withStateDatabaseConnection((db) => {
          let transactionStarted = false;
          try {
            beginSerializedReplayTransaction(db, operationName, lockDeadlineAt, retryCount);
            transactionStarted = true; acquired = true; lockWaitMs += Date.now() - lockStartedAt;
            const check = () => recordingDeadline(transactionDeadlineAt, operationName), transactionDeadlineAt = Date.now() + TASK_RECORDING_TRANSACTION_MS;
            const meta = parsePayload(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get()?.payload, {});
            assertMaintenanceWriteAllowed({ meta }); check();
            assertAdoptionPreimage(footprint, currentAdoptionFootprint(db, verification, meta, check), verification); check();
            assertOperatorCandidateCommitFence(db, verification); check();
            for (const row of write.updates) {
              check(); const table = TABLE_NAME[row.table] || row.table;
              const current = db.prepare(`SELECT sequence FROM ${table} WHERE id = ?`).get(row.item.id);
              if (!current) operatorCandidateError("adoption_preimage_stale");
              upsertEntity(db, row.table, row.item, current.sequence, row.payload);
            }
            let eventNumber = Number(recordingNextId(db, "events", "event", check).slice("event_".length));
            let sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM events").get().value);
            const now = new Date().toISOString();
            for (const template of write.events) {
              check(); const event = { ...template, id: `event_${eventNumber++}` };
              upsertEntity(db, "events", event, sequence++);
              retainRecordedEventGroup(db, event, meta, now, check);
            }
            meta.updatedAt = now; meta.storageBackend = "sqlite"; check();
            db.prepare("UPDATE state_meta SET payload = ?, version = version + 1, updated_at = ? WHERE singleton_id = 1").run(JSON.stringify(meta), now);
            recordContentionEvent(db, { operationName, outcome: "adoption_preimage_committed", waitMs: lockWaitMs, durationMs: Date.now() - startedAt, retryCount });
            check(); db.exec("COMMIT"); transactionStarted = false; cachedReadSnapshot = null;
            return result;
          } catch (error) { if (transactionStarted) db.exec("ROLLBACK"); throw error; }
        }, { operationName, deadlineAt: lockDeadlineAt }).finally(() => { if (!acquired) lockWaitMs += Date.now() - lockStartedAt; });
        await secureStoragePaths(); return committed;
      } catch (error) {
        // Only an unavailable SQL lock may wait. A relevant change requires a
        // fresh request/owner confirmation, never hidden global replay.
        if (!isSqliteBusy(error) || Date.now() >= lockDeadlineAt) throw error;
        retryCount++; await sleep(Math.min(retryDelayMs(retryCount), Math.max(1, lockDeadlineAt - Date.now())));
      }
    }
  } catch (error) {
    error.operationName = operationName; error.retryCount = retryCount;
    await recordFailedContentionEvent({ operationName, waitMs: lockWaitMs, durationMs: Date.now() - startedAt, retryCount }, error);
    throw error;
  }
}

/** Executable, replayed verification is required before any operator intake. */
export async function mutateOperatorCandidateState(verifySnapshot, mutator, options = {}) {
  if (typeof verifySnapshot !== "function" || typeof mutator !== "function") {
    throw new Error("Operator candidate writer requires executable verification and mutation callbacks.");
  }
  let verification = null;
  return mutateDatabaseState(async (state) => {
    verification = freezeOperatorVerification(await verifySnapshot(state));
    assertOperatorCandidateIdle(state, verification);
    return mutator(state, verification);
  }, {
    idempotent: true,
    ...options,
    operatorCandidateCapability: OPERATOR_CANDIDATE_WRITE,
    get operatorCandidateVerification() { return verification; },
  });
}

/** Trusted native dispatch/remap adapter; serialized options cannot mint it. */
export async function mutateScopeDispatchState(mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("Scoped dispatch writer requires a mutation callback.");
  return mutateDatabaseState(mutator, { ...options, scopedDispatchCapability: SCOPED_DISPATCH_WRITE });
}

/** Only the native workspace producer may bind an existing run to prepared Git. */
export async function mutateNativeWorkspaceState(runId, mutator, options = {}) {
  const id = typeof runId === "string" ? runId.trim() : "";
  if (!id || typeof mutator !== "function") throw new Error("Native workspace writer requires an existing run ID and mutation callback.");
  return mutateDatabaseState(async (state) => {
    const previous = (state.runs || []).find((run) => run.id === id);
    if (!previous) operatorCandidateError("native_workspace_persisted_run_required");
    const runIds = (state.runs || []).map((run) => run.id);
    const nonWorkspaceFields = (run) => Object.fromEntries(Object.entries(run)
      .filter(([key]) => ![...NATIVE_WORKSPACE_AUTHORITY_FIELDS, "updatedAt"].includes(key)));
    const binding = canonicalJson(nonWorkspaceFields(previous));
    const result = await mutator(state);
    if (canonicalJson((state.runs || []).map((run) => run.id)) !== canonicalJson(runIds)) operatorCandidateError("native_workspace_run_set_immutable");
    const current = (state.runs || []).find((run) => run.id === id);
    if (canonicalJson(nonWorkspaceFields(current)) !== binding) operatorCandidateError("native_workspace_run_record_immutable");
    return result;
  }, {
    idempotent: true,
    ...options,
    nativeWorkspaceCapability: NATIVE_WORKSPACE_WRITE,
    nativeWorkspaceRunId: id,
  });
}

/** Narrow writer for the first owner QA decision on an immutable candidate. */
export async function mutateCandidateQaDecisionState(candidateId, verification, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("Candidate QA decision writer requires a mutator.");
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("Candidate QA decision writer requires a candidate ID.");
  let authorizedDecision = null;
  return mutateDatabaseState(async (state) => {
    const candidate = (state.candidates || []).find((item) => item.id === id);
    if (!candidate) throw new Error(`Unknown QA decision candidate: ${id}`);
    const hadDecision = Boolean(candidate.qaDecision);
    const previousStatus = candidate.status;
    const expectedPacket = !hadDecision
      ? structuredClone(assertCurrentOwnerQaPacket(
        state,
        candidate,
        (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId),
      ))
      : null;
    const result = await mutator(state);
    const current = (state.candidates || []).find((item) => item.id === id);
    if (!hadDecision && current?.qaDecision) {
      if (previousStatus !== "frozen") {
        throw new Error(`Candidate ${id} must be frozen before its first QA decision.`);
      }
      authorizedDecision = structuredClone(
        assertInitialCandidateQaDecisionAuthority(state, current, verification, expectedPacket),
      );
    }
    return result;
  }, {
    idempotent: true,
    ...options,
    candidateQaDecisionCapability: CANDIDATE_QA_DECISION_WRITE,
    get candidateQaDecisionCandidateId() { return id; },
    get candidateQaDecisionRecord() { return authorizedDecision; },
  });
}

/** Persist exactly one claim transition produced by the claim state machine. */
export async function mutatePromotionAttemptClaimState(candidateId, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("Promotion claim writer requires a mutator.");
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("Promotion claim writer requires a candidate ID.");
  let authorizedClaim = null;
  let authorizedClaimPresent = false;
  return mutateDatabaseState(async (state) => {
    const claimsBefore = promotionClaims(state.meta);
    const previousPresent = Object.prototype.hasOwnProperty.call(claimsBefore, id);
    const previousClaim = previousPresent ? structuredClone(claimsBefore[id]) : undefined;
    const result = await mutator(state);
    const claimsAfter = promotionClaims(state.meta);
    authorizedClaimPresent = Object.prototype.hasOwnProperty.call(claimsAfter, id);
    authorizedClaim = authorizedClaimPresent ? structuredClone(claimsAfter[id]) : null;
    const claimUnchanged = previousPresent === authorizedClaimPresent
      && (!previousPresent || JSON.stringify(previousClaim) === JSON.stringify(authorizedClaim));
    if (!claimUnchanged) {
      assertPromotionAttemptClaimTransitionAttestation(result, id, previousClaim, state);
    }
    return result;
  }, {
    idempotent: true,
    ...options,
    promotionClaimCapability: PROMOTION_CLAIM_WRITE,
    get promotionClaimCandidateId() { return id; },
    get promotionClaimRecordPresent() { return authorizedClaimPresent; },
    get promotionClaimRecord() { return authorizedClaim; },
  });
}

function assertHistoricalReleaseCandidateAuthority(state, candidate) {
  if (
    candidate.status !== "release_candidate_ready"
    || candidate.invalidation
    || candidate.promotionMerge
    || candidate.qaRevocationIntent
    || candidate.qaRevocationSettlement
  ) {
    throw new Error(`Candidate ${candidate.id} is not eligible for merged-PR admission recovery.`);
  }
  const existingClaim = promotionClaims(state.meta)[candidate.id];
  const terminalHandoffClaim = Boolean(
    existingClaim
    && existingClaim.status === "terminal"
    && ["pr_ready", "pr_merged_detected"].includes(existingClaim.outcome)
    && ["create", "retry"].includes(existingClaim.mode)
    && existingClaim.candidateId === candidate.id
    && existingClaim.projectId === candidate.projectId
    && existingClaim.qaDecision?.candidateId === candidate.id
    && existingClaim.qaDecision?.manifestDigest === candidate.manifestDigest
    && existingClaim.qaDecision?.integrationSha === candidate.manifest.integration.sha
  );
  if (existingClaim && !terminalHandoffClaim) {
    throw new Error(`Candidate ${candidate.id} already has an active or incompatible promotion claim.`);
  }
  const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  const packet = assertOwnerQaPacket(candidate.qaPacket, candidate, bundle);
  if (
    !bundle
    || bundle.qaPacket === undefined
    || bundle.packetDigest !== packet.packetDigest
    || JSON.stringify(bundle.qaPacket) !== JSON.stringify(packet)
  ) {
    throw new Error(`Candidate ${candidate.id} historical owner-QA packet mirror is invalid.`);
  }
  const decision = candidate.qaDecision;
  const decisionPacketDigest = decision?.ownerQaPacketDigest || (
    packet.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION ? packet.packetDigest : ""
  );
  const expectedTaskIds = candidate.manifest.sources.map((source) => String(source.taskId)).sort();
  const decidedTaskIds = Array.isArray(decision?.taskIds) ? decision.taskIds.map(String).sort() : [];
  if (
    decision?.outcome !== "passed"
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || String(decision.integrationSha || "").toLowerCase() !== candidate.manifest.integration.sha
    || decisionPacketDigest !== packet.packetDigest
    || JSON.stringify(decidedTaskIds) !== JSON.stringify(expectedTaskIds)
    || !String(decision.author || "").trim()
    || !Number.isFinite(Date.parse(decision.repositoryVerifiedAt || ""))
    || !Number.isFinite(Date.parse(decision.decidedAt || ""))
  ) {
    throw new Error(`Candidate ${candidate.id} historical owner-QA decision is invalid.`);
  }
  const staleTasks = candidate.manifest.sources.filter((source) => {
    const task = (state.tasks || []).find((item) => item.id === source.taskId);
    if (!task) return false;
    return !taskHasPromotionExposureAuthority(task, candidate, task.status, null);
  }).map((source) => (state.tasks || []).find((item) => item.id === source.taskId));
  if (!staleTasks.length) return { bundle, staleTasks: [] };
  for (const task of staleTasks) {
    if (
      task.status !== "needs_changes"
      || task.assignedAgentRole !== "builder"
      || task.promotionStatus !== "validation_failed"
      || task.promotionPrUrl !== candidate.promotion?.prUrl
      || task.promotionBranch !== candidate.promotion?.branch
    ) {
      throw new Error(
        `Candidate ${candidate.id} task ${task.id} is not the exact stale post-merge validation-result signature.`,
      );
    }
  }
  return { bundle, staleTasks };
}

/**
 * Restore only reconciliation admission after GitHub proves that a stranded
 * persisted release PR is already merged. Merge authority itself is still
 * granted later by the ordinary v4 claim and claimed reconciliation path.
 */
export async function recoverMergedPromotionAdmissionState(candidateId, observation, options = {}) {
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("Merged promotion recovery requires a candidate ID.");
  let authorizedTasks = null;
  return mutateDatabaseState((state) => {
    const candidate = (state.candidates || []).find((item) => item.id === id);
    if (!candidate) throw new Error(`Unknown merged promotion recovery candidate: ${id}`);
    const { staleTasks } = assertHistoricalReleaseCandidateAuthority(state, candidate);
    const authority = mergedPromotionRecoveryAuthorityForState(state, candidate);
    assertMergedPromotionRecoveryObservation(authority, observation);
    if (!staleTasks.length) {
      authorizedTasks = candidate.manifest.sources
        .map((source) => (state.tasks || []).find((task) => task.id === source.taskId));
      return { candidateId: id, repaired: false, reason: "already_reconciliation_safe" };
    }
    const observedAt = new Date(observation.observedAt).toISOString();
    for (const task of staleTasks) {
      const failureProvenance = observation.recoveryProvenance?.staleTasks
        ?.find((item) => item.taskId === task.id);
      if (!failureProvenance) {
        throw new Error(`Candidate ${candidate.id} task ${task.id} has no sealed recovery chronology.`);
      }
      task.status = "promotion_blocked";
      task.assignedAgentRole = "promotion-worker";
      task.assignedThreadId = "";
      task.reviewerThreadId = "";
      task.retryNotBefore = "";
      task.promotionStatus = "remote_merge_reconciliation_pending";
      task.promotionPrUrl = candidate.promotion.prUrl;
      task.promotionBranch = candidate.promotion.branch;
      task.promotionUpdatedAt = observedAt;
      task.promotionRecovery = {
        schemaVersion: "studioops.merged-promotion-admission-recovery.v1",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        prUrl: observation.pr.url,
        mergeCommit: observation.pr.mergeCommit,
        mergedAt: observation.pr.mergedAt,
        observedAt,
        validationFailure: {
          preserved: true,
          recordedAt: failureProvenance.failureRecordedAt,
          evidenceDigest: failureProvenance.validationDigest,
        },
      };
      task.updatedAt = observedAt;
    }
    state.events = state.events || [];
    if (!state.events.some((event) => (
      event.type === "merged_promotion_admission_recovered"
      && event.candidateId === candidate.id
      && event.mergeCommit === observation.pr.mergeCommit
    ))) {
      state.events.push({
        id: `event_${randomUUID()}`,
        type: "merged_promotion_admission_recovered",
        projectId: candidate.projectId,
        taskId: "",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        prUrl: observation.pr.url,
        mergeCommit: observation.pr.mergeCommit,
        mergedAt: observation.pr.mergedAt,
        message: `Restored claimed reconciliation admission for already-merged candidate ${candidate.id}; the late validation failure remains preserved as a warning.`,
        createdAt: observedAt,
      });
    }
    authorizedTasks = candidate.manifest.sources
      .map((source) => (state.tasks || []).find((task) => task.id === source.taskId));
    return { candidateId: id, repaired: true, taskIds: staleTasks.map((task) => task.id) };
  }, {
    idempotent: true,
    ...options,
    operationName: options.operationName || "promotion.recover_merged_admission",
    mergedPromotionRecoveryCapability: MERGED_PROMOTION_RECOVERY_WRITE,
    mergedPromotionRecoveryCandidateId: id,
    get mergedPromotionRecoveryTaskRecords() { return authorizedTasks; },
  });
}

function githubPullRequestRepository(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return "";
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || segments.length !== 4
    || segments[2] !== "pull"
    || !/^[1-9][0-9]*$/.test(segments[3])
  ) return "";
  return `${segments[0]}/${segments[1]}`.toLowerCase();
}

/** Narrow writer for claim-bound promotion evidence, handoff, and merge authority. */
export async function mutateCandidatePromotionState(candidateId, claim, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("Candidate promotion writer requires a mutator.");
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("Candidate promotion writer requires a candidate ID.");
  let authorizedPromotion = null;
  let authorizedPromotionMerge = null;
  let authorizedRecoveryReceipt = null;
  let authorizedClaim = null;
  let authorizedClaimPresent = false;
  return mutateDatabaseState(async (state) => {
    const candidate = (state.candidates || []).find((item) => item.id === id);
    if (!candidate) throw new Error(`Unknown promotion candidate: ${id}`);
    const before = {
      promotion: candidate.promotion || null,
      promotionMerge: candidate.promotionMerge || null,
      recovery: candidate.promotionValidationRecoveryReceipt || null,
    };
    const claimsBefore = promotionClaims(state.meta);
    const previousClaimPresent = Object.prototype.hasOwnProperty.call(claimsBefore, id);
    const previousClaim = previousClaimPresent ? structuredClone(claimsBefore[id]) : undefined;
    if (!previousClaimPresent) {
      throw new Error(`Candidate ${id} promotion writer requires the exact current fenced claim.`);
    }
    try {
      assertPromotionAttemptClaimInState(state, claim);
    } catch (error) {
      error.code = error.code || "PROMOTION_ATTEMPT_STALE";
      throw error;
    }
    const result = await mutator(state);
    const current = (state.candidates || []).find((item) => item.id === id);
    assertPromotionAttemptClaimTransitionAttestation(result, id, previousClaim, state);
    const currentClaims = promotionClaims(state.meta);
    authorizedClaimPresent = Object.prototype.hasOwnProperty.call(currentClaims, id);
    authorizedClaim = authorizedClaimPresent ? structuredClone(currentClaims[id]) : null;
    const currentClaim = currentClaims[id];
    const attestedRecoveryReceipt = result?.receipt || null;
    if (!before.recovery && (current?.promotionValidationRecoveryReceipt || attestedRecoveryReceipt)) {
      if (
        !current?.promotionValidationRecoveryReceipt
        || !attestedRecoveryReceipt
        || canonicalJson(current.promotionValidationRecoveryReceipt) !== canonicalJson(attestedRecoveryReceipt)
      ) {
        throw new Error(
          `Candidate ${id} promotion validation receipt must exactly match the private claim helper result.`,
        );
      }
      if (currentClaim.status !== "active") {
        throw new Error(`Candidate ${id} promotion validation receipt requires an active fenced claim.`);
      }
      authorizedRecoveryReceipt = structuredClone(attestedRecoveryReceipt);
    }
    if (!before.promotion && current?.promotion) {
      const project = (state.projects || []).find((item) => item.id === current.projectId);
      const repository = project ? assertCanonicalCandidateRepositoryAuthority(project).repository : "";
      if (
        currentClaim.status !== "terminal"
        || !["pr_ready", "pr_merged_detected"].includes(currentClaim.outcome)
        || !["create", "retry"].includes(currentClaim.mode)
        || current.status !== "release_candidate_ready"
        || current.promotion.commitSha !== current.manifest.integration.sha
        || current.promotion.manifestDigest !== current.manifestDigest
        || !Number.isFinite(Date.parse(current.promotion.readyAt || ""))
        || githubPullRequestRepository(current.promotion.prUrl) !== repository
      ) {
        throw new Error(`Candidate ${id} promotion handoff does not match its fenced claim and repository authority.`);
      }
      assertPromotionRemoteObservation({
        projectId: project.id,
        repoUrl: project.repoUrl,
        targetBranch: current.manifest.base.branch,
        promotionBranch: current.promotion.branch,
        headSha: current.manifest.integration.sha,
        candidate: current,
        subjectCandidate: current,
        claim: currentClaim,
      }, options.promotionRemoteObservation, {
        state: currentClaim.outcome === "pr_merged_detected" ? "MERGED" : "OPEN",
        prUrl: current.promotion.prUrl,
      });
      authorizedPromotion = structuredClone(current.promotion);
    }
    if (!before.promotionMerge && current?.promotionMerge) {
      const terminal = currentClaim.terminalResult;
      const replacementId = String(current.promotionMerge.reconciledByCandidateId || "");
      const remoteCandidate = replacementId
        ? (state.candidates || []).find((item) => item.id === replacementId)
        : current;
      const remotePromotion = remoteCandidate?.promotion;
      const replacementMatches = !replacementId || Boolean(
        remoteCandidate
        && remoteCandidate.status === "merged"
        && remoteCandidate.manifestDigest === current.promotionMerge.reconciledByManifestDigest
        && remoteCandidate.promotionMerge?.mergeCommit === current.promotionMerge.mergeCommit
        && remoteCandidate.promotionMerge?.mergedAt === current.promotionMerge.mergedAt
      );
      if (
        currentClaim.status !== "terminal"
        || currentClaim.outcome !== "merged"
        || currentClaim.mode !== "reconcile"
        || current.status !== "merged"
        || !terminal
        || terminal.candidateId !== current.id
        || terminal.manifestDigest !== current.manifestDigest
        || terminal.prUrl !== remotePromotion?.prUrl
        || terminal.mergeCommit !== current.promotionMerge.mergeCommit
        || terminal.mergedAt !== current.promotionMerge.mergedAt
        || !replacementMatches
      ) {
        throw new Error(`Candidate ${id} merge authority does not match its fenced remote observation.`);
      }
      const project = (state.projects || []).find((item) => item.id === current.projectId);
      if (!project) throw new Error(`Candidate ${id} merge authority has no project.`);
      assertPromotionRemoteObservation({
        projectId: project.id,
        repoUrl: project.repoUrl,
        targetBranch: remoteCandidate.manifest.base.branch,
        promotionBranch: remotePromotion.branch,
        headSha: remoteCandidate.manifest.integration.sha,
        candidate: remoteCandidate,
        subjectCandidate: current,
        claim: currentClaim,
      }, options.promotionRemoteObservation, {
        state: "MERGED",
        prUrl: terminal.prUrl,
        mergeCommit: terminal.mergeCommit,
        mergedAt: terminal.mergedAt,
      });
      assertPromotionMergeAncestryObservation({
        projectId: project.id,
        repoUrl: project.repoUrl,
        targetBranch: remoteCandidate.manifest.base.branch,
        promotionBranch: remotePromotion.branch,
        subjectCandidate: current,
        remoteCandidate,
        claim: currentClaim,
        prUrl: terminal.prUrl,
        mergeCommit: terminal.mergeCommit,
        mergedAt: terminal.mergedAt,
        remoteObservation: options.promotionRemoteObservation,
      }, options.promotionMergeAncestryObservation);
      authorizedPromotionMerge = structuredClone(current.promotionMerge);
    }
    return result;
  }, {
    idempotent: true,
    ...options,
    candidatePromotionCapability: CANDIDATE_PROMOTION_WRITE,
    promotionClaimCapability: PROMOTION_CLAIM_WRITE,
    get candidatePromotionCandidateId() { return id; },
    get candidatePromotionRecord() { return authorizedPromotion; },
    get candidatePromotionMergeRecord() { return authorizedPromotionMerge; },
    get candidatePromotionValidationRecoveryReceiptRecord() { return authorizedRecoveryReceipt; },
    get promotionClaimCandidateId() { return id; },
    get promotionClaimRecordPresent() { return authorizedClaimPresent; },
    get promotionClaimRecord() { return authorizedClaim; },
  });
}

/**
 * Narrow writer for an owner's durable request to revoke an already-passed QA
 * decision. The writer derives the immutable coordinates from current state so
 * a generic caller cannot plant an intent for a different candidate or packet.
 */
export async function mutateQaRevocationIntentState(candidateId, input = {}, mutator = null, options = {}) {
  if (mutator !== null && typeof mutator !== "function") {
    throw new Error("QA revocation intent writer requires a mutator function when one is supplied.");
  }
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("QA revocation intent writer requires a candidate ID.");
  let authorizedIntent = null;
  return mutateDatabaseState(async (state) => {
    const candidate = (state.candidates || []).find((item) => item.id === id);
    if (!candidate) throw new Error(`Unknown QA revocation candidate: ${id}`);
    if (candidate.invalidation || !["qa_passed", "release_candidate_ready"].includes(candidate.status)) {
      throw new Error("A durable QA revocation intent is only valid for an active QA-passed or release-ready candidate.");
    }
    const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
    const packet = assertCurrentOwnerQaPacket(state, candidate, bundle);
    const sourceTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
    const suppliedTaskIds = Array.isArray(input.taskIds) ? input.taskIds.map(String).sort() : sourceTaskIds;
    if (
      String(input.outcome || "failed").trim().toLowerCase() !== "failed"
      || (input.candidateId !== undefined && String(input.candidateId) !== candidate.id)
      || (input.manifestDigest !== undefined && String(input.manifestDigest) !== candidate.manifestDigest)
      || (input.integrationSha !== undefined && String(input.integrationSha).toLowerCase() !== candidate.manifest.integration.sha)
      || String(input.ownerQaPacketDigest || "") !== packet.packetDigest
      || JSON.stringify(suppliedTaskIds) !== JSON.stringify(sourceTaskIds)
    ) {
      throw new Error("QA revocation intent does not match the current immutable owner-QA authority.");
    }
    if (candidate.qaRevocationIntent) {
      authorizedIntent = structuredClone(assertQaRevocationIntent(candidate, candidate.qaRevocationIntent));
    } else {
      const requestedAt = new Date().toISOString();
      const coordinates = qaRevocationIntentCoordinates(candidate, {
        ownerQaPacketDigest: packet.packetDigest,
      });
      authorizedIntent = {
        schemaVersion: "studioops.qa-revocation-intent.v1",
        requestId: `qa_revocation_${randomUUID()}`,
        outcome: "failed",
        ...coordinates,
        author: String(input.author || "Owner QA").trim(),
        notes: String(input.notes || input.body || "").trim(),
        requestedAt,
      };
      assertQaRevocationIntent(candidate, authorizedIntent);
      candidate.qaRevocationIntent = structuredClone(authorizedIntent);
      candidate.updatedAt = requestedAt;
    }
    const result = mutator
      ? await mutator(state, structuredClone(authorizedIntent))
      : structuredClone(authorizedIntent);
    const current = (state.candidates || []).find((item) => item.id === id);
    if (JSON.stringify(current?.qaRevocationIntent) !== JSON.stringify(authorizedIntent)) {
      throw new Error(`Candidate ${id} QA revocation intent changed during its fenced write.`);
    }
    return result;
  }, {
    idempotent: true,
    ...options,
    qaRevocationIntentCapability: QA_REVOCATION_INTENT_WRITE,
    get qaRevocationIntentCandidateId() { return id; },
    get qaRevocationIntentRecord() { return authorizedIntent; },
  });
}

/**
 * Narrow writer for the local half of an externally observed QA revocation.
 * Generic state writers cannot mint a settlement that re-enables promotion.
 */
export async function mutateQaRevocationSettlementState(candidateId, observation, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("QA revocation settlement writer requires a mutator.");
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("QA revocation settlement writer requires a candidate ID.");
  let authorizedSettlement = null;
  return mutateDatabaseState((state) => {
    const candidate = (state.candidates || []).find((item) => item.id === id);
    if (!candidate) throw new Error(`Unknown QA revocation candidate: ${id}`);
    assertQaRevocationRemoteObservation(candidate, observation);
    authorizedSettlement = normalizeQaRevocationSettlement(candidate, observation);
    return mutator(state, structuredClone(authorizedSettlement));
  }, {
    idempotent: true,
    ...options,
    qaRevocationSettlementCapability: QA_REVOCATION_SETTLEMENT_WRITE,
    get qaRevocationSettlementCandidateId() { return id; },
    get qaRevocationSettlementRecord() { return authorizedSettlement; },
  });
}

function failureIncidentFromRow(row) {
  if (!row) return null;
  const incident = assertFailureIncident(parsePayload(row.payload, null));
  if (
    incident.incidentId !== row.incident_id
    || incident.taskId !== row.task_id
    || incident.fingerprintDigest !== row.fingerprint_digest
    || incident.state !== row.state
    || incident.generation !== Number(row.generation)
    || incident.evidenceDigest !== row.evidence_digest
  ) throw new Error(`Failure incident ${row.incident_id} indexed fields do not match its payload.`);
  return incident;
}

function latestFailureIncidentRow(db, taskId, fingerprintDigest) {
  return db.prepare(`
    SELECT * FROM failure_incidents
    WHERE task_id = ? AND fingerprint_digest = ?
    ORDER BY generation DESC
    LIMIT 1
  `).get(taskId, fingerprintDigest);
}

function supersedePriorFailureGeneration(db, previous, current) {
  if (!previous || previous.incidentId === current.incidentId) return;
  const superseded = assertFailureIncident({
    ...previous,
    state: "superseded",
    backoffUntil: "",
    updatedAt: current.updatedAt,
  });
  upsertFailureIncidentRow(db, superseded);
}

function failureClaimAuthority(input = {}) {
  const fingerprint = failureFingerprint(input);
  const evidence = failureEvidence(input.evidence || {});
  return { fingerprint, evidence };
}

function equivalentFailureIncident(db, authority) {
  const incidents = db.prepare(`SELECT * FROM failure_incidents WHERE task_id = ? AND state NOT IN ('closed', 'superseded')`)
    .all(authority.fingerprint.value.taskId).map(failureIncidentFromRow);
  return selectFailureIncident(incidents, authority.fingerprint.value);
}

async function beginFailureContainmentTransaction(db, operationName) {
  const deadlineAt = Date.now() + SERIALIZED_REPLAY_LOCK_DEADLINE_MS;
  let attempts = 0;
  while (true) {
    try {
      beginSerializedReplayTransaction(db, operationName, deadlineAt, attempts);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadlineAt) throw error;
      await sleep(Math.min(retryDelayMs(++attempts), Math.max(1, deadlineAt - Date.now())));
    }
  }
}

/**
 * Atomically claim one paid model attempt from the current evidence generation.
 * SDK, CLI, dispatcher, and watchdog callers share this single table and cap.
 */
export async function claimFailureContainmentPaidAttempt(input = {}) {
  const authority = failureClaimAuthority(input);
  return withStateDatabaseConnection(async (db) => {
    await beginFailureContainmentTransaction(db, "failure_containment.claim_paid_attempt");
    try {
      const meta = parsePayload(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get()?.payload, {});
      assertMaintenanceWriteAllowed({ meta });
      const equivalent = equivalentFailureIncident(db, authority);
      const previous = equivalent?.incident || failureIncidentFromRow(latestFailureIncidentRow(
        db, authority.fingerprint.value.taskId, authority.fingerprint.digest,
      ));
      let initial = previous || createFailureIncident({
        fingerprint: authority.fingerprint,
        evidence: authority.evidence,
        now: input.now,
      });
      const alias = previous && previous.fingerprintDigest !== authority.fingerprint.digest;
      const evidence = alias && !input.verifier ? failureEvidence(previous.evidence) : authority.evidence;
      if (equivalent?.paidAttempts >= 2 && initial.paidAttempts < 2 && evidence.digest === initial.evidenceDigest) {
        initial = openFailureCircuit(initial, input);
      }
      const result = claimPaidFailureAttempt(initial, {
        ...input,
        evidence,
      });
      supersedePriorFailureGeneration(db, previous, result.incident);
      upsertFailureIncidentRow(db, result.incident);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, { operationName: "failure_containment.claim_paid_attempt" });
}

async function mutateFailureIncident(input, transition, options = {}) {
  const authority = failureClaimAuthority(input);
  return withStateDatabaseConnection(async (db) => {
    await beginFailureContainmentTransaction(db, "failure_containment.transition");
    try {
      const meta = parsePayload(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get()?.payload, {});
      assertMaintenanceWriteAllowed({ meta });
      const previous = equivalentFailureIncident(db, authority)?.incident || failureIncidentFromRow(latestFailureIncidentRow(
        db, authority.fingerprint.value.taskId, authority.fingerprint.digest,
      ));
      const initial = previous || (options.createIfMissing ? createFailureIncident({
        fingerprint: authority.fingerprint,
        evidence: authority.evidence,
        now: input.now,
      }) : null);
      if (!initial) throw new Error("Failure incident does not exist.");
      const alias = previous && previous.fingerprintDigest !== authority.fingerprint.digest;
      const current = transition(initial, alias && !input.verifier ? failureEvidence(previous.evidence) : authority.evidence);
      supersedePriorFailureGeneration(db, previous, current);
      upsertFailureIncidentRow(db, current);
      db.exec("COMMIT");
      return current;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, { operationName: "failure_containment.transition" });
}

export async function recordFailureContainmentActivity(input = {}) {
  return mutateFailureIncident(input, (incident, evidence) => recordFailureRecoveryActivity(incident, {
    ...input,
    evidence,
  }), { createIfMissing: true });
}

export async function scheduleFailureContainmentBackoff(input = {}) {
  return mutateFailureIncident(input, (incident, evidence) => {
    if (incident.evidenceDigest !== evidence.digest) throw new Error("Failure backoff evidence generation changed.");
    return scheduleFailureBackoff(incident, input);
  });
}

export async function openFailureContainmentCircuit(input = {}) {
  return mutateFailureIncident(input, (incident, evidence) => {
    if (incident.evidenceDigest !== evidence.digest) throw new Error("Failure circuit evidence generation changed.");
    return openFailureCircuit(incident, input);
  });
}

/** Indexed operational query; never scans run payloads. */
export async function readFailureIncidents(input = {}) {
  const db = await ensureReadOnlyStateDatabase();
  const where = [];
  const parameters = [];
  if (input.taskId) {
    where.push("task_id = ?");
    parameters.push(String(input.taskId));
  }
  if (input.fingerprintDigest) {
    where.push("fingerprint_digest = ?");
    parameters.push(String(input.fingerprintDigest).toLowerCase());
  }
  if (input.state) {
    where.push("state = ?");
    parameters.push(String(input.state));
  }
  const limit = Math.floor(Math.min(500, Math.max(1, Number(input.limit || 100))));
  parameters.push(limit);
  const rows = db.prepare(`
    SELECT * FROM failure_incidents
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, incident_id DESC
    LIMIT ?
  `).all(...parameters);
  return rows.map(failureIncidentFromRow);
}

/** Cursor-paginated failure rows for the bounded owner progress read model. */
export async function readFailureIncidentPage(input = {}) {
  const db = await ensureReadOnlyStateDatabase();
  const where = [];
  const parameters = [];
  const taskIds = [...new Set((input.taskIds || []).map(String).filter(Boolean))].slice(0, 500);
  if (input.projectId) {
    where.push("EXISTS (SELECT 1 FROM tasks AS scoped_task WHERE scoped_task.id = failure_incidents.task_id AND scoped_task.project_id = ?)");
    parameters.push(String(input.projectId));
  } else if (taskIds.length) {
    where.push(`task_id IN (${taskIds.map(() => "?").join(", ")})`);
    parameters.push(...taskIds);
  } else if (input.requireTaskScope !== false) {
    return { incidents: [], limit: Math.min(100, Math.max(1, Number(input.limit || 100))), nextCursor: "" };
  }
  if (input.updatedAfter) {
    where.push("updated_at >= ?");
    parameters.push(String(input.updatedAfter));
  }
  if (input.cursor?.updatedAt && input.cursor?.incidentId) {
    where.push("(updated_at < ? OR (updated_at = ? AND incident_id < ?))");
    parameters.push(String(input.cursor.updatedAt), String(input.cursor.updatedAt), String(input.cursor.incidentId));
  }
  const limit = Math.floor(Math.min(100, Math.max(1, Number(input.limit || 100))));
  parameters.push(limit + 1);
  const rows = db.prepare(`
    SELECT * FROM failure_incidents
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, incident_id DESC
    LIMIT ?
  `).all(...parameters);
  const hasMore = rows.length > limit;
  const incidents = rows.slice(0, limit).map(failureIncidentFromRow);
  const last = incidents.at(-1);
  return {
    incidents,
    limit,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, incidentId: last.incidentId }), "utf8").toString("base64url")
      : "",
  };
}

/** Aggregate counters are independent of the incident detail page size. */
export async function readFailureIncidentTotals(input = {}) {
  const db = await ensureReadOnlyStateDatabase();
  const where = [];
  const parameters = [];
  const taskIds = [...new Set((input.taskIds || []).map(String).filter(Boolean))].slice(0, 500);
  if (input.projectId) {
    where.push("EXISTS (SELECT 1 FROM tasks AS scoped_task WHERE scoped_task.id = failure_incidents.task_id AND scoped_task.project_id = ?)");
    parameters.push(String(input.projectId));
  } else if (taskIds.length) {
    where.push(`task_id IN (${taskIds.map(() => "?").join(", ")})`);
    parameters.push(...taskIds);
  } else if (input.requireTaskScope !== false) {
    return { containedFingerprintGenerations: 0, cheapProbesAndRepairs: 0, paidModelAttempts: 0, avoidedModelRetries: 0 };
  }
  if (input.updatedAfter) {
    where.push("updated_at >= ?");
    parameters.push(String(input.updatedAfter));
  }
  const row = db.prepare(`
    SELECT
      coalesce(sum(CASE WHEN state IN ('open', 'backoff') THEN 1 ELSE 0 END), 0) AS contained_fingerprint_generations,
      coalesce(sum(cheap_probe_attempts + repair_attempts), 0) AS cheap_probes_and_repairs,
      coalesce(sum(paid_attempts), 0) AS paid_model_attempts,
      coalesce(sum(avoided_retries), 0) AS avoided_model_retries
    FROM failure_incidents
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `).get(...parameters);
  return {
    containedFingerprintGenerations: Number(row.contained_fingerprint_generations || 0),
    cheapProbesAndRepairs: Number(row.cheap_probes_and_repairs || 0),
    paidModelAttempts: Number(row.paid_model_attempts || 0),
    avoidedModelRetries: Number(row.avoided_model_retries || 0),
  };
}

export async function databaseContentionHealth(input = {}) {
  const db = await ensureReadOnlyStateDatabase();
  const windowMinutes = Math.min(1_440, Math.max(1, Number(input.windowMinutes) || 15));
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const failureTelemetry = await readFailedContentionEvents();
  const failed = failureTelemetry.events.filter((event) => event.created_at >= cutoff);
  const aggregate = db.prepare(`
    SELECT
      count(*) AS operation_count,
      coalesce(sum(retry_count), 0) AS retry_count,
      coalesce(max(wait_ms), 0) AS max_wait_ms,
      coalesce(round(avg(wait_ms)), 0) AS average_wait_ms,
      coalesce(sum(wait_ms), 0) AS total_wait_ms,
      coalesce(max(duration_ms), 0) AS max_duration_ms,
      coalesce(round(avg(duration_ms)), 0) AS average_duration_ms,
      coalesce(sum(duration_ms), 0) AS total_duration_ms,
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
  const operationCount = Number(aggregate.operation_count || 0) + failed.length;
  const combinedRecent = [...recent, ...failed].sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 20);
  return {
    scope: "state_mutations",
    windowMinutes,
    operationCount,
    successfulOperationCount: Number(aggregate.operation_count || 0),
    failedOperationCount: failed.length,
    failureTelemetryAvailable: failureTelemetry.available && failureTelemetryWriteErrors === 0,
    retryCount: Number(aggregate.retry_count || 0) + failed.reduce((sum, event) => sum + event.retry_count, 0),
    maxWaitMs: Math.max(Number(aggregate.max_wait_ms || 0), ...failed.map((event) => event.wait_ms)),
    averageWaitMs: operationCount ? Math.round((Number(aggregate.total_wait_ms || 0) + failed.reduce((sum, event) => sum + event.wait_ms, 0)) / operationCount) : 0,
    maxDurationMs: Math.max(Number(aggregate.max_duration_ms || 0), ...failed.map((event) => event.duration_ms)),
    averageDurationMs: operationCount ? Math.round((Number(aggregate.total_duration_ms || 0) + failed.reduce((sum, event) => sum + event.duration_ms, 0)) / operationCount) : 0,
    lastOperationAt: [aggregate.last_operation_at || "", ...failed.map((event) => event.created_at)].sort().at(-1),
    recent: combinedRecent.map((event) => ({
      operation: event.operation_name,
      outcome: event.outcome,
      ...(event.failure_code ? { failureCode: event.failure_code } : {}),
      waitMs: Number(event.wait_ms || 0),
      durationMs: Number(event.duration_ms || 0),
      retries: Number(event.retry_count || 0),
      createdAt: event.created_at,
    })),
  };
}

export async function databaseStorageHealth() {
  const db = await ensureReadOnlyStateDatabase();
  const row = db.prepare(`
    SELECT updated_at
    FROM state_meta
    WHERE singleton_id = 1
  `).get();
  if (!row) throw new Error("StudioOps state database is not initialized.");
  return {
    storage: "sqlite",
    updatedAt: row.updated_at || "",
  };
}

export async function backupStateDatabase(destination = "") {
  const backupDir = path.join(DATA_DIR, "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.resolve(destination || path.join(backupDir, `mission-control-${timestamp}.sqlite3`));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await withStateDatabaseConnection((db) => backup(db, outputPath), { operationName: "state.backup" });
  await chmod(outputPath, 0o600);
  return outputPath;
}

// Hosted RC records are additive metadata on existing indexed aggregates. Absence is
// version zero and grants no authority; legacy candidate manifests are never rewritten.
function hostedRcStorageError(code) {
  const error = new Error(code); error.code = code; return error;
}
function assertHostedRcProtectedState(state, snapshot) {
  for (const table of ["projects", "candidates"]) {
    for (const item of state[table] || []) {
      const prior = snapshot.tables[table].get(item.id);
      const previous = prior ? JSON.parse(prior.payload).hostedRc : undefined;
      if (JSON.stringify(previous) !== JSON.stringify(item.hostedRc)) {
        throw hostedRcStorageError("authority_required");
      }
    }
    for (const [id, row] of snapshot.tables[table]) {
      if (JSON.parse(row.payload).hostedRc && !(state[table] || []).some((item) => item.id === id)) {
        throw hostedRcStorageError("authority_required");
      }
    }
  }
}

/** Internal persistence port; only workflow-state's hosted RC adapter supplies mutator. No network IO in a transaction. */
export async function mutateHostedRcAggregate(input, mutator) {
  if (!input || typeof input.projectId !== "string" || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0 || typeof mutator !== "function") throw hostedRcStorageError("state_conflict");
  return withStateDatabaseConnection((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const meta = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
      assertMaintenanceWriteAllowed({ meta: parsePayload(meta?.payload, {}) });
      const project = parsePayload(db.prepare("SELECT payload FROM projects WHERE id = ?").get(input.projectId)?.payload, null);
      if (!project) throw hostedRcStorageError("project_mismatch");
      const candidate = input.candidateId ? parsePayload(db.prepare(
        "SELECT payload FROM candidates WHERE id = ? AND project_id = ?",
      ).get(input.candidateId, input.projectId)?.payload, null) : null;
      if (input.candidateId && !candidate) throw hostedRcStorageError("candidate_mismatch");
      const aggregate = candidate || project;
      const previous = aggregate.hostedRc || null;
      if ((previous?.version || 0) !== input.expectedVersion) throw hostedRcStorageError("state_conflict");
      const reviewIds = [...new Set((candidate?.manifest?.sources || []).flatMap((s) => (s.reviews || []).map((r) => r.id)))];
      if (reviewIds.length > 128) throw hostedRcStorageError("history_limit");
      const reviews = reviewIds.length ? db.prepare(`SELECT payload FROM reviews WHERE id IN (${reviewIds.map(() => "?").join(",")}) ORDER BY id`)
        .all(...reviewIds).map((r) => parsePayload(r.payload, null)) : [];
      const result = mutator({ project: structuredClone(project), candidate: structuredClone(candidate),
        reviews, record: structuredClone(previous) });
      if (!result || typeof result.then === "function") throw hostedRcStorageError("authority_required");
      if (JSON.stringify(result.record) !== JSON.stringify(previous)) {
        if (!result.record || result.record.version !== input.expectedVersion + 1
          || Buffer.byteLength(JSON.stringify(result.record)) > 16 * 1024 * 1024) throw hostedRcStorageError("history_limit");
        aggregate.hostedRc = result.record;
        const table = candidate ? "candidates" : "projects";
        db.prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`).run(JSON.stringify(aggregate), aggregate.id);
        db.prepare("UPDATE state_meta SET version = version + 1 WHERE singleton_id = 1").run();
      }
      db.exec("COMMIT");
      return { ...result.value, version: result.record?.version || 0,
        queryCount: (candidate ? 3 : 2) + (reviewIds.length ? 1 : 0) };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }, { operationName: "hosted_rc.fenced_aggregate" });
}

/** Point lookup, not a full-board state load. Payloads stay behind workflow-state APIs. */
export async function readHostedRcAggregate(projectId, candidateId = "", includeReviews = false) {
  return withStateDatabaseRead((db) => {
    const project = parsePayload(db.prepare("SELECT payload FROM projects WHERE id = ?").get(projectId)?.payload, null);
    if (!project) throw hostedRcStorageError("project_mismatch");
    const candidate = candidateId ? parsePayload(db.prepare("SELECT payload FROM candidates WHERE id = ? AND project_id = ?")
      .get(candidateId, projectId)?.payload, null) : null;
    if (candidateId && !candidate) throw hostedRcStorageError("candidate_mismatch");
    const reviewIds = includeReviews ? [...new Set((candidate?.manifest?.sources || []).flatMap((s) => (s.reviews || []).map((r) => r.id)))].sort() : [];
    if (reviewIds.length > 128) throw hostedRcStorageError("history_limit");
    const reviews = reviewIds.length ? db.prepare(`SELECT payload FROM reviews WHERE id IN (${reviewIds.map(() => "?").join(",")}) ORDER BY id`)
      .all(...reviewIds).map((r) => parsePayload(r.payload, null)) : [];
    return { project, candidate, reviews, queryCount: (candidateId ? 2 : 1) + (reviewIds.length ? 1 : 0) };
  });
}
