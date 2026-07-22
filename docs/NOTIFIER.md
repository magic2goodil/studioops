# StudioOps Notifier

The notifier is the local handoff layer.

It sends macOS notifications when:

- a task reaches owner review through a `notify_owner` run
- a task reaches Trust Leads local QA through a `notify_qa_review` run
- a coherent Trust Leads QA integration bundle is validated and its local preview passes health checks
- owner-QA-passed work has a validated release-candidate PR ready
- an automated runner run fails

It does not:

- approve work
- merge PRs
- deploy production
- send email, SMS, Discord, push notifications, or customer-facing messages

## Preview Notifications

```bash
npm run notifier -- --plan
```

## Send Once

```bash
npm run notifier
```

## Run Continuously

```bash
npm run notifier -- --watch --interval 60
```

The LaunchAgent example lives at:

```text
deploy/local/com.codex.mission-control.notifier.plist.example
```

## Behavior

Owner handoff notifications are marked on the run with:

- `externalNotifiedAt`
- `notificationStatus`
- `notificationChannel`

Failed runner notifications are marked with:

- `failureNotifiedAt`
- `notificationStatus`
- `notificationChannel`

That prevents repeat notifications every sweep. Delivery failures retry up to three times with backoff; they are then retained as visible failures rather than retried forever.

QA and release-candidate notifications are stored on the QA bundle, so one coherent batch creates one owner interruption instead of one notification per task. They mean "review this bundle or PR," not "deploy this."

Feature merge conflicts and validation failures route to builder remediation. A local preview restart or health failure routes to infrastructure repair, not back through the feature builder loop.

## Safety

This notifier is intentionally local-only. It uses macOS `osascript` to display a notification on the owner machine.

Project/customer-facing notifications should be separate, explicit product work with privacy, consent, unsubscribe, and audit behavior defined on the task.
