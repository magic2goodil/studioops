# ADR 0001: Immutable Candidate Trust Chain

- Status: Accepted
- Date: 2026-07-25
- Decision owner: StudioOps Ultra implementation lead
- Governing task: `task_74`
- Depends on: `task_70`

## Context

StudioOps currently records reviews without a repository subject SHA, assembles
local QA from moving task branches or pull-request heads, and later rebuilds a
release candidate from those moving refs. An approval can therefore apply to
different code than the code shown in local QA or proposed for release.

This is a stop-ship integrity defect. Workflow labels such as `qa_review`,
`approved_for_main`, and `release_candidate_ready` cannot be authoritative until
they refer to one immutable code identity.

## Decision

StudioOps will introduce an append-only candidate envelope with a canonical,
digest-locked manifest. Reviews, integration validation, preview verification,
owner QA, and promotion will all name the candidate ID, manifest digest, and
exact subject SHA that they authorize.

The candidate manifest is the authority. Tasks and QA bundles remain useful
workflow projections, but their mutable status is not release evidence.

### Candidate envelope

Candidates are persisted as a first-class `candidates` entity:

```json
{
  "id": "candidate_opaque",
  "projectId": "project_opaque",
  "qaBundleId": "qa_bundle_opaque",
  "status": "frozen",
  "manifest": {},
  "manifestDigest": "sha256:full-digest",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "invalidation": null,
  "qaDecision": null,
  "promotion": null
}
```

The envelope may gain append-only decision and operational records. The
`manifest`, `manifestDigest`, and candidate identity may never change. A digest
mismatch fails closed. An invalidated candidate can never become valid again;
new work requires a new candidate ID and digest.

### Canonical manifest

Schema `studioops.candidate-manifest.v1` contains only release-integrity data:

- schema version, candidate ID, and project ID;
- exact target/base branch and base SHA;
- source entries sorted by task ID, each with task ID, source ref, exact head
  SHA, candidate cycle, and required review records;
- review ID, stage, outcome, candidate cycle, exact subject SHA, and review
  timestamp;
- exact unique integration branch and integration SHA;
- validation/check evidence IDs, outcome, evidence digest, and the exact
  integration subject SHA;
- preview URL, health status, verification time, verified commit SHA, and the
  response header or JSON field that attested the running commit;
- atomic or explicitly authorized partial-assembly policy and exact membership.

The manifest excludes prompts, source contents, raw command output, credentials,
customer data, email addresses, and local workspace paths.

The digest is `sha256:` plus the SHA-256 of UTF-8 canonical JSON. Canonical JSON
recursively sorts object keys, preserves schema-defined array order, and rejects
unsupported or non-finite values. Source, review, and check arrays are sorted by
stable identity before canonicalization. The digest is recomputed and checked at
every decision or side-effect boundary.

### Review binding

Each source task's current review cycle is its `candidateCycle`: the cycle of
builder evidence from which that task may enter a candidate. Different tasks in
one candidate may have different candidate-cycle numbers.

Every specialist and lead review must include:

- a full Git object SHA in `subjectSha`;
- the exact current task `candidateCycle`;
- its immutable review ID, stage, role, outcome, and timestamp.

The first review in a cycle establishes the task's review subject. Every later
required review in that cycle must use the same SHA. A new builder submission
increments the cycle and clears the current review subject; old approvals remain
historical but cannot satisfy the new cycle. If a reviewer makes even a bounded
code change, the new SHA starts a new cycle and every affected downstream review
must run again.

QA planning rejects tasks whose required reviews are missing, incomplete, from a
different cycle, or bound to different SHAs.

### Candidate assembly

Candidate assembly uses an isolated workspace and starts from the exact fetched
target branch head. It does not reuse a cumulative shared QA branch.

For each source, StudioOps fetches the declared branch or pull-request head,
records the fetched SHA, and compares it with the review subject SHA before
merging. Any mismatch is source drift and stops assembly before push.

The default is atomic:

- every requested task must be review-current and merge successfully;
- all configured validation commands must pass;
- a healthy local preview must resolve to the integration SHA;
- only then may StudioOps freeze the candidate.

The integration commit may be placed on a unique staged remote branch before
preview verification when the preview mechanism requires a remote ref. That
branch has no approval semantics. Freeze occurs only after the preview checkout
is healthy at the exact integration SHA, after which the candidate branch is
immutable and any movement invalidates the candidate.

Partial assembly is permitted only when the caller explicitly supplies the
included task IDs, a non-sensitive opaque actor ID, and a bounded reason code.
Descriptive notes, names, email addresses, secrets, and local paths stay outside
the manifest. The manifest records requested, included, and excluded task IDs
plus the coded authorization. Excluded tasks remain outside the candidate and
cannot be described as QA-ready.

Integration validation becomes check evidence keyed to the integration SHA.
Manifest check labels are generic and raw validation commands/output stay
outside the manifest so local paths, credentials, and logs cannot enter release
authority. Task 78 may add remote CI/check-run evidence to the same schema;
absent evidence is never invented.

Task filters and retry windows cannot silently narrow an atomic candidate. If
any selected member is retry-delayed, the whole atomic assembly waits. Selecting
fewer than all eligible members requires the same explicit partial-candidate
authorization recorded in the manifest.

An HTTP success response is not preview identity. The configured preview health
endpoint must return the exact running commit in `X-StudioOps-Commit` or the
configured JSON identity field. StudioOps compares that attestation with the
preview checkout and integration SHA before freeze.

### Drift and invalidation

StudioOps verifies the target/base branch, candidate branch, and source refs:

1. while assembling the candidate;
2. immediately before owner QA is recorded;
3. immediately before promotion side effects.

The target branch must still equal the manifest base SHA, the observed candidate
branch must equal the manifest integration SHA, and every observed source ref
must equal its manifest head SHA. Drift records an append-only invalidation
reason and event, blocks the operation, and requires a new candidate. Promotion
always performs its own verification even when owner QA previously passed.

Task 75 will add actor authority and state-version compare-and-swap. Task 76 will
add fenced operation leases. Until those follow-up controls land, task 74 still
guarantees that no promotion side effect consumes a ref different from the
approved immutable integration commit.

### Owner QA binding

Owner QA is a candidate-level decision. A pass or failure request must include
and exactly match:

- candidate ID;
- manifest digest;
- integration SHA.

The candidate must be frozen, non-invalidated, and freshly drift-verified.
Passing the candidate updates all and only its manifest tasks. A multi-task
candidate cannot be partially passed. A single-task compatibility endpoint may
delegate to the candidate decision but cannot bypass these checks.

### Promotion binding

Promotion plans from candidates with a valid candidate-level QA pass. It does
not select arbitrary `approved_for_main` tasks.

The promotion worker:

1. verifies the manifest digest and all refs;
2. fetches the unique candidate branch;
3. verifies its head equals the manifest integration SHA;
4. verifies the target branch still equals the recorded base SHA and that the
   base is an ancestor of the integration SHA;
5. checks out the exact integration SHA without re-merging task refs;
6. reruns configured promotion validation;
7. pushes a unique, non-force release-candidate branch;
8. opens a pull request listing exactly the manifest task membership and digest.

Any failure blocks the whole candidate. Promotion cannot mark an intersecting QA
bundle ready after only a subset succeeds.

### Persistence and migration

SQLite gains a `candidates` table and indexes for project, status, and digest.
The existing transactional write path persists candidates atomically with tasks,
reviews, events, and QA bundles.

Candidate rows are append-only history. Generic mutation and full-state import
cannot delete an existing candidate, reuse its ID with another manifest, replace
its digest, or rewrite a recorded invalidation, QA decision, or promotion.

Existing QA bundles and task-level QA passes do not contain enough evidence to
be trusted. Migration marks them `legacy_untrusted`; it does not synthesize a
manifest or approval. They remain visible for history but are ineligible for new
owner QA or promotion until rebuilt as a candidate.

No live database is edited manually. Schema creation and reconciliation run
through the tested application migration path.

## Invariants

1. A candidate's canonical manifest and digest never change.
2. Every required review names the current cycle and exact source head SHA.
3. Every check names the integration SHA, and the running preview attests that
   same SHA.
4. Candidate assembly is atomic unless explicit partial authorization is
   recorded before assembly.
5. A changed source or candidate ref invalidates all downstream authorization.
6. Owner QA names the candidate ID, digest, and integration SHA.
7. Promotion consumes the exact approved integration SHA and never reconstructs
   it from moving task refs.
8. Legacy status labels alone confer no release authority.
9. No candidate manifest contains secrets, PII, source contents, raw logs, or
   unnecessary local paths.
10. No task 74 workflow deploys production or activates a StudioOps runtime.

## Required tests

- Canonical digest is stable across object insertion order and changes for every
  security-relevant field.
- Manifest mutation, digest mismatch, malformed SHA, and duplicate source or
  review identity fail closed.
- Reviews reject missing SHA, malformed SHA, wrong cycle, and mixed subjects.
- QA rejects source drift before merge or push.
- One failed task prevents an atomic candidate; authorized partial assembly
  contains only the explicit subset and records its authorization.
- Frozen manifest contains exact base, source, review, check, integration, and
  preview evidence.
- Owner QA rejects wrong candidate ID, digest, integration SHA, invalidated
  candidates, and partial decisions.
- Promotion fails on source or candidate-branch drift and never fetches or
  re-merges task refs after candidate freeze.
- Release-candidate content and pull-request copy list exactly the manifest
  members and digest.
- Legacy QA state is visible but ineligible for owner QA and promotion.
- Candidate persistence, restart, migration, and rollback behavior pass using
  synthetic repositories and the hermetic test control plane.

## Consequences

This intentionally breaks workflows that relied on status labels, branch names,
or old QA bundles as sufficient authority. It adds explicit evidence plumbing
and more Git verification, but removes the ambiguity that has repeatedly left
the owner unsure which code is in local QA and whether it matches a release.

Task 74 does not solve actor authentication, fenced leases, hosted redundancy,
notification delivery, or the complete owner QA packet. Tasks 75, 76, 78, and 80
build those controls on this immutable identity.

## Ultra lead review gate

Passed. An independent Ultra review approved exact implementation commit
`0598df340dab83c1822f7db1e6fcdb6c58f12158` against the task 74 acceptance
criteria and the audit's required handoff contracts. The SHA-bound validation
artifact `task_74-0598df3-validation.log` records 152/152 hermetic tests,
`git diff --check`, and a clean worktree; its SHA-256 is
`7e82a1b40052cd3cbce64fbd0ea213c111b519d5e38e68f8c662101873ce9e6a`.

Residual risks are explicit dependencies, not accepted gaps in this decision:

- task 75 must authenticate and authorize actors and close state-version races;
- task 76 must fence concurrent remote operations and make side effects
  idempotent;
- task 78 must supply protected-branch and remote CI provenance;
- task 80 must enforce the complete owner-facing QA packet and durable delivery.

This ADR authorizes task 74 implementation only. It does not authorize runtime
activation or unattended use against valuable repositories.

## Rollback

Before runtime activation, rollback is a normal code revert. After a future
approved activation, rollback reverts the candidate feature while retaining the
new candidates table as inert historical data. Never downgrade by converting
candidate approvals back into task-status-only approvals.
