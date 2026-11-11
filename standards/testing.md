# Testing Standards

## Required Closeout

Every task must document:

- validation commands run
- result of each command
- manual checks performed
- known gaps

## UI Work

UI changes require:

- mobile verification
- tablet verification
- desktop verification
- direct route refresh check when routing is affected
- browser console check
- screenshot or visual inspection when practical

## Design-Match Work

When working from a mockup:

- identify which mockup screens or regions were implemented
- state how mobile, tablet, and desktop layouts map to the mockup
- note any intentional deviations
- verify the rest of the visible page was not left in a mismatched design state
- exercise every visible primary control or verify it is explicitly disabled and labeled
- verify data survives refresh/restart where the task promises persistence
- verify loading, empty, error, and retry behavior for each data-bearing surface
- run at least one end-to-end or integration smoke path for the core user outcome unless the task is explicitly `visual-only`

## Performance-Sensitive Work

Run Lighthouse, WebPageTest, browser performance tools, or a project-approved equivalent when work affects:

- landing pages
- initial app load
- image-heavy pages
- routing
- global CSS or JS bundles

## Backend Work

Backend tasks should include relevant unit, integration, migration, or smoke checks. If full testing is not practical, record the smallest meaningful validation performed and the remaining risk.

## Regression And Risk Selection

Bug fixes require a test that reproduces the original failure and passes with the fix. If automation is not practical, record precise reproduction steps, before/after evidence, the coverage gap, and the reviewer's rationale for the alternative.

Record a risk matrix mapping changed behavior to unit, integration/contract, browser/end-to-end, and manual checks. Cover authorization and tenant boundaries, persistence/migrations, failure and recovery paths, and critical user journeys where affected. Preserve all full-regression triggers in the modular architecture standard and project-specific safety gates; a risk matrix cannot waive them.

Use isolated deterministic fixtures, controlled time/randomness where relevant, semantic locators, and assertions that wait for observable conditions rather than arbitrary sleeps. Test browser engines separately from responsive viewport sizes: a mobile-width Chromium run is not WebKit or Firefox coverage. Document the project's supported browser/device matrix, selected checks, and explicit gaps.

## Failures, Retries, And Quarantine

Preserve original failure evidence and all retry outcomes. A retry-pass is flaky, not a clean first-pass result. Bound retries explicitly; retries must not hide deterministic regressions or substitute for diagnosis. Quarantining a test requires an owner, reason, review/expiry date, lost-coverage statement, and replacement evidence or explicit risk decision. Quarantine does not silently satisfy a required gate. Review unresolved failures independently before acceptance.

Bind validation records to the exact commit SHA and relevant environment/dependency contract. Include command, result, duration, retry/skip state, and evidence references. Separate checks that passed, failed, were skipped, and were never run.

References: [Playwright best practices](https://playwright.dev/docs/best-practices) and [retry semantics](https://playwright.dev/docs/test-retries). Equivalent tools may satisfy the same requirements.
