# Modular Architecture and Impact-Scoped Validation Standard

## Purpose

Build software as maintainable bounded modules whose contracts, data ownership,
tests, and release impact can be understood independently. A modular monolith is
the default unless demonstrated operational needs justify distributed services.
Modularity must reduce coupling and validation waste without weakening safety,
security, privacy, compatibility, or release confidence.

## Architecture Requirements

Every non-trivial system or feature must identify:

- its owning component or bounded module;
- the public contracts, DTOs, events, and supported entry adapters it exposes;
- the data, migrations, jobs, assets, routes, and tests it owns;
- allowed dependency direction and prohibited cross-component imports;
- the shared-kernel or platform primitives it consumes;
- its rollback boundary and compatibility behavior while a boundary changes;
- its owned unit, contract, persistence, adapter/browser, and composition tests.

Business policy belongs to one authoritative component. UI, HTTP, worker,
provider, and platform adapters must call that authority through a public
contract instead of copying policy. Cross-component raw database access and
imports of another component's internals are prohibited unless an architecture
decision explicitly records the temporary exception and its removal task.

New work must extend an existing component or create one focused component. It
must not add unrelated behavior to a composition root, god service, catch-all
utility, oversized route file, shared mutable model, or undifferentiated test
suite. Large extractions use incremental compatibility facades and one
reviewable rollback point per branch rather than a big-bang rewrite.

## Ownership Manifest

Projects with more than one meaningful component must maintain a deterministic
ownership and dependency manifest. It maps source paths, routes, browser
modules, tables, migrations, jobs, events, workflows, deploy surfaces, and tests
to one owner or an explicitly shared classification. New or ambiguous paths fail
closed to shared/full validation until reviewed and classified.

The manifest and dependency graph are executable release inputs, not only prose.
Automated checks must reject prohibited imports, unowned release-sensitive
surfaces, dependency cycles, and contract-version mismatches.

## Test Structure

Each component owns layered tests:

- unit tests for pure policy and value behavior;
- contract tests for public provider/consumer behavior;
- persistence tests for owned queries, migrations, pagination, idempotency, and
  concurrency;
- adapter or browser tests for its real entry surfaces;
- a small composition smoke test for authorization, wiring, health, and failure
  containment.

Shared-kernel, public-contract, identity, authorization, consent, safety,
entitlement, schema, migration, event-version, composition-root, dependency,
workflow, and deployment changes require full-system regression. Multi-component
or unclassified changes also require full regression. Safety-critical device or
physical-output changes retain their dedicated stop, revoke, disconnect, and
failure-mode coverage regardless of component scope. Project-specific safety
gates always remain additive and can never be narrowed by the impact classifier.

## CI and Release Selection

Feature branches run one authoritative pull-request validation path. Do not run
equivalent push and pull-request copies for the same feature head. A deterministic
classifier selects component jobs from the base/head diff plus the ownership and
dependency manifests. Any uncertainty selects full regression.

One stable required aggregate check evaluates every selected job. A selected
failure or cancellation fails the aggregate; intentionally unselected components
are neutral and visible in evidence. Path-ignore rules alone are insufficient
because they do not express shared dependencies.

The protected integration branch runs the complete required regression once on
the exact immutable candidate SHA and emits machine-readable evidence containing
the source SHA, dependency/manifest digest, selected components, commands,
outcomes, durations, retries, skips, and artifact digests. Promotion and release
may reuse that attestation only while every bound digest and environment contract
matches. Missing, stale, cross-SHA, malformed, or unsuccessful evidence blocks
release.

Pre-deploy validation should verify exact-SHA provenance and run a concise
cross-system smoke rather than repeat an unchanged full suite. Production
deployment remains separately authorized and must preserve project-specific
backup, rollback, safety, and non-destructive release controls.

## Performance and Review Evidence

Architecture tasks establish measured baseline and target budgets for:

- component-only pull-request validation;
- full integration validation;
- pre-deploy evidence verification and smoke;
- total release time;
- duplicate workflow count.

Builders record the exact SHA, selected components, commands, outcomes, timings,
and known gaps. Reviewers reject changes that blur ownership, create dependency
cycles, duplicate policy, silently narrow required safety coverage, or grow a
monolith without an approved migration step.

## Exceptions

Microservices, additional databases, brokers, caches, and distributed state are
not implied by this standard. They require evidence that a modular monolith
cannot meet the isolation, scaling, deployment, or reliability need.

Emergency full-suite waivers require explicit owner approval with the missing
coverage, risk, rollback plan, and follow-up task. Time pressure, prior manual
testing, or a green unrelated suite is not a waiver.
