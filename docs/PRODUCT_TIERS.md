# StudioOps Product Tiers

StudioOps uses an open-core model: the complete single-developer local engineering loop is free, while hosted coordination and organization-level governance are paid services.

## Proposed Launch Packaging

| Capability | Community | Pro | Team |
| --- | --- | --- | --- |
| Proposed price | Free | $29/month | $99/month including 5 seats |
| Local StudioOps board | Yes | Yes | Yes |
| Codex plugin and structured intake | Yes | Yes | Yes |
| Project standards and staged reviews | Yes | Yes | Yes |
| Local builders, QA, and human release gate | Yes | Yes | Yes |
| Hosted sync and encrypted backup | — | Yes | Yes |
| Private reusable standards packs | — | Yes | Yes |
| Cross-project engineering insights | — | Yes | Yes |
| Managed always-on automation | — | Yes | Yes |
| Shared workspace and assignments | — | — | Yes |
| Role-based access and policy enforcement | — | — | Yes |
| Team audit history and analytics | — | — | Yes |

Prices are launch hypotheses, not hard-coded billing commitments. Validate willingness to pay before adding annual contracts or an enterprise tier.

## Technical Boundary

The public MIT repository owns:

- the local application and data model;
- the Codex plugin and local intake client;
- default standards, workflows, and human safety gates;
- stable interfaces that optional services can extend.

A separate proprietary StudioOps Cloud service should own:

- accounts, organizations, subscriptions, and billing;
- encrypted hosted sync and backups;
- private shared standards and policy distribution;
- team roles, audit history, analytics, and administration;
- the premium MCP/app tools exposed to Codex.

Do not implement paid access as a local environment flag. A user controls their own machine and can change local code. Premium value must live in the hosted service or in signed server-issued entitlements for downloadable assets. The local application reports Community access honestly through `/api/product`; it does not pretend to enforce a commercial license.

## Plugin Packaging

The free plugin always includes `run-studioops` and the local API client. Pro and Team customers later connect the same plugin to StudioOps Cloud, which adds premium MCP tools after authentication. This keeps one recognizable plugin while preserving a useful offline edition.

## Monetization Sequence

1. Release Community and collect installs, activated projects, retained weekly users, and completed QA handoffs.
2. Sell Pro first: hosted sync, backup, private standards packs, and cross-project reporting.
3. Add Team only after multiple people need to share one StudioOps workspace.
4. Use external checkout and account management until Codex provides a verified native payment channel suitable for this product.
