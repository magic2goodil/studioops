# StudioOps Privacy Notice

Effective July 23, 2026

StudioOps is an open-source, local-first developer tool. This notice describes the data handled by the StudioOps software and Codex plugin distributed by StudioOps contributors.

## What StudioOps Handles

Depending on how you use it, StudioOps may process:

- project and repository metadata;
- task descriptions, acceptance criteria, comments, attachments, and workflow history;
- builder and reviewer prompts, results, logs, and validation output;
- local Git branch, commit, pull-request, and QA status;
- operator display name and GitHub organization or username;
- local configuration needed to run the workflow.

Do not put passwords, private keys, access tokens, production secrets, customer records, or unnecessary personal information into StudioOps tasks, prompts, comments, attachments, configuration, or logs.

## Local Storage

The Community edition stores its operational state on the user's machine, by default under `~/.codex/studioops/`. This includes its SQLite database, logs, run output, attachments, workspaces, backups, and local configuration. StudioOps does not operate a hosted account service for the Community edition.

Users control access to, retention of, backup of, and deletion of this local data. Removing the application does not automatically delete local project repositories or external pull requests.

## External Services

StudioOps may invoke services that the user separately configures:

- Codex or another coding agent processes prompts and repository context according to that provider's terms and privacy practices.
- GitHub may receive branches, commits, pull requests, comments, and reviews when GitHub automation is enabled.
- Project validation commands may use package registries, APIs, or other services selected by the project.

StudioOps does not silently enable these integrations. Users are responsible for reviewing the data handling and permissions of each configured service.

## Sharing And Sale

StudioOps contributors do not receive the Community edition's local task database, repository contents, prompts, or logs merely because the software is installed. StudioOps contributors do not sell personal information collected by the Community edition.

Information voluntarily submitted through GitHub issues, pull requests, discussions, or security reports is handled by GitHub and is visible according to the selected GitHub channel.

## Security

StudioOps binds its local UI to `127.0.0.1` by default and does not currently provide internet-facing multi-user authentication. Do not expose the UI directly to the public internet. Security reports must follow [SECURITY.md](SECURITY.md) and should never include credentials or private customer data.

## Changes And Questions

Material changes to this notice will be committed to the public repository. General privacy questions may be opened as a GitHub issue without including personal or confidential information. Security-sensitive concerns should use GitHub private vulnerability reporting.
