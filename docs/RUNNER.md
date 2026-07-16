# Mission Control Runner

The runner is the execution layer after the dispatcher.

It claims queued builder/reviewer runs and launches Codex CLI against the target project repository with the stored Mission Control prompt.

It can:

- claim one or more queued builder/reviewer runs
- mark runs `running`, `completed`, or `failed`
- stream Codex output to `data/run-outputs/`
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

## Codex CLI

The runner defaults to:

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
