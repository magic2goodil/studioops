# Hosted Release Candidate QA

This release standard applies to projects with a production deployment, including StudioOps itself. Local tests remain useful, but production qualification requires a real hosted candidate. It describes operator obligations; it does not imply a complete hosted-environment adapter is shipped.

## Required release sequence

1. Build an immutable candidate from reviewed Git source and record its full
   commit, artifact digest, dependencies and infrastructure/configuration version.
2. Deploy it to a controlled RC or staging environment reachable by the owner
   over HTTPS. Use the same operating/runtime/database setup as production;
   explicitly record version, topology, capacity and security differences.
3. Restore a consistent, authorized production-data snapshot into independently
   isolated storage. Keep a pristine verified snapshot, rehearse migrations, and
   verify preservation of existing records, identities, task history and media.
4. Run the applicable regression and integration QA against the hosted candidate.
   Record the tested origin, deployed identity, environment and data generation,
   commands, outcomes, retries, known differences and evidence digests.
5. Perform required owner/device acceptance on that same candidate using the
   normal authenticated application. Provide a usable URL before requesting it.
6. Obtain genuine required StudioOps reviews and owner acceptance. Promote the
   same tested artifact/revision through the project's protected release path,
   preserving production backups, migration safeguards and rollback controls.
7. Verify deployed identity and production health. Never promote the RC database
   or copy testing actions, generated progress or test history into production.

## Permission is separate from qualification

A standing deployment authorization or an explicit production greenlight does
not waive hosted RC QA. A local preview, dry-run sync, old staging revision,
synthetic screenshot or a prose approval is not hosted candidate evidence.
Missing, failed, stale or mismatched mandatory evidence holds promotion. Do not
infer an emergency exception from urgency, silence or a general greenlight.
Any separately authorized incident exception must name its exact omitted checks,
accepted risks, rollback and follow-up; do not solicit one as the routine path.

## Isolation and production data

An RC may share a production host only with reviewed process, filesystem,
network, credential and resource boundaries. Its database, writable media,
sessions, caches, queues and operational records must be separate. The staging
application must not be able to connect to or write production data/services.
Access controls must protect the real-data copy at least as strongly as its
sensitivity requires, including pre-login routes where they can mutate data.

Keep snapshots and user media out of Git, CI uploads and public artifacts. Use
aggregate verification evidence without exposing member data or secrets. Apply
project identity and content-preservation rules unchanged.

Quarantine copied provider credentials, push subscriptions and pending outbound
work before boot. Staging must not notify live customers, take payments, publish,
control live devices or spend API credits. Explicitly consented test integrations
must use scoped staging credentials/endpoints and remain identifiable in evidence.
Document isolated/sandboxed provider differences; never fake a successful flow.

## Refresh and applicability

Refresh from a new consistent snapshot into a new generation. Revoke old RC
sessions/test grants, serialize migration/deployment, preserve previous verified
state and change only RC-owned resources. Rebind QA after artifact, environment,
data generation, policy or required test coverage changes; reuse unchanged valid
evidence only where its exact bindings remain valid.

All applicable new projects must plan hosted RC access during setup. Existing
projects without it are explicitly not release-ready until provisioned. Native
projects use a controlled candidate distribution and the matching hosted RC
backend where applicable. Projects with no production deployment document that
fact rather than inventing a staging URL. Adopting this policy does not authorize
unrelated deployments or automatic rebuilding of historical completed work.

