import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
import {
  planQaIntegrations,
  probeQaIntegrationProject,
  projectPlanHasWork,
  qaResultFingerprint,
} from "../src/qa-integration.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const qaIntegrationModuleUrl = pathToFileURL(path.join(process.cwd(), "src/qa-integration.js")).href;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.cwd ? { STUDIOOPS_ROOT: options.cwd } : {}),
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

test("QA integration skips already-ready tasks unless forced", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      qaIntegration: { syncDefaultBranchIntoIntegration: true },
      localQaPreview: { enabled: true, checkoutPath: "/tmp/demo-preview", branch: "qa/demo" },
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Ready task",
      status: "qa_review",
      integrationStatus: "ready",
      branchName: "codex/demo-task",
    }],
  };

  assert.equal(planQaIntegrations(state, { project: "demo" }).taskCount, 0);
  assert.equal(planQaIntegrations(state, { project: "demo", force: true }).taskCount, 1);
});

test("QA integration honors retry windows for unchanged blocked work", () => {
  const nowMs = Date.parse("2026-07-22T20:00:00.000Z");
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Blocked task",
      status: "qa_review",
      integrationStatus: "conflict",
      integrationRetryNotBefore: "2026-07-22T20:15:00.000Z",
      branchName: "codex/demo-task",
    }],
  };

  const deferredPlan = planQaIntegrations(state, { project: "demo", nowMs });
  assert.equal(deferredPlan.taskCount, 0);
  assert.equal(deferredPlan.projects[0].deferredTaskCount, 1);
  assert.equal(projectPlanHasWork(deferredPlan.projects[0]), false);
  assert.equal(planQaIntegrations(state, { project: "demo", nowMs: nowMs + 16 * 60_000 }).taskCount, 1);
  assert.equal(planQaIntegrations(state, { project: "demo", nowMs, force: true }).taskCount, 1);
});

test("QA project repair probes use the qa-integration-worker identity and remote operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-probe-"));
  const repoPath = path.join(root, "repo");
  try {
    await git(root, ["init", repoPath]);
    await git(repoPath, ["remote", "add", "origin", "https://github.com/example/demo.git"]);
    let preparedRole = "";
    let checkedRole = "";
    let checkedOperation = "";
    let cleaned = false;
    const result = await probeQaIntegrationProject({
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath,
      repoUrl: "https://github.com/example/demo",
      reviewPolicy: { integrationBranch: "qa/integration" },
    }, {
      prepareGitHubAppAuth: async (runContext) => {
        preparedRole = runContext.role;
        return {
          token: "test-token-value",
          jwt: "",
          role: runContext.role,
          app: { slug: "qa-test" },
          repo: { owner: "example", name: "demo" },
          askpassPath: path.join(root, "askpass"),
        };
      },
      cleanupGitHubAppAuth: async () => { cleaned = true; },
      checkQaIntegrationRemote: async (context) => {
        checkedRole = context.role;
        checkedOperation = context.operation;
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(preparedRole, "qa-integration-worker");
    assert.equal(checkedRole, "qa-integration-worker");
    assert.equal(checkedOperation, "git ls-remote origin");
    assert.equal(cleaned, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA result fingerprints ignore isolated workspace names but detect material changes", () => {
  const task = { status: "validation_failed", source: "codex/demo", output: "Tests failed" };
  const first = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-one",
    output: "Failure in /tmp/qa-one",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-one/test.js\nduration_ms 123.45\nRan 10 tests in 2.2s" }],
  }, task);
  const repeated = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-two",
    output: "Failure in /tmp/qa-two",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-two/test.js\nduration_ms 987.65\nRan 10 tests in 8.8s" }],
  }, task);
  const changed = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-three",
    output: "Different assertion failed in /tmp/qa-three",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-three/test.js" }],
  }, task);

  assert.equal(first, repeated);
  assert.notEqual(first, changed);
});

test("ready QA fingerprints ignore transient push and preview transitions", () => {
  const task = { status: "ready", source: "codex/demo" };
  const first = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "abc123",
    workspacePath: "/tmp/qa-one",
    output: "To github.com:example/demo.git\n   old..abc  HEAD -> qa/demo",
    localQaPreview: {
      status: "updated",
      before: "old",
      after: "abc123",
      output: "Local QA preview updated to abc123.",
    },
    validation: [{ command: "npm test", ok: true, output: "Duration 1.23s" }],
  }, task);
  const repeated = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "abc123",
    workspacePath: "/tmp/qa-two",
    output: "Everything up-to-date",
    localQaPreview: {
      status: "current",
      before: "abc123",
      after: "abc123",
      output: "Local QA preview already current.",
    },
    validation: [{ command: "npm test", ok: true, output: "Duration 9.87s" }],
  }, task);
  const changedCommit = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "def456",
    localQaPreview: { status: "updated", before: "abc123", after: "def456" },
    validation: [{ command: "npm test", ok: true, output: "Duration 1.23s" }],
  }, task);

  assert.equal(first, repeated);
  assert.notEqual(first, changedCommit);
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "ready");
    assert.equal(state.tasks[0].integrationValidation.commands[0].ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration redacts GitHub token values from validation output before storing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-redaction-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeToken = "ghs_fake-validation-secret-token";

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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

    const validationCommand = `${JSON.stringify(process.execPath)} -e "console.log(process.env.GH_TOKEN); console.error(process.env.MISSION_CONTROL_GITHUB_TOKEN)"`;

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
          validationCommands: [validationCommand],
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
      const report = await runQaIntegration({
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))},
        githubAppAuth: false,
        env: {
          GH_TOKEN: ${JSON.stringify(fakeToken)},
          GITHUB_TOKEN: ${JSON.stringify(fakeToken)},
          MISSION_CONTROL_GITHUB_TOKEN: ${JSON.stringify(fakeToken)}
        },
        secrets: [${JSON.stringify(fakeToken)}],
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const reportText = JSON.stringify(report);
    const stateText = JSON.stringify(readPersistedState(root));

    assert.equal(report.projects[0].status, "ready");
    assert.equal(report.projects[0].tasks[0].status, "ready");
    assert.equal(reportText.includes(fakeToken), false);
    assert.match(reportText, /\[REDACTED_GITHUB_APP_TOKEN\]/);
    assert.equal(stateText.includes(fakeToken), false);
    assert.match(stateText, /\[REDACTED_GITHUB_APP_TOKEN\]/);
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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

    const state = readPersistedState(root);
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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
      qaBundles: [
        {
          id: "qa_bundle_1",
          projectId: "legacy_project",
          projectKey: "legacy",
          status: "ready",
          integrationCommit: "legacy-commit",
          tasks: [],
        },
      ],
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

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "ready");
    assert.equal(state.tasks[0].integrationWorkspacePath, report.projects[0].workspacePath);
    assert.match(state.comments[0].body, /Workspace:/);
    assert.deepEqual(state.qaBundles.map((bundle) => bundle.id), ["qa_bundle_1", "qa_bundle_2"]);
    assert.equal(state.tasks[0].qaBundleId, "qa_bundle_2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QA integration can sync default branch changes into QA and refresh a local preview checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-default-sync-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const previewPath = path.join(root, "preview");
  const healthServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });

  try {
    await new Promise((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    const healthPort = healthServer.address().port;
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);
    await git(repoPath, ["push", "origin", "main:qa/integration"]);

    await git(root, ["clone", remotePath, previewPath]);
    await git(previewPath, ["checkout", "-b", "qa/integration", "origin/qa/integration"]);
    await writeFile(path.join(previewPath, "dirty-preview-note.txt"), "keep me\n", "utf8");

    await writeFile(path.join(repoPath, "app.txt"), "main update\n", "utf8");
    await git(repoPath, ["commit", "-am", "main update"]);
    await git(repoPath, ["push", "origin", "main"]);

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
          qaIntegration: {
            syncDefaultBranchIntoIntegration: true,
            localPreview: {
              enabled: true,
              checkoutPath: previewPath,
              branch: "qa/integration",
              stashDirty: true,
              previewUrl: `http://127.0.0.1:${healthPort}/`,
              healthCheckUrl: `http://127.0.0.1:${healthPort}/health`,
            },
          },
        },
      ],
      tasks: [],
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
    assert.equal(report.projects[0].defaultBranchSync.status, "merged");
    assert.equal(report.projects[0].localQaPreview.stashed, true);
    assert.match(report.projects[0].localQaPreview.status, /^(updated|current)$/);
    assert.equal(report.projects[0].localQaPreview.healthCheckUrl, `http://127.0.0.1:${healthPort}/health`);
    assert.equal(await git(remotePath, ["show", "refs/heads/qa/integration:app.txt"]), "main update");
    assert.equal(await readFile(path.join(previewPath, "app.txt"), "utf8"), "main update\n");
    assert.match(await git(previewPath, ["stash", "list"]), /StudioOps local QA preview sync/);
  } finally {
    await new Promise((resolve) => healthServer.close(resolve));
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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

    const state = readPersistedState(root);
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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

test("preview failures preserve the integrated commit and the next sweep only probes health", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-preview-probe-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const previewPath = path.join(root, "preview");
  const markerPath = path.join(root, "validation-runs.txt");
  const qaWorkspaceRoot = path.join(root, "qa-workspaces");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);
    await git(repoPath, ["push", "origin", "main:qa/integration"]);
    await git(root, ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);
    await git(repoPath, ["push", "origin", "feature/task"]);

    const markerScript = `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "validated\\n")`;
    const validationCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(markerScript)}`;
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        repoUrl: "",
        defaultBranch: "main",
        validationCommands: [validationCommand],
        reviewPolicy: {
          trustLeadApprovals: true,
          integrationBranch: "qa/integration",
        },
        localQaPreview: {
          enabled: true,
          checkoutPath: previewPath,
          branch: "qa/integration",
          createIfMissing: true,
          healthCheckUrl: "http://127.0.0.1:49999/health",
        },
      }],
      tasks: [{
        id: "task_1",
        projectId: "project_1",
        title: "Feature task",
        status: "qa_review",
        branchName: "feature/task",
        prUrl: "",
      }],
      comments: [],
      events: [],
      reviews: [],
      runs: [],
      qaBundles: [],
    }, null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const options = {
        workspaceRoot: ${JSON.stringify(qaWorkspaceRoot)},
        githubAppAuth: false,
        healthAttempts: 1,
        healthRetryDelayMs: 0,
        fetch: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
      };
      const first = await runQaIntegration(options);
      const second = await runQaIntegration({
        ...options,
        nowMs: Date.now() + 16 * 60_000,
      });
      console.log(JSON.stringify({ first, second }));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
    });
    const reports = JSON.parse(runResult.stdout.trim());
    const state = readPersistedState(root);
    const validationRuns = (await readFile(markerPath, "utf8")).trim().split("\n");

    assert.equal(reports.first.projects[0].status, "preview_blocked");
    assert.equal(reports.second.projects[0].status, "preview_blocked");
    assert.equal(reports.second.projects[0].previewProbeOnly, true);
    assert.equal(validationRuns.length, 1);
    assert.ok(state.tasks[0].integrationCommit);
    assert.equal(state.tasks[0].integrationStatus, "preview_blocked");
    assert.equal(state.runs.length, 0);
    assert.equal(
      state.tasks[0].integrationCommit,
      await git(remotePath, ["rev-parse", "refs/heads/qa/integration"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub QA integration fails explicitly when app credentials are missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "mission-control-test@example.com"]);
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath,
          repoUrl: "https://github.com/example/demo",
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
          prUrl: "https://github.com/example/demo/pull/1",
        },
        {
          id: "task_2",
          projectId: "project_1",
          title: "Queued sibling",
          status: "in_progress",
          branchName: "feature/sibling",
        },
      ],
      comments: [],
      events: [],
      reviews: [],
      runs: [{
        id: "run_1",
        taskId: "task_2",
        projectId: "project_1",
        actionType: "start_builder",
        group: "builder",
        role: "builder",
        status: "queued",
        taskStatusBeforeDispatch: "queued",
        modelBudgetConsumed: false,
        budgetReservation: true,
        createdAt: new Date().toISOString(),
      }],
    }, null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: {
        STUDIOOPS_GITHUB_APPS_DIR: path.join(root, "missing-github-apps"),
      },
    });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "blocked");
    assert.equal(report.projects[0].tasks[0].status, "blocked");
    assert.match(report.projects[0].output, /QA-integration GitHub App credentials/i);
    assert.doesNotMatch(report.projects[0].output, /could not read Username/);

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "blocked");
    assert.equal(state.tasks[0].status, "blocked");
    assert.equal(state.tasks[0].assignedAgentRole, "owner");
    assert.equal(state.tasks[0].automationBlocker.type, "project_circuit");
    assert.equal(state.projects[0].automationCircuit.state, "open");
    assert.equal(state.projects[0].automationCircuit.probeKind, "qa_integration_preflight");
    assert.equal(state.projects[0].automationCircuit.probeRole, "qa-integration-worker");
    assert.equal(state.runs[0].status, "cancelled");
    assert.equal(state.tasks[1].status, "queued");
    assert.ok(state.comments.some((comment) => /Project automation circuit opened/.test(comment.body)));
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
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
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
