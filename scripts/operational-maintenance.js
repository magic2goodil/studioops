#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactStateDatabase,
  enforceOperationalRetention,
  operationalMetrics,
  operationalRetentionPolicy,
  pruneRunOutputFiles,
} from "../src/state-database.js";

export async function runOperationalMaintenance(input = {}) {
  const policy = operationalRetentionPolicy(input.policy || input);
  if (input.apply !== true) {
    return {
      applied: false,
      policy,
      metrics: await operationalMetrics(input),
    };
  }
  const retention = await enforceOperationalRetention({ ...input, policy });
  const runOutput = await pruneRunOutputFiles({ ...input, policy });
  const compaction = await compactStateDatabase(input);
  return {
    applied: true,
    policy,
    retention,
    runOutput: {
      ...runOutput,
      removed: runOutput.removed.length,
    },
    compaction,
  };
}

function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--backup") {
      options.backupPath = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (value === "--output-dir") {
      options.outputDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else {
      throw new Error(`Unknown operational-maintenance option: ${value}`);
    }
  }
  return options;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const report = await runOperationalMaintenance(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
}
