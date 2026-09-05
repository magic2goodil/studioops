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
