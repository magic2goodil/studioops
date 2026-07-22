import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const promotionModuleUrl = pathToFileURL(path.join(process.cwd(), "src/promotion.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env || {}),
    },
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function git(repoPath, args) {
  const result = await run("git", args, { cwd: repoPath });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function configureRepo(repoPath) {
  await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
}

function baseState(overrides = {}) {
  return {
    meta: {},
    projects: [],
    tasks: [],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
    ...overrides,
  };
}

async function writeState(root, state) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("owner QA pass queues a task for main promotion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-decision-"));
  try {
    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          defaultBranch: "main",
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Ready task",
          status: "qa_review",
          integrationStatus: "ready",
        },
      ],
    }));

    const script = `
      import { recordQaDecision } from ${JSON.stringify(storeModuleUrl)};
      const result = await recordQaDecision("task_1", {
        outcome: "passed",
        author: "Owner QA",
        body: "Preview looked good."
      });
      console.log(JSON.stringify(result.task));
    `;
    const result = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const task = JSON.parse(result.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(task.status, "approved_for_main");
    assert.equal(task.assignedAgentRole, "promotion-worker");
    assert.equal(task.promotionStatus, "queued");
    assert.equal(state.comments[0].author, "Owner QA");
    assert.match(state.comments[0].body, /Local QA passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion creates a validated release-candidate PR without updating main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-promotion-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await configureRepo(repoPath);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "-u", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    await git(repoPath, ["push", "-u", "origin", "feature/task"]);
    await git(repoPath, ["checkout", "main"]);
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "gh"), "#!/bin/sh\necho https://github.com/example/demo/pull/42\n", "utf8");
    await chmod(path.join(fakeBin, "gh"), 0o755);

    await writeState(root, baseState({
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: ["test -f feature.txt"],
          promotion: {
            enabled: true,
            targetBranch: "main",
          },
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "approved_for_main",
          branchName: "feature/task",
          prUrl: "",
          promotionStatus: "queued",
          qaBundleId: "qa_bundle_1",
        },
      ],
      qaBundles: [
        {
          id: "qa_bundle_1",
          projectId: "project_1",
          projectKey: "demo",
          status: "passed",
          tasks: [{ id: "task_1", title: "Feature task" }],
        },
      ],
    }));

    const script = `
      import { runPromotion } from ${JSON.stringify(promotionModuleUrl)};
      const report = await runPromotion({
        githubAppAuth: false,
        promotionWorkspaceRoot: ${JSON.stringify(path.join(root, "promotion-workspaces"))},
        env: { PATH: ${JSON.stringify(`${fakeBin}:/usr/local/bin:/usr/bin:/bin`)} }
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);

    assert.equal(report.projects[0].status, "pr_ready");
    assert.equal(report.projects[0].tasks[0].status, "pr_ready");
    assert.equal(report.projects[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.tasks[0].status, "user_review");
    assert.equal(state.tasks[0].promotionStatus, "pr_ready");
    assert.equal(state.tasks[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(state.qaBundles[0].status, "release_candidate_ready");
    assert.equal(state.qaBundles[0].promotionPrUrl, "https://github.com/example/demo/pull/42");
    assert.ok(report.projects[0].promotionBranch);
    assert.ok(await git(root, ["--git-dir", remotePath, "rev-parse", `refs/heads/${report.projects[0].promotionBranch}`]));
    await assert.rejects(() => git(root, ["--git-dir", remotePath, "show", "refs/heads/main:feature.txt"]));
    assert.equal(state.events.some((event) => event.type === "release_candidate_ready"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
