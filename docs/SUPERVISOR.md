# Mission Control Supervisor

The supervisor is the always-on layer for Mission Control.

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
npm run supervisor -- --watch --interval 300
```

The default interval is 300 seconds. For active local work, 60 seconds is reasonable:

```bash
npm run supervisor -- --watch --interval 60
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

- `start_builder`: a `ready` or `queued` task can be picked up by a builder.
- `unblock_task`: a blocked task can return to the queue.
- `start_builder_fix`: reviewer changes need builder work.
- `start_review`: a PR is ready for a backend, frontend, or lead reviewer.
- `continue_review`: a review lane has not recorded an outcome yet.
- `return_to_builder`: branch/PR intake is incomplete or a reviewer requested changes.
- `notify_qa_review`: the task is lead-approved and ready for local QA review.
- `notify_owner`: the task is ready for final human owner review.

By default, passive `waiting_on_dependency` and `blocked` tasks are summarized in the waiting count instead of printed as actions. Use `--all` when you want the full dependency backlog.

Each action includes:

- project key
- task ID and title
- task URL
- branch and PR URL when present
- prompt command for the relevant Codex role
- review command when the action is a review
- reason for the action

## Relationship To Automation Tick

`automation-tick` mutates workflow state. It assigns tasks, blocks/unblocks dependency work, routes review stages, and moves reviewed work to `user_review` or, when Trust Leads is enabled, `qa_review`.

The supervisor is the outer orchestration view. It is safe to run continuously because it only reads state and prints the next actions.

Recommended loop for a Codex runner:

1. Run `npm run automation-tick -- --limit 10`.
2. Run `npm run dispatcher`.
3. Let `mission-control-runner` consume queued builder/reviewer dispatch runs.
4. Let `mission-control-notifier` send local notifications for owner handoff and failed runs.
5. For `notify_owner` or `notify_qa_review`, the human owner reviews the task URL, PR URL, and QA list.
6. Stop at the human owner gate. Do not merge or deploy automatically.

See [DISPATCHER.md](DISPATCHER.md), [RUNNER.md](RUNNER.md), and [NOTIFIER.md](NOTIFIER.md) for the durable automation layers.

## Configuration

Local config can set the supervisor defaults:

```json
{
  "defaults": {
    "supervisor": {
      "intervalSeconds": 300,
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

`user_review` is the default handoff point. `qa_review` is the Trust Leads handoff point for local visual QA before production approval.

Before notifying the owner, the task should show:

- branch link
- PR link
- builder comment with changed files and validation
- backend review or explicit skip
- frontend review or explicit skip
- lead review
- known gaps and residual risk

The owner decides whether to request changes, approve, merge, or deploy.
