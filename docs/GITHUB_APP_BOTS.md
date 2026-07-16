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

## Separate Role Apps

If you want GitHub to show different bot actors for different automation roles, run:

```bash
npm run setup-github-role-apps
```

This creates manifests for:

- `Mission Control Builder`
- `MC Backend Reviewer`
- `MC Frontend Reviewer`
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

## Remaining Integration Step

Creating the app registration is only the identity foundation.

For future PRs to appear as the bot, Mission Control must also use the app installation token when it:

- pushes branches over HTTPS
- creates pull requests
- posts comments or reviews

If Codex uses your local SSH key or your `gh auth` login, GitHub will still attribute PRs to you.
