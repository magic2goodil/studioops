# Codex Mission Control

Codex Mission Control is a local-first task board for coordinating Codex work across multiple projects.

It is designed for a workflow where you say an idea once, capture it as a task, send it to a builder branch, have a reviewer pass inspect it, and only then kick it to the human owner for final review.

This first version is intentionally simple:

- Runs locally with Node.js.
- Stores data in a JSON file.
- Has a browser task board.
- Has a CLI for adding/listing tasks.
- Generates builder and reviewer prompts you can hand to Codex.
- Keeps project safety rules and validation commands beside the task.

## Quick Start

```bash
git clone https://github.com/magic2goodil/codex-mission-control.git
cd codex-mission-control
npm install
npm run setup
npm run dev
```

Open:

```text
http://127.0.0.1:4317
```

No external database is required. The app writes to `data/mission-control.json`.

The setup wizard writes `mission-control.config.md`, which is ignored by Git. It asks about your GitHub owner, local workspace, AI tools, and first project. It checks GitHub CLI and SSH readiness, but it does not ask for or store private SSH keys.

## CLI

List projects:

```bash
npm run projects
```

Run setup:

```bash
npm run setup
```

Import projects from `mission-control.config.md`:

```bash
npm run import-config
```

List tasks:

```bash
npm run tasks
```

Add a project:

```bash
node src/mission-control-cli.js add-project \
  --key myapp \
  --name "My App" \
  --repo-path "/absolute/path/to/repo" \
  --default-branch main
```

Add a task:

```bash
node src/mission-control-cli.js add-task \
  --project myapp \
  --title "Add onboarding flow" \
  --story "As a new user, I want onboarding to explain the product before auth." \
  --description "Create a first-pass onboarding screen and tests." \
  --expected "Users see the onboarding flow, then continue to auth." \
  --criteria "The first screen explains the value, Location and notification prompts are introduced before permission requests, npm run check passes" \
  --attachment "/absolute/path/to/mockup.png" \
  --status ready \
  --priority high
```

Generate a Codex builder prompt:

```bash
node src/mission-control-cli.js prompt task_1 --role builder
```

Generate a reviewer prompt:

```bash
node src/mission-control-cli.js prompt task_1 --role reviewer
```

## Intended Workflow

1. Capture idea as a task.
2. Shape it with a user story, expected outcome, acceptance criteria, visual attachments, and safety notes.
3. Builder Codex thread creates a feature branch and implements it.
4. Builder runs validation, commits, pushes, and marks the task `builder_review`.
5. Reviewer Codex thread reviews the branch.
6. Reviewer sends it back as `needs_changes` or forwards it as `user_review`.
7. Human owner approves, asks for changes, merges, or deploys.

## Future Chat Handoff

For new or existing chats, point the assistant at:

```text
docs/HANDOFF.md
```

Useful phrases:

```text
Create a task for this in Mission Control and send me the link.
```

```text
Build this through Mission Control.
```

```text
Break this mockup into Mission Control tasks, one task per screen or functional slice.
```

The handoff standard requires a user story, problem description, expected outcome, acceptance criteria, visual attachments for UI or bug work, privacy/security notes when relevant, and a builder/reviewer workflow.

## Project Safety Rules

Each project can store safety rules. Examples:

- Do not deploy production without explicit approval.
- Do not send emails or notifications without explicit approval.
- Treat PII, auth data, payment data, location data, and behavioral analytics as sensitive.
- Use project-specific context files before editing.

## Current Scope

This repository does not yet spawn Codex threads automatically. It gives you the durable local board, project context, branch/review fields, and prompts needed to coordinate Codex work manually.

The next logical layer is GitHub integration and Codex thread/action integration.
