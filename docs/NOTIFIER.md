# Mission Control Notifier

The notifier is the local handoff layer.

It sends macOS notifications when:

- a task reaches owner review through a `notify_owner` run
- a task reaches Trust Leads local QA through a `notify_qa_review` run
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

`notify_qa_review` uses the same notification marker fields. It means "review the local QA bundle before production," not "deploy this."

## Safety

This notifier is intentionally local-only. It uses macOS `osascript` to display a notification on the owner machine.

Project/customer-facing notifications should be separate, explicit product work with privacy, consent, unsubscribe, and audit behavior defined on the task.
