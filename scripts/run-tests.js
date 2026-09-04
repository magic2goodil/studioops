#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHermeticTestEnvironment } from "./test-environment.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");

function parseArguments(argv) {
  const options = {
    probe: "",
    testFiles: [],
    excludedTestFiles: [],
    passthrough: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--probe") {
      options.probe = argv[index + 1] || "";
      index += 1;
    } else if (value === "--test-file") {
      options.testFiles.push(argv[index + 1] || "");
      index += 1;
    } else if (value === "--exclude-test-file") {
      const excluded = argv[index + 1] || "";
      if (!excluded || excluded.startsWith("--")) {
        throw new Error("--exclude-test-file requires a repository-relative test file.");
      }
      options.excludedTestFiles.push(excluded);
      index += 1;
    } else if (value === "--") {
      options.passthrough.push(...argv.slice(index + 1));
      break;
    } else {
      options.passthrough.push(value);
    }
  }
  if (options.probe && (options.testFiles.length || options.excludedTestFiles.length)) {
    throw new Error("--probe cannot be combined with test-file selection options.");
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
      env: {
        ...env,
        // Test-created clones intentionally do not inherit a writable global
        // Git configuration inside the release sandbox. Give fixture commits
        // a stable non-personal identity instead of depending on the host.
        GIT_AUTHOR_NAME: "StudioOps Test",
        GIT_AUTHOR_EMAIL: "studioops-test@example.invalid",
        GIT_COMMITTER_NAME: "StudioOps Test",
        GIT_COMMITTER_EMAIL: "studioops-test@example.invalid",
      },
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
    const selectedTestFiles = options.testFiles.length
      ? options.testFiles.map((entry) => path.relative(repositoryRoot, path.resolve(repositoryRoot, entry)))
      : await defaultTestFiles();
    const excludedTestFiles = new Set(
      options.excludedTestFiles
        .map((entry) => path.relative(repositoryRoot, path.resolve(repositoryRoot, entry))),
    );
    const testFiles = selectedTestFiles.filter((entry) => !excludedTestFiles.has(entry));
    if (!testFiles.length) {
      throw new Error("Test-file selection is empty after applying exclusions.");
    }
    console.log(`[StudioOps] Running ${testFiles.length} test files in a hermetic temporary control plane.`);
    exitCode = await runNode(["--test", ...options.passthrough, ...testFiles], isolated.env);
  }
} finally {
  await isolated.cleanup();
}
process.exitCode = exitCode;
