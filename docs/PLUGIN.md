# StudioOps Codex Plugin

StudioOps ships as a skills-first Codex plugin. Version 0.1 can bootstrap the local Community application and provides a real intake path into its visual board and worker system.

## Install From GitHub

```bash
codex plugin marketplace add magic2goodil/studioops
codex plugin add studioops@studioops-marketplace
```

Start a new Codex task inside a software repository and ask:

```text
Set up StudioOps Community for this project.
```

The bundled bootstrap installs under `~/.studioops/community`, creates local configuration and SQLite state under `~/.studioops/community/workspace`, registers the current repository, and starts StudioOps on `127.0.0.1:4317`. It requires Node.js 22.5 or newer, npm, and Git. GitHub CLI and Codex CLI are checked but are not required for the local board.

## Install From A Local Checkout

```bash
codex plugin marketplace add /absolute/path/to/studioops
codex plugin add studioops@studioops-marketplace
```

Start a new Codex task after installing or updating a plugin. Bundled skills are loaded when a new task begins.

## What Works In 0.1

- Diagnoses required and optional local tooling with `community.mjs doctor`.
- Installs and starts StudioOps Community on first use when the local service is absent.
- Keeps source, configuration, state, logs, and process metadata under a predictable user-local directory.
- Registers the active repository without importing another user's database, credentials, or task history.
- Implicitly recognizes requests to capture, plan, build, or review software through StudioOps.
- Inspects the active repository before intake.
- Reuses an existing StudioOps project or creates one.
- Writes structured tasks to the local board through the StudioOps HTTP API.
- Returns the durable task ID, direct board URL, current status, and next owner.
- Keeps secrets, production releases, paid connectivity, and unsupported completion claims outside the automatic intake path.

The local service defaults to `http://127.0.0.1:4317`. Set `STUDIOOPS_URL` when the service uses another local URL. The bootstrap remains localhost-only and does not enable GitHub writes, background workers, cloud services, merges, releases, or deployment.

Useful bootstrap commands:

```bash
node plugins/studioops/scripts/community.mjs doctor
node plugins/studioops/scripts/community.mjs bootstrap --project /absolute/path/to/project
node plugins/studioops/scripts/community.mjs start
node plugins/studioops/scripts/community.mjs stop
```

## Validate During Development

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/studioops
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/studioops/skills/run-studioops
node plugins/studioops/scripts/community.mjs doctor
node plugins/studioops/scripts/studioops.mjs status
```

The first paid integration should be an optional StudioOps Cloud MCP/app connection. The free skill and local client should continue working without cloud authentication.
