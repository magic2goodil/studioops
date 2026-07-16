# Future Chat Handoff

Use this document when a new or existing AI chat needs to coordinate work through Codex Mission Control.

## Canonical Project Reference

Repository:

```text
https://github.com/magic2goodil/codex-mission-control
```

Local app URL when running:

```text
http://127.0.0.1:4317
```

Task URLs use:

```text
http://127.0.0.1:4317/tasks/<task_id>
```

Default local repo path for this machine:

```text
/Users/jrobison/Documents/Codex/2026-07-15/codex-mission-control
```

## What The User Can Say

Create a task only:

```text
Create a task for this in Mission Control and send me the link.
```

Create a task, then wait:

```text
Add this to Mission Control. Do not build it yet.
```

Create and build:

```text
Build this through Mission Control.
```

Break a mockup into tasks:

```text
Break this mockup into Mission Control tasks, one task per screen or functional slice.
```

Review existing work:

```text
Review the branch for task task_123 and tell me if it is ready for me.
```

## Intake Standard

Every non-trivial task should be shaped into a real build ticket before implementation.

Required fields:

- Project
- Title
- User story
- Problem or description
- Expected outcome
- Acceptance criteria
- Visual attachments or context links when relevant
- Privacy and security notes when relevant
- Suggested branch name when known
- Linked pull request URL when known
- Validation commands or test expectations

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

## Build Flow

When the user says to build:

1. Create or update the Mission Control task.
2. Set task status to `ready` or `queued`.
3. Generate the builder prompt from Mission Control.
4. If Codex thread tools are available, create a builder task/thread and send the prompt there.
5. If thread tools are not available, provide the builder prompt and the Mission Control task link.
6. Builder creates a feature branch using:

```text
codex/<project-key>-<task-id>-<short-title>
```

7. Builder implements the change, validates it, commits, pushes, and opens a PR when the project workflow calls for it.
8. Builder links the feature branch and PR on the task.
9. Builder leaves a task comment with changed files, validation results, known gaps, and the PR link.
10. Task moves to `builder_review`.
11. A reviewer pass checks acceptance criteria, tests, security, privacy, and scope.
12. Reviewer moves the task to `needs_changes` or `user_review`.
13. The human owner makes the final merge/deploy decision.

## Mockup Breakdown Flow

When asked to break a mockup into tasks:

1. Inspect the full mockup first.
2. Identify each screen, panel, state, and interaction.
3. Group the work into coherent slices that one builder can finish on a feature branch.
4. Create one Mission Control task per slice.
5. Attach the relevant image crop or full mockup reference.
6. Include the applicable product requirement, not just the visual appearance.
7. Add acceptance criteria that cover functionality, responsive behavior, visual match, and validation.
8. Link each task back to the same project and original source image.

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

## If Mission Control Is Not Running

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
