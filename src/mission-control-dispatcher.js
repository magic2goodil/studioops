#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { readState } from "./store.js";
import { createSupervisorReport } from "./supervisor.js";
import { dispatchSupervisorActions, formatDispatchReport, planDispatches } from "./dispatcher.js";
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

function secondsFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function dispatcherDefaults(config) {
  return {
    ...(config?.defaults?.supervisor || {}),
    ...(config?.defaults?.dispatcher || {}),
    ...(config?.supervisor || {}),
    ...(config?.dispatcher || {}),
  };
}

function optionsFrom(args, config) {
  const defaults = dispatcherDefaults(config);
  const intervalSeconds = secondsFrom(
    args.interval || args["interval-seconds"] || defaults.intervalSeconds,
    DEFAULT_INTERVAL_SECONDS,
  );
  return {
    baseUrl: args["base-url"] || defaults.baseUrl || "http://127.0.0.1:4317",
    builderConcurrency: numberFrom(args["builder-concurrency"] || defaults.builderConcurrency, 3),
    reviewerConcurrency: numberFrom(args["reviewer-concurrency"] || defaults.reviewerConcurrency, 3),
    ownerConcurrency: numberFrom(args["owner-concurrency"] || defaults.ownerConcurrency, 10),
    maxDispatchesPerSweep: numberFrom(args.limit || args["max-dispatches"] || defaults.maxDispatchesPerSweep, 6),
    provider: args.provider || defaults.provider || "prompt-outbox",
    executionPolicy: {
      ...(config?.defaults?.executionPolicy || {}),
      ...(config?.executionPolicy || {}),
    },
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    dryRun: Boolean(args["dry-run"] || args.dryRun),
    intervalSeconds,
  };
}

async function buildActions(options) {
  const state = await readState();
  const report = createSupervisorReport(state, {
    baseUrl: options.baseUrl,
    intervalSeconds: options.intervalSeconds,
  });
  return { state, report };
}

async function runOnce(args) {
  const config = await loadConfig();
  const options = optionsFrom(args, config);
  const { state, report } = await buildActions(options);

  if (args.plan) {
    const plan = planDispatches(state, report.actions, options);
    const planReport = {
      generatedAt: report.generatedAt,
      dryRun: true,
      runs: [],
      selected: plan.selected,
      skipped: plan.skipped,
    };
    if (args.json) console.log(JSON.stringify(planReport, null, 2));
    else console.log(formatDispatchReport(planReport));
    return planReport;
  }

  const dispatchReport = await dispatchSupervisorActions(report.actions, options);
  if (args.json) console.log(JSON.stringify(dispatchReport, null, 2));
  else console.log(formatDispatchReport(dispatchReport));
  return dispatchReport;
}

async function runWatch(args) {
  const config = await loadConfig();
  const options = optionsFrom(args, config);
  await runResilientWorkerLoop({
    worker: "dispatcher",
    intervalSeconds: options.intervalSeconds,
    runOnce: async () => {
      await runOnce(args);
      console.log("");
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    console.log(`StudioOps Dispatcher

Usage:
  studioops-dispatcher --plan
  studioops-dispatcher --dry-run
  studioops-dispatcher
  studioops-dispatcher --watch --interval 300
  studioops dispatcher --project event-horizons-web --limit 3

The dispatcher consumes supervisor actions and creates durable run records. It
does not merge PRs, deploy production, or send external notifications.

Default provider is prompt-outbox: the generated Codex prompt is stored on the
run record so a Codex-capable runner can pick it up.
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
