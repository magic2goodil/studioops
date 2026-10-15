# StudioOps Codex plugin

StudioOps is a skills-first plugin for setting up a local software-delivery board and capturing structured engineering work. It remains a developer preview. The visual board and workers run in the separately installed StudioOps application.

## Install or update

From a reviewed source checkout:

```bash
codex plugin marketplace add /absolute/path/to/studioops
codex plugin add studioops@studioops-marketplace
```

Use a local workspace such as `~/.codex/workspaces/studioops`. Start a new Codex task after installing or updating: existing tasks may retain the earlier skill snapshot. Confirm the marketplace points to the intended checkout and that the installed plugin version matches `.codex-plugin/plugin.json`.

## Included skills

- `setup-studioops`: inspects the active repository, configures the local control plane, registers the project and verifies installation.
- `run-studioops`: captures a project/task with user story, outcome, acceptance criteria, standards, validation and privacy notes; returns the durable task ID, local board URL, status and next owner.

The bundled client communicates with `http://127.0.0.1:4317` by default. `STUDIOOPS_URL` can select another reviewed local service address. The plugin contains no credentials or model account, no MCP server and no hosted StudioOps service. It does not grant production release authority.

Codex and GitHub interactions use the operator's configured accounts. Model usage remains subject to that provider's plan and limits; the MIT software license is not a promise of free model execution. Existing operator pauses and project-specific permissions remain authoritative.

## Distribution

Run `npm run plugin:package` from the source checkout. The ZIP includes an explicit file allowlist: plugin manifest, the two skills and their references, local client, three icon/logo assets, this guide, MIT license and policy/support notices. It excludes screenshots, tests, operator configuration, databases, run output, private reference material and Git history.

The npm distribution uses a separate allowlist for the runnable application, standards, operating documentation and installer scripts. Managed runtime installation/self-update still require a canonical Git checkout with its lockfile; use the Git-based setup for those operations. A package's current files can be audited independently, but its canonical source links and installer still lead to the public repository and its contributor history. See [Sharing and evaluation](https://github.com/magic2goodil/studioops/blob/main/docs/SHARING.md).

For development, use the plugin-creator validator and each skill's validator available in your Codex installation. Update plugin versions with the plugin-creator cachebuster helper, align the prepared listing version, rebuild the ZIP, and reinstall from the verified marketplace. Record the source revision and package SHA-256 outside the package; do not treat a version label alone as release evidence.

## Scope of the workflow

The application supports isolated builders, specialist and lead review, local QA and release-candidate PR preparation. Hosted release qualification and deployment need project-specific operator work. Jira integration is a proposed extension, not included functionality. See the [workflow UML](https://github.com/magic2goodil/studioops/blob/main/docs/workflow-uml/README.md).

[Source and setup](https://github.com/magic2goodil/studioops) · [Privacy](https://github.com/magic2goodil/studioops/blob/main/PRIVACY.md) · [Support](https://github.com/magic2goodil/studioops/blob/main/SUPPORT.md)
