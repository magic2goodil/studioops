# Mission Control Notifier

The notifier is the local handoff layer.

It sends macOS notifications when:

- a task reaches owner review through a `notify_owner` run
- a task reaches Trust Leads local QA through a `notify_qa_review` run
- a Trust Leads QA integration bundle is validated through a `qa_bundle_ready` run
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

That prevents repeat notifications every sweep.

`notify_qa_review` and `qa_bundle_ready` use the same notification marker fields. They mean "review the local QA bundle before production," not "deploy this."

QA integration blockers should not sit silently. The dispatcher routes `qa_integration_blocked` actions back to a builder remediation run so conflicts, dirty worktrees, validation failures, and push failures can be fixed before owner QA.

## Safety

This notifier is intentionally local-only. It uses macOS `osascript` to display a notification on the owner machine.

Project/customer-facing notifications should be separate, explicit product work with privacy, consent, unsubscribe, and audit behavior defined on the task.
