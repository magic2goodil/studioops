# Mission Control Dispatcher

The dispatcher is the next layer after the supervisor.

The supervisor decides what should happen next. The dispatcher turns those decisions into durable work runs.

It can:

- create builder runs for `start_builder`, `start_builder_fix`, and `return_to_builder`
- create reviewer runs for `start_review` and `continue_review`
- create owner handoff notifications for `notify_owner`
- update task status and assignment so work is not dispatched repeatedly
- store a prompt snapshot on each run
- enforce builder, reviewer, and owner handoff concurrency

It does not:

- merge PRs
- deploy production
- send external notifications
- delete production files
- silently approve work

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

## Safety

The dispatcher stops at the human owner gate.

It may create an owner handoff run, but it must not merge, deploy, or mark final approval. Production deployment still belongs to the human owner and the project-specific protected GitHub Actions workflow.
