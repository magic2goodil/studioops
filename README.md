# Codex Mission Control

Codex Mission Control is a local-first task board for coordinating Codex work across multiple projects.

It is designed for a workflow where you say an idea once, capture it as a task, send it to a builder branch, run backend/frontend/lead reviewer passes as applicable, and only then kick it to the human owner for final review.

This first version is intentionally simple:

- Runs locally with Node.js.
- Stores data in a JSON file.
- Has a browser task board.
- Has a CLI for adding/listing tasks.
- Generates builder and reviewer prompts you can hand to Codex.
- Generates backend, frontend, and primary lead reviewer prompts.
- Includes a supervisor loop for continuously reporting builder, reviewer, dependency, and owner-handoff actions across projects.
- Keeps project safety rules and validation commands beside the task.
- Opens tasks at shareable URLs like `/tasks/task_1`.
- Supports local image previews, feature branch links, PR links, and task comments.
- Supports epic/task hierarchy and dependency links so broad work can be planned before builders start.
- Includes default project standards for engineering, frontend, Sass/CSS, assets, content/IA, data/backend, mockup intake, SEO, performance, accessibility, security/privacy, testing, and review.
- Includes design-system standards for reusable components, Storybook/component catalogs, Twig or equivalent templates, and Sass mixins/tokens.

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
  --repo-url "https://github.com/owner/repo" \
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
  --parent "task_10" \
  --depends-on "task_7, task_8" \
  --branch "codex/myapp-task_2-add-onboarding-flow" \
  --status ready \
  --priority high
```

Link a branch or PR after the builder starts:

```bash
node src/mission-control-cli.js update-task task_2 \
  --branch "codex/myapp-task_2-add-onboarding-flow" \
  --pr-url "https://github.com/owner/repo/pull/123"
```

Add a builder note:

```bash
node src/mission-control-cli.js comment task_2 \
  --author "Codex Builder" \
  --body "Implemented onboarding and opened https://github.com/owner/repo/pull/123"
```

Generate a Codex builder prompt:

```bash
node src/mission-control-cli.js prompt task_1 --role builder
```

Generate a reviewer prompt:

```bash
node src/mission-control-cli.js prompt task_1 --role backend-reviewer
node src/mission-control-cli.js prompt task_1 --role frontend-reviewer
node src/mission-control-cli.js prompt task_1 --role lead-reviewer
```

Run one workflow automation pass:

```bash
npm run automation-tick -- --project dollos --limit 10
```

Run the supervisor once:

```bash
npm run supervisor
```

Run the supervisor continuously:

```bash
npm run supervisor -- --watch --interval 300
```

Record a review outcome:

```bash
node src/mission-control-cli.js review task_1 --stage backend --outcome approved --body "Reviewed API, data model, and validation."
```

## Intended Workflow

1. Capture idea as a task.
2. Shape it with a user story, expected outcome, acceptance criteria, visual attachments, and safety notes.
3. For broad work, create epics and dependency links before assigning builders.
4. For UI-heavy work, create a foundation/design-system task first so parallel builders share tokens, components, mixins, and responsive rules.
5. Attach project standards that the builder and reviewer must follow.
6. Builder Codex thread creates a feature branch and implements it.
7. Builder runs validation, commits, pushes, links the branch/PR, leaves a task comment, and marks the task `builder_review`.
8. Automation tick verifies branch/PR intake and routes work through the review pipeline.
9. Backend reviewer records `approved`, `skipped`, or `changes_requested`.
10. Frontend reviewer records `approved`, `skipped`, or `changes_requested`.
11. Primary lead reviewer records the final review outcome.
12. Automation tick moves fully reviewed work to `user_review`.
13. The supervisor reports `notify_owner` for tasks that have reached the human gate.
14. Human owner approves, asks for changes, merges, or deploys.

Default PR rule: one PR should have one primary Mission Control task. Related tasks may be referenced, but they should not all move to `user_review` unless the PR satisfies each task's acceptance criteria. See [docs/REVIEW_PIPELINE.md](docs/REVIEW_PIPELINE.md).

For continuous coordination, see [docs/SUPERVISOR.md](docs/SUPERVISOR.md).

For UI work, the default standards require mobile-first implementation plus mobile, tablet, and desktop verification. If only one breakpoint is intended, the task must say so explicitly.

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

## Project Standards

Each project can store standards files. These are injected into builder and reviewer prompts.

Default standards live in [standards/](standards/):

- engineering
- design system and component architecture
- frontend and responsive design
- Sass/CSS
- JavaScript
- assets and icons
- content and information architecture
- data and backend
- mockup intake and design critique
- SEO
- performance
- accessibility
- security/privacy
- testing
- review checklist

For UI work, the default standard is mobile-first, not mobile-only: builders must account for mobile, tablet, and desktop unless the task explicitly scopes one breakpoint.

For component work, the default standard is reusable-by-design: a card, CTA, badge, modal, or form control should be built once as a component/template and reused across pages. Design artifacts should define responsive variants and component states before page implementation when practical.

For parallel builder work, the default standard is foundation-first. One builder should define the shared design system, Sass API, data-access conventions, and performance expectations before several builders start implementing page slices. Reviewer prompts are expected to catch duplicate components, duplicate mixins, unindexed queries, and other “AI slop” signals before the work reaches the owner.

## Current Scope

This repository now has a bounded workflow automation steward for assignment, dependency blocking/unblocking, review routing, review-cycle handling, and owner handoff.

It also has a read-oriented supervisor command that can run every few minutes to report what builders, reviewers, or the human owner should do next across all projects.

It still does not spawn Codex threads, open GitHub PRs, merge branches, deploy, or send external notifications by itself. Those should be built as the next runner layer on top of the existing `automation-tick`, review outcomes, and `owner_review_requested` events.

The next logical layer is GitHub integration and Codex thread/action integration.
