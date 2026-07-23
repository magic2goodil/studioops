# Codex Operating Notes

When working in this repository:

- Keep the app local-first and easy to run.
- Do not add external services unless the task explicitly calls for them.
- Do not store secrets in the repo or in sample data.
- Treat project safety rules as first-class instructions.
- Prefer small, reviewable branches.
- Keep generated task prompts clear enough to paste into a fresh Codex thread.
- Use `docs/HANDOFF.md` when a user asks to create, build, review, or split work through StudioOps.
- Use `docs/STEWARD.md` when a user asks for scheduled workflow routing or status advancement across projects.
- Use `docs/SUPERVISOR.md` when a user asks for continuous coordination, scheduled checks, or what should move next across projects.
- Use `docs/DISPATCHER.md` when a user asks StudioOps to actually queue builder, reviewer, or owner handoff work.
- Use `docs/RUNNER.md` when a user asks StudioOps to execute queued builder/reviewer runs through Codex CLI.
- Use `docs/ARCHITECT.md` for broad apps, platforms, epics, and mockup-driven work that must be decomposed before builders.
- Use `docs/NOTIFIER.md` when a user asks StudioOps to notify them when owner review or failures need attention.
- For non-trivial tasks, capture user story, expected outcome, acceptance criteria, visual attachments when relevant, and privacy/security notes before implementation.
- Broad product/mockup work must pass through the `systems-architect` gate before builders. The role is pinned to `gpt-5.6-sol` at `xhigh` and must record a durable architecture plus dependency-linked implementation tasks.
- Functional delivery is the default. A visual-only task must be explicit; mockups do not authorize inert display pages.
- Attach project standards to tasks and enforce them in builder/reviewer prompts.
- For UI work, require mobile-first implementation plus tablet and desktop expectations unless a task explicitly scopes one breakpoint only.
- For repeated UI, require reusable components/templates and shared Sass tokens/mixins/classes instead of page-specific copies.
- Builder work should link the feature branch and PR on the task, then leave a task comment with changed files, validation, known gaps, and the PR URL.
- One PR should have one primary task by default. If a PR intentionally advances several related tasks, comments must say which task is primary and whether each related task is complete or partial.
- Tasks should move from `builder_review` through applicable backend/frontend review and then `lead_review` before `user_review`.
- Backend review is required for API, data, auth, analytics, queues, privacy/security, persistence, or deployment changes unless explicitly skipped in a task comment.
- Frontend review is required for UI, CSS/Sass, frontend JS, content rendering, assets, SEO, accessibility, or public page changes unless explicitly skipped in a task comment.
- Primary lead review is always required before work reaches the human owner.
- Reviewers may make tiny low-risk fixes to save time, but they must document those fixes. Material, risky, ambiguous, or product-shaping fixes go back to the builder as `needs_changes`.
- Run `npm run check` before committing code changes.
- Use `npm run supervisor` for a read-only cross-project action sweep, or `npm run supervisor -- --watch --interval 15` for a continuous local loop. The supervisor must not merge, deploy, or send external notifications.
- Use `npm run automation-tick -- --limit 50` for one workflow-routing pass. The scheduled steward LaunchAgent runs that command every 10 seconds across all projects.
- Use `npm run dispatcher -- --plan` to preview dispatches and `npm run dispatcher` to create durable dispatch runs. The dispatcher must not merge, deploy, or send external notifications.
- Use `npm run runner -- --plan` to preview queued builder/reviewer work and `npm run runner` to let Codex CLI execute one queued run. The runner must not merge or deploy and must stop at the human owner gate.
- Use `npm run notifier -- --plan` to preview local notifications and `npm run notifier` to send owner/failure notifications. The notifier must not approve, merge, deploy, or send app/customer-facing messages.

## Roles

Systems architect role:

- Inspect the repository and every supplied mockup, logo, screenshot, and reference.
- Choose the smallest justified server, persistence, API, cache, queue, performance, security, and operating architecture.
- Record material decisions and rejected alternatives.
- Create dependency-linked implementation tasks that carry those decisions to builders.
- Do not edit product code, open a feature PR, merge, or deploy.

Builder role:

- Read the task and project context.
- Create a feature branch.
- Implement the requested change.
- Run validation.
- Commit and push if asked.
- Mark gaps honestly.

Reviewer role:

- Review the branch like a senior engineer.
- Lead with findings.
- Check acceptance criteria, tests, security, privacy, and scope.
- Do not rubber-stamp incomplete work.
- Use the backend, frontend, or primary lead reviewer lane as appropriate.
- Move work to `needs_changes` when material issues exist; only primary lead review should move work to `user_review`.
