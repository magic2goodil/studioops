import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    await prepareLocalWorkspace({ sourceRepoPath: repo, workspacePath: builder, branch: "feature/task", originUrl: "https://token-user:secret-token@github.com/example/project.git?access_token=query-secret", root, useCandidate: false });
    assert.equal(await git(builder, ["remote", "get-url", "origin"]), "https://github.com/example/project.git");
    await writeFile(path.join(builder, "change.txt"), "candidate\n"); await git(builder, ["add", "."]); await git(builder, ["commit", "-m", "candidate"]);
    const identity = await materializeLocalCandidate({ workspacePath: builder, root, branch: "feature/task", taskId: "task_1", identity: { candidateCycle: 1 } });
    const review = path.join(root, "review");
    await prepareLocalWorkspace({ sourceRepoPath: repo, workspacePath: review, branch: "feature/task", originUrl: "https://github.com/example/project.git", root, identity, useCandidate: true });
    assert.equal(await git(review, ["rev-parse", "HEAD"]), identity.commitSha);
    assert.equal(await git(review, ["rev-parse", "HEAD^{tree}"]), identity.treeSha);
    assert.equal(await git(review, ["remote", "get-url", "origin"]), "https://github.com/example/project.git");
    assert.equal(await git(review, ["remote", "get-url", "local-candidate"]), path.join(root, identity.operationalLocalArtifactRef));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local workspaces allow a missing configured origin and reject managed-path symlinks", async () => {
  const { root, repo } = await fixture();
  try {
    const workspace = path.join(root, "no-origin");
    await prepareLocalWorkspace({ sourceRepoPath: repo, workspacePath: workspace, branch: "feature/no-origin", originUrl: "", root, useCandidate: false });
    assert.equal(await git(workspace, ["remote"]), "");
    await writeFile(path.join(workspace, "candidate.txt"), "candidate\n");
    await git(workspace, ["add", "candidate.txt"]);
    await git(workspace, ["commit", "-m", "candidate"]);

    const artifactRoot = path.join(root, "artifacts");
    const escapedRoot = path.join(root, "escaped");
    await mkdir(artifactRoot);
    await mkdir(escapedRoot);
    await symlink(escapedRoot, path.join(artifactRoot, "candidates"));
    await assert.rejects(
      () => materializeLocalCandidate({ workspacePath: workspace, root: artifactRoot, branch: "feature/no-origin", taskId: "task_2", identity: { candidateCycle: 1 } }),
      (error) => error.code === "local_candidate_path_unsafe",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing or mismatched local candidates fail before workspace launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-candidate-missing-"));
  try {
    await assert.rejects(() => verifyLocalCandidate(root, { taskId: "task_1", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/task", candidateCycle: 1, operationalLocalArtifactRef: `candidates/task_1/1-${"a".repeat(40)}.git` }), (error) => error.code === "local_candidate_artifact_missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
