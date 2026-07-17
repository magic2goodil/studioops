#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { formatSelfUpdateReport, runSelfUpdate } from "./self-update.js";

const DEFAULT_INTERVAL_SECONDS = 300;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const rawKey = item.slice(2);
    const equalsIndex = rawKey.indexOf("=");
    if (equalsIndex !== -1) {
      args[rawKey.slice(0, equalsIndex)] = rawKey.slice(equalsIndex + 1);
      continue;
    }
    const key = rawKey;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanDefault(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function selfUpdateDefaults(config) {
  return {
    ...(config?.defaults?.selfUpdate || {}),
    ...(config?.selfUpdate || {}),
  };
}

async function optionsFrom(args) {
  const config = await loadConfig();
  const defaults = selfUpdateDefaults(config);
  return {
    repoPath: args.repo || args["repo-path"] || defaults.repoPath || process.cwd(),
    remote: args.remote || defaults.remote,
    branch: args.branch || defaults.branch || defaults.defaultBranch,
    staleRunMs: numberFrom(args["stale-run-ms"] || defaults.staleRunMs, undefined),
    restartAgentLabels: args.agents || args["restart-agents"] || defaults.restartAgentLabels || defaults.agents,
    restartAgents: args["no-restart"] ? false : booleanDefault(args.restart || defaults.restartAgents, true),
    commentTaskId: args.task || args["task-id"] || defaults.commentTaskId || defaults.taskId,
    notify: args["no-notify"] ? false : booleanDefault(args.notify || defaults.notify, false),
    recordNoop: booleanDefault(args["record-noop"] || defaults.recordNoop, false),
    dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    checkPids: args["check-pids"] ? true : booleanDefault(defaults.checkPids, false),
    intervalSeconds: numberFrom(args.interval || args["interval-seconds"] || defaults.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
  };
}

async function runOnce(args) {
  const options = await optionsFrom(args);
  const report = await runSelfUpdate(options);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatSelfUpdateReport(report));
  return report;
}

async function runWatch(args) {
  while (true) {
    const options = await optionsFrom(args);
    await runOnce(args);
    await new Promise((resolve) => {
      setTimeout(resolve, numberFrom(options.intervalSeconds, DEFAULT_INTERVAL_SECONDS) * 1000);
    });
    console.log("");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    console.log(`Mission Control Self Update

Usage:
  mission-control-self-update --plan
  mission-control-self-update
  mission-control-self-update --branch main --remote origin
  mission-control-self-update --task task_101 --notify
  mission-control self-update --plan

The self-updater fetches origin, fast-forwards the local main branch only from
a clean and fast-forwardable work tree, refuses to restart while active
builder/reviewer runs are in progress, and restarts the worker LaunchAgents
after a successful update. Use --plan or --dry-run to preview without merging
or restarting agents.
`);
    return;
  }

  if (args.watch || args.daemon) {
    await runWatch(args);
    return;
  }

  await runOnce(args);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
