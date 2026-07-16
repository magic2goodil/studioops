# Codex Workflow

Mission Control is built around four roles.

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
7. Link the feature branch and PR on the Mission Control task.
8. Add a task comment with changed files, validation results, known gaps, and the PR URL.

## Reviewer

Use the generated reviewer prompt. The reviewer should:

1. Inspect the branch diff.
2. Check acceptance criteria.
3. Check referenced project standards.
4. Check reusable architecture instead of only visible output.
5. Check database query shape, indexes, migrations, and privacy boundaries when data changes.
6. Check consent and revocation behavior when sensitive data, personalization, notifications, location, or social presence are involved.
7. Verify validation.
8. Lead with findings.
9. Confirm the task has branch/PR context and builder notes.
10. Mark the task `needs_changes` or `user_review`.

## Human Owner

The human owner is the final product and merge authority.
