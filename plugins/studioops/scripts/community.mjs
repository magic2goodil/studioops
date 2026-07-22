#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = "https://github.com/magic2goodil/studioops.git";
const DEFAULT_URL = "http://127.0.0.1:4317";
const MINIMUM_NODE = { major: 22, minor: 5 };

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const raw = value.slice(2);
    const separator = raw.indexOf("=");
    if (separator !== -1) {
      parsed[raw.slice(0, separator)] = raw.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[raw] = true;
    } else {
      parsed[raw] = next;
      index += 1;
    }
  }
  return parsed;
}

function usage() {
  return `StudioOps Community bootstrap

Usage:
  community.mjs doctor [--project PATH] [--url URL]
  community.mjs bootstrap [--project PATH] [--url URL]
  community.mjs start [--url URL]
  community.mjs stop

Options:
  --home PATH          Community installation root (default: ~/.studioops/community)
  --project PATH       Repository to register (default: current directory)
  --repository URL     StudioOps Git source (default: ${DEFAULT_REPOSITORY})
  --branch NAME        StudioOps Git branch or tag (default: main)
  --update             Fast-forward an existing clean StudioOps checkout

The bootstrap remains local, binds to localhost, and does not enable GitHub
writes, background worker automation, cloud services, merges, or deployment.`;
}

function normalizedUrl(value) {
  return String(value || DEFAULT_URL).trim().replace(/\/$/, "");
}

function pathsFor(args = {}) {
  const communityHome = path.resolve(String(
    args.home
      || process.env.STUDIOOPS_COMMUNITY_HOME
      || path.join(os.homedir(), ".studioops", "community"),
  ));
  return {
    communityHome,
    sourceRoot: path.join(communityHome, "source"),
    workspaceRoot: path.join(communityHome, "workspace"),
    logsRoot: path.join(communityHome, "workspace", "logs"),
    pidFile: path.join(communityHome, "workspace", "studioops-server.json"),
  };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function commandCheck(command, commandArgs = ["--version"]) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      version: `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n")[0],
    };
  } catch (error) {
    return {
      ok: false,
      version: "",
      error: String(error.code === "ENOENT" ? `${command} was not found on PATH.` : error.message),
    };
  }
}

function nodeSupported(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split(".").map(Number);
  return major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
}

async function gitValue(repoPath, args) {
  try {
    const result = await execFileAsync("git", ["-C", repoPath, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function slug(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

function githubOwnerFromRemote(remote) {
  const match = String(remote || "").match(/github\.com[/:]([^/]+)\//i);
  return match?.[1] || "";
}

async function inferredValidation(repoPath) {
  const packagePath = path.join(repoPath, "package.json");
  if (await exists(packagePath)) {
    try {
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      if (packageJson.scripts?.check) return "npm run check";
      if (packageJson.scripts?.test) return "npm test";
      if (packageJson.scripts?.build) return "npm run build";
    } catch {
      // An invalid project package.json should not prevent StudioOps setup.
    }
  }
  if (await exists(path.join(repoPath, "pyproject.toml"))) return "pytest";
  if (await exists(path.join(repoPath, "go.mod"))) return "go test ./...";
  if (await exists(path.join(repoPath, "Cargo.toml"))) return "cargo test";
  return "";
}

async function inspectProject(requestedPath) {
  const requested = path.resolve(String(requestedPath || process.cwd()));
  const gitRoot = await gitValue(requested, ["rev-parse", "--show-toplevel"]);
  const repoPath = gitRoot || requested;
  const remote = await gitValue(repoPath, ["remote", "get-url", "origin"]);
  const currentBranch = await gitValue(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let defaultBranch = "main";
  if (await gitValue(repoPath, ["rev-parse", "--verify", "refs/heads/main"])) defaultBranch = "main";
  else if (await gitValue(repoPath, ["rev-parse", "--verify", "refs/heads/master"])) defaultBranch = "master";
  else if (currentBranch) defaultBranch = currentBranch;
  const directoryName = path.basename(repoPath);
  let projectName = directoryName;
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8"));
    projectName = String(packageJson.displayName || packageJson.name || directoryName).trim();
  } catch {
    // Directory name is a sufficient default for non-Node repositories.
  }
  return {
    requestedPath: requested,
    repoPath,
    isGitRepository: Boolean(gitRoot),
    repoUrl: remote,
    defaultBranch,
    key: slug(directoryName),
    name: projectName,
    displayName: "Local Owner",
    githubOwner: githubOwnerFromRemote(remote),
    preferredProtocol: remote.startsWith("git@") || remote.startsWith("ssh://") ? "ssh" : "https",
    workspaceRoot: path.dirname(repoPath),
    validationCommand: await inferredValidation(repoPath),
  };
}

async function serviceStatus(url) {
  try {
    const response = await fetch(`${url}/api/state`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { reachable: false, studioops: false, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    const studioops = Array.isArray(body.projects)
      && Array.isArray(body.tasks)
      && body.productAccess?.source === "local-open-core";
    return {
      reachable: true,
      studioops,
      projects: body.projects?.length || 0,
      tasks: body.tasks?.length || 0,
      configLoaded: Boolean(body.configLoaded),
      plan: body.productAccess?.planName || "Community",
      error: studioops ? "" : "The address responded, but it was not a StudioOps Community service.",
    };
  } catch (error) {
    return { reachable: false, studioops: false, error: String(error.message || error) };
  }
}

function runtimeEnvironment(paths, url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") throw new Error("StudioOps Community bootstrap only supports a local http:// URL.");
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("StudioOps Community bootstrap only binds to localhost.");
  }
  const port = parsed.port || "80";
  return {
    ...process.env,
    STUDIOOPS_ROOT: paths.workspaceRoot,
    STUDIOOPS_CONFIG_ROOT: paths.workspaceRoot,
    STUDIOOPS_DATA_DIR: path.join(paths.workspaceRoot, "data"),
    HOST: "127.0.0.1",
    PORT: port,
  };
}

async function doctor(args = {}) {
  const paths = pathsFor(args);
  const url = normalizedUrl(args.url || process.env.STUDIOOPS_URL);
  const project = await inspectProject(args.project || process.cwd());
  const [npm, git, gh, codex, service] = await Promise.all([
    commandCheck("npm"),
    commandCheck("git"),
    commandCheck("gh"),
    commandCheck("codex"),
    serviceStatus(url),
  ]);
  const [sourceInstalled, configCreated, databaseCreated, processRecorded] = await Promise.all([
    exists(path.join(paths.sourceRoot, "src", "server.js")),
    exists(path.join(paths.workspaceRoot, "studioops.config.md")),
    exists(path.join(paths.workspaceRoot, "data", "mission-control.sqlite3")),
    exists(paths.pidFile),
  ]);
  const node = {
    ok: nodeSupported(),
    version: process.version,
    error: nodeSupported() ? "" : "StudioOps requires Node.js 22.5 or newer.",
  };
  return {
    ok: node.ok && npm.ok && git.ok,
    platform: process.platform,
    url,
    paths,
    required: { node, npm, git },
    optional: { gh, codex },
    installation: { sourceInstalled, configCreated, databaseCreated, processRecorded },
    service,
    project,
    boundaries: {
      bootstrapBindsToLocalhostOnly: true,
      bootstrapEnablesGithubWrites: false,
      bootstrapEnablesBackgroundAutomation: false,
      bootstrapConnectsToCloud: false,
    },
  };
}

async function ensureSource(paths, args) {
  const repository = String(args.repository || process.env.STUDIOOPS_REPOSITORY || DEFAULT_REPOSITORY);
  const branch = String(args.branch || process.env.STUDIOOPS_RELEASE_REF || "main");
  const serverPath = path.join(paths.sourceRoot, "src", "server.js");
  let installed = false;
  let updated = false;
  if (!(await exists(serverPath))) {
    if (await exists(paths.sourceRoot)) {
      throw new Error(`StudioOps source path exists but is incomplete: ${paths.sourceRoot}`);
    }
    await mkdir(path.dirname(paths.sourceRoot), { recursive: true, mode: 0o700 });
    await execFileAsync("git", [
      "clone",
      "--depth", "1",
      "--branch", branch,
      "--single-branch",
      repository,
      paths.sourceRoot,
    ], {
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    installed = true;
  } else if (args.update) {
    const dirty = await gitValue(paths.sourceRoot, ["status", "--porcelain"]);
    if (dirty) throw new Error(`StudioOps source has local changes and was not updated: ${paths.sourceRoot}`);
    await execFileAsync("git", ["-C", paths.sourceRoot, "fetch", "--depth", "1", "origin", branch], {
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync("git", ["-C", paths.sourceRoot, "merge", "--ff-only", "FETCH_HEAD"], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    updated = true;
  }

  const dependencyMarker = path.join(paths.sourceRoot, "node_modules", "@openai", "codex-sdk", "package.json");
  const dependenciesInstalled = await exists(dependencyMarker);
  if (!dependenciesInstalled || installed || updated) {
    await execFileAsync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: paths.sourceRoot,
      timeout: 10 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });
  }
  return {
    repository,
    branch,
    installed,
    updated,
    dependenciesInstalled: dependenciesInstalled || installed || updated,
  };
}

function runQuestionnaire(command, args, options, questions) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let questionIndex = 0;
    let stdinEnded = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("StudioOps local setup timed out."));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (questionIndex < questions.length && stdout.includes(questions[questionIndex].prompt)) {
        child.stdin.write(`${questions[questionIndex].answer}\n`);
        questionIndex += 1;
      }
      if (questionIndex === questions.length && !stdinEnded) {
        stdinEnded = true;
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && questionIndex === questions.length) resolve({ stdout, stderr });
      else if (code === 0) reject(new Error(`StudioOps setup ended before all setup questions were answered.\n${stdout}`));
      else reject(new Error(`StudioOps setup exited with code ${code}. ${stderr || stdout}`.trim()));
    });
  });
}

async function ensureConfiguration(paths, url, project) {
  await mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(paths.workspaceRoot, "studioops.config.md");
  if (await exists(configPath)) {
    return { created: false, configPath };
  }
  const questions = [
    { prompt: "Your display name:", answer: project.displayName },
    { prompt: "GitHub user or organization for repos:", answer: project.githubOwner },
    { prompt: "Local workspace root [~/Development]:", answer: project.workspaceRoot },
    { prompt: "Git protocol [ssh]:", answer: project.preferredProtocol },
    { prompt: "AI tools to generate prompts for [codex]:", answer: "codex" },
    { prompt: "Add a first project now? [Y/n]:", answer: "Y" },
    { prompt: "Project key, such as myapp:", answer: project.key },
    { prompt: "Project name:", answer: project.name },
    { prompt: "Local repo path:", answer: project.repoPath },
    { prompt: "Git repo URL, optional:", answer: project.repoUrl },
    { prompt: "Validation command, optional:", answer: project.validationCommand },
  ];
  await runQuestionnaire(
    process.execPath,
    [path.join(paths.sourceRoot, "src", "mission-control-cli.js"), "setup"],
    {
      cwd: paths.sourceRoot,
      env: runtimeEnvironment(paths, url),
    },
    questions,
  );
  if (!(await exists(configPath))) throw new Error(`StudioOps setup did not create ${configPath}.`);
  return { created: true, configPath };
}

async function recentLog(paths) {
  try {
    const content = await readFile(path.join(paths.logsRoot, "community-server.log"), "utf8");
    return content.slice(-4000);
  } catch {
    return "";
  }
}

async function waitForService(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await serviceStatus(url);
  while ((!status.reachable || !status.studioops) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await serviceStatus(url);
  }
  return status;
}

async function startService(paths, url) {
  const current = await serviceStatus(url);
  if (current.reachable && current.studioops) {
    return { started: false, alreadyRunning: true, status: current };
  }
  if (current.reachable && !current.studioops) {
    throw new Error(`Cannot start StudioOps at ${url}: ${current.error}`);
  }
  if (!(await exists(path.join(paths.sourceRoot, "src", "server.js")))) {
    throw new Error(`StudioOps Community is not installed at ${paths.sourceRoot}. Run bootstrap first.`);
  }
  await mkdir(paths.logsRoot, { recursive: true, mode: 0o700 });
  const logPath = path.join(paths.logsRoot, "community-server.log");
  const logHandle = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [path.join(paths.sourceRoot, "src", "server.js")], {
    cwd: paths.sourceRoot,
    detached: true,
    env: runtimeEnvironment(paths, url),
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await writeFile(paths.pidFile, JSON.stringify({
    pid: child.pid,
    url,
    sourceRoot: paths.sourceRoot,
    startedAt: new Date().toISOString(),
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  await logHandle.close();
  const status = await waitForService(url);
  if (!status.reachable || !status.studioops) {
    await rm(paths.pidFile, { force: true });
    throw new Error(`StudioOps did not become ready at ${url}. ${status.error}\n${await recentLog(paths)}`.trim());
  }
  return { started: true, alreadyRunning: false, pid: child.pid, logPath, status };
}

async function bootstrap(args = {}) {
  const report = await doctor(args);
  if (!report.ok) {
    const missing = Object.entries(report.required)
      .filter(([, item]) => !item.ok)
      .map(([name, item]) => `${name}: ${item.error || "not ready"}`)
      .join("; ");
    throw new Error(`StudioOps prerequisites are not ready. ${missing}`);
  }
  if (report.service.reachable && report.service.studioops) {
    return {
      ok: true,
      action: "already-running",
      url: report.url,
      paths: report.paths,
      project: report.project,
      service: report.service,
      boundaries: report.boundaries,
    };
  }
  if (report.service.reachable && !report.service.studioops) {
    throw new Error(`Cannot install StudioOps at ${report.url}: ${report.service.error}`);
  }
  const source = await ensureSource(report.paths, args);
  const configuration = await ensureConfiguration(report.paths, report.url, report.project);
  const service = await startService(report.paths, report.url);
  return {
    ok: true,
    action: source.installed ? "installed" : "started",
    url: report.url,
    paths: report.paths,
    source,
    configuration,
    project: report.project,
    service,
    boundaries: report.boundaries,
    next: "StudioOps Community is ready for structured intake. GitHub bot writes and unattended automation remain disabled until explicitly configured.",
  };
}

async function stopService(paths) {
  if (!(await exists(paths.pidFile))) {
    return { ok: true, stopped: false, reason: "No StudioOps Community PID file was found." };
  }
  const record = JSON.parse(await readFile(paths.pidFile, "utf8"));
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Invalid StudioOps PID file: ${paths.pidFile}`);
  if (process.platform === "win32") {
    throw new Error("Automatic Community stop is not yet supported on Windows because the recorded process cannot be verified safely.");
  } else {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
      const command = String(result.stdout || "");
      if (!command.includes("src/server.js") || !command.includes(record.sourceRoot)) {
        throw new Error(`PID ${pid} does not belong to the recorded StudioOps server.`);
      }
    } catch (error) {
      if (String(error.message).includes("does not belong")) throw error;
      await rm(paths.pidFile, { force: true });
      return { ok: true, stopped: false, reason: "The recorded StudioOps process was no longer running." };
    }
  }
  process.kill(pid, "SIGTERM");
  await rm(paths.pidFile, { force: true });
  return { ok: true, stopped: true, pid };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (["help", "--help", "-h"].includes(command) || args.help) {
    console.log(usage());
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await doctor(args), null, 2));
    return;
  }
  if (["bootstrap", "ensure", "setup"].includes(command)) {
    console.log(JSON.stringify(await bootstrap(args), null, 2));
    return;
  }
  if (command === "start") {
    const paths = pathsFor(args);
    const url = normalizedUrl(args.url || process.env.STUDIOOPS_URL);
    console.log(JSON.stringify({ ok: true, ...(await startService(paths, url)), url, paths }, null, 2));
    return;
  }
  if (command === "stop") {
    console.log(JSON.stringify(await stopService(pathsFor(args)), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error.message || error),
    }, null, 2));
    process.exitCode = 1;
  });
}

export {
  bootstrap,
  doctor,
  inspectProject,
  nodeSupported,
  pathsFor,
  serviceStatus,
  startService,
  stopService,
};
