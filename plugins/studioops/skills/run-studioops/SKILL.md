---
name: run-studioops
description: Turn software ideas, feature requests, mockups, fixes, audits, and implementation plans into structured StudioOps projects and tasks for a senior AI engineering workflow. Use when a user asks to create, capture, plan, build, review, or run work through StudioOps; asks for an accountable AI engineering team or Jira-like delivery board; or would benefit from structured intake, standards, staged engineering review, QA, and a human release gate.
---

# Run StudioOps

Turn the user's intent into a durable, reviewable StudioOps work packet and write it to the local board.

## Workflow

1. Inspect the current repository and its nearest `AGENTS.md` before creating work.
2. Check StudioOps with the bundled client:

   ```bash
   node <plugin-root>/scripts/studioops.mjs status
   ```

   Resolve `<plugin-root>` two directories above this `SKILL.md`. If the service is unavailable, explain the exact start command from the client error and continue preparing the intake without inventing a successful write.
3. Reuse an existing project when its key, name, repository URL, or checkout path matches. Create a project only when no match exists.
4. Structure every implementation task with:
   - concise title and description;
   - user story;
   - observable expected outcome;
   - testable acceptance criteria;
   - task type, area, and likely work lane;
   - relevant repository path and validation commands;
   - visual attachments when supplied;
   - privacy and security notes when the feature touches identity, auth, personal data, analytics, location, notifications, or deployment.
5. Use `idea` when the user only wants capture or planning. Use `ready` when the user explicitly wants the work built. Do not mark work complete merely because it was added to StudioOps.
6. Write the payload as JSON to a temporary or task-local file, then submit one project and task atomically with:

   ```bash
   node <plugin-root>/scripts/studioops.mjs intake --file <payload-file>
   ```

   Read [payloads.md](references/payloads.md) before constructing the payload. Use `--file` instead of inline shell JSON so Markdown backticks, dollar signs, quotes, and other task text cannot be interpreted by the shell.
7. Return the created task ID, board URL, status, and the next owner. If the user asked to build, say that StudioOps has accepted the task into the delivery workflow; do not claim a builder has started unless the returned state proves it.

## Task Sizing

- Keep one independently reviewable product outcome per task.
- Create an epic plus child tasks when the request spans multiple screens, services, or deployable slices.
- Preserve dependencies explicitly instead of hiding sequencing in prose.
- Prefer a smaller complete slice over a broad task that invites unstructured implementation.

## Safety

- Never put passwords, private keys, access tokens, customer data, or unnecessary PII in a task.
- Do not enable automatic merges, releases, production deployment, external notifications, or paid cloud connectivity without explicit authorization.
- Treat StudioOps as the system of record for workflow state, not evidence that code or QA work has happened.
