# Mission Control Dispatcher

The dispatcher is the next layer after the supervisor.

The supervisor decides what should happen next. The dispatcher turns those decisions into durable work runs.

It can:

- create builder runs for `start_builder`, `start_builder_fix`, and `return_to_builder`
- create reviewer runs for `start_review` and `continue_review`
- create owner handoff notifications for `notify_owner`, `notify_qa_review`, and validated `qa_bundle_ready` Trust Leads QA bundles
- route `qa_integration_blocked` work back to a builder remediation run instead of leaving blocked QA bundles silent
- update task status and assignment so work is not dispatched repeatedly
- store a prompt snapshot on each run
- enforce builder, reviewer, and owner handoff concurrency

It does not:

- merge PRs
- update QA integration branches
- deploy production
- send external notifications
- delete production files
- silently approve work

The QA integration worker is a separate local command:

```bash
npm run qa-integrate -- --plan
npm run qa-integrate
```

The dispatcher may show `run_qa_integration` in supervisor output, but it does not dispatch that action to Codex. The integration worker performs the Git merge, validation, and non-force push for opted-in Trust Leads projects.

## Run A Plan

Preview what would be dispatched without writing state:

```bash
npm run dispatcher -- --plan
```

JSON:

```bash
npm run dispatcher -- --plan --json
```

## Dispatch Once

```bash
npm run dispatcher
```

Limit to one project:

```bash
npm run dispatcher -- --project event-horizons-web --limit 3
```

## Run Continuously

```bash
npm run dispatcher -- --watch --interval 300
```

The dispatcher should be the durable runner for a machine. The supervisor can keep running as a read-only dashboard, but the dispatcher is what creates run records.

## Provider Model

The default provider is `prompt-outbox`.

That means Mission Control stores the generated Codex prompt on the run record. A Codex-capable runner can then pick up the run and create or resume the actual builder/reviewer task.

This is intentional for the open-source project:

- it does not require private Codex APIs
- it does not hard-code one AI vendor
- it gives Codex, Claude, Antigravity, or another runner the same durable work packet

Mission Control also includes a local Codex CLI runner. It consumes queued builder/reviewer runs created by the dispatcher and executes the stored prompt inside the target project repo. See [RUNNER.md](RUNNER.md).

When a native thread API is available, it should plug in at the provider boundary by:

1. reading queued runs
2. creating or resuming the external worker thread
3. writing the external thread ID back to the run
4. marking the run `running`
5. letting the worker update the task, PR, comments, validation, and review status

## Run Statuses

- `queued`: Mission Control created the run and stored the prompt.
- `running`: an external worker thread has started.
- `notified`: owner handoff was recorded.
- `completed`: the worker finished and recorded output.
- `failed`: the worker failed and needs attention.
- `cancelled`: the run was intentionally stopped.

List runs:

```bash
node src/mission-control-cli.js runs
```

Print a queued prompt:

```bash
node src/mission-control-cli.js run-prompt run_1
```

Mark a run:

```bash
node src/mission-control-cli.js update-run run_1 --status running --thread "codex-thread-id"
node src/mission-control-cli.js update-run run_1 --status completed --notes "PR linked and task moved to builder_review."
```

## Concurrency

Default dispatcher limits:

```json
{
  "maxDispatchesPerSweep": 6,
  "builderConcurrency": 3,
  "reviewerConcurrency": 3,
  "ownerConcurrency": 10
}
```

Queued and running runs count toward concurrency. Completed, failed, and cancelled runs do not.

The dispatcher also deduplicates by task, role, action type, review cycle, and target status so the same task is not re-dispatched every five minutes.

The dispatcher also attaches a work lane and file-scope hint to each builder/reviewer run. If a task does not explicitly set `lane` or `workAreas`, Mission Control infers the lane from task type, area, title, story, expected outcome, and reviewer role.

Lane conflict rules:

- backend and frontend can dispatch together for the same project
- frontend and design conflict by default because they often share UI/CSS/assets
- devops and project-wide work conflict with all same-project lanes
- different projects can dispatch independently

Tasks can be scoped manually:

```bash
node src/mission-control-cli.js update-task task_1 --lane backend --work-area "src/**,db/**"
```

## Safety

The dispatcher stops at the human owner gate.

It may create an owner or QA handoff run, but it must not merge, deploy, or mark final approval. Production deployment still belongs to the human owner and the project-specific protected GitHub Actions workflow.
