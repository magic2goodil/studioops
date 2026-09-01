import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNotificationOutboxInState,
  deliverNotificationOutboxItem,
  enqueueOwnerQaNotificationsInState,
  escalateDueNotificationsInState,
  notificationForBundle,
  notificationForOwnerQaPacket,
  notificationRetryReady,
} from "../src/notifier.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";

const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);

function qaReadyState() {
  const manifest = {
    candidateId: "candidate_1",
    projectId: "project_1",
    base: { branch: "main", sha: BASE_SHA },
    sources: [{
      taskId: "task_1",
      sourceRef: "refs/heads/codex/task-1",
      headSha: SOURCE_SHA,
      candidateCycle: 1,
      reviews: [{
        id: "review_1",
        stageKey: "lead",
        role: "lead-reviewer",
        outcome: "approved",
        subjectSha: SOURCE_SHA,
        candidateCycle: 1,
        reviewedAt: "2026-08-17T00:00:00.000Z",
      }],
    }],
    integration: { branch: "qa/demo", sha: INTEGRATION_SHA },
    checks: [{
      id: "check_1",
      kind: "local-validation",
      name: "npm run check",
      outcome: "passed",
      subjectSha: INTEGRATION_SHA,
      evidenceDigest: `sha256:${"d".repeat(64)}`,
    }],
    preview: {
      url: "http://127.0.0.1:4174/",
      status: "healthy",
      commitSha: INTEGRATION_SHA,
      verifiedAt: "2026-08-17T00:01:00.000Z",
      attestation: { kind: "header", key: "x-studioops-commit", observedSha: INTEGRATION_SHA },
    },
    assembly: { mode: "atomic", requestedTaskIds: ["task_1"], includedTaskIds: ["task_1"], excludedTaskIds: [] },
  };
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest,
    createdAt: "2026-08-17T00:01:00.000Z",
  });
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      notificationPolicy: { channels: ["in_app", "macos"], acknowledgementTimeoutMs: 60_000 },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Verify notification handoff",
      acceptanceCriteria: ["The owner receives one exact-SHA QA packet."],
      prUrl: "https://github.com/example/demo/pull/1",
    }],
    qaBundles: [{
      id: "qa_bundle_1",
      projectId: "project_1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
    }],
    candidates: [candidate],
    notificationOutbox: [],
  };
}

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
  assert.match(notification.body, /Ready to test locally: Fix map categories; Clarify Discover and Map/);
  assert.doesNotMatch(notification.body, /task_126|task_127/);
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

test("QA notification enqueue is manifest-idempotent and desktop text is exact-SHA scoped", () => {
  const state = qaReadyState();
  const candidate = state.candidates[0];
  const first = enqueueOwnerQaNotificationsInState(state, candidate, { now: "2026-08-17T00:02:00.000Z" });
  const second = enqueueOwnerQaNotificationsInState(state, candidate, { now: "2026-08-17T00:03:00.000Z" });

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(state.notificationOutbox.length, 2);
  assert.deepEqual(candidate.qaPacket.actions.map((item) => item.action), ["pass", "fail", "request_changes", "defer", "open_candidate"]);
  const notification = notificationForOwnerQaPacket(candidate.qaPacket);
  assert.match(notification.body, /Ready to test: Verify notification handoff/);
  assert.match(notification.body, /Approval applies only to tested SHA c{12}/);
  assert.doesNotMatch(notification.body, /127\.0\.0\.1|Users\//);
});

test("outbox claims are leased, stale claims recover, and active claims do not duplicate", () => {
  const state = qaReadyState();
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], { now: "2026-08-17T00:02:00.000Z" });
  const first = claimNotificationOutboxInState(state, {
    ids: [state.notificationOutbox[0].id],
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
    claimLeaseMs: 10_000,
  });
  const duplicate = claimNotificationOutboxInState(state, {
    ids: [state.notificationOutbox[0].id],
    nowMs: Date.parse("2026-08-17T00:03:05.000Z"),
  });
  const recovered = claimNotificationOutboxInState(state, {
    ids: [state.notificationOutbox[0].id],
    nowMs: Date.parse("2026-08-17T00:03:11.000Z"),
  });

  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);
  assert.equal(recovered.length, 1);
  assert.notEqual(recovered[0].claimToken, first[0].claimToken);
  assert.equal(recovered[0].attempts, 2);
});

test("email fails closed without an adapter and macOS delivery receives rendered text", async () => {
  const state = qaReadyState();
  enqueueOwnerQaNotificationsInState(state, state.candidates[0]);
  const packet = state.candidates[0].qaPacket;
  await assert.rejects(
    () => deliverNotificationOutboxItem({ channel: "email", packet }),
    /without a delivery adapter/,
  );
  let delivered;
  await deliverNotificationOutboxItem({ channel: "macos", packet }, {
    sendMac: async (notification) => { delivered = notification; },
  });
  assert.match(delivered.body, /tested SHA/);
});

test("delivered notifications escalate once after their acknowledgement deadline", () => {
  const state = qaReadyState();
  state.notificationOutbox.push({
    id: "notification_1",
    status: "delivered",
    acknowledgementDueAt: "2026-08-17T00:04:00.000Z",
  });
  const escalated = escalateDueNotificationsInState(state, {
    nowMs: Date.parse("2026-08-17T00:05:00.000Z"),
  });
  const duplicate = escalateDueNotificationsInState(state, {
    nowMs: Date.parse("2026-08-17T00:06:00.000Z"),
  });
  assert.equal(escalated.length, 1);
  assert.equal(state.notificationOutbox[0].status, "escalated");
  assert.equal(duplicate.length, 0);
});
