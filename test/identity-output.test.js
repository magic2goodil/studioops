import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNotificationReport,
  notificationForBundle,
  renderEmailNotification,
} from "../src/notifier.js";
import {
  promotionCommentForTask,
  resolvePromotionPath,
} from "../src/promotion.js";
import {
  qaIntegrationCommentForTask,
  resolveQaIntegrationPath,
} from "../src/qa-integration.js";
import { compactOperationalHistory } from "../src/state-database.js";

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

test("notification report output identifies StudioOps and preserves project-owned URLs", () => {
  const report = formatNotificationReport({
    generatedAt: "2026-07-28T12:00:00.000Z",
    dryRun: true,
    sent: [],
    skipped: [],
    pending: [{
      id: "run_1",
      notification: {
        title: "StudioOps needs your review",
        subtitle: "customer-project · task_91",
        body: "Canonicalize notifications · https://github.com/example/customer-project/pull/7",
      },
    }],
  });

  assert.match(report, /^StudioOps notifier sweep/);
  assert.match(report, /https:\/\/github\.com\/example\/customer-project\/pull\/7/);
  assert.doesNotMatch(report, /Mission Control/);
  assert.doesNotMatch(report, /magic2goodil\/mission-control/);
});

test("every promotion comment path uses StudioOps identity and canonical product attribution", () => {
  const projectResult = {
    targetBranch: "main",
    commit: "a".repeat(40),
    prUrl: "https://github.com/example/customer-project/pull/9",
    repoUrl: "https://github.com/example/customer-project",
    promotionBranch: "qa/promotion-demo",
    output: "No promotion was attempted.",
    validation: [{ command: "npm test", ok: true, output: "ok" }],
  };
  const statuses = [
    "pr_ready",
    "conflict",
    "validation_failed",
    "push_failed",
    "pr_failed",
    "dependency_blocked",
    "skipped",
  ];

  for (const status of statuses) {
    const body = promotionCommentForTask(projectResult, {
      status,
      source: "feature/task",
      output: "Waiting for dependency.",
      conflicts: ["app.js"],
    });
    assert.match(body, /^StudioOps /, status);
    assert.doesNotMatch(body, /Mission Control/, status);
    assert.doesNotMatch(body, /magic2goodil\/mission-control/, status);
  }

  const ready = promotionCommentForTask(projectResult, {
    status: "pr_ready",
    source: "feature/task",
  });
  assert.match(ready, /Product: https:\/\/github\.com\/magic2goodil\/studioops/);
  assert.match(ready, /https:\/\/github\.com\/example\/customer-project\/tree\/main/);
});

test("every QA integration comment path uses StudioOps identity", () => {
  const projectResult = {
    projectKey: "demo",
    integrationBranch: "qa/demo",
    integrationBranchUrl: "https://github.com/example/customer-project/tree/qa/demo",
    integrationCandidateCommit: "a".repeat(40),
    integrationCandidateBranch: "studioops/qa-candidate/demo-aaaaaaaaaaaa",
    integrationPr: { url: "https://github.com/example/customer-project/pull/10" },
    integrationBlocker: "Checks are pending.",
    output: "No merge was attempted.",
    validation: [{ command: "npm test", ok: true, output: "ok" }],
  };
  const statuses = [
    "ready",
    "conflict",
    "validation_failed",
    "validation_missing",
    "push_failed",
    "pr_waiting",
    "candidate_drift",
    "skipped",
  ];

  for (const status of statuses) {
    const body = qaIntegrationCommentForTask(projectResult, {
      status,
      source: "feature/task",
      output: "No merge was attempted.",
      conflicts: ["app.js"],
    });
    assert.match(body, /^StudioOps /, status);
    assert.doesNotMatch(body, /Mission Control/, status);
    assert.doesNotMatch(body, /magic2goodil\/mission-control/, status);
  }
});

test("StudioOps PATH variables take precedence with exact legacy fallbacks", () => {
  assert.equal(resolvePromotionPath({
    STUDIOOPS_PROMOTION_PATH: "/studioops/promotion",
    MISSION_CONTROL_PROMOTION_PATH: "/legacy/promotion",
  }), "/studioops/promotion");
  assert.equal(resolvePromotionPath({
    MISSION_CONTROL_PROMOTION_PATH: "/legacy/promotion",
  }), "/legacy/promotion");
  assert.equal(resolveQaIntegrationPath({
    STUDIOOPS_QA_INTEGRATION_PATH: "/studioops/qa",
    MISSION_CONTROL_QA_INTEGRATION_PATH: "/legacy/qa",
  }), "/studioops/qa");
  assert.equal(resolveQaIntegrationPath({
    MISSION_CONTROL_QA_INTEGRATION_PATH: "/legacy/qa",
  }), "/legacy/qa");
});

test("historical QA author comments remain readable and use the bounded deduplication alias", () => {
  const historicalComments = [1, 2].map((index) => ({
    id: `comment_${index}`,
    taskId: "task_91",
    author: "Mission Control QA Integration",
    body: `QA integration historical report ${index}`,
    createdAt: `2026-07-28T12:0${index}:00.000Z`,
  }));
  const state = {
    comments: historicalComments,
    events: historicalComments.map((comment, index) => ({
      id: `event_${index + 1}`,
      type: "qa_integration_blocked",
      taskId: comment.taskId,
      createdAt: comment.createdAt,
    })),
    runs: [],
  };

  const archived = compactOperationalHistory(state, { commentLimit: 1 });
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0].id, "comment_2");
  assert.equal(state.comments[0].author, "Mission Control QA Integration");
  assert.equal(archived.comments.length, 1);
  assert.equal(archived.comments[0].id, "comment_1");
});
