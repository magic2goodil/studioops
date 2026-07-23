# Engineering Standards

## Source Of Truth

- Edit source files, not generated output.
- Generated files must be created by the project build command.
- Do not hand-edit minified CSS, minified JavaScript, compiled bundles, or generated manifests.
- Keep changes scoped to the task and avoid unrelated refactors.

## Formatting

- Use the formatter and indentation configured by the project.
- If the project does not specify indentation, use two spaces for web/frontend code and four spaces for Python.
- Do not mix tabs and spaces in the same file.
- Do not introduce broad whitespace churn.

## Code Shape

- Prefer clear, boring code over clever code.
- Add abstractions only when they reduce real duplication or clarify ownership.
- Keep naming explicit enough that a human maintainer can find and modify behavior later.
- Avoid hidden global state.
- Avoid copy-paste implementations of the same behavior in multiple places.
- Avoid rushed "looks done" implementations that leave behind brittle structure, duplicated systems, slow queries, or unreviewed security/privacy decisions.

## Architecture Gate

For non-trivial work, identify the shared architecture before implementation:

- reusable UI components and templates
- Sass tokens, mixins, and component classes
- data model and ownership
- API contracts
- background jobs or queues
- caching and invalidation
- security/privacy boundaries

If several builders will work in parallel, the foundation task should define these boundaries first.

Broad apps, platforms, epics, and mockup-driven product work must use the StudioOps `systems-architect` gate before builders. Architecture must select the smallest system justified by the workload, record rejected alternatives, inventory canonical supplied assets, and flow into dependency-linked implementation tasks. Infrastructure such as caches, queues, fanout, or extra services requires a stated performance, consistency, durability, isolation, or operating reason.

## Functional Product Gate

- A mockup is not a complete implementation specification and is never an implicit request for a static replica.
- Unless a task explicitly says `visual-only`, every primary control must work or be explicitly disabled and labeled.
- Data-bearing surfaces must define their source of truth, persistence lifecycle, authorization boundary, bounded loading strategy, and loading/empty/error/retry states.
- Durable outcomes must survive refresh and process restart.
- Core behavior requires executable validation, not only render or snapshot checks.

## Production Change Gate

Prefer admin-editable content and layout configuration over code changes for routine copy, images, panel ordering, visibility, and SEO metadata.

Code changes should go through feature branches, validation, pull request review, a protected integration branch, and the project's configured release/tag deployment workflow. PR merges and integration branch pushes should not deploy production by default. Do not treat direct production edits or one-off server changes as the normal release path.

## Comments

- Comments should explain why a decision exists.
- Do not add comments that merely restate the code.
- Add a short note before non-obvious compatibility, performance, or security decisions.

## Task Closeout

Every builder closeout must record:

- changed files
- validation commands and results
- known gaps
- branch and PR link when available
- standards that were relevant to the change
