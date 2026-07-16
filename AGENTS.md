# Codex Operating Notes

When working in this repository:

- Keep the app local-first and easy to run.
- Do not add external services unless the task explicitly calls for them.
- Do not store secrets in the repo or in sample data.
- Treat project safety rules as first-class instructions.
- Prefer small, reviewable branches.
- Keep generated task prompts clear enough to paste into a fresh Codex thread.
- Use `docs/HANDOFF.md` when a user asks to create, build, review, or split work through Mission Control.
- For non-trivial tasks, capture user story, expected outcome, acceptance criteria, visual attachments when relevant, and privacy/security notes before implementation.
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

## Roles

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
