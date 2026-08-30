import { randomUUID } from "node:crypto";
import {
  boundedListInput,
  DELIVERY_TELEMETRY_CONTRACT_VERSION,
  normalizeCriterionEvidence,
  normalizeDeliveryEvent,
  normalizeExperiment,
  normalizeImprovementProposal,
  normalizeJournalExport,
  normalizeMetricDefinition,
  normalizeMetricSnapshot,
  normalizeRetrospective,
  normalizeRetrospectiveJob,
  normalizeValidationEvidence,
} from "./delivery-telemetry.js";
import { ensureStateDatabase } from "./state-database.js";

export const DELIVERY_TELEMETRY_REPOSITORY_CONTRACT = Object.freeze({
  version: DELIVERY_TELEMETRY_CONTRACT_VERSION,
  compatibility: "Readers ignore unknown additive tables and fields; writers reject newer schema versions.",
  authority: "SQLite",
  methods: Object.freeze([
    "appendDeliveryEvent", "appendValidationEvidence", "appendCriterionEvidence",
    "appendMetricDefinition", "appendMetricSnapshot", "appendRetrospectiveJob",
    "appendRetrospective", "appendImprovementProposal", "appendExperiment",
    "appendJournalExport", "listDeliveryEvents", "listRetrospectivesByDate",
    "listValidationEvidence", "listPendingRetrospectiveJobs", "listOpenProposals",
    "listDueExperiments",
  ]),
});

function parse(row) {
  return row ? JSON.parse(row.record_json) : null;
}

function conflict(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "DELIVERY_TELEMETRY_IDEMPOTENCY_CONFLICT";
  return error;
}

function canonical(record) {
  return JSON.stringify(record);
}

function assertWritersEnabled(db) {
  const row = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
  const meta = JSON.parse(row?.payload || "{}");
  if (meta.deliveryTelemetryMigration?.writerEnabled !== false) return;
  const error = new Error("Delivery telemetry writers are disabled for rollback; existing ledger rows remain readable.");
  error.code = "DELIVERY_TELEMETRY_WRITERS_DISABLED";
  throw error;
}

function isBusy(error) {
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listResult(rows, limit, timestampField) {
  const items = rows.map(parse);
  const last = items.at(-1);
  return {
    items,
    nextCursor: items.length === limit && last
      ? { timestamp: last[timestampField], id: last.id }
      : null,
  };
}

const CONTRACTS = {
  delivery_events: {
    normalize: normalizeDeliveryEvent,
    insert: `INSERT INTO delivery_events(
      id, schema_version, project_id, task_id, run_id, candidate_id, commit_sha, stage,
      event_type, occurred_at, received_at, source_kind, source_reference,
      idempotency_key, measures_json, attributes_json, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.projectId, r.taskId, r.runId, r.candidateId,
      r.commitSha, r.stage, r.eventType, r.occurredAt, r.receivedAt, r.sourceKind,
      r.sourceReference, r.idempotencyKey, JSON.stringify(r.measures), JSON.stringify(r.attributes), json],
  },
  validation_evidence: {
    normalize: normalizeValidationEvidence,
    insert: `INSERT INTO validation_evidence(
      id, schema_version, event_id, check_name, subject_sha, outcome, observed_at,
      source_reference, idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.eventId, r.checkName, r.subjectSha,
      r.outcome, r.observedAt, r.sourceReference, r.idempotencyKey, json],
  },
  criterion_evidence: {
    normalize: normalizeCriterionEvidence,
    insert: `INSERT INTO criterion_evidence(
      id, schema_version, event_id, criterion_key, outcome, observed_at,
      evidence_reference, idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.eventId, r.criterionKey, r.outcome,
      r.observedAt, r.evidenceReference, r.idempotencyKey, json],
  },
  metric_definitions: {
    normalize: normalizeMetricDefinition,
    insert: `INSERT INTO metric_definitions(
      id, schema_version, metric_key, definition_version, numerator, denominator, unit,
      inclusion_rules_json, exclusion_rules_json, source_event_types_json,
      minimum_sample_size, percentile_method, target_direction, compatible_from,
      recorded_at, idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.metricKey, r.definitionVersion,
      r.numerator, r.denominator, r.unit, JSON.stringify(r.inclusionRules),
      JSON.stringify(r.exclusionRules), JSON.stringify(r.sourceEventTypes),
      r.minimumSampleSize, r.percentileMethod, r.targetDirection, r.compatibleFrom,
      r.recordedAt, r.idempotencyKey, json],
  },
  metric_snapshots: {
    normalize: normalizeMetricSnapshot,
    insert: `INSERT INTO metric_snapshots(
      id, schema_version, metric_definition_id, project_id, window_started_at,
      window_ended_at, value, numerator_value, denominator_value, sample_size,
      computed_at, idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.metricDefinitionId, r.projectId,
      r.windowStartedAt, r.windowEndedAt, r.value, r.numeratorValue, r.denominatorValue,
      r.sampleSize, r.computedAt, r.idempotencyKey, json],
  },
  retrospective_jobs: {
    normalize: normalizeRetrospectiveJob,
    insert: `INSERT INTO retrospective_jobs(
      id, schema_version, project_id, event_id, status, due_at, attempt, recorded_at,
      idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.projectId, r.eventId || null, r.status,
      r.dueAt, r.attempt, r.recordedAt, r.idempotencyKey, json],
  },
  retrospectives: {
    normalize: normalizeRetrospective,
    insert: `INSERT INTO retrospectives(
      id, schema_version, project_id, event_id, job_id, journal_date, title, recorded_at,
      idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.projectId, r.eventId, r.jobId || null,
      r.journalDate, r.title, r.recordedAt, r.idempotencyKey, json],
  },
  improvement_proposals: {
    normalize: normalizeImprovementProposal,
    insert: `INSERT INTO improvement_proposals(
      id, schema_version, project_id, retrospective_id, fingerprint, status, recorded_at,
      idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.projectId, r.retrospectiveId,
      r.fingerprint, r.status, r.recordedAt, r.idempotencyKey, json],
  },
  experiments: {
    normalize: normalizeExperiment,
    insert: `INSERT INTO experiments(
      id, schema_version, project_id, proposal_id, status, due_at, recorded_at,
      idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.projectId, r.proposalId, r.status,
      r.dueAt, r.recordedAt, r.idempotencyKey, json],
  },
  journal_exports: {
    normalize: normalizeJournalExport,
    insert: `INSERT INTO journal_exports(
      id, schema_version, journal_date, relative_path, content_sha256, entry_count,
      through_recorded_at, through_id, exported_at, idempotency_key, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: (r, json) => [r.id, r.schemaVersion, r.journalDate, r.relativePath,
      r.contentSha256, r.entryCount, r.throughRecordedAt, r.throughId, r.exportedAt,
      r.idempotencyKey, json],
  },
};

export function createDeliveryTelemetryRepository(options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const getDatabase = options.getDatabase || ensureStateDatabase;

  async function append(table, input) {
    const contract = CONTRACTS[table];
    const db = await getDatabase();
    assertWritersEnabled(db);
    const startedAt = performance.now();
    const writeTime = now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const requestedKey = String(input?.idempotencyKey || "").trim();
        const existingRow = requestedKey
          ? db.prepare(`SELECT record_json FROM ${table} WHERE idempotency_key = ?`).get(requestedKey)
          : null;
        if (existingRow) {
          const existing = parse(existingRow);
          const stableTime = existing.receivedAt || existing.recordedAt || existing.exportedAt;
          const record = contract.normalize(input, { now: () => stableTime });
          if (!record.id) record.id = existing.id;
          if (canonical(record) !== canonical(existing)) throw conflict(`Conflicting reuse of idempotency key ${record.idempotencyKey}.`);
          return { inserted: false, record: existing, durationMs: performance.now() - startedAt };
        }
        const record = contract.normalize(input, { now: () => writeTime });
        record.id ||= randomUUID();
        const json = canonical(record);
        db.prepare(contract.insert).run(...contract.values(record, json));
        return { inserted: true, record, durationMs: performance.now() - startedAt };
      } catch (error) {
        if (isBusy(error) && attempt < 8) {
          await wait(Math.min(20, 2 * (attempt + 1)));
          continue;
        }
        if (/UNIQUE constraint failed/.test(error.message || "")) {
          const requestedKey = String(input?.idempotencyKey || "").trim();
          const racedRow = requestedKey
            ? db.prepare(`SELECT record_json FROM ${table} WHERE idempotency_key = ?`).get(requestedKey)
            : null;
          if (racedRow) {
            const existing = parse(racedRow);
            const stableTime = existing.receivedAt || existing.recordedAt || existing.exportedAt;
            const record = contract.normalize(input, { now: () => stableTime });
            if (!record.id) record.id = existing.id;
            if (canonical(record) === canonical(existing)) {
              return { inserted: false, record: existing, durationMs: performance.now() - startedAt };
            }
          }
          throw conflict(`Conflicting reuse of a unique ${table} source or natural key.`, error);
        }
        throw error;
      }
    }
  }

  async function list(sql, parameters, input, timestampField, column) {
    const db = await getDatabase();
    const bounded = boundedListInput(input, timestampField);
    const cursorClause = bounded.cursor ? `AND (${column} > ? OR (${column} = ? AND id > ?))` : "";
    const cursorParameters = bounded.cursor
      ? [bounded.cursor.timestamp, bounded.cursor.timestamp, bounded.cursor.id]
      : [];
    const rows = db.prepare(`${sql} ${cursorClause} ORDER BY ${column} ASC, id ASC LIMIT ?`)
      .all(...parameters, ...cursorParameters, bounded.limit);
    return listResult(rows, bounded.limit, timestampField);
  }

  return Object.freeze({
    contract: DELIVERY_TELEMETRY_REPOSITORY_CONTRACT,
    appendDeliveryEvent: (input) => append("delivery_events", input),
    appendValidationEvidence: (input) => append("validation_evidence", input),
    appendCriterionEvidence: (input) => append("criterion_evidence", input),
    appendMetricDefinition: (input) => append("metric_definitions", input),
    appendMetricSnapshot: (input) => append("metric_snapshots", input),
    appendRetrospectiveJob: (input) => append("retrospective_jobs", input),
    appendRetrospective: (input) => append("retrospectives", input),
    appendImprovementProposal: (input) => append("improvement_proposals", input),
    appendExperiment: (input) => append("experiments", input),
    appendJournalExport: (input) => append("journal_exports", input),
    listDeliveryEvents(input = {}) {
      const filters = [];
      const parameters = [];
      for (const [property, column] of [["projectId", "project_id"], ["taskId", "task_id"], ["runId", "run_id"], ["eventType", "event_type"]]) {
        if (input[property]) { filters.push(`${column} = ?`); parameters.push(String(input[property])); }
      }
      return list(`SELECT record_json FROM delivery_events WHERE ${filters.length ? filters.join(" AND ") : "1 = 1"}`,
        parameters, input, "occurredAt", "occurred_at");
    },
    listValidationEvidence(input = {}) {
      const parameters = [String(input.eventId || "")];
      let sql = "SELECT record_json FROM validation_evidence WHERE event_id = ?";
      if (input.subjectSha) { sql += " AND subject_sha = ?"; parameters.push(String(input.subjectSha)); }
      if (input.checkName) { sql += " AND check_name = ?"; parameters.push(String(input.checkName)); }
      return list(sql, parameters, input, "observedAt", "observed_at");
    },
    listRetrospectivesByDate(input = {}) {
      return list("SELECT record_json FROM retrospectives WHERE journal_date = ?", [String(input.journalDate || "")], input, "recordedAt", "recorded_at");
    },
    listPendingRetrospectiveJobs(input = {}) {
      return list("SELECT record_json FROM retrospective_jobs WHERE status = 'pending' AND due_at <= ?", [String(input.dueBefore || now())], input, "dueAt", "due_at");
    },
    listOpenProposals(input = {}) {
      return list("SELECT record_json FROM improvement_proposals WHERE status = 'open' AND project_id = ?", [String(input.projectId || "")], input, "recordedAt", "recorded_at");
    },
    listDueExperiments(input = {}) {
      return list("SELECT record_json FROM experiments WHERE status IN ('planned', 'running') AND due_at <= ?", [String(input.dueBefore || now())], input, "dueAt", "due_at");
    },
  });
}
