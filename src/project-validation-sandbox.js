import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PROJECT_VALIDATION_SANDBOX_POLICY_ID = "darwin-seatbelt-v3-disposable-clone-data-egress-exec-confined";
export const PROJECT_VALIDATION_SANDBOX_ISOLATION = Object.freeze({
  filesystem: "kernel_enforced_allowlist",
  network: "kernel_enforced_deny_all",
  executablePolicy: "kernel_enforced_allowlist",
  processInspection: "deny_by_default",
  workspaceIntegrity: "postvalidation_prevalidation_byte_mode_symlink_manifest",
  leaderAndProcessGroup: "bounded_with_stdio_drain_deadline",
  detachedDescendantTermination: false,
});
export const DEFAULT_PROJECT_VALIDATION_PATH = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DEPENDENCY_ACQUISITION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DEPENDENCY_ACQUISITION_MAX_CAPTURE_BYTES = 256 * 1024;
const PROCESS_DRAIN_DEADLINE_MS = 500;
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const SANDBOX_CAPABILITIES = new WeakMap();
const SYSTEM_RUNTIME_READ_ROOTS = [
  "/System",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/lib",
  "/usr/local/share",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/lib",
  "/opt/homebrew/share",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/Applications/Xcode.app/Contents",
  "/Library/Developer/CommandLineTools",
  "/Library/Apple/usr/libexec/oah",
  "/Library/Java/JavaVirtualMachines",
  "/private/var/db/timezone",
];
const SYSTEM_RUNTIME_READ_FILES = [
  "/",
  "/dev/null",
  "/dev/dtracehelper",
  "/dev/random",
  "/dev/urandom",
  "/dev/zero",
  "/Library/Preferences/com.apple.dt.Xcode.plist",
  "/private/var/select/developer_dir",
  "/private/var/select/sh",
  "/var/select/developer_dir",
  "/var/select/sh",
];
const SAFE_SYSCTL_READ_NAMES = [
  "kern.ostype",
  "kern.osrelease",
  "kern.version",
  "kern.hostname",
  "kern.boottime",
  "hw.machine",
  "hw.model",
  "hw.memsize",
  "hw.cpufrequency",
  "hw.activecpu",
  "hw.logicalcpu",
  "hw.logicalcpu_max",
  "hw.physicalcpu",
  "hw.physicalcpu_max",
  "hw.ncpu",
  "machdep.cpu.brand_string",
  "vm.loadavg",
];

const VERIFY_WORKSPACE_MANIFEST_SCRIPT = [
  "const crypto = require('node:crypto');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "let source = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { source += chunk; });",
  "process.stdin.on('end', () => {",
  "  const manifest = JSON.parse(source);",
  "  const root = fs.realpathSync(process.cwd());",
  "  const withinRoot = (candidate) => {",
  "    const relative = path.relative(root, candidate);",
  "    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));",
  "  };",
  "  for (const entry of manifest) {",
  "    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path === '.git' || entry.path.startsWith('.git/')) throw new Error('Invalid trusted workspace-manifest entry.');",
  "    const candidate = path.resolve(root, entry.path);",
  "    if (!withinRoot(candidate)) throw new Error('Workspace-manifest path escaped its root.');",
  "    const info = fs.lstatSync(candidate);",
  "    const mode = info.mode & 0o111;",
  "    if (entry.type === 'directory') {",
  "      if (!info.isDirectory() || mode !== entry.mode) throw new Error('Workspace directory identity changed.');",
  "      continue;",
  "    }",
  "    if (entry.type === 'symlink') {",
  "      if (!info.isSymbolicLink() || fs.readlinkSync(candidate) !== entry.target) throw new Error('Workspace symlink identity changed.');",
  "      continue;",
  "    }",
  "    if (entry.type !== 'file' || !info.isFile() || mode !== entry.mode) throw new Error('Workspace file type or mode changed.');",
  "    const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);",
  "    try {",
  "      const opened = fs.fstatSync(descriptor);",
  "      if (!opened.isFile() || (opened.mode & 0o111) !== entry.mode) throw new Error('Workspace file changed while it was being verified.');",
  "      const digest = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');",
  "      if (digest !== entry.digest) throw new Error('Workspace file content changed.');",
  "    } finally { fs.closeSync(descriptor); }",
  "  }",
  "});",
].join("\n");

function sandboxError(message, code = "PROJECT_VALIDATION_SANDBOX_UNAVAILABLE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function containsPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function seatbeltLiteral(value) {
  return JSON.stringify(String(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function pathAncestors(value) {
  const resolved = path.resolve(value);
  const filesystemRoot = path.parse(resolved).root;
  const ancestors = [];
  for (let current = path.dirname(resolved); current !== filesystemRoot; current = path.dirname(current)) {
    ancestors.push(current);
  }
  return ancestors.reverse();
}

async function canonicalValidationToolRoots(values) {
  const directories = [];
  for (const value of values) {
    if (!value || !path.isAbsolute(value)) {
      throw sandboxError(`Unsafe validation PATH entry: ${value || "<empty>"}.`, "PROJECT_VALIDATION_INPUT_INVALID");
    }
    try {
      const resolved = await realpath(value);
      const info = await lstat(resolved);
      if (!info.isDirectory()) {
        throw sandboxError(`Unsafe validation PATH entry: ${value}.`, "PROJECT_VALIDATION_INPUT_INVALID");
      }
      directories.push(resolved);
    } catch (error) {
      if (error?.code === "PROJECT_VALIDATION_INPUT_INVALID") throw error;
      throw sandboxError(`Unsafe validation PATH entry: ${value}.`, "PROJECT_VALIDATION_INPUT_INVALID");
    }
  }
  return unique(directories);
}

async function prospectiveCanonicalPath(value) {
  let current = path.resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function canonicalVerifierExecutable() {
  const resolved = await realpath(process.execPath).catch(() => "");
  if (!resolved) throw sandboxError("Project validation requires a resolvable Node verification executable.");
  const info = await lstat(resolved);
  if (!info.isFile() || (info.mode & 0o022) !== 0) {
    throw sandboxError("The project validation Node verification executable has unsafe permissions.");
  }
  return resolved;
}

function validationEnvironment(homePath, validationPath) {
  return {
    PATH: validationPath,
    HOME: homePath,
    TMPDIR: path.join(homePath, "tmp"),
    XDG_CONFIG_HOME: path.join(homePath, ".config"),
    XDG_CACHE_HOME: path.join(homePath, ".cache"),
    GH_CONFIG_DIR: path.join(homePath, ".config", "gh"),
    npm_config_cache: path.join(homePath, ".npm-cache"),
    npm_config_userconfig: path.join(homePath, ".npmrc"),
    npm_config_globalconfig: path.join(homePath, ".npm-globalrc"),
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C",
    LC_ALL: "C",
    OPENSSL_CONF: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    STUDIOOPS_PROJECT_VALIDATION_SANDBOX: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
  };
}

function seatbeltProfile(rootPath, readableToolRoots, verifierExecutable) {
  const explicitRoots = unique([rootPath, ...readableToolRoots, ...SYSTEM_RUNTIME_READ_ROOTS]);
  const explicitReadRoots = explicitRoots
    .map((entry) => `(subpath ${seatbeltLiteral(entry)})`)
    .join(" ");
  const explicitExecRoots = explicitRoots
    .map((entry) => `(subpath ${seatbeltLiteral(entry)})`)
    .join(" ");
  // Seatbelt still evaluates metadata access on every directory traversed to
  // reach an allowed descendant. Grant only literal metadata reads for the
  // sandbox's ancestors; granting a subpath here would expose sibling names or
  // contents beneath sensitive temporary-directory roots.
  const explicitAncestorMetadata = unique([
    path.parse(path.resolve(rootPath)).root,
    ...explicitRoots.flatMap(pathAncestors),
    ...SYSTEM_RUNTIME_READ_FILES.flatMap(pathAncestors),
    ...pathAncestors(verifierExecutable),
  ])
    .map((entry) => `(literal ${seatbeltLiteral(entry)})`)
    .join(" ");
  const explicitReadFiles = SYSTEM_RUNTIME_READ_FILES
    .map((entry) => `(literal ${seatbeltLiteral(entry)})`)
    .join(" ");
  const safeSysctls = SAFE_SYSCTL_READ_NAMES
    .map((entry) => `(sysctl-name ${seatbeltLiteral(entry)})`)
    .join(" ");
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${explicitExecRoots} (literal ${seatbeltLiteral(verifierExecutable)}))`,
    "(allow process-fork)",
    `(allow sysctl-read ${safeSysctls})`,
    `(allow file-read-metadata ${explicitAncestorMetadata})`,
    `(allow file-read* ${explicitReadRoots})`,
    `(allow file-read* ${explicitReadFiles})`,
    `(allow file-write* (subpath ${seatbeltLiteral(rootPath)}))`,
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
    "(allow file-ioctl (literal \"/dev/dtracehelper\"))",
  ].join("\n");
}

function killProcessGroup(child, signal = "SIGKILL") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The process already exited between the group and direct signal.
      }
    }
  }
}

function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = Object.prototype.hasOwnProperty.call(options, "input");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = "";
    let drainTimer = null;
    const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));

    function destroyStdio() {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
    }

    function finish(code = exitCode, signal = exitSignal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      killProcessGroup(child, "SIGKILL");
      destroyStdio();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const reason = timedOut
        ? `Command timed out after ${timeoutMs}ms.`
        : overflow
          ? `Command output exceeded ${Number(options.maxCaptureBytes || MAX_CAPTURE_BYTES)} bytes.`
          : signal
            ? `Command terminated by ${signal}.`
            : "";
      resolve({
        ok: code === 0 && !signal && !timedOut && !overflow,
        code: Number.isInteger(code) ? code : null,
        signal: signal || "",
        timedOut,
        overflow,
        stdout: stdoutText,
        stderr: stderrText,
        output: `${stdoutText}${stderrText}${reason && !stderrText.endsWith(reason) ? `${stderrText || stdoutText ? "\n" : ""}${reason}` : ""}`.trim(),
      });
    }

    function scheduleDrainDeadline() {
      if (drainTimer || settled) return;
      drainTimer = setTimeout(() => finish(), PROCESS_DRAIN_DEADLINE_MS);
      drainTimer.unref?.();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGKILL");
      scheduleDrainDeadline();
    }, timeoutMs);
    timer.unref?.();

    function collect(target, chunk) {
      if (overflow) return;
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > Number(options.maxCaptureBytes || MAX_CAPTURE_BYTES)) {
        overflow = true;
        killProcessGroup(child, "SIGKILL");
        scheduleDrainDeadline();
        return;
      }
      target.push(value);
    }

    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      if (settled) return;
      settled = true;
      destroyStdio();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exitCode = Number.isInteger(code) ? code : null;
      exitSignal = signal || "";
      killProcessGroup(child, "SIGKILL");
      scheduleDrainDeadline();
    });
    child.once("close", (code, signal) => finish(code, signal));
    if (hasInput) {
      child.stdin.on("error", (error) => {
        if (error?.code === "EPIPE" || settled || timedOut || overflow) return;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        settled = true;
        killProcessGroup(child, "SIGKILL");
        destroyStdio();
        reject(error);
      });
      child.stdin.end(String(options.input ?? ""));
    }
  });
}

async function snapshotWorkspaceManifest(rootPath) {
  const manifest = [];
  async function visit(relativePath) {
    const absolutePath = path.join(rootPath, relativePath);
    const names = await readdir(absolutePath);
    names.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      if (!relativePath && name === ".git") continue;
      const entryPath = relativePath ? path.join(relativePath, name) : name;
      const entryAbsolutePath = path.join(rootPath, entryPath);
      const info = await lstat(entryAbsolutePath);
      const mode = info.mode & 0o111;
      if (info.isDirectory()) {
        manifest.push({ path: entryPath, type: "directory", mode });
        await visit(entryPath);
      } else if (info.isSymbolicLink()) {
        manifest.push({ path: entryPath, type: "symlink", mode, target: await readlink(entryAbsolutePath) });
      } else if (info.isFile()) {
        const handle = await open(entryAbsolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            throw sandboxError("Validation checkout changed during manifest capture.", "PROJECT_VALIDATION_CLONE_UNSAFE");
          }
          const digest = createHash("sha256").update(await handle.readFile()).digest("hex");
          manifest.push({ path: entryPath, type: "file", mode: opened.mode & 0o111, digest });
        } finally {
          await handle.close();
        }
      } else {
        throw sandboxError(
          `Unsupported validation checkout entry type: ${entryPath}.`,
          "PROJECT_VALIDATION_CLONE_UNSAFE",
        );
      }
    }
  }
  await visit("");
  return manifest;
}

async function trustedGit(repoPath, args, options = {}) {
  const suppliedEnvironment = options.env || {};
  const result = await runCaptured(options.executable || TRUSTED_GIT_EXECUTABLE, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    ...(repoPath ? ["-C", repoPath] : []),
    ...args,
  ], {
    ...options,
    env: {
      PATH: DEFAULT_PROJECT_VALIDATION_PATH,
      HOME: suppliedEnvironment.HOME || "/var/empty",
      TMPDIR: suppliedEnvironment.TMPDIR || "/tmp",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (!result.ok) {
    throw sandboxError(
      result.output || `Trusted git command failed: ${args.join(" ")}`,
      "PROJECT_VALIDATION_CLONE_FAILED",
    );
  }
  return result;
}

async function validateTrustedGitExecutable() {
  const resolved = await realpath(TRUSTED_GIT_EXECUTABLE).catch(() => "");
  if (resolved !== TRUSTED_GIT_EXECUTABLE) {
    throw sandboxError("Project validation requires the system /usr/bin/git executable.");
  }
  const info = await lstat(resolved);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw sandboxError("The project validation Git executable has unsafe ownership or permissions.");
  }
  return resolved;
}

async function assertNoAlternates(repoPath) {
  try {
    await lstat(path.join(repoPath, ".git", "objects", "info", "alternates"));
    throw sandboxError(
      "Disposable validation clone unexpectedly shares a Git object store.",
      "PROJECT_VALIDATION_CLONE_UNSAFE",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function validateSeatbeltExecutable(executable) {
  if (process.platform !== "darwin") {
    throw sandboxError(`No fail-closed project validation sandbox is available on ${process.platform}.`);
  }
  const resolved = await realpath(executable).catch(() => "");
  if (resolved !== "/usr/bin/sandbox-exec") {
    throw sandboxError("Project validation requires the system /usr/bin/sandbox-exec provider.");
  }
  const info = await lstat(resolved);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw sandboxError("The project validation sandbox provider has unsafe ownership or permissions.");
  }
  return resolved;
}

export async function prepareProjectValidationSandbox(input = {}) {
  const requestedSourceRepoPath = String(input.sourceRepoPath || "");
  const requestedWorkspaceRoot = String(input.workspaceRoot || "");
  const expectedHeadSha = String(input.expectedHeadSha || "").trim().toLowerCase();
  if (!path.isAbsolute(requestedSourceRepoPath) || !path.isAbsolute(requestedWorkspaceRoot)) {
    throw sandboxError("Project validation source and workspace paths must be absolute.", "PROJECT_VALIDATION_INPUT_INVALID");
  }
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(expectedHeadSha)) {
    throw sandboxError("Project validation requires an exact full commit SHA.", "PROJECT_VALIDATION_INPUT_INVALID");
  }
  const sourceRepoPath = await realpath(requestedSourceRepoPath).catch(() => "");
  if (!sourceRepoPath || !(await lstat(sourceRepoPath)).isDirectory()) {
    throw sandboxError("Project validation source must be an existing directory.", "PROJECT_VALIDATION_INPUT_INVALID");
  }
  const prospectiveWorkspaceRoot = await prospectiveCanonicalPath(requestedWorkspaceRoot);
  if (containsPath(sourceRepoPath, prospectiveWorkspaceRoot)) {
    throw sandboxError("Project validation workspace root must be outside its trusted source clone.", "PROJECT_VALIDATION_INPUT_INVALID");
  }

  await mkdir(requestedWorkspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpath(requestedWorkspaceRoot);
  if (containsPath(sourceRepoPath, workspaceRoot)) {
    throw sandboxError("Project validation workspace root resolved inside its trusted source clone.", "PROJECT_VALIDATION_INPUT_INVALID");
  }
  const rootPath = await mkdtemp(path.join(workspaceRoot, "validation-sandbox-"));
  let prepared = false;
  try {
    const repoPath = path.join(rootPath, "repo");
    const homePath = path.join(rootPath, "home");
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(path.join(homePath, "tmp"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(homePath, ".config", "gh"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(homePath, ".cache"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(homePath, ".npm-cache"), { recursive: true, mode: 0o700 }),
      writeFile(path.join(homePath, ".npmrc"), "", { mode: 0o600 }),
      writeFile(path.join(homePath, ".npm-globalrc"), "", { mode: 0o600 }),
    ]);
    const gitExecutable = await validateTrustedGitExecutable();
    const gitEnvironment = validationEnvironment(homePath, DEFAULT_PROJECT_VALIDATION_PATH);
    await trustedGit("", [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-tags",
      "--no-checkout",
      "--",
      sourceRepoPath,
      repoPath,
    ], { executable: gitExecutable, env: gitEnvironment, timeoutMs: Number(input.cloneTimeoutMs || DEFAULT_TIMEOUT_MS) });
    await trustedGit(repoPath, ["checkout", "--detach", expectedHeadSha], { executable: gitExecutable, env: gitEnvironment });
    await trustedGit(repoPath, ["remote", "remove", "origin"], { executable: gitExecutable, env: gitEnvironment });
    await assertNoAlternates(repoPath);

    const actualHead = (await trustedGit(repoPath, ["rev-parse", "--verify", "HEAD"], {
      executable: gitExecutable,
      env: gitEnvironment,
    })).stdout.trim().toLowerCase();
    if (actualHead !== expectedHeadSha) {
      throw sandboxError(
        `Disposable validation clone identity mismatch: expected ${expectedHeadSha}, observed ${actualHead || "missing"}.`,
        "PROJECT_VALIDATION_CLONE_UNSAFE",
      );
    }

    const executable = await validateSeatbeltExecutable(input.sandboxExecutable || "/usr/bin/sandbox-exec");
    const requestedValidationPath = input.validationPath === undefined || input.validationPath === null
      ? DEFAULT_PROJECT_VALIDATION_PATH
      : String(input.validationPath);
    const pathRoots = await canonicalValidationToolRoots(requestedValidationPath.split(path.delimiter));
    for (const toolRoot of pathRoots) {
      const approvedToolRoot = SYSTEM_RUNTIME_READ_ROOTS.some((approvedRoot) => containsPath(approvedRoot, toolRoot));
      if (containsPath(sourceRepoPath, toolRoot) || containsPath(os.homedir(), toolRoot) || !approvedToolRoot) {
        throw sandboxError(`Unsafe validation PATH entry: ${toolRoot}.`, "PROJECT_VALIDATION_INPUT_INVALID");
      }
    }
    const validationPath = pathRoots.join(path.delimiter);
    const resolvedRoot = await realpath(rootPath);
    const resolvedRepoPath = await realpath(repoPath);
    const resolvedHomePath = await realpath(homePath);
    const verifierExecutable = await canonicalVerifierExecutable();
    const expectedWorkspaceManifest = await snapshotWorkspaceManifest(resolvedRepoPath);
    const profile = seatbeltProfile(resolvedRoot, pathRoots, verifierExecutable);
    const environment = validationEnvironment(resolvedHomePath, validationPath);
    const sandbox = {
      rootPath: resolvedRoot,
      repoPath: resolvedRepoPath,
      homePath: resolvedHomePath,
      executable,
      profile,
      environment,
      policyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
      strategy: "disposable_full_clone",
      networkPolicy: "deny_all",
      processPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
      validationPath,
      verifierExecutable,
      expectedHeadSha,
      expectedWorkspaceManifest,
    };
    const preflight = await runCaptured(executable, [
      "-p",
      profile,
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "test -d \"$HOME\" && test -d \"$TMPDIR\" && printf sandbox-ready",
    ], {
      cwd: sandbox.repoPath,
      env: environment,
      timeoutMs: 15_000,
    });
    if (!preflight.ok || preflight.stdout !== "sandbox-ready") {
      throw sandboxError(
        `Project validation sandbox preflight failed: ${preflight.output || `exit=${preflight.code ?? "none"} signal=${preflight.signal || "none"}`}`,
      );
    }
    const verifierPreflight = await runCaptured(executable, [
      "-p",
      profile,
      verifierExecutable,
      "-e",
      "process.stdout.write('verifier-ready')",
    ], {
      cwd: sandbox.repoPath,
      env: environment,
      timeoutMs: 15_000,
    });
    if (!verifierPreflight.ok || verifierPreflight.stdout !== "verifier-ready") {
      throw sandboxError(
        `Project validation verifier preflight failed: ${verifierPreflight.output || `exit=${verifierPreflight.code ?? "none"} signal=${verifierPreflight.signal || "none"}`}`,
      );
    }
    const rootIdentity = await lstat(resolvedRoot);
    SANDBOX_CAPABILITIES.set(sandbox, {
      rootPath: resolvedRoot,
      workspaceRoot,
      repoPath: resolvedRepoPath,
      homePath: resolvedHomePath,
      executable,
      profile,
      environment,
      verifierExecutable,
      expectedHeadSha,
      expectedWorkspaceManifest: structuredClone(expectedWorkspaceManifest),
      dependencyCachePrepared: false,
      device: Number(rootIdentity.dev),
      inode: Number(rootIdentity.ino),
      cleaned: false,
    });
    Object.freeze(sandbox);
    prepared = true;
    return sandbox;
  } finally {
    if (!prepared) await rm(rootPath, { recursive: true, force: true });
  }
}

function sandboxCapability(sandbox, options = {}) {
  const capability = sandbox && typeof sandbox === "object" ? SANDBOX_CAPABILITIES.get(sandbox) : null;
  if (!capability || (capability.cleaned && !options.allowCleaned)) {
    throw sandboxError(
      "A live verified project validation sandbox capability is required.",
      options.errorCode || "PROJECT_VALIDATION_SANDBOX_UNAVAILABLE",
    );
  }
  return capability;
}

export async function runProjectValidationCommand(sandbox, command, options = {}) {
  const capability = sandboxCapability(sandbox);
  return runCaptured(capability.executable, [
    "-p",
    capability.profile,
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    String(command || ""),
  ], {
    cwd: capability.repoPath,
    env: capability.environment,
    timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    maxCaptureBytes: options.maxCaptureBytes,
  });
}

function dependencyAcquisitionError(message, output = "") {
  const error = sandboxError(message, "PROJECT_VALIDATION_DEPENDENCY_ACQUISITION_FAILED");
  error.output = output;
  return error;
}

/**
 * Populate a lockfile-bound npm cache before entering the deny-all sandbox.
 * npm ci is deliberately run with lifecycle scripts disabled; the disposable
 * sandbox performs the actual install and product validation later.
 */
export async function prepareProjectValidationDependencies(sandbox, options = {}) {
  const capability = sandboxCapability(sandbox);
  const lockName = await (async () => {
    for (const candidate of ["package-lock.json", "npm-shrinkwrap.json"]) {
      try {
        const info = await lstat(path.join(capability.repoPath, candidate));
        if (info.isFile()) return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return "";
  })();
  if (!lockName) return { applicable: false, status: "not_applicable" };

  const lockPath = path.join(capability.repoPath, lockName);
  const lockBytes = await readFile(lockPath);
  const lockDigest = createHash("sha256").update(lockBytes).digest("hex");
  const cachePath = path.join(capability.rootPath, `npm-cache-${lockDigest}`);
  const identityPath = path.join(cachePath, ".studioops-cache-identity.json");
  await mkdir(cachePath, { recursive: true, mode: 0o700 });
  let cachePrepared = false;
  try {
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    if (identity.lockfile !== lockName || identity.lockDigest !== lockDigest) {
      throw dependencyAcquisitionError(
        `Prepared npm cache identity does not match ${lockName}; refusing incompatible dependency reuse.`,
      );
    }
    cachePrepared = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error?.code === "PROJECT_VALIDATION_DEPENDENCY_ACQUISITION_FAILED") throw error;
      throw dependencyAcquisitionError(`Prepared npm cache identity is unreadable: ${error.message}`);
    }
  }

  const acquisitionEnvironment = {
    ...capability.environment,
    npm_config_cache: cachePath,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_userconfig: path.join(capability.homePath, ".npmrc"),
  };
  let acquisition;
  try {
    acquisition = cachePrepared ? { ok: true, output: "reused lockfile-bound cache" } : await runCaptured("npm", [
      "ci",
      "--ignore-scripts",
      "--cache",
      cachePath,
      "--prefer-online",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: capability.repoPath,
      env: acquisitionEnvironment,
      timeoutMs: Number(options.dependencyAcquisitionTimeoutMs || DEFAULT_DEPENDENCY_ACQUISITION_TIMEOUT_MS),
      maxCaptureBytes: Number(options.dependencyAcquisitionMaxCaptureBytes || DEFAULT_DEPENDENCY_ACQUISITION_MAX_CAPTURE_BYTES),
    });
  } catch (error) {
    await rm(path.join(capability.repoPath, "node_modules"), { recursive: true, force: true });
    throw dependencyAcquisitionError(`Dependency acquisition could not start for ${lockName}: ${error.message}`);
  }
  await rm(path.join(capability.repoPath, "node_modules"), { recursive: true, force: true });
  if (!acquisition.ok) {
    throw dependencyAcquisitionError(
      `Dependency acquisition failed for ${lockName}: ${acquisition.output || `exit=${acquisition.code ?? "none"}`}`,
      acquisition.output,
    );
  }
  await writeFile(identityPath, JSON.stringify({
    schemaVersion: "studioops.project-validation-npm-cache.v1",
    lockfile: lockName,
    lockDigest,
  }) + "\n", { mode: 0o600 });
  capability.environment.npm_config_cache = cachePath;
  capability.dependencyCachePrepared = true;
  return {
    applicable: true,
    status: "prepared",
    lockfile: lockName,
    lockDigest,
    cachePath,
    acquisition: {
      ok: true,
      timeoutMs: Number(options.dependencyAcquisitionTimeoutMs || DEFAULT_DEPENDENCY_ACQUISITION_TIMEOUT_MS),
    },
  };
}

export async function installPreparedProjectValidationDependencies(sandbox, options = {}) {
  const capability = sandboxCapability(sandbox);
  if (!capability.dependencyCachePrepared) return { applicable: false, status: "not_applicable" };
  const result = await runProjectValidationCommand(sandbox, "npm ci --offline --no-audit --no-fund", {
    timeoutMs: Number(options.validationTimeoutMs || DEFAULT_TIMEOUT_MS),
    maxCaptureBytes: Number(options.maxCaptureBytes || DEFAULT_DEPENDENCY_ACQUISITION_MAX_CAPTURE_BYTES),
  });
  return { applicable: true, status: result.ok ? "installed" : "failed", ...result };
}

export async function verifyProjectValidationSandbox(sandbox) {
  const capability = sandboxCapability(sandbox);
  // The checkout, index, and local Git configuration are untrusted after a
  // project command runs. Git verifies only the ref identity with replacement
  // objects disabled. A pre-validation byte/mode/symlink manifest verifies the
  // worktree without consulting candidate-controlled index flags, attributes,
  // filters, diff drivers, hooks, or core.worktree configuration.
  const headVerification = await runCaptured(capability.executable, [
    "-p",
    capability.profile,
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    [
      "set -eu",
      `test \"$(${TRUSTED_GIT_EXECUTABLE} --no-replace-objects --git-dir=.git --work-tree=. -c core.hooksPath=/dev/null -c credential.helper= -c core.fsmonitor=false -c core.worktree=. rev-parse --verify 'HEAD^{commit}')\" = ${seatbeltLiteral(capability.expectedHeadSha)}`,
    ].join("\n"),
  ], {
    cwd: capability.repoPath,
    env: { ...capability.environment, GIT_NO_REPLACE_OBJECTS: "1" },
    timeoutMs: 30_000,
  }).catch(() => ({ ok: false }));
  const manifestVerification = headVerification.ok && Array.isArray(capability.expectedWorkspaceManifest)
    ? await runCaptured(capability.executable, [
        "-p",
        capability.profile,
        capability.verifierExecutable,
        "-e",
        VERIFY_WORKSPACE_MANIFEST_SCRIPT,
      ], {
        cwd: capability.repoPath,
        env: capability.environment,
        input: JSON.stringify(capability.expectedWorkspaceManifest),
        timeoutMs: 30_000,
      }).catch(() => ({ ok: false }))
    : { ok: false };
  if (!headVerification.ok || !manifestVerification.ok) {
    throw sandboxError(
      "Repository validation changed the exact candidate checkout; its result cannot be trusted.",
      "PROJECT_VALIDATION_IDENTITY_DRIFT",
    );
  }
  return {
    head: capability.expectedHeadSha,
    policyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
    strategy: "disposable_full_clone",
    networkPolicy: "deny_all",
    processPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
  };
}

export async function cleanupProjectValidationSandbox(sandbox) {
  if (!sandbox) return;
  const capability = sandboxCapability(sandbox, {
    allowCleaned: true,
    errorCode: "PROJECT_VALIDATION_CLEANUP_UNSAFE",
  });
  if (capability.cleaned) return;
  const rootPath = capability.rootPath;
  if (
    rootPath === path.parse(rootPath).root
    || path.dirname(rootPath) !== capability.workspaceRoot
    || !path.basename(rootPath).startsWith("validation-sandbox-")
  ) {
    throw sandboxError(`Refusing to remove unsafe validation sandbox path: ${rootPath}.`, "PROJECT_VALIDATION_CLEANUP_UNSAFE");
  }
  let currentIdentity;
  try {
    currentIdentity = await lstat(rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      capability.cleaned = true;
      return;
    }
    throw error;
  }
  const canonicalRoot = await realpath(rootPath).catch(() => "");
  if (
    canonicalRoot !== rootPath
    || !currentIdentity.isDirectory()
    || Number(currentIdentity.dev) !== capability.device
    || Number(currentIdentity.ino) !== capability.inode
  ) {
    throw sandboxError(`Refusing to remove replaced validation sandbox path: ${rootPath}.`, "PROJECT_VALIDATION_CLEANUP_UNSAFE");
  }
  await rm(rootPath, { recursive: true, force: true });
  capability.cleaned = true;
}
