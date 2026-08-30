import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDeliveryTelemetryRepository } from "../src/delivery-telemetry-repository.js";

function event(overrides = {}) {
  const unique = randomUUID();
  return {
    projectId: "studioops",
    taskId: "task_766",
    runId: "run_12864",
    candidateId: "candidate_1",
    commitSha: "a".repeat(40),
    stage: "builder",
    eventType: "delivery.completed",
    occurredAt: "2026-08-30T18:00:00.000Z",
    sourceKind: "task_completion",
    sourceReference: `task_79:${unique}`,
    idempotencyKey: `delivery:${unique}`,
    measures: { duration_ms: 12, retries: 0 },
    attributes: { outcome: "passed", adapter_version: "1" },
    ...overrides,
  };
}

test("delivery append is exact-retry idempotent and conflicting reuse fails closed", async () => {
  const repository = createDeliveryTelemetryRepository();
  const input = event();
  const first = await repository.appendDeliveryEvent(input);
  const retry = await repository.appendDeliveryEvent(input);
  assert.equal(first.inserted, true);
  assert.equal(retry.inserted, false);
  assert.deepEqual(retry.record, first.record);
  await assert.rejects(
    repository.appendDeliveryEvent({ ...input, stage: "lead_review" }),
    { code: "DELIVERY_TELEMETRY_IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    repository.appendDeliveryEvent({ ...input, idempotencyKey: `different:${randomUUID()}`, eventType: "delivery.failed" }),
    { code: "DELIVERY_TELEMETRY_IDEMPOTENCY_CONFLICT" },
  );
});

test("event validation bounds payloads and refuses sensitive attribute keys", async () => {
  const repository = createDeliveryTelemetryRepository();
  await assert.rejects(repository.appendDeliveryEvent(event({ attributes: { prompt_body: "private" } })), /not permitted/);
  await assert.rejects(repository.appendDeliveryEvent(event({ measures: { latency_ms: Number.POSITIVE_INFINITY } })), /bounded finite number/);
  await assert.rejects(repository.appendDeliveryEvent(event({ schemaVersion: 2 })), { code: "DELIVERY_TELEMETRY_SCHEMA_UNSUPPORTED" });
});

test("stable timestamp and ID cursors are bounded to 100", async () => {
  const repository = createDeliveryTelemetryRepository();
  const prefix = randomUUID();
  for (let index = 0; index < 3; index += 1) {
    await repository.appendDeliveryEvent(event({
      id: `${prefix}-${index}`,
      sourceReference: `task_80:${prefix}:${index}`,
      idempotencyKey: `cursor:${prefix}:${index}`,
      occurredAt: `2026-08-30T18:00:0${index}.000Z`,
    }));
  }
  const first = await repository.listDeliveryEvents({ projectId: "studioops", limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await repository.listDeliveryEvents({ projectId: "studioops", limit: 2, cursor: first.nextCursor });
  assert.ok(second.items.every((item) => item.id > first.items[0].id || item.occurredAt > first.items[0].occurredAt));
  await assert.rejects(repository.listDeliveryEvents({ limit: 101 }), /at most 100/);
});

test("10 concurrent duplicate-safe appends meet the synthetic local p95 budget", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE state_meta(singleton_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO state_meta VALUES (1, '{"deliveryTelemetryMigration":{"writerEnabled":true}}');
    CREATE TABLE delivery_events (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, project_id TEXT NOT NULL,
      task_id TEXT NOT NULL, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL, stage TEXT NOT NULL, event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, source_kind TEXT NOT NULL,
      source_reference TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
      measures_json TEXT NOT NULL, attributes_json TEXT NOT NULL, record_json TEXT NOT NULL
    );
  `);
  const repository = createDeliveryTelemetryRepository({ getDatabase: async () => db });
  const input = event();
  const results = await Promise.all(Array.from({ length: 10 }, () => repository.appendDeliveryEvent(input)));
  const durations = results.map((item) => item.durationMs).sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.equal(results.filter((item) => item.inserted).length, 1);
  assert.equal(results.length, 10);
  assert.ok(p95 <= 25, `expected p95 <= 25ms, observed ${p95.toFixed(2)}ms`);
  assert.equal(db.prepare("SELECT count(*) count FROM delivery_events").get().count, 1);
  db.close();
});

test("exact validation and criterion evidence retain adapter references", async () => {
  const repository = createDeliveryTelemetryRepository();
  const appended = await repository.appendDeliveryEvent(event());
  const subjectSha = "b".repeat(40);
  await repository.appendValidationEvidence({
    eventId: appended.record.id,
    checkName: "exact_sha_regression",
    subjectSha,
    outcome: "passed",
    observedAt: "2026-08-30T18:01:00.000Z",
    sourceReference: "task_550:attestation_1",
    idempotencyKey: `validation:${randomUUID()}`,
    command: "npm run check",
    artifactDigest: `sha256:${"c".repeat(64)}`,
  });
  await repository.appendCriterionEvidence({
    eventId: appended.record.id,
    criterionKey: "criterion_1",
    outcome: "passed",
    observedAt: "2026-08-30T18:02:00.000Z",
    evidenceReference: "task_631:admission_1",
    idempotencyKey: `criterion:${randomUUID()}`,
  });
  const evidence = await repository.listValidationEvidence({ eventId: appended.record.id, subjectSha });
  assert.equal(evidence.items.length, 1);
  assert.equal(evidence.items[0].sourceReference, "task_550:attestation_1");
});

test("metric, retrospective-job, proposal, and experiment contracts persist their required fields", async () => {
  const repository = createDeliveryTelemetryRepository();
  const unique = randomUUID();
  const source = await repository.appendDeliveryEvent(event({
    sourceReference: `task_631:${unique}`,
    idempotencyKey: `foundation-event:${unique}`,
  }));
  const definition = await repository.appendMetricDefinition({
    metricKey: `duplicate_append_p95_${unique}`,
    definitionVersion: 1,
    numerator: "p95 duplicate-safe append duration",
    denominator: "accepted delivery event appends",
    unit: "milliseconds",
    inclusionRules: ["local_writers"],
    exclusionRules: ["migration_startup"],
    sourceEventTypes: ["delivery.completed"],
    minimumSampleSize: 10,
    percentileMethod: "nearest-rank",
    targetDirection: "decrease",
    compatibleFrom: "2026-08-30",
    idempotencyKey: `metric:${unique}`,
    recordedAt: "2026-08-30T20:00:00.000Z",
  });
  const snapshot = await repository.appendMetricSnapshot({
    metricDefinitionId: definition.record.id,
    projectId: "studioops",
    windowStartedAt: "2026-08-30T19:00:00.000Z",
    windowEndedAt: "2026-08-30T20:00:00.000Z",
    value: 4.2,
    numeratorValue: 42,
    denominatorValue: 10,
    sampleSize: 10,
    computedAt: "2026-08-30T20:00:00.000Z",
    idempotencyKey: `snapshot:${unique}`,
  });
  const job = await repository.appendRetrospectiveJob({
    projectId: "studioops", eventId: source.record.id, status: "pending",
    dueAt: "2026-08-31T00:00:00.000Z", idempotencyKey: `job:${unique}`,
  });
  const retrospective = await repository.appendRetrospective({
    projectId: "studioops", eventId: source.record.id, jobId: job.record.id,
    journalDate: "2026-08-30", title: "Synthetic append budget",
    summary: "Duplicate appends stayed within the local budget.", observations: { p95_ms: 4.2 },
    idempotencyKey: `retro:${unique}`,
  });
  const proposal = await repository.appendImprovementProposal({
    projectId: "studioops", retrospectiveId: retrospective.record.id,
    fingerprint: `sha256:${unique.replaceAll("-", "")}`, status: "open",
    title: "Preserve targeted inserts", hypothesis: "Short inserts reduce local contention.",
    idempotencyKey: `proposal:${unique}`,
  });
  const experiment = await repository.appendExperiment({
    projectId: "studioops", proposalId: proposal.record.id, status: "planned",
    dueAt: "2026-09-01T00:00:00.000Z", hypothesis: "Targeted inserts remain below budget.",
    successMetricDefinitionId: definition.record.id, idempotencyKey: `experiment:${unique}`,
  });
  assert.equal(snapshot.record.sampleSize, 10);
  assert.equal(experiment.record.successMetricDefinitionId, definition.record.id);
  assert.equal((await repository.listPendingRetrospectiveJobs({ dueBefore: "2026-09-02T00:00:00.000Z" })).items.some((item) => item.id === job.record.id), true);
  assert.equal((await repository.listOpenProposals({ projectId: "studioops" })).items.some((item) => item.id === proposal.record.id), true);
  assert.equal((await repository.listDueExperiments({ dueBefore: "2026-09-02T00:00:00.000Z" })).items.some((item) => item.id === experiment.record.id), true);
});
