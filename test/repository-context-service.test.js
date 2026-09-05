import assert from "node:assert/strict";
import test from "node:test";
import { withRepositoryContext } from "../src/repository-context-service.js";
import { runContextCommand } from "../src/mission-control-context.js";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
function fixture() {
  const project = { key: "fixture", repoUrl: "https://github.com/example/fixture", repoPath: "/unused/repo" };
  const impactPlan = { project: { key: project.key, repository: project.repoUrl }, sourceCommit: sha, manifest: { digest }, allowedFileScope: ["src/delivery.js"], supportingFileScope: [], targetedTests: ["npm run check"], fullRegression: true };
  return { project, impactPlan, preflightBaseCommit: sha, task: { title: "retryDelivery" }, fileScope: ["src/delivery.js"], fileScopeExplicit: true };
}
function index() {
  return { schemaVersion: 1, project: { key: "fixture", repository: "https://github.com/example/fixture" }, commitSha: sha, mapDigest: digest, extractorVersion: "test-1", digest, files: [{ path: "src/delivery.js", blobSha: "c".repeat(40), language: "javascript", owner: "delivery", symbols: [{ name: "retryDelivery", kind: "function", line: 5 }], imports: [] }], coverage: { complete: true, partial: false }, cacheHit: true };
}

test("runner context adds bounded advice while preserving exact scope and QA objects", async () => {
  const run = fixture();
  const before = structuredClone(run);
  const result = await withRepositoryContext(run, { loadIndex: async (input) => {
    assert.equal(input.commitSha, sha);
    assert.equal(input.project, run.project);
    return index();
  } });
  assert.notEqual(result.repositoryContext.status, "unavailable");
  assert.match(result.repositoryContextPacket, /retryDelivery/);
  assert.equal(result.repositoryContext.cacheHit, true);
  assert.ok(Buffer.byteLength(result.repositoryContextPacket) <= 10000);
  assert.equal(result.impactPlan, run.impactPlan);
  assert.equal(result.fileScope, run.fileScope);
  assert.deepEqual(run, before);
});

test("wrong repository, stale commit or map cannot enter a worker prompt", async () => {
  for (const change of [
    { project: { key: "other", repository: "https://github.com/example/other" } },
    { commitSha: "d".repeat(40) },
    { mapDigest: `sha256:${"e".repeat(64)}` },
  ]) {
    const run = fixture();
    const result = await withRepositoryContext(run, { loadIndex: async () => ({ ...index(), ...change }) });
    assert.equal(result.repositoryContext.status, "unavailable");
    assert.doesNotMatch(result.repositoryContextPacket, /retryDelivery|example\/other/);
    assert.equal(result.impactPlan, run.impactPlan);
    assert.equal(result.impactPlan.fullRegression, true);
  }
});

test("index failure, missing SHA and explicit disablement preserve the existing worker", async () => {
  const run = fixture();
  const result = await withRepositoryContext(run, { loadIndex: async () => { throw new Error("secret file contents"); } });
  assert.equal(result.repositoryContext.status, "unavailable");
  assert.doesNotMatch(result.repositoryContextPacket, /secret file contents/);
  const disabled = await withRepositoryContext(run, { enabled: false, loadIndex: async () => { assert.fail("disabled index executed"); } });
  assert.equal(disabled.repositoryContextPacket, "");
  const missing = await withRepositoryContext({ ...run, preflightBaseCommit: "", impactPlan: { ...run.impactPlan, sourceCommit: "" } }, { loadIndex: async () => { assert.fail("unbound index executed"); } });
  assert.equal(missing.repositoryContext.reason, "snapshot_binding_missing");
});

test("read-only context command handles help and rejects incomplete or mutable commit input", async () => {
  const lines = [];
  await runContextCommand(["--help"], (line) => lines.push(line));
  assert.match(lines.join("\n"), /--query TEXT/);
  await assert.rejects(runContextCommand(["--query", "retry"], () => {}), /required/);
  await assert.rejects(runContextCommand(["--repo", "/unused", "--project", "fixture", "--repository", "https://github.com/example/fixture", "--query", "retry", "--commit", "main"], () => {}), /immutable/);
});
