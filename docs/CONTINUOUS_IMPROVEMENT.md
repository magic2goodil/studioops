# Continuous-improvement ledger

StudioOps keeps delivery truth in one append-only bounded context inside the existing local Node.js modular monolith and SQLite database. SQLite is authoritative. Markdown under `improvement-journal/YYYY/MM/YYYY-MM-DD.md` is a deterministic, repairable projection and is never accepted as input.

## Contract and ownership

`createDeliveryTelemetryRepository()` publishes contract version 1 for delivery events, validation observations, criterion evidence, metric definitions and snapshots, retrospective jobs and immutable records, deduplicated proposals, experiments, and journal export checkpoints. The component owns contracts and persistence only. Workflow instrumentation, status transitions, analysis, enforcement, and UI remain downstream work.

Upstream systems provide evidence through adapters. `sourceKind` and `sourceReference` identify the immutable task_79 completion record, task_80 owner handoff, task_631 cost-admission decision, or task_550-shaped exact-SHA attestation. The ledger stores the observation; it does not copy or reinterpret upstream policy.

All records use canonical UTC ISO-8601 timestamps with milliseconds and `Z`. Journal dates are UTC calendar dates. Writers accept schema version 1 and reject newer versions; older runtimes safely ignore these additive tables. List queries are ordered by timestamp then ID, default to 50 rows, and reject limits above 100.

## Idempotency and immutability

Every append requires a caller-owned idempotency key. Delivery events also require a unique `(source_kind, source_reference)` identity. An exact retry returns the stored row with `inserted: false`; reusing either identity for different canonical content fails closed. Metric definitions are unique by metric key and definition version, evidence has exact natural keys, proposals are deduplicated by project and fingerprint, and journal checkpoints by date and content digest.

SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers protect all ten tables. State changes are represented by a new immutable record, not mutation of an earlier row. Foreign keys bind evidence to delivery events, snapshots to definitions, retrospectives to events/jobs, proposals to retrospectives, and experiments to proposals.

Indexes cover project/task/run/event-type plus time, exact validation and criterion lookup, pending retrospective jobs, open proposal fingerprints, due experiments, metric snapshots, journal dates, and journal checkpoints. Repository queries use targeted SQL and never add these records to whole-state hydration.

## Privacy and units

Delivery measures are at most 24 bounded finite numeric values with absolute magnitude at most `1e15`; metric definitions name the unit explicitly. Attributes are at most 24 shallow scalar values. Keys matching prompt, source, log, body, secret, token, credential, customer, or content are rejected. IDs and references are bounded opaque identifiers, not places for prompts, logs, credentials, customer data, or other content. Retrospective observations use the same sensitive-key rejection and bounded scalar shape.

Metric definitions persist a definition version, numerator, optional denominator, unit, inclusion and exclusion rules, source event types, minimum sample size, percentile method, target direction, and compatibility date. Snapshots retain the exact definition ID, UTC window, value, numerator/denominator observations, sample size, and computation time.

## Journal materialization and recovery

`materializeImprovementJournalDate()` reads all retrospectives for one UTC date, sorts by `recordedAt` and ID, and renders event and retrospective links. It writes a mode-`0600` temporary file in the target directory and atomically renames it. Repeating materialization from unchanged SQLite rows produces identical bytes and the same SHA-256 checkpoint, including after a crash between rename and checkpoint append.

The default root is the configured StudioOps control-plane root plus `improvement-journal`. A custom root is supported for isolated tests. Journal entries contain only bounded retrospective fields already accepted by the repository.

## Migration, rollback, and performance

Schema v1 is additive and runs after the existing integrity migration. It reuses the verified pre-migration SQLite backup path, acquires `BEGIN IMMEDIATE`, rechecks under the lock, creates tables/indexes/triggers, and updates only `state_meta`; it does not hydrate or rewrite aggregate state. DDL and metadata roll back together on failure.

Rollback disables repository writers by setting `state_meta.deliveryTelemetryMigration.writerEnabled` false (or by running a build with writers disabled) while leaving additive tables and triggers readable. Do not drop the tables. Journal files remain reconstructable from SQLite. Restore the verified backup only when recovering from a failed migration rather than as a normal feature rollback.

The synthetic fixture requires 10 duplicate-safe local appends with p95 at most 25 ms and no lost accepted event. WAL mode, the existing SQLite busy timeout, short targeted inserts, and idempotent retry semantics support the local single-owner workload; no broker, cache, or additional database is justified.

The executable ownership and impact record is `docs/architecture/continuous-improvement.components.json`. Because this slice changes a public contract, shared-kernel schema, migration, event version, and manifest across several components, validation fails closed to the full regression suite after the three targeted test files.
