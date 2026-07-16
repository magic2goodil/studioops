# Review Pipeline

Mission Control uses staged review so the human owner only sees work after the builder and reviewer agents have done their jobs.

## Default Flow

1. `in_progress`
   - Builder is implementing the task on a feature branch.

2. `builder_review`
   - Builder has pushed a branch/PR, run validation, linked the PR on the task, and left a comment with changed files, validation results, known gaps, and next review step.

3. `backend_review`
   - Backend reviewer checks API contracts, persistence, migrations, query shape, indexes, pagination, auth/session handling, PII, security, privacy, queues, deployment impact, and operational risk.
   - Required when the PR touches backend, data, auth, analytics, integrations, queues, or deploy behavior.
   - May be explicitly skipped in a task comment when there is no backend/data/deployment surface.

4. `frontend_review`
   - Frontend reviewer checks UI/UX, responsiveness, visual fidelity, accessibility, design-system reuse, Sass/CSS structure, content editability, loading/empty/error states, browser console health, and direct route behavior.
   - Required when the PR touches UI, CSS, frontend JS, templates, content rendering, assets, SEO, or public pages.
   - May be explicitly skipped in a task comment when there is no frontend/user-visible surface.

5. `lead_review`
   - Primary team lead checks product fit, acceptance criteria, architecture, cross-cutting risk, prior reviewer findings, task/PR scope, deployment safety, and readiness for the human owner.
   - Always required before `user_review`.

6. `user_review`
   - Work is ready for the human owner to inspect, test, request changes, approve, merge, or deploy.

7. `needs_changes`
   - Any reviewer or the human owner can send the work back.
   - The task should include a comment with concrete requested changes.
   - Builder fixes the same branch/PR unless the reviewer asks for a split PR.

8. `done`
   - Work is merged/deployed or intentionally closed.

## Reviewer Outcome Rules

Reviewers should not silently fix builder work on the same branch unless the task explicitly asks for a reviewer-fix pass.

Expected reviewer outcomes:

- No issues: comment with reviewed scope, validation reviewed, residual risk, and next status.
- Issues found: move task to `needs_changes`, comment with findings, and tag the builder/next agent in plain language.
- Wrong scope: request a PR split or task split.
- Incomplete acceptance criteria: move to `needs_changes`.
- Missing review lane: move to the required review status, or document why the lane is not applicable.

## One PR Versus Multiple Tasks

Default rule: one PR should have one primary Mission Control task.

Related tasks may be referenced in comments, PR body, or as dependencies, but they should not all be moved to `user_review` unless the PR actually satisfies each task's acceptance criteria.

Allowed exceptions:

- A foundation PR intentionally covers a parent epic plus a small set of tightly related setup tasks.
- A mechanical PR updates shared config, standards, or deployment files that are intentionally shared by several tasks.
- A reviewer explicitly approves combining the work because splitting would create more risk than value.

When one PR intentionally covers multiple tasks:

- Choose one primary task.
- Add a comment to every linked task saying whether the PR completes it or only partially advances it.
- Keep incomplete related tasks in `ready`, `queued`, or `in_progress`, not `user_review`.
- The PR body should list the primary task and any related tasks.
- The lead reviewer must decide whether the combined PR should stay combined or be split.

## Human Owner Gate

The human owner should receive only tasks in `user_review`.

Before a task reaches `user_review`, Mission Control should show:

- branch link
- PR link
- builder notes
- validation results
- backend review result or explicit skip note
- frontend review result or explicit skip note
- primary lead review result
- known gaps and residual risk
