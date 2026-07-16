#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const templateDir = path.join(repoRoot, "deploy", "local");
const launchAgentDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logDir = path.join(repoRoot, "data", "launch-agents");
const uid = String(process.getuid?.() || "");
const defaultHost = process.env.MISSION_CONTROL_HOST || "127.0.0.1";
const defaultPort = process.env.MISSION_CONTROL_PORT || "4317";

function usage() {
  console.log(`Mission Control LaunchAgent installer

Usage:
  npm run install-agents
  npm run uninstall-agents
  npm run status-agents

Optional environment:
  MISSION_CONTROL_HOST=0.0.0.0   Bind web UI to the local network
  MISSION_CONTROL_PORT=4317      Web UI port
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

function renderTemplate(raw) {
  return raw
    .replaceAll("__NODE_PATH__", process.execPath)
    .replaceAll("__MISSION_CONTROL_REPO__", repoRoot)
    .replaceAll("__LOG_DIR__", logDir)
    .replaceAll("__HOST__", defaultHost)
    .replaceAll("__PORT__", defaultPort);
}

async function install() {
  ensureMac();
  await mkdir(launchAgentDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const installed = [];
  for (const template of await templates()) {
    const target = targetPathForLabel(template.label);
    const rendered = renderTemplate(await readFile(template.source, "utf8"));
    await launchctl(["bootout", `gui/${uid}`, target], { ignoreErrors: true });
    await writeFile(target, rendered, "utf8");
    await launchctl(["bootstrap", `gui/${uid}`, target]);
    await launchctl(["enable", `gui/${uid}/${template.label}`], { ignoreErrors: true });
    await launchctl(["kickstart", "-k", `gui/${uid}/${template.label}`], { ignoreErrors: true });
    installed.push(template.label);
  }

  console.log(`Installed ${installed.length} Mission Control LaunchAgents:`);
  for (const label of installed) console.log(`- ${label}`);
  console.log(`Logs: ${logDir}`);
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
  console.log(`Removed ${removed.length} Mission Control LaunchAgents:`);
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
