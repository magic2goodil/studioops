import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { materializeLocalCandidate, prepareLocalWorkspace, verifyLocalCandidate } from "../src/workspace.js";

const exec = promisify(execFile);
async function git(cwd, args) { return (await exec("git", args, { cwd })).stdout.trim(); }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-candidate-"));
  const repo = path.join(root, "source");
  await mkdir(repo);
  await git(repo, ["init"]); await git(repo, ["checkout", "-b", "main"]);
  await git(repo, ["config", "user.name", "StudioOps Test"]); await git(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "base\n"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]);
  return { root, repo };
}

test("local candidate materialization preserves exact commit, tree, base, and remotes", async () => {
  const { root, repo } = await fixture();
  try {
    const builder = path.join(root, "builder");
    await prepareLocalWorkspace({ sourceRepoPath: repo, workspacePath: builder, branch: "feature/task", originUrl: "https://github.com/example/project.git", root, useCandidate: false });
    await writeFile(path.join(builder, "change.txt"), "candidate\n"); await git(builder, ["add", "."]); await git(builder, ["commit", "-m", "candidate"]);
    const identity = await materializeLocalCandidate({ workspacePath: builder, root, branch: "feature/task", taskId: "task_1", identity: { candidateCycle: 1 } });
    const review = path.join(root, "review");
    await prepareLocalWorkspace({ sourceRepoPath: repo, workspacePath: review, branch: "feature/task", originUrl: "https://github.com/example/project.git", root, identity, useCandidate: true });
    assert.equal(await git(review, ["rev-parse", "HEAD"]), identity.commitSha);
    assert.equal(await git(review, ["rev-parse", "HEAD^{tree}"]), identity.treeSha);
    assert.match(await git(review, ["remote", "get-url", "origin"]), /github\.com\/example\/project/);
    assert.equal(await git(review, ["remote", "get-url", "local-candidate"]), path.join(root, identity.operationalLocalArtifactRef));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing or mismatched local candidates fail before workspace launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-candidate-missing-"));
  try {
    await assert.rejects(() => verifyLocalCandidate(root, { commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/task", candidateCycle: 1, operationalLocalArtifactRef: "candidates/task_1/1-a.git" }), (error) => error.code === "local_candidate_artifact_missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
