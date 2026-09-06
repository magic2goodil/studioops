# Hosted release candidate QA

Every production release of an applicable web, service or native project,
including StudioOps, requires a real hosted release candidate. Unknown
applicability blocks release. A non-deployable project needs an explicit reviewed
applicability decision through the release policy authority.

## One authority and exact candidate

Use the shared ReleaseQaPolicy v1, HostedRcEvidence v1 and ReleaseQualification
v1 contracts. Record a signed, project-specific policy through the authenticated
policy channel. Do not invent origins, runtime fingerprints, snapshot approvals,
device results or a generic approved policy to satisfy required fields.

Bind the full immutable source and integration SHA, candidate/manifest, artifact,
build provenance, ownership, dependencies, runtime and configuration schema.
Deploy that artifact to a controlled HTTPS origin with independently observed
deployed identity. Record material differences from production. Localhost,
dry-run sync, screenshots, old staging, a valid JSON digest or an actor label
cannot establish hosted qualification or producer trust.

Recommended initial project policy: evidence and snapshot age at most 24 hours,
origin observation at most five minutes, and an immediate identity/authority
recheck before activation. The shared policy validator and evaluator define
the actual bounds. A reviewed project policy may specify different supported
snapshot timings before evidence is generated; a force flag cannot waive them.

## Isolated and authorized data

Restore a transactionally consistent, authorized production-data snapshot into
isolated storage under the approved production-copy or masked-copy policy.
Keep the pristine snapshot and verify its identity, consistency point, restore
time, record preservation and retention/cleanup ownership. If real data access
is unavailable, report it; representative data requires its own approved policy
and cannot be presented as an authorized production copy.

Before boot, replace secrets, revoke copied sessions and isolate databases,
queues, caches, jobs and writable content/media. Verify process, filesystem,
network and credential separation when sharing a host. Disable production
outbound effects and quarantine copied pending work. Notifications, payments,
devices and providers must be disabled or verified sandbox-only. Keep snapshots,
customer rows, credentials and private media out of Git and evidence envelopes.
Use opaque authorization references and private digest-addressed artifacts.
Project identity rules, including Miss Dolly sender separation, remain additive.

## Regression, migration and device acceptance

Rehearse migrations on the isolated snapshot. Record migration-plan digest,
pre/post schema, result and verified restore/rollback outcome. Run the required
hosted regression, integration scenarios and normal authenticated application
flows against the same artifact and environment generation.

Complete required physical device and browser acceptance; identify simulated
coverage honestly. Native releases use a controlled distribution/build identity
and the matching hosted RC backend where applicable. Record both identities
and required native scenarios. A simulator alone cannot satisfy physical-device
acceptance. Supply the usable hosted URL/distribution before owner acceptance.

Obtain independent required domain and lead reviews, current owner decision and
revocation coordinates. The shared evaluator rejects missing, stale, mismatched,
failed or untrusted evidence. Reuse unchanged successful regression only while
all exact bindings remain valid; refresh short-lived hosted observations.

## Promotion and rollback

Promote the same tested revision and artifact through the governed release path.
Rebuilt artifacts and different merge SHAs need applicable new evidence. Before
production cutover, verify a current production backup, rollback readiness and
fresh hosted identity/qualification under the current policy and lease. Do not
stop workers, migrate active state or activate a runtime before its gate passes.

The dataTransferMode is none: never promote the staging database, test actions or
test history into production. Verify production identity and health after the
authorized cutover. Rollback must restore the exact prior verified runtime and
protected state under the governed recovery operation.

## Defaults and preserving adoption

New projects receive this standard. Existing projects can preview a bounded
adoption inventory before applying it per project. Adopting standards creates no
environment, snapshot, candidate, review, approval or release authority. Missing
staging is an actual prerequisite. Preserve custom standards and project policy;
do not overwrite user-owned files or replace signed hosted RC policy.

Historical/frozen manifests, reviews, approvals, completed task statuses and
audit history remain intact. A historic QA approval cannot satisfy a new release
under current policy. Adoption must not reopen, requeue or rebuild that work;
new feature work needs a separate trigger. Repeating unchanged adoption must
produce no mutation or duplicate event.

Standing production authorization and explicit greenlights remain separate from
qualification and do not waive this standard. Policy packaging, adoption,
hosted evidence collection and runtime activation are distinct responsibilities.
