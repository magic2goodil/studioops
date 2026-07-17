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

test("failed validation leaves the owner checkout untouched and does not push", async () => {
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
    await git(repoPath, ["checkout", "-b", "owner/work"]);
    await writeFile(path.join(repoPath, "app.txt"), "owner dirty\n", "utf8");
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);

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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "validation_failed");
    assert.equal(report.projects[0].tasks[0].status, "validation_failed");
    assert.equal(report.projects[0].sourceRepoPath, repoPath);
    assert.ok(report.projects[0].workspacePath.startsWith(path.join(root, "qa-workspaces")));
    assert.notEqual(report.projects[0].workspacePath, repoPath);
    assert.equal(report.projects[0].workspaceStrategy, "isolated_clone");

    assert.equal(await git(remotePath, ["rev-parse", "refs/heads/qa/integration"]), await git(remotePath, ["rev-parse", "refs/heads/main"]));
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.tasks[0].integrationStatus, "validation_failed");
    assert.equal(state.tasks[0].integrationWorkspacePath, report.projects[0].workspacePath);
    assert.equal(state.tasks[0].integrationWorkspaceStrategy, "isolated_clone");
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /Workspace:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful QA integration uses an isolated workspace without switching the registered repo", async () => {
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

    await git(repoPath, ["checkout", "-b", "owner/work", "main"]);
    await writeFile(path.join(repoPath, "owner-notes.txt"), "uncommitted owner note\n", "utf8");
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);

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
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "ready");
    assert.equal(report.projects[0].tasks[0].status, "ready");
    assert.ok(report.projects[0].workspacePath.startsWith(path.join(root, "qa-workspaces")));
    assert.notEqual(report.projects[0].workspacePath, repoPath);
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);
    assert.equal(await git(remotePath, ["show", "refs/heads/qa/integration:app.txt"]), "feature");

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.tasks[0].integrationStatus, "ready");
    assert.equal(state.tasks[0].integrationWorkspacePath, report.projects[0].workspacePath);
    assert.match(state.comments[0].body, /Workspace:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration preserves a distinct origin push URL in the isolated workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const fetchRemotePath = path.join(root, "fetch-remote.git");
  const pushRemotePath = path.join(root, "push-remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", fetchRemotePath]);
    await git(root, ["init", "--bare", pushRemotePath]);
    await git(root, ["clone", fetchRemotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "Mission Control Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);
    await git(repoPath, ["push", "origin", "main:qa/integration"]);
    await git(repoPath, ["push", pushRemotePath, "main:qa/integration"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);
    await git(repoPath, ["push", "origin", "feature/task"]);
    await git(repoPath, ["remote", "set-url", "--push", "origin", pushRemotePath]);

    await git(repoPath, ["checkout", "-b", "owner/work", "main"]);
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);

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
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "ready");
    assert.equal(await git(pushRemotePath, ["show", "refs/heads/qa/integration:app.txt"]), "feature");
    assert.equal(await git(fetchRemotePath, ["show", "refs/heads/qa/integration:app.txt"]), "base");
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration refuses a repo without origin instead of pushing back into the registered repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "Mission Control Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["branch", "qa/integration"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);

    await git(repoPath, ["checkout", "-b", "owner/work", "main"]);
    await writeFile(path.join(repoPath, "owner-notes.txt"), "uncommitted owner note\n", "utf8");
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);
    const qaHeadBefore = await git(repoPath, ["rev-parse", "refs/heads/qa/integration"]);

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
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "blocked");
    assert.equal(report.projects[0].tasks[0].status, "blocked");
    assert.match(report.projects[0].output, /origin remote/);
    assert.equal(report.projects[0].workspacePath, "");
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);
    assert.equal(await git(repoPath, ["rev-parse", "refs/heads/qa/integration"]), qaHeadBefore);

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.tasks[0].integrationStatus, "blocked");
    assert.equal(state.tasks[0].integrationWorkspacePath, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration refuses workspace roots inside the registered repo", async () => {
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

    await git(repoPath, ["checkout", "-b", "owner/work", "main"]);
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);

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
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(repoPath, ".qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "blocked");
    assert.equal(report.projects[0].tasks[0].status, "blocked");
    assert.match(report.projects[0].output, /outside the registered project repoPath/);
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration keeps sanitized project workspace segments inside the workspace root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const workspaceRoot = path.join(root, "qa-workspaces");

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

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [
        {
          id: "project_1",
          key: "..",
          name: "Demo",
          repoPath,
          repoUrl: "",
          defaultBranch: "main",
          validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
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
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(workspaceRoot)} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const relativeWorkspace = path.relative(workspaceRoot, report.projects[0].workspacePath);

    assert.equal(report.projects[0].status, "ready");
    assert.ok(relativeWorkspace);
    assert.equal(relativeWorkspace.startsWith(".."), false);
    assert.equal(path.isAbsolute(relativeWorkspace), false);
    assert.match(relativeWorkspace, /^workspace\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
