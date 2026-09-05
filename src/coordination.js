import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { assertIsolatedTestEnvironment } from "./runtime-paths.js";
import { withStateDatabaseConnection, withStateDatabaseRead } from "./state-database.js";

const MAX_TEXT = 512;
const DEFAULT_LEASE_TTL_MS = 30_000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_LEASE_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_OPERATION_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const SECRET_PATTERN = /\b(?:authorization|bearer|password|passwd|secret|token|api[_-]?key|private[-_ ]?key)\s*[:=]/i;
const SENSITIVE_KEY_PATTERN = /(?:authorization|bearer|password|passwd|secret|token|api[_-]?key|private[-_ ]?key)/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function text(value, label, { required = true, max = MAX_TEXT } = {}) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && !normalized) throw new Error(`${label} is required.`);
  if (normalized.length > max) throw new Error(`${label} exceeds the bounded coordination field length.`);
  if (SECRET_PATTERN.test(normalized)) throw new Error(`${label} must not contain credentials or secret assignments.`);
  return normalized;
}

function positiveVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("expectedStateVersion must be a positive integer.");
  return version;
}

function coordinatorNow() {
  const testValue = process.env.STUDIOOPS_COORDINATION_TEST_NOW_MS;
  if (testValue !== undefined) {
    if (!process.env.NODE_TEST_CONTEXT && !process.env.STUDIOOPS_TEST_ISOLATION) {
      throw new Error("The coordination test clock is permitted only in a verified isolated test process.");
    }
    assertIsolatedTestEnvironment();
    const number = Number(testValue);
    if (!Number.isFinite(number)) throw new Error("The coordination test clock must be finite.");
    return number;
  }
  return Date.now();
}

function iso(ms) { return new Date(ms).toISOString(); }

function ownerIdentity(value) {
  return text(value || `pid:${process.pid}@${os.hostname()}`, "ownerProcessIdentity", { max: 160 });
}

function aggregateIdentity(input) {
  const aggregateType = text(input.aggregateType, "aggregateType", { max: 80 });
  if (aggregateType !== "task") throw new Error(`Unsupported coordination aggregate type: ${aggregateType}.`);
  return { aggregateType, aggregateId: text(input.aggregateId, "aggregateId", { max: 160 }) };
}

function authoritativeAggregateVersion(db, aggregateType, aggregateId) {
  if (aggregateType !== "task") throw new Error(`Unsupported coordination aggregate type: ${aggregateType}.`);
  const row = db.prepare("SELECT state_version FROM tasks WHERE id = ?").get(aggregateId);
  if (!row) throw new Error(`Coordination aggregate ${aggregateType}:${aggregateId} does not exist.`);
  return Number(row.state_version);
}

function assertAuthoritativeAggregateVersion(db, aggregateType, aggregateId, expectedStateVersion) {
  const current = authoritativeAggregateVersion(db, aggregateType, aggregateId);
  if (current !== Number(expectedStateVersion)) {
    throw new Error(`Coordination aggregate state version changed from ${expectedStateVersion} to ${current}.`);
  }
}

function boundedTtl(value) {
  const ttl = Number(value ?? DEFAULT_LEASE_TTL_MS);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) {
    throw new Error(`leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`);
  }
  return ttl;
}

function boundedRetention(value, minimum, label) {
  const retention = Number(value ?? minimum);
  if (!Number.isSafeInteger(retention) || retention < minimum) {
    throw new Error(`${label} must be at least ${minimum} milliseconds.`);
  }
  return retention;
}

function assertSafeEvidence(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidence(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SECRET_PATTERN.test(value)) throw new Error("Operation evidence must be secret-free.");
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error(`Operation evidence field ${path}.${key} is sensitive.`);
    assertSafeEvidence(item, `${path}.${key}`);
  }
}

function rowToLease(row) {
  if (!row) return null;
  return {
    leaseId: row.lease_id,
    resourceKey: row.resource_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    fence: Number(row.fence),
    ownerProcessIdentity: row.owner_process_identity,
    expectedStateVersion: Number(row.expected_state_version),
    status: row.status,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    terminalAt: row.terminal_at,
  };
}

function rowToOperation(row) {
  if (!row) return null;
  return {
    operationKey: row.operation_key,
    operationId: row.operation_id,
    kind: row.kind,
    requestDigest: row.request_digest,
    subject: row.subject,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    expectedRemoteState: row.expected_remote_state,
    leaseId: row.lease_id,
    fence: Number(row.fence),
    ownerProcessIdentity: row.owner_process_identity,
    expectedStateVersion: Number(row.expected_state_version),
    status: row.status,
    preparedAt: row.prepared_at,
    terminalAt: row.terminal_at,
    evidence: JSON.parse(row.evidence_json || "{}"),
  };
}

function leasePredicate(input) {
  return [
    text(input.leaseId, "leaseId"), Number(input.fence), ownerIdentity(input.ownerProcessIdentity),
    positiveVersion(input.expectedStateVersion),
  ];
}

async function transaction(callback) {
  return withStateDatabaseConnection((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, { operationName: "coordination.transaction" });
}

function currentLease(db, input, nowMs, activeOnly = true) {
  const [leaseId, fence, owner, version] = leasePredicate(input);
  const row = db.prepare(`
    SELECT * FROM coordination_leases
    WHERE lease_id = ? AND fence = ? AND owner_process_identity = ? AND expected_state_version = ?
      ${activeOnly ? "AND status = 'active' AND expires_at > ?" : ""}
  `).get(...(activeOnly ? [leaseId, fence, owner, version, iso(nowMs)] : [leaseId, fence, owner, version]));
  return row;
}

export async function claimResourceLease(input = {}) {
  const resourceKey = text(input.resourceKey, "resourceKey");
  const { aggregateType, aggregateId } = aggregateIdentity(input);
  const owner = ownerIdentity(input.ownerProcessIdentity);
  const expectedStateVersion = positiveVersion(input.expectedStateVersion);
  const nowMs = coordinatorNow();
  const ttl = boundedTtl(input.leaseTtlMs);
  return transaction((db) => {
    assertAuthoritativeAggregateVersion(db, aggregateType, aggregateId, expectedStateVersion);
    const existing = db.prepare("SELECT * FROM coordination_leases WHERE resource_key = ? AND status = 'active'").get(resourceKey);
    if (existing && existing.expires_at > iso(nowMs)) {
      return { acquired: false, lease: rowToLease(existing) };
    }
    if (existing) db.prepare("UPDATE coordination_leases SET status = 'expired', terminal_at = ? WHERE lease_id = ? AND status = 'active'").run(iso(nowMs), existing.lease_id);
    db.prepare(`
      INSERT INTO coordination_fence_counters(resource_key, last_fence, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(resource_key) DO UPDATE SET last_fence = last_fence + 1, updated_at = excluded.updated_at
    `).run(resourceKey, iso(nowMs));
    const fence = Number(db.prepare("SELECT last_fence FROM coordination_fence_counters WHERE resource_key = ?").get(resourceKey).last_fence);
    const leaseId = randomUUID();
    const acquiredAt = iso(nowMs);
    const expiresAt = iso(nowMs + ttl);
    db.prepare(`
      INSERT INTO coordination_leases(
        lease_id, resource_key, aggregate_type, aggregate_id, fence, owner_process_identity, expected_state_version, status,
        acquired_at, heartbeat_at, expires_at, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, '{}')
    `).run(leaseId, resourceKey, aggregateType, aggregateId, fence, owner, expectedStateVersion, acquiredAt, acquiredAt, expiresAt);
    return { acquired: true, lease: { leaseId, resourceKey, aggregateType, aggregateId, fence, ownerProcessIdentity: owner, expectedStateVersion, status: "active", acquiredAt, heartbeatAt: acquiredAt, expiresAt, terminalAt: "" } };
  });
}

export async function renewResourceLease(input = {}) {
  const nowMs = coordinatorNow();
  const expiresAt = iso(nowMs + boundedTtl(input.leaseTtlMs));
  return transaction((db) => {
    const predicate = leasePredicate(input);
    const result = db.prepare(`UPDATE coordination_leases SET heartbeat_at = ?, expires_at = ?
      WHERE lease_id = ? AND fence = ? AND owner_process_identity = ? AND expected_state_version = ?
        AND status = 'active' AND expires_at > ?`).run(iso(nowMs), expiresAt, ...predicate, iso(nowMs));
    if (result.changes !== 1) return null;
    return rowToLease(db.prepare("SELECT * FROM coordination_leases WHERE lease_id = ?").get(predicate[0]));
  });
}

async function endLease(input, status) {
  const nowMs = coordinatorNow();
  return transaction((db) => {
    const predicate = leasePredicate(input);
    const result = db.prepare(`UPDATE coordination_leases SET status = ?, terminal_at = ?
      WHERE lease_id = ? AND fence = ? AND owner_process_identity = ? AND expected_state_version = ?
        AND status = 'active' AND expires_at > ?`).run(status, iso(nowMs), ...predicate, iso(nowMs));
    return result.changes === 1 ? rowToLease(db.prepare("SELECT * FROM coordination_leases WHERE lease_id = ?").get(predicate[0])) : null;
  });
}

export const abandonResourceLease = (input) => endLease(input, "abandoned");
export const releaseResourceLease = (input) => endLease(input, "released");

function leaseForOperation(db, input, nowMs) {
  const row = currentLease(db, input, nowMs);
  if (!row) throw new Error("Operation requires the current unexpired matching lease.");
  return row;
}

function operationAuthorityMatches(operation, lease) {
  return operation.lease_id === lease.lease_id
    && Number(operation.fence) === Number(lease.fence)
    && operation.owner_process_identity === lease.owner_process_identity
    && Number(operation.expected_state_version) === Number(lease.expected_state_version);
}

function assertOperationIntentMatches(existing, input) {
  if (existing.kind !== input.kind || existing.subject !== input.subject
    || existing.expected_remote_state !== input.expectedRemoteState) {
    throw new Error("Operation key intent mismatch; refusing to adopt a different external operation.");
  }
}

export async function prepareExternalOperation(input = {}) {
  const operationKey = text(input.operationKey, "operationKey");
  const kind = text(input.kind, "kind");
  const requestDigest = text(input.requestDigest, "requestDigest", { max: 160 });
  const subject = text(input.subject, "subject");
  const expectedRemoteState = text(input.expectedRemoteState, "expectedRemoteState", { max: 1_024 });
  const nowMs = coordinatorNow();
  return transaction((db) => {
    const existing = db.prepare("SELECT * FROM external_operations WHERE operation_key = ?").get(operationKey);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Operation key payload mismatch; refusing to reuse the idempotency key.");
      assertOperationIntentMatches(existing, { kind, subject, expectedRemoteState });
      if (existing.status !== "prepared") return rowToOperation(existing);
      const lease = leaseForOperation(db, input, nowMs);
      assertAuthoritativeAggregateVersion(db, lease.aggregate_type, lease.aggregate_id, lease.expected_state_version);
      if (operationAuthorityMatches(existing, lease)) return rowToOperation(existing);
      const priorLease = db.prepare("SELECT * FROM coordination_leases WHERE lease_id = ?").get(existing.lease_id);
      if (!priorLease || priorLease.resource_key !== lease.resource_key
        || existing.aggregate_type !== lease.aggregate_type || existing.aggregate_id !== lease.aggregate_id) {
        throw new Error("Prepared operation cannot be adopted across resource or aggregate boundaries.");
      }
      if (priorLease.status === "active" && priorLease.expires_at > iso(nowMs)) {
        throw new Error("Prepared operation remains owned by an unexpired lease.");
      }
      const adopted = db.prepare(`UPDATE external_operations
        SET lease_id = ?, fence = ?, owner_process_identity = ?, expected_state_version = ?
        WHERE operation_key = ? AND status = 'prepared'
          AND lease_id = ? AND fence = ? AND owner_process_identity = ? AND expected_state_version = ?`)
        .run(
          lease.lease_id, lease.fence, lease.owner_process_identity, lease.expected_state_version,
          operationKey, existing.lease_id, existing.fence, existing.owner_process_identity, existing.expected_state_version,
        );
      if (adopted.changes !== 1) throw new Error("Prepared operation adoption compare-and-swap rejected.");
      return rowToOperation(db.prepare("SELECT * FROM external_operations WHERE operation_key = ?").get(operationKey));
    }
    const lease = leaseForOperation(db, input, nowMs);
    assertAuthoritativeAggregateVersion(db, lease.aggregate_type, lease.aggregate_id, lease.expected_state_version);
    const operationId = randomUUID();
    db.prepare(`INSERT INTO external_operations(
      operation_key, operation_id, kind, request_digest, subject, aggregate_type, aggregate_id, expected_remote_state,
      lease_id, fence, owner_process_identity, expected_state_version, status, prepared_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`)
      .run(operationKey, operationId, kind, requestDigest, subject, lease.aggregate_type, lease.aggregate_id, expectedRemoteState, lease.lease_id, lease.fence, lease.owner_process_identity, lease.expected_state_version, iso(nowMs));
    return rowToOperation(db.prepare("SELECT * FROM external_operations WHERE operation_key = ?").get(operationKey));
  });
}

export async function terminalExternalOperation(input = {}) {
  const operationKey = text(input.operationKey, "operationKey");
  const requestDigest = text(input.requestDigest, "requestDigest", { max: 160 });
  const status = input.status === "quarantined" ? "quarantined" : "succeeded";
  if (input.evidence && typeof input.evidence === "object") assertSafeEvidence(input.evidence);
  const evidence = input.evidence && typeof input.evidence === "object" ? JSON.stringify(input.evidence) : "{}";
  if (evidence.length > 2_048 || SECRET_PATTERN.test(evidence)) throw new Error("Operation evidence must be bounded and secret-free.");
  const nowMs = coordinatorNow();
  return transaction((db) => {
    const existing = db.prepare("SELECT * FROM external_operations WHERE operation_key = ?").get(operationKey);
    if (!existing) throw new Error("External operation is not prepared.");
    if (existing.request_digest !== requestDigest) throw new Error("Operation key payload mismatch; refusing terminal replay.");
    if (existing.status !== "prepared") {
      // A terminal replay is read-only, but it still needs the original authority tuple.
      const [, fence, owner, version] = leasePredicate(input);
      if (existing.lease_id !== input.leaseId || Number(existing.fence) !== fence
        || existing.owner_process_identity !== owner || Number(existing.expected_state_version) !== version) {
        throw new Error("External operation terminal replay rejected for a stale lease tuple.");
      }
      if (existing.status !== status) throw new Error("External operation terminal result is immutable.");
      return rowToOperation(existing);
    }
    const lease = leaseForOperation(db, input, nowMs);
    if (lease.aggregate_type !== existing.aggregate_type || lease.aggregate_id !== existing.aggregate_id) {
      throw new Error("External operation aggregate binding does not match the current lease.");
    }
    assertAuthoritativeAggregateVersion(db, existing.aggregate_type, existing.aggregate_id, existing.expected_state_version);
    const predicate = leasePredicate(input);
    const result = db.prepare(`UPDATE external_operations SET status = ?, terminal_at = ?, evidence_json = ?
      WHERE operation_key = ? AND request_digest = ? AND status = 'prepared' AND lease_id = ? AND fence = ?
        AND owner_process_identity = ? AND expected_state_version = ?`)
      .run(status, iso(nowMs), evidence, operationKey, requestDigest, ...predicate);
    if (result.changes !== 1) throw new Error("External operation terminal compare-and-swap rejected.");
    return rowToOperation(db.prepare("SELECT * FROM external_operations WHERE operation_key = ?").get(operationKey));
  });
}

export const completeExternalOperation = (input) => terminalExternalOperation({ ...input, status: "succeeded" });
export const quarantineExternalOperation = (input) => terminalExternalOperation({ ...input, status: "quarantined" });
export const digestOperationRequest = (payload) => `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
export const claimLease = claimResourceLease;
export const renewLease = renewResourceLease;
export const abandonLease = abandonResourceLease;
export const releaseLease = releaseResourceLease;

export async function compactCoordinationHistory(input = {}) {
  const nowMs = coordinatorNow();
  const leaseRetentionMs = boundedRetention(
    input.leaseDetailRetentionMs,
    MIN_LEASE_DETAIL_RETENTION_MS,
    "leaseDetailRetentionMs",
  );
  const operationRetentionMs = boundedRetention(
    input.operationEvidenceRetentionMs,
    MIN_OPERATION_EVIDENCE_RETENTION_MS,
    "operationEvidenceRetentionMs",
  );
  const leaseCutoff = iso(nowMs - leaseRetentionMs);
  const operationCutoff = iso(nowMs - operationRetentionMs);
  return transaction((db) => {
    const leases = db.prepare("UPDATE coordination_leases SET detail_json = '{}' WHERE status <> 'active' AND terminal_at <> '' AND terminal_at < ? AND detail_json <> '{}' ").run(leaseCutoff);
    const operations = db.prepare("UPDATE external_operations SET evidence_json = '{}' WHERE status <> 'prepared' AND terminal_at <> '' AND terminal_at < ? AND evidence_json <> '{}' ").run(operationCutoff);
    return { compactedLeases: leases.changes, compactedOperations: operations.changes };
  });
}

export async function listDueExternalOperations(input = {}) {
  const limit = Math.min(100, Math.max(1, Number(input.limit || 50)));
  return withStateDatabaseRead((db) => db.prepare("SELECT * FROM external_operations WHERE status = 'prepared' ORDER BY prepared_at ASC LIMIT ?").all(limit).map(rowToOperation));
}

export async function listExpiringLeases(input = {}) {
  const limit = Math.min(100, Math.max(1, Number(input.limit || 50)));
  return withStateDatabaseRead((db) => db.prepare("SELECT * FROM coordination_leases WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?").all(iso(coordinatorNow()), limit).map(rowToLease));
}
