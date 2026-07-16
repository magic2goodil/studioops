# Data And Backend Standards

## Data Model

- Define ownership for each table, collection, or persisted object.
- Name relationships clearly.
- Avoid storing duplicate derived data unless there is a clear performance or audit reason.
- When derived data is stored, document the source of truth and recalculation path.

## Query Shape

For tasks that add or change data access, describe:

- expected filters
- expected sort order
- expected pagination or limit
- expected joins or relation loading
- expected cardinality at small, medium, and large scale

Do not fetch whole tables or large datasets when the UI needs a summary, page, slice, or aggregate.

## Indexes

Add or verify indexes for common filters, joins, uniqueness checks, and sort patterns.

Examples:

- auth lookup by provider and provider user id
- user lookup by normalized email when applicable
- foreign keys used in joins
- status and approval queues
- geospatial location queries
- event start/end time queries
- organization/business ownership filters
- audit/event log task or project id filters

If an index is intentionally skipped, record why.

## Migrations

- Use the project's migration system.
- Keep migrations reversible when practical.
- Do not rewrite production history without explicit approval.
- Include seed/sample data only when the task calls for it, and keep it clearly fake unless the user requests real imported data.

## Performance Review

For non-trivial queries, use the database's inspection tools when practical:

- `EXPLAIN`
- query planner output
- slow query logs
- ORM query logging
- realistic local data volume

Reviewers should send work back when data access is unbounded, unindexed, N+1-prone, or likely to become slow as the project grows.

## Privacy

- Treat raw location, auth, payment, social graph, behavioral analytics, and inferred interest data as sensitive.
- Prefer aggregate analytics for business-facing reporting.
- Do not expose individual user identities in business analytics unless the feature explicitly requires it and the user consent model allows it.
