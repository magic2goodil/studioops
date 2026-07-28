import assert from "node:assert/strict";
import test from "node:test";
import { notificationForBundle, renderEmailNotification } from "../src/notifier.js";

test("notification and email transports share the StudioOps envelope", () => {
  const envelope = notificationForBundle({
    projectKey: "demo",
    status: "ready",
    tasks: [{ id: "task_91", title: "Canonicalize notifications" }],
  });

  assert.equal(envelope.subject, "StudioOps QA bundle ready");
  assert.equal(envelope.title, "StudioOps QA bundle ready");
  assert.equal(envelope.actionUrl, "http://127.0.0.1:4317/tasks/task_91");

  const email = renderEmailNotification(envelope);
  assert.equal(email.subject, envelope.subject);
  assert.match(email.body, /StudioOps/);
  assert.match(email.body, /http:\/\/127\.0\.0\.1:4317\/tasks\/task_91/);
});
