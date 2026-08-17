import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { projectFromConfig } from "../src/config.js";
import {
  integrationBranchName,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "../src/integration-policy.js";
import {
  githubAppLocalFallbackEnabled,
  isGitHubAppPermissionError,
  planQaIntegrations,
  projectPlanHasWork,
  qaResultFingerprint,
} from "../src/qa-integration.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const qaIntegrationModuleUrl = pathToFileURL(path.join(process.cwd(), "src/qa-integration.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

async function run(command, args, options = {}) {
  const baseEnv = options.cwd && command === process.execPath
    ? await environmentForTestControlRoot(options.cwd)
    : process.env;
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...baseEnv,
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

async function stateWithReviewEvidence(state) {
  state.reviews = state.reviews || [];
  for (const task of state.tasks || []) {
    if (task.status !== "qa_review" || !task.branchName || task.reviewSubjectSha) continue;
    const project = (state.projects || []).find((item) => item.id === task.projectId);
    if (!project?.repoPath) continue;
    try {
      const subjectSha = await git(project.repoPath, ["rev-parse", task.branchName]);
      task.reviewCycle = 1;
      task.reviewSubjectSha = subjectSha;
      task.reviewSubjectCycle = 1;
      for (const stageKey of ["backend", "frontend", "accessibility", "lead"]) {
        state.reviews.push({
          id: `review_${state.reviews.length + 1}`,
          taskId: task.id,
          projectId: task.projectId,
          cycle: 1,
          candidateCycle: 1,
          stageKey,
          status: `${stageKey}_review`,
          role: `${stageKey}-reviewer`,
          outcome: "approved",
          subjectSha,
          createdAt: "2026-07-25T12:00:00.000Z",
        });
      }
    } catch {
      // Negative repository fixtures intentionally remain untrusted.
    }
  }
  return state;
}

async function runQaIntegrationFixture(root, options = {}) {
  const script = `
    import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
    const report = await runQaIntegration(${JSON.stringify({
      workspaceRoot: path.join(root, "qa-workspaces"),
      ...(options.env?.PATH ? { path: options.env.PATH } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...options.input,
    })});
    console.log(JSON.stringify(report));
  `;
  const result = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: options.env,
  });
  return JSON.parse(result.stdout.trim());
}

async function addReviewedQaTask(root, task, subjectSha) {
  const script = `
    import { mutateState } from ${JSON.stringify(storeModuleUrl)};
    await mutateState((state) => {
      const task = ${JSON.stringify(task)};
      task.reviewCycle = 1;
      task.reviewSubjectSha = ${JSON.stringify(subjectSha)};
      task.reviewSubjectCycle = 1;
      state.tasks.push(task);
      for (const stageKey of ["backend", "frontend", "accessibility", "lead"]) {
        state.reviews.push({
          id: "review_" + (state.reviews.length + 1),
          taskId: task.id,
          projectId: task.projectId,
          cycle: 1,
          candidateCycle: 1,
          stageKey,
          status: stageKey + "_review",
          role: stageKey + "-reviewer",
          outcome: "approved",
          subjectSha: ${JSON.stringify(subjectSha)},
          createdAt: "2026-07-25T12:00:00.000Z"
        });
      }
    });
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
}

async function advanceReviewedQaTask(root, taskId, subjectSha) {
  const script = `
    import { mutateState } from ${JSON.stringify(storeModuleUrl)};
    await mutateState((state) => {
      const task = state.tasks.find((item) => item.id === ${JSON.stringify(taskId)});
      if (!task) throw new Error("missing task");
      task.reviewCycle = Number(task.reviewCycle || 0) + 1;
      task.reviewSubjectSha = ${JSON.stringify(subjectSha)};
      task.reviewSubjectCycle = task.reviewCycle;
      for (const stageKey of ["backend", "frontend", "accessibility", "lead"]) {
        state.reviews.push({
          id: "review_" + (state.reviews.length + 1),
          taskId: task.id,
          projectId: task.projectId,
          cycle: task.reviewCycle,
          candidateCycle: task.reviewCycle,
          stageKey,
          status: stageKey + "_review",
          role: stageKey + "-reviewer",
          outcome: "approved",
          subjectSha: ${JSON.stringify(subjectSha)},
          createdAt: "2026-07-25T13:00:00.000Z"
        });
      }
    });
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
}

async function createProtectedBranchFixture(root) {
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const fakeBin = path.join(root, "fake-bin");
  const prMarker = path.join(root, "pr-created");
  const prCreateLog = path.join(root, "pr-create.log");
  const prCloseLog = path.join(root, "pr-close.log");

  await git(root, ["init", "--bare", remotePath]);
  await git(root, ["clone", remotePath, repoPath]);
  await git(repoPath, ["config", "user.email", "studioops-test@example.com"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
  await git(repoPath, ["checkout", "-b", "main"]);
  await writeFile(path.join(repoPath, "app.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "app.txt"]);
  await git(repoPath, ["commit", "-m", "base"]);
  await git(repoPath, ["push", "origin", "main"]);
  await git(repoPath, ["push", "origin", "main:qa/integration"]);
  const baseSha = await git(repoPath, ["rev-parse", "main"]);

  await git(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(path.join(repoPath, "feature.txt"), "protected QA feature\n", "utf8");
  await git(repoPath, ["add", "feature.txt"]);
  await git(repoPath, ["commit", "-m", "feature"]);
  await git(repoPath, ["push", "origin", "feature/task"]);

  const hookPath = path.join(remotePath, "hooks", "pre-receive");
  await writeFile(hookPath, `#!/bin/sh
while read old_sha new_sha ref_name
do
  if [ "$ref_name" = "refs/heads/qa/integration" ] && [ "$old_sha" != "0000000000000000000000000000000000000000" ]; then
    echo "remote: error: GH006: Protected branch update failed for refs/heads/qa/integration." >&2
    echo "remote: Changes must be made through a pull request." >&2
    exit 1
  fi
done
exit 0
`, "utf8");
  await chmod(hookPath, 0o755);

  await mkdir(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  await writeFile(fakeGh, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const marker = process.env.FAKE_GH_PR_MARKER;
const createLog = process.env.FAKE_GH_CREATE_LOG;
const closeLog = process.env.FAKE_GH_CLOSE_LOG;
const readPrs = () => existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf8") || "[]")
  : [];
const writePrs = (prs) => writeFileSync(marker, JSON.stringify(prs));
if (args[0] === "pr" && args[1] === "create") {
  const prs = readPrs();
  const head = args[args.indexOf("--head") + 1];
  const base = args[args.indexOf("--base") + 1];
  const existing = prs.find((pr) => pr.head === head && pr.base === base);
  if (existing) {
    console.log(existing.url);
    process.exit(0);
  }
  const number = 42 + prs.length;
  const record = {
    number,
    url: "https://github.com/example/demo/pull/" + number,
    head,
    base,
    state: "OPEN"
  };
  prs.push(record);
  writePrs(prs);
  appendFileSync(createLog, "create " + number + " " + head + "\\n");
  console.log(record.url);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "close") {
  const number = Number(args[2]);
  const prs = readPrs();
  const record = prs.find((pr) => pr.number === number);
  if (!record) {
    console.error("missing PR " + number);
    process.exit(1);
  }
  record.state = "CLOSED";
  writePrs(prs);
  appendFileSync(closeLog, "close " + number + "\\n");
  console.log("Closed pull request " + record.url);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const head = args[args.indexOf("--head") + 1];
  const base = args[args.indexOf("--base") + 1];
  const record = readPrs()
    .filter((pr) => pr.head === head && pr.base === base)
    .sort((a, b) => b.number - a.number)[0];
  if (!record) {
    console.log("[]");
    process.exit(0);
  }
  const line = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + head], { encoding: "utf8" }).trim();
  const oid = line.split(/\\s+/)[0] || "";
  const checkMode = String(record.number) === process.env.FAKE_GH_FAILED_PR_NUMBER
    ? "failed"
    : process.env.FAKE_GH_CHECK_STATE || "pending";
  const checks = checkMode === "failed"
    ? [{ name: "integration-test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://example.test/check" }]
    : checkMode === "passed"
      ? [{ name: "integration-test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" }]
      : [{ name: "integration-test", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://example.test/check" }];
  console.log(JSON.stringify([{
    number: record.number,
    url: record.url,
    state: process.env.FAKE_GH_PR_STATE || record.state,
    headRefName: head,
    headRefOid: oid,
    baseRefName: base,
    mergeStateStatus: process.env.FAKE_GH_MERGE_STATE || "BLOCKED",
    reviewDecision: process.env.FAKE_GH_REVIEW_DECISION || "REVIEW_REQUIRED",
    statusCheckRollup: checks,
    mergeCommit: process.env.FAKE_GH_MERGE_COMMIT
      ? { oid: process.env.FAKE_GH_MERGE_COMMIT }
      : null
  }]));
  process.exit(0);
}
console.error("unexpected gh invocation: " + args.join(" "));
process.exit(1);
`, "utf8");
  await chmod(fakeGh, 0o755);

  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
    meta: {},
    projects: [{
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
  }), null, 2)}\n`, "utf8");

  return {
    remotePath,
    repoPath,
    fakeBin,
    hookPath,
    prMarker,
    prCreateLog,
    prCloseLog,
    baseSha,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_GH_PR_MARKER: prMarker,
      FAKE_GH_CREATE_LOG: prCreateLog,
      FAKE_GH_CLOSE_LOG: prCloseLog,
    },
  };
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

test("QA integration skips already-ready tasks unless explicitly forced", () => {
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
  assert.equal(planQaIntegrations(state, { project: "demo", force: true }).taskCount, 0);
  assert.equal(planQaIntegrations(state, {
    project: "demo",
    task: "task_1",
    force: true,
  }).taskCount, 1);
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

test("atomic QA planning cannot silently omit filtered or retry-delayed tasks", () => {
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
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Ready task",
        status: "qa_review",
        branchName: "codex/task-1",
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Retry-delayed task",
        status: "qa_review",
        branchName: "codex/task-2",
        integrationRetryNotBefore: "2026-07-22T20:15:00.000Z",
      },
    ],
  };

  assert.throws(
    () => planQaIntegrations(state, { project: "demo", task: "task_1", nowMs }),
    /requires explicit partial-candidate authorization/,
  );
  const deferred = planQaIntegrations(state, { project: "demo", nowMs });
  assert.equal(deferred.taskCount, 0);
  assert.equal(deferred.projects[0].deferredTaskCount, 2);
  assert.equal(projectPlanHasWork(deferred.projects[0]), false);
});

test("project-level force does not re-integrate already-ready QA tasks", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [
      {
        id: "task_ready",
        projectId: "project_1",
        title: "Already assembled",
        status: "qa_review",
        integrationStatus: "ready",
        branchName: "codex/ready",
      },
      {
        id: "task_retry",
        projectId: "project_1",
        title: "Needs reconciliation",
        status: "qa_review",
        integrationStatus: "pr_waiting",
        branchName: "codex/retry",
      },
    ],
  };

  const projectForce = planQaIntegrations(state, { project: "demo", force: true });
  assert.deepEqual(projectForce.projects[0].tasks.map((task) => task.id), ["task_retry"]);

  const explicitForce = planQaIntegrations({
    ...state,
    tasks: [state.tasks[0]],
  }, {
    project: "demo",
    task: "task_ready",
    force: true,
  });
  assert.deepEqual(explicitForce.projects[0].tasks.map((task) => task.id), ["task_ready"]);
});

test("GitHub App local fallback is opt-in and limited to permission failures", () => {
  assert.equal(githubAppLocalFallbackEnabled({}), false);
  assert.equal(githubAppLocalFallbackEnabled({ githubAppFallbackToLocalAuth: true }), true);
  assert.equal(
    isGitHubAppPermissionError(new Error("GraphQL: Resource not accessible by integration")),
    true,
  );
  assert.equal(isGitHubAppPermissionError(new Error("repository validation failed")), false);
});

test("QA integration plans only an explicitly authorized partial candidate subset", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Independent repair",
        status: "qa_review",
        branchName: "codex/task-1",
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Deferred enhancement",
        status: "qa_review",
        branchName: "codex/task-2",
      },
    ],
    reviews: [],
  };
  const plan = planQaIntegrations(state, {
    project: "demo",
    partialTasks: "task_1",
    partialActorId: "release-owner",
    partialReasonCode: "independent_repair",
  });

  assert.deepEqual(plan.projects[0].tasks.map((task) => task.id), ["task_1"]);
  assert.deepEqual(plan.projects[0].assembly, {
    mode: "authorized_partial",
    requestedTaskIds: ["task_1", "task_2"],
    includedTaskIds: ["task_1"],
    excludedTaskIds: ["task_2"],
    authorization: {
      actorId: "release-owner",
      reasonCode: "independent_repair",
    },
  });
  assert.throws(
    () => planQaIntegrations(state, { project: "demo", partialTasks: "task_1" }),
    /partial-actor-id/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1",
      partialActorId: "owner@example.com",
      partialReasonCode: "independent_repair",
    }),
    /non-sensitive --partial-actor-id/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1",
      partialActorId: "release-owner",
      partialReasonCode: "Contains descriptive text and a path /Users/example",
    }),
    /bounded --partial-reason-code/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1,task_2",
      partialActorId: "release-owner",
      partialReasonCode: "not_partial",
    }),
    /must exclude at least one/,
  );
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

    assert.equal(report.projects[0].status, "preview_missing");
    assert.equal(report.projects[0].tasks[0].status, "preview_missing");
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

test("QA integration rejects source drift before merge or candidate push", async () => {
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

test("successful QA integration freezes an immutable candidate at the healthy preview commit", async () => {
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

test("QA integration can sync default branch changes into QA and refresh a local preview checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-qa-default-sync-"));
  const remotePath = path.join(root, "remote.git");
  const repoPath = path.join(root, "repo");
  const previewPath = path.join(root, "preview");
  const healthServer = createServer(async (_request, response) => {
    try {
      const commitSha = await git(previewPath, ["rev-parse", "HEAD"]);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-studioops-commit": commitSha,
      });
      response.end(JSON.stringify({ ok: true, commitSha }));
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

    await git(root, ["clone", remotePath, previewPath]);
    await git(previewPath, ["checkout", "-b", "qa/integration", "origin/qa/integration"]);
    await writeFile(path.join(previewPath, "dirty-preview-note.txt"), "keep me\n", "utf8");

    await writeFile(path.join(repoPath, "app.txt"), "main update\n", "utf8");
    await git(repoPath, ["commit", "-am", "main update"]);
    await git(repoPath, ["push", "origin", "main"]);

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
    }), null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(path.join(root, "qa-workspaces"))} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "no_changes", JSON.stringify(report.projects[0], null, 2));
    assert.equal(report.projects[0].defaultBranchSync.status, "merged");
    assert.equal(report.projects[0].localQaPreview.status, "updated");
    assert.equal(report.projects[0].localQaPreview.after, await git(remotePath, ["rev-parse", "refs/heads/qa/integration"]));
    assert.equal(await git(remotePath, ["show", "refs/heads/qa/integration:app.txt"]), "main update");
    assert.equal(await readFile(path.join(previewPath, "app.txt"), "utf8"), "main update\n");
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

    assert.equal(report.projects[0].status, "preview_missing");
    assert.equal(await git(pushRemotePath, ["show", `refs/heads/${report.projects[0].integrationBranch}:app.txt`]), "feature");
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
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: {
        STUDIOOPS_GITHUB_APPS_DIR: path.join(root, "missing-github-apps"),
      },
    });
    const report = JSON.parse(runResult.stdout.trim());

    assert.equal(report.projects[0].status, "blocked");
    assert.equal(report.projects[0].tasks[0].status, "blocked");
    assert.match(report.projects[0].output, /GitHub App auth failed/);
    assert.match(report.projects[0].output, /credentials/);
    assert.doesNotMatch(report.projects[0].output, /could not read Username/);

    const state = readPersistedState(root);
    assert.equal(state.tasks[0].integrationStatus, "blocked");
    assert.match(state.comments[0].body, /GitHub App auth failed/);
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
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(await stateWithReviewEvidence({
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
    }), null, 2)}\n`, "utf8");

    const script = `
      import { runQaIntegration } from ${JSON.stringify(qaIntegrationModuleUrl)};
      const report = await runQaIntegration({ workspaceRoot: ${JSON.stringify(workspaceRoot)} });
      console.log(JSON.stringify(report));
    `;
    const runResult = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
    const report = JSON.parse(runResult.stdout.trim());
    const relativeWorkspace = path.relative(workspaceRoot, report.projects[0].workspacePath);

    assert.equal(report.projects[0].status, "preview_missing");
    assert.ok(relativeWorkspace);
    assert.equal(relativeWorkspace.startsWith(".."), false);
    assert.equal(path.isAbsolute(relativeWorkspace), false);
    assert.match(relativeWorkspace, /^workspace\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected QA branches use one idempotent integration PR and advance only after policy merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const pendingProject = pending.projects[0];
    const pendingTask = pendingProject.tasks[0];

    assert.equal(pendingProject.status, "pr_waiting", JSON.stringify(pendingProject, null, 2));
    assert.equal(pendingTask.status, "pr_waiting");
    assert.equal(pendingProject.protectedBranchFallback, true);
    assert.match(pendingProject.integrationCandidateBranch, /^studioops\/qa-candidate\/demo-[0-9a-f]{12}$/);
    assert.equal(pendingProject.integrationCandidateCommit, pendingProject.commit);
    assert.equal(pendingProject.integrationPr.url, "https://github.com/example/demo/pull/42");
    assert.equal(pendingProject.integrationCheckState.state, "pending");
    assert.match(pendingProject.integrationBlocker, /required human review/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", "refs/heads/qa/integration"]),
      fixture.baseSha,
    );
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", `refs/heads/${pendingProject.integrationCandidateBranch}`]),
      pendingProject.commit,
    );

    let persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationCandidateCommit, pendingProject.commit);
    assert.equal(persisted.tasks[0].integrationPrUrl, pendingProject.integrationPr.url);
    assert.equal(persisted.tasks[0].integrationCheckState.state, "pending");
    assert.match(persisted.tasks[0].integrationBlocker, /required human review/);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);

    const failed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "failed",
        FAKE_GH_REVIEW_DECISION: "",
      },
    });
    assert.equal(failed.projects[0].status, "checks_failed");
    assert.equal(failed.projects[0].commit, pendingProject.commit);
    assert.equal(failed.projects[0].integrationCandidateBranch, pendingProject.integrationCandidateBranch);
    assert.equal(failed.projects[0].integrationCheckState.failed, 1);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);

    const checksPassed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    assert.equal(checksPassed.projects[0].status, "pr_waiting");
    assert.equal(checksPassed.projects[0].integrationCheckState.state, "passed");
    assert.match(checksPassed.projects[0].integrationBlocker, /required human review/);

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${pendingProject.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "integration-merge",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    const mergeCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, [
      "push",
      "origin",
      "HEAD:refs/heads/qa/integration",
    ]);
    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: mergeCommit,
      },
    });

    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, mergeCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, mergeCommit);
    assert.match(merged.projects[0].output, /Source commits were not merged or pushed again/);
    assert.match(merged.projects[0].integrationCandidateCleanup, /Removed merged integration-candidate branch/);
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${pendingProject.integrationCandidateBranch}`]),
      "",
    );
    persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(persisted.tasks[0].integrationCandidateCommit, pendingProject.commit);
    assert.equal(persisted.tasks[0].integrationCommit, mergeCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.notEqual(persisted.tasks[0].integrationStatus, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merged protected QA handoff validates a squash result without repushing source commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-squash-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${project.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "integration-squash",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--squash", "FETCH_HEAD"]);
    await git(fixture.repoPath, ["commit", "-m", "squash QA candidate"]);
    const squashCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await assert.rejects(
      git(fixture.repoPath, ["merge-base", "--is-ancestor", project.integrationCandidateCommit, squashCommit]),
    );
    await git(fixture.repoPath, ["push", "origin", "HEAD:refs/heads/qa/integration"]);

    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: squashCommit,
      },
    });

    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, squashCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, squashCommit);
    assert.match(merged.projects[0].output, /Source commits were not merged or pushed again/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", "refs/heads/qa/integration"]),
      squashCommit,
    );
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${project.integrationCandidateBranch}`]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new QA tasks wait behind an existing protected integration handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-serialized-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await git(fixture.repoPath, ["checkout", "-b", "feature/task-2", "main"]);
    await writeFile(path.join(fixture.repoPath, "feature-2.txt"), "later QA feature\n", "utf8");
    await git(fixture.repoPath, ["add", "feature-2.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "later feature"]);
    const secondHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task-2"]);
    await addReviewedQaTask(root, {
      id: "task_2",
      projectId: "project_1",
      title: "Later feature task",
      status: "qa_review",
      branchName: "feature/task-2",
      prUrl: "",
    }, secondHead);

    const repeated = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: fixture.env,
    });

    assert.equal(repeated.projects[0].status, "pr_waiting");
    assert.deepEqual(repeated.projects[0].tasks.map((task) => task.taskId), ["task_1"]);
    assert.deepEqual(repeated.projects[0].deferredTaskIds, ["task_2"]);
    assert.equal(repeated.projects[0].integrationCandidateBranch, project.integrationCandidateBranch);
    assert.equal(repeated.projects[0].integrationCandidateCommit, project.integrationCandidateCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(
      (await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/studioops/qa-candidate"])).split("\n").filter(Boolean).length,
      1,
    );

    const persisted = readPersistedState(root);
    const laterTask = persisted.tasks.find((task) => task.id === "task_2");
    assert.equal(laterTask.integrationCandidateBranch || "", "");
    assert.equal(laterTask.integrationPrUrl || "", "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed protected handoffs are audited and safely replaced after new source review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-replacement-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const previous = pending.projects[0];

    const failed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "failed",
        FAKE_GH_REVIEW_DECISION: "",
      },
    });
    assert.equal(failed.projects[0].status, "checks_failed");
    let persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationStatus, "blocked");
    assert.equal(persisted.tasks[0].integrationValidation.status, "checks_failed");
    assert.equal(persisted.tasks[0].integrationSourceHeadSha, persisted.tasks[0].reviewSubjectSha);
    assert.equal(persisted.tasks[0].integrationSourceCandidateCycle, 1);

    await git(fixture.repoPath, ["checkout", "feature/task"]);
    await writeFile(path.join(fixture.repoPath, "feature.txt"), "corrected protected QA feature\n", "utf8");
    await git(fixture.repoPath, ["commit", "-am", "correct protected feature"]);
    const correctedHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task"]);
    await advanceReviewedQaTask(root, "task_1", correctedHead);

    await git(fixture.repoPath, ["checkout", "-b", "feature/task-2", "main"]);
    await writeFile(path.join(fixture.repoPath, "feature-2.txt"), "later reviewed feature\n", "utf8");
    await git(fixture.repoPath, ["add", "feature-2.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "later reviewed feature"]);
    const secondHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task-2"]);
    await addReviewedQaTask(root, {
      id: "task_2",
      projectId: "project_1",
      title: "Later feature task",
      status: "qa_review",
      branchName: "feature/task-2",
      prUrl: "",
    }, secondHead);

    const replacement = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_FAILED_PR_NUMBER: "42",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    const replacementProject = replacement.projects[0];

    assert.equal(replacementProject.status, "pr_waiting", JSON.stringify(replacementProject, null, 2));
    assert.equal(replacementProject.integrationPr.url, "https://github.com/example/demo/pull/43");
    assert.notEqual(replacementProject.integrationCandidateCommit, previous.integrationCandidateCommit);
    assert.deepEqual(replacementProject.tasks.map((task) => task.taskId), ["task_1", "task_2"]);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
    assert.equal((await readFile(fixture.prCloseLog, "utf8")).trim(), "close 42");
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${previous.integrationCandidateBranch}`]),
      "",
    );

    persisted = readPersistedState(root);
    const correctedTask = persisted.tasks.find((task) => task.id === "task_1");
    const laterTask = persisted.tasks.find((task) => task.id === "task_2");
    assert.equal(correctedTask.integrationPrUrl, "https://github.com/example/demo/pull/43");
    assert.equal(correctedTask.integrationSourceHeadSha, correctedHead);
    assert.equal(correctedTask.integrationSourceCandidateCycle, 2);
    assert.equal(correctedTask.integrationHandoffHistory.length, 1);
    assert.equal(correctedTask.integrationHandoffHistory[0].candidateCommit, previous.integrationCandidateCommit);
    assert.equal(correctedTask.integrationHandoffHistory[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(correctedTask.integrationHandoffHistory[0].checkState.state, "failed");
    assert.match(correctedTask.integrationHandoffHistory[0].cleanup, /Removed superseded/);
    assert.equal(laterTask.integrationPrUrl, "https://github.com/example/demo/pull/43");
    assert.equal(laterTask.integrationHandoffHistory, undefined);

    const repeated = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_FAILED_PR_NUMBER: "42",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    assert.equal(repeated.projects[0].status, "pr_waiting");
    assert.equal(repeated.projects[0].integrationPr.url, "https://github.com/example/demo/pull/43");
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
    assert.equal((await readFile(fixture.prCloseLog, "utf8")).trim(), "close 42");

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${replacementProject.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "replacement-merge",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    const mergeCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "HEAD:refs/heads/qa/integration"]);

    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: mergeCommit,
      },
    });
    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, mergeCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, mergeCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected QA handoff refuses changed candidate heads without force-pushing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-drift-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await git(fixture.repoPath, ["fetch", "origin", project.integrationCandidateBranch]);
    await git(fixture.repoPath, ["checkout", "-B", "tamper-candidate", "FETCH_HEAD"]);
    await writeFile(path.join(fixture.repoPath, "remote-change.txt"), "unexpected\n", "utf8");
    await git(fixture.repoPath, ["add", "remote-change.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "unexpected candidate change"]);
    const changedHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", `HEAD:refs/heads/${project.integrationCandidateBranch}`]);

    const drift = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: fixture.env,
    });
    assert.equal(drift.projects[0].status, "candidate_drift");
    assert.match(drift.projects[0].integrationBlocker, /will not overwrite/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", `refs/heads/${project.integrationCandidateBranch}`]),
      changedHead,
    );
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
