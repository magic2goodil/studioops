# StudioOps Codex Plugin

StudioOps ships as a skills-first Codex plugin. Version 0.1 provides a real local intake path while keeping the visual board and worker system in the StudioOps application.

## Install From A Local Checkout

```bash
codex plugin marketplace add /absolute/path/to/studioops
codex plugin add studioops@studioops-marketplace
```

Start a new Codex task after installing or updating a plugin. Bundled skills are loaded when a new task begins.

## What Works In 0.1

- Implicitly recognizes requests to capture, plan, build, or review software through StudioOps.
- Inspects the active repository before intake.
- Reuses an existing StudioOps project or creates one.
- Writes structured tasks to the local board through the StudioOps HTTP API.
- Returns the durable task ID, direct board URL, current status, and next owner.
- Keeps secrets, production releases, paid connectivity, and unsupported completion claims outside the automatic intake path.

The local service defaults to `http://127.0.0.1:4317`. Set `STUDIOOPS_URL` when the service uses another local URL.

## Validate During Development

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/studioops
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/studioops/skills/run-studioops
node plugins/studioops/scripts/studioops.mjs status
```

The first paid integration should be an optional StudioOps Cloud MCP/app connection. The free skill and local client should continue working without cloud authentication.
