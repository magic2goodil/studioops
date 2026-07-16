# Performance Standards

## Default Budgets

Unless the project defines stricter budgets, target:

- First Contentful Paint under 1.8 seconds
- Largest Contentful Paint under 2.5 seconds
- Cumulative Layout Shift under 0.1
- Interaction to Next Paint under 200ms

Budgets are targets, not excuses to avoid measurement. If a task affects initial load or rendering, record the validation method used.

## Loading

- Defer non-critical JavaScript.
- Split large bundles when practical.
- Load below-the-fold sections as they approach the viewport.
- Reserve space for async content to prevent layout shift.
- Use pagination, virtualized lists, or API slicing for large datasets.

## Images

- Lazy-load non-critical images.
- Preload the LCP image when appropriate.
- Never ship oversized images for their display dimensions.

## Data Fetching

- Do not fetch entire datasets when the UI needs only a page, slice, or summary.
- Cache stable data where appropriate.
- Avoid duplicate requests for the same resource.

## Review Requirement

Reviewers should flag changes that feel slow, block rendering, cause avoidable layout shift, or load too much upfront.

