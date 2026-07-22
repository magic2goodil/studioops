#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { formatPromotionReport, planPromotions, runPromotion } from "./promotion.js";
import { readState } from "./store.js";

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

function secondsFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function promotionDefaults(config) {
  return {
    ...(config?.defaults?.promotion || {}),
    ...(config?.promotion || {}),
  };
}

async function optionsFrom(args) {
  const config = await loadConfig();
  const defaults = promotionDefaults(config);
  return {
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    task: args.task || args.tasks || args["task-id"],
    dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    validationTimeoutMs: args["validation-timeout-ms"] || defaults.validationTimeoutMs,
    promotionWorkspaceRoot: args["workspace-root"] || defaults.workspaceRoot,
    githubAppAuth: args["no-github-app-auth"] ? false : (args["github-app-auth"] || defaults.githubAppAuth),
    githubAppCredentialsDir: args["github-apps-dir"] || defaults.githubAppCredentialsDir,
    githubAppRole: args["github-app-role"] || defaults.githubAppRole || "promotion-worker",
    githubAppDefaultRole: args["github-app-default-role"] || defaults.githubAppDefaultRole,
    intervalSeconds: secondsFrom(
      args.interval || args["interval-seconds"] || defaults.intervalSeconds,
      DEFAULT_INTERVAL_SECONDS,
    ),
  };
}

async function runOnce(args) {
  const options = await optionsFrom(args);
  let report;
  if (args.plan || args["dry-run"] || args.dryRun) {
    const state = await readState();
    report = planPromotions(state, options);
  } else {
    report = await runPromotion(options);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatPromotionReport(report));
  return { report, intervalSeconds: options.intervalSeconds };
}

async function runWatch(args) {
  const first = await runOnce(args);
  while (true) {
    await sleep(first.intervalSeconds * 1000);
    console.log("");
    await runOnce(args);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    console.log(`StudioOps Promotion Worker

Usage:
  studioops-promotion --plan
  studioops-promotion --project myapp
  studioops-promotion --watch --interval 300
  studioops promote --plan
  studioops promote --github-apps-dir .mission-control/github-apps

The worker merges owner-QA-passed task branches or PR heads into the project's
configured target branch, defaulting to the project default branch. It uses an
isolated clone, runs validation commands, performs a non-force push, and never
deploys production. Production deployment should remain release/tag gated.
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
