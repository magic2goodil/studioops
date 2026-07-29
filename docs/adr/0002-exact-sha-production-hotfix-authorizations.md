# ADR 0002: Exact-SHA Production Hotfix Authorizations

- Status: Accepted
- Date: 2026-07-29
- Decision owner: StudioOps implementation lead
- Governing task: `task_205`
- Parent: `task_203`

## Context

StudioOps normally routes reviewed changes through QA and the human release
gate. A production incident may justify a narrower owner-approved hotfix path,
but an exception expressed as free text, a moving branch, a reusable project
permission, or a workflow status would let retries or later commits widen what
the owner approved.

This decision defines only the fail-closed domain and persistence contract. It
does not add a mutation endpoint, GitHub write, merge, tag, deployment, queue,
service, cache, Redis dependency, production credential, or standing release
permission.

## Decision

### Canonical owner invocation

StudioOps recognizes exactly one of these normalized phrases:

```text
green-light <project-key> hotfix PR #<number> for production
green-light <project-key> hotfix commit <40-hex-sha> for production
```

Normalization trims outer whitespace, collapses internal whitespace, and
lowercases the phrase. The complete normalized string must match. Prefixes,
suffixes, abbreviations, fuzzy language, partial SHAs, zero PR numbers, and
mixed PR/commit subjects fail closed.

One invocation ID is idempotent and immutable. Reusing it with different text
is rejected. A terminal release record cannot be reactivated; another release
attempt requires a new explicit owner invocation.

### Exact candidate resolution

The project key must resolve uniquely to a project with a canonical GitHub
repository. The PR or commit must then resolve uniquely to one open, non-draft
pull request targeting the configured default branch. A commit invocation is
eligible only when the named commit is the PR head. The observation must
explicitly contain both PR state and a boolean draft state; absence is not
interpreted as open or non-draft. The observed PR URL, repository metadata, and
number must all resolve to the same canonical GitHub PR.

The PR must map uniquely to one StudioOps task in that project, and the task PR
URL must name the same canonical repository and PR number. The PR head must
equal the task's current full `reviewSubjectSha`. Missing, duplicate,
cross-repository, cross-project, mixed-task, draft, wrong-base, closed, and
stale mappings are ineligible.

### Review and task evidence

Eligibility calls the existing `candidateReviewEvidenceForTask` contract. Every
configured required review stage must be `approved` or explicitly `skipped` for
the current candidate cycle and exact SHA. Primary lead review remains required
and cannot be skipped.

The current lead approval must also carry this structured assessment:

```json
{
  "kind": "narrow_production_fix",
  "subjectSha": "<same full SHA>",
  "prohibitedChanges": {
    "mixedScope": false,
    "broadScope": false,
    "binaryOrUninspectable": false,
    "migrationChanges": false,
    "workflowChanges": false,
    "secretMaterial": false,
    "stateDeletion": false,
    "unrelatedFeatureChanges": false
  }
}
```

Every flag must be an explicit boolean. A true, absent, malformed, or
differently bound assessment rejects the exception. The task must be type
`bug` or `security` and carry the exact `production-hotfix` label (or the
equivalent explicit persisted marker).

### Project policy and deterministic scope

Project policy is disabled by default. Enabling requires an explicit
`hotfixPolicy` with positive `maxFiles` and `maxChangedLines` bounds, an explicit
`blockedPaths` array, and `requireCompleteTextPatches: true`.

Before classification, the PR observation must include an explicit total
changed-file count and an explicit complete-list attestation. The declared
count must equal the supplied list length, and paths must be present and unique.
Caller-supplied file overrides require their own count and completeness
attestation; completeness from another list cannot be reused.

Classification consumes file path, additions, deletions, status, and a text
patch carrying `patchComplete: true`. Missing paths or counts, unproven,
unavailable, or truncated patches, and binary content are uninspectable and
fail closed. The classifier rejects:

- file or changed-line limits and blocked paths;
- explicitly mixed scope;
- migration/schema paths and SQL migrations;
- GitHub or equivalent workflow changes;
- secret/credential paths or credential-shaped added values;
- file removal and deterministic destructive-state operations;
- files explicitly classified as unrelated feature work.

Only classification evidence is persisted. Source patches and raw repository
contents are never written to the state database.

### Durable release record

Every attempt, including malformed or ineligible requests, creates a
`studioops.hotfix-release.v1` audit record unless it repeats the same invocation
ID. The record contains:

- bounded requested phrase and normalized subject;
- non-sensitive owner ID and provider;
- project, PR, task, candidate SHA, review cycle, and review IDs;
- structured lead and scope evidence, including reconciled declared/list file
  counts and completeness;
- eligibility code and bounded redacted diagnostics;
- notification state and append-only notification history;
- append-only status transitions and an exact execution claim.

Eligible attempts begin `authorized`; all others begin `rejected`. The only
normal transitions are:

```text
authorized -> executing -> succeeded | failed | cancelled
authorized -> cancelled | expired
```

Integrity reconciliation may move an active record to `invalidated`. One exact
candidate can have only one active `authorized` or `executing` record.
Execution claims require an exact caller-supplied execution ID; retrying the
same claim is idempotent and a different claimant fails.

### SQLite integrity

`hotfix_releases` is a dedicated SQLite table. The principal operational index
is `(project_id, status, updated_at)`; candidate lookup and invocation uniqueness
are also indexed. The table participates in the same `BEGIN IMMEDIATE`
transactions, WAL durability, file permissions, online backup, migration
backup, restart reads, and integrity reconciliation as existing state.

Identity, requested authorization, owner, candidate, review, scope, policy, and
eligibility fields are immutable. Release and notification histories are
append-only. Generic full-state writes cannot delete a record, rewrite history,
change an execution claim, or reactivate a terminal record.

Diagnostics redact credential-bearing URLs, GitHub tokens, authorization and
secret assignments, and private-key blocks, then enforce item and length
bounds. A non-canonical phrase is replaced by a fixed audit marker while its
SHA-256 fingerprint preserves invocation idempotency without retaining
arbitrary text. Records exclude tokens, workflow credentials, raw production
logs, customer data, local workspaces, and source patches.

## Failure Modes

- Missing GitHub state/draft observations, inconsistent PR identities,
  incomplete file lists, count mismatches, or unproven patches reject
  authorization; no remote lookup or side effect is inferred.
- A later PR head makes the recorded authorization stale; it does not retarget
  the record.
- Missing or duplicated project/task relationships invalidate active authority.
- SQLite constraint or integrity failures roll back the entire attempt or
  transition.
- An execution crash leaves one exact claim visible for explicit recovery; a
  retry cannot claim a broader candidate.

## Rollback

The functional path remains dormant while project policy is disabled. Rolling
back callers therefore requires only leaving policies disabled. The table and
records must remain readable and backed up as audit history; rollback must not
drop, rewrite, or compact them. No production action needs reversal because
this slice performs none.

## Consequences

The hotfix exception is intentionally inconvenient when evidence is incomplete.
Owners must issue another exact phrase for another terminal attempt or changed
candidate. Future GitHub or deployment adapters may consume an `executing`
record, but they must preserve these identity, transaction, and transition
contracts and require a separate task and review.
