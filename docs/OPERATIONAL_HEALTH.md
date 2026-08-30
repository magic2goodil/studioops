# Operational health and maintenance

StudioOps exposes cheap, bounded health contracts for the local control plane:

- `GET /api/live` is process-only. It does not open SQLite, read configuration, scan state, inspect workers, or touch the filesystem.
- `GET /api/ready` and the compatibility route `GET /api/health` report database, queue, coordination-lease, managed-worker, configuration, and data/workspace disk health. The default end-to-end latency SLO is 250 ms; a component that exceeds the deadline is reported unhealthy rather than holding the request open.
- `GET /api/metrics` reports oldest queue and lease age, expired leases, run and database retries, 24-hour automation-loop count, token usage, notification delivery status/attempts, database latency and free pages, incident counts, worker health, and disk pressure.
- `GET /api/incidents` returns bounded durable incident records and timelines. `POST /api/incidents/:id/acknowledge`, `/assign`, and `/resolve` record operator actions. Resolution requires evidence.

Readiness uses direct indexed SQL and bounded heartbeat/disk reads. It does not deserialize the complete StudioOps state. The first readiness check after an upgrade can report not-ready while a verified migration finishes; liveness remains available during that time.

## Retention policy

Retention is local and configurable through environment variables. Defaults preserve human comments and immutable reviews/candidates while bounding machine-generated operational data:

| Environment variable | Default | Scope |
|---|---:|---|
| `STUDIOOPS_RETENTION_QA_COMMENTS_PER_TASK` | 20 | Machine QA comments per task |
| `STUDIOOPS_RETENTION_MACHINE_COMMENTS_PER_TASK` | 12 | Other machine comments per task |
| `STUDIOOPS_RETENTION_EVENTS_PER_STREAM` | 40 | Events per execution/attempt/dispatch/type stream |
| `STUDIOOPS_RETENTION_TERMINAL_RUNS_PER_ACTION` | 3 | Terminal runs per task/action/role, raised to preserve attempt-budget evidence |
| `STUDIOOPS_RETENTION_NOTIFICATION_DAYS` | 30 | Acknowledged or retry-exhausted notification evidence |
| `STUDIOOPS_RETENTION_NOTIFICATION_MAX_ROWS` | 2000 | Terminal notification evidence retained active |
| `STUDIOOPS_RETENTION_ARCHIVE_DAYS` | 90 | Operational archive rows |
| `STUDIOOPS_RETENTION_INCIDENT_TIMELINE_DAYS` | 90 | Timeline rows for resolved incidents |
| `STUDIOOPS_RETENTION_RESOLVED_INCIDENT_DAYS` | 365 | Resolved incident identity/evidence |
| `STUDIOOPS_RETENTION_CONTENTION_HOURS` | 24 | Database contention detail |
| `STUDIOOPS_RETENTION_CONTENTION_MAX_ROWS` | 1000 | Database contention row cap |
| `STUDIOOPS_RETENTION_RUN_OUTPUT_DAYS` | 14 | Terminal run-output files |
| `STUDIOOPS_RETENTION_RUN_OUTPUT_MAX_FILES` | 2000 | Terminal run-output file cap |

Queued/running run outputs and notifications still awaiting delivery, acknowledgement, escalation, or retry are never selected by terminal retention. Cleanup only removes regular files directly below the configured `run-outputs` directory; it skips symlinks, directories, and active references.

## Backup and compaction

Preview the current policy and metrics without changing state:

```bash
node scripts/operational-maintenance.js
```

Apply database/archive retention, prune eligible run output, create and verify an online SQLite backup, acquire a cross-process database-maintenance lease, checkpoint WAL, compact the database, verify integrity and row counts, and release the lease:

```bash
node scripts/operational-maintenance.js --apply
```

Use `--backup /absolute/path/snapshot.sqlite3` to select the backup destination. Writers that do not own the maintenance lease fail closed while compaction is active. The backup is created before the lease/compaction phase and must pass `PRAGMA integrity_check`. Compaction must preserve every table row count and pass a second integrity check before it reports success.

## Soak validation

The accelerated soak advances a virtual clock across 24 hours, continuously appends machine events/comments/runs/notifications, applies the configured retention policy, injects a stalled queue, missing worker, and disk pressure, and verifies watchdog detection plus a clean recovery pass:

```bash
node scripts/operational-soak.js --hours 24
```

The executable test also runs under `npm run check`. Test processes continue to use task_70's marked temporary control root; unmarked test processes and symlink escapes fail closed before database access.

## Ownership and rollback

The `operational-persistence` component owns the retention policy, operational incident/timeline tables, direct SQL health/metrics contracts, online backup, maintenance lease, compaction, and run-output selection. The HTTP server and watchdog are adapters; they do not duplicate database policy. See `docs/architecture/operational-health.components.json` for the executable ownership and dependency classification.

Rollback is additive: an older release ignores the new incident tables and indexes. Stop the maintenance script and health adapters before rolling back. Do not delete the new tables or archive/backup evidence. Environment overrides can lengthen retention or effectively disable practical cleanup while a rollback is evaluated.
