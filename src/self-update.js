import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  activeSelfUpdateLease,
  createSelfUpdateLease,
  DEFAULT_SELF_UPDATE_LEASE_MS,
} from "./self-update-lease.js";
import { mutateState, readState } from "./store.js";
import { deployRuntime } from "./runtime-install.js";

const execFileAsync = promisify(execFile);

const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const DEFAULT_STALE_RUN_MS = 2 * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["running"]);
const BLOCKING_RUN_GROUPS = new Set(["builder", "reviewer"]);
const DEFAULT_RESTART_AGENT_LABELS = [
  "com.codex.mission-control.web",
  "com.codex.mission-control.steward",
  "com.codex.mission-control.supervisor",
  "com.codex.mission-control.dispatcher",
  "com.codex.mission-control.runner",
  "com.codex.mission-control.notifier",
  "com.codex.mission-control.qa-integration",
  "com.codex.mission-control.promotion",
  "com.codex.mission-control.watchdog",
];

export { DEFAULT_RESTART_AGENT_LABELS, DEFAULT_STALE_RUN_MS, DEFAULT_SELF_UPDATE_LEASE_MS };

function nextId(items, prefix) {
  const max = (items || [])
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [...fallback];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function shortCommit(value) {
  return value ? String(value).slice(0, 12) : "";
}

function truncate(value, max = 1000) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env || {}),
    },
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function gitMaybe(args, options = {}) {
  try {
    return { ok: true, output: await git(args, options) };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ""}${error.stderr || error.message}`.trim(),
    };
  }
}

function parseAheadBehind(value) {
  const [localAheadRaw, remoteAheadRaw] = String(value || "0 0").trim().split(/\s+/);
  return {
    localAhead: Number(localAheadRaw) || 0,
    remoteAhead: Number(remoteAheadRaw) || 0,
  };
}

function pidIsAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function activeRunStaleReason(run, input = {}) {
  if (run.completedAt) return "completed_at_recorded";

  const pid = String(run.runnerPid || "").trim();
  if (pid && input.pidIsAlive && !input.pidIsAlive(pid)) return `pid_not_running:${pid}`;
  if (pid && input.checkPids && !pidIsAlive(pid)) return `pid_not_running:${pid}`;

  const staleRunMs = Math.max(1, Number(input.staleRunMs || DEFAULT_STALE_RUN_MS));
  const nowMs = Number(input.nowMs || Date.now());
  const startedMs = Date.parse(run.startedAt || "");
  if (Number.isFinite(startedMs) && nowMs - startedMs > staleRunMs) {
    return `started_at_stale:${run.startedAt}`;
  }
  return "";
}

export function classifyActiveRuns(state, input = {}) {
  const blocking = [];
  const stale = [];

  for (const run of state?.runs || []) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    if (!BLOCKING_RUN_GROUPS.has(run.group)) continue;

    const staleReason = activeRunStaleReason(run, input);
    const item = {
      id: run.id,
      taskId: run.taskId || "",
      projectId: run.projectId || "",
      group: run.group || "",
      role: run.role || "",
      actionType: run.actionType || "",
      startedAt: run.startedAt || "",
      runnerPid: run.runnerPid || "",
      staleReason,
    };
    if (staleReason) stale.push(item);
    else blocking.push(item);
  }

  return { blocking, stale };
}

async function mutateSelfUpdateState(input, mutator) {
  if (input.state) return mutator(input.state);
  return mutateState(mutator);
}

async function acquireSelfUpdateLease(plan, input = {}) {
  return mutateSelfUpdateState(input, async (state) => {
    state.meta = state.meta || {};
    const activeLease = activeSelfUpdateLease(state, input);
    if (activeLease) {
      return {
        acquired: false,
        status: "blocked_self_update_in_progress",
        canUpdate: false,
        selfUpdateLease: activeLease,
        reason: `Another StudioOps self-update is already in progress until ${activeLease.expiresAt}.`,
      };
    }

    const activeRuns = classifyActiveRuns(state, input);
    if (activeRuns.blocking.length) {
      return {
        acquired: false,
        status: "blocked_active_runs",
        canUpdate: false,
        activeRunBlockers: activeRuns.blocking,
        staleActiveRuns: activeRuns.stale,
        reason: `${activeRuns.blocking.length} builder/reviewer run(s) are still active.`,
      };
    }

    const lease = createSelfUpdateLease({
      ...input,
      repoPath: plan.repoPath,
      branch: plan.branch,
      remoteRef: plan.remoteRef,
    });
    state.meta.selfUpdateLease = lease;

    return {
      acquired: true,
      selfUpdateLease: lease,
      activeRunBlockers: [],
      staleActiveRuns: activeRuns.stale,
    };
  });
}

async function releaseSelfUpdateLease(lease, input = {}) {
  if (!lease?.id) return;
  await mutateSelfUpdateState(input, async (state) => {
    const current = state?.meta?.selfUpdateLease;
    if (current?.id === lease.id) delete state.meta.selfUpdateLease;
  });
}

async function inspectGitRepository(input = {}) {
  const repoPath = path.resolve(input.repoPath || process.cwd());
  const remote = String(input.remote || DEFAULT_REMOTE).trim() || DEFAULT_REMOTE;
  const branch = String(input.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const localRef = `refs/heads/${branch}`;
  const displayRemoteRef = `${remote}/${branch}`;

  const inside = await gitMaybe(["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
  if (!inside.ok || inside.output !== "true") {
    return {
      repoPath,
      remote,
      branch,
      remoteRef: displayRemoteRef,
      status: "blocked_not_git_repo",
      canUpdate: false,
      reason: inside.output || "Repository path is not a git work tree.",
    };
  }

  if (input.fetch !== false) {
    const fetch = await gitMaybe(["fetch", remote, "--prune"], {
      cwd: repoPath,
      timeout: input.fetchTimeoutMs || 300_000,
    });
    if (!fetch.ok) {
      return {
        repoPath,
        remote,
        branch,
        remoteRef: displayRemoteRef,
        status: "blocked_fetch_failed",
        canUpdate: false,
        reason: fetch.output || `Could not fetch ${remote}.`,
      };
    }
  }

  const currentBranchResult = await gitMaybe(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  const currentBranch = currentBranchResult.ok ? currentBranchResult.output : "";
  const localCommitResult = await gitMaybe(["rev-parse", localRef], { cwd: repoPath });
  const remoteCommitResult = await gitMaybe(["rev-parse", remoteRef], { cwd: repoPath });
  const dirtyOutput = await git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoPath });
  const dirtyFiles = dirtyOutput.split("\n").map((item) => item.trim()).filter(Boolean);

  if (!localCommitResult.ok) {
    return {
      repoPath,
      remote,
      branch,
      currentBranch,
      remoteRef: displayRemoteRef,
      status: "blocked_missing_local_branch",
      canUpdate: false,
      dirtyFiles,
      reason: localCommitResult.output || `Local branch ${branch} does not exist.`,
    };
  }

  if (!remoteCommitResult.ok) {
    return {
      repoPath,
      remote,
      branch,
      currentBranch,
      localCommit: localCommitResult.output,
      remoteRef: displayRemoteRef,
      status: "blocked_missing_remote_branch",
      canUpdate: false,
      dirtyFiles,
      reason: remoteCommitResult.output || `Remote branch ${displayRemoteRef} does not exist.`,
    };
  }

  const localCommit = localCommitResult.output;
  const remoteCommit = remoteCommitResult.output;
  const aheadBehind = parseAheadBehind(await git(["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`], { cwd: repoPath }));
  const updateAvailable = aheadBehind.remoteAhead > 0 && aheadBehind.localAhead === 0;

  return {
    repoPath,
    remote,
    branch,
    currentBranch,
    localCommit,
    remoteCommit,
    remoteRef: displayRemoteRef,
    localAhead: aheadBehind.localAhead,
    remoteAhead: aheadBehind.remoteAhead,
    updateAvailable,
    dirtyFiles,
    status: updateAvailable ? "update_available" : "up_to_date",
    canUpdate: updateAvailable,
    reason: updateAvailable
      ? `${displayRemoteRef} is ${aheadBehind.remoteAhead} commit(s) ahead of local ${branch}.`
      : `${branch} is already aligned with ${displayRemoteRef}.`,
  };
}

function applySafetyDecision(gitPlan, activeRuns) {
  if (!gitPlan.updateAvailable) {
    if (gitPlan.localAhead > 0 || gitPlan.remoteAhead > 0) {
      return {
        ...gitPlan,
        status: "blocked_non_fast_forward",
        canUpdate: false,
        reason: `Local ${gitPlan.branch} cannot fast-forward to ${gitPlan.remoteRef}: local ahead ${gitPlan.localAhead || 0}, remote ahead ${gitPlan.remoteAhead || 0}.`,
      };
    }
    return {
      ...gitPlan,
      canUpdate: false,
    };
  }

  if (gitPlan.currentBranch !== gitPlan.branch) {
    return {
      ...gitPlan,
      status: "blocked_wrong_branch",
      canUpdate: false,
      reason: `Current branch is ${gitPlan.currentBranch || "detached HEAD"}; self-update only runs from ${gitPlan.branch}.`,
    };
  }

  if (gitPlan.dirtyFiles?.length) {
    return {
      ...gitPlan,
      status: "blocked_dirty",
      canUpdate: false,
      reason: "Working tree has uncommitted or untracked files.",
    };
  }

  if (activeRuns.blocking.length) {
    return {
      ...gitPlan,
      status: "blocked_active_runs",
      canUpdate: false,
      reason: `${activeRuns.blocking.length} builder/reviewer run(s) are still active.`,
    };
  }

  return {
    ...gitPlan,
    status: "ready",
    canUpdate: true,
  };
}

export async function planSelfUpdate(input = {}) {
  const state = input.state || await readState();
  const gitPlan = await inspectGitRepository(input);
  const activeRuns = classifyActiveRuns(state, input);
  const safetyPlan = applySafetyDecision(gitPlan, activeRuns);
  const restartAgentLabels = normalizeList(input.restartAgentLabels || input.agents, DEFAULT_RESTART_AGENT_LABELS);

  return {
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(input.dryRun || input.plan),
    ...safetyPlan,
    activeRunBlockers: activeRuns.blocking,
    staleActiveRuns: activeRuns.stale,
    restartAgentLabels,
  };
}

async function restartLaunchAgents(labels, input = {}) {
  if (!labels.length) return [];
  if (input.restartAgents === false) {
    return labels.map((label) => ({ label, status: "skipped", reason: "restart_disabled" }));
  }
  if (process.platform !== "darwin") {
    return labels.map((label) => ({ label, status: "skipped", reason: "not_macos" }));
  }

  const uid = String(process.getuid?.() || "");
  const results = [];
  for (const label of labels) {
    try {
      const result = await execFileAsync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
        timeout: input.restartTimeoutMs || 15_000,
      });
      results.push({
        label,
        status: "restarted",
        output: truncate(`${result.stdout || ""}${result.stderr || ""}`, 500),
      });
    } catch (error) {
      results.push({
        label,
        status: "failed",
        reason: truncate(`${error.stdout || ""}${error.stderr || error.message}`, 500),
      });
    }
  }
  return results;
}

function appleScriptString(value) {
  return `"${String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", " ")
    .slice(0, 240)}"`;
}

async function sendSelfUpdateNotification(report, input = {}) {
  if (!booleanOption(input.notify, false)) return { status: "skipped", reason: "disabled" };
  if (process.platform !== "darwin") return { status: "skipped", reason: "not_macos" };

  const title = report.status === "updated"
    ? "StudioOps updated"
    : "StudioOps self-update skipped";
  const body = selfUpdateSummary(report);
  const script = [
    "display notification",
    appleScriptString(body),
    "with title",
    appleScriptString(title),
  ].join(" ");

  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: input.notificationTimeoutMs || 10_000 });
    return { status: "sent", channel: "macos" };
  } catch (error) {
    return {
      status: "failed",
      channel: "macos",
      reason: truncate(`${error.stdout || ""}${error.stderr || error.message}`, 500),
    };
  }
}

function selfUpdateSummary(report) {
  if (report.status === "updated") {
    return `Fast-forwarded ${report.branch} from ${shortCommit(report.previousCommit)} to ${shortCommit(report.currentCommit)} from ${report.remoteRef}.`;
  }
  if (report.status === "up_to_date") {
    return `${report.branch} is already aligned with ${report.remoteRef}.`;
  }
  if (report.status === "ready") {
    return `Dry run: ${report.branch} can fast-forward from ${shortCommit(report.localCommit)} to ${shortCommit(report.remoteCommit)}.`;
  }
  return `Self-update skipped: ${report.reason || report.status}.`;
}

function selfUpdateComment(report) {
  const lines = [
    `StudioOps self-update ${report.status}.`,
    "",
    selfUpdateSummary(report),
  ];

  if (report.status === "blocked_dirty" && report.dirtyFiles?.length) {
    lines.push("", "Dirty files:", ...report.dirtyFiles.slice(0, 20).map((file) => `- ${file}`));
  }
  if (report.status === "blocked_active_runs" && report.activeRunBlockers?.length) {
    lines.push("", "Active runs:", ...report.activeRunBlockers.map((run) => `- ${run.id} (${run.role || run.group}) task ${run.taskId}`));
  }
  if (report.staleActiveRuns?.length) {
    lines.push("", "Stale active runs ignored:", ...report.staleActiveRuns.map((run) => `- ${run.id}: ${run.staleReason}`));
  }
  if (report.restartResults?.length) {
    lines.push("", "LaunchAgent restart results:", ...report.restartResults.map((item) => `- ${item.label}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`));
  }
  if (report.notification?.status && report.notification.status !== "skipped") {
    lines.push("", `Notification: ${report.notification.status}${report.notification.reason ? ` (${report.notification.reason})` : ""}`);
  }

  return lines.join("\n");
}

async function recordSelfUpdateResult(report, input = {}) {
  if (input.record === false || report.dryRun) return { status: "skipped", reason: "record_disabled" };
  if (report.status === "up_to_date" && !booleanOption(input.recordNoop, false)) {
    return { status: "skipped", reason: "up_to_date" };
  }

  const taskId = String(input.commentTaskId || input.task || input.taskId || "").trim();
  const body = selfUpdateComment(report);
  const now = new Date().toISOString();

  return mutateState(async (state) => {
    state.events = state.events || [];
    state.comments = state.comments || [];
    const event = {
      id: nextId(state.events, "event"),
      type: `self_update_${report.status}`,
      projectId: "",
      taskId,
      message: truncate(selfUpdateSummary(report), 300),
      createdAt: now,
    };
    state.events.push(event);

    let comment = null;
    if (taskId) {
      const task = (state.tasks || []).find((item) => item.id === taskId);
      if (task) {
        comment = {
          id: nextId(state.comments, "comment"),
          taskId,
          author: "StudioOps Self Update",
          body,
          createdAt: now,
        };
        state.comments.push(comment);
      }
    }

    return { status: "recorded", eventId: event.id, commentId: comment?.id || "" };
  });
}

export async function runSelfUpdate(input = {}) {
  const dryRun = Boolean(input.dryRun || input.plan);
  const plan = await planSelfUpdate({ ...input, dryRun });

  if (dryRun) return plan;

  if (!plan.canUpdate) {
    const blockedReport = {
      ...plan,
      notification: await sendSelfUpdateNotification(plan, input),
    };
    blockedReport.record = await recordSelfUpdateResult(blockedReport, input);
    return blockedReport;
  }

  const leaseResult = await acquireSelfUpdateLease(plan, input);
  if (!leaseResult.acquired) {
    const blockedReport = {
      ...plan,
      ...leaseResult,
      dryRun: false,
      canUpdate: false,
    };
    delete blockedReport.acquired;
    blockedReport.notification = await sendSelfUpdateNotification(blockedReport, input);
    blockedReport.record = await recordSelfUpdateResult(blockedReport, input);
    return blockedReport;
  }

  try {
    const finalPlan = {
      ...(await planSelfUpdate({ ...input, dryRun: false })),
      selfUpdateLease: leaseResult.selfUpdateLease,
    };

    if (!finalPlan.canUpdate) {
      const blockedReport = {
        ...finalPlan,
        canUpdate: false,
      };
      blockedReport.notification = await sendSelfUpdateNotification(blockedReport, input);
      blockedReport.record = await recordSelfUpdateResult(blockedReport, input);
      return blockedReport;
    }

    await git(["merge", "--ff-only", finalPlan.remoteRef], { cwd: finalPlan.repoPath, timeout: input.mergeTimeoutMs || 300_000 });
    const currentCommit = await git(["rev-parse", `refs/heads/${finalPlan.branch}`], { cwd: finalPlan.repoPath });
    const updatedReport = {
      ...finalPlan,
      status: "updated",
      canUpdate: false,
      updated: true,
      previousCommit: finalPlan.localCommit,
      currentCommit,
      reason: `Fast-forwarded ${finalPlan.branch} to ${shortCommit(currentCommit)}.`,
    };

    if (input.deployRuntime !== false) {
      try {
        updatedReport.runtimeDeployment = await deployRuntime({
          sourceRoot: finalPlan.repoPath,
          runtimeRoot: input.runtimeRoot || process.env.MISSION_CONTROL_RUNTIME_ROOT,
        });
      } catch (error) {
        updatedReport.status = "runtime_deploy_failed";
        updatedReport.updated = false;
        updatedReport.reason = `Source updated, but the stable runtime could not be published: ${error.message}`;
        updatedReport.notification = await sendSelfUpdateNotification(updatedReport, input);
        updatedReport.record = await recordSelfUpdateResult(updatedReport, input);
        return updatedReport;
      }
    }

    updatedReport.restartResults = await restartLaunchAgents(finalPlan.restartAgentLabels, input);
    updatedReport.notification = await sendSelfUpdateNotification(updatedReport, input);
    updatedReport.record = await recordSelfUpdateResult(updatedReport, input);

    return updatedReport;
  } finally {
    await releaseSelfUpdateLease(leaseResult.selfUpdateLease, input);
  }
}

export function formatSelfUpdateReport(report) {
  const lines = [
    `StudioOps self-update (${report.generatedAt})`,
    `Status: ${report.status}${report.dryRun ? "  DRY RUN" : ""}`,
    `Repo: ${report.repoPath}`,
    `Branch: ${report.branch}  Remote: ${report.remoteRef}`,
  ];

  if (report.localCommit || report.remoteCommit) {
    lines.push(`Commits: local ${shortCommit(report.localCommit)}  remote ${shortCommit(report.remoteCommit)}`);
  }
  if (Number.isFinite(report.localAhead) || Number.isFinite(report.remoteAhead)) {
    lines.push(`Divergence: local ahead ${report.localAhead || 0}  remote ahead ${report.remoteAhead || 0}`);
  }
  if (report.previousCommit || report.currentCommit) {
    lines.push(`Updated: ${shortCommit(report.previousCommit)} -> ${shortCommit(report.currentCommit)}`);
  }
  if (report.runtimeDeployment?.releasePath) lines.push(`Runtime: ${report.runtimeDeployment.releasePath}`);
  if (report.reason) lines.push(`Reason: ${report.reason}`);

  if (report.dirtyFiles?.length) {
    lines.push("", "Dirty files:");
    for (const file of report.dirtyFiles.slice(0, 20)) lines.push(`- ${file}`);
    if (report.dirtyFiles.length > 20) lines.push(`- ... ${report.dirtyFiles.length - 20} more`);
  }

  if (report.activeRunBlockers?.length) {
    lines.push("", "Active builder/reviewer runs:");
    for (const run of report.activeRunBlockers) {
      lines.push(`- ${run.id} ${run.role || run.group}${run.taskId ? ` task ${run.taskId}` : ""}${run.startedAt ? ` since ${run.startedAt}` : ""}`);
    }
  }

  if (report.staleActiveRuns?.length) {
    lines.push("", "Stale active runs ignored:");
    for (const run of report.staleActiveRuns) lines.push(`- ${run.id}: ${run.staleReason}`);
  }

  if (report.restartResults?.length) {
    lines.push("", "LaunchAgent restarts:");
    for (const item of report.restartResults) {
      lines.push(`- ${item.label}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`);
    }
  } else if (report.restartAgentLabels?.length && report.status === "ready") {
    lines.push("", "LaunchAgents to restart after update:");
    for (const label of report.restartAgentLabels) lines.push(`- ${label}`);
  }

  if (report.record) {
    lines.push("", `Record: ${report.record.status}${report.record.commentId ? ` comment ${report.record.commentId}` : ""}${report.record.reason ? ` (${report.record.reason})` : ""}`);
  }
  if (report.notification) {
    lines.push(`Notification: ${report.notification.status}${report.notification.reason ? ` (${report.notification.reason})` : ""}`);
  }

  return lines.join("\n").trimEnd();
}
