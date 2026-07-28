# Codex Workflow

StudioOps is built around four roles.

## Intake

Capture the user's idea as a task. Preserve nuance, but shape the work into a buildable ticket:

- User story
- Problem or description
- Expected outcome
- Acceptance criteria
- Visual attachments for UI, design, or bug work
- Referenced standards
- Privacy and security notes when relevant

Use `docs/HANDOFF.md` as the standard for task intake and future-chat handoff.

## Planner

Split broad tasks into branches small enough for one builder thread. For mockups, split by screen, panel, state, or interaction and attach the relevant image crop or reference to each task.

For UI work, include mobile, tablet, and desktop expectations unless the user explicitly scopes one breakpoint only.

When a task touches repeated UI, plan the shared component/template first. Avoid creating page-specific copies of cards, buttons, badges, modals, or form controls.

When several builders could work in parallel, create a foundation/design-system epic first. That epic should define shared components, Sass tokens/mixins/classes, responsive rules, data/API contracts, and review gates before page builders begin.

For backend or persistence work, plan data ownership, query patterns, indexes, migrations, pagination, and privacy boundaries before implementation.

For consent-sensitive work, plan opt-in, opt-out/revocation, data minimization, retention, and user-facing consent copy before implementation.

## Builder

Use the generated builder prompt. The builder should:

1. Read the project context.
2. Read the referenced project standards.
3. Create a branch.
4. Implement the task.
5. Run validation.
6. Commit and push only when asked or when the project workflow allows it.
7. Link the feature branch and PR on the StudioOps task.
8. Add a task comment with changed files, validation results, known gaps, and the PR URL.

## Review Pipeline

Use `docs/REVIEW_PIPELINE.md` for the canonical staged review flow.

Default automated task flow:

1. The dispatcher turns `ready` or `queued` tasks into durable queued builder runs. The task stays `queued` until the runner claims the run, then moves to `in_progress`.
2. Builder implements, validates, links branch/PR, comments with changed files and validation, then moves work to `builder_review`.
3. Automation tick verifies branch/PR intake and routes to the next review lane.
4. Backend reviewer records `approved`, `skipped`, or `changes_requested`.
5. Frontend reviewer records `approved`, `skipped`, or `changes_requested`.
6. Accessibility reviewer records `approved`, `skipped`, or `changes_requested` before lead review for UI/frontend work.
7. Primary team lead reviewer records `approved` or `changes_requested`.
8. Automation tick moves fully reviewed work to `user_review`, or to `qa_review` when Trust Leads is enabled.
9. QA integration merges `qa_review` PR heads into a non-production QA branch and refreshes the local preview when configured.
10. Human owner reviews only after `user_review` or after the local QA preview is ready.
11. Owner QA pass moves the task to `approved_for_main`; owner QA fail moves it back to `needs_changes`.
12. The promotion worker merges `approved_for_main` task heads into the configured target branch after validation, using a non-force push.
13. Production deployment remains release/tag gated and separate from PR, QA-branch, or target-branch promotion.

Backend, frontend, and accessibility review can be explicitly skipped only when that lane has no relevant surface. The skip must be recorded as a review outcome with a reason.

Reviewers should fix small deterministic issues directly when project policy allows it, then document the fix and continue the review. Material issues use `changes_requested`. The default review policy allows two routine builder review cycles; after that, non-lead change requests route to the primary lead reviewer for the final automation decision instead of creating another builder-review loop.

Default PR rule: one PR should have one primary StudioOps task. Related tasks can be referenced, but they should not all be moved to `user_review` unless the PR satisfies each task's acceptance criteria.

Run the steward manually with:

```bash
npm run automation-tick -- --project dollos --limit 10
```

The scheduled steward LaunchAgent runs this periodically for every registered project. It routes dependencies/reviews but intentionally leaves `ready` and `queued` tasks available for the dispatcher:

```bash
npm run automation-tick -- --limit 50
```

Run the cross-project supervisor with:

```bash
npm run supervisor
```

or continuously:

```bash
npm run supervisor -- --watch --interval 300
```

Preview and create dispatcher runs with:

```bash
npm run dispatcher -- --plan
npm run dispatcher
```

Preview and execute queued builder/reviewer runs with:

```bash
npm run runner -- --plan
npm run runner
```

Preview and execute QA integration plus main promotion with:

```bash
npm run qa-integrate -- --plan
npm run qa-integrate
npm run promotion -- --plan
npm run promotion
```

Preview and send local owner/failure notifications with:

```bash
npm run notifier -- --plan
npm run notifier
```

Record review outcomes with:

```bash
node src/mission-control-cli.js review task_123 --stage backend --outcome approved --body "Reviewed API and persistence."
```

Record owner QA outcomes with:

```bash
node src/mission-control-cli.js qa-pass task_123 --body "Checked the local QA preview."
node src/mission-control-cli.js qa-fail task_123 --body "Mobile nav still overlaps."
```

The active local automation stack calls the steward, dispatcher, runner, and notifier every 10 seconds by default, with the read-only supervisor reporting every 15 seconds. The dispatcher creates durable builder, reviewer, and owner handoff runs, the runner executes queued Codex work, and the notifier alerts the human owner when review or failures need attention. The stack should not deploy production or merge PRs.

For macOS always-on setup, see [LOCAL_AUTOMATION.md](LOCAL_AUTOMATION.md).

## Reviewer

Use the generated domain reviewer prompts. The reviewer should:

1. Inspect the branch diff.
2. Check acceptance criteria.
3. Check referenced project standards.
4. Check reusable architecture instead of only visible output.
5. Check database query shape, indexes, migrations, and privacy boundaries when data changes.
6. Check consent and revocation behavior when sensitive data, personalization, notifications, location, or social presence are involved.
7. Verify validation.
8. Lead with findings.
9. Confirm the task has branch/PR context and builder notes.
10. Fix small deterministic issues directly when allowed and document those commits.
11. Record `approved`, `skipped`, or `changes_requested` with the review command or task detail form.

## Human Owner

The human owner is the final product and production-release authority. Tasks should reach the human owner only after backend/frontend/accessibility review has been completed or explicitly skipped and the primary team lead has approved the work into `user_review` or, when Trust Leads is enabled, `qa_review`.

When a task reaches `user_review`, StudioOps emits an `owner_review_requested` event and assigns the owner role. When Trust Leads routes a task to `qa_review`, StudioOps emits `qa_review_requested` and the supervisor reports `notify_qa_review`. External notifications should be built from those events rather than arbitrary status polling.

When local QA passes, StudioOps emits `qa_passed`, assigns the promotion worker, and queues target-branch promotion. When promotion succeeds, it emits `release_candidate_ready` for the project. That event means the target branch is ready for owner release-candidate review; it does not mean production has deployed.
