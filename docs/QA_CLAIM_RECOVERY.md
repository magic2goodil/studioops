# Recovering an abandoned QA claim

A running QA sweep is separate from queued builder work. An empty task queue can
still have active branch synchronization, validation or preview work. Never
interrupt that work or remove its claim to make a release appear idle.

If a worker exits before its result is persisted, an operator can inspect one
exact claim whose process is absent on the same host:

```sh
node src/mission-control-cli.js qa-recover-claim \
  --project-id project_1 --claim-id EXACT_CLAIM_ID --fence 7 \
  --owner-pid 12345 --owner-host HOSTNAME
```

The command is read-only by default. Add `--apply` only after reviewing the
current identity and operational evidence. Recovery checks the current claim
and owner again on every persistence attempt. Live processes, PID reuse,
foreign hosts, uncertain process permissions, changed claims and maintenance
fences prevent recovery. It preserves the complete original claim in
abandonment history, keeps its expiry and fence, and records a terminal
`owner_process_absent` outcome. It does not claim QA passed, start another job,
clear history, change schedules, or authorize a release. Repeating the exact
completed recovery is read-only.

Failed empty-queue branch synchronization records its remote refs, project
authority and validation runtime. An unchanged failure is held before cloning,
validation or preview work. Changed refs, policy, runtime or actual queued tasks
remain eligible. Explicit `qa-integrate --force` is an operator-requested retry;
routine timers do not use it. Default validation resolves Node from the worker's
runtime directory before generic system installations. Explicit validation PATH
configuration remains subject to the existing trusted-path checks.

Recovery does not replace the normal global-idle, exact-candidate QA, lead review,
maintenance, backup or release requirements.
