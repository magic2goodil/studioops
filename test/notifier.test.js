import assert from "node:assert/strict";
import test from "node:test";
import { notificationForBundle, notificationRetryReady } from "../src/notifier.js";

test("QA bundles produce one checklist notification with the preview URL", () => {
  const notification = notificationForBundle({
    projectKey: "event-horizons-web",
    status: "ready",
    previewUrl: "http://127.0.0.1:4174/",
    tasks: [
      { id: "task_126", title: "Fix map categories" },
      { id: "task_127", title: "Clarify Discover and Map" },
    ],
  });

  assert.equal(notification.title, "StudioOps QA bundle ready");
  assert.match(notification.body, /task_126 Fix map categories/);
  assert.match(notification.body, /task_127 Clarify Discover and Map/);
  assert.match(notification.body, /127\.0\.0\.1:4174/);
});

test("release candidates notify with their PR and exhausted notification retries stop", () => {
  const notification = notificationForBundle({
    projectKey: "event-horizons-web",
    status: "release_candidate_ready",
    promotionPrUrl: "https://github.com/example/event-horizon/pull/42",
    tasks: [{ id: "task_126", title: "Fix map categories" }],
  });

  assert.equal(notification.title, "StudioOps release candidate ready");
  assert.match(notification.body, /pull\/42/);
  assert.equal(notificationRetryReady({ notificationStatus: "failed", notificationAttempts: 3 }), false);
  assert.equal(notificationRetryReady({ notificationStatus: "failed", notificationAttempts: 2 }), true);
});
