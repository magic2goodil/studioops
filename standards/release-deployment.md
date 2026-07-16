# Release And Deployment Standards

## Branch And Review Flow

Production changes should move through reviewed pull requests.

- Builders work on feature branches.
- Validation runs before the branch is marked review-ready.
- The user or reviewer approves the PR before merge.
- Production deployment is triggered by merge to the configured production branch, normally `main` or `master`.
- When the project owner requires owner-only deploys, production deployment must be gated to the configured owner GitHub actor and protected production branch.
- Direct pushes to production branches should be avoided unless the project owner explicitly requests an emergency change.
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
- run only from the configured production branch
- trigger real production changes only from protected production branch pushes or merges, not from arbitrary local commands
- make manual `workflow_dispatch` runs dry-run or preview-only unless the owner explicitly approves a separate emergency path
- fail closed unless the GitHub actor matches the configured deploy owner or allowed deployer list
- be deferred until development auth, admin mutation routes, legacy mutation/import routes, and other production-dangerous surfaces are gated or removed
- use GitHub Environments or equivalent protection when available
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
