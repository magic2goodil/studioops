# Security Policy

StudioOps executes coding agents against local repositories. Treat its configuration, task content, workspaces, GitHub credentials, logs, and state database as sensitive development infrastructure.

## Supported Versions

The project is currently in developer preview. Security fixes are applied to the latest `main` branch. No older release line is supported yet.

## Reporting A Vulnerability

Do not open a public issue containing exploit details, credentials, private repository information, customer data, or other sensitive material.

Use GitHub's private vulnerability reporting or a private security advisory for this repository when available. Include:

- affected commit or version
- affected component and configuration
- reproduction steps or a minimal proof of concept
- expected and observed behavior
- likely impact
- suggested mitigation, if known

If private reporting is unavailable, open a public issue that only asks the maintainer for a private contact path. Do not include vulnerability details in that issue.

## Deployment And Exposure

- The web server binds to `127.0.0.1` by default. Every API except the redacted health probe requires an owner session or a route-scoped service capability.
- Do not expose the UI directly to the public internet.
- A non-loopback bind fails closed unless secured LAN mode is explicitly enabled with TLS, exact allowed hosts and origins, and a previously enrolled owner. A trusted network and host firewall remain required.
- StudioOps must not be used as a public webhook endpoint without an authenticated gateway designed for that purpose.

The default loopback control plane validates `Host` before URL construction and
checks browser origin, Fetch Metadata, JSON media type, body limits, session
authorization, and CSRF before parsing mutation bodies. Secured LAN mode is a
separate configuration, not an `0.0.0.0` shortcut. It does not turn StudioOps
into a public or multi-user service.

Owner password hashes and recovery-code digests live in the owner-only local
control-plane auth directory. Sessions, CSRF values, and two-minute
reauthentication grants are never persisted by the server. The only plaintext
server-side authentication secret written to disk is the first-run, single-use,
short-lived bootstrap secret in the `0600` local operator log. It is invalidated
by enrollment. Rotate the owner password or use one recovery code if compromise
is suspected; both actions revoke every active session and grant.

## Secrets And PII

Except for the deliberately isolated first-run bootstrap record described
above, never store secrets, access tokens, private keys, passwords, customer
records, or unnecessary PII in:

- `studioops.config.md`
- tasks, comments, acceptance criteria, or attachments
- builder or reviewer prompts
- sample data
- Git history
- logs or run output

GitHub App credentials belong under the local ignored credentials directory described in [docs/GITHUB_APP_BOTS.md](docs/GITHUB_APP_BOTS.md). Project secrets belong in each project's existing secret manager or protected environment.

Treat authentication data, payment data, precise location, social graphs, behavioral analytics, private repository content, and production operational data as sensitive. Minimize collection, redact logs, define retention, and require explicit consent when a product task introduces sensitive user data or outbound communication.

## Agent Execution Risk

Builders and reviewers may read and edit local repository files, execute project commands, create branches, commit, push, and open pull requests. Before enabling unattended execution:

1. Review project paths and work lanes.
2. Use least-privilege GitHub App installations.
3. Define project safety rules and validation commands.
4. Keep production credentials outside the worker environment.
5. Use non-production QA branches and local previews.
6. Require owner QA before promotion.
7. Require an explicit release or tag before production deployment.

StudioOps intentionally does not authorize direct production deployment. Do not weaken that boundary in a routine task or pull request.

## Local State

The SQLite database, WAL, shared-memory files, backups, heartbeats, local attachments, run outputs, control-plane auth directory, operator log, and GitHub App credentials are runtime data and must remain outside version control. The default installer applies restrictive local file permissions, but workstation backups and filesystem access still need normal host security.

Local attachment previews are limited to the managed `data/local-attachments`
directory and additional roots explicitly registered through
`STUDIOOPS_ATTACHMENT_ROOTS`. Authentication does not authorize arbitrary local
filesystem reads.
