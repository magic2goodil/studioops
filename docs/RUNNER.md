# StudioOps Runner

The runner is the execution layer after the dispatcher.

It claims queued builder/reviewer runs and launches a Codex provider against the target project repository with the stored StudioOps prompt.

It can:

- claim systems-architect runs before builders and machine-check their durable architecture handoff
- claim one or more queued builder/reviewer runs
- mark runs `running`, `completed`, or `failed`
- stream Codex output to `data/run-outputs/`
- store Codex thread IDs on runs and tasks when the SDK provider returns them
- pass the task ID and run ID into the worker environment
- run continuously through a local LaunchAgent
- pin and record the selected model, reasoning effort, attempt number, and selection reason
- recover stale running records whose process died or exceeded its allowed runtime
- refuse new claims when the data volume is below the configured disk-space safety threshold
- verify that builders linked a branch/PR and reviewers recorded an outcome before accepting a successful process exit

It does not:

- merge PRs
- deploy production
- approve owner review
- send customer-facing messages
- override project safety rules

## Preview Work

```bash
npm run runner -- --plan
```

Limit to one project:

```bash
npm run runner -- --plan --project event-horizons-web
```

## Run Once

```bash
npm run runner
```

The default limit is one active Codex run. This keeps parallel builders from independently inventing duplicate architecture, Sass mixins, or project conventions.

## Model And Retry Policy

Every dispatched run is explicitly pinned to `gpt-5.6-sol`. Ordinary work uses `high` reasoning; lead reviews and architecture, auth, privacy, data, security, migration, and deployment work use `xhigh`. Configure role overrides under `defaults.executionPolicy.roles`.

The watch process schedules a fresh durable-claim sweep on every configured interval even while earlier claimed jobs are still running. Transactional claims and the configured runner/concurrency limits bound work; a long builder or reviewer no longer prevents a newly queued independent architect or reviewer from using available capacity.

Each workflow action gets two worker-launch attempts by default with a 30-second base backoff. A cancellation before claim does not consume an attempt. After the launch limit and one bounded transient-recovery cycle, StudioOps opens a visible task circuit with the run ID and failure reason for owner repair. A runner startup sweep also recovers dead-PID and overlong `running` records so one crashed process cannot consume concurrency forever.

Before claiming work, the runner checks the data volume used for SQLite state and run output. The default safety floor is 5 GiB or 2% free, whichever is stricter. Existing builders are not killed by this check; new claims pause until capacity is restored, and the watchdog records the reason instead of entering a restart loop.

## Run Continuously

```bash
npm run runner -- --watch --interval 10 --limit 1
```

The LaunchAgent example lives at:

```text
deploy/local/com.codex.mission-control.runner.plist.example
```

## Providers

The runner supports two execution providers:

- `codex-cli`: default, shells out to the local Codex CLI with `codex exec`
- `codex-sdk`: uses `@openai/codex-sdk`, streams structured events, stores the Codex thread ID, and resumes the same task thread on later runs

Use the SDK provider for one sweep:

```bash
npm run runner -- --provider codex-sdk
```

Or with an environment variable, which is useful for LaunchAgents and shells:

```bash
MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk npm run runner
```

Or make it the default in `studioops.config.md`:

```json
{
  "defaults": {
    "runner": {
      "provider": "codex-sdk"
    }
  }
}
```

The SDK currently wraps the Codex CLI's structured JSON mode and persists threads in `~/.codex/sessions`. StudioOps records the returned thread ID on the run and on the task so later dispatches can resume it. If Codex Desktop surfaces those SDK-created sessions in the sidebar, they should appear as visible tasks; if not, the thread IDs still remain resumable through StudioOps.

## Codex CLI

The CLI and SDK providers both default to:

```text
/Applications/Codex.app/Contents/Resources/codex
```

Override it when needed:

```bash
npm run runner -- --codex-bin /path/to/codex
```

Each run executes:

```bash
codex exec --cd <project-repo> --dangerously-bypass-approvals-and-sandbox --output-last-message <file> -
```

The prompt still forbids merging, production deploys, external messages, secrets, and unrelated changes. The sandbox is disabled so Codex can work across the registered project repo paths on the same machine.

The runner supplies a developer-oriented `PATH` to child Codex sessions so LaunchAgent jobs can find tools installed by Homebrew, including `node`, `npm`, `gh`, and similar project tooling.

`gh` must be installed on the runner host. The runner supplies authentication for each App-authenticated run, so unattended builders should verify the installation token with `gh api /installation/repositories --jq .total_count` but must not run `gh auth login` or rely on a personal keychain session. See [GitHub App Bots](GITHUB_APP_BOTS.md#pull-request-publish-flow) for the copyable push, draft-PR, task-link, and builder-comment procedure.

Runs have a default two-hour timeout. Override it with:

```bash
npm run runner -- --timeout-ms 7200000
```

## GitHub App Bot Auth

Builder and reviewer runs use GitHub App installation tokens by default for GitHub operations. The runner fails before launch when app credentials are missing, invalid, or not installed on the target repository.

Credentials live outside git under:

```text
~/.codex/studioops/credentials/github-apps/
```

The runner maps roles to app identities using `studioops.config.md` `githubApps.roleMap`, or these default directories:

- `default`
- `builder`
- `backend-reviewer`
- `frontend-reviewer`
- `accessibility-reviewer`
- `lead-reviewer`

For each claimed run, StudioOps mints a short-lived repository-scoped installation token, configures `GH_TOKEN`/`GITHUB_TOKEN` for GitHub CLI calls, configures `GIT_ASKPASS` for HTTPS pushes, and rewrites GitHub SSH remotes to HTTPS only inside the runner child process. Tokens are not written into git remotes or command arguments, and runner logs redact them if a child process prints one.

Use a custom app directory:

```bash
npm run runner -- --github-apps-dir /absolute/path/to/github-apps
```

Disable app auth only for local experiments that will not push or create bot-authored GitHub activity:

```bash
npm run runner -- --no-github-app-auth
```

See [GitHub App Bots](GITHUB_APP_BOTS.md) for setup and rotation.

## Output

Runner logs are written to:

```text
data/run-outputs/<run_id>.log
data/run-outputs/<run_id>.last-message.md
```

List runs:

```bash
node src/mission-control-cli.js runs
```

Read a run prompt:

```bash
node src/mission-control-cli.js run-prompt run_1
```

## Human Gate

The runner can create branches, validate work, commit, push, and open/update PRs when the task asks for that. It must not merge or deploy.

Systems-architect runs are read-only against product code. They inspect the repository and supplied assets, create/update StudioOps task records, and complete the durable architecture handoff described in [ARCHITECT.md](ARCHITECT.md).

Once reviewers and lead review pass, the task moves to `user_review`, or to `qa_review` when Trust Leads is enabled. The notifier then tells the human owner. That is the local QA or merge/deploy gate; production still requires explicit owner approval.

## Isolated Workspaces

By default, runner jobs execute in isolated per-run workspaces under:

```text
~/.codex/studioops/run-workspaces/
```

The runner prefers `git worktree` for a project branch. If the target branch is already checked out somewhere else, it falls back to an isolated local clone and points that clone's `origin` remote back to the real GitHub remote.

This lets multiple builders and reviewers run at the same time without sharing one mutable checkout.

Disable isolated workspaces only for debugging:

```bash
npm run runner -- --no-workspace
```

Use a custom workspace root:

```bash
npm run runner -- --workspace-root /path/to/mission-control-workspaces
```

The runner passes these environment variables to Codex:

- `MISSION_CONTROL_WORKSPACE_PATH`
- `MISSION_CONTROL_SOURCE_REPO_PATH`
- `MISSION_CONTROL_WORK_LANE`
- `MISSION_CONTROL_ROOT`
- `MISSION_CONTROL_CONFIG_ROOT`
- `MISSION_CONTROL_DATA_DIR`

The explicit state paths are important: a worker can execute inside any project workspace while still updating the one authoritative StudioOps database.

## Work Lanes

StudioOps assigns each run a lane:

- `backend`
- `frontend`
- `design`
- `devops`
- `product`
- `project-wide`

Tasks can set this explicitly:

```bash
node src/mission-control-cli.js update-task task_1 --lane frontend --work-area "public/**,src/styles/**"
```

If no lane is set, StudioOps infers one from task type, area, title, story, expected outcome, and reviewer role.

Dispatch and runner claim both enforce lane conflicts:

- backend and frontend can run at the same time for one project
- frontend and design conflict by default because they often share UI/CSS/assets
- devops and lead/project-wide work conflict with all lanes for the same project
- different projects can run independently

This is intentionally conservative. Use explicit `--work-area` values when a future scheduler needs finer-grained file ownership.
