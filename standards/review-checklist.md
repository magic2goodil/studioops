# Review Checklist

Fail or send back the task when a material issue exists:

- Source files were skipped and compiled CSS or JS was hand-edited.
- Sass/CSS is hacky, unstructured, or not maintainable by a human.
- Repeated UI was copied instead of built as a reusable component/template.
- A component exists in Storybook or a component catalog but was not updated when changed.
- A visual change only updates one breakpoint while leaving tablet or desktop broken.
- A redesign updates one component but leaves the rest of the visible page in the old design without explicit scope.
- Public content relies entirely on client-side JavaScript for meaningful HTML.
- Generated navigation or dropdown links point to missing routes or missing fragment IDs.
- API-driven UI updates only hidden/non-visible markup while product copy claims that data is active.
- Routine marketing/page content was hard-coded when the project requires authenticated CMS editing.
- Page sections, panels, or repeated content blocks cannot be reordered or managed through the agreed content model.
- SEO metadata, canonical URLs, or structured data are missing for SEO-sensitive pages.
- Images lack dimensions, aspect ratios, or appropriate lazy-loading behavior.
- Async content causes avoidable layout shift.
- Large datasets or page sections load eagerly without need.
- Database queries are unbounded, unindexed, N+1-prone, or missing pagination.
- Fresh database bootstrap fails or is not verified after base schema changes.
- Migrations, indexes, or data ownership are unclear for persistence changes.
- Production deploy automation runs bootstrap SQL as a migration or can ignore SQL failures.
- API failures are invisible to users.
- There are browser console errors.
- The implementation ignores referenced mockups or visual attachments.
- The PR lacks validation notes.
- The PR is linked to several tasks without a clear primary task and per-task complete/partial notes.
- Deployment or production-impacting work bypasses the feature branch, PR, validation, and configured CI/CD flow.
- Production deploy automation is added before development auth/admin/legacy mutation surfaces are gated or removed.
- PR merges, feature-branch pushes, or protected integration-branch pushes deploy production by default.
- Release/tag deploy automation does not verify that the release commit is reachable from the protected integration branch.
- Production deploy automation can mutate production from manual dispatch without a dry-run/preview default and an explicit emergency approval path.
- Production deploy automation lacks protected integration-branch, deploy-owner actor, allowed-deployer, or GitHub Environment gates.
- Production deploy automation can broadly delete or sync-clean production runtime files, uploaded media, generated assets, databases, env files, logs, virtualenvs, backups, or production-only state.
- Production deployment docs encourage local SSH deploys as the normal path instead of GitHub Actions with audit history.
- Sensitive data is logged, exposed, stored casually, or collected without explicit consent requirements.
- Consent-sensitive features lack opt-in, opt-out/revocation, retention, or data-minimization behavior.
- The work violates project-specific standards.

Do not use review as an endless polish loop:

- Fix small deterministic issues directly when the project review policy allows it.
- Document reviewer-made commits in the task and PR.
- Reserve `changes_requested` for material, risky, ambiguous, security/privacy-sensitive, or product-shaping issues.
- After the configured routine review-cycle limit, route unresolved non-lead findings to lead review for a final automation decision instead of sending the task back to the builder again.

For UI work, reviewers should specifically ask:

- Was mobile verified?
- Was tablet verified?
- Was desktop verified?
- Was the direct URL/refresh path verified?
- Was the full visible page considered, not just the smallest component?
- Did an accessibility reviewer approve the work or explicitly skip it because there is no user-visible accessibility surface?
- Are contrast, readable typography, visible focus, keyboard tab order, semantic headings, link/button names, alt text, title text, form labels, ARIA use, and screen-reader basics acceptable?

For backend/data work, reviewers should specifically ask:

- Are likely queries indexed?
- Is pagination or result limiting in place?
- Is the data model maintainable?
- Are sensitive fields minimized and protected?

For consent-sensitive work, reviewers should specifically ask:

- Did the user explicitly opt in?
- Can the user turn it off later?
- Is the consent copy specific enough to understand?
- Is business-facing analytics aggregated unless identity is truly required?
