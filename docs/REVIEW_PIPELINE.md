# Review Pipeline

StudioOps uses staged review so the human owner only sees work after the builder and reviewer agents have done their jobs.

## Automation Steward

StudioOps has a bounded automation steward. It advances ticket ownership and review gates; it does not silently approve work, merge PRs, deploy, or replace real code review.

Run one pass manually with:

```bash
npm run automation-tick -- --project dollos --limit 10
```

or directly:

```bash
node src/mission-control-cli.js automation-tick --project dollos --limit 10
```

For cross-project monitoring, run:

```bash
npm run supervisor
```

or keep it running:

```bash
npm run supervisor -- --watch --interval 300
```

The automation tick:

- assigns `ready` or `queued` tasks to the builder by moving them to `in_progress`
- marks tasks `blocked` when dependencies are unfinished
- rechecks blocked tasks and returns them to the queue when dependencies are complete
- requires branch and PR links before reviewer routing
- routes each `builder_review` task through backend, frontend, accessibility, and lead review stages
- records owner handoff by moving fully reviewed tasks to `user_review`
- when Trust Leads is enabled, records QA handoff by moving lead-approved tasks to `qa_review` instead of per-task `user_review`

The supervisor reports the next action across projects. It is read-oriented and safe to keep running because it does not merge, deploy, or send external notifications.

Reviewers must record explicit outcomes:

```bash
node src/mission-control-cli.js review task_123 --stage backend --outcome approved --body "Reviewed API, query shape, and migration safety."
node src/mission-control-cli.js review task_123 --stage frontend --outcome skipped --body "No frontend surface in this PR."
node src/mission-control-cli.js review task_123 --stage accessibility --outcome approved --body "Reviewed contrast, keyboard behavior, semantics, labels, and screen-reader basics."
node src/mission-control-cli.js review task_123 --stage lead --outcome changes_requested --body "Split deploy config from UI changes."
```

Valid outcomes are `approved`, `skipped`, and `changes_requested`.

Each time a builder moves work into `builder_review`, StudioOps increments the task's review cycle. Review outcomes are scoped to that cycle, so an old approval cannot carry forward after a reviewer requests changes and the builder resubmits.

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

5. `accessibility_review`
   - Accessibility expert reviewer checks color contrast, readable typography, focus-visible states, keyboard tab order, semantic headings, link/button names, alt text, title text, form labels, ARIA use, and screen-reader basics.
   - Required before lead review when the PR touches UI, CSS, frontend JS, templates, content rendering, assets, SEO, or public pages.
   - Review must cover mobile, tablet, and desktop behavior unless the task explicitly scopes one breakpoint only.
   - May be explicitly skipped with a review outcome when there is no frontend/user-visible accessibility surface.

6. `lead_review`
   - Primary team lead checks product fit, acceptance criteria, architecture, cross-cutting risk, prior reviewer findings, task/PR scope, deployment safety, and readiness for the human owner.
   - Always required before `qa_review` or `user_review`.

7. `qa_review`
   - Optional Trust Leads gate for projects with `trustLeadApprovals: true` and a safe `integrationBranch`.
   - The QA integration worker prepares an isolated workspace for the project, merges lead-approved PR heads into the configured non-production integration branch, runs validation commands, and records conflicts or validation failures back on the task.
   - The registered project `repoPath` remains on the owner's active branch with its existing dirty or clean state; QA reports and task comments show the isolated workspace path used for the run.
   - This branch must not be `main`, `master`, `production`, or the project default branch.
   - The human owner should test the full QA bundle locally before approving production.
   - This is not production approval.

8. `user_review`
   - Work is ready for the human owner to inspect, test, request changes, approve, merge, or deploy.

9. `needs_changes`
   - Any reviewer or the human owner can send the work back.
   - The task should include a comment with concrete requested changes.
   - Builder fixes the same branch/PR unless the reviewer asks for a split PR.
   - At the configured review-cycle limit, unresolved non-lead findings route to lead review instead of another routine builder pass.

10. `done`
   - Work is merged/deployed or intentionally closed.

## Reviewer Outcome Rules

Reviewers should not silently change builder work. When they fix something directly, it must be intentional, small, and documented on the task and PR.

Reviewers may make small, low-risk fixes directly when doing so clearly saves time and does not change product scope. Examples:

- typo, copy, or comment corrections
- obvious broken link or metadata fixes
- tiny test/check fixes caused by the reviewed branch
- narrow CSS/layout cleanup with no design decision hidden inside it
- missing validation note, task comment, or PR body correction

Reviewer fixes must be recorded in the task comments and PR notes.

Reviewers should send work back to the builder when fixes are material, risky, ambiguous, or product-shaping. Examples:

- schema or migration changes
- auth, permissions, privacy, consent, PII, or payment behavior
- data-loss or deployment behavior
- broad refactors
- redesigns or new components
- changes that affect multiple tasks or widen PR scope
- anything that would need user/product judgment

Expected reviewer outcomes:

- No issues: record an `approved` review outcome with reviewed scope, validation reviewed, residual risk, and next status.
- No relevant surface: record a `skipped` review outcome with the reason the lane does not apply.
- Issues found: record a `changes_requested` review outcome with findings. StudioOps returns the task to `needs_changes` and assigns the builder unless the task has reached the configured review-cycle limit, in which case unresolved non-lead findings route to lead review.
- Wrong scope: request a PR split or task split.
- Incomplete acceptance criteria: record `changes_requested`.
- Missing review lane: let automation route to the required review status, or record a `skipped` outcome when the lane truly does not apply.
- Small reviewer fix made: commit the fix, comment with exactly what changed, then continue the review stage.

## Review Loop Limits

Default policy: StudioOps allows two routine builder review cycles.

The first material `changes_requested` outcome returns the task to `needs_changes` and assigns the builder to update the same branch/PR unless the reviewer asks for a split.

At the configured cycle limit, StudioOps stops normal builder-review ping-pong:

- Non-lead reviewers still record `changes_requested` for material unresolved issues, but StudioOps routes the task to `lead_review` instead of back to the builder.
- The primary lead reviewer makes the final automation decision for that cycle.
- The lead should fix small deterministic issues directly when practical, approve with residual risk documented when acceptable, or send the task to human owner review when it is unsafe or genuinely blocked.
- A lead `changes_requested` outcome at the cycle limit requests human owner review instead of starting another routine builder pass.

Projects can override the default with:

```json
"reviewPolicy": {
  "maxBuilderReviewCycles": 2,
  "reviewerMayFixSmallIssues": true,
  "leadOwnsFinalDecisionAtLimit": true,
  "trustLeadApprovals": false,
  "qaReviewerRole": "qa-reviewer",
  "integrationBranch": ""
}
```

## Trust Leads And QA Review

Trust Leads is a project-level option for reducing owner review fatigue.

When `reviewPolicy.trustLeadApprovals` is `true`, StudioOps trusts the primary lead's `approved` or `skipped` outcome after backend/frontend/accessibility review is complete. The task moves to `qa_review` instead of `user_review`, and the supervisor reports `notify_qa_review`.

Use `reviewPolicy.integrationBranch` to name the non-production branch or bundle target that should collect lead-approved work for local testing, for example `qa/event-horizons-web`.

Trust Leads does not allow production deploys. It only changes the handoff from "review every PR" to "review the QA bundle." Production release still requires explicit owner approval and the project's protected deployment workflow.

## One PR Versus Multiple Tasks

Default rule: one PR should have one primary StudioOps task.

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

The human owner should receive only tasks in `user_review` or `qa_review`.

`user_review` and `qa_review` are stop points. Automation should not merge to `main`, deploy production, or mark final completion. The human owner approves, requests changes, or merges.

Before a task reaches `user_review`, StudioOps should show:

- branch link
- PR link
- builder notes
- validation results
- backend review result or explicit skip note
- frontend review result or explicit skip note
- accessibility review result or explicit skip note
- primary lead review result
- known gaps and residual risk
