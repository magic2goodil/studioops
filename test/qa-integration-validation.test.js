import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  git,
  qaIntegrationModuleUrl,
  run,
  stateWithReviewEvidence,
} from "./helpers/qa-integration-fixture.js";
import { qaIntegrationScenarios } from "./helpers/qa-integration-scenarios.js";
import { readPersistedState } from "./state-database-helper.js";

const scenario = qaIntegrationScenarios(import.meta.url);

scenario("validation commands use the QA integration PATH override", async () => {
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
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
    }), null, 2)}\n`, "utf8");

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

    assert.equal(report.projects[0].status, "preview_missing");
    assert.equal(report.projects[0].tasks[0].status, "preview_missing");

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "preview_missing");
    assert.equal(state.tasks[0].integrationValidation.commands[0].ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("QA integration removes repository credentials from validation environments", async () => {
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

    const validationCommand = `${JSON.stringify(process.execPath)} -e "console.log(JSON.stringify({ gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN, mission: process.env.MISSION_CONTROL_GITHUB_TOKEN, askpass: process.env.GIT_ASKPASS, ssh: process.env.SSH_AUTH_SOCK, marker: process.env.SAFE_VALIDATION_MARKER }))"`;

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
    }), null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))},
        githubAppAuth: false,
        env: {
          GH_TOKEN: ${JSON.stringify(fakeToken)},
          GITHUB_TOKEN: ${JSON.stringify(fakeToken)},
          MISSION_CONTROL_GITHUB_TOKEN: ${JSON.stringify(fakeToken)},
          GIT_ASKPASS: "/tmp/credential-helper",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          SAFE_VALIDATION_MARKER: "safe-value"
        },
        secrets: [${JSON.stringify(fakeToken)}],
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const reportText = JSON.stringify(report);
    const persistedState = readPersistedState(root);
    const stateText = JSON.stringify(persistedState);
    const validationOutput = report.projects[0].validation[0].output;
    const persistedValidationOutput = persistedState.tasks[0].integrationValidation.commands[0].output;

    assert.equal(report.projects[0].status, "preview_missing");
    assert.equal(report.projects[0].tasks[0].status, "preview_missing");
    assert.equal(reportText.includes(fakeToken), false);
    assert.equal(validationOutput, '{"marker":"safe-value"}');
    assert.doesNotMatch(reportText, /credential-helper|agent\.sock/);
    assert.equal(stateText.includes(fakeToken), false);
    assert.equal(persistedValidationOutput, '{"marker":"safe-value"}');
    assert.doesNotMatch(stateText, /credential-helper|agent\.sock/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("failed validation leaves the owner checkout untouched and does not push", async () => {
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
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
    }), null, 2)}\n`, "utf8");

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

scenario("QA integration rejects source drift before merge or candidate push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-source-drift-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");

  try {
    await git(root, ["init", "--bare", remotePath]);
    await git(root, ["clone", remotePath, repoPath]);
    await git(repoPath, ["config", "user.email", "studioops-test@example.com"]);
    await git(repoPath, ["config", "user.name", "StudioOps Test"]);
    await git(repoPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "app.txt"]);
    await git(repoPath, ["commit", "-m", "base"]);
    await git(repoPath, ["push", "origin", "main"]);

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "reviewed feature"]);
    const reviewedSourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "origin", "feature/task"]);

    await git(repoPath, ["checkout", "main"]);
    await git(repoPath, ["checkout", "-b", "feature/stable"]);
    await writeFile(path.join(repoPath, "stable.txt"), "stable\n", "utf8");
    await git(repoPath, ["add", "stable.txt"]);
    await git(repoPath, ["commit", "-m", "stable feature"]);
    await git(repoPath, ["push", "origin", "feature/stable"]);

    const state = await stateWithReviewEvidence({
      meta: {},
      projects: [{
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath,
        defaultBranch: "main",
        validationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
        reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/integration" },
      }],
      tasks: [
        {
          id: "task_2",
          projectId: "project_1",
          title: "Stable feature task",
          status: "qa_review",
          branchName: "feature/stable",
        },
        {
          id: "task_1",
          projectId: "project_1",
          title: "Drifting feature task",
          status: "qa_review",
          branchName: "feature/task",
        },
      ],
      comments: [],
      events: [],
      reviews: [],
      runs: [],
    });
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", "mission-control.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    await git(repoPath, ["checkout", "feature/task"]);
    await writeFile(path.join(repoPath, "feature.txt"), "moved after review\n", "utf8");
    await git(repoPath, ["commit", "-am", "move source after review"]);
    const movedSourceSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["push", "origin", "feature/task"]);

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const persisted = readPersistedState(root);

    assert.equal(report.projects[0].status, "blocked");
    assert.equal(report.projects[0].tasks[0].status, "merged");
    assert.equal(report.projects[0].tasks[1].status, "source_drift");
    assert.equal(report.projects[0].tasks[1].expectedHeadSha, reviewedSourceSha);
    assert.equal(report.projects[0].tasks[1].headSha, movedSourceSha);
    assert.equal(persisted.candidates.length, 0);
    assert.equal(
      await git(remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/qa/candidate-"]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("successful QA integration freezes an immutable candidate at the healthy preview commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-integration-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const previewPath = path.join(root, "preview");
  let attestsPreview = false;
  const healthServer = createServer(async (_request, response) => {
    try {
      const commitSha = await git(previewPath, ["rev-parse", "HEAD"]);
      const headers = {
        "content-type": "application/json",
      };
      if (attestsPreview) headers["x-studioops-commit"] = commitSha;
      response.writeHead(200, headers);
      response.end(JSON.stringify(attestsPreview ? { ok: true, commitSha } : { ok: true }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"ok":false}');
    }
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

    await git(repoPath, ["checkout", "-b", "feature/task"]);
    await writeFile(path.join(repoPath, "app.txt"), "feature\n", "utf8");
    await git(repoPath, ["commit", "-am", "feature"]);
    await git(repoPath, ["push", "origin", "feature/task"]);

    await git(root, ["clone", remotePath, previewPath]);
    await git(previewPath, ["checkout", "-b", "main", "origin/main"]);

    await git(repoPath, ["checkout", "-b", "owner/work", "main"]);
    await writeFile(path.join(repoPath, "owner-notes.txt"), "uncommitted owner note\n", "utf8");
    const ownerStatusBefore = await git(repoPath, ["status", "--porcelain"]);

    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
          localQaPreview: {
            enabled: true,
            checkoutPath: previewPath,
            branch: "qa/integration",
            previewUrl: `http://127.0.0.1:${healthPort}/`,
            healthCheckUrl: `http://127.0.0.1:${healthPort}/health`,
          },
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
    }), null, 2)}\n`, "utf8");

    const rejectedRun = await run(process.execPath, ["--input-type=module", "-e", `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))},
        previewHealthAttempts: 1
      });
      console.log(JSON.stringify(report));
    `], { cwd: root });
    const rejectedReport = JSON.parse(rejectedRun.stdout.trim());
    assert.equal(rejectedReport.projects[0].status, "preview_identity_mismatch");
    assert.equal(readPersistedState(root).candidates.length, 0);

    attestsPreview = true;
    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({
        force: true,
        task: "task_1",
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "ready");
    assert.equal(report.projects[0].tasks[0].status, "ready");
    assert.equal(report.projects[0].integrationBranch, "qa/integration");
    assert.equal(report.projects[0].localQaPreview.branch, report.projects[0].integrationBranch);
    assert.equal(report.projects[0].localQaPreview.after, report.projects[0].commit);
    assert.equal(report.projects[0].candidate.manifest.integration.sha, report.projects[0].commit);
    assert.equal(report.projects[0].candidate.manifest.preview.commitSha, report.projects[0].commit);
    assert.equal(report.projects[0].candidate.manifest.sources[0].headSha, await git(remotePath, ["rev-parse", "refs/heads/feature/task"]));
    assert.ok(report.projects[0].workspacePath.startsWith(path.join(root, "qa-workspaces")));
    assert.notEqual(report.projects[0].workspacePath, repoPath);
    assert.equal(await git(repoPath, ["symbolic-ref", "--short", "HEAD"]), "owner/work");
    assert.equal(await git(repoPath, ["status", "--porcelain"]), ownerStatusBefore);
    assert.equal(await git(remotePath, ["show", `refs/heads/${report.projects[0].integrationBranch}:app.txt`]), "feature");

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "ready");
    assert.equal(state.tasks[0].integrationWorkspacePath, report.projects[0].workspacePath);
    assert.match(state.comments[0].body, /Workspace:/);
    assert.equal(state.qaBundles.length, 2);
    assert.equal(state.candidates.length, 1);
    assert.equal(state.tasks[0].candidateId, state.candidates[0].id);
    assert.equal(state.tasks[0].candidateManifestDigest, state.candidates[0].manifestDigest);
    assert.equal(state.qaBundles.find((bundle) => bundle.candidateId === state.candidates[0].id)?.status, "ready");

    const secondRun = await run(process.execPath, ["--input-type=module", "-e", `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({
        force: true,
        task: "task_1",
        workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))}
      });
      console.log(JSON.stringify(report));
    `], { cwd: root });
    const secondReport = JSON.parse(secondRun.stdout.trim());
    const replacedState = readPersistedState(root);
    const currentCandidate = replacedState.candidates.find((candidate) => candidate.id === secondReport.projects[0].candidate.id);
    const supersededCandidate = replacedState.candidates.find((candidate) => candidate.id === report.projects[0].candidate.id);
    assert.equal(secondReport.projects[0].status, "ready");
    assert.equal(replacedState.candidates.length, 2);
    assert.equal(currentCandidate.status, "frozen");
    assert.equal(supersededCandidate.status, "invalidated");
    assert.match(supersededCandidate.invalidation.reason, /Superseded by newer candidate/);
    assert.equal(
      replacedState.qaBundles.find((bundle) => bundle.candidateId === supersededCandidate.id).status,
      "invalidated",
    );
    assert.equal(replacedState.tasks[0].candidateId, currentCandidate.id);
  } finally {
    await new Promise((resolve) => healthServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

scenario.assertComplete();
