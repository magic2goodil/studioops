import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { environmentForTestControlRoot } from "../../scripts/test-environment.js";

const execFileAsync = promisify(execFile);
export const qaIntegrationModuleUrl = pathToFileURL(path.join(process.cwd(), "src/qa-integration.js")).href;
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

export async function run(command, args, options = {}) {
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

export async function git(repoPath, args) {
  const result = await run("git", args, { cwd: repoPath });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

export async function stateWithReviewEvidence(state) {
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

export async function runQaIntegrationFixture(root, options = {}) {
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

export async function addReviewedQaTask(root, task, subjectSha) {
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

export async function advanceReviewedQaTask(root, taskId, subjectSha) {
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

export async function createProtectedBranchFixture(root) {
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
