# Local Automation

Mission Control can run manually from the CLI or continuously through macOS user LaunchAgents.

The always-on stack includes:

- `web`: serves the task board and API
- `steward`: advances workflow state and review routing every few minutes
- `supervisor`: reports next actions across projects
- `dispatcher`: creates durable builder, reviewer, and owner-handoff runs
- `runner`: launches queued builder/reviewer runs with a Codex provider
- `qa-integration`: merges `qa_review` PR heads into opted-in non-production integration branches after validation
- `promotion`: merges owner-QA-passed work into the project target branch after validation
- `notifier`: sends local owner-review and failure notifications
- `self-update`: fetches `origin/main`, fast-forwards Mission Control itself when safe, and restarts worker LaunchAgents

## Install

```bash
npm install
npm run setup
npm run install-agents
```

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

The runner defaults to persistent `codex-sdk` threads. To run one explicitly:

```bash
npm run runner -- --provider codex-sdk --limit 1
```

To make LaunchAgent runs use persistent Codex threads, set `defaults.runner.provider` to `codex-sdk`, `defaults.runner.model` to `gpt-5.6-sol`, and `defaults.runner.modelReasoningEffort` to `xhigh` in `mission-control.config.md`, then restart the local agents. Keep `allowApiKeyAuth` false unless API billing is explicitly authorized.

For an ad hoc shell or service override, set:

```bash
MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk
MISSION_CONTROL_RUNNER_MODEL=gpt-5.6-sol
MISSION_CONTROL_RUNNER_REASONING_EFFORT=xhigh
```

When installing on macOS, pin the worker services to a stable Node.js binary instead of whatever Node happens to invoke npm:

```bash
MISSION_CONTROL_NODE_PATH=/path/to/node npm run install-agents
```

Continuous LaunchAgents include a 60-second restart throttle so a startup failure cannot create a resource-exhausting crash loop.

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

Tasks already marked with `integrationStatus: ready` are skipped on later sweeps. Use `--force` only when a branch has changed and a deliberate revalidation is required.

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
      "restartLaunchAgents": ["com.example.myapp.local"]
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

`localPreview` fast-forwards a stable local checkout to the QA branch after a successful integration or default-branch sync. It never force-pulls. If `stashDirty` is false, uncommitted preview checkout changes block the sync and are reported. If `stashDirty` is true, Mission Control preserves them in a Git stash before fast-forwarding. `restartLaunchAgents` is intended for local preview servers only.

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

The promotion worker uses an isolated clone under `~/.mission-control/promotion-workspaces/`, fetches the task branch or PR head, merges it into the target branch, runs validation, and performs a non-force push only after validation passes. It records conflicts, validation failures, push failures, and successful target-branch commits back on the task.

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

- `com.codex.mission-control.dispatcher`
- `com.codex.mission-control.runner`
- `com.codex.mission-control.notifier`
- `com.codex.mission-control.qa-integration`
- `com.codex.mission-control.promotion`

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

The always-on stack may create branches, run validation, commit, push, open or update pull requests, and merge owner-QA-passed task heads into a configured target branch when a project allows that behavior.

It must not:

- press GitHub's pull-request merge button or bypass the configured owner-QA gate
- deploy production
- send customer-facing messages
- commit secrets or private data
- bypass the human owner review or Trust Leads QA gate

The runner defaults to isolated workspaces and one active Codex run. Increase the limit only after validating that the host and repository lanes can safely support more concurrency.

Mission Control treats backend and frontend work as compatible by default. Design conflicts with frontend, and devops/project-wide work conflicts with other lanes in the same project. That keeps parallel agents from editing the same UI/CSS/deployment surface while still allowing a real team-style flow.
