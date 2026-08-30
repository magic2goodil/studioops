import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import test from "node:test";
import { createDeliveryTelemetryRepository } from "../src/delivery-telemetry-repository.js";
import { DATABASE_FILE, DELIVERY_TELEMETRY_SCHEMA_VERSION, ensureStateDatabase } from "../src/state-database.js";

const TABLES = ["delivery_events", "validation_evidence", "criterion_evidence", "metric_definitions",
  "metric_snapshots", "retrospective_jobs", "retrospectives", "improvement_proposals", "experiments", "journal_exports"];

test("verified additive migration installs all telemetry tables, indexes, and append-only triggers", async () => {
  await ensureStateDatabase();
  const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
    const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name));
    for (const table of TABLES) {
      assert.ok(tables.has(table), `missing ${table}`);
      assert.ok(triggers.has(`${table}_append_only_update`));
      assert.ok(triggers.has(`${table}_append_only_delete`));
    }
    for (const index of ["idx_delivery_events_project_time", "idx_delivery_events_task_time",
      "idx_delivery_events_run_time", "idx_delivery_events_type_time", "idx_validation_evidence_exact",
      "idx_retrospective_jobs_pending", "idx_improvement_proposals_open", "idx_experiments_due"]) {
      assert.ok(indexes.has(index), `missing ${index}`);
    }
    const meta = JSON.parse(db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get().payload);
    assert.equal(meta.deliveryTelemetryMigration.schemaVersion, DELIVERY_TELEMETRY_SCHEMA_VERSION);
    assert.equal(meta.deliveryTelemetryMigration.backupVerified, true);
    assert.ok((await stat(meta.deliveryTelemetryMigration.backupPath)).size > 0);
  } finally {
    db.close();
  }
});

test("database triggers reject silent mutation and deletion", async () => {
  const unique = randomUUID();
  const appended = await createDeliveryTelemetryRepository().appendDeliveryEvent({
    projectId: "studioops", stage: "migration_test", eventType: "delivery.persisted",
    occurredAt: "2040-02-03T00:00:00.000Z", sourceKind: "migration_test",
    sourceReference: `trigger:${unique}`, idempotencyKey: `trigger:${unique}`,
    measures: {}, attributes: {},
  });
  const db = await ensureStateDatabase();
  assert.throws(() => db.prepare("UPDATE delivery_events SET stage = 'changed' WHERE id = ?").run(appended.record.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM delivery_events WHERE id = ?").run(appended.record.id), /append-only/);
});
