#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHermeticTestEnvironment } from "./test-environment.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");

function parseArguments(argv) {
  const options = { probe: "", testFiles: [], passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--probe") {
      options.probe = argv[index + 1] || "";
      index += 1;
    } else if (value === "--test-file") {
      options.testFiles.push(argv[index + 1] || "");
      index += 1;
    } else if (value === "--") {
      options.passthrough.push(...argv.slice(index + 1));
      break;
    } else {
      options.passthrough.push(value);
    }
  }
  if (options.probe && options.testFiles.length) {
    throw new Error("--probe and --test-file cannot be combined.");
  }
  return options;
}

async function defaultTestFiles() {
  const entries = await readdir(path.join(repositoryRoot, "test"));
  return entries
    .filter((entry) => entry.endsWith(".test.js"))
    .sort()
    .map((entry) => path.join("test", entry));
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Isolated test process terminated by ${signal}.`));
        return;
      }
      resolve(Number(code || 0));
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const isolated = await createHermeticTestEnvironment();
let exitCode = 1;
try {
  if (options.probe) {
    exitCode = await runNode(
      [path.resolve(repositoryRoot, options.probe), ...options.passthrough],
      isolated.env,
    );
  } else {
    const testFiles = options.testFiles.length
      ? options.testFiles.map((entry) => path.relative(repositoryRoot, path.resolve(repositoryRoot, entry)))
      : await defaultTestFiles();
    console.log(`[StudioOps] Running ${testFiles.length} test files in a hermetic temporary control plane.`);
    exitCode = await runNode(["--test", ...options.passthrough, ...testFiles], isolated.env);
  }
} finally {
  await isolated.cleanup();
}
process.exitCode = exitCode;
