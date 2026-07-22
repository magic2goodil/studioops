#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { readState } from "./store.js";
import { createSupervisorReport, formatSupervisorReport } from "./supervisor.js";
import { runResilientWorkerLoop } from "./worker-heartbeat.js";

const DEFAULT_INTERVAL_SECONDS = 300;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
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

function configSupervisorDefaults(config) {
  return {
    ...(config?.defaults?.supervisor || {}),
    ...(config?.supervisor || {}),
  };
}

function secondsFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function buildReport(args) {
  const config = await loadConfig();
  const supervisor = configSupervisorDefaults(config);
  const intervalSeconds = secondsFrom(
    args.interval || args["interval-seconds"] || supervisor.intervalSeconds,
    DEFAULT_INTERVAL_SECONDS,
  );
  const state = await readState();
  return createSupervisorReport(state, {
    baseUrl: args["base-url"] || supervisor.baseUrl || "http://127.0.0.1:4317",
    includeWaiting: args.all || args["include-waiting"],
    intervalSeconds,
    mode: args.watch || args.daemon ? "watch" : "once",
  });
}

function printReport(report, args) {
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatSupervisorReport(report));
}

async function runOnce(args) {
  const report = await buildReport(args);
  printReport(report, args);
  return report;
}

async function runWatch(args) {
  const config = await loadConfig();
  const defaults = configSupervisorDefaults(config);
  const intervalSeconds = secondsFrom(
    args.interval || args["interval-seconds"] || defaults.intervalSeconds,
    DEFAULT_INTERVAL_SECONDS,
  );
  await runResilientWorkerLoop({
    worker: "supervisor",
    intervalSeconds,
    runOnce: async () => {
      await runOnce(args);
      console.log("");
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    console.log(`StudioOps Supervisor

Usage:
  studioops-supervisor
  studioops-supervisor --json
  studioops-supervisor --watch --interval 300
  studioops-supervisor --all
  studioops supervisor --watch --interval 300

The supervisor is read-oriented. It inspects every project and task, then prints the
next builder, reviewer, dependency, or owner handoff action. It does not merge,
deploy, or send external notifications.

By default it hides passive dependency-waiting tasks. Use --all to show those too.
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
