---
name: setup-studioops
description: Install, configure, start, repair, or verify StudioOps for a local software project. Use when the user asks to install or set up StudioOps, initialize its board, connect the current repository, start the local service, or make StudioOps ready for first use.
---

# Set Up StudioOps

Install a safe local StudioOps control plane and register the user's current project with minimal questions.

## Default Outcome

After setup:

- StudioOps source and operational state live under `~/.codex/`.
- The UI is available only on localhost.
- The current repository is registered with detected context and validation.
- The user can ask Codex to create or build work through StudioOps.
- Production deployment, automatic protected-branch merges, and external messaging remain disabled.

## Workflow

1. Read the nearest `AGENTS.md` and inspect the current Git repository.
2. Detect, when available:
   - repository root, name, remote URL, and default branch;
   - GitHub owner from the remote;
   - user display name from Git configuration;
   - relevant `README.md`, `AGENTS.md`, and architecture or standards documents;
   - validation commands from the existing package, build, and test configuration.
3. Check whether StudioOps is already reachable:

   ```bash
   node <plugin-root>/scripts/studioops.mjs status
   ```

   Resolve `<plugin-root>` two directories above this `SKILL.md`.
4. If StudioOps is unavailable, use `~/.codex/studioops/source` as the installation checkout:
   - require Node.js 22.5 or newer, npm, and Git;
   - clone `https://github.com/magic2goodil/studioops.git` only when the checkout does not exist;
   - when it exists, verify its origin and Git state instead of deleting, resetting, or overwriting it;
   - run `npm install` and `npm run check`;
   - run the StudioOps setup wizard, supplying detected answers and asking the user only for material values that cannot be inferred safely;
   - keep workspaces under `~/.codex/workspaces/` and StudioOps state under `~/.codex/studioops/`.
5. Register or reuse the current project. Include its actual repository path, remote URL, default branch, context files, validation commands, safety rules, and applicable standards.
6. Start the local UI and verify `http://127.0.0.1:4317/api/health`. Do not bind to a public interface.
7. Return the board URL, registered project, validation result, and any optional setup that remains.

## Optional Capabilities Require Separate Consent

Explain the boundary and obtain explicit approval before:

- installing always-on macOS LaunchAgents;
- creating or installing GitHub Apps;
- allowing unattended GitHub writes or PR creation;
- enabling Trust Leads QA integration;
- configuring external notifications;
- enabling release or deployment automation.

Never ask the user to paste a private key, access token, password, production secret, customer data, or repository content into StudioOps.

## Failure Handling

- Report the exact failed prerequisite or command.
- Preserve existing repositories, configurations, and runtime data.
- Do not claim setup succeeded until the health endpoint and project registration are verified.
- Do not dispatch builders merely because installation completed.
