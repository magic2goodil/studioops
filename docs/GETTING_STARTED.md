# Getting Started

This guide takes a new installation from clone to a working local task board. Start manually, verify the workflow, and only then enable always-on automation.

## 1. Install Prerequisites

Required:

- Node.js `22.5` or newer
- npm
- Git

Recommended for the full GitHub workflow:

- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`
- GitHub SSH or HTTPS access to every registered repository
- Codex CLI or a local ChatGPT/Codex installation authenticated to the account that should run builders and reviewers
- macOS if you want StudioOps to install its worker stack as LaunchAgents

Verify the local tools:

```bash
node --version
npm --version
git --version
gh auth status
```

StudioOps does not need Postgres, Redis, Docker, or a hosted service for a local installation.

## 2. Clone And Validate

```bash
git clone https://github.com/magic2goodil/studioops.git
cd studioops
npm install
npm run check
```

`npm run check` performs syntax checks and runs the automated test suite. Resolve failures before connecting StudioOps to a real project.

## 3. Create Local Configuration

```bash
npm run setup
```

The setup wizard asks for:

- your display name
- your GitHub user or organization
- your local workspace root
- your preferred Git protocol
- the AI coding tools you use
- an optional first project and its validation command

It writes `studioops.config.md`, which is excluded from Git. The file contains operational settings and project paths, but it must not contain private keys, tokens, passwords, customer data, or other secrets.

The wizard registers the first project immediately. If you later edit the config and add projects, import them with:

```bash
npm run import-config
```

You can also register a project directly:

```bash
node src/mission-control-cli.js add-project \
  --key myapp \
  --name "My App" \
  --repo-path "/absolute/path/to/myapp" \
  --repo-url "git@github.com:owner/myapp.git" \
  --default-branch main
```

Use an absolute local repository path. Add the project's actual validation commands and safety rules before enabling unattended builders.

## 4. Run The Local UI

```bash
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Keep the default localhost bind while learning the system.

The current UI is not an internet-facing authenticated service. Never forward this port to the public internet. Local-network access is available for trusted networks and is documented in [LOCAL_AUTOMATION.md](LOCAL_AUTOMATION.md).

## 5. Create A First Task

Use the UI or CLI:

```bash
node src/mission-control-cli.js add-task \
  --project myapp \
  --title "Document the development setup" \
  --story "As a contributor, I want a verified setup guide, so that I can run the project locally." \
  --description "Document prerequisites, install commands, configuration, and validation." \
  --expected "A new contributor can run the project without undocumented steps." \
  --criteria "Setup commands are documented, Validation commands pass, No secrets are included" \
  --status ready \
  --priority medium
```

Inspect the task list and generated prompt:

```bash
npm run tasks
node src/mission-control-cli.js prompt task_1 --role builder
```

Task IDs are installation-local. Use the ID printed by the command rather than assuming `task_1` on an existing database.

## 6. Preview Automation

Before allowing a worker to execute code, preview each stage:

```bash
npm run automation-tick -- --limit 50
npm run supervisor
npm run dispatcher -- --plan
npm run runner -- --plan
```

The plan commands show what StudioOps would queue or execute without starting a Codex builder or reviewer.

When the project paths, task prompt, work lane, validation commands, and safety rules are correct, run one stage at a time:

```bash
npm run dispatcher
npm run runner
```

The runner uses isolated Git workspaces by default. It may edit files, run project commands, commit, push, and open PRs according to the task and project policy. It must not merge protected branches or deploy production.

## 7. Configure GitHub Bot Identity

The recommended automation identity is a private GitHub App installed only on repositories StudioOps should access:

```bash
npm run setup-github-app
```

For separate role identities:

```bash
npm run setup-github-role-apps
```

Follow [GITHUB_APP_BOTS.md](GITHUB_APP_BOTS.md) to select permissions, install the app, and store its credentials outside the repository. When app authentication is required and missing, automation fails closed before Codex starts.

## 8. Choose A Codex Provider

StudioOps supports queued prompt output, the local Codex CLI, and the Codex SDK. Provider behavior is documented in [RUNNER.md](RUNNER.md).

Preview an SDK run:

```bash
npm run runner -- --plan --provider codex-sdk
```

The SDK provider removes `OPENAI_API_KEY` and `CODEX_API_KEY` from the child environment by default. It uses the local Codex authentication context unless API-key authentication is explicitly enabled. Keep API-key auth disabled unless you deliberately want metered API usage and have reviewed the security implications.

## 9. Enable Always-On Automation On macOS

After manual builder and reviewer runs work correctly:

```bash
npm run install-agents
npm run status-agents
```

The installer publishes a stable runtime under `~/.mission-control/runtime`, creates a clean self-update checkout under `~/.mission-control/source`, and installs user LaunchAgents for the web UI and workflow workers. It does not require sudo or install a system daemon.

See [LOCAL_AUTOMATION.md](LOCAL_AUTOMATION.md) before configuring Trust Leads, local QA integration, preview restarts, or promotion.

## 10. Back Up And Upgrade

Create a transactionally consistent SQLite backup:

```bash
npm run backup
```

The backup is written under the local data directory unless another output path is supplied. Runtime state and backups are ignored by Git.

For an always-on installation, StudioOps can fast-forward its clean source checkout after a control-plane change is merged to `main`:

```bash
npm run self-update -- --plan
npm run self-update
```

The updater refuses dirty or divergent checkouts and active non-stale builder/reviewer runs.

## Give This Guide To Codex

```text
Clone https://github.com/magic2goodil/studioops and read
README.md, docs/GETTING_STARTED.md, docs/HANDOFF.md, and SECURITY.md.
Set it up locally, register my project, run npm run check, and start the UI on
localhost. Use plan/dry-run commands before enabling builders. Ask for project
paths and GitHub owner information when required, but never ask me to paste
private keys, access tokens, passwords, or customer data. Do not expose the UI
to the internet or authorize production deployment.
```

## Troubleshooting

- `npm run check` fails: verify Node.js is at least `22.5`, reinstall dependencies, and rerun the command.
- GitHub operations fail: run `gh auth status`, verify repository access, and check the GitHub App installation and permissions.
- A task is not moving: inspect `npm run supervisor`, `npm run dispatcher -- --plan`, `npm run runner -- --plan`, and `npm run status-agents`.
- The local UI is stale: verify the web LaunchAgent and configured local QA preview health check in [LOCAL_AUTOMATION.md](LOCAL_AUTOMATION.md).
- A worker appears stuck: inspect `data/launch-agents/`, `data/run-outputs/`, and watchdog events without committing those files.
