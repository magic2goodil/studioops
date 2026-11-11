# StudioOps Default Standards

These standards are the default project-quality contract for StudioOps tasks.

Projects can reference all of them or only the files that apply. Builders must read the referenced standards before editing. Reviewers must treat material violations as review findings, not style preferences.

Default standards:

- `modular-architecture-and-scoped-validation.md`
- `engineering.md`
- `data.md`
- `design-system.md`
- `frontend.md`
- `styles.md`
- `javascript.md`
- `assets.md`
- `seo.md`
- `performance.md`
- `accessibility.md`
- `security-privacy.md`
- `testing.md`
- `release-deployment.md`
- `content.md`
- `review-checklist.md`

For visual work, the default expectation is mobile-first implementation with mobile, tablet, and desktop coverage. If a task is intentionally limited to one breakpoint, the task must say so explicitly.

- [Hosted release-candidate QA](hosted-release-candidate-qa.md): controlled HTTPS qualification, isolated data, candidate-bound acceptance and rollback before production.

## Portable Quality Contract

These requirements apply whether work is coordinated through StudioOps or directly in a project repository. A board status, dispatcher, daemon, or scheduled review lane is not evidence of quality and is not required to produce validation and independent review evidence. Record applicable standards, acceptance criteria, exact commit SHA, validation results, review findings, and known gaps in the PR or closeout packet.

Workflow routing conventions are separate from quality gates. Direct work still requires applicable specialist review, independent lead review, and the project's configured human, security, branch-protection, and release gates. This document does not disable existing automation or change configured permissions. Never label unverified work approved or deployed.
