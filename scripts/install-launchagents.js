#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultRuntimeRoot, deployRuntime } from "../src/runtime-install.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const workingRoot = path.resolve(process.env.MISSION_CONTROL_WORKING_ROOT || repoRoot);
const templateDir = path.join(repoRoot, "deploy", "local");
const launchAgentDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logDir = path.join(workingRoot, "data", "launch-agents");
const uid = String(process.getuid?.() || "");
const defaultHost = process.env.MISSION_CONTROL_HOST || "127.0.0.1";
const defaultPort = process.env.MISSION_CONTROL_PORT || "4317";
const runtimeRoot = process.env.MISSION_CONTROL_RUNTIME_ROOT || defaultRuntimeRoot();
const sourceRoot = path.resolve(process.env.MISSION_CONTROL_SOURCE_ROOT || path.join(os.homedir(), ".mission-control", "source"));
const sourceBranch = process.env.MISSION_CONTROL_SOURCE_BRANCH || "main";

function usage() {
  console.log(`StudioOps LaunchAgent installer

Usage:
  npm run install-agents
  npm run uninstall-agents
  npm run status-agents

Optional environment:
  MISSION_CONTROL_HOST=0.0.0.0   Bind web UI to the local network
  MISSION_CONTROL_PORT=4317      Web UI port
  MISSION_CONTROL_NODE_PATH=...  Stable Node.js binary for every LaunchAgent
  MISSION_CONTROL_RUNTIME_ROOT=~/.mission-control/runtime
  MISSION_CONTROL_WORKING_ROOT=... Use a separate source/config/data checkout
  MISSION_CONTROL_SOURCE_ROOT=~/.mission-control/source Clean main checkout used by self-update
`);
}

function ensureMac() {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent installation is only supported on macOS. Use npm run dispatcher/runner/notifier manually on other systems.");
  }
}

function labelFromTemplate(fileName) {
  return fileName.replace(/\.plist\.example$/, "");
}

function targetPathForLabel(label) {
  return path.join(launchAgentDir, `${label}.plist`);
}

async function launchctl(args, options = {}) {
  try {
    const result = await execFileAsync("launchctl", args, { timeout: 15_000 });
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    if (options.ignoreErrors) return `${error.stdout || ""}${error.stderr || error.message}`.trim();
    throw error;
  }
}

async function templates() {
  const files = await readdir(templateDir);
  return files
    .filter((file) => file.endsWith(".plist.example"))
    .sort()
    .map((file) => ({
      file,
      label: labelFromTemplate(file),
      source: path.join(templateDir, file),
    }));
}

async function nodeCandidates() {
  const candidates = [
    process.execPath,
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const root of [
    path.join(os.homedir(), ".nvm", "versions", "node"),
    path.join(os.homedir(), "Library", "Application Support", "Herd", "config", "nvm", "versions", "node"),
  ]) {
    try {
      for (const version of await readdir(root)) candidates.push(path.join(root, version, "bin", "node"));
    } catch {
      // Optional Node managers are not required.
    }
  }
  return [...new Set(candidates)];
}

async function resolveNodePath() {
  if (process.env.MISSION_CONTROL_NODE_PATH) return path.resolve(process.env.MISSION_CONTROL_NODE_PATH);
  const supported = [];
  for (const candidate of await nodeCandidates()) {
    try {
      await access(candidate);
      const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      const match = String(stdout).trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;
      const major = Number(match[1]);
      if (major >= 22) supported.push({ candidate, major, minor: Number(match[2]), patch: Number(match[3]) });
    } catch {
      // Ignore invalid candidates and continue looking for a stable runtime.
    }
  }
  supported.sort((left, right) => {
    const leftLts = left.major % 2 === 0 ? 1 : 0;
    const rightLts = right.major % 2 === 0 ? 1 : 0;
    return rightLts - leftLts || right.major - left.major || right.minor - left.minor || right.patch - left.patch;
  });
  if (!supported.length) throw new Error("StudioOps requires Node.js 22.5 or newer.");
  return supported[0].candidate;
}

async function ensureSourceCheckout() {
  if (sourceRoot === repoRoot) return sourceRoot;
  const gitMarker = path.join(sourceRoot, ".git");
  try {
    await access(gitMarker);
    return sourceRoot;
  } catch {
    // Create the canonical checkout below.
  }
  try {
    await access(sourceRoot);
    throw new Error(`StudioOps source root exists but is not a Git checkout: ${sourceRoot}`);
  } catch (error) {
    if (!String(error?.message || "").includes("ENOENT") && error?.code !== "ENOENT") throw error;
  }
  const { stdout: originUrl } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    timeout: 15_000,
  });
  await mkdir(path.dirname(sourceRoot), { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["clone", "--no-tags", "--branch", sourceBranch, originUrl.trim(), sourceRoot], {
    timeout: 5 * 60_000,
  });
  return sourceRoot;
}

function renderTemplate(raw, runtime, canonicalSourceRoot, nodePath) {
  return raw
    .replaceAll("__NODE_PATH__", nodePath)
    .replaceAll("__MISSION_CONTROL_REPO__", workingRoot)
    .replaceAll("__MISSION_CONTROL_RUNTIME__", runtime.currentPath)
    .replaceAll("__MISSION_CONTROL_SOURCE_REPO__", canonicalSourceRoot)
    .replaceAll("__LOG_DIR__", logDir)
    .replaceAll("__HOST__", defaultHost)
    .replaceAll("__PORT__", defaultPort);
}

async function install() {
  ensureMac();
  const nodePath = await resolveNodePath();
  await access(nodePath);
  await mkdir(launchAgentDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  const runtime = await deployRuntime({ sourceRoot: repoRoot, runtimeRoot });
  const canonicalSourceRoot = await ensureSourceCheckout();

  const installed = [];
  for (const template of await templates()) {
    const target = targetPathForLabel(template.label);
    const rendered = renderTemplate(await readFile(template.source, "utf8"), runtime, canonicalSourceRoot, nodePath);
    await launchctl(["bootout", `gui/${uid}`, target], { ignoreErrors: true });
    await writeFile(target, rendered, "utf8");
    await launchctl(["bootstrap", `gui/${uid}`, target]);
    await launchctl(["enable", `gui/${uid}/${template.label}`], { ignoreErrors: true });
    installed.push(template.label);
  }

  console.log(`Installed ${installed.length} StudioOps LaunchAgents:`);
  for (const label of installed) console.log(`- ${label}`);
  console.log(`Logs: ${logDir}`);
  console.log(`Runtime: ${runtime.releasePath}`);
  console.log(`Node: ${nodePath}`);
  console.log(`Self-update source: ${canonicalSourceRoot}`);
}

async function uninstall() {
  ensureMac();
  const removed = [];
  for (const template of await templates()) {
    const target = targetPathForLabel(template.label);
    await launchctl(["bootout", `gui/${uid}`, target], { ignoreErrors: true });
    await rm(target, { force: true });
    removed.push(template.label);
  }
  console.log(`Removed ${removed.length} StudioOps LaunchAgents:`);
  for (const label of removed) console.log(`- ${label}`);
}

async function status() {
  ensureMac();
  const output = await launchctl(["list"]);
  const labels = (await templates()).map((template) => template.label);
  for (const label of labels) {
    const line = output.split("\n").find((item) => item.includes(label));
    console.log(line || `-       -       ${label} (not loaded)`);
  }
}

async function main() {
  const command = process.argv[2] || "install";
  if (command === "--help" || command === "help") {
    usage();
    return;
  }
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command === "status") return status();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
