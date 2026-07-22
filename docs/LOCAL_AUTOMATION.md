# Local Automation

Mission Control can run manually from the CLI or continuously through macOS user LaunchAgents.

The always-on stack includes:

- `web`: serves the task board and API
- `steward`: advances workflow state and review routing every few minutes
- `supervisor`: reports next actions across projects
- `dispatcher`: creates durable builder, reviewer, and owner-handoff runs
- `runner`: launches queued builder/reviewer runs with a Codex provider
- `qa-integration`: merges `qa_review` PR heads into opted-in non-production integration branches after validation
- `promotion`: assembles owner-QA-passed work into a validated release-candidate PR
- `notifier`: sends local owner-review and failure notifications
- `self-update`: fetches `origin/main`, fast-forwards Mission Control itself when safe, and restarts worker LaunchAgents
- `watchdog`: reconciles stranded task state, watches worker heartbeats, and restarts stale workers

## Install

```bash
npm install
npm run setup
npm run install-agents
```

The installer publishes a stable runtime under `~/.mission-control/runtime`, creates a clean `main` checkout under `~/.mission-control/source` for self-updates, and points LaunchAgents at the immutable runtime. Local config and SQLite state remain in the working root. This prevents workers from executing half-synced files or depending on the branch currently open in a developer checkout. Re-running the installer atomically updates the runtime and restarts all workers. The installer prefers an available supported even-numbered Node.js LTS runtime; `MISSION_CONTROL_NODE_PATH` remains the explicit override.

## Self-Healing Invariants

Long-running workers write atomic heartbeats under `data/heartbeats/` every 30 seconds, including while a Codex run is active. The watchdog runs independently every two minutes and:

- restarts a worker whose heartbeat is missing or stale
- wakes the runner when queued durable runs have waited too long
- wakes the dispatcher when dispatchable tasks have waited too long
- returns a non-epic `in_progress` task to the queue when it has no queued or running durable run
- automatically releases transient SDK, process, timeout, and orphan-run blockers after a bounded recovery delay

Configuration blockers such as missing or invalid GitHub App credentials remain owner-gated. Tracking epics are exempt from the active-run invariant because their status represents child-task progress rather than direct builder execution.

By default, the web UI is only available on the local machine:

```text
http://127.0.0.1:4317
```

For phone or local-network testing:

```bash
MISSION_CONTROL_HOST=0.0.0.0 MISSION_CONTROL_PORT=4317 npm run install-agents
```

Only use `0.0.0.0` on a trusted local network.

## Status

```bash
npm run status-agents
node src/mission-control-cli.js runs
npm run runner -- --plan
npm run dispatcher -- --plan
npm run qa-integrate -- --plan
npm run promotion -- --plan
npm run self-update -- --plan
```

The runner defaults to `codex-cli`. To test SDK-backed Codex threads:

```bash
npm run runner -- --provider codex-sdk --limit 1
```

To make LaunchAgent runs use the SDK provider, set `defaults.runner.provider` to `codex-sdk` in `mission-control.config.md`, then restart the local agents.

For an ad hoc shell or service override, set:

```bash
MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk
```

Runner workspace preparation is serialized per source repository with a local
Git lock under `~/.mission-control/locks/git` by default. This prevents
parallel runner processes from fetching, pruning, or creating worktrees against
the same checkout at the same time, which can otherwise surface as Git
pack/object errors such as `Resource deadlock avoided`. Tune the lock with:

- `MISSION_CONTROL_GIT_LOCK_ROOT`
- `MISSION_CONTROL_GIT_LOCK_TIMEOUT_MS`
- `MISSION_CONTROL_GIT_LOCK_STALE_MS`
- `MISSION_CONTROL_GIT_LOCK_POLL_MS`

## QA Integration

Trust Leads QA integration is opt-in per project:

```json
{
  "trustLeadApprovals": true,
  "integrationBranch": "qa/integration",
  "validationCommands": ["npm run check"]
}
```

When review automation moves a lead-approved task to `qa_review`, run:

```bash
npm run qa-integrate -- --plan
npm run qa-integrate -- --project myapp
```

The worker refuses `main`, `master`, `production`, and the configured default branch as integration targets. It prepares each QA bundle in an isolated workspace under `~/.mission-control/qa-workspaces/` by default, so the registered project checkout can stay on the owner's active branch with local changes. Override the workspace root with `MISSION_CONTROL_QA_WORKSPACE_ROOT` when needed, but keep it outside the registered project checkout.

QA integration requires the registered project checkout to have an `origin` remote. It aborts merge conflicts, records comments on affected tasks, runs validation commands from the isolated workspace, and only then pushes the non-production integration branch to that remote. Reports and task comments include the workspace path and strategy used for the run. It does not merge PRs, deploy, force-push, or checkout the registered project repoPath.

Projects can also opt into keeping their QA branch and local preview checkout current:

```json
{
  "qaIntegration": {
    "syncDefaultBranchIntoIntegration": true,
    "localPreview": {
      "enabled": true,
      "checkoutPath": "~/.mission-control/qa-workspaces/myapp/myapp-clean",
      "branch": "qa/integration",
      "stashDirty": true,
      "postUpdateCommands": ["npm run check"],
      "restartLaunchAgents": ["com.example.myapp.local"],
      "launchAgentPlists": {
        "com.example.myapp.local": "~/Library/LaunchAgents/com.example.myapp.local.plist"
      },
      "previewUrl": "http://127.0.0.1:4174/",
      "healthCheckUrl": "http://127.0.0.1:4174/health"
    }
  }
}
```

The same local preview can be configured without hand-editing the data file:

```bash
mission-control update-project myapp \
  --local-qa-preview \
  --local-qa-preview-checkout ~/.mission-control/qa-workspaces/myapp/myapp-clean \
  --local-qa-preview-branch qa/integration \
  --local-qa-preview-create \
  --local-qa-preview-stash-dirty
```

`syncDefaultBranchIntoIntegration` merges the latest configured default branch into the non-production QA branch before task PR heads are integrated. This is useful after the owner merges a PR to `main`: the QA branch catches up on the next sweep instead of leaving the local preview stale.

`localPreview` fast-forwards a stable local checkout to the QA branch after a successful integration or default-branch sync. It never force-pulls. If `stashDirty` is false, uncommitted preview checkout changes block the sync and are reported. If `stashDirty` is true, Mission Control preserves them in a Git stash before fast-forwarding. Missing preview LaunchAgents are bootstrapped from the configured plist (or the standard `~/Library/LaunchAgents/<label>.plist` path), restarted, and health-checked before the bundle is marked ready.

## Main Promotion

After the owner reviews the local QA preview, mark the task from the UI or CLI:

```bash
mission-control qa-pass task_123 --body "Checked locally."
mission-control qa-fail task_123 --body "Hero image still covers the full page."
```

`qa-pass` moves the task to `approved_for_main` and queues it for the promotion worker. `qa-fail` moves it back to `needs_changes` with the owner notes preserved as a task comment.

Promotion is configured per project and defaults to the project's `defaultBranch`:

```json
{
  "promotion": {
    "enabled": true,
    "targetBranch": "main",
    "validationCommands": ["npm run check"]
  }
}
```

Run or preview promotion manually:

```bash
npm run promotion -- --plan
npm run promotion -- --project myapp
```

The promotion worker uses an isolated clone under `~/.mission-control/promotion-workspaces/`, fetches the task branch or PR head, merges it locally on top of the target branch, runs validation, pushes a uniquely named release-candidate branch, and opens a ready PR against the target. It never pushes directly to the protected target branch. It records conflicts, validation failures, push failures, and the release-candidate PR back on the task and QA bundle.

Promotion does not deploy production. It prepares the target branch for owner release-candidate review. Production deploys should remain behind explicit release or tag workflows.

## Self Update

Mission Control can update its own local checkout after a control-plane PR is merged to `origin/main`:

```bash
npm run self-update -- --plan
npm run self-update
```

The self-updater only fast-forwards the configured branch, `main` by default. It refuses to update when:

- the working tree has uncommitted or untracked files
- local `main` cannot fast-forward to `origin/main`
- the checkout is on another branch
- builder or reviewer Codex runs are actively running

Running builder/reviewer runs are ignored only when they are stale, such as a missing runner process when PID checks are enabled or a `startedAt` timestamp older than the configured stale-run window. After a successful update, the updater restarts these LaunchAgents:

- `com.codex.mission-control.web`
- `com.codex.mission-control.steward`
- `com.codex.mission-control.supervisor`
- `com.codex.mission-control.dispatcher`
- `com.codex.mission-control.runner`
- `com.codex.mission-control.notifier`
- `com.codex.mission-control.qa-integration`
- `com.codex.mission-control.promotion`
- `com.codex.mission-control.watchdog`

During an applied update, Mission Control records a short-lived self-update lease in local state. The runner checks that lease before claiming queued builder/reviewer work, so queued runs wait until the fast-forward and LaunchAgent restart window is over instead of being started and interrupted.

Use `mission-control.config.md` `defaults.selfUpdate` or CLI flags such as `--branch`, `--remote`, `--stale-run-ms`, `--task`, `--notify`, and `--no-restart` to tune local behavior. `--task` records a Mission Control comment on that task; all material non-dry-run outcomes are recorded as Mission Control events.

## Uninstall

```bash
npm run uninstall-agents
```

## Logs

LaunchAgent logs are written to:

```text
data/launch-agents/
```

Runner output is written to:

```text
data/run-outputs/
```

## Safety

The always-on stack may create branches, run validation, commit, push, and open or update pull requests. It may assemble owner-QA-passed task heads on a release-candidate branch, but it does not merge that branch into the protected target.

It must not:

- press GitHub's pull-request merge button or bypass the configured owner-QA gate
- deploy production
- send customer-facing messages
- commit secrets or private data
- bypass the human owner review or Trust Leads QA gate

The runner defaults to isolated workspaces and a limit of three active Codex runs. It can run multiple projects, or compatible lanes within the same project, at the same time.

Mission Control treats backend and frontend work as compatible by default. Design conflicts with frontend, and devops/project-wide work conflicts with other lanes in the same project. That keeps parallel agents from editing the same UI/CSS/deployment surface while still allowing a real team-style flow.
