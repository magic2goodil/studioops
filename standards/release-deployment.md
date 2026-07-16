# Release And Deployment Standards

## Branch And Review Flow

Production changes should move through reviewed pull requests.

- Builders work on feature branches.
- Validation runs before the branch is marked review-ready.
- The user or reviewer approves the PR before merge.
- Production deployment is triggered by merge to the configured production branch, normally `main` or `master`.
- Direct pushes to production branches should be avoided unless the project owner explicitly requests an emergency change.

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
- use GitHub Environments or equivalent protection when available
- require repository secrets/variables rather than hard-coded credentials
- avoid printing secrets, tokens, connection strings, or private paths in logs
- provide smoke checks after deploy
- fail closed when required secrets are missing

## Rollback And Audit

Deployment work should leave a clear audit trail:

- commit SHA
- PR link
- deployment time
- validation commands
- smoke check result
- known follow-up work

For content publishing, store version history so a bad CMS edit can be reverted without a code rollback.
