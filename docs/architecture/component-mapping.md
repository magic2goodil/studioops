# Repository component maps

Each repository owns `docs/architecture/components.json`. Its project key and
repository identity must match the dispatched project. Candidate maps are read
from the exact Git commit, not the mutable working copy. Digests cover normalized
canonical map JSON; they are not raw file hashes or hashes of all source code.

## Context and edit authority

The dispatcher records an initial `impactScopePlan`. Its editable paths remain
fixed across retries and redispatches. The runner may refresh classification and
supporting context, but it cannot enlarge this edit authority. At handoff,
StudioOps recomputes the actual Git diff, including deletions, file type changes,
and both sides of renames, and compares it against the original or explicitly
remapped scope. Candidate classification separately chooses validation impact.

Declared component dependencies supply supporting contracts and paths for
selective reading. Those paths are not editable. Tests owned by transitive
dependents are included in the validation plan. This is a declared component
graph, not a compiler-derived symbol/import graph. Read the named contracts as
needed; a dependency does not require reading every supporting file.

## Explicit remapping

## Guarded operator candidate adoption

`adopt-candidate TASK_ID --request-file FILE --preview` verifies a real committed
candidate without writes. Omit `--preview` only in an owner terminal. Commit
mode rejects managed-worker and noninteractive invocations, binds confirmation
to the printed request digest, and derives its audit principal from the OS owner
of the control-plane database. No HTTP adoption route or caller actor flag exists.
`adoption-status TASK_ID` inspects current version, scope and intake.

Request v1 accepts only `schemaVersion`, `expectedStateVersion`, `projectId`,
`repository`, `candidate` (`baseSha`, `commitSha`, `treeSha`, `branch`), `mapDigest`,
sorted unique literal `reviewedFiles`, a substantive `reason`, and optional
`prerequisites`. JSON is data; executable confirmation/conflict and persistence
ports remain outside it. Unknown fields, actor/provenance/run/cycle injection,
globs, escaping paths, stale versions, moved refs, wrong trees/origins/maps and
incomplete ownership fail closed. Requests are capped at64KiB,256paths and32direct
prerequisite dispositions. Git output retains its2MiB bound. Version1 rejects
renames, deletions, symlinks and gitlinks; use the normal governed workflow for
those changes. It does not fetch missing objects or follow mutable branch refs.

Initial authoring scope freezes the exact verified changed paths. Existing frozen
or legacy scopes remain authoritative and unchanged; wider work requires the
separate explicit CAS remap. The transaction re-verifies immutable evidence on
optimistic replay and checks live coordination leases at its final SQL fence.
Optional direct prerequisite closures require recorded immutable Git/map and
hashed local verification receipts, matching versions, completed dependencies and
no unresolved incident. Closure is an administrative disposition, never QA or
feature acceptance, and is atomic with intake. Arbitrary prose is insufficient.

One stale failure pointer may be reconciled at this same boundary: its exact
durable ancestor must be superseded by the immediate current generation of the
same task/fingerprint/reason after changed evidence and a successful allowlisted
cheap probe. The successor must have zero paid attempts, one passed cheap probe,
no repair/backoff/open state, and no other unresolved current task fault. The
native runner's minimal failure pointer is recognized by its exact schema and
task/reason/resource/incident binding; generation and evidence come from the
canonical stored ancestor. Supplied conflicting fields or unknown shapes fail.

An active row can also be admission bookkeeping after a verified repair. Only a
repaired provider-unavailable generation with one native paid admission may be
corroborated by the task's retained failure/run references and an unambiguous
persisted native terminal run that ended in the blocked output failure. Exact
task/project/provider/action/candidate/repository/map bindings, replayed repair
and admission history, terminal claim, raw failure and probe result are required.
The overwritten prior provider claim is not reconstructed. Unknown, overlapping
or later runs, another active group, new proof, exhaustion, backoff or open state
reject recovery. Known native CLI cancellations with no start or paid claim and
an exhausted queued-attempt reason may precede that run only when their actual
creation/completion interval ended before the linked start and admission. No
missing start is inferred. The entire run inventory is digest-bound. This narrow
classification does not reset an admission counter.

Preparation reads the authoritative ledger and supporting run rows; the final
SQL transaction rechecks all normalized lineage and run digests alongside task
CAS and live ownership fences. Supporting runs cannot change in the adoption
proposal. Ledger-only or run-only races fail
closed even without a task-version change. The exact old pointer and recovery
digests are retained in an immutable disposition while the prerequisite closes
and the reviewed child is adopted, with no intermediate queue. Generic writers
cannot create or rewrite that disposition. Historical incidents and counters
are never reset, and a successful ledger probe alone does not close a task.

Successful intake creates a real source-bound review cycle and a truthful
`source=operator` receipt, without a builder run or credit/cost fiction. Existing
failures and attempt counters remain. Exact replay is read-only; unchanged failed
material cannot gain a retry by changing labels, source metadata or provenance.
Unfinished dependencies retain the candidate at review intake with a visible
waiting reason. Workflow, supervisor and dispatcher reject held or stale actions;
no intervening builder queue is exposed. Normal independent review, hosted RC and
human project release gates still apply. Native handoff also accepts a candidate
from its persisted same-task/branch workspace or typed managed bare artifact;
caller cwd never grants authority. Workspace path/identity metadata can change
only through the existing runner preparation producer and private writer. Cold
JSON imports retain path history as untrusted until that producer revalidates it.
A controller may import exact objects into an origin-tracking ref without moving
a preserved checked-out worktree. Repository identity, commit/tree/base, branch,
committed map and actual scoped diff are checked again at persistence ingress. Generic status/transition/persistence
adapters cannot mint adoption authority or submit absent-scope handoffs.

Stable `adoption_*` reasons identify the failed binding: refresh state for stale
CAS, obtain missing immutable objects through the trusted repository workflow,
apply a reviewed scope remap for wider files, or repair the recorded incident.
Do not blindly retry or reset history. Rollback must retain additive intake
receipts and hold their tasks if the older scheduler cannot honor waiting states.


A legitimate expansion has its own operation, before builder handoff:

```sh
node src/mission-control-cli.js update-task task_123 \
  --remap-plan-digest 'sha256:<scope digest from worker context packet>' \
  --remap-work-areas 'src/catalog.js,src/catalog-adapter.js' \
  --remap-reason 'The catalog change requires updating the adapter contract as well.'
```

The supplied digest must match the current scope. The reason must explain the
expansion; the repository map must uniquely classify all requested paths. The
operation records the old/new scopes and hashes in a durable event and comment.
It does not submit the candidate or approve review, QA, merge, or deployment.
The worker should refresh its task/context after remapping. Ordinary edits to
task work areas cannot silently grant additional edit authority.

For a new file or component, update the repository map on the feature branch and
commit it, then provide `--remap-sha <full candidate SHA>` to resolve the new map.
The map and requested code remain subject to normal review and full validation
where required. Record remaps while the task is ready, queued, in progress,
needs changes, or blocked, separately from status/candidate changes.

## Drift and validation

`coverageRoots` opts a repository into deterministic ownership coverage checks.
StudioOps covers `src` and `test`: each tracked file must have exactly one owner.
Working-copy checks also include untracked non-ignored files. Candidate checks
use only that commit's tree. New unmapped files and overlapping path patterns
report drift, require discovery/remapping, and force aggregate validation. The
repository's map test requires complete ownership, so such drift also fails the
aggregate check until repaired. Coverage does not prove that declared contracts
or dependency edges still match the implementation; those need engineering
review when affected.

QA computes the immutable base/candidate diff and loads both committed maps.
Scoped execution requires identical normalized map digests, an exact candidate
binding, one known component, complete declared coverage, no sensitive/shared/
unknown impact, and commands present in the protected base map. The executor
runs the selected component tests plus declared dependent tests in the existing
validation sandbox. StudioOps component commands invoke `scripts/run-tests.js`
with every owned `*.test.js`, including nested test files, so the required
temporary control plane is established before tests access state. A regression
check rejects missing owned tests or commands that bypass this bootstrap.
Candidate map commands alone are not execution authority.
Any failed condition uses configured aggregate commands. Changing a map or
release-sensitive surface therefore requires the broader path. This selection
and its Git/map/diff bindings accompany validation evidence. Supporting or
dependent context never relaxes repository identity or release approval checks.

Worker context packets prioritize named paths. Their search guidance does not
intercept every shell command or guarantee a hard token budget; the runner's
separate output and failure containment controls still apply.

## Derived code context

The runner also attaches an advisory structural retrieval packet after resolving
its execution scope. `repository-context-index.js` reads immutable Git blobs;
`repository-context-extractor.js` uses the bundled Tree-sitter WASM grammars for
JavaScript, TypeScript/TSX, Python and PHP. Named declarations and static import
hints are derived from syntax. Dynamic imports and unsupported languages are
reported as unresolved or path-only; this is not a complete compiler call graph.

The authored map remains the authority for component ownership, allowed edits,
declared dependencies, review and validation. Derived imports describe observed
code relationships and do not replace architectural dependency policy. Retrieval
results are suggestions for reading, including related locations outside edit
scope. They do not grant remapping, test-skipping, merge or release authority.

The local disposable cache is partitioned by project/repository and immutable
source version, and binds the extractor, map and exclusion policy. It stores
paths, identifiers, line numbers and blob IDs, not source bodies or task text.
Secret, dependency, generated and user-data paths are excluded; additional
exclusions can be committed in `.studioops-contextignore`. Partial coverage,
unsupported syntax, limits and unavailable indexes remain visible. A stale,
invalid or unavailable index leaves the existing map and QA behavior intact.

`task-context-retrieval.js` ranks exact paths and identifiers, identifier-token
overlap and bounded static relationships. `repository-context-packet.js` verifies
the repository, commit and map bindings before formatting at most 10,000 UTF-8
bytes of advice. This is an output byte bound, not a claim about tokenizer size
or the total worker prompt. The existing authority packet is preserved.

Run the same read-only retrieval directly:

```sh
npm run context -- --repo /path/to/repo --project studioops \
  --repository https://github.com/magic2goodil/studioops \
  --commit FULL_40_CHARACTER_SHA --query 'retry queued worker'
```

Omit `--commit` to resolve the local HEAD once. The selected commit must contain
a valid map for this command's policy-bound packet. `--work-area` supplies a
specific task path. The command changes no task, source file or Git reference.
Set `STUDIOOPS_CONTEXT_RETRIEVAL=0` to disable worker attachment for rollback;
normal component mapping and validation remain active. No embedding provider is
enabled by default. The reproducible experiment and limits are documented in
`repository-context-evaluation.md`.

## Hosted RC authority v1 (task_1010)

`qa-release` owns `hosted-rc-evidence.js` and `release-qualification.js` and
all normalization, canonical SHA-256 digests and eligibility policy. These two
modules import only Node crypto and one another; they perform no filesystem,
provider, database, config-default, worker, promotion or runtime operations.
`runtime-self-update -> qa-release` is the public consumer dependency.
`workflow-state` implements an injected executable persistence port: its store
functions accept a `createReleaseQualificationAuthority(resolveCurrentContext)`
instance supplied by an approved composition adapter. State never imports the
release component, preserving the component DAG and single policy owner.

The exported normalizers are the executable DTO schemas; unknown fields are
rejected, including metadata/pass/force/off/hash additions. Envelopes are at most
64 KiB. IDs are bounded opaque references, never personal identity or secrets.
Arrays normalize in deterministic lexical order; object keys sort canonically.
Private logs/screenshots/snapshots remain outside SQLite by digest. No raw source,
customer records, credentials, URLs containing credentials/query/fragment, or
unrestricted evidence bodies belong in these DTOs. Snapshot access and retention
are represented by opaque authorization IDs, policy digests and expiry; the
collection adapter owns actual TTL deletion and access enforcement.

`ReleaseQaPolicy v1` binds reviewed applicability, HTTPS origins, explicitly
approved private origins, native distribution IDs, authorized snapshot source
and modes, required normal-auth/device scenarios, independent review lanes,
runtime/environment equivalence and age budgets. `HostedRcEvidence v1` binds
project/repository/candidate/source/protected-integration/manifest/ownership,
artifact/provenance/regression digests, environment/runtime identity, consistent
snapshot/restore/authorization/retention, rehearsal/schema controls, isolated
secrets/sessions/writes/jobs/outbound/providers/notifications/payments/devices,
physical vs simulated acceptance, matching native backend, and producer/times.
The v1 normalizer carries explicit runtime differences and migration evidence
by digest; the trusted observer must independently verify these claims.

Approved adapters supply the clock, current exact bindings, policy and key
allowlists, approved producer/observer/owner IDs, production origins, current
snapshot/deployment/migration/native coordinates, and live review/revocation and
owner packet/decision coordinates in `context`. Never derive this context or
key configuration from the evidence request. `hostedRcSigningBytes(kind,payload)`
provides domain-separated bytes for Ed25519 proofs `{keyId,signature}`. Producer,
policy, current observation and owner decision each require a valid proof from
the configured channel. The independent observer must use a different ID and
key from the producer, verify current served identity and actual isolation/data/
device evidence, classify resolved network addresses, and reject redirect or
production endpoint substitution. Pure code cannot perform that observation or
authenticate transport by itself. No production private keys enter the pure
API. C owns authenticated transport and observation adapters; D owns fresh
preactivation checks. General approvals and caller-supplied booleans/hashes have
no qualification authority.

`evaluateReleaseQaApplicability` returns `applicable:null` for unknown or
unverified classification. Reviewed non-deployable projects require signed
policy and matching trusted project classification/reviewer coordinates; they
receive an applicability result, never a fabricated hosted receipt. Applicable
projects always use `assertHostedRcEvidence` and
`evaluateReleaseQualification`/`assertReleaseQualification`.

`releaseQualificationInputs` canonically binds evidence/policy/frozen candidate,
per-task source SHA and exact-cycle review coordinates and revocation generation before the owner
packet/decision is created. The decision observation binds this inputs digest
and the approved packet/decision digests. `ReleaseQualification v1` is a separate
immutable receipt binding all those coordinates plus fresh observation and
expiry. Packet construction must never include the final receipt digest.

Public store contracts (input and executable authority are separate arguments):

- `recordReleaseQaPolicy({projectId,expectedVersion,policy,proof}, authority)`
- `appendHostedRcEvidence({projectId,candidateId,expectedVersion,evidence,proof}, authority)`
- `recordReleaseQualification({projectId,candidateId,expectedVersion,evidenceDigest}, authority)`
- `invalidateReleaseQualification({projectId,candidateId,expectedVersion,payload,proof}, authority)`;
  signed revocation payload carries id/project/candidate/next generation, actor,
  observedAt and one of owner_revoked/policy_changed/review_changed/
  evidence_revoked/environment_changed.
- `getReleaseQaPolicy(projectId)`, `getHostedRcEvidence(projectId,candidateId,digest)`,
  `listHostedRcEvidence(projectId,candidateId,{offset,limit})` (1–50 summaries),
  `getCurrentReleaseQualification(projectId,candidateId)` (display/query only).

`resolveCurrentContext(coordinates)` is synchronous and called under the
transaction for writes. Coordinates include current project, candidate,
protected hosted record and exact persisted source-review rows. Trusted context.reviewSubjects contains each
manifest source taskId/headSha/candidateCycle as taskId/subjectSha/cycle; distinct
source SHAs and cycles in a composed candidate remain distinct. Approved IO
adapters prepare authenticated observations outside the write transaction, then
resolve current authority using these rows. `qualify` checks each signed review
coordinate against its stored row digest, stage, SHA, cycle and non-revocation;
store also checks actual persisted owner packet/decision and active policy.
Hosted metadata retains only hashes of review rows, never copies of review prose
or source excerpts.
External adapters must not import/use the internal SQLite mutation port or raw
SQL. Missing authority is a hard error; no default permissive adapter exists.

Persistence adds `projects.hostedRc` policy history and `candidates.hostedRc`
evidence/receipt/audit history to existing JSON aggregates. Absence means version
zero with no authority. Old manifests, local preview/check evidence, task states
and historical approvals retain their original meaning. No table, database,
queue or cache is added. Point reads use existing primary keys; candidate writes
read only state-meta, project, candidate and bounded exact source reviews (at
most four SELECTs). BEGIN IMMEDIATE plus expectedVersion fences writes; rejected
or duplicate operations do not advance aggregate versions. Retry duplicates
with the current version; stale versions fail. Histories are append-only through
the facade, bounded to 128 entries per list and 16 MiB total. Capacity exhaustion
blocks (`history_limit`); retention must preserve active audit references before
a future reviewed archival extension. General aggregate writers cannot inject,
replace or delete hosted authority. Candidate receipts do not reopen tasks.
Policy changes invalidate current release authority via active digest/generation,
while preserving history. Revocation is generation-bound and idempotent.

Reads return historical digests but no current receipt after expiry, changed
policy/review records, candidate invalidation or revocation. These display APIs
are not production activation authority: the runtime must call the pure
qualification evaluator with a fresh observation and recheck under its existing
lease immediately before mutation. Restoring old code must retain additive
history and hold production while the new gate is unavailable; rollback cannot
turn local or legacy evidence into hosted approval.

The manifest reserves `hosted-rc-adoption.test.js` to scheduling-dispatch,
`hosted-rc-adapters.test.js` to qa-release and `hosted-rc-runtime.test.js` to
runtime-self-update. Those builders add their commands when delivering the tests;
A's executable commands contain only present tests. The bundled standard belongs
to scheduling-dispatch and the installer to runtime-self-update. Existing CLI/
rendering/deploy adapters remain sibling work; this authority prerequisite does
not claim hosted collection, UI, runtime enforcement or production activation.
Full regression is mandatory for these public-contract/schema/authorization/
manifest/deployment and multi-component changes. New tests cover canonical and
signed valid/invalid evidence, receipt hash separation, persistence/restart/CAS,
legacy unqualified state, revocation and manifest ownership/pure import guards.
