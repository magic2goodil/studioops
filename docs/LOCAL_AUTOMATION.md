# Local Automation

Mission Control can run manually from the CLI or continuously through macOS user LaunchAgents.

The always-on stack includes:

- `web`: serves the task board and API
- `steward`: advances workflow state and review routing every few minutes
- `supervisor`: reports next actions across projects
- `dispatcher`: creates durable builder, reviewer, and owner-handoff runs
- `runner`: launches queued builder/reviewer runs with Codex CLI
- `notifier`: sends local owner-review and failure notifications

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
```

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

The always-on stack may create branches, run validation, commit, push, and open or update pull requests when a task asks for that behavior.

It must not:

- merge pull requests
- deploy production
- send customer-facing messages
- commit secrets or private data
- bypass the human owner review gate

The runner intentionally defaults to one active Codex run at a time. That keeps parallel agents from inventing competing architecture, Sass mixins, migrations, or data contracts in the same repository.
