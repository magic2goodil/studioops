# Testing

StudioOps tests must never use the installed control plane or inherit its database paths.

Run the suite with:

```bash
npm run test:isolated
```

`npm run check` invokes the same launcher after syntax validation.

Run a focused QA integration boundary with:

```bash
npm run test:isolated -- --test-file test/qa-integration-planning.test.js
```

Pass `--test-file` more than once to exercise several boundaries in one hermetic
run. Node executes independent test files concurrently while preserving the
sequential scenario order inside each file.

## QA integration regression boundaries

The QA integration regression suite is partitioned by contract so slow Git and
subprocess fixtures can run concurrently:

| Module | Owned contract | Scenarios |
| --- | --- | ---: |
| `qa-integration-planning.test.js` | policy resolution, candidate planning, retry selection, and result fingerprints | 9 |
| `qa-integration-validation.test.js` | validation environment, source drift, checkout safety, and immutable candidate evidence | 5 |
| `qa-integration-workspace.test.js` | integration/preview synchronization, remote handling, workspace containment, and credential failure | 6 |
| `qa-integration-protected-branch.test.js` | protected-branch PR serialization, merge modes, replacement, and candidate drift | 5 |
| **Total** | | **25** |

Shared repository, state, subprocess, and protected-branch fixture ownership
lives in `test/helpers/qa-integration-fixture.js`; scenario files must not copy
that lifecycle setup. `test/helpers/qa-integration-scenarios.js` is the
executable coverage inventory. Every module registers its scenarios through
that inventory and fails during test discovery if an inventoried scenario is
missing, duplicated, renamed, reordered, or assigned to the wrong module.

Validate all four boundaries together with:

```bash
npm run test:isolated -- \
  --test-file test/qa-integration-planning.test.js \
  --test-file test/qa-integration-validation.test.js \
  --test-file test/qa-integration-workspace.test.js \
  --test-file test/qa-integration-protected-branch.test.js
```

## Isolation contract

`scripts/run-tests.js` creates a permission-restricted temporary StudioOps root and overrides every current and legacy root, data, and config environment variable before Node discovers test files. Runtime, workspace, Git-lock, and GitHub App credential paths are also redirected into that temporary root. GitHub and OpenAI credential environment variables are removed; a test that needs a credential must inject an explicit synthetic value into only its own subprocess.

The launcher writes a random marker token into the temporary root. When Node's test context is active, `state-database.js` fails closed unless:

- `STUDIOOPS_TEST_ROOT` is present;
- the marker token matches `STUDIOOPS_TEST_ISOLATION_TOKEN`; and
- the configured control root, data directory, and config root are contained by the marked test root.

Tests that launch a subprocess with a dedicated fixture database must use `environmentForTestControlRoot` from `scripts/test-environment.js`. Overriding only `MISSION_CONTROL_ROOT` or `STUDIOOPS_ROOT` is unsafe because higher-precedence variables may be inherited from an installed StudioOps worker.

Do not run `node --test` directly. The database guard rejects unmarked test processes before opening a database.
