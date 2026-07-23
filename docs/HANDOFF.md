# Future Chat Handoff

Use this document when a new or existing AI chat needs to coordinate work through StudioOps.

## Canonical Project Reference

Repository:

```text
https://github.com/magic2goodil/studioops
```

Local app URL when running:

```text
http://127.0.0.1:4317
```

Task URLs use:

```text
http://127.0.0.1:4317/tasks/<task_id>
```

Supervisor docs:

```text
docs/SUPERVISOR.md
```

Dispatcher docs:

```text
docs/DISPATCHER.md
```

Steward docs:

```text
docs/STEWARD.md
```

Runner docs:

```text
docs/RUNNER.md
```

Systems architect docs:

```text
docs/ARCHITECT.md
```

Notifier docs:

```text
docs/NOTIFIER.md
```

Default installed source checkout:

```text
~/.codex/studioops/source
```

Persistent control-plane state, worker workspaces, runtime releases, logs, and credentials also live below `~/.codex/studioops`. Do not place StudioOps operational state in Documents, Desktop, or another cloud-synchronized directory.

## What The User Can Say

Create a task only:

```text
Create a task for this in StudioOps and send me the link.
```

Create a task, then wait:

```text
Add this to StudioOps. Do not build it yet.
```

Create and build:

```text
Build this through StudioOps.
```

Break a mockup into tasks:

```text
Break this mockup into StudioOps tasks, one task per screen or functional slice.
```

Review existing work:

```text
Review the branch for task task_123 and tell me if it is ready for me.
```

## Intake Standard

Every non-trivial task should be shaped into a real build ticket before implementation.

Broad apps, platforms, epics, and mockup-driven product work must pass through the `systems-architect` gate before builders. The architect is pinned to `gpt-5.6-sol` at `xhigh`, records the cross-cutting technical decisions, and creates the dependency-linked implementation task graph. See [ARCHITECT.md](ARCHITECT.md).

Functional delivery is the default. `visual-only` must be stated explicitly. A mockup is evidence of presentation and interaction intent, not authorization to deliver a static replica.

Required fields:

- Project
- Title
- User story
- Problem or description
- Expected outcome
- Acceptance criteria
- Visual attachments or context links when relevant
- Referenced standards
- Privacy and security notes when relevant
- Suggested branch name when known
- Linked pull request URL when known
- Validation commands or test expectations

For broad work, use hierarchy:

- Epic: a page, major workflow, system foundation, or product area.
- Task: one buildable slice that can fit on a feature branch.
- Dependency: work that must be finished or reviewed before another task starts.

For UI work with several builders, create a design-system/foundation epic first. Page builders should depend on that foundation instead of inventing new buttons, cards, mixins, typography, colors, or layout primitives in parallel.

For backend/data work, include query shape, likely indexes, pagination/result limits, migration expectations, and data ownership.

For consent-sensitive work, include the opt-in path, opt-out/revocation behavior, consent copy requirements, data minimization, retention expectations, and whether analytics must be aggregated.

For marketing/public pages, include editable content regions, dynamic data regions, SEO fields, navigation routes, dropdown/subnav expectations, and whether visible mockup items map to confirmed product requirements or need product decisions.

User story format:

```text
As a [role], I want [capability], so that [outcome].
```

Examples:

```text
As a business owner, I want to create an event with a photo and category tags, so that nearby customers can discover it on the live map.
```

```text
As a mobile user, I want location permission explained before the permission prompt, so that I understand why Event Horizon needs access.
```

Acceptance criteria should be observable. Prefer:

```text
- The business event form stores title, image, time, location, categories, and approval status.
- The event appears on the consumer map only after approval.
- The builder runs npm run check and records the result.
```

Avoid:

```text
- Make it better.
- Clean up the UI.
```

## Visual Attachments

For UI, design, bug, or mockup work, attach at least one visual reference when available.

Supported attachment forms:

- Absolute local image path
- Screenshot path
- Mockup crop path
- Public image URL
- Design URL
- Short textual reference when no image exists

If a full mockup contains multiple screens, prefer creating cropped image files for each task. If cropping is not practical, attach the full mockup and describe the exact region, screen, or component.

Image attachments should render inside the task detail page as clickable previews. They should expand in the page, not open a new browser window.

## Responsive Design Standard

UI and design tasks are mobile-first by default, but they are not mobile-only by default.

When the user provides a mobile mockup, the task should still define expected behavior for:

- mobile
- tablet
- desktop
- wide desktop when relevant

If tablet or desktop is out of scope, that must be stated explicitly in the task. Otherwise the builder is expected to infer a polished responsive layout that preserves the design intent across breakpoints.

For redesign work, do not update only the mocked component while leaving the rest of the visible page in an obviously mismatched design state unless the task explicitly scopes a single component.

## Component Design Standard

When a design artifact defines a reusable piece of UI, create or update the shared component instead of hard-coding a one-off page instance.

Preferred design inputs:

- Figma, Sketch, or equivalent design files
- static mockups
- screenshots
- Storybook or a component catalog
- existing production components

Component tasks should define:

- component anatomy
- mobile, tablet, and desktop layouts
- variants
- states
- data requirements
- accessibility requirements
- reusable Sass tokens, mixins, or component classes
- template/component location, such as Twig partial, React component, Vue component, Astro component, or server-rendered partial

Twig is acceptable and preferred for PHP/Drupal-style projects when already available. Storybook is preferred for projects with enough reusable UI surface to justify it; otherwise a simpler component gallery is acceptable.

## Build Flow

When the user says to build:

1. Create or update the StudioOps task.
2. Route broad app/platform/mockup work to `architecture_pending`.
3. Let the `systems-architect` inspect the repository and supplied assets, choose the justified system/data/API/performance boundaries, and create dependency-linked child tasks.
4. Create each implementation child with the architecture task as its parent and `--architecture-approved`; this stages the child without making it buildable.
5. Record architecture completion only after StudioOps validates the complete child contract and acyclic dependency graph. The same transaction marks the parent complete and its governed children ready, so no child builder can dispatch early.
6. Confirm parent epic and dependency links when this is part of larger work.
7. If the task depends on foundation/design-system/data-access work, do not start the builder until that dependency is ready.
8. Let the scheduled dispatcher create a durable builder run, or run `npm run dispatcher`.
9. Let the scheduled runner consume the queued builder/reviewer run, or run `npm run runner`.
10. If automated runner support is unavailable, generate the builder prompt from StudioOps and hand it to a Codex builder task/thread.
11. Builder creates a feature branch using:

```text
codex/<project-key>-<task-id>-<short-title>
```

12. Builder implements the change, validates it, commits, pushes, and opens a PR when the project workflow calls for it.
13. Builder links the feature branch and PR on the task.
14. Builder leaves a task comment with changed files, validation results, known gaps, and the PR link.
15. Task moves to `builder_review`.
16. Run `npm run automation-tick -- --project <project-key> --limit 10` or let the scheduled steward route the task across projects.
17. Run `npm run dispatcher -- --plan` to preview worker dispatches, or let the scheduled dispatcher create durable run records across projects.
18. Run `npm run runner -- --plan` to preview queued builder/reviewer work, or let the scheduled runner execute queued Codex work.
19. Backend reviewer runs when the PR touches backend, data, auth, analytics, queues, integrations, deployment, security, privacy, or persistence. Otherwise, record a `skipped` backend review.
20. Frontend reviewer runs when the PR touches UI, templates, CSS/Sass, frontend JavaScript, content rendering, assets, SEO, accessibility, or public pages. Otherwise, record a `skipped` frontend review.
21. Accessibility reviewer runs before lead review for UI/frontend work and checks contrast, typography, focus-visible states, keyboard tab order, semantic headings, link/button names, alt text, title text, form labels, ARIA use, screen-reader basics, and mobile/tablet/desktop behavior. Otherwise, record a `skipped` accessibility review.
22. Primary team lead reviewer checks product fit, architecture, scope, previous reviewer findings, deployment risk, and whether the PR should be split.
23. Reviewers record outcomes with `studioops review <task-id> --stage backend|frontend|accessibility|lead --outcome approved|skipped|changes_requested --body "..."`.
24. A first routine `changes_requested` outcome returns the task to `needs_changes` and assigns the builder. At the configured review-cycle limit, non-lead `changes_requested` routes to lead review instead of another builder loop.
25. After all current-cycle review stages are approved or skipped, automation moves the task to `user_review`, or to `qa_review` when Trust Leads is enabled.
26. The supervisor reports `notify_owner` for final human review or `notify_qa_review` for local QA bundle review.
27. The notifier sends a local owner/QA-review notification.
28. The human owner makes the final production release decision.

Default PR rule:

- One PR should have one primary StudioOps task.
- Related tasks can be referenced in the PR body or task comments.
- Do not mark several independent tasks `user_review` from one PR unless the PR satisfies each task's acceptance criteria.
- In Trust Leads mode, do not treat `qa_review` as production approval; it is a local QA bundle gate.
- If one foundation PR intentionally covers several related tasks, add comments to each linked task saying whether the PR completes it or only partially advances it.

## Mockup Breakdown Flow

When asked to break a mockup into tasks:

1. Inspect the full mockup first.
2. Run the systems architect before builders.
3. Inventory canonical assets, especially supplied logos, and identify each screen, panel, state, interaction, and data-bearing region.
4. Create a foundation/design-system epic before page builders begin.
5. Define the shared component inventory, Sass tokens/mixins/classes, fonts, spacing, cards, buttons, maps, charts, icons, image treatments, and motion language.
6. Identify editable content, dynamic content, and hard-coded design-only elements.
7. Audit navigation and subnavigation against the product requirements; create tasks for valid pages and call out placeholders or AI-invented items.
8. Group the work into coherent slices that one builder can finish on a feature branch.
9. Create one StudioOps task per slice.
10. Attach the relevant image crop or full mockup reference.
11. Include mobile, tablet, and desktop expectations for each visual slice.
12. Include the applicable product requirement, not just the visual appearance.
13. Add acceptance criteria that cover functionality, responsive behavior, visual match, reuse of shared components, editable/dynamic content, privacy/consent where relevant, and validation.
14. Link each task back to the same project and original source image.

The first implementation task after a mockup breakdown should usually be a foundation task. It prevents six parallel builders from creating six button systems, six card systems, or six incompatible Sass APIs.

For Event Horizon, useful slices include:

- Landing hero and brand system
- Consumer discovery map
- Event detail screen
- Business signup and onboarding
- Business dashboard
- Admin review and approval queue
- Live activity map and heat map
- Social check-in and friend visibility controls
- Real data ingestion and business profile enrichment

## Security And Privacy Standard

Every task should assume security and PII matter.

Default rules:

- Do not commit secrets, tokens, private keys, or private customer data.
- Treat auth, payment, location, social graph, behavioral analytics, and business performance data as sensitive.
- Prefer durable storage for auth/session data instead of in-memory prototype state.
- Keep user-identifying analytics aggregated unless the feature explicitly requires identity.
- Avoid broad logging of PII.
- Do not send notifications, emails, SMS, or external messages without explicit approval.
- Do not deploy production without explicit approval.
- PR merges and protected integration branch pushes should run validation, previews, or staging only; they must not deploy production by default.
- Production deploys should run through an explicit release/tag workflow that verifies the target commit is reachable from the protected integration branch, not ad hoc local SSH.
- Manual `workflow_dispatch` deploys should be dry-run or preview-only unless explicitly approved for an emergency production path.
- Real production deploy workflows should be gated to the approved owner/deployer actor or allowed deployer list.
- Deployment work must preserve production state. Do not allow broad delete flags, stale-file deletion switches, sync-cleanup, or cleanup commands that can remove env files, databases, uploads, generated media, logs, virtualenvs, backups, or production-only runtime assets.

Consent-sensitive features include:

- background or precise location
- push notifications, email, SMS, or other outbound messaging
- social presence, friend visibility, check-ins, or "headed there" status
- behavioral analytics tied to a user
- personalization and inferred interest profiles
- AI training, coaching, persuasion, hypnosis, or similar behavior-shaping experiences
- third-party sharing, ads, or business-facing analytics derived from users

Those tasks must say how consent is requested, what the user is told, how consent can be revoked, and what happens to already-collected data.

## Anti-Slop Quality Standard

StudioOps should prevent rushed AI output from becoming production architecture.

Default rules:

- Builders must read source files and project standards before editing.
- Shared UI must be implemented through reusable components/templates and Sass tokens/mixins/classes.
- Source Sass and source JavaScript should be edited, not only compiled/minified output.
- Performance-sensitive database work must consider indexes, query shape, pagination, and explain/query-plan review where practical.
- Large rewrites should be split into reviewable chunks with feature branches and PRs.
- Reviewers should send work back when it looks complete visually but is brittle, duplicated, slow, inaccessible, insecure, or hard for a human to maintain.
- Reviewers must reject an inert display page when the task asks for an app, workflow, platform, or functional product.
- Every visible primary control must work or be explicitly disabled and labeled. Data-bearing UI must have a defined source of truth, persistence lifecycle, authorization boundary, bounded loading behavior, and loading/empty/error states.

## If StudioOps Is Not Running

From the repo:

```bash
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:4317
```

If a future assistant cannot run the local app, it should still create or update tasks through the CLI:

```bash
node src/mission-control-cli.js add-task \
  --project event-horizon \
  --title "Task title" \
  --story "As a user..." \
  --description "Problem and context" \
  --expected "Expected behavior" \
  --criteria "Observable acceptance criteria" \
  --attachment "/absolute/path/to/mockup.png" \
  --status ready
```

Then generate a prompt:

```bash
node src/mission-control-cli.js prompt task_123 --role builder
```
