# Release And Deployment Standards

## Branch And Review Flow

Production changes should move through reviewed pull requests.

- Builders work on feature branches.
- Validation runs before the branch is marked review-ready.
- The user or reviewer approves the PR before merge.
- Reviewed PRs merge into a protected integration branch, normally `main` or `master`.
- Merging a PR, pushing a feature branch, or updating the protected integration branch must not deploy production by default. Those events should run validation, build artifacts, preview deploys, or staging deploys only.
- Production deployment should require an explicit release or tag created after the reviewed code lands on the protected integration branch.
- Release/tag deploy workflows must verify that the release commit is reachable from the protected integration branch before mutating production. If the commit is missing from that branch, the deploy must fail closed.
- When the project owner requires owner-only deploys, production deployment must also be gated to the configured owner GitHub actor or allowed deployer list.
- Direct pushes to integration or release branches should be avoided unless the project owner explicitly requests an emergency change.
- Local SSH deploys are break-glass only. If one is used, record why, reconcile the exact production change back into Git, and follow with a normal reviewed deployment path.

## Content Versus Code

Routine content changes should not require a production code deploy.

Use authenticated CMS/admin tools for copy, images, panel ordering, visibility, scheduling, and SEO metadata.

Use code deployments for new capabilities, new CMS block types, schema changes, API changes, security fixes, and reusable component changes.

## GitHub Actions

Projects should define CI before production deploy automation.

At minimum, CI should run:

- install/build steps
- syntax/type checks
- unit or integration tests when available
- lint/format checks when configured
- migrations or schema validation when relevant

Production deploy workflows should:

- run only after CI passes
- trigger real production changes only from explicit releases or tags, not from PR merges, integration branch pushes, feature branch pushes, or arbitrary local commands
- verify that the release or tag commit is reachable from the protected integration branch before deploying
- fail closed when the release/tag ref is missing, mutable in an unexpected way, or points at an unreviewed commit
- make manual `workflow_dispatch` runs dry-run or preview-only unless the owner explicitly approves a separate emergency production path
- fail closed unless the GitHub actor matches the configured deploy owner or allowed deployer list
- use GitHub Environments or equivalent protection when available, especially for production
- be deferred until development auth, admin mutation routes, legacy mutation/import routes, and other production-dangerous surfaces are gated or removed
- require repository secrets/variables rather than hard-coded credentials
- avoid printing secrets, tokens, connection strings, or private paths in logs
- provide smoke checks after deploy
- fail closed when required secrets are missing
- fail closed when schema or migration steps fail

Deployment automation should not be added just because it is easy to write YAML. A reviewer should send it back if the application being deployed is not production-safe yet.

## Non-Destructive Production Sync

Deployments must preserve production state by default.

- Do not use `rsync --delete`, broad `rm -rf`, or cleanup commands against production runtime directories.
- Do not offer a casual "delete stale production files" switch in workflow inputs.
- Exclude or protect environment files, databases, uploaded media, generated media, logs, PID files, virtual environments, backups, production-only state, and service-specific runtime assets.
- Guard remote paths before syncing. Empty paths, `/`, home directories, and unexpected parent directories must fail closed.
- Prefer immutable release directories plus a `current` symlink when the project is ready for atomic releases. Any cleanup must target old release directories only, never shared production state.
- Run an initial dry-run or preview for first-time reconciliation and copy any production-only code that must survive back into Git before a real deploy.

## Rollback And Audit

Deployment work should leave a clear audit trail:

- commit SHA
- PR link
- deployment time
- validation commands
- smoke check result
- known follow-up work

For content publishing, store version history so a bad CMS edit can be reverted without a code rollback.
