#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { readState } from "./store.js";
import {
  formatRunnerPlan,
  formatRunnerReport,
  planRunnableRuns,
  runQueuedRuns,
} from "./runner.js";
import { runResilientWorkerLoop } from "./worker-heartbeat.js";

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_LIMIT = 1;

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

function runnerDefaults(config) {
  return {
    ...(config?.defaults?.runner || {}),
    ...(config?.runner || {}),
  };
}

async function optionsFrom(args) {
  const config = await loadConfig();
  const defaults = runnerDefaults(config);
  return {
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    limit: numberFrom(args.limit || args["max-runs"] || defaults.limit || defaults.maxRuns, DEFAULT_LIMIT),
    provider: args.provider || process.env.MISSION_CONTROL_RUNNER_PROVIDER || defaults.provider || defaults.runProvider,
    codexBin: args["codex-bin"] || defaults.codexBin,
    model: args.model || process.env.MISSION_CONTROL_RUNNER_MODEL || defaults.model || "gpt-5.6-sol",
    modelReasoningEffort: args["model-reasoning-effort"]
      || args.reasoning
      || process.env.MISSION_CONTROL_RUNNER_REASONING_EFFORT
      || defaults.modelReasoningEffort
      || "high",
    allowApiKeyAuth: args["allow-api-key-auth"]
      || process.env.MISSION_CONTROL_RUNNER_ALLOW_API_KEY_AUTH
      || defaults.allowApiKeyAuth,
    executionPolicy: {
      ...(config?.defaults?.executionPolicy || {}),
      ...(config?.executionPolicy || {}),
    },
    useWorkspaces: args["no-workspace"] ? false : (args.workspaces || defaults.useWorkspaces || defaults.isolatedWorkspaces),
    workspaceRoot: args["workspace-root"] || defaults.workspaceRoot,
    timeoutMs: numberFrom(args["timeout-ms"] || defaults.timeoutMs, 0) || undefined,
    staleRunMs: numberFrom(args["stale-run-ms"] || defaults.staleRunMs || config?.defaults?.executionPolicy?.staleRunMs, 0) || undefined,
    githubAppAuth: args["no-github-app-auth"] ? false : (args["github-app-auth"] || process.env.MISSION_CONTROL_GITHUB_APP_AUTH || defaults.githubAppAuth),
    githubAppCredentialsDir: args["github-apps-dir"] || defaults.githubAppCredentialsDir || config?.githubApps?.credentialsDir,
    githubAppRoleMap: config?.githubApps?.roleMap,
    githubAppDefaultRole: config?.githubApps?.defaultRole,
    gitLock: defaults.gitLock || config?.defaults?.gitLock || config?.gitLock || {},
    intervalSeconds: secondsFrom(
      args.interval || args["interval-seconds"] || defaults.intervalSeconds,
      DEFAULT_INTERVAL_SECONDS,
    ),
  };
}

async function runOnce(args) {
  const options = await optionsFrom(args);
  if (args.plan || args["dry-run"] || args.dryRun) {
    const state = await readState();
    const plan = planRunnableRuns(state, options);
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatRunnerPlan(plan));
    return plan;
  }

  const report = await runQueuedRuns(options);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatRunnerReport(report));
  return report;
}

async function runWatch(args) {
  const options = await optionsFrom(args);
  await runResilientWorkerLoop({
    worker: "runner",
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
    console.log(`StudioOps Runner

Usage:
  studioops-runner --plan
  studioops-runner
  studioops-runner --watch --interval 300 --limit 1
  studioops-runner --watch --timeout-ms 7200000
  studioops-runner --provider codex-sdk
  studioops-runner --model gpt-5.6-sol --model-reasoning-effort high
  studioops-runner --workspace-root .mission-control/run-workspaces
  studioops-runner --no-workspace
  studioops-runner --github-apps-dir .mission-control/github-apps
  studioops-runner --no-github-app-auth
  MISSION_CONTROL_RUNNER_PROVIDER=codex-sdk studioops-runner
  MISSION_CONTROL_RUNNER_MODEL=gpt-5.6-sol MISSION_CONTROL_RUNNER_REASONING_EFFORT=high studioops-runner
  studioops runner --project event-horizons-web --limit 1

The runner claims queued builder/reviewer dispatch runs and launches a Codex
provider against the target project repository. Providers: codex-cli, codex-sdk.
Every run records and explicitly pins its model and reasoning effort; the default
is gpt-5.6-sol with high reasoning, while lead and complex-risk work can use xhigh.
It uses GitHub App installation tokens by default for GitHub push, PR, and
review/comment activity. It does not merge PRs, deploy production, or bypass
the human owner gate.
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
