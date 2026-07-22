# Security Policy

Codex Mission Control executes coding agents against local repositories. Treat its configuration, task content, workspaces, GitHub credentials, logs, and state database as sensitive development infrastructure.

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

- The web server binds to `127.0.0.1` by default and does not currently provide internet-facing multi-user authentication.
- Do not expose the UI directly to the public internet.
- Binding to `0.0.0.0` exposes task content to the reachable local network. Use it only on a trusted network with host firewall controls.
- Mission Control must not be used as a public webhook endpoint without an authenticated gateway designed for that purpose.

## Secrets And PII

Never store secrets, access tokens, private keys, passwords, customer records, or unnecessary PII in:

- `mission-control.config.md`
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

Mission Control intentionally does not authorize direct production deployment. Do not weaken that boundary in a routine task or pull request.

## Local State

The SQLite database, WAL, shared-memory files, backups, heartbeats, local attachments, run outputs, and GitHub App credentials are runtime data and must remain outside version control. The default installer applies restrictive local file permissions, but workstation backups and filesystem access still need normal host security.
