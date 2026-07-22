#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { formatQaIntegrationReport, planQaIntegrations, runQaIntegration } from "./qa-integration.js";
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

function qaIntegrationDefaults(config) {
  return {
    ...(config?.defaults?.qaIntegration || {}),
    ...(config?.qaIntegration || {}),
  };
}

async function optionsFrom(args) {
  const config = await loadConfig();
  const defaults = qaIntegrationDefaults(config);
  return {
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    task: args.task || args.tasks || args["task-id"],
    dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    force: Boolean(args.force || args.reintegrate),
    validationTimeoutMs: args["validation-timeout-ms"] || defaults.validationTimeoutMs,
    githubAppAuth: args["no-github-app-auth"] ? false : (args["github-app-auth"] || defaults.githubAppAuth),
    githubAppCredentialsDir: args["github-apps-dir"] || defaults.githubAppCredentialsDir,
    githubAppRole: args["github-app-role"] || defaults.githubAppRole,
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
    report = planQaIntegrations(state, options);
  } else {
    report = await runQaIntegration(options);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatQaIntegrationReport(report));
  return report;
}

async function runWatch(args) {
  const firstReport = await runOnce(args);
  const intervalSeconds = firstReport.intervalSeconds || secondsFrom(args.interval || args["interval-seconds"], DEFAULT_INTERVAL_SECONDS);
  while (true) {
    await sleep(intervalSeconds * 1000);
    console.log("");
    await runOnce(args);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    console.log(`StudioOps QA Integration Worker

Usage:
  studioops-qa-integration --plan
  studioops-qa-integration --project myapp
  studioops-qa-integration --project myapp --force
  studioops-qa-integration --watch --interval 300
  studioops qa-integrate --plan
  studioops qa-integrate --github-apps-dir .mission-control/github-apps

The worker merges qa_review task PR heads into a project's configured
non-production integrationBranch only when trustLeadApprovals is enabled. It
skips tasks whose current integration result is already ready unless --force
is supplied. It does not merge PRs to production, deploy, or force-push.

For GitHub repositories, the worker uses short-lived GitHub App installation
tokens by default. If no dedicated qa-integration-worker app exists, it falls
back to the builder app identity.
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
