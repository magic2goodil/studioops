# GitHub App Bots

Mission Control can use GitHub Apps as bot identities for branch pushes, pull requests, comments, and reviewer handoffs.

GitHub requires one browser approval step to create an App registration. Mission Control provides a local manifest setup helper so the app permissions are prefilled and private credentials are saved outside git.

## Recommended Setup

Start with one private app:

```bash
npm run setup-github-app
```

This creates a local setup page at:

```text
http://127.0.0.1:4328/
```

Click **Create Mission Control Bot**, approve the GitHub App registration, then install it on the repositories Mission Control should manage.

Credentials are written locally under:

```text
.mission-control/github-apps/default/
```

That directory is ignored by git.

The runner uses GitHub App auth by default for builder and reviewer runs. If credentials are missing, invalid, or not installed on the target repository, the run fails before Codex starts. This prevents a worker from falling back to your personal `gh` login or SSH identity for bot-authored PR work.

## Separate Role Apps

If you want GitHub to show different bot actors for different automation roles, run:

```bash
npm run setup-github-role-apps
```

This creates manifests for:

- `Mission Control Builder`
- `MC Backend Reviewer`
- `MC Frontend Reviewer`
- `MC Accessibility Reviewer`
- `MC Lead Reviewer`

Separate role apps create clearer GitHub audit trails, but they also mean more app registrations, installations, private keys, and installation tokens to rotate and monitor.

## Permissions

The manifest requests:

- `contents: write` for branch and commit writes
- `pull_requests: write` for PR creation and review activity
- `issues: write` for PR comments and labels
- `checks: read` and `actions: read` for CI/status inspection
- `metadata: read`, required by GitHub Apps

Webhooks are not requested by default. Mission Control can add webhook handling later if we use a public endpoint or tunnel and want GitHub to actively push events into the local task board.

## Security

Do not commit anything from `.mission-control/`.

The setup helper stores:

- `app.json`: non-secret app metadata
- `private-key.pem`: GitHub App private key
- `secrets.json`: client secret and webhook secret
- `install-url.txt`: app installation link

Private keys and secrets are written with owner-only file permissions where the operating system supports that.

## Runtime Auth

When the runner claims a builder or reviewer run, it:

- reads the role's app metadata from `.mission-control/github-apps/`
- signs a GitHub App JWT with the local private key
- resolves the app installation for the run's `github.com` repository
- creates a repository-scoped installation token with only the role permissions needed for branch, PR, comment, and review activity
- passes the token to child Codex runs as `GH_TOKEN` and `GITHUB_TOKEN` so `gh pr create`, comments, and reviews use the app identity
- passes the token to `git` through `GIT_ASKPASS`, not through command arguments or remote URLs
- rewrites GitHub SSH remotes to HTTPS for the child process only, so `git push origin ...` uses HTTPS without changing persistent remotes
- redacts the installation token from runner logs and last-message files if a child process prints it

Installation tokens are short-lived. GitHub controls the final expiry, and Mission Control rejects expired token responses.

## Role Mapping

With `npm run setup-github-app`, all roles use `.mission-control/github-apps/default/`.

With `npm run setup-github-role-apps`, Mission Control looks for these directories:

- `builder`
- `backend-reviewer`
- `frontend-reviewer`
- `accessibility-reviewer`
- `lead-reviewer`

You can override the mapping in `mission-control.config.md`:

```json
"githubApps": {
  "credentialsDir": ".mission-control/github-apps",
  "defaultRole": "default",
  "roleMap": {
    "builder": "default",
    "backend-reviewer": "backend-reviewer",
    "frontend-reviewer": "frontend-reviewer",
    "accessibility-reviewer": "accessibility-reviewer",
    "lead-reviewer": "lead-reviewer"
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
3. Replace only the matching local `private-key.pem` file under `.mission-control/github-apps/<role>/`.
4. Keep file permissions owner-only, for example `chmod 600 .mission-control/github-apps/<role>/private-key.pem`.
5. Delete the old private key in GitHub after a runner sweep succeeds with the new key.

If an app is compromised or no longer needed, uninstall it from the repository and remove the matching local directory under `.mission-control/github-apps/`.
