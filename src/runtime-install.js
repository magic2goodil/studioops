import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defaultStudioOpsRuntimeRoot } from "./runtime-paths.js";

const execFileAsync = promisify(execFile);
const RUNTIME_ITEMS = [
  "src",
  "public",
  "scripts",
  "deploy",
  "package.json",
  "package-lock.json",
  "plugins/studioops/.codex-plugin/plugin.json",
];
const LEGACY_REPOSITORY_NAME = "codex-mission-control";
const CURRENT_REPOSITORY_NAME = "studioops";
const CANONICAL_REPOSITORY_URL = "https://github.com/magic2goodil/studioops";
const CANONICAL_NORMALIZED_ORIGIN = "github.com/magic2goodil/studioops";
const PROVENANCE_FILE = "studioops-runtime-provenance.v1.json";
const PLUGIN_MANIFEST_PATH = path.join("plugins", "studioops", ".codex-plugin", "plugin.json");
const SCAN_ENTRY_PATHS = [
  "README.md",
  "package.json",
  "public",
  "scripts",
  "src",
  "plugins/studioops",
];
const SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "data",
  "logs",
  "credentials",
  ".credentials",
]);
const SCAN_EXTENSIONS = new Set([".css", ".example", ".html", ".js", ".json", ".md", ".mjs", ".scss", ".txt"]);
const MAX_SCAN_FILE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_FINDINGS = 200;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_DEPTH = 16;
const MAX_IDENTITY_FILE_BYTES = 1024 * 1024;

export const STUDIOOPS_IDENTITY = Object.freeze({
  product: "StudioOps",
  repository: CANONICAL_REPOSITORY_URL,
  normalizedRepository: CANONICAL_NORMALIZED_ORIGIN,
  packageName: "studioops",
  pluginName: "studioops",
  provenanceSchemaVersion: 1,
  provenanceFile: PROVENANCE_FILE,
});

export function normalizeGitRemoteUrl(value) {
  let remote = String(value || "").trim();
  if (!remote) return "";

  const scpStyle = remote.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
  if (scpStyle && !remote.includes("://")) {
    remote = `${scpStyle[1]}/${scpStyle[2]}`;
  } else {
    try {
      const parsed = new URL(remote);
      remote = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      remote = remote.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, "");
    }
  }

  return remote
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function planSourceRemoteMigration(existingOrigin, desiredOrigin) {
  const existing = normalizeGitRemoteUrl(existingOrigin);
  const desired = normalizeGitRemoteUrl(desiredOrigin);
  if (!existing || !desired) return { action: "reject", reason: "missing_origin" };
  if (existing === desired) return { action: "keep", existing, desired };

  const existingParts = existing.split("/");
  const desiredParts = desired.split("/");
  const sameOwner = existingParts.length === desiredParts.length
    && existingParts.slice(0, -1).join("/") === desiredParts.slice(0, -1).join("/");
  const recognizedRename = sameOwner
    && existingParts.at(-1) === LEGACY_REPOSITORY_NAME
    && desiredParts.at(-1) === CURRENT_REPOSITORY_NAME;

  if (recognizedRename) return { action: "migrate", existing, desired };
  return { action: "reject", reason: "unrecognized_origin", existing, desired };
}

export function sourceCheckoutSafetyError(input = {}) {
  if (String(input.statusOutput || "").trim()) return "has uncommitted changes";
  const sourceBranch = String(input.sourceBranch || "main").trim();
  const currentBranch = String(input.currentBranch || "").trim();
  if (currentBranch !== sourceBranch) {
    return `must be on ${sourceBranch}, but is on ${currentBranch || "a detached HEAD"}`;
  }
  if (Number(input.ahead || 0) > 0) return "has local commits and cannot be fast-forwarded safely";
  return "";
}

function safeSegment(value) {
  return String(value || "runtime").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

async function readJson(filePath) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile()) throw new Error("identity path is not a regular file");
  if (fileStat.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error(`identity file exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

function validCommit(value) {
  return /^[0-9a-f]{40}$/.test(String(value || ""));
}

async function gitOutput(sourceRoot, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: sourceRoot, timeout: 15_000 });
  return String(stdout || "").trim();
}

function pluginIdentity(plugin = {}) {
  return {
    name: String(plugin.name || ""),
    version: String(plugin.version || ""),
    repository: String(plugin.repository || ""),
    homepage: String(plugin.homepage || ""),
  };
}

function packageIdentity(packageJson = {}) {
  return {
    name: String(packageJson.name || ""),
    version: String(packageJson.version || ""),
  };
}

function pluginIsCanonical(plugin) {
  return plugin.name === STUDIOOPS_IDENTITY.pluginName
    && Boolean(plugin.version)
    && plugin.repository === CANONICAL_REPOSITORY_URL
    && plugin.homepage === CANONICAL_REPOSITORY_URL;
}

function packageIsCanonical(packageJson) {
  return packageJson.name === STUDIOOPS_IDENTITY.packageName && Boolean(packageJson.version);
}

async function inspectCanonicalSource(sourceRoot) {
  const [origin, commit, statusOutput, packageJson, pluginJson] = await Promise.all([
    gitOutput(sourceRoot, ["remote", "get-url", "origin"]),
    gitOutput(sourceRoot, ["rev-parse", "HEAD"]),
    gitOutput(sourceRoot, ["status", "--porcelain", "--untracked-files=normal"]),
    readJson(path.join(sourceRoot, "package.json")),
    readJson(path.join(sourceRoot, PLUGIN_MANIFEST_PATH)),
  ]);
  const normalizedOrigin = normalizeGitRemoteUrl(origin);
  const packageInfo = packageIdentity(packageJson);
  const pluginInfo = pluginIdentity(pluginJson);
  const problems = [];
  if (normalizedOrigin !== CANONICAL_NORMALIZED_ORIGIN) {
    problems.push(`origin must be ${CANONICAL_REPOSITORY_URL}, received ${origin || "no origin"}`);
  }
  if (!validCommit(commit)) problems.push("HEAD must resolve to an exact 40-character commit");
  if (statusOutput) problems.push("source checkout has uncommitted changes");
  if (!packageIsCanonical(packageInfo)) problems.push("package identity must be studioops with a version");
  if (!pluginIsCanonical(pluginInfo)) {
    problems.push("plugin identity must be studioops with canonical repository, homepage, and a version");
  }
  if (problems.length) throw new Error(`StudioOps runtime source identity rejected: ${problems.join("; ")}`);
  return {
    origin: CANONICAL_REPOSITORY_URL,
    normalizedOrigin,
    commit,
    clean: true,
    package: packageInfo,
    plugin: {
      ...pluginInfo,
      repository: CANONICAL_REPOSITORY_URL,
      homepage: CANONICAL_REPOSITORY_URL,
    },
  };
}

function provenanceManifest(source) {
  return {
    schemaVersion: STUDIOOPS_IDENTITY.provenanceSchemaVersion,
    product: STUDIOOPS_IDENTITY.product,
    repository: STUDIOOPS_IDENTITY.repository,
    source: {
      origin: source.origin,
      normalizedOrigin: source.normalizedOrigin,
      commit: source.commit,
      clean: source.clean,
    },
    package: source.package,
    plugin: source.plugin,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function validateRelease(releasePath, expectedManifest) {
  let actualManifest;
  let runtimePackage;
  let runtimePlugin;
  try {
    const [serverStat, provenance, packageJson, pluginJson] = await Promise.all([
      lstat(path.join(releasePath, "src", "server.js")),
      readJson(path.join(releasePath, PROVENANCE_FILE)),
      readJson(path.join(releasePath, "package.json")),
      readJson(path.join(releasePath, PLUGIN_MANIFEST_PATH)),
    ]);
    if (!serverStat.isFile()) throw new Error("src/server.js is not a file");
    actualManifest = provenance;
    runtimePackage = packageIdentity(packageJson);
    runtimePlugin = pluginIdentity(pluginJson);
  } catch (error) {
    throw new Error(`release metadata is incomplete: ${error.message}`);
  }
  if (!sameJson(actualManifest, expectedManifest)) {
    throw new Error("provenance manifest contradicts the canonical source identity");
  }
  if (!sameJson(runtimePackage, expectedManifest.package)) {
    throw new Error("runtime package identity contradicts its provenance");
  }
  if (!sameJson(runtimePlugin, expectedManifest.plugin)) {
    throw new Error("runtime plugin identity contradicts its provenance");
  }
  if (path.basename(releasePath) !== expectedManifest.source.commit) {
    throw new Error("release directory does not match the provenance commit");
  }
  return actualManifest;
}

async function copyWithRetry(source, destination, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = error?.errno === -11 || error?.code === "EAGAIN" || /Unknown system error -11/i.test(error?.message || "");
      if (!transient || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** (attempt - 1))));
    }
  }
}

async function swapCurrentLink(runtimeRoot, releasePath) {
  const currentPath = path.join(runtimeRoot, "current");
  const nextPath = path.join(runtimeRoot, `.current-${process.pid}-${Date.now()}`);
  await symlink(releasePath, nextPath, "dir");
  await rename(nextPath, currentPath).catch(async (error) => {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    await rm(currentPath, { force: true, recursive: true });
    await rename(nextPath, currentPath);
  });
}

async function pruneOldReleases(runtimeRoot, currentRelease, keep = 3) {
  const releasesRoot = path.join(runtimeRoot, "releases");
  const entries = await readdir(releasesRoot, { withFileTypes: true });
  const releases = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  const keepNames = new Set([path.basename(currentRelease), ...releases.slice(0, keep)]);
  for (const name of releases) {
    if (!keepNames.has(name)) await rm(path.join(releasesRoot, name), { recursive: true, force: true });
  }
}

export function defaultRuntimeRoot() {
  return defaultStudioOpsRuntimeRoot();
}

export async function activateRuntime(runtime, input = {}) {
  await swapCurrentLink(runtime.runtimeRoot, runtime.releasePath);
  if (input.prune !== false) {
    await pruneOldReleases(runtime.runtimeRoot, runtime.releasePath, Number(input.keepReleases || 3));
  }
  return {
    ...runtime,
    currentPath: path.join(runtime.runtimeRoot, "current"),
    currentTarget: await readlink(path.join(runtime.runtimeRoot, "current")),
  };
}

export async function restoreRuntimeCurrent(runtime) {
  const currentPath = path.join(runtime.runtimeRoot, "current");
  if (runtime.previousCurrentTarget) {
    await swapCurrentLink(runtime.runtimeRoot, runtime.previousCurrentTarget);
  } else {
    await rm(currentPath, { force: true });
  }
}

export async function pruneRuntimeReleases(runtime, input = {}) {
  await pruneOldReleases(runtime.runtimeRoot, runtime.releasePath, Number(input.keepReleases || 3));
}

export async function deployRuntime(input = {}) {
  const sourceRoot = path.resolve(input.sourceRoot || process.cwd());
  const runtimeRoot = path.resolve(
    input.runtimeRoot
      || process.env.STUDIOOPS_RUNTIME_ROOT
      || process.env.MISSION_CONTROL_RUNTIME_ROOT
      || defaultRuntimeRoot(),
  );
  const source = await inspectCanonicalSource(sourceRoot);
  const manifest = provenanceManifest(source);
  const version = safeSegment(source.commit);
  const releasesRoot = path.join(runtimeRoot, "releases");
  const releasePath = path.join(releasesRoot, version);
  const stagePath = path.join(releasesRoot, `.stage-${version}-${process.pid}-${Date.now()}`);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700).catch(() => {});
  await chmod(releasesRoot, 0o700).catch(() => {});

  let releaseExists = false;
  try {
    const stat = await lstat(releasePath);
    releaseExists = stat.isDirectory();
  } catch {
    releaseExists = false;
  }

  if (releaseExists) {
    await validateRelease(releasePath, manifest).catch((error) => {
      throw new Error(`StudioOps runtime release ${version} cannot be reused: ${error.message}`);
    });
  } else {
    await rm(stagePath, { recursive: true, force: true });
    await mkdir(stagePath, { recursive: true });
    for (const item of RUNTIME_ITEMS) {
      await copyWithRetry(path.join(sourceRoot, item), path.join(stagePath, item));
    }
    const npmBin = input.npmBin
      || process.env.STUDIOOPS_NPM_PATH
      || process.env.MISSION_CONTROL_NPM_PATH
      || "npm";
    await execFileAsync(npmBin, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: stagePath,
      timeout: Number(input.installTimeoutMs || 5 * 60 * 1000),
      env: process.env,
    });
    await writeFile(path.join(stagePath, PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o444,
    });
    await rename(stagePath, releasePath).catch(async (error) => {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await rm(stagePath, { recursive: true, force: true });
    });
    await validateRelease(releasePath, manifest).catch((error) => {
      throw new Error(`StudioOps runtime release ${version} failed provenance validation: ${error.message}`);
    });
  }

  const currentPath = path.join(runtimeRoot, "current");
  let previousCurrentTarget = "";
  try {
    previousCurrentTarget = await readlink(currentPath);
  } catch {
    previousCurrentTarget = "";
  }
  const runtime = {
    sourceRoot,
    runtimeRoot,
    releasePath,
    currentPath,
    currentTarget: "",
    previousCurrentTarget,
    version,
    provenance: manifest,
  };
  if (input.activate === false) return runtime;
  return activateRuntime(runtime, input);
}

function verificationError(errors, code, message) {
  errors.push({ code, message });
}

async function inspectSourceForVerification(sourceRoot, errors) {
  const result = {
    root: sourceRoot,
    origin: "",
    normalizedOrigin: "",
    head: "",
    clean: false,
    canonical: false,
  };
  try {
    result.origin = await gitOutput(sourceRoot, ["remote", "get-url", "origin"]);
    result.normalizedOrigin = normalizeGitRemoteUrl(result.origin);
  } catch (error) {
    verificationError(errors, "source_origin_unavailable", `Source origin could not be read: ${error.message}`);
  }
  try {
    result.head = await gitOutput(sourceRoot, ["rev-parse", "HEAD"]);
    if (!validCommit(result.head)) {
      verificationError(errors, "source_head_invalid", "Source HEAD is not an exact 40-character commit.");
    }
  } catch (error) {
    verificationError(errors, "source_head_unavailable", `Source HEAD could not be read: ${error.message}`);
  }
  try {
    result.clean = !(await gitOutput(sourceRoot, ["status", "--porcelain", "--untracked-files=normal"]));
    if (!result.clean) verificationError(errors, "source_dirty", "Source checkout has uncommitted changes.");
  } catch (error) {
    verificationError(errors, "source_clean_state_unavailable", `Source clean state could not be read: ${error.message}`);
  }
  result.canonical = result.normalizedOrigin === CANONICAL_NORMALIZED_ORIGIN;
  if (!result.canonical) {
    verificationError(
      errors,
      "source_origin_mismatch",
      `Source origin must normalize to ${CANONICAL_NORMALIZED_ORIGIN}.`,
    );
  }
  return result;
}

async function readIdentityFile(filePath, kind, errors, scope) {
  try {
    const data = await readJson(filePath);
    return kind === "package" ? packageIdentity(data) : pluginIdentity(data);
  } catch (error) {
    verificationError(errors, `${scope}_${kind}_unavailable`, `${scope} ${kind} identity could not be read: ${error.message}`);
    return kind === "package"
      ? { name: "", version: "" }
      : { name: "", version: "", repository: "", homepage: "" };
  }
}

async function inspectRuntimeForVerification(runtimeRoot, errors) {
  const currentPath = path.join(runtimeRoot, "current");
  const result = {
    root: runtimeRoot,
    currentPath,
    currentTarget: "",
    releasePath: "",
    commit: "",
  };
  try {
    result.currentTarget = await readlink(currentPath);
    result.releasePath = path.resolve(path.dirname(currentPath), result.currentTarget);
    const releasesRoot = path.resolve(runtimeRoot, "releases");
    if (path.dirname(result.releasePath) !== releasesRoot) {
      verificationError(errors, "runtime_target_unrelated", "Runtime current target is outside the immutable releases directory.");
      result.releasePath = "";
      return result;
    }
    result.commit = path.basename(result.releasePath);
    if (!validCommit(result.commit)) {
      verificationError(errors, "runtime_commit_invalid", "Runtime release directory is not an exact 40-character commit.");
    }
  } catch (error) {
    verificationError(errors, "runtime_current_unavailable", `Runtime current target could not be read: ${error.message}`);
  }
  return result;
}

function scanMatch(line, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(line)) matches.push(pattern.id);
  }
  return matches;
}

async function scanPresentationRoot(root, scope, findings, compatibilityFindings, counters) {
  const stalePatterns = [
    { id: "legacy_product_name", expression: /\bMission Control\b/i },
    {
      id: "retired_repository_url",
      expression: /(?:https?:\/\/|git@)github\.com[/:]magic2goodil\/codex-mission-control(?:\.git)?/i,
    },
  ];
  const compatibilityPatterns = [
    { id: "legacy_launchagent_label", expression: /\bcom\.codex\.mission-control(?:\.[a-z0-9-]+)*\b/i },
    { id: "legacy_environment_variable", expression: /\bMISSION_CONTROL_[A-Z0-9_]+\b/ },
    { id: "legacy_database_filename", expression: /\bmission-control\.sqlite3\b/i },
    { id: "legacy_config_filename", expression: /\bmission-control\.config\.md\b/i },
  ];

  const visit = async (candidate, relativePath, depth) => {
    if (
      counters.files >= MAX_SCAN_FILES
      || counters.entries >= MAX_SCAN_ENTRIES
      || findings.length >= MAX_SCAN_FINDINGS
      || depth > MAX_SCAN_DEPTH
    ) return;
    counters.entries += 1;
    let fileStat;
    try {
      fileStat = await lstat(candidate);
    } catch {
      return;
    }
    if (fileStat.isSymbolicLink()) return;
    if (fileStat.isDirectory()) {
      if (relativePath && SCAN_EXCLUDED_DIRECTORIES.has(path.basename(relativePath).toLowerCase())) return;
      let entries = [];
      try {
        entries = await readdir(candidate, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (
          counters.files >= MAX_SCAN_FILES
          || counters.entries >= MAX_SCAN_ENTRIES
          || findings.length >= MAX_SCAN_FINDINGS
        ) break;
        await visit(path.join(candidate, entry.name), path.join(relativePath, entry.name), depth + 1);
      }
      return;
    }
    if (!fileStat.isFile() || fileStat.size > MAX_SCAN_FILE_BYTES) return;
    if (!SCAN_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return;
    counters.files += 1;
    let raw;
    try {
      raw = await readFile(candidate);
    } catch {
      return;
    }
    if (raw.includes(0)) return;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const stale = scanMatch(lines[index], stalePatterns);
      const compatibility = scanMatch(lines[index], compatibilityPatterns);
      for (const match of stale) {
        if (findings.length >= MAX_SCAN_FINDINGS) break;
        findings.push({ scope, path: relativePath.split(path.sep).join("/"), line: index + 1, match });
      }
      for (const identifier of compatibility) {
        if (compatibilityFindings.length >= MAX_SCAN_FINDINGS) break;
        compatibilityFindings.push({
          scope,
          path: relativePath.split(path.sep).join("/"),
          line: index + 1,
          identifier,
        });
      }
    }
  };

  for (const entryPath of SCAN_ENTRY_PATHS) {
    if (
      counters.files >= MAX_SCAN_FILES
      || counters.entries >= MAX_SCAN_ENTRIES
      || findings.length >= MAX_SCAN_FINDINGS
    ) break;
    await visit(path.join(root, entryPath), entryPath, 0);
  }
}

export async function verifyStudioOpsIdentity(input = {}) {
  const sourceRoot = path.resolve(input.sourceRoot || process.cwd());
  const runtimeRoot = path.resolve(
    input.runtimeRoot
      || process.env.STUDIOOPS_RUNTIME_ROOT
      || process.env.MISSION_CONTROL_RUNTIME_ROOT
      || defaultRuntimeRoot(),
  );
  const errors = [];
  const source = await inspectSourceForVerification(sourceRoot, errors);
  const runtime = await inspectRuntimeForVerification(runtimeRoot, errors);
  const sourcePackage = await readIdentityFile(path.join(sourceRoot, "package.json"), "package", errors, "source");
  const sourcePlugin = await readIdentityFile(
    path.join(sourceRoot, PLUGIN_MANIFEST_PATH),
    "plugin",
    errors,
    "source",
  );
  const runtimePackage = runtime.releasePath
    ? await readIdentityFile(path.join(runtime.releasePath, "package.json"), "package", errors, "runtime")
    : { name: "", version: "" };
  const runtimePlugin = runtime.releasePath
    ? await readIdentityFile(path.join(runtime.releasePath, PLUGIN_MANIFEST_PATH), "plugin", errors, "runtime")
    : { name: "", version: "", repository: "", homepage: "" };
  let manifest = null;
  const provenance = {
    path: runtime.releasePath ? path.join(runtime.releasePath, PROVENANCE_FILE) : "",
    present: false,
    valid: false,
    schemaVersion: null,
    sourceCommit: "",
  };
  if (provenance.path) {
    try {
      manifest = await readJson(provenance.path);
      provenance.present = true;
      provenance.schemaVersion = manifest.schemaVersion ?? null;
      provenance.sourceCommit = String(manifest.source?.commit || "");
    } catch (error) {
      verificationError(errors, "runtime_provenance_unavailable", `Runtime provenance could not be read: ${error.message}`);
    }
  }

  const packageIdentityValid = packageIsCanonical(sourcePackage)
    && packageIsCanonical(runtimePackage)
    && sameJson(sourcePackage, runtimePackage);
  if (!packageIdentityValid) {
    verificationError(errors, "package_identity_mismatch", "Source and runtime package identity must match canonical studioops metadata.");
  }
  const pluginIdentityValid = pluginIsCanonical(sourcePlugin)
    && pluginIsCanonical(runtimePlugin)
    && sameJson(sourcePlugin, runtimePlugin);
  if (!pluginIdentityValid) {
    verificationError(errors, "plugin_identity_mismatch", "Source and runtime plugin identity must match canonical StudioOps metadata.");
  }

  if (manifest) {
    const expected = {
      schemaVersion: STUDIOOPS_IDENTITY.provenanceSchemaVersion,
      product: STUDIOOPS_IDENTITY.product,
      repository: STUDIOOPS_IDENTITY.repository,
      source: {
        origin: STUDIOOPS_IDENTITY.repository,
        normalizedOrigin: STUDIOOPS_IDENTITY.normalizedRepository,
        commit: source.head,
        clean: true,
      },
      package: sourcePackage,
      plugin: {
        ...sourcePlugin,
        repository: STUDIOOPS_IDENTITY.repository,
        homepage: STUDIOOPS_IDENTITY.repository,
      },
    };
    provenance.valid = sameJson(manifest, expected)
      && runtime.commit === source.head
      && provenance.sourceCommit === runtime.commit;
    if (!provenance.valid) {
      verificationError(errors, "runtime_provenance_mismatch", "Runtime provenance does not bind the current canonical source commit and identity.");
    }
  }

  const staleUserFacingFindings = [];
  const compatibilityFindings = [];
  const scan = {
    filesInspected: 0,
    entriesInspected: 0,
    maxFiles: MAX_SCAN_FILES,
    maxEntries: MAX_SCAN_ENTRIES,
    maxDepth: MAX_SCAN_DEPTH,
    maxFileBytes: MAX_SCAN_FILE_BYTES,
    truncated: false,
  };
  const counters = { files: 0, entries: 0 };
  await scanPresentationRoot(sourceRoot, "source", staleUserFacingFindings, compatibilityFindings, counters);
  if (runtime.releasePath) {
    await scanPresentationRoot(runtime.releasePath, "runtime", staleUserFacingFindings, compatibilityFindings, counters);
  }
  scan.filesInspected = counters.files;
  scan.entriesInspected = counters.entries;
  scan.truncated = counters.files >= MAX_SCAN_FILES
    || counters.entries >= MAX_SCAN_ENTRIES
    || staleUserFacingFindings.length >= MAX_SCAN_FINDINGS;
  if (staleUserFacingFindings.length) {
    verificationError(
      errors,
      "stale_user_facing_identity",
      `${staleUserFacingFindings.length} stale user-facing identity finding(s) detected.`,
    );
  }

  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    canonical: STUDIOOPS_IDENTITY,
    source,
    runtime,
    provenance,
    package: {
      source: sourcePackage,
      runtime: runtimePackage,
      valid: packageIdentityValid,
    },
    plugin: {
      source: sourcePlugin,
      runtime: runtimePlugin,
      valid: pluginIdentityValid,
    },
    compatibility: {
      detail: "Recognized legacy identifiers retained for compatibility only.",
      recognizedIdentifiers: {
        launchAgentLabelPrefix: "com.codex.mission-control",
        environmentVariablePrefix: "MISSION_CONTROL_",
        databaseFilename: "mission-control.sqlite3",
        configFilename: "mission-control.config.md",
      },
      findings: compatibilityFindings,
    },
    staleUserFacingFindings,
    scan,
    errors,
  };
}
