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
- Includes a steward tick for continuously routing task workflow state across projects.
- Includes a dispatcher loop for creating durable builder, reviewer, and owner handoff run records from supervisor actions.
- Includes a runner loop for consuming queued builder/reviewer runs with Codex CLI or the Codex SDK.
- Runs builders/reviewers in isolated workspaces with lane-aware scheduling so backend, frontend, design, and devops work do not blindly collide.
- Includes a notifier loop for local owner-review and failed-run notifications.
- Includes a GitHub App manifest setup helper for Mission Control bot identities.
- Keeps project safety rules and validation commands beside the task.
- Opens tasks at shareable URLs like `/tasks/task_1`.
- Supports local image previews, feature branch links, PR links, and task comments.
- Supports epic/task hierarchy and dependency links so broad work can be planned before builders start.
- Supports optional Trust Leads mode, where lead-approved work goes to a consolidated `qa_review` queue instead of requiring owner review on every individual task.
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

Optional: create a private GitHub App identity for Mission Control automation:

```bash
npm run setup-github-app
```

For separate builder/reviewer role identities:

```bash
npm run setup-github-role-apps
```

See [GitHub App Bots](docs/GITHUB_APP_BOTS.md).

The runner uses these local GitHub App credentials by default for builder and reviewer branch pushes, pull requests, comments, and reviews. If app credentials are missing or the app is not installed on the target repository, the run fails before Codex starts instead of falling back to a personal GitHub identity.

## Always-On Local Automation

On macOS, install the local web UI, steward, supervisor, dispatcher, runner, and notifier as user LaunchAgents:

```bash
npm run install-agents
```

By default the web UI binds to localhost only:

```text
http://127.0.0.1:4317
```

To view it from another device on your local network, install with an explicit network bind:

```bash
MISSION_CONTROL_HOST=0.0.0.0 MISSION_CONTROL_PORT=4317 npm run install-agents
```

Check status:

```bash
npm run status-agents
```

Remove the LaunchAgents:

```bash
npm run uninstall-agents
```

The installer writes user LaunchAgents under `~/Library/LaunchAgents` and logs under `data/launch-agents/`. It does not install system services, ask for sudo, merge PRs, deploy production, or store private keys.

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

The local LaunchAgent steward runs the same workflow tick on a schedule for every registered project.

Run the supervisor once:

```bash
npm run supervisor
```

Run the supervisor continuously:

```bash
npm run supervisor -- --watch --interval 300
```

Preview dispatcher work:

```bash
npm run dispatcher -- --plan
```

Dispatch work into durable run records:

```bash
npm run dispatcher
```

Preview queued Codex runner work:

```bash
npm run runner -- --plan
```

Run the next queued builder/reviewer dispatch with Codex:

```bash
npm run runner
```

Use the SDK-backed provider when you want Mission Control to store and resume Codex thread IDs:

```bash
npm run runner -- --provider codex-sdk
```

Preview owner/failure notifications:

```bash
npm run notifier -- --plan
```

Send local macOS notifications for owner/failure handoffs:

```bash
npm run notifier
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
12. Automation tick moves fully reviewed work to `user_review`, or to `qa_review` when Trust Leads is enabled for the project.
13. The supervisor reports `notify_owner` or `notify_qa_review` for tasks that have reached the human gate.
14. Human owner tests the QA bundle locally, approves, asks for changes, merges, or deploys through the protected release workflow.

Default PR rule: one PR should have one primary Mission Control task. Related tasks may be referenced, but they should not all move to `user_review` unless the PR satisfies each task's acceptance criteria. See [docs/REVIEW_PIPELINE.md](docs/REVIEW_PIPELINE.md).

Default review-loop rule: reviewers may fix small deterministic issues directly and document the fix. Material issues get `changes_requested`, but routine builder-review ping-pong is capped at two cycles; after that, non-lead change requests route to the primary lead for the final automation decision.

Trust Leads mode is project-level. When `reviewPolicy.trustLeadApprovals` is true, lead-approved work moves to `qa_review` with an optional non-production `integrationBranch`. This reduces per-PR owner review fatigue, but it does not authorize production deploys or bypass the final owner release decision.

For continuous coordination, see [docs/STEWARD.md](docs/STEWARD.md), [docs/SUPERVISOR.md](docs/SUPERVISOR.md), [docs/DISPATCHER.md](docs/DISPATCHER.md), [docs/RUNNER.md](docs/RUNNER.md), and [docs/NOTIFIER.md](docs/NOTIFIER.md).

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
- release/deployment
- review checklist

For UI work, the default standard is mobile-first, not mobile-only: builders must account for mobile, tablet, and desktop unless the task explicitly scopes one breakpoint.

For component work, the default standard is reusable-by-design: a card, CTA, badge, modal, or form control should be built once as a component/template and reused across pages. Design artifacts should define responsive variants and component states before page implementation when practical.

For parallel builder work, the default standard is foundation-first. One builder should define the shared design system, Sass API, data-access conventions, and performance expectations before several builders start implementing page slices. Reviewer prompts are expected to catch duplicate components, duplicate mixins, unindexed queries, and other “AI slop” signals before the work reaches the owner.

## Current Scope

This repository now has a bounded workflow automation steward for assignment, dependency blocking/unblocking, review routing, review-cycle handling, and owner handoff.

It also has a read-oriented supervisor command that can run every few minutes to report what builders, reviewers, or the human owner should do next across all projects.

The dispatcher consumes supervisor actions and creates durable run records with prompt snapshots. The default provider is `prompt-outbox`, which is intentionally vendor-neutral and ready for a Codex/native-thread runner to pick up.

The included runner consumes queued builder/reviewer runs and launches Codex against the target project repository. The default `codex-cli` provider shells out to the local Codex CLI. The optional `codex-sdk` provider uses `@openai/codex-sdk`, streams structured events, stores returned Codex thread IDs, and resumes those threads on later task runs. Builder and reviewer prompts allow branch creation, validation, commits, pushes, and PR creation when the task requires it, while still forbidding production deploys, merges, secrets, external messages, and bypassing the human owner gate.

The next logical layer is richer GitHub integration and deeper native Codex task/action integration, but the local runner is already enough to execute queued work on a developer machine.
