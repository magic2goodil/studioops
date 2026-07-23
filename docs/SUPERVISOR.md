# StudioOps Supervisor

The supervisor is the always-on layer for StudioOps.

It checks every registered project, reads task status, and reports the next action needed for builders, reviewers, dependency blockers, and owner handoff.

It is intentionally conservative:

- It does not merge PRs.
- It does not deploy production.
- It does not send external notifications.
- It does not delete production files.
- It does not replace the human owner as final merge/deploy authority.
- Trust Leads may route lead-approved work to `qa_review`, but production approval still belongs to the human owner.

## Run One Sweep

```bash
npm run supervisor
```

Machine-readable output:

```bash
npm run supervisor -- --json
```

Show passive dependency-waiting tasks too:

```bash
npm run supervisor -- --all
```

## Run Continuously

```bash
npm run supervisor -- --watch --interval 15
```

The default interval is 15 seconds for low-latency local delivery:

```bash
npm run supervisor -- --watch --interval 15
```

## Keep It Running On macOS

A LaunchAgent example lives at:

```text
deploy/local/com.codex.mission-control.supervisor.plist.example
```

To install it:

1. Copy it to `~/Library/LaunchAgents/com.codex.mission-control.supervisor.plist`.
2. Replace `__NODE_PATH__`, `__MISSION_CONTROL_REPO__`, and `__LOG_DIR__`.
3. Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex.mission-control.supervisor.plist
launchctl enable gui/$(id -u)/com.codex.mission-control.supervisor
```

Check status:

```bash
launchctl print gui/$(id -u)/com.codex.mission-control.supervisor
```

Stop it:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.codex.mission-control.supervisor.plist
```

## What It Reports

The supervisor emits active actions like:

- `start_architecture`: broad product/mockup work needs the `systems-architect` before builders.
- `start_builder`: a `ready` or `queued` task can be picked up by a builder.
- `unblock_task`: a blocked task can return to the queue.
- `start_builder_fix`: reviewer changes need builder work.
- `start_review`: a PR is ready for a backend, frontend, accessibility, or lead reviewer.
- `continue_review`: a review lane has not recorded an outcome yet.
- `return_to_builder`: branch/PR intake is incomplete or a reviewer requested changes.
- `run_qa_integration`: a lead-approved task is in `qa_review` and waiting for the QA integration worker.
- `qa_bundle_ready`: the integration branch was validated and is ready for local owner testing.
- `qa_integration_blocked`: the integration worker recorded a conflict, validation failure, push failure, or local safety blocker.
- `notify_owner`: the task is ready for final human owner review.

By default, passive `waiting_on_dependency` and `blocked` tasks are summarized in the waiting count instead of printed as actions. Use `--all` when you want the full dependency backlog.

Each action includes:

- project key
- task ID and title
- task URL
- branch and PR URL when present
- QA integration branch and status when present
- prompt command for the relevant Codex role
- review command when the action is a review
- integration command when the action needs the QA integration worker
- reason for the action

## Relationship To Automation Tick

`automation-tick` mutates workflow state. It assigns tasks, blocks/unblocks dependency work, routes review stages, and moves reviewed work to `user_review` or, for opted-in Trust Leads projects, `qa_review`.

The supervisor is the outer orchestration view. It is safe to run continuously because it only reads state and prints the next actions.

Recommended loop for a Codex runner:

1. Run `npm run automation-tick -- --limit 10`.
2. Run `npm run dispatcher`.
3. Let `mission-control-runner` consume queued builder/reviewer dispatch runs.
4. Run `npm run qa-integrate` when the supervisor reports `run_qa_integration`.
5. Let `mission-control-notifier` send local notifications for owner handoff and failed runs.
6. For `notify_owner` or `qa_bundle_ready`, the human owner reviews the task URL, PR URL, and QA integration branch.
7. Stop at the human owner gate. Do not merge or deploy automatically.

See [DISPATCHER.md](DISPATCHER.md), [RUNNER.md](RUNNER.md), and [NOTIFIER.md](NOTIFIER.md) for the durable automation layers.

## Configuration

Local config can set the supervisor defaults:

```json
{
  "defaults": {
    "supervisor": {
      "intervalSeconds": 15,
      "baseUrl": "http://127.0.0.1:4317",
      "ownerNotificationStatus": "user_review",
      "builderConcurrency": 1,
      "reviewerConcurrency": 2,
      "requireHumanMerge": true,
      "requireGitHubActionsDeploy": true
    },
    "reviewPolicy": {
      "trustLeadApprovals": true,
      "integrationBranch": "qa/my-project"
    }
  }
}
```

The concurrency values are policy hints for the dispatcher and any Codex-native runner layered on top of it.

## Human Gate

`user_review` is the final handoff point. For Trust Leads projects, `qa_review` is the local bundle-testing gate before any final merge/deploy decision.

Before notifying the owner, the task should show:

- branch link
- PR link
- builder comment with changed files and validation
- backend review or explicit skip
- frontend review or explicit skip
- accessibility review or explicit skip
- lead review
- QA integration branch link when the project uses Trust Leads mode
- known gaps and residual risk

The owner decides whether to request changes, approve, merge, or deploy.
