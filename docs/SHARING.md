# Sharing and evaluating StudioOps

Use a reviewed current snapshot and a fresh local workspace for an evaluation. The repository's README visuals use synthetic examples; they are not operational reports. Public workflow diagrams use generic project names and distinguish implemented behavior from proposed integrations.

## Choose a distribution

| Artifact | Intended use | Boundary |
| --- | --- | --- |
| Skills-only plugin ZIP | Install the two Codex skills and local client | No runtime database, screenshots, tests or Git history; setup may retrieve the canonical source repository |
| npm tarball | Inspect or run the allowlisted application payload | Includes runtime and operating docs, excludes test/evaluation/design evidence and operational state |
| Current source archive | Review source, tests and documentation without a `.git` directory | A snapshot only; it does not anonymize upstream history or linked resources |

The npm tarball can run the local UI after dependency installation. Managed runtime installation and self-update require the canonical Git checkout and its lockfile/provenance; use the documented Git-based setup for those operations. The npm tarball is not a replacement for a managed source checkout.

Keep the MIT license and contributor notices. Record the full source commit, plugin version, file manifest and SHA-256 for the exact artifact being evaluated. Build archives from reviewed tracked files, not an entire working directory. Recheck extracted contents before sharing.

## Privacy review scope

Current-file cleanup does not erase previous commits, contributor names/emails in commit metadata, issues, PRs, forks or caches. The canonical public repository retains that history and attribution. Do not describe it as anonymous or as having had all historical personal information removed. Rewriting history or publishing a separate distribution source requires a distinct coordinated decision.

Never add local configuration, credentials, task exports, SQLite files, backups, run output, private photographs or production screenshots to an evaluation package. Keep customer/employer-specific proposals outside the public source tree. Inspect image pixels as well as metadata: a screenshot can reveal project names and review text without containing EXIF data.

## Team evaluation

Begin with a synthetic repository and sample tasks. StudioOps is a single-owner developer preview, with no built-in enterprise authentication or tenancy. Jira intake, organization policy enforcement and a hosted release-environment adapter are additional integration work. A demonstration is not evidence of security or regulatory approval.

Confirm approved model accounts, permitted source/data categories and outbound access before enabling agents. A firewall around the local board does not prevent a configured cloud model from receiving prompts and repository context. Keep model execution paused until the evaluator deliberately enables a bounded task, and preserve review, hosted QA and human release boundaries.
