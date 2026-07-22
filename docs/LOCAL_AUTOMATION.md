# Local Automation

StudioOps can run manually from the CLI or continuously through macOS user LaunchAgents.

The always-on stack includes:

- `web`: serves the task board and API
- `steward`: advances workflow state and review routing every few minutes
- `supervisor`: reports next actions across projects
- `dispatcher`: creates durable builder, reviewer, and owner-handoff runs
- `runner`: launches queued builder/reviewer runs with a Codex provider
- `qa-integration`: merges `qa_review` PR heads into opted-in non-production integration branches after validation
- `promotion`: assembles owner-QA-passed work into a validated release-candidate PR
- `notifier`: sends local owner-review and failure notifications
- `self-update`: fetches `origin/main`, fast-forwards StudioOps itself when safe, and restarts worker LaunchAgents
- `watchdog`: reconciles stranded task state, watches worker heartbeats, and restarts stale workers

## Install

```bash
npm install
npm run setup
npm run install-agents
```

The installer publishes a stable runtime under `~/.codex/studioops/runtime`, creates a clean `main` checkout under `~/.codex/studioops/source` for self-updates, and stores persistent config, SQLite state, and logs under `~/.codex/studioops/control-plane`. Run, QA, and promotion workspaces also live under `~/.codex/studioops`. This keeps operational writes out of `Documents`, Desktop, iCloud Drive, and other synchronized folders. Re-running the installer atomically updates the runtime and restarts all workers. The installer prefers an available supported even-numbered Node.js LTS runtime; `STUDIOOPS_NODE_PATH` and the legacy `MISSION_CONTROL_NODE_PATH` remain explicit overrides.

Existing installations from the project rename are migrated from the retired `codex-mission-control` source remote to `studioops` only when the checkout is clean, on `main`, and fast-forwardable. The installer refuses dirty, divergent, detached, or unrelated source checkouts instead of rewriting them.

Repeated equivalent QA outcomes are fingerprinted so an unchanged failure or ready state does not append another task comment on every worker pass. Failed QA integration attempts use a bounded retry window instead of immediately repeating expensive repository and preview work; an explicit forced run bypasses that window. Before the state-integrity migration changes the database, StudioOps writes an owner-only SQLite backup under `data/backups/`. Excess legacy QA comments and QA events then move to the local SQLite `operational_archive` table; recent active history remains on each task, and human comments and reviews are never compacted.

## Self-Healing Invariants

Long-running workers write atomic heartbeats under `data/heartbeats/` every 30 seconds, including while a Codex run is active. The watchdog runs independently every two minutes and:

- restarts a worker whose heartbeat is missing or stale
- wakes the runner when queued durable runs have waited too long
- wakes the dispatcher when dispatchable tasks have waited too long
- records the worker data root and disk availability with every heartbeat
- pauses new claims and reports disk pressure instead of repeatedly restarting workers when free space is below the safety threshold
- refuses to restart a LaunchAgent whose installed working root does not match the watchdog's current StudioOps root
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

Run maintenance commands from the same working root used during `npm run install-agents`. A watchdog started from another checkout will report the root mismatch and leave the installed workers untouched. `STUDIOOPS_WORKING_ROOT`, `STUDIOOPS_DATA_DIR`, and the legacy `MISSION_CONTROL_*` aliases can select the intended persistent instance explicitly.

### Migrating a legacy or cloud-synchronized installation

Do not relocate an active database by copying its live SQLite files. The installer reads the existing web LaunchAgent to find its installed working root and refuses to stop any agents while a builder or reviewer run is active. Once idle, it stops all StudioOps writers together and uses SQLite's backup API to create:

- `~/.codex/studioops/control-plane/data/backups/pre-local-root-migration-*.sqlite3`, mode `0600`
- `~/.codex/studioops/control-plane/data/mission-control.sqlite3`, mode `0600`

It also copies configuration and attachments under `~/.codex/studioops/control-plane`, migrates GitHub App credentials to `~/.codex/studioops/credentials/github-apps`, applies owner-only directory permissions, and then installs the new agent definitions. If migration or installation fails, the previous LaunchAgent files are restored and restarted. The destination working root must not exist; the installer will not merge into it or overwrite an existing database.

If an unused destination root already exists, first verify no LaunchAgent or process references it, inspect its contents, and rename it to a timestamped sibling backup such as `control-plane.pre-migration-YYYYMMDD-HHMMSS`. Do not delete it during the cutover. Run the installer only after `~/.codex/studioops/control-plane` is absent, and retain the renamed copy until post-migration verification is complete.

For an installation without an existing web LaunchAgent, select the legacy working root explicitly:

```bash
STUDIOOPS_MIGRATE_FROM=/absolute/path/to/legacy-control-plane npm run install-agents
```

After installation, verify `npm run status-agents`, `http://127.0.0.1:4317/api/health`, project/task counts, migrated attachments, GitHub App access, and queued-run recovery before retiring the old root. The old source remains unchanged as a rollback copy.

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

To make LaunchAgent runs use the SDK provider, set `defaults.runner.provider` to `codex-sdk` in `studioops.config.md`, then restart the local agents.

For an ad hoc shell or service override, set:

```bash
MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk
```

Runner workspace preparation is serialized per source repository with a local
Git lock under `~/.codex/studioops/locks/git` by default. This prevents
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

Tasks already marked with `integrationStatus: ready` are skipped on later sweeps. Use `--force` only when a branch has changed and deliberate revalidation is required.

The worker refuses `main`, `master`, `production`, and the configured default branch as integration targets. It prepares each QA bundle in an isolated workspace under `~/.codex/studioops/qa-workspaces/` by default, so the registered project checkout can stay on the owner's active branch with local changes. Override the workspace root with `STUDIOOPS_QA_WORKSPACE_ROOT` or its legacy `MISSION_CONTROL_QA_WORKSPACE_ROOT` alias when needed, but keep it outside the registered project checkout.

QA integration requires the registered project checkout to have an `origin` remote. It aborts merge conflicts, records comments on affected tasks, runs validation commands from the isolated workspace, and only then pushes the non-production integration branch to that remote. Reports and task comments include the workspace path and strategy used for the run. It does not merge PRs, deploy, force-push, or checkout the registered project repoPath.

Projects can also opt into keeping their QA branch and local preview checkout current:

```json
{
  "qaIntegration": {
    "syncDefaultBranchIntoIntegration": true,
    "localPreview": {
      "enabled": true,
      "checkoutPath": "~/.codex/studioops/qa-workspaces/myapp/myapp-clean",
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
studioops update-project myapp \
  --local-qa-preview \
  --local-qa-preview-checkout ~/.codex/studioops/qa-workspaces/myapp/myapp-clean \
  --local-qa-preview-branch qa/integration \
  --local-qa-preview-create \
  --local-qa-preview-stash-dirty
```

`syncDefaultBranchIntoIntegration` merges the latest configured default branch into the non-production QA branch before task PR heads are integrated. This is useful after the owner merges a PR to `main`: the QA branch catches up on the next sweep instead of leaving the local preview stale.

`localPreview` fast-forwards a stable local checkout to the QA branch after a successful integration or default-branch sync. It never force-pulls. If `stashDirty` is false, uncommitted preview checkout changes block the sync and are reported. If `stashDirty` is true, StudioOps preserves them in a Git stash before fast-forwarding. Missing preview LaunchAgents are bootstrapped from the configured plist (or the standard `~/Library/LaunchAgents/<label>.plist` path), restarted, and health-checked before the bundle is marked ready.

## Main Promotion

After the owner reviews the local QA preview, mark the task from the UI or CLI:

```bash
studioops qa-pass task_123 --body "Checked locally."
studioops qa-fail task_123 --body "Hero image still covers the full page."
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

The promotion worker uses an isolated clone under `~/.codex/studioops/promotion-workspaces/`, fetches the task branch or PR head, merges it locally on top of the target branch, runs validation, pushes a uniquely named release-candidate branch, and opens a ready PR against the target. It never pushes directly to the protected target branch. It records conflicts, validation failures, push failures, and the release-candidate PR back on the task and QA bundle.

Promotion does not deploy production. It prepares the target branch for owner release-candidate review. Production deploys should remain behind explicit release or tag workflows.

## Self Update

StudioOps can update its own local checkout after a control-plane PR is merged to `origin/main`:

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

During an applied update, StudioOps records a short-lived self-update lease in local state. The runner checks that lease before claiming queued builder/reviewer work, so queued runs wait until the fast-forward and LaunchAgent restart window is over instead of being started and interrupted.

Use `studioops.config.md` `defaults.selfUpdate` or CLI flags such as `--branch`, `--remote`, `--stale-run-ms`, `--task`, `--notify`, and `--no-restart` to tune local behavior. `--task` records a StudioOps comment on that task; all material non-dry-run outcomes are recorded as StudioOps events.

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

StudioOps treats backend and frontend work as compatible by default. Design conflicts with frontend, and devops/project-wide work conflicts with other lanes in the same project. That keeps parallel agents from editing the same UI/CSS/deployment surface while still allowing a real team-style flow.
