#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { formatNotificationReport, sendPendingNotifications } from "./notifier.js";
import { runResilientWorkerLoop } from "./worker-heartbeat.js";

const DEFAULT_INTERVAL_SECONDS = 10;

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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function notifierDefaults(config) {
  return {
    ...(config?.defaults?.notifier || {}),
    ...(config?.notifier || {}),
  };
}

async function optionsFrom(args) {
  const config = await loadConfig();
  const defaults = notifierDefaults(config);
  return {
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    limit: numberFrom(args.limit || args["max-notifications"] || defaults.limit, 10),
    dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    intervalSeconds: secondsFrom(
      args.interval || args["interval-seconds"] || defaults.intervalSeconds,
      DEFAULT_INTERVAL_SECONDS,
    ),
  };
}

async function runOnce(args) {
  const options = await optionsFrom(args);
  const report = await sendPendingNotifications(options);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatNotificationReport(report));
  return report;
}

async function runWatch(args) {
  const options = await optionsFrom(args);
  await runResilientWorkerLoop({
    worker: "notifier",
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
    console.log(`StudioOps Notifier

Usage:
  studioops-notifier --plan
  studioops-notifier
  studioops-notifier --watch --interval 10
  studioops notifier --project event-horizons-web

The notifier sends local macOS notifications when a task reaches owner review,
Trust Leads QA review, or when an automated run fails. It does not approve,
merge, deploy, or contact users.
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
