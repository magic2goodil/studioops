# StudioOps Steward

The steward is the scheduled workflow-routing tick.

It runs `automation-tick`, which advances task state when the rules are satisfied:

- dependency-blocked tasks return to the queue when dependencies complete
- `builder_review` tasks route into backend, frontend, accessibility, and lead review
- review changes send work back to the builder
- fully reviewed work moves to `user_review`, or to `qa_review` when Trust Leads QA integration is enabled for the project

It intentionally leaves `ready` and `queued` tasks in place. The dispatcher owns turning those tasks into durable builder runs. This prevents the steward from moving tasks to `in_progress` before a builder has actually been launched.

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
npm run automation-tick -- --project event-horizons-web --limit 20
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
