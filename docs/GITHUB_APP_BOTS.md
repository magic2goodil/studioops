# GitHub App Bots

StudioOps can use GitHub Apps as bot identities for branch pushes, pull requests, comments, and reviewer handoffs.

GitHub requires one browser approval step to create an App registration. StudioOps provides a local manifest setup helper so the app permissions are prefilled and private credentials are saved outside git.

## Recommended Setup

Start with one private app:

```bash
npm run setup-github-app -- --owner YOUR_GITHUB_USER
```

This creates a local setup page at:

```text
http://127.0.0.1:4328/
```

Click **Create StudioOps Bot**, approve the GitHub App registration, then install it on the repositories StudioOps should manage.

Credentials are written locally under:

```text
~/.codex/studioops/credentials/github-apps/default/
```

That directory is ignored by git.

The runner uses GitHub App auth by default for builder and reviewer runs. If credentials are missing, invalid, or not installed on the target repository, the run fails before Codex starts. This prevents a worker from falling back to your personal `gh` login or SSH identity for bot-authored PR work.

## Separate Role Apps

If you want GitHub to show different bot actors for different automation roles, run:

```bash
npm run setup-github-role-apps -- --owner YOUR_GITHUB_USER
```

This creates manifests for:

- `StudioOps Builder`
- `MC Backend Reviewer`
- `MC Frontend Reviewer`
- `MC Accessibility Reviewer`
- `MC Lead Reviewer`
- `MC Promotion Worker`
- `StudioOps QA Integration Worker`

Separate role apps create clearer GitHub audit trails, but they also mean more app registrations, installations, private keys, and installation tokens to rotate and monitor.

## Permissions

The manifest requests:

- `contents: write` for branch and commit writes
- `pull_requests: write` for PR creation and review activity
- `issues: write` for PR comments and labels
- `checks: read` and `actions: read` for CI/status inspection
- `metadata: read`, required by GitHub Apps

Registration permissions are a ceiling. Each installation token explicitly requests a narrower profile for one target repository. [GitHub documents the repository and permission limits of installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

| Token profile | Requested repository permissions |
| --- | --- |
| Ordinary builder | Contents, Issues and Pull requests: write |
| Specialist/lead reviewer | Existing Contents, Issues and Pull requests: write; Actions and Checks: read |
| QA integration | Contents, Issues and Pull requests: write; Checks and Commit statuses: read |
| Promotion worker | Existing Contents, Issues and Pull requests: write |
| Owner QA verification | Contents: read |

QA integration needs its existing writes to publish immutable candidate branches and PRs. Its token does not request Actions write, workflow-file write or administration. If a dedicated QA App is absent, the configured builder/default App can provide the identity, while token minting still uses the QA-specific profile. Ordinary builder tokens do not inherit QA check/status read permissions.

The separate Builder registration is the only generated App manifest that requests `workflows: write`. The shared default App and reviewer, QA and promotion registrations omit it. The default and Builder registration ceilings include `statuses: read` so they can serve the configured QA identity fallback; ordinary builder token permissions remain unchanged.

### Declared Workflow Builder Runs

StudioOps requests `workflows: write` only for the exact builder role and group, a branch-writing builder action and explicit current task scope covering the effective workflow paths. Before preflight and execution token minting, the runner re-reads the durable run, task and project, verifies their identity, current builder assignment and run scope, and supplies the authoritative task `workAreas`. Worker snapshots and caller-supplied declarations cannot grant this permission. Stale, cancelled, cross-project, reassigned, unassigned or changed-scope bindings do not receive workflow elevation.

An exact `.github/workflows` directory declaration or exact descendant file is eligible. Every effective workflow path must be covered by that declaration. Impact expansion can add non-workflow support paths such as `src/**` or `package*.json` without requiring the two complete scope arrays to match.

Missing scope metadata, traversal, absolute paths, lookalikes such as `.github/workflows-ci`, broad `.github/**` or root globs, workflow wildcards, and unmatched workflow files do not receive this permission. Reviewers, QA and promotion never receive it through this classifier.

GitHub's permission is repository-wide, not a file-scoped token. This classifier controls when StudioOps requests it; normal task scope, immutable candidate review, QA and release gates still govern which changes can be accepted. No Actions write, Administration, Deployments, Environments or organization permission is added here.

### Updating Existing Apps

Source changes do not update an existing GitHub App or approve an installation. An App owner must separately:

1. Review the intended role's registration ceiling. QA inspection needs **Checks: read** and **Commit statuses: read** on its dedicated App or configured builder/default identity.
2. For explicitly scoped workflow builder work only, review **Workflows: write** on the separate Builder App.
3. Save the App permission change and approve any pending installation update for the intended repository.
4. Start a new authorized invocation so it mints a fresh repository-scoped token. Previously minted tokens do not acquire new grants.

GitHub denial or revocation fails closed. A token-minting `403` reports the permission approval/fresh-token requirement without echoing the token or JWT. Protected PR inspection denial retains the prior candidate branch, commit, PR and source snapshot, then reports a bounded retry command. It does not reinterpret that old candidate as newly reviewed source.

After the permission change is separately approved, retry the existing candidate through the normal QA workflow:

```bash
npm run qa-integrate -- --project example-app --force
```

`--force` skips only the StudioOps retry cooldown. It does not force-push, merge, bypass checks/reviews or deploy. Failed GitHub App inspection never retries with personal `gh`, PAT or SSH credentials; the legacy local-fallback option is disabled. To roll back a permission change, first stop the affected worker, then revoke the dedicated App grant. Preserved candidate branches and PRs remain audit evidence.

Webhooks are not requested by default. StudioOps can add webhook handling later if we use a public endpoint or tunnel and want GitHub to actively push events into the local task board.

## Security

Do not commit anything from `~/.codex/studioops/credentials/`.

The setup helper stores:

- `app.json`: non-secret app metadata
- `private-key.pem`: GitHub App private key
- `secrets.json`: client secret and webhook secret
- `install-url.txt`: app installation link

Private keys and secrets are written with owner-only file permissions where the operating system supports that.

## Runtime Auth

When the runner claims a builder or reviewer run, it:

- reads the role's app metadata from `~/.codex/studioops/credentials/github-apps/`
- signs a GitHub App JWT with the local private key
- resolves the app installation for the run's `github.com` repository
- creates a repository-scoped installation token with only the role and declared-run permissions needed for branch, PR, comment, review and eligible workflow activity
- passes the token to child Codex runs as `GH_TOKEN` and `GITHUB_TOKEN` so `gh pr create`, comments, and reviews use the app identity
- passes the token to `git` through `GIT_ASKPASS`, not through command arguments or remote URLs
- rewrites GitHub SSH remotes to HTTPS for the child process only, so `git push origin ...` uses HTTPS without changing persistent remotes
- redacts the installation token from runner logs and last-message files if a child process prints it

Installation tokens are short-lived. GitHub controls the final expiry, and StudioOps rejects expired token responses.

## Pull Request Publish Flow

The supported unattended path is the GitHub CLI running inside a StudioOps builder session with a freshly minted GitHub App installation token. It does not depend on a saved personal `gh` login or a long-lived connector session.

Before starting Codex, the runner:

1. Mints a repository-scoped installation token for the builder App.
2. Exposes that token to `gh` as `GH_TOKEN` and `GITHUB_TOKEN`.
3. Exposes the same token to HTTPS `git` commands through `GIT_ASKPASS`.
4. Adds common Homebrew locations to the child `PATH`, including `/opt/homebrew/bin` and `/usr/local/bin`.

Inside the builder session, use this noninteractive sequence:

```bash
command -v gh
gh api /installation/repositories --jq .total_count
git push --set-upstream origin "$(git branch --show-current)"

gh pr view --json url --jq .url 2>/dev/null || \
  gh pr create --draft \
    --base main \
    --title "StudioOps task title" \
    --body "Primary task: task_123"
```

`gh pr view` returns the existing pull request URL on follow-up builder runs. Only create a new draft when no PR exists for the current branch. Then link the branch and PR and record the builder handoff:

```bash
node src/mission-control-cli.js update-task task_123 \
  --branch "$(git branch --show-current)" \
  --pr-url "https://github.com/owner/repository/pull/123"

node src/mission-control-cli.js comment task_123 \
  --author "Codex Builder" \
  --body "Changed files: ... Validation: npm run check passed. Known gaps: none. PR: https://github.com/owner/repository/pull/123. Next: builder review."
```

Do not run `gh auth login` in an App-authenticated runner. A successful `gh api /installation/repositories --jq .total_count` verifies that `GH_TOKEN` is an active App installation token without printing credential details or repository names. GitHub App installation tokens cannot use the user-profile endpoint, so `gh api user` returning `403 Resource not accessible by integration` does not mean the installation token is invalid.

### Runner Host Readiness

Install GitHub CLI once on each runner host and make it visible to the LaunchAgent environment:

```bash
brew install gh
command -v gh
gh --version
```

No persistent `gh` authentication is required for normal App-authenticated runs. If the runner reports missing App credentials, rerun `npm run setup-github-app` or `npm run setup-github-role-apps` and install the App on the target repository. If token minting fails or GitHub reports an expired token, verify the App installation and local private key; the next runner attempt mints a new token rather than reusing the expired one.

For a smoke test, use a harmless documentation-only branch, push it through the runner session, create a draft PR with the sequence above, and confirm the bot owns the PR. Link that PR to its single primary StudioOps task before moving the task to `builder_review`. Close the test PR after verification if it is not intended to merge.

## Role Mapping

With `npm run setup-github-app`, all roles use `~/.codex/studioops/credentials/github-apps/default/`.

With `npm run setup-github-role-apps`, StudioOps looks for these directories:

- `builder`
- `backend-reviewer`
- `frontend-reviewer`
- `accessibility-reviewer`
- `lead-reviewer`
- `promotion-worker`
- `qa-integration-worker`

You can override the mapping in `studioops.config.md`:

```json
"githubApps": {
  "credentialsDir": "~/.codex/studioops/credentials/github-apps",
  "defaultRole": "default",
  "roleMap": {
    "builder": "builder",
    "backend-reviewer": "backend-reviewer",
    "frontend-reviewer": "frontend-reviewer",
    "accessibility-reviewer": "accessibility-reviewer",
    "lead-reviewer": "lead-reviewer",
    "promotion-worker": "promotion-worker",
    "qa-integration-worker": "qa-integration-worker"
  }
}
```

## Runner Options

Use the default app directory:

```bash
npm run runner
```

Use a different app directory:

```bash
npm run runner -- --github-apps-dir /absolute/path/to/github-apps
```

Disable app auth only for local experiments that will not push, create PRs, or comment as a bot:

```bash
npm run runner -- --no-github-app-auth
```

Disabling app auth means GitHub operations may use the user's local credentials. Do not use that mode for automation runs that should be bot-authored.

## Rotation

To rotate a private key:

1. Open the GitHub App settings page from the app's `app.json` or `install-url.txt`.
2. Generate a new private key in GitHub.
3. Replace only the matching local `private-key.pem` file under `~/.codex/studioops/credentials/github-apps/<role>/`.
4. Keep file permissions owner-only, for example `chmod 600 ~/.codex/studioops/credentials/github-apps/<role>/private-key.pem`.
5. Delete the old private key in GitHub after a runner sweep succeeds with the new key.

If an app is compromised or no longer needed, uninstall it from the repository and remove the matching local directory under `~/.codex/studioops/credentials/github-apps/`.
