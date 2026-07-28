# Testing

StudioOps tests must never use the installed control plane or inherit its database paths.

Run the suite with:

```bash
npm run test:isolated
```

`npm run check` invokes the same launcher after syntax validation.

## Isolation contract

`scripts/run-tests.js` creates a permission-restricted temporary StudioOps root and overrides every current and legacy root, data, and config environment variable before Node discovers test files. Runtime, workspace, Git-lock, and GitHub App credential paths are also redirected into that temporary root. GitHub and OpenAI credential environment variables are removed; a test that needs a credential must inject an explicit synthetic value into only its own subprocess.

The launcher writes a random marker token into the temporary root. When Node's test context is active, `state-database.js` fails closed unless:

- `STUDIOOPS_TEST_ROOT` is present;
- the marker token matches `STUDIOOPS_TEST_ISOLATION_TOKEN`; and
- the configured control root, data directory, and config root are contained by the marked test root.

Tests that launch a subprocess with a dedicated fixture database must use `environmentForTestControlRoot` from `scripts/test-environment.js`. Overriding only `MISSION_CONTROL_ROOT` or `STUDIOOPS_ROOT` is unsafe because higher-precedence variables may be inherited from an installed StudioOps worker.

Do not run `node --test` directly. The database guard rejects unmarked test processes before opening a database.
