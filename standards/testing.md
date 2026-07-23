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
