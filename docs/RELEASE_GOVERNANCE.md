# Standing Release Governance Contract

Standing production release authorization is off when a project has no
`standingReleaseAuthorizationHistory` entry without a revocation. Status labels,
task dependencies, candidate records, and configuration defaults do not imply a
grant. This contract only records authority; it does not activate production
release execution.

## Local project update contract

Grant authority with the existing local `PATCH /api/projects/:project` contract:

```json
{
  "standingReleaseAuthorization": {
    "action": "grant",
    "authorizationId": "authorization_opaque_01",
    "ownerActorId": "owner_actor_opaque_01",
    "grantedAt": "2026-08-16T12:00:00.000Z",
    "repository": "owner/repository",
    "targetHostname": "release.example.com",
    "deploymentWorkflow": ".github/workflows/deploy.yml",
    "environment": "production",
    "artifactName": "web-dist",
    "healthPath": "/healthz",
    "rollbackWorkflow": ".github/workflows/rollback.yml",
    "rollbackReference": "refs/tags/v1.2.2"
  }
}
```

The repository is canonicalized to lowercase `owner/repository`. The hostname
contains no scheme, port, wildcard, credentials, or path. Workflows, environment,
artifact, health path, and rollback reference are bounded coordinates, not raw
provider payloads. Every persisted coordinate rejects control characters,
credential and secret-assignment shapes, and local filesystem paths before the
project transaction can commit. Actor and authorization IDs are opaque
identifiers; names and email addresses are not accepted as identities.

Only one project may have an active grant. A project must revoke its active
grant before reauthorization, and reauthorization appends a new ID and record.
The update fails atomically on an incomplete grant, malformed binding, reused ID,
or active-grant conflict. Project creation cannot import history or create an
active grant; it always starts at the default-off boundary.

Revoke authority with:

```json
{
  "standingReleaseAuthorization": {
    "action": "revoke",
    "authorizationId": "authorization_opaque_01",
    "revokedByActorId": "owner_actor_opaque_02",
    "revokedAt": "2026-08-16T13:00:00.000Z",
    "reasonCode": "owner_requested"
  }
}
```

Revocation only adds the bounded revocation object. It cannot replace grant
bindings, be removed, or be recorded twice. Direct writes to
`standingReleaseAuthorizationHistory` through the project update contract are
rejected. Grant and revocation timestamps must name real ISO-8601 calendar
instants, and revocation cannot precede its grant. Grant and revoke events
contain only project and authorization IDs, generic messages, and timestamps;
repository, hostname, actor, local path, credential, customer, and provider
payload data stay out of events.

## Operational capability blockers

Product dependencies remain project-local. `dependsOnTaskIds` rejects a task in
another project. Cross-project runtime readiness is represented separately:

```json
{
  "operationalCapabilityBlockers": [
    {
      "capabilityKey": "standing-production-release",
      "governingTaskId": "task_534"
    }
  ]
}
```

The stored relation is normalized with `scope: "release"`. It may name a
capability key, an existing governing task, or both. Builder and reviewer routing
does not consume this relation; a future release-boundary planner must evaluate
it before creating production work. It never enters task dependency ordering.

## Ownership, validation, and rollback

The executable ownership and dependency graph is
[`release-governance-ownership.json`](release-governance-ownership.json). The
graph is acyclic and assigns configuration, store policy, routing, promotion,
notification, tests, and documentation to bounded components.

This public authorization, persistence, dependency, event, workflow, and
deployment contract is always `full-regression`. The required aggregate is
`npm run check`, supplemented by the targeted policy/persistence command and
`git diff --check`. Rollback may make the new project fields inert but must not
erase authorization or revocation history. No rollback converts mutable task
status into release authority.
