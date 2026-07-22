# Contributing

Codex Mission Control is an early open-source project. Contributions should preserve its local-first architecture, human release authority, durable workflow state, and explicit security boundaries.

## Before You Start

For a bug or feature request, open an issue that includes:

- the user or operator problem
- expected and observed behavior
- reproduction steps when applicable
- acceptance criteria
- screenshots or logs with secrets and private data removed
- platform, Node.js version, and relevant provider

Security reports must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## Development Setup

```bash
git clone https://github.com/magic2goodil/codex-mission-control.git
cd codex-mission-control
npm install
npm run check
npm run dev
```

Use Node.js `22.5` or newer. Keep local configuration and runtime state out of Git.

## Change Expectations

- Keep work scoped to one primary issue or Mission Control task per PR.
- Add or update tests for workflow, persistence, worker, security, or recovery changes.
- Preserve SQLite transactions, indexes, file permissions, and one authoritative source of state.
- Preserve isolated workspaces and bounded retry/review behavior.
- Do not add direct protected-branch merges or production deployment to automatic workers.
- Keep GitHub credentials and other secrets outside the repository and state database.
- Update public docs when commands, configuration, safety boundaries, or platform support change.
- For UI work, verify keyboard behavior, focus visibility, semantics, contrast, and mobile, tablet, and desktop layouts.

Read [AGENTS.md](AGENTS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CODEX_WORKFLOW.md](docs/CODEX_WORKFLOW.md), and the relevant files under [standards/](standards/) before making cross-cutting changes.

## Pull Requests

1. Create a focused branch.
2. Implement the smallest coherent change.
3. Run `npm run check`.
4. Inspect the complete diff for secrets, runtime data, generated files, and unrelated edits.
5. Explain what changed, why, user impact, validation, migration requirements, and known limitations.
6. Link the issue or Mission Control task.

PRs that change persistence, authentication, GitHub permissions, worker execution, self-update, QA integration, promotion, or release gates should include explicit failure-mode and rollback notes.

## Commit And Style Guidance

- Use concise imperative commit messages.
- Prefer existing modules and patterns over parallel abstractions.
- Keep comments focused on non-obvious constraints.
- Avoid unrelated formatting or metadata churn.
- Never commit local SQLite files, backups, heartbeats, task attachments, run output, credentials, or `mission-control.config.md`.

## License

By contributing, you agree that your contributions are licensed under the repository's [MIT License](LICENSE).
