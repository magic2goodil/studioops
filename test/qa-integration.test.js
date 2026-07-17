import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { projectFromConfig } from "../src/config.js";
import {
  integrationBranchName,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "../src/integration-policy.js";

const execFileAsync = promisify(execFile);
const qaIntegrationModuleUrl = pathToFileURL(path.join(process.cwd(), "src/qa-integration.js")).href;

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

test("review policy Trust Leads settings override stale top-level mirrors", () => {
  const staleProject = {
    defaultBranch: "main",
    trustLeadApprovals: false,
    integrationBranch: "qa/old",
    reviewPolicy: {
      trustLeadApprovals: true,
      integrationBranch: "qa/new",
    },
  };

  assert.equal(trustLeadApprovalsEnabled(staleProject), true);
  assert.equal(integrationBranchName(staleProject), "qa/new");
  assert.equal(projectUsesTrustLeadQa(staleProject), true);

  assert.equal(trustLeadApprovalsEnabled({
    trustLeadApprovals: true,
    reviewPolicy: { trustLeadApprovals: false },
  }), false);

  const imported = projectFromConfig(
    {
      key: "demo",
      name: "Demo",
      trustLeadApprovals: true,
      integrationBranch: "qa/imported",
    },
    {
      reviewPolicy: {
        trustLeadApprovals: false,
        integrationBranch: "",
      },
    },
  );
  assert.equal(imported.reviewPolicy.trustLeadApprovals, true);
  assert.equal(imported.reviewPolicy.integrationBranch, "qa/imported");
});

test("validation commands use the QA integration PATH override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-path-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "fake-bin");
  const fakeCheck = path.join(fakeBin, "mc-qa-check");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(fakeCheck, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fakeCheck, 0o755);

    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "Mission Control Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);
    await git(repoPath, ["push", "origin", "main:qa/integration"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);
    await git(repoPath, ["push", "origin", "feature/task"]);
    await git(repoPath, ["checkout", "main"]);

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: ["mc-qa-check"],
          reviewPolicy: {
            trustLeadApprovals: true,
            integrationBranch: "qa/integration",
          },
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "qa_review",
          branchName: "feature/task",
          prUrl: "",
        },
      ],
      comments: [],
      events: [],
      reviews: [],
      runs: [],
    }, null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({});
      console.log(JSON.stringify(report));
    `;
    const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: {
        PATH: systemPath,
        MISSION_CONTROL_QA_INTEGRATION_PATH: `${fakeBin}:${systemPath}`,
      },
    });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "ready");
    assert.equal(report.projects[0].tasks[0].status, "ready");

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.tasks[0].integrationStatus, "ready");
    assert.equal(state.tasks[0].integrationValidation.commands[0].ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed validation rolls the local integration branch back to its prepared head", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "Mission Control Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);
    await git(repoPath, ["push", "origin", "main:qa/integration"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);
    await git(repoPath, ["push", "origin", "feature/task"]);
    await git(repoPath, ["checkout", "main"]);

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(1)"`],
          reviewPolicy: {
            trustLeadApprovals: true,
            integrationBranch: "qa/integration",
          },
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Feature task",
          status: "qa_review",
          branchName: "feature/task",
          prUrl: "",
        },
      ],
      comments: [],
      events: [],
      reviews: [],
      runs: [],
    }, null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({});
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "validation_failed");
    assert.equal(report.projects[0].tasks[0].status, "validation_failed");

    const remoteHead = await git(repoPath, ["rev-parse", "refs/remotes/origin/qa/integration"]);
    const localHead = await git(repoPath, ["rev-parse", "refs/heads/qa/integration"]);
    assert.equal(localHead, remoteHead);
    assert.equal(await git(repoPath, ["rev-list", "--left-right", "--count", "refs/remotes/origin/qa/integration...refs/heads/qa/integration"]), "0\t0");
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "main");

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.tasks[0].integrationStatus, "validation_failed");
    assert.equal(state.comments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
