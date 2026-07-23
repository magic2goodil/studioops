# StudioOps Systems Architect

The systems architect is the durable planning gate before builders for broad apps, platforms, epics, and mockup-driven product work.

The role is pinned to `gpt-5.6-sol` with `xhigh` reasoning. It does not edit product code, open a feature PR, merge, or deploy.

## When It Runs

StudioOps routes work to `systems-architect` when:

- a task explicitly sets `architectureRequired`
- an epic is queued for delivery
- a task describes an app, platform, product, system, dashboard, portal, website, mobile/native experience, mockup, or redesign, with or without a visual attachment

Small bugs and isolated visual corrections can explicitly waive architecture with `--no-architecture-required`.

Tasks move through:

```text
architecture_pending -> architecture_in_progress -> architecture_ready
```

Implementation child tasks become `ready` only after they are linked to the completed architecture.

## Required Decision Record

The architect must inspect the repository and every supplied asset before deciding:

- canonical assets, including the exact logo and image sources builders must use
- screen, component, interaction, and state decomposition
- runtime and service boundaries
- data ownership, schema, migrations, indexes, query shape, pagination, and retention
- API, event, background-job, idempotency, and consistency contracts
- cache or queue use, including the measured requirement that justifies each added system
- authentication, authorization, privacy, consent, abuse controls, secrets, and audit behavior
- loading, empty, error, retry, offline, degraded, and recovery behavior
- payload, query, rendering, and latency budgets
- observability, backups, restore behavior, and operational ownership
- local services, seed data, health checks, and end-to-end QA
- material rejected alternatives and why the chosen option is simpler or safer

Redis, RabbitMQ, fanout, microservices, or any other infrastructure are not defaults. They are selected only when the workload needs their specific semantics.

## Builder Task Graph

Broad work must be broken into dependency-linked child tasks. Each task receives:

- the architecture constraints it consumes
- a narrow lane and file scope
- relevant mockups and canonical assets
- observable functional acceptance criteria
- data/API/event contracts
- validation and local QA expectations
- `--parent <architecture-task-id>` and `--architecture-approved` so StudioOps stages the child as governed but non-buildable

After creating the child tasks, the architect records the durable handoff:

```bash
studioops architecture-complete task_123 \
  --body "Architecture summary and material decisions..." \
  --task-ids "task_124,task_125,task_126"
```

Every architecture pass requires at least one implementation child task. Completion verifies that every listed task is in the same project, parent-linked, explicitly staged, fully shaped with the required delivery fields, and part of an acyclic dependency graph. Only then does one transaction mark the architecture complete and the governed children inherited/ready. The runner treats a process exit without that valid record as a failed architecture handoff.

## Functional Default

A mockup is evidence of presentation and interaction intent. It is not authorization to deliver a static replica.

Unless a task is explicitly `visual-only`, the architecture and child tasks must cover working controls, real data boundaries, durable persistence, authorization, bounded loading, empty/error/retry states, executable behavior tests, and a coherent local QA path.
