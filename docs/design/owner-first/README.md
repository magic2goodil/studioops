# Owner-first design source

Status: proposed design contract for `task_117`.

This directory is the durable source for owner-facing StudioOps UI work. It is a
visual-only artifact: the prototype uses synthetic records, does not call the
StudioOps API, and does not make any decision control functional. Builders must
consume the contract before implementing Portfolio, Work, Task, QA & Release,
Action Required, Operations, or Policies.

## Review order

1. [OWNER_FIRST_DESIGN_CONTRACT.md](OWNER_FIRST_DESIGN_CONTRACT.md) — route,
   responsive, state, accessibility, privacy, QA-packet, and audit-correction
   decisions.
2. [element-inventory.csv](element-inventory.csv) — region-level source,
   control, breakpoint, state, privacy, and owning-task classification.
3. [component-inventory.csv](component-inventory.csv) — reusable component
   anatomy, variants, states, interactions, accessibility, and data contracts.
4. [design-tokens.json](design-tokens.json) — exact visual token values.
5. [content-contract.json](content-contract.json) and
   [content-contract.sha256](content-contract.sha256) — checksum-protected
   product copy used by the prototype.
6. [prototype.html](prototype.html) — responsive, non-functional reference
   implementation. Serve the repository root and open:
   - `docs/design/owner-first/prototype.html#/action-required`
   - `docs/design/owner-first/prototype.html#/tasks/task_synthetic`
   - `docs/design/owner-first/prototype.html#/qa/candidates/candidate_synthetic`

The canonical brand asset is
`plugins/studioops/assets/studioops-logo.png`. The prototype references that
file directly. `studioops-icon.png` remains the app/marketplace asset and
`studioops-composer-icon.png` remains composer-only; neither belongs in this
owner shell.

## Evidence

Rendered references and their viewport metadata live in
`test/visual/owner-first/`. All visible names, IDs, branches, checks, and times
are synthetic. Run:

```bash
node --test test/visual/owner-first/design-contract.test.js
```

The test fails when canonical asset identity, product-copy bytes, routes, task
tabs, required states, viewport dimensions, or the route-first landmark
contract drift.

