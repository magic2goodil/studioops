# Bounded prepaid admission

StudioOps can use existing prepaid credits for authorized work when included
usage is exhausted. This is an explicit opt-in, separate from the existing
degraded-telemetry fallback policy. StudioOps does not purchase credits or
enable an unlimited commitment.

The canonical configuration is `defaults.creditPolicy.prepaid` (or the existing
top-level `creditPolicy` override). It defaults to `{ "enabled": false }`.
Enabling it requires all three fields:

| Field | Required value |
| --- | --- |
| `enabled` | Literal `true` |
| `maxEstimatedCredits` | Finite positive number for the cumulative shared allowance |
| `maxConcurrentRuns` | Positive integer for outstanding prepaid work |

Missing, null, boolean, string or invalid bounds do not authorize prepaid work.
The outer credit policy must also be enabled. Model routing, task budgets,
project permissions, failure containment and normal review gates still apply.

## Evidence and reservations

Prepaid admission requires a fresh recognized Codex snapshot, finite positive
available balance, explicit non-unlimited credits, and explicit
`spendControlReached: false`. Unknown spend-control status, provider or workspace
denials, unknown bucket identity, stale evidence and future timestamps do not
qualify. Included usage permission may be false or unknown when prepaid funding
is independently verified. Positive balance alone is insufficient.

All tiers reserve one account-wide pool. A run must fit its configured tier
estimate within both the cumulative allowance and the observed credit balance
minus `reserveCredits`. Eligible queued work reserves that same pool and the
concurrency limit. Claim ordering excludes the candidate's own queued reservation
and later queued work, while existing running ownership always counts.

Planning is read-only. Only a successful native queued-to-running claim commits
estimated usage to `meta.prepaidCreditLedger`, in the same atomic state
transaction as the run. The ledger has a version, cumulative estimated credits,
monotonic claim count and last claim timestamp. Each claim carries its sequence
and bounded admission evidence. Raw account identifiers and provider payloads
are not persisted in that evidence.

## No automatic replenishment

Completed, cancelled-after-start, failed and archived runs remain charged to the
cumulative allowance. Refreshing telemetry, changing tiers, restarting workers
or disabling and re-enabling prepaid admission cannot reset that history.
Generic state updates cannot initialize, lower, delete or replace the ledger;
an absent ledger initializes only with the first qualified native claim. A
malformed ledger fails closed. These conservative estimates can count usage
already reflected in a newer balance, so the effective allowance may be smaller
than the provider's reported balance.

These limits control estimated admission, **not a guaranteed provider bill cap**.
Actual model usage may differ from the estimate. StudioOps never labels these
values as measured charges and does not reconcile refunds or replenish windows.

Previously queued prepaid work is rechecked at claim time. Disabled admission,
revoked opt-in, stale evidence or a transport-only fallback cannot launch it as
prepaid. Fresh included capacity may fund that unstarted run under normal rules.

An exact, current, zero-attempt credit-admission hold can resume on newer
qualified prepaid evidence without advancing its execution epoch. This includes
`prior_exhaustion_unverified` holds caused by a historical global marker. Actual
provider failures, ambiguous task circuits and exhausted paid-attempt lineage
remain governed by their existing recovery requirements. No provider call is
used to prove prepaid admission.

That retirement requires native snapshot evidence that no unresolved durable
failure incident exists, followed by an independent incident check inside the
writer transaction. Serialized incident lists cannot grant that permission.
Running prepaid claim evidence cannot be stripped, retyped or moved to another
task through a generic state update.

Global recovery records retain prepaid funding provenance. Missing or stale
telemetry and revoked prepaid authorization cannot turn that recovery into
ordinary degraded-telemetry fallback, including for newly queued work. Only
strictly newer verified included capacity retires this restriction; tied
included evidence remains subject to prepaid accounting.
