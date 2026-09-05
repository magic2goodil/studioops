import assert from "node:assert/strict";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const environment = await createHermeticTestEnvironment();
Object.assign(process.env, environment.env);
test.after(() => environment.cleanup());
const { buildBoardState, boardStateForSnapshot } = await import("../src/board-state.js");

function fixture() {
  return {
    meta: { storageBackend: "sqlite", updatedAt: "2026-09-05T00:00:00.000Z", privateHistory: "PRIVATE_META" },
    projects: [{ id: "project_1", key: "example", name: "Example", reviewPolicy: { trustLeadApprovals: true }, credentials: "PRIVATE_PROJECT" }],
    tasks: [{
      id: "task_1", projectId: "project_1", title: "Review current work", status: "ready",
      description: "Description ".repeat(100), candidateId: "candidate_1", candidateManifestDigest: "sha256:manifest",
      integrationCommit: "a".repeat(40), parentTaskId: "", dependsOnTaskIds: [],
      attachments: [{ label: "Example", url: "PRIVATE_ATTACHMENT" }],
      integrationValidation: { output: "PRIVATE_VALIDATION".repeat(10_000) },
      impactPlan: { prompt: "PRIVATE_PROMPT" },
    }],
    comments: [{ id: "comment_1", taskId: "task_1", body: "PRIVATE_COMMENT" }],
    reviews: [], runs: [], events: [], candidates: [], notificationOutbox: [],
    qaBundles: [
      { id: "bundle_active", projectId: "project_1", status: "ready", candidateId: "candidate_1", manifestDigest: "sha256:manifest", integrationCommit: "a".repeat(40), tasks: [{ id: "task_1", title: "Review current work", validation: "PRIVATE_VALIDATION" }], qaPacket: { history: "PRIVATE_PACKET" } },
      { id: "bundle_archived", projectId: "project_1", status: "invalidated", qaPacket: { history: "PRIVATE_PACKET" } },
    ],
  };
}

test("board summaries preserve navigation and exact decision coordinates without workflow payloads", () => {
  const state = fixture();
  const before = JSON.stringify(state);
  const result = buildBoardState(state);
  const task = result.tasks[0];
  assert.equal(task.candidateId, "candidate_1");
  assert.equal(task.candidateManifestDigest, "sha256:manifest");
  assert.equal(task.integrationCommit, "a".repeat(40));
  assert.equal(task.attachmentCount, 1);
  assert.equal(task.descriptionTruncated, true);
  assert.ok(task.description.length <= 320);
  assert.equal(result.qaBundles.length, 1);
  assert.deepEqual(result.qaBundles[0].tasks, [{ id: "task_1", title: "Review current work" }]);
  assert.deepEqual(result.ownerInbox.items, []);
  assert.ok(Array.isArray(result.ownerInbox.groups));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(JSON.stringify(state), before);
  assert.ok(JSON.stringify(result).length < before.length / 20);
});

test("board cache reuses only an immutable snapshot and changes with its identity", () => {
  const first = Object.freeze(fixture());
  const view = boardStateForSnapshot(first);
  assert.equal(boardStateForSnapshot(first), view);
  const next = fixture();
  next.tasks[0].title = "Updated after database commit";
  assert.equal(boardStateForSnapshot(Object.freeze(next)).tasks[0].title, "Updated after database commit");
  const mutable = fixture();
  boardStateForSnapshot(mutable);
  mutable.tasks[0].title = "Not a cacheable snapshot";
  assert.equal(boardStateForSnapshot(mutable).tasks[0].title, "Not a cacheable snapshot");
});

test("time-based board labels refresh even without a database commit", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const snapshot = Object.freeze(fixture());
  const initial = boardStateForSnapshot(snapshot);
  now += 5_001;
  assert.notEqual(boardStateForSnapshot(snapshot), initial);
});
