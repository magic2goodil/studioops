# StudioOps Steward

The steward is the scheduled workflow-routing tick.

It runs `automation-tick`, which advances task state when the rules are satisfied:

- dependency-blocked tasks return to the queue when dependencies complete
- `builder_review` tasks route into backend, frontend, accessibility, and lead review
- review changes send work back to the builder
- fully reviewed work moves to `user_review`, or to `qa_review` when Trust Leads QA integration is enabled for the project

It intentionally leaves `ready` and `queued` tasks in place. The dispatcher owns turning those tasks into durable builder runs. This prevents the steward from moving tasks to `in_progress` before a builder has actually been launched.

An operator-adopted candidate can finish its independent reviews while an automated reviewer remains blocked before launch by credit admission. The next tick, or the final recorded approval, can supersede that specific review-credit hold when every required current-candidate review is approved. The blocked review's approval must postdate the hold, stage ordering must be consistent, and contradictory simultaneous evidence is rejected. Optional lanes retain their explicit skip policy. Missing dependencies, other holds, active work, and unresolved durable failure incidents prevent this reconciliation.

This uses the existing owner/QA routing policy in one state transition. It preserves the original circuit, blocker, review records, failure history, and attempt epoch. A task-scoped failure-ledger check runs again inside the database commit so a newly recorded incident cannot be missed by a concurrent workflow update. No model run, credit verification, attempt reset, QA approval, or release is implied. Existing completed reviews need not be recorded again; use the normal project-scoped `automation-tick` below.

It does not:

- run Codex
- merge PRs
- update QA integration branches
- deploy production
- send notifications
- approve owner review

## Run Once

```bash
npm run automation-tick -- --limit 50
```

Limit to one project:

```bash
npm run automation-tick -- --project example-app --limit 20
```

## Scheduled Local Agent

The LaunchAgent example lives at:

```text
deploy/local/com.codex.mission-control.steward.plist.example
```

This is a one-shot scheduled job using `StartInterval`, not a long-running process. It runs every 300 seconds by default.

The rest of the automation stack is:

1. Steward routes task workflow state.
2. Supervisor reports next actions.
3. Dispatcher creates durable run records.
4. Runner executes queued builder/reviewer runs with Codex CLI.
5. QA integration worker updates opted-in non-production integration branches.
6. Notifier sends local owner/failure notifications.

The human owner remains the final merge/deploy authority.
