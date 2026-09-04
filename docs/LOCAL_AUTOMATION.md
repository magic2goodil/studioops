# Local Automation

StudioOps can run manually from the CLI or continuously through macOS user LaunchAgents.

The always-on stack includes:

- `web`: serves the task board and API
- `steward`: advances workflow state and review routing every 10 seconds by default
- `supervisor`: reports next actions across projects
- `dispatcher`: creates durable builder, reviewer, and owner-handoff runs
- `runner`: launches queued builder/reviewer runs with a Codex provider
- `qa-integration`: merges `qa_review` PR heads into opted-in non-production integration branches after validation
- `promotion`: assembles owner-QA-passed work into a validated release-candidate PR
- `notifier`: sends local owner-review and failure notifications
- `self-update`: fetches `origin/main`, fast-forwards StudioOps itself when safe, and restarts worker LaunchAgents
- `watchdog`: reconciles stranded task state, watches worker heartbeats, and restarts stale workers

## Install

```bash
npm install
npm run setup
npm run install-agents
```

The installer publishes a stable runtime under `~/.codex/studioops/runtime`, creates a clean `main` checkout under `~/.codex/studioops/source` for self-updates, and stores persistent config, SQLite state, and logs under `~/.codex/studioops/control-plane`. Run, QA, and promotion workspaces also live under `~/.codex/studioops`. This keeps operational writes out of `Documents`, Desktop, iCloud Drive, and other synchronized folders. Re-running the installer atomically updates the runtime and restarts all workers. The installer prefers an available supported even-numbered Node.js LTS runtime; `STUDIOOPS_NODE_PATH` and the legacy `MISSION_CONTROL_NODE_PATH` remain explicit overrides.

Existing installations from the project rename are migrated from the retired `codex-mission-control` source remote to `studioops` only when the checkout is clean, on `main`, and fast-forwardable. The installer refuses dirty, divergent, detached, or unrelated source checkouts instead of rewriting them.

Repeated equivalent QA outcomes are fingerprinted so an unchanged failure or ready state does not append another task comment on every worker pass. Failed QA integration attempts use a bounded retry window instead of immediately repeating expensive repository and preview work; an explicit forced run bypasses that window. Before the state-integrity migration changes the database, StudioOps writes an owner-only SQLite backup under `data/backups/`. Excess legacy QA comments and QA events then move to the local SQLite `operational_archive` table; recent active history remains on each task, and human comments and reviews are never compacted.

## Self-Healing Invariants

Long-running workers write atomic heartbeats under `data/heartbeats/` every 30 seconds, including while a Codex run is active. The watchdog runs independently every two minutes and:

- restarts a worker whose heartbeat is missing or stale
- wakes the runner when queued durable runs have waited too long
- wakes the dispatcher when dispatchable tasks have waited too long
- records the worker data root and disk availability with every heartbeat
- opens one durable disk-pressure incident and blocks new claims while either the database or run-workspace volume is below its byte or percentage threshold
- calls the runner's public retention adapter once per pass; it never duplicates path eligibility or deletes an unverified workspace itself
- requires two healthy post-cleanup disk observations, a complete SQLite read plus atomic incident transition, and fresh root-matching `idle` or `busy` heartbeats before recovery
- attempts at most one root-verified restart per unhealthy managed worker during an incident, and never restarts workers while disk pressure remains
- records bounded cleanup totals, exclusion reasons, database and worker evidence, recovery duration, and operator remediation without appending duplicate events on every pass
- refuses to restart a LaunchAgent whose installed working root does not match the watchdog's current StudioOps root
- returns a non-epic `in_progress` task to the queue when it has no queued or running durable run
- automatically releases transient SDK, process, timeout, and orphan-run blockers after a bounded recovery delay

Configuration blockers such as missing or invalid GitHub App credentials remain owner-gated. Tracking epics are exempt from the active-run invariant because their status represents child-task progress rather than direct builder execution.

Builder and reviewer attempts are bounded. When the configured attempt budget and one bounded transient recovery are exhausted, StudioOps opens a task circuit and stops dispatching model runs for it. Inspect the preserved output, repair or verify the underlying blocker, then reset that one circuit:

```bash
studioops circuit-reset --task task_123 --expected-opened-at <circuit-opened-at> --reason "Verified credentials and repository access"
```

Incident-wide pauses are explicit and auditable:

```bash
studioops automation-pause --reason "Database recovery"
studioops automation-resume --reason "Backup, integrity, and worker health verified"
```

An operator pause suppresses new builder and reviewer claims while still allowing owner-review notifications to reach the persistent inbox.
Disk recovery never clears an operator pause, task or project circuit, configuration blocker, review gate, or owner approval. If no workspace is safely eligible, inspect the incident's bounded exclusion reasons and free local disk space; do not delete source checkouts, active workspaces, or candidate artifacts manually. A `degraded` or `awaiting_health` incident remains fail-closed until a later watchdog pass proves every recovery condition.

## Tiered model routing

StudioOps can route ordinary implementation, specialist review, high-risk work,
and explicitly mechanical tasks to different Codex models. Model selection is
recorded on each run so the cost and quality decision remains auditable.

```json
{
  "defaults": {
    "executionPolicy": {
      "model": "gpt-5.6-luna",
      "reasoningEffort": "medium",
      "mechanicalLabels": ["spark-ok"],
      "escalationLabels": ["ultra-review"],
      "modelTiers": {
        "mechanical": {
          "model": "gpt-5.3-codex-spark",
          "reasoningEffort": "high"
        },
        "economy": {
          "model": "gpt-5.6-luna",
          "reasoningEffort": "medium"
        },
        "balanced": {
          "model": "gpt-5.6-terra",
          "reasoningEffort": "high"
        },
        "critical": {
          "model": "gpt-5.6-sol",
          "reasoningEffort": "high"
        },
        "frontier": {
          "model": "gpt-5.6-sol",
          "reasoningEffort": "ultra"
        }
      },
      "tierRouting": {
        "defaultTier": "economy",
        "mechanicalTier": "mechanical",
        "architectTier": "critical",
        "leadTier": "critical",
        "complexTier": "critical",
        "routineReviewTier": "balanced",
        "escalationTier": "frontier"
      },
      "roles": {
        "backend-reviewer": {
          "tier": "balanced"
        },
        "frontend-reviewer": {
          "tier": "balanced"
        },
        "accessibility-reviewer": {
          "tier": "balanced"
        }
      }
    }
  }
}
```

Tier names are stable policy concepts; model IDs and reasoning effort are
replaceable local configuration. Architecture, lead, and complex work take
precedence over cheaper routes.
Lead review of an exact, classified documentation-only or routine formatting
configuration diff uses the configurable `routineReviewTier` (balanced by
default). Security, privacy, authentication, migration, deployment, release,
production, infrastructure, and data-loss semantics remain critical regardless
of file type.
Complex work includes security, privacy, consent, authentication, database,
migration, deployment, release, production, infrastructure, and data-loss
terms. Spark is never selected implicitly: a low-risk builder task must carry
one of the configured `mechanicalLabels`. An explicit `escalationLabels` match
selects the configured frontier tier, including `ultra` effort when supported.

## Credit-aware admission

StudioOps can check the authenticated Codex account before creating a model
run. The controller calls the local Codex App Server
`account/rateLimits/read` method, caches the sanitized result, and retains only
quota headroom, reset timing, limit state, and available credit balance fields.
It does not store account identity or authentication tokens.

```json
{
  "defaults": {
    "creditPolicy": {
      "enabled": true,
      "refreshIntervalMs": 300000,
      "snapshotMaxAgeMs": 900000,
      "probeTimeoutMs": 20000,
      "reserveCredits": 5,
      "tierBudgets": {
        "mechanical": {
          "estimatedCredits": 2,
          "minRemainingPercent": 2
        },
        "economy": {
          "estimatedCredits": 8,
          "minRemainingPercent": 5
        },
        "balanced": {
          "estimatedCredits": 15,
          "minRemainingPercent": 5
        },
        "critical": {
          "estimatedCredits": 30,
          "minRemainingPercent": 5
        },
        "frontier": {
          "estimatedCredits": 40,
          "minRemainingPercent": 35
        }
      },
      "degradedTelemetryFallback": {
        "policyVersion": 1,
        "explicitFailClosedLabels": ["credit-fail-closed"],
        "rules": {
          "mechanical": {
            "ruleId": "mechanical-bounded-v1",
            "mode": "bounded",
            "maxConcurrentRuns": 2,
            "maxAttempts": 1,
            "estimatedTokensPerRun": 40000,
            "maxInFlightEstimatedTokens": 80000
          },
          "economy": {
            "ruleId": "economy-bounded-v1",
            "mode": "bounded",
            "maxConcurrentRuns": 2,
            "maxAttempts": 1,
            "estimatedTokensPerRun": 80000,
            "maxInFlightEstimatedTokens": 160000
          },
          "balanced": {
            "ruleId": "balanced-bounded-v1",
            "mode": "bounded",
            "maxConcurrentRuns": 1,
            "maxAttempts": 1,
            "estimatedTokensPerRun": 100000,
            "maxInFlightEstimatedTokens": 100000
          },
          "critical": {
            "ruleId": "critical-bounded-v1",
            "mode": "bounded",
            "maxConcurrentRuns": 1,
            "maxAttempts": 1,
            "estimatedTokensPerRun": 120000,
            "maxInFlightEstimatedTokens": 120000
          },
          "frontier": {
            "ruleId": "frontier-fail-closed-v1",
            "mode": "fail_closed"
          }
        }
      }
    }
  }
}
```

The credit estimates and token reservations are admission envelopes, not
promises of exact spend or provider-side token truncation. Actual
credit use depends on model, context, cached input, output, reasoning, and
tools. When Codex exposes a purchased-credit balance, StudioOps requires the
tier estimate plus the configured reserve. When the account is operating on
included quota, StudioOps uses remaining quota percentage instead.

The controller never lowers a task below its quality-required tier. A failed
critical or frontier admission opens one owner-visible task circuit before any
model launch. A credit-only circuit is automatically closed when a later fresh
snapshot admits the same required tier and the captured workflow and candidate
identity are unchanged; the restored task becomes eligible on the following
dispatcher sweep. Cost-budget circuits and any circuit whose identity drifted
still require explicit operator review. If the account
snapshot is unavailable or stale, the versioned
`degradedTelemetryFallback.rules` contract is keyed only by stable execution
risk tier. Frontier work fails closed by default. Ordinary critical work uses
one concurrent run, one attempt, a 120,000 estimated-token reservation per
run, and a 120,000 aggregate in-flight reservation. A match in
`explicitFailClosedLabels` also fails closed regardless of tier. Missing,
unclassified, malformed, zero, non-finite, or unsupported rules fail closed;
the policy never switches on a model ID.

For one compatibility release, existing `failClosedTiers` and `tierBudgets`
configuration remains readable and is normalized into the version 1 contract.
New configuration should use `degradedTelemetryFallback`; `tierBudgets`
continues to carry the quota and purchased-credit estimates used when a fresh
snapshot is available. Removing the additive fallback configuration and
admission evidence fields rolls this slice back. Existing SQLite JSON payloads
remain readable, and no schema or index change is required.

Admission evaluation records only a sanitized, deterministic evidence DTO:
evaluation time; policy version and rule ID; risk tier; explicit-label match;
snapshot status, allowlisted source, observation time, age, and generic reason; decision
code and mode; and all four bounded limits. Account identity, authentication
tokens, raw provider payloads, and secrets are not part of this contract.

Live dispatch gives a fail-closed critical or frontier run one bounded recovery
only when its first sanitized snapshot is unknown. Before opening the SQLite
mutation transaction, the dispatcher performs one direct uncached
`account/rateLimits/read` probe using `probeTimeoutMs`, then reassesses the same
required quality tier. A usable result proceeds normally; a second unknown opens
one owner-visible circuit. A real quota, rate-limit, purchased-credit balance,
or reserve failure from either snapshot is never retried, never launches a model,
and never downgrades quality. Plan mode performs no recovery probe. Credit logs
and test fixtures contain only sanitized limit fields, never tokens, account
identity, raw account payloads, or secrets.

By default, the web UI is only available on the local machine:

```text
http://127.0.0.1:4317
```

For phone or local-network testing:

```bash
MISSION_CONTROL_HOST=0.0.0.0 MISSION_CONTROL_PORT=4317 npm run install-agents
```

Only use `0.0.0.0` on a trusted local network.

Run maintenance commands from the same working root used during `npm run install-agents`. A watchdog started from another checkout will report the root mismatch and leave the installed workers untouched. `STUDIOOPS_WORKING_ROOT`, `STUDIOOPS_DATA_DIR`, and the legacy `MISSION_CONTROL_*` aliases can select the intended persistent instance explicitly.

### Migrating a legacy or cloud-synchronized installation

Do not relocate an active database by copying its live SQLite files. The installer reads the existing web LaunchAgent to find its installed working root and refuses to stop any agents while a builder or reviewer run is active. Once idle, it stops all StudioOps writers together and uses SQLite's backup API to create:

- `~/.codex/studioops/control-plane/data/backups/pre-local-root-migration-*.sqlite3`, mode `0600`
- `~/.codex/studioops/control-plane/data/mission-control.sqlite3`, mode `0600`

It also copies configuration and attachments under `~/.codex/studioops/control-plane`, migrates GitHub App credentials to `~/.codex/studioops/credentials/github-apps`, applies owner-only directory permissions, and then installs the new agent definitions. If migration or installation fails, the previous LaunchAgent files are restored and restarted. The destination working root must not exist; the installer will not merge into it or overwrite an existing database.

If an unused destination root already exists, first verify no LaunchAgent or process references it, inspect its contents, and rename it to a timestamped sibling backup such as `control-plane.pre-migration-YYYYMMDD-HHMMSS`. Do not delete it during the cutover. Run the installer only after `~/.codex/studioops/control-plane` is absent, and retain the renamed copy until post-migration verification is complete.

For an installation without an existing web LaunchAgent, select the legacy working root explicitly:

```bash
STUDIOOPS_MIGRATE_FROM=/absolute/path/to/legacy-control-plane npm run install-agents
```

After installation, verify `npm run status-agents`, `http://127.0.0.1:4317/api/health`, project/task counts, migrated attachments, GitHub App access, and queued-run recovery before retiring the old root. The old source remains unchanged as a rollback copy.

## Status

```bash
npm run status-agents
node src/mission-control-cli.js runs
npm run runner -- --plan
npm run dispatcher -- --plan
npm run qa-integrate -- --plan
node src/mission-control-techops.js --plan
npm run promotion -- --plan
npm run self-update -- --plan
```

The runner defaults to `codex-cli`. To test SDK-backed Codex threads:

```bash
npm run runner -- --provider codex-sdk --limit 1
```

To make LaunchAgent runs use the SDK provider, set `defaults.runner.provider` to `codex-sdk` in `studioops.config.md`, then restart the local agents.

For an ad hoc shell or service override, set:

```bash
MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk
```

Runner workspace preparation is serialized per source repository with a local
Git lock under `~/.codex/studioops/locks/git` by default. This prevents
parallel runner processes from fetching, pruning, or creating worktrees against
the same checkout at the same time, which can otherwise surface as Git
pack/object errors such as `Resource deadlock avoided`. Tune the lock with:

- `MISSION_CONTROL_GIT_LOCK_ROOT`
- `MISSION_CONTROL_GIT_LOCK_TIMEOUT_MS`
- `MISSION_CONTROL_GIT_LOCK_STALE_MS`
- `MISSION_CONTROL_GIT_LOCK_POLL_MS`

## QA Integration

Trust Leads QA integration is opt-in per project:

```json
{
  "trustLeadApprovals": true,
  "integrationBranch": "qa/integration",
  "validationCommands": ["npm run check"]
}
```

When review automation moves a lead-approved task to `qa_review`, run:

```bash
npm run qa-integrate -- --plan
npm run qa-integrate -- --project myapp
```

Tasks already marked with `integrationStatus: ready` are skipped on later sweeps. Use `--force` only when a branch has changed and deliberate revalidation is required.

The worker refuses `main`, `master`, `production`, and the configured default branch as integration targets. It prepares each QA bundle in an isolated workspace under `~/.codex/studioops/qa-workspaces/` by default, so the registered project checkout can stay on the owner's active branch with local changes. Override the workspace root with `STUDIOOPS_QA_WORKSPACE_ROOT` or its legacy `MISSION_CONTROL_QA_WORKSPACE_ROOT` alias when needed, but keep it outside the registered project checkout.

QA integration requires the registered project checkout to have an `origin` remote. It aborts merge conflicts, records comments on affected tasks, and prepares a full disposable clone at the exact integration SHA before running validation. Project validation runs with a synthetic environment inside the macOS Seatbelt sandbox: network access, arbitrary process inspection, reads outside the disposable clone and approved tool roots, and execution outside the clone and approved tool roots are denied. Only a bounded set of non-process operating-system and hardware metadata needed by normal runtimes is readable. A pre-validation byte, executable-mode, and symlink manifest verifies the original worktree afterward without trusting candidate-controlled Git indexes, replace refs, filters, or local configuration. If that data-and-egress boundary is unavailable, QA fails closed before running project code or pushing the non-production integration branch. Reports and task comments include the workspace and sandbox strategies used for the run. QA integration does not merge PRs, deploy, force-push, or checkout the registered project `repoPath`.

Validation commands must remain owner-authorized. The post-command manifest proves that tracked checkout bytes, executable modes, and symlinks match their pre-command state; it cannot prove that a command never modified and restored them while it ran. Seatbelt restrictions follow forked and executed descendants, and StudioOps kills the leader's ordinary process group after success, failure, timeout, or output overflow, then closes inherited output pipes after a bounded drain. macOS does not provide StudioOps an unprivileged atomic way to kill a descendant that deliberately creates a new session or process group. Such a descendant remains unable to read disallowed host paths, write outside the disposable root, inspect other processes, or use the network, but it can consume host resources until separately terminated. Use a VM- or cgroup-backed validation provider when hostile-code availability or immutable-execution containment is required.

Projects can also opt into keeping their QA branch and local preview checkout current:

```json
{
  "qaIntegration": {
    "syncDefaultBranchIntoIntegration": true,
    "localPreview": {
      "enabled": true,
      "checkoutPath": "~/.codex/studioops/qa-workspaces/myapp/myapp-clean",
      "branch": "qa/integration",
      "stashDirty": true,
      "postUpdateCommands": ["npm run check"],
      "restartLaunchAgents": ["com.example.myapp.local"],
      "launchAgentPlists": {
        "com.example.myapp.local": "~/Library/LaunchAgents/com.example.myapp.local.plist"
      },
      "previewUrl": "http://127.0.0.1:4174/",
      "healthCheckUrl": "http://127.0.0.1:4174/health",
      "identityHeader": "x-studioops-commit",
      "identityJsonField": "commitSha"
    }
  }
}
```

The same local preview can be configured without hand-editing the data file:

```bash
studioops update-project myapp \
  --local-qa-preview \
  --local-qa-preview-checkout ~/.codex/studioops/qa-workspaces/myapp/myapp-clean \
  --local-qa-preview-branch qa/integration \
  --local-qa-preview-create \
  --local-qa-preview-stash-dirty
```

`syncDefaultBranchIntoIntegration` merges the latest configured default branch into the non-production QA branch before task PR heads are integrated. This is useful after the owner merges a PR to `main`: the QA branch catches up on the next sweep instead of leaving the local preview stale.

`localPreview` fast-forwards a stable local checkout to the exact candidate
branch after successful integration. The configured static branch remains the
maintenance/default-sync branch and cannot override a candidate branch. It
never force-pulls. If `stashDirty` is false, uncommitted preview checkout
changes block the sync and are reported. If `stashDirty` is true, StudioOps
preserves them in a Git stash before fast-forwarding. Missing preview
LaunchAgents are bootstrapped from the configured plist (or the standard
`~/Library/LaunchAgents/<label>.plist` path) and restarted.

The health endpoint must attest the commit actually served by the running
preview. Return the full Git SHA in the configured `identityHeader` (default
`X-StudioOps-Commit`) or JSON `identityJsonField` (default `commitSha`). A plain
HTTP 200 is insufficient and blocks candidate freeze.

## Local TechOps recovery

The optional TechOps worker rechecks the loopback health endpoint for active
`ready` and `partially_reviewed` QA bundles after they have been frozen. It
checks both availability and the full immutable candidate SHA, so a previously
healthy preview that stops or begins serving a stale checkout becomes a
dedicated `techops_check_qa_preview` action rather than another feature build.

Configure the policy per project (or under `defaults.techOps`):

```json
{
  "techOps": {
    "enabled": true,
    "healthCheckIntervalSeconds": 60,
    "healthTimeoutMs": 5000,
    "commandTimeoutMs": 60000,
    "maxAttempts": 3,
    "initialBackoffSeconds": 60,
    "maxBackoffSeconds": 900,
    "leaseSeconds": 300,
    "maxConcurrentRecoveries": 1,
    "maxCommandsPerAttempt": 8,
    "maxOutputChars": 4000,
    "verificationAttempts": 5,
    "verificationDelayMs": 1000,
    "diagnosticCommands": [
      {
        "id": "postgres-status",
        "operation": "docker_compose_ps",
        "services": ["postgres"]
      }
    ],
    "recoveryCommands": [
      {
        "id": "postgres-start",
        "operation": "docker_compose_up",
        "services": ["postgres"]
      }
    ],
    "restartLaunchAgents": ["com.example.myapp.local"]
  }
}
```

Commands must use the typed operation records above; arbitrary executables,
argument arrays, shell strings, SQL, interpreter/eval commands, filesystem
utilities, and raw Docker subcommands are rejected before execution. Supported
diagnostic operations are `docker_compose_ps`; supported recovery operations
are `docker_compose_up`, `docker_compose_start`, and
`docker_compose_restart`. Every operation requires one or more validated Compose
service names. StudioOps generates the Docker argv internally, pins the local
`default` Docker context, supplies the already verified project-local Compose
project directory without accepting file or project-name overrides, and never
exposes delete, remove, down, prune, or volume flags. Compose therefore resolves
only the configuration and existing project identity rooted at that directory.
The `docker_compose_up` operation always includes
`--no-recreate`, so it can start or create a missing service but cannot replace
an existing database container. A malformed command makes the entire recovery
policy fail closed; it cannot be skipped while other commands or LaunchAgent
restarts continue.

Command working directories must resolve inside the registered project or its
local QA preview checkout. LaunchAgents are restarted by the worker only when
their labels also appear in
`localPreview.restartLaunchAgents`. Keep secrets out of command arguments and
output; stored output is bounded and common credential forms are redacted, and
the durable audit records command identifiers and typed result codes rather
than generated argv values.

Run a read-only plan or one sweep manually:

```bash
node src/mission-control-techops.js --plan
node src/mission-control-techops.js --json
```

The installed `com.codex.mission-control.techops` LaunchAgent runs one sweep per
minute. A fenced lease deduplicates overlapping sweeps. Failures use durable
exponential backoff; after `maxAttempts`, the QA bundle records one
`circuit_open` incident with the final actionable blocker and no further
recovery is claimed. A successful recovery must again attest the exact
candidate SHA before the incident is cleared. Changing candidate or recovery
policy identity starts a new bounded series. TechOps never merges, pushes,
deploys, deletes databases, resets volumes, or runs a command rooted in another
project.

## Main Promotion

After the owner reviews the local QA preview, mark the task from the UI or CLI:

```bash
studioops qa-list --json

studioops qa-pass task_123 \
  --candidate candidate_opaque \
  --manifest-digest sha256:full-digest \
  --integration-sha full-git-sha \
  --owner-qa-packet-digest sha256:owner-packet-digest \
  --body "Checked locally."

studioops qa-fail task_123 \
  --candidate candidate_opaque \
  --manifest-digest sha256:full-digest \
  --integration-sha full-git-sha \
  --owner-qa-packet-digest sha256:owner-packet-digest \
  --body "Hero image still covers the full page."

studioops qa-pass --bundle qa_bundle_opaque \
  --candidate candidate_opaque \
  --manifest-digest sha256:full-digest \
  --integration-sha full-git-sha \
  --owner-qa-packet-digest sha256:owner-packet-digest \
  --body "Checked the complete bundle locally."
```

Copy all four immutable decision coordinates from the same actionable task or
bundle returned by `qa-list`; do not mix coordinates from separate rows. Use
the positional task ID for a task selector and `--bundle BUNDLE_ID` for a
bundle selector. Multi-task candidates must use the bundle selector so the
decision applies atomically to every task in the immutable candidate.
`qa-pass` moves the task to `approved_for_main` and queues it for the promotion
worker. `qa-fail` moves it back to `needs_changes` with the owner notes
preserved as a task comment.

Promotion is configured per project and defaults to the project's `defaultBranch`:

```json
{
  "promotion": {
    "enabled": true,
    "targetBranch": "main",
    "validationCommands": ["npm run check"]
  }
}
```

Run or preview promotion manually:

```bash
npm run promotion -- --plan
npm run promotion -- --project myapp
```

The promotion worker uses an isolated clone under `~/.codex/studioops/promotion-workspaces/`, verifies the immutable QA candidate, and runs validation in a second full disposable clone under the same no-network macOS sandbox used by QA integration. Missing sandbox support fails closed before project code, push, or PR creation. After successful validation it performs a non-force push to a deterministic release-candidate branch, then authoritatively re-observes exactly one GitHub PR whose repository, base, head branch, head SHA, state, and immutable-candidate marker all match. Ambiguous PR identity is a failure, never release-ready. It never pushes directly to the protected target branch.

Merged-PR reconciliation never reruns project validation or resolves project validation executables. It re-observes the exact GitHub merge and independently fetches the protected branch into a fresh private bare repository using the canonical HTTPS URL with repository-local rewrites and non-HTTPS transports disabled. The final SQLite write accepts only fresh, in-process observations bound to the current fenced claim. Historical recovery is deliberately narrower still: it requires exact persisted handoff and event chronology, and retains any post-handoff validation failure as an owner-visible warning instead of converting it into passing evidence.

Operational authentication, evidence, push, and PR failures retry with durable exponential delays. Three failures for the same candidate and live project policy open an owner-visible circuit; changing `repoPath`, `repoUrl`, promotion enablement, target branch, validation policy, or an explicit circuit reset starts a newly bound attempt series.

Promotion does not deploy production. It prepares the target branch for owner release-candidate review. Production deploys should remain behind explicit release or tag workflows.

## Self Update

StudioOps can update its own local checkout after a control-plane PR is merged to `origin/main`:

```bash
npm run self-update -- --plan
npm run self-update
```

The self-updater compares both the configured source branch (`main` by default) and the active immutable runtime provenance. It can therefore republish and restart a stale runtime even when the source checkout was already fast-forwarded by a person or another process. Source divergence and runtime drift are reported separately.

It refuses to update or republish the runtime when:

- the working tree has uncommitted or untracked files
- local `main` cannot fast-forward to `origin/main`
- the checkout is on another branch
- builder or reviewer Codex runs are actively running

An absent runtime, a runtime commit that differs from the verified source commit, or invalid runtime provenance is actionable drift. Runtime publication still uses the immutable release staging and atomic `current` symlink swap, so a repair does not execute files directly from the writable source checkout.

Running builder/reviewer runs are ignored only when they are stale, such as a missing runner process when PID checks are enabled or a `startedAt` timestamp older than the configured stale-run window. After a successful update, the updater restarts these LaunchAgents:

- `com.codex.mission-control.web`
- `com.codex.mission-control.steward`
- `com.codex.mission-control.supervisor`
- `com.codex.mission-control.dispatcher`
- `com.codex.mission-control.runner`
- `com.codex.mission-control.notifier`
- `com.codex.mission-control.qa-integration`
- `com.codex.mission-control.promotion`
- `com.codex.mission-control.watchdog`

During an applied update, StudioOps records a short-lived self-update lease in local state. The runner checks that lease before claiming queued builder/reviewer work, so queued runs wait until the fast-forward and LaunchAgent restart window is over instead of being started and interrupted.

Use `studioops.config.md` `defaults.selfUpdate` or CLI flags such as `--branch`, `--remote`, `--stale-run-ms`, `--task`, `--notify`, and `--no-restart` to tune local behavior. `--task` records a StudioOps comment on that task; all material non-dry-run outcomes are recorded as StudioOps events.

## Uninstall

```bash
npm run uninstall-agents
```

## Logs

LaunchAgent logs are written to:

```text
data/launch-agents/
```

Runner output is written to:

```text
data/run-outputs/
```

## Safety

The always-on stack may create branches, run validation, commit, push, and open or update pull requests. It may assemble owner-QA-passed task heads on a release-candidate branch, but it does not merge that branch into the protected target.

### Project run budgets

#### Completed runs over budget

Provider usage is recorded on both the run and its task. The telemetry fields
are deliberately separate: `rawInputTokens`, `cachedInputTokens`,
`uncachedInputTokens`, `outputTokens`, `reasoningOutputTokens`,
`rawTotalTokens`, `effectiveBudgetTokens`, and authoritative provider credit
status (`actualCredits`, `authoritativeCreditStatus`). `rawTotalTokens` is the
provider's complete input-plus-output volume, including cached input and any
replayed context. `effectiveBudgetTokens` is uncached input plus output, so
cached input is not charged at face value but is also not treated as free.
The effective token budget and `rawContextTokenBudget` are independent: the
latter catches pathological transcript or board-history replay. Missing credit
telemetry remains `unavailable`; StudioOps never infers credits from tokens.

Before launch, each worker receives a bounded packet containing only the
current task contract, exact candidate identity, applicable standards, current
stage evidence, and a small remediation/failure slice. Full board snapshots,
unrelated tasks, completed review history, raw transcripts, and prior model
prose are excluded. `promptChars`, `promptOriginalChars`, and
`promptCompacted` record the deterministic packet-size decision; an oversized
packet is compacted before a paid provider run can start.

If a completed builder or architecture run has already atomically recorded a
valid handoff, exceeding its effective-work, raw-context, or credit budget preserves the completed
run, exact candidate/PR or architecture graph, and reviewable task status. The
task records `budgetTelemetry` and a `budgetPause`; automatic reviewer, QA,
retry, and continuation work remains paused until an owner-authorized next
action. A completion without valid handoff evidence still fails closed and
becomes owner-blocked. Budget telemetry is audit evidence, not permission to
continue spending.

Projects that use GitHub Actions can opt into a project-level worker budget in
`wipPolicy`:

```json
{
  "wipPolicy": {
    "maxActiveRuns": 1,
    "maxRunsPerWindow": 0,
    "runWindowMinutes": 60
  }
}
```

`maxActiveRuns` applies to queued and running builder/reviewer/QA-worker runs;
owner handoffs are intentionally exempt. It prevents a single project from
fanning out several Actions-triggering branches at once. Completed healthy
runs do not consume a rolling launch quota, so distinct productive work can
continue as soon as the active slot clears. Lane and exact file-scope conflicts,
credit admission, duplicate exact candidate-stage suppression, and durable
failure incidents continue to contain unsafe or redundant work.

Configure them with `studioops update-project PROJECT --max-active-runs 1
--max-runs-per-window 0 --run-window-minutes 60`. For one compatibility release,
legacy positive `maxRunsPerWindow` values remain readable but normalize to zero
and emit one bounded `total_run_window_deprecated` diagnostic. The preserved
`runWindowMinutes` value is used only for duplicate exact-stage detection and
deprecation evidence. Target repositories should still keep expensive
validation on pull requests and their canonical QA branch rather than on every
feature-branch push.

StudioOps also applies an installation-wide active-work brake. The default
admits two metered workers across the installation at a time; per-project limits
still prevent overlapping project work, and owner handoffs remain visible and
unmetered. Configure it under `defaults.globalRunAdmission` with
`maxActiveMeteredRuns`. `maxMeteredRunsPerWindow` is now the same inert
compatibility field and defaults to zero. Deferred active work remains queued
with `global_active_run_limit` evidence; completed healthy work never causes a
`global_run_window_limit` skip.

Before selecting paid work, the dispatcher reads indexed durable failure
incidents and suppresses only an exact task, action, provider, and immutable
candidate match whose circuit is open or whose backoff has not elapsed. An
unrelated task or changed candidate remains eligible. The dispatcher is a
read-only admission boundary; it records that the atomic paid-attempt claim
belongs immediately before provider launch in the runner, so a queued run that
never launches cannot spend a failure-generation attempt.

Exact candidate-stage duplicates and unchanged failed retries inside their
retry window are suppressed as `duplicate_candidate_stage` and `retry_backoff`.
Before a GitHub push, the
runner installs a local pre-push hook that executes the project's deterministic
`validationCommands`, keeps full output in a local log, emits only a bounded
failure excerpt, and caches success by exact Git tree and validation-policy
digest. Review comments and other state-only work never push.

Finally, `defaults.runner.outputGuard` records guidance and bounds the stored event
when one command exceeds 24,000 characters. The first broad read does not discard
an otherwise useful run. Cumulative command output above 160,000 characters remains
a hard circuit breaker, preventing repeated broad searches or test dumps from
expanding into a multi-million-token transcript. A cumulative violation blocks the
task with explicit output-budget evidence until the work is resumed with targeted
reads or local log files.

It must not:

- press GitHub's pull-request merge button or bypass the configured owner-QA gate
- deploy production
- send customer-facing messages
- commit secrets or private data
- bypass the human owner review or Trust Leads QA gate

The runner defaults to isolated workspaces and a limit of three active Codex runs. Installed configurations normalize a missing runner limit to three while preserving an explicit lower positive limit. It can run multiple projects, or compatible lanes within the same project, at the same time.

StudioOps treats backend and frontend work as compatible by default. Design conflicts with frontend, and devops/project-wide work conflicts with other lanes in the same project. That keeps parallel agents from editing the same UI/CSS/deployment surface while still allowing a real team-style flow.

Automation ends at the owner handoff. It cannot merge, tag, release, deploy
production, or send an external notification. The immutable candidate manifest
remains the sole release authority. One human production release decision must
name the full commit SHA, target host, candidate-manifest or artifact SHA-256
digest, time of a successful health check that attested that exact commit, and a
tested rollback commit or procedure. No task status, delivery mode, policy
profile, comment, or prose substitutes for that packet.
