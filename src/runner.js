import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { findProject, mutateState } from "./store.js";

const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const RUN_OUTPUT_DIR = path.join(process.cwd(), "data", "run-outputs");
const RUNNABLE_GROUPS = new Set(["builder", "reviewer"]);
const RUNNABLE_STATUSES = new Set(["queued"]);
const ACTIVE_STATUSES = new Set(["running"]);
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RUNNER_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");

function nextId(items, prefix) {
  const max = (items || [])
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function projectAllowed(run, project, options) {
  const onlyProjects = normalizeList(options.project || options.projects);
  if (!onlyProjects.length) return true;
  return onlyProjects.includes(project?.key) || onlyProjects.includes(project?.id) || onlyProjects.includes(run.projectId);
}

export function planRunnableRuns(state, input = {}) {
  const limit = Math.max(1, Number(input.limit || input.maxRuns || 1));
  const activeCount = (state.runs || []).filter((run) => ACTIVE_STATUSES.has(run.status)).length;
  const available = Math.max(0, limit - activeCount);
  const runnable = [];
  const skipped = [];

  for (const run of state.runs || []) {
    const project = findProject(state, run.projectId);
    if (!RUNNABLE_STATUSES.has(run.status)) continue;
    if (!RUNNABLE_GROUPS.has(run.group)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "not_runner_group" });
      continue;
    }
    if (!projectAllowed(run, project, input)) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "project_filter" });
      continue;
    }
    if (!project?.repoPath) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "missing_repo_path" });
      continue;
    }
    if (runnable.length >= available) {
      skipped.push({ runId: run.id, taskId: run.taskId, reason: "runner_limit" });
      continue;
    }
    runnable.push({
      ...run,
      project,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    limit,
    activeCount,
    available,
    runnable,
    skipped,
  };
}

function runnerPrompt(run, project) {
  const missionControlCli = path.join(process.cwd(), "src", "mission-control-cli.js");
  const taskUrl = run.taskUrl || `http://127.0.0.1:4317/tasks/${run.taskId}`;
  return `Mission Control automation run: ${run.id}

You are being launched automatically by Mission Control.

Run details:
- Run ID: ${run.id}
- Role: ${run.role}
- Action: ${run.actionType}
- Project: ${project?.name || run.projectId}
- Repository path: ${project?.repoPath || "(not recorded)"}
- Task: ${run.taskId}
- Task URL: ${taskUrl}
- Branch: ${run.branchName || "(not recorded)"}
- PR: ${run.prUrl || "(not recorded)"}

Mission Control CLI:
\`node ${missionControlCli}\`

Automation rules:
- You may create local branches, edit code, run validation, commit, push, and open/update a PR when the task requires it.
- Do not merge PRs.
- Do not deploy production.
- Do not send emails, push notifications, Discord messages, SMS, payment actions, toy/device actions, or other external side effects unless the task explicitly authorizes that action.
- Do not commit secrets, tokens, .env files, private user data, or unrelated changes.
- If you discover necessary follow-up work, add it to Mission Control with \`node ${missionControlCli} add-task ...\`, including user story and acceptance criteria.
- When implementation/review work is ready, update the task and leave a clear Mission Control comment with changed files, validation, known gaps, branch/PR, and next review step.
- If blocked, add a Mission Control comment explaining the blocker and set the task to an appropriate blocked/needs_changes state.
- The runner will mark this run completed or failed based on your process exit code.

Original prompt:

${run.prompt || ""}
`;
}

async function appendTaskComment(state, run, body, now, author = "Mission Control Runner") {
  state.comments = state.comments || [];
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId: run.taskId,
    author,
    body,
    createdAt: now,
  });
}

export async function claimRuns(input = {}) {
  const limit = Math.max(1, Number(input.limit || input.maxRuns || 1));
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    state.events = state.events || [];
    state.comments = state.comments || [];
    const now = new Date().toISOString();
    const activeCount = state.runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
    const available = Math.max(0, limit - activeCount);
    if (available <= 0) return [];

    const claimed = [];
    for (const run of state.runs) {
      if (claimed.length >= available) break;
      const project = findProject(state, run.projectId);
      if (!RUNNABLE_STATUSES.has(run.status)) continue;
      if (!RUNNABLE_GROUPS.has(run.group)) continue;
      if (!projectAllowed(run, project, input)) continue;
      if (!project?.repoPath) {
        run.status = "failed";
        run.exitCode = "missing_repo_path";
        run.completedAt = now;
        run.updatedAt = now;
        await appendTaskComment(state, run, `${run.id} failed before launch: project repository path is not recorded.`, now);
        continue;
      }

      run.status = "running";
      run.provider = input.provider || "codex-cli";
      run.startedAt = now;
      run.completedAt = "";
      run.exitCode = "";
      run.failureNotifiedAt = "";
      run.notificationFailedAt = "";
      run.notificationStatus = "";
      run.notificationChannel = "";
      run.notificationError = "";
      run.updatedAt = now;
      run.runnerPid = String(process.pid);
      run.outputPath = path.join(RUN_OUTPUT_DIR, `${run.id}.log`);
      run.lastMessagePath = path.join(RUN_OUTPUT_DIR, `${run.id}.last-message.md`);

      state.events.push({
        id: nextId(state.events, "event"),
        type: "run_claimed",
        projectId: run.projectId,
        taskId: run.taskId,
        message: `${run.id} claimed by Mission Control runner`,
        createdAt: now,
      });
      await appendTaskComment(state, run, `${run.id} started by Mission Control Runner using Codex CLI.`, now);
      claimed.push({
        ...run,
        project,
      });
    }
    return claimed;
  });
}

export async function completeRun(runId, input = {}) {
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    state.events = state.events || [];
    state.comments = state.comments || [];
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const now = new Date().toISOString();
    run.status = input.status || "completed";
    run.exitCode = String(input.exitCode ?? "");
    run.completedAt = now;
    run.updatedAt = now;
    run.outputPath = input.outputPath || run.outputPath || "";
    run.lastMessagePath = input.lastMessagePath || run.lastMessagePath || "";
    run.notes = String(input.notes || run.notes || "").trim();

    const summary = run.status === "completed"
      ? `${run.id} completed. Output: ${run.outputPath || "(not recorded)"}`
      : `${run.id} failed with exit code ${run.exitCode || "unknown"}. Output: ${run.outputPath || "(not recorded)"}`;
    await appendTaskComment(state, run, summary, now);

    state.events.push({
      id: nextId(state.events, "event"),
      type: run.status === "completed" ? "run_completed" : "run_failed",
      projectId: run.projectId,
      taskId: run.taskId,
      message: summary,
      createdAt: now,
    });

    return run;
  });
}

export async function runClaimedRun(run, input = {}) {
  await mkdir(RUN_OUTPUT_DIR, { recursive: true });
  const codexBin = input.codexBin || process.env.MISSION_CONTROL_CODEX_BIN || DEFAULT_CODEX_BIN;
  const childPath = input.path || process.env.MISSION_CONTROL_RUNNER_PATH || DEFAULT_RUNNER_PATH;
  const timeoutMs = Math.max(60_000, Number(input.timeoutMs || process.env.MISSION_CONTROL_RUN_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS));
  const outputPath = run.outputPath || path.join(RUN_OUTPUT_DIR, `${run.id}.log`);
  const lastMessagePath = run.lastMessagePath || path.join(RUN_OUTPUT_DIR, `${run.id}.last-message.md`);
  const log = createWriteStream(outputPath, { flags: "a" });
  const prompt = runnerPrompt(run, run.project);
  const args = [
    "exec",
    "--cd",
    run.project.repoPath,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    lastMessagePath,
    "-",
  ];

  return new Promise((resolve) => {
    let settled = false;
    log.write(`Mission Control Runner started ${run.id} at ${new Date().toISOString()}\n`);
    log.write(`Command: ${codexBin} ${args.join(" ")}\n\n`);
    log.write(`PATH: ${childPath}\n`);
    log.write(`Timeout: ${Math.round(timeoutMs / 1000)}s\n\n`);
    const child = spawn(codexBin, args, {
      cwd: run.project.repoPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: childPath,
        MISSION_CONTROL_RUN_ID: run.id,
        MISSION_CONTROL_TASK_ID: run.taskId,
      },
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      log.write(`\nRunner timeout after ${Math.round(timeoutMs / 1000)}s. Sending SIGTERM to child process.\n`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          log.write("\nRunner child did not exit after SIGTERM. Sending SIGKILL.\n");
          child.kill("SIGKILL");
        }
      }, 10_000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => log.write(chunk));
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.on("error", async (error) => {
      settled = true;
      clearTimeout(timeout);
      log.write(`\nRunner spawn error: ${error.message}\n`);
      log.end();
      const completed = await completeRun(run.id, {
        status: "failed",
        exitCode: "spawn_error",
        outputPath,
        lastMessagePath,
        notes: error.message,
      });
      resolve(completed);
    });
    child.on("close", async (code) => {
      settled = true;
      clearTimeout(timeout);
      let notes = "";
      try {
        notes = (await readFile(lastMessagePath, "utf8")).trim();
      } catch {
        notes = "";
      }
      log.write(`\nMission Control Runner finished ${run.id} at ${new Date().toISOString()} with code ${code}\n`);
      log.end();
      const completed = await completeRun(run.id, {
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
        outputPath,
        lastMessagePath,
        notes,
      });
      resolve(completed);
    });
    child.stdin.end(prompt);
  });
}

export async function runQueuedRuns(input = {}) {
  const claimed = await claimRuns(input);
  const results = [];
  for (const run of claimed) {
    results.push(await runClaimedRun(run, input));
  }
  return {
    generatedAt: new Date().toISOString(),
    claimed: claimed.map((run) => run.id),
    results,
  };
}

export function formatRunnerReport(report) {
  const lines = [
    `Mission Control runner sweep (${report.generatedAt})`,
    `Claimed: ${report.claimed.length}  Finished: ${report.results.length}`,
    "",
  ];
  if (!report.claimed.length) {
    lines.push("No queued runs claimed.");
    return lines.join("\n");
  }
  for (const run of report.results) {
    lines.push(`[${run.id}] ${run.status}${run.exitCode ? ` (${run.exitCode})` : ""}`);
    lines.push(`  Task: ${run.taskId}`);
    if (run.outputPath) lines.push(`  Output: ${run.outputPath}`);
    if (run.lastMessagePath) lines.push(`  Last message: ${run.lastMessagePath}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatRunnerPlan(plan) {
  const lines = [
    `Mission Control runner plan (${plan.generatedAt})`,
    `Limit: ${plan.limit}  Active: ${plan.activeCount}  Available: ${plan.available}  Runnable: ${plan.runnable.length}`,
    "",
  ];
  if (!plan.runnable.length) {
    lines.push("No queued builder/reviewer runs are ready for this runner.");
  }
  for (const run of plan.runnable) {
    lines.push(`[${run.id}] ${run.role} ${run.actionType}`);
    lines.push(`  Project: ${run.project?.key || run.projectId}`);
    lines.push(`  Task: ${run.taskId}`);
    lines.push(`  Repo: ${run.project?.repoPath || "(missing)"}`);
    lines.push("");
  }
  const skippedSummary = (plan.skipped || []).reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  const skippedText = Object.entries(skippedSummary)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  if (skippedText) lines.push(`Skipped: ${skippedText}`);
  return lines.join("\n").trimEnd();
}
