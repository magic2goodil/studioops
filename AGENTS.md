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
- Builder work should link the feature branch and PR on the task, then leave a task comment with changed files, validation, known gaps, and the PR URL.
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
