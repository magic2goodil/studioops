import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNotificationOutboxDeliveryInState,
  claimNotificationOutboxInState,
  deliverNotificationOutboxItem,
  enqueueFailureCircuitNotificationsInState,
  enqueueOwnerQaNotificationsInState,
  enqueueReleaseCandidateNotificationsInState,
  escalateDueNotificationsInState,
  notificationForBundle,
  notificationForFailureCircuit,
  notificationForOwnerQaPacket,
  notificationForPipelineStall,
  notificationRetryReady,
  planNotifications,
  reconcilePipelineLivenessNotificationInState,
  sendPendingNotifications,
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
      repoUrl: "https://github.com/example/demo",
      notificationPolicy: { channels: ["in_app", "macos"], acknowledgementTimeoutMs: 60_000 },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Verify notification handoff",
      status: "qa_review",
      assignedAgentRole: "owner",
      stateVersion: 1,
      acceptanceCriteria: ["The owner receives one exact-SHA QA packet."],
      prUrl: "https://github.com/example/demo/pull/1",
      branchName: "codex/task-1",
      candidateId: candidate.id,
      qaBundleId: "qa_bundle_1",
      candidateManifestDigest: candidate.manifestDigest,
      integrationStatus: "ready",
      integrationCommit: INTEGRATION_SHA,
    }],
    qaBundles: [{
      id: "qa_bundle_1",
      projectId: "project_1",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      status: "ready",
      integrationBranch: "qa/demo",
      integrationCommit: INTEGRATION_SHA,
      previewUrl: "http://127.0.0.1:4174/",
      tasks: [{ id: "task_1", title: "Verify notification handoff" }],
    }],
    candidates: [candidate],
    notificationOutbox: [],
  };
}

function releaseReadyState() {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  const candidate = state.candidates[0];
  enqueueOwnerQaNotificationsInState(state, candidate, {
    now: "2026-08-17T00:02:00.000Z",
  });
  state.notificationOutbox = [];
  candidate.status = "release_candidate_ready";
  candidate.qaDecision = {
    outcome: "passed",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    ownerQaPacketDigest: candidate.qaPacket.packetDigest,
    taskIds: ["task_1"],
    author: "Owner QA",
    repositoryVerifiedAt: "2026-08-17T00:02:30.000Z",
    decidedAt: "2026-08-17T00:02:31.000Z",
  };
  candidate.promotion = {
    branch: "qa/promotion-demo",
    prUrl: "https://github.com/example/demo/pull/42",
    commitSha: INTEGRATION_SHA,
    manifestDigest: candidate.manifestDigest,
  };
  state.tasks[0].status = "user_review";
  Object.assign(state.qaBundles[0], {
    status: "release_candidate_ready",
    qaDecision: candidate.qaDecision,
    promotionBranch: candidate.promotion.branch,
    promotionPrUrl: candidate.promotion.prUrl,
    promotionCommit: candidate.promotion.commitSha,
    promotedTaskIds: ["task_1"],
  });
  return state;
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

test("release candidates are enqueued on the claimed exact-authority path", async () => {
  const state = releaseReadyState();
  const enqueued = enqueueReleaseCandidateNotificationsInState(state, {
    now: "2026-08-17T00:03:00.000Z",
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, "release_candidate");
  assert.equal(enqueued[0].promotionPrUrl, "https://github.com/example/demo/pull/42");

  let deliveryCalls = 0;
  const report = await sendPendingNotifications({
    state,
    nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
    sendMac: async (notification) => {
      deliveryCalls += 1;
      assert.equal(notification.title, "StudioOps release candidate ready");
      assert.match(notification.body, /pull\/42/);
    },
  });
  assert.equal(deliveryCalls, 1);
  assert.equal(report.sent.length, 1);
  assert.ok(Number.isFinite(Date.parse(state.qaBundles[0].promotionNotifiedAt)));
});

test("release notification authority rejects a promotion PR in another repository", () => {
  const state = releaseReadyState();
  state.candidates[0].promotion.prUrl = "https://github.com/attacker/forged-release/pull/42";
  state.qaBundles[0].promotionPrUrl = state.candidates[0].promotion.prUrl;

  const enqueued = enqueueReleaseCandidateNotificationsInState(state, {
    now: "2026-08-17T00:03:00.000Z",
  });

  assert.deepEqual(enqueued, []);
  assert.deepEqual(state.notificationOutbox, []);
});

test("release notification loses delivery authority when the project repository drifts after enqueue", async () => {
  const state = releaseReadyState();
  const enqueued = enqueueReleaseCandidateNotificationsInState(state, {
    now: "2026-08-17T00:03:00.000Z",
  });
  assert.equal(enqueued.length, 1);
  state.projects[0].repoUrl = "https://github.com/example/other-repository";

  let deliveryCalls = 0;
  const report = await sendPendingNotifications({
    state,
    nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.equal(deliveryCalls, 0);
  assert.equal(report.sent.length, 0);
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "qa_authority_changed");
});

test("a forged release handoff cannot retain delivery authority when every notification mirror is rewritten", async () => {
  const state = releaseReadyState();
  enqueueReleaseCandidateNotificationsInState(state, {
    now: "2026-08-17T00:03:00.000Z",
  });
  const forgedPrUrl = "https://github.com/attacker/forged-release/pull/42";
  state.candidates[0].promotion.prUrl = forgedPrUrl;
  state.qaBundles[0].promotionPrUrl = forgedPrUrl;
  state.notificationOutbox[0].promotionPrUrl = forgedPrUrl;

  let deliveryCalls = 0;
  const report = await sendPendingNotifications({
    state,
    nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.equal(deliveryCalls, 0);
  assert.equal(report.sent.length, 0);
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "qa_authority_changed");
});

test("release delivery rejects stale QA decisions and promotion mirrors after enqueue", async (t) => {
  const cases = [
    ["candidate QA decision", (state) => {
      state.candidates[0].qaDecision.integrationSha = SOURCE_SHA;
    }],
    ["bundle QA decision", (state) => {
      state.qaBundles[0].qaDecision = {
        ...state.qaBundles[0].qaDecision,
        author: "Forged reviewer",
      };
    }],
    ["bundle promotion commit", (state) => {
      state.qaBundles[0].promotionCommit = SOURCE_SHA;
    }],
    ["bundle promoted task membership", (state) => {
      state.qaBundles[0].promotedTaskIds = [];
    }],
  ];

  for (const [name, mutateAuthority] of cases) {
    await t.test(name, async () => {
      const state = releaseReadyState();
      const enqueued = enqueueReleaseCandidateNotificationsInState(state, {
        now: "2026-08-17T00:03:00.000Z",
      });
      assert.equal(enqueued.length, 1);
      mutateAuthority(state);
      let deliveryCalls = 0;
      const report = await sendPendingNotifications({
        state,
        nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
        sendMac: async () => { deliveryCalls += 1; },
      });
      assert.equal(deliveryCalls, 0);
      assert.equal(report.sent.length, 0);
      assert.equal(state.notificationOutbox[0].status, "acknowledged");
      assert.equal(state.notificationOutbox[0].resolutionReason, "qa_authority_changed");
    });
  }
});

test("revocation terminalizes delivered, deferred, and escalated QA notifications", () => {
  const state = releaseReadyState();
  enqueueReleaseCandidateNotificationsInState(state, {
    now: "2026-08-17T00:03:00.000Z",
  });
  const original = state.notificationOutbox[0];
  state.notificationOutbox = ["delivered", "deferred", "escalated"].map((status, index) => ({
    ...structuredClone(original),
    id: `notification_stale_${index}`,
    idempotencyKey: `${original.idempotencyKey}:${status}`,
    status,
    deliveredAt: status === "delivered" ? "2026-08-17T00:03:01.000Z" : "",
    acknowledgementDueAt: status === "delivered" ? "2026-08-17T00:03:02.000Z" : "",
  }));
  state.candidates[0].qaRevocationIntent = { pending: true };

  const escalated = escalateDueNotificationsInState(state, {
    nowMs: Date.parse("2026-08-17T00:04:00.000Z"),
  });

  assert.equal(escalated.length, 0);
  assert.ok(state.notificationOutbox.every((item) => item.status === "acknowledged"));
  assert.ok(state.notificationOutbox.every((item) => item.resolutionReason === "qa_authority_changed"));
  assert.equal(state.notificationOutbox[0].deliveredAt, "2026-08-17T00:03:01.000Z");
});

test("pending release revocation suppresses release-ready delivery before and after claim", async () => {
  const beforeClaim = releaseReadyState();
  beforeClaim.candidates[0].qaRevocationIntent = { pending: true };
  let deliveryCalls = 0;
  const suppressed = await sendPendingNotifications({
    state: beforeClaim,
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
    sendMac: async () => { deliveryCalls += 1; },
  });
  assert.equal(deliveryCalls, 0);
  assert.equal(suppressed.pending.length, 0);

  const afterClaim = releaseReadyState();
  const raced = await sendPendingNotifications({
    state: afterClaim,
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
    beforeOutboxDelivery: async () => {
      afterClaim.candidates[0].qaRevocationIntent = { pending: true };
    },
    sendMac: async () => { deliveryCalls += 1; },
  });
  assert.equal(deliveryCalls, 0);
  assert.equal(raced.sent.length, 0);
  assert.ok(raced.skipped.some((item) => item.reason === "qa_authority_changed"));
});

test("reassignment suppresses both owner-QA and release notifications", async (t) => {
  for (const [name, createState, enqueue] of [
    ["owner QA", qaReadyState, (state) => enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
      now: "2026-08-17T00:02:00.000Z",
    })],
    ["release", releaseReadyState, (state) => enqueueReleaseCandidateNotificationsInState(state, {
      now: "2026-08-17T00:03:00.000Z",
    })],
  ]) {
    await t.test(name, async () => {
      const state = createState();
      state.projects[0].notificationPolicy.channels = ["macos"];
      assert.equal(enqueue(state).length, 1);
      state.tasks[0].assignedAgentRole = "builder";
      let deliveryCalls = 0;
      const report = await sendPendingNotifications({
        state,
        nowMs: Date.parse("2026-08-17T00:04:00.000Z"),
        sendMac: async () => { deliveryCalls += 1; },
      });
      assert.equal(deliveryCalls, 0);
      assert.equal(report.sent.length, 0);
      assert.equal(state.notificationOutbox[0].status, "acknowledged");
      assert.equal(state.notificationOutbox[0].resolutionReason, "qa_authority_changed");
    });
  }
});

test("QA notification enqueue is manifest-idempotent and desktop text is exact-SHA scoped", () => {
  const state = qaReadyState();
  const candidate = state.candidates[0];
  const first = enqueueOwnerQaNotificationsInState(state, candidate, { now: "2026-08-17T00:02:00.000Z" });
  const second = enqueueOwnerQaNotificationsInState(state, candidate, { now: "2026-08-17T00:03:00.000Z" });

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(state.notificationOutbox.length, 2);
  assert.equal(state.qaBundles[0].packetDigest, candidate.qaPacket.packetDigest);
  assert.deepEqual(state.qaBundles[0].qaPacket, candidate.qaPacket);
  assert.deepEqual(candidate.qaPacket.actions.map((item) => item.action), ["pass", "fail", "request_changes", "defer", "open_candidate"]);
  const notification = notificationForOwnerQaPacket(candidate.qaPacket);
  assert.match(notification.body, /Ready to test: Verify notification handoff/);
  assert.match(notification.body, /Approval applies only to tested SHA c{12}/);
  assert.doesNotMatch(notification.body, /127\.0\.0\.1|Users\//);
});

test("canonical owner-QA outbox suppresses the duplicate legacy bundle notification", async () => {
  const state = qaReadyState();
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  const plan = await planNotifications({ state });
  assert.equal(plan.pending.length, 2);
  assert.ok(plan.pending.every((item) => item.notificationType === "outbox"));
  assert.deepEqual(plan.skipped, [{ bundleId: "qa_bundle_1", reason: "canonical_owner_qa_outbox" }]);
});

test("modern QA bundles never fall through to the legacy notifier when their outbox is missing", async (t) => {
  const cases = [
    ["candidate and manifest identity", (state) => {
      state.candidates = [];
    }],
    ["current packet identity", (state) => {
      const bundle = state.qaBundles[0];
      const candidate = state.candidates[0];
      enqueueOwnerQaNotificationsInState(state, candidate, {
        now: "2026-08-17T00:02:00.000Z",
      });
      delete bundle.candidateId;
      delete bundle.manifestDigest;
      state.candidates = [];
    }],
    ["candidate association", (state) => {
      const bundle = state.qaBundles[0];
      delete bundle.candidateId;
      delete bundle.manifestDigest;
    }],
  ];

  for (const [name, prepare] of cases) {
    await t.test(name, async () => {
      const state = qaReadyState();
      prepare(state);
      state.notificationOutbox = [];
      const plan = await planNotifications({ state });
      assert.equal(plan.pending.length, 0);
      assert.deepEqual(plan.skipped, [{
        bundleId: "qa_bundle_1",
        reason: "canonical_owner_qa_outbox_missing",
      }]);
    });
  }
});

test("a deleted modern QA outbox cannot legacy-send after task authority drifts", async () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  state.notificationOutbox = [];
  state.tasks[0].assignedAgentRole = "builder";
  let deliveryCalls = 0;

  const report = await sendPendingNotifications({
    state,
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.equal(deliveryCalls, 0);
  assert.equal(report.pending.length, 0);
  assert.deepEqual(report.skipped, [{
    bundleId: "qa_bundle_1",
    reason: "canonical_owner_qa_outbox_missing",
  }]);
});

test("an explicit empty channel list yields no pending notification and no Mac delivery", async () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  let deliveryCalls = 0;

  const report = await sendPendingNotifications({
    state,
    channels: [],
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.equal(deliveryCalls, 0);
  assert.equal(report.pending.length, 0);
  assert.ok(report.skipped.some((item) => (
    item.notificationId === state.notificationOutbox[0].id
    && item.reason === "notification_channel_disabled"
  )));
});

test("a channel disabled after claim is fenced before the Mac adapter", async () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  let deliveryCalls = 0;

  const report = await sendPendingNotifications({
    state,
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
    beforeOutboxDelivery: async () => {
      state.projects[0].notificationPolicy.channels = [];
    },
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.equal(deliveryCalls, 0);
  assert.equal(report.sent.length, 0);
  assert.ok(report.skipped.some((item) => item.reason === "notification_channel_disabled"));
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "notification_channel_disabled");
});

test("truly legacy QA bundles retain Mac fallback only when that channel is enabled", async () => {
  const state = {
    projects: [{
      id: "project_legacy",
      key: "legacy",
      notificationPolicy: { channels: ["macos"] },
    }],
    qaBundles: [{
      id: "qa_bundle_legacy",
      projectId: "project_legacy",
      projectKey: "legacy",
      status: "ready",
      tasks: [{ id: "task_legacy", title: "Legacy QA task" }],
    }],
    candidates: [],
    notificationOutbox: [],
  };

  const enabled = await planNotifications({ state });
  const disabled = await planNotifications({ state, channels: [] });

  assert.equal(enabled.pending.length, 1);
  assert.equal(enabled.pending[0].notificationType, "qa_bundle");
  assert.equal(disabled.pending.length, 0);
  assert.deepEqual(disabled.skipped, [{
    bundleId: "qa_bundle_legacy",
    reason: "notification_channel_disabled",
  }]);
});

test("stale owner-QA notifications are skipped and terminalized before a claim", async () => {
  const state = qaReadyState();
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  state.candidates[0].status = "qa_passed";
  state.qaBundles[0].status = "passed";

  const plan = await planNotifications({ state });
  assert.equal(plan.pending.length, 0);
  assert.deepEqual(
    plan.skipped.map((item) => item.reason),
    ["qa_authority_changed", "qa_authority_changed"],
  );
  const claimed = claimNotificationOutboxInState(state, {
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
  });
  assert.equal(claimed.length, 0);
  assert.ok(state.notificationOutbox.every((item) => item.status === "acknowledged"));
  assert.ok(state.notificationOutbox.every((item) => item.resolutionReason === "qa_authority_changed"));
});

test("enqueue rejects a stored owner packet after current authority changes", () => {
  const state = qaReadyState();
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  state.projects[0].key = "changed-after-packet";
  assert.throws(
    () => enqueueOwnerQaNotificationsInState(state, state.candidates[0]),
    /packet no longer matches current project or task definitions/i,
  );
  assert.equal(state.notificationOutbox.length, 2);
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

test("pre-delivery authorization atomically acknowledges a claimed packet whose QA authority changed", () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  const [claim] = claimNotificationOutboxInState(state, {
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
  });
  state.candidates[0].status = "qa_passed";
  state.qaBundles[0].status = "passed";

  const authorization = authorizeNotificationOutboxDeliveryInState(state, {
    id: claim.id,
    claimToken: claim.claimToken,
    nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
  });

  assert.equal(authorization.authorized, false);
  assert.equal(authorization.reason, "qa_authority_changed");
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "qa_authority_changed");
  assert.equal(state.notificationOutbox[0].claimToken, undefined);
});

test("pre-delivery authorization durably records the exact owning claim", () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  const [claim] = claimNotificationOutboxInState(state, {
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
  });

  const authorization = authorizeNotificationOutboxDeliveryInState(state, {
    id: claim.id,
    claimToken: claim.claimToken,
    now: "2026-08-17T00:03:01.000Z",
    nowMs: Date.parse("2026-08-17T00:03:01.000Z"),
  });

  assert.equal(authorization.authorized, true);
  assert.equal(state.notificationOutbox[0].deliveryAuthorizedAt, "2026-08-17T00:03:01.000Z");
  assert.equal(state.notificationOutbox[0].deliveryAuthorizedClaimToken, claim.claimToken);
});

test("a revoked persisted claim cannot reach an external adapter after the worker resumes", async () => {
  const state = qaReadyState();
  state.projects[0].notificationPolicy.channels = ["macos"];
  enqueueOwnerQaNotificationsInState(state, state.candidates[0], {
    now: "2026-08-17T00:02:00.000Z",
  });
  let deliveryCalls = 0;
  let observedClaimToken = "";

  const report = await sendPendingNotifications({
    state,
    nowMs: Date.parse("2026-08-17T00:03:00.000Z"),
    beforeOutboxDelivery: async (claim) => {
      const persisted = state.notificationOutbox.find((item) => item.id === claim.id);
      assert.equal(persisted.status, "attempted");
      assert.equal(persisted.claimToken, claim.claimToken);
      observedClaimToken = claim.claimToken;
      persisted.status = "acknowledged";
      persisted.resolutionReason = "qa_authority_changed";
      delete persisted.claimToken;
      delete persisted.claimExpiresAt;
      state.candidates[0].status = "qa_passed";
      state.qaBundles[0].status = "passed";
    },
    sendMac: async () => { deliveryCalls += 1; },
  });

  assert.ok(observedClaimToken);
  assert.equal(deliveryCalls, 0);
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(report.sent.length, 0);
  assert.ok(report.skipped.some((item) => (
    item.notificationId === state.notificationOutbox[0].id
    && item.reason === "claim_lost"
  )));
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

test("pipeline stall notifications include cause and recovery and deduplicate until progress resumes", async () => {
  const state = {
    meta: {},
    projects: [{ id: "project_1", key: "demo", notificationPolicy: { channels: ["in_app"] } }],
    notificationOutbox: [],
    events: [],
  };
  const assessment = {
    stalled: true,
    fingerprint: "task_7:start_builder:no_executable_run_admitted",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_7",
    taskTitle: "Advance accepted work",
    taskUrl: "http://127.0.0.1:4317/tasks/task_7",
    cause: "no_executable_run_admitted",
    recoveryAction: "Inspect dispatcher admission and run it again.",
  };

  const first = reconcilePipelineLivenessNotificationInState(state, assessment, { now: "2026-09-03T13:00:00.000Z" });
  const duplicate = reconcilePipelineLivenessNotificationInState(state, assessment, { now: "2026-09-03T13:01:00.000Z" });
  const notification = notificationForPipelineStall(first.notifications[0]);

  assert.equal(first.notifications.length, 1);
  assert.equal(duplicate.notifications.length, 1);
  assert.equal(state.notificationOutbox.length, 1);
  assert.match(notification.subtitle, /task_7/);
  assert.match(notification.body, /Cause: no_executable_run_admitted/);
  assert.match(notification.body, /Recovery: Inspect dispatcher admission/);
  const plan = await planNotifications({ state });
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].notification.title, "StudioOps pipeline stalled");
  await deliverNotificationOutboxItem(plan.pending[0]);

  reconcilePipelineLivenessNotificationInState(state, { stalled: false }, { now: "2026-09-03T13:02:00.000Z" });
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "pipeline_recovered");
  assert.equal(state.notificationOutbox[0].resolvedAt, "2026-09-03T13:02:00.000Z");
  assert.equal((await planNotifications({ state })).pending.length, 0);

  const recurrence = reconcilePipelineLivenessNotificationInState(state, assessment, { now: "2026-09-03T13:03:00.000Z" });
  assert.equal(recurrence.notifications.length, 1);
  assert.equal(state.notificationOutbox.length, 2);
  assert.notEqual(recurrence.notifications[0].id, first.notifications[0].id);
  const recurrencePlan = await planNotifications({ state });
  assert.deepEqual(recurrencePlan.pending.map((item) => item.id), [recurrence.notifications[0].id]);
});

test("pipeline recovery terminalizes a retryable failed stall notification", async () => {
  const state = {
    meta: {},
    projects: [{ id: "project_1", key: "demo", notificationPolicy: { channels: ["in_app"] } }],
    notificationOutbox: [],
    events: [],
  };
  const assessment = {
    stalled: true,
    fingerprint: "task_8:start_builder:no_executable_run_admitted",
    projectId: "project_1",
    projectKey: "demo",
    taskId: "task_8",
    cause: "no_executable_run_admitted",
  };
  const first = reconcilePipelineLivenessNotificationInState(state, assessment, { now: "2026-09-03T14:00:00.000Z" });
  Object.assign(state.notificationOutbox[0], {
    status: "failed",
    attempts: 1,
    retryNotBefore: "2026-09-03T14:10:00.000Z",
  });

  reconcilePipelineLivenessNotificationInState(state, { stalled: false }, { now: "2026-09-03T14:02:00.000Z" });

  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].acknowledgedAt, "2026-09-03T14:02:00.000Z");
  assert.equal(state.notificationOutbox[0].acknowledgedBy, "pipeline_liveness_reconciliation");
  assert.equal(state.notificationOutbox[0].retryNotBefore, undefined);
  assert.equal((await planNotifications({ state })).pending.length, 0);
  assert.equal(claimNotificationOutboxInState(state, {
    ids: [first.notifications[0].id],
    nowMs: Date.parse("2026-09-03T14:11:00.000Z"),
  }).length, 0);
});

test("one unchanged failure circuit generation creates one local notification independent of backoff time", async () => {
  const state = {
    meta: {},
    projects: [{ id: "project_1", key: "demo", notificationPolicy: { channels: ["in_app", "macos"] } }],
    tasks: [{
      id: "task_9",
      projectId: "project_1",
      title: "Repair bounded failure",
      status: "blocked",
      retryNotBefore: "2026-09-05T13:00:00.000Z",
      automationBlocker: { type: "circuit", reason: "execution_failed" },
      automationCircuit: {
        state: "open",
        reasonCode: "execution_failed",
        incidentGeneration: 2,
        notificationKey: "failure:aaaaaaaaaaaaaaaaaaaaaa:2",
      },
    }],
    notificationOutbox: [],
    events: [],
  };

  const first = enqueueFailureCircuitNotificationsInState(state, { now: "2026-09-05T12:00:00.000Z" });
  state.tasks[0].retryNotBefore = "2026-09-05T14:00:00.000Z";
  const repeated = enqueueFailureCircuitNotificationsInState(state, { now: "2026-09-05T12:05:00.000Z" });
  assert.equal(first.length, 1);
  assert.equal(repeated.length, 0);
  assert.equal(state.notificationOutbox.length, 1);
  assert.equal(state.notificationOutbox[0].channel, "macos");
  assert.match(notificationForFailureCircuit(first[0]).body, /Paid retries remain stopped/);

  state.tasks[0].automationCircuit = {
    ...state.tasks[0].automationCircuit,
    incidentGeneration: 3,
    notificationKey: "failure:aaaaaaaaaaaaaaaaaaaaaa:3",
  };
  const nextGeneration = enqueueFailureCircuitNotificationsInState(state, { now: "2026-09-05T12:10:00.000Z" });
  assert.equal(nextGeneration.length, 1);
  assert.equal(state.notificationOutbox.length, 2);
  assert.equal(state.notificationOutbox[0].status, "acknowledged");
  assert.equal(state.notificationOutbox[0].resolutionReason, "failure_generation_changed");
});
