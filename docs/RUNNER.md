# Mission Control Runner

The runner is the execution layer after the dispatcher.

It claims queued builder/reviewer runs and launches a Codex provider against the target project repository with the stored Mission Control prompt.

It can:

- claim one or more queued builder/reviewer runs
- mark runs `running`, `completed`, or `failed`
- stream Codex output to `data/run-outputs/`
- store Codex thread IDs on runs and tasks when the SDK provider returns them
- pass the task ID and run ID into the worker environment
- run continuously through a local LaunchAgent

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

## Run Continuously

```bash
npm run runner -- --watch --interval 300 --limit 1
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

Or make it the default in `mission-control.config.md`:

```json
{
  "defaults": {
    "runner": {
      "provider": "codex-sdk"
    }
  }
}
```

The SDK currently wraps the Codex CLI's structured JSON mode and persists threads in `~/.codex/sessions`. Mission Control records the returned thread ID on the run and on the task so later dispatches can resume it. If Codex Desktop surfaces those SDK-created sessions in the sidebar, they should appear as visible tasks; if not, the thread IDs still remain resumable through Mission Control.

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

Runs have a default two-hour timeout. Override it with:

```bash
npm run runner -- --timeout-ms 7200000
```

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

Once reviewers and lead review pass, the task moves to `user_review`. The notifier then tells the human owner. That is the merge/deploy gate.
