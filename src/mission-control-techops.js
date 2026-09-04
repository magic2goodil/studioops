#!/usr/bin/env node
import { loadConfig, normalizeTechOpsPolicy } from "./config.js";
import { formatTechOpsReport, planTechOpsActions, runTechOps, summarizeTechOpsAction } from "./techops.js";
import { readState } from "./store.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function configuredPolicies(config = {}) {
  const policies = {};
  for (const project of config.projects || []) {
    const policy = normalizeTechOpsPolicy({
      ...(config.defaults?.techOps || {}),
      ...(project.techOps || {}),
    });
    if (project.id) policies[project.id] = policy;
    if (project.key) policies[project.key] = policy;
  }
  return policies;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`StudioOps local TechOps worker

Usage:
  node src/mission-control-techops.js --plan
  node src/mission-control-techops.js --json

The worker checks active ready QA previews, executes only configured local
argv-based recovery commands, restarts allowlisted project LaunchAgents, and
opens a durable circuit after bounded failures. It never merges or deploys.`);
    return;
  }
  const config = await loadConfig();
  const projectPolicies = configuredPolicies(config || {});
  let report;
  if (args.plan || args["dry-run"]) {
    const state = await readState();
    const actions = planTechOpsActions(state, { projectPolicies });
    report = { generatedAt: new Date().toISOString(), actionCount: actions.length, results: actions.map((action) => summarizeTechOpsAction(action, { outcome: "planned" })) };
  } else {
    report = await runTechOps({ projectPolicies });
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : formatTechOpsReport(report));
}

main().catch((error) => {
  console.error(`StudioOps TechOps failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
