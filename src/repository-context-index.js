import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { studioOpsHome } from "./runtime-paths.js";
import { sha256Digest, projectRepositoryIdentity, normalizeRepositoryIdentity,
  validateComponentImpactMap, pathMatchesImpactScope } from "./component-impact-map.js";
import { extractRepositoryContext, repositoryContextLanguage, REPOSITORY_CONTEXT_EXTRACTOR_VERSION,
  safeContextIdentifier, safeContextSpecifier } from "./repository-context-extractor.js";

export { REPOSITORY_CONTEXT_EXTRACTOR_VERSION } from "./repository-context-extractor.js";
export const REPOSITORY_CONTEXT_SCHEMA_VERSION = 1;
const IGNORE_PATH = ".studioops-contextignore";
const POLICY_VERSION = 4;
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 5000, maxFileBytes: 512 * 1024, maxTotalBytes: 20 * 1024 * 1024,
  maxDurationMs: 15000, parseTimeoutMs: 100, maxSymbolsPerFile: 1000, maxImportsPerFile: 1000 });
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_REASONS = new Set(["unsupported_language", "parse_timeout", "parse_error", "parser_unavailable", "extraction_limit",
  "symbol_limit", "import_limit", "file_limit", "total_byte_limit", "duration_limit", "file_too_large", "binary_file"]);
const TRANSIENT_REASONS = new Set(["duration_limit", "parse_timeout", "parser_unavailable", "extraction_limit"]);

function transientIncomplete(index) {
  return [...TRANSIENT_REASONS].some((reason) => index.coverage?.excluded?.[reason] > 0)
    || index.coverage?.diagnostics?.some((item) => TRANSIENT_REASONS.has(item.reason));
}

function failure(code) { const error = new Error(`Repository context unavailable: ${code}.`); error.code = code; return error; }
function limitsFor(input = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, ceiling]) => {
    const value = input[key] ?? ceiling;
    if (!Number.isInteger(value) || value <= 0) throw failure("invalid_limits");
    return [key, Math.min(ceiling, value)];
  }));
}
function git(root, args, maxBuffer = 8 * 1024 * 1024, input, timeoutMs = 10000) {
  try {
    return execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: null, maxBuffer, input, timeout: timeoutMs,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } });
  } catch { throw failure("git_snapshot_unavailable"); }
}
export function safeRepositoryContextPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && /^[\p{L}\p{N}\p{M} _./@+()\[\],=\-]+$/u.test(value)
    && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}
function exclusion(filePath) {
  if (!safeRepositoryContextPath(filePath)) return "unsafe_path";
  const parts = filePath.toLowerCase().split("/");
  if (parts.some((part) => /^(?:vendor|node_modules|venv|\.venv|backup|backups|dist|build)(?:[._-].+)?$/.test(part))) return "private_or_generated";
  if (parts.some((part) => [".git", ".codex", "node_modules", "vendor", "dist", "build", "coverage", ".next", ".nuxt", "__pycache__",
    ".venv", "venv", ".cache", "logs", "uploads", "backups", "private", "credentials", "secrets"].includes(part))) return "private_or_generated";
  const base = parts.at(-1);
  if (/^(?:\.env(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|\.npmrc|\.netrc|\.pypirc)$/.test(base)
    || /\.(?:pem|key|p12|pfx|keystore|db|sqlite3?|log|csv|tsv|parquet|zip|gz|tgz|jpg|jpeg|png|webp|gif|mp[34]|wav|pdf|woff2?|ttf|ico|wasm|map)$/.test(base)) return "private_or_binary";
  if (/\.min\.(?:js|css)$/.test(base) || /(?:^|[.-])lock(?:\.json|\.yaml)?$/.test(base)) return "generated_file";
  return "";
}

function ownerFor(filePath, manifest) {
  const owners = Object.values(manifest?.components || {}).filter((component) => component.paths.some((scope) => pathMatchesImpactScope(filePath, scope)));
  return owners.length === 1 && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(owners[0].id) ? owners[0].id : "";
}

async function snapshot(input) {
  const limits = limitsFor(input.limits);
  const deadline = Date.now() + limits.maxDurationMs;
  const commitSha = String(input.commitSha || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw failure("full_commit_required");
  const project = { key: String(input.project?.key || input.project?.id || "").trim(), repository: projectRepositoryIdentity(input.project) };
  if (!project.key || project.key.length > 160 || /[\u0000-\u001f\u007f]/.test(project.key) || !project.repository) throw failure("project_binding_required");
  if (!project.repository.startsWith("local:")) {
    try { const url = new URL(project.repository); if (url.username || url.password || url.search || url.hash) throw failure("repository_identity_unsafe"); }
    catch { throw failure("repository_identity_unsafe"); }
  }
  let repoRoot;
  try { repoRoot = await realpath(input.repoRoot || input.project?.sourceRepoPath || input.project?.repoPath || ""); } catch { throw failure("repository_missing"); }
  const runGit = (args, maxBuffer) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("duration_limit");
    return git(repoRoot, args, maxBuffer, undefined, remaining);
  };
  const top = runGit(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (await realpath(top) !== repoRoot) throw failure("repository_root_mismatch");
  if (!project.repository.startsWith("local:")) {
    const remote = normalizeRepositoryIdentity(runGit(["remote", "get-url", "origin"]).toString("utf8").trim());
    if (remote !== project.repository) throw failure("repository_identity_mismatch");
  }
  runGit(["cat-file", "-e", `${commitSha}^{commit}`]);
  const inventory = runGit(["ls-tree", "-r", "-l", "-z", commitSha]).toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, blobSha, size] = record.slice(0, tab).trim().split(/\s+/);
    return { mode, type, blobSha, size: Number(size), path: record.slice(tab + 1) };
  });
  const mapPath = input.project?.componentImpactMapPath || "docs/architecture/components.json";
  if (!safeRepositoryContextPath(mapPath)) throw failure("component_map_invalid");
  const mapEntry = inventory.find((entry) => entry.path === mapPath);
  let manifest = null;
  if (mapEntry) {
    if (!["100644", "100755"].includes(mapEntry.mode) || mapEntry.size > 1024 * 1024) throw failure("component_map_invalid");
    try { manifest = validateComponentImpactMap(JSON.parse(runGit(["cat-file", "blob", mapEntry.blobSha], 1024 * 1024 + 1).toString("utf8")), { projectKey: project.key, repository: project.repository }); }
    catch { throw failure("component_map_invalid"); }
  }
  if (input.manifest) {
    let supplied;
    try { supplied = validateComponentImpactMap(input.manifest, { projectKey: project.key, repository: project.repository }); }
    catch { throw failure("component_map_invalid"); }
    if (!manifest || sha256Digest(supplied) !== sha256Digest(manifest)) throw failure("component_map_snapshot_mismatch");
  }
  const ignoreEntry = inventory.find((entry) => entry.path === IGNORE_PATH);
  if (ignoreEntry && (!["100644", "100755"].includes(ignoreEntry.mode) || ignoreEntry.size > 65536)) throw failure("context_ignore_invalid");
  const ignoreText = ignoreEntry ? runGit(["cat-file", "blob", ignoreEntry.blobSha], 65537).toString("utf8") : "";
  const ignorePatterns = ignoreText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (ignorePatterns.length > 500 || ignorePatterns.some((pattern) => pattern.startsWith("!") || !safeRepositoryContextPath(pattern.replaceAll("*", "x").replace(/\/$/, "")))) throw failure("context_ignore_invalid");
  const binding = { schemaVersion: REPOSITORY_CONTEXT_SCHEMA_VERSION, project, commitSha, mapDigest: sha256Digest(manifest || null),
    extractorVersion: REPOSITORY_CONTEXT_EXTRACTOR_VERSION, ignoreDigest: sha256Digest({ version: POLICY_VERSION, patterns: ignorePatterns }), limits };
  return { repoRoot, manifest, inventory, ignorePatterns, binding, limits, deadline };
}

function resolveImport(file, imported, eligiblePaths) {
  const specifier = imported.specifier;
  if (!specifier) return imported;
  let candidates = [];
  if (["javascript", "typescript", "tsx", "php"].includes(file.language) && specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
    candidates = [base];
    if (file.language !== "php") {
      const stem = base.replace(/\.(?:m?js|cjs)$/, "");
      if (stem !== base) candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((suffix) => stem + suffix));
      candidates.push(...[".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", "/index.js", "/index.ts", "/index.tsx"].map((suffix) => base + suffix));
    }
  } else if (file.language === "python") {
    const prefix = specifier.match(/^\.+/)?.[0] || "";
    let root = prefix ? path.posix.dirname(file.path) : "";
    if (prefix.length > root.split("/").filter((part) => part && part !== ".").length + 1) return imported;
    for (let i = 1; i < prefix.length; i++) root = path.posix.dirname(root);
    const modulePath = specifier.slice(prefix.length).replaceAll(".", "/");
    const base = path.posix.join(root, modulePath);
    candidates = [base + ".py", path.posix.join(base, "__init__.py")];
  }
  const matches = [...new Set(candidates.filter((candidate) => safeRepositoryContextPath(candidate) && eligiblePaths.has(candidate)))];
  // Ambiguous extension/alias resolution is advisory unknown, never a guessed edge.
  return matches.length === 1 ? { ...imported, target: matches[0], resolved: true } : imported;
}

async function buildSnapshot(context) {
  const { binding, limits, inventory, manifest, repoRoot, ignorePatterns, deadline } = context;
  const files = [], excluded = {}, diagnostics = [];
  const toParse = [];
  let totalBytes = 0, parsedFiles = 0, pathOnlyFiles = 0;
  const count = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const diagnose = (reason, filePath) => { if (diagnostics.length < 100) diagnostics.push({ ...(filePath ? { path: filePath } : {}), reason }); };
  let incomplete = false;
  for (const entry of inventory) {
    const reason = !["100644", "100755"].includes(entry.mode) || entry.type !== "blob" ? "non_regular_file" : exclusion(entry.path);
    if (reason) { count(reason); continue; }
    if (ignorePatterns.some((pattern) => pathMatchesImpactScope(entry.path, pattern))) { count("context_ignore"); continue; }
    if (files.length >= limits.maxFiles) { count("file_limit"); incomplete = true; continue; }
    const language = repositoryContextLanguage(entry.path);
    const file = { path: entry.path, blobSha: entry.blobSha, language, owner: ownerFor(entry.path, manifest), symbols: [], imports: [] };
    files.push(file);
    if (language === "unsupported") { pathOnlyFiles++; continue; }
    if (Date.now() >= deadline) { count("duration_limit"); diagnose("duration_limit", entry.path); incomplete = true; pathOnlyFiles++; continue; }
    if (entry.size > limits.maxFileBytes) { count("file_too_large"); diagnose("file_too_large", entry.path); incomplete = true; pathOnlyFiles++; continue; }
    if (totalBytes + entry.size > limits.maxTotalBytes) { count("total_byte_limit"); diagnose("total_byte_limit", entry.path); incomplete = true; pathOnlyFiles++; continue; }
    totalBytes += entry.size;
    toParse.push({ entry, file });
  }
  let batch = Buffer.alloc(0);
  if (toParse.length && Date.now() < deadline) {
    batch = git(repoRoot, ["cat-file", "--batch"], totalBytes + toParse.length * 128 + 1024,
      toParse.map(({ entry }) => entry.blobSha).join("\n") + "\n", Math.max(1, deadline - Date.now()));
  }
  let offset = 0;
  const binaryPaths = new Set();
  for (const { entry, file } of toParse) {
    if (Date.now() >= deadline || !batch.length) { count("duration_limit"); diagnose("duration_limit", entry.path); incomplete = true; pathOnlyFiles++; continue; }
    const end = batch.indexOf(10, offset);
    if (end < 0 || batch.subarray(offset, end).toString("utf8") !== `${entry.blobSha} blob ${entry.size}`) throw failure("git_blob_batch_invalid");
    const bytes = batch.subarray(end + 1, end + 1 + entry.size);
    offset = end + 1 + entry.size + 1;
    if (bytes.length !== entry.size || batch[offset - 1] !== 10) throw failure("git_blob_batch_invalid");
    if (bytes.includes(0)) { count("binary_file"); binaryPaths.add(entry.path); continue; }
    const extracted = await extractRepositoryContext(bytes.toString("utf8"), file.language,
      { ...limits, parseTimeoutMs: Math.max(1, Math.min(limits.parseTimeoutMs, deadline - Date.now())) });
    file.symbols = extracted.symbols;
    file.imports = extracted.imports;
    parsedFiles++;
    if (extracted.diagnostics.length) incomplete = true;
    for (const reasonCode of extracted.diagnostics) {
      diagnose(reasonCode, entry.path);
      // Retain transient counts even when the bounded diagnostic list is full.
      if (TRANSIENT_REASONS.has(reasonCode)) count(reasonCode);
    }
  }
  const eligibleFiles = files.filter((file) => !binaryPaths.has(file.path));
  const eligiblePaths = new Set(eligibleFiles.map((file) => file.path));
  for (const file of eligibleFiles) file.imports = file.imports.map((item) => resolveImport(file, item, eligiblePaths));
  const coverage = { complete: !incomplete && pathOnlyFiles === 0, partial: incomplete || pathOnlyFiles > 0, filesSeen: inventory.length,
    filesIndexed: eligibleFiles.length, parsedFiles, pathOnlyFiles, unresolvedImports: eligibleFiles.reduce((sum, file) => sum + file.imports.filter((item) => !item.resolved).length, 0),
    excluded, diagnostics };
  const result = { ...binding, files: eligibleFiles, coverage };
  return { ...result, digest: sha256Digest(result), cacheHit: false };
}

export async function buildRepositoryContextIndex(input) { return buildSnapshot(await snapshot(input)); }

async function secureDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("cache_path_unsafe"); }
    catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(current, { mode: 0o700 }); }
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.chmod(0o700); } finally { await handle.close(); }
  return absolute;
}

function validCache(value, context) {
  const { binding, inventory, manifest, ignorePatterns } = context;
  const snapshotFiles = new Map(inventory.map((entry) => [entry.path, entry]));
  if (!value || typeof value !== "object" || transientIncomplete(value)) return false;
  const { digest, cacheHit, ...material } = value;
  if (digest !== sha256Digest(material) || cacheHit !== false) return false;
  if (Object.keys(material).sort().join() !== [...Object.keys(binding), "files", "coverage"].sort().join()) return false;
  for (const key of Object.keys(binding)) if (sha256Digest(material[key]) !== sha256Digest(binding[key])) return false;
  if (!Array.isArray(value.files) || value.files.length > binding.limits.maxFiles) return false;
  const seen = new Set();
  for (const file of value.files) {
    const entry = snapshotFiles.get(file.path);
    if (Object.keys(file).sort().join() !== ["path", "blobSha", "language", "owner", "symbols", "imports"].sort().join()
      || !safeRepositoryContextPath(file.path) || exclusion(file.path) || seen.has(file.path) || !/^[a-f0-9]{40}$/.test(file.blobSha)
      || file.language !== repositoryContextLanguage(file.path) || file.owner !== ownerFor(file.path, manifest)
      || !entry || !["100644", "100755"].includes(entry.mode) || entry.blobSha !== file.blobSha
      || ignorePatterns.some((pattern) => pathMatchesImpactScope(file.path, pattern))) return false;
    seen.add(file.path);
    if (!Array.isArray(file.symbols) || file.symbols.length > binding.limits.maxSymbolsPerFile || !Array.isArray(file.imports) || file.imports.length > binding.limits.maxImportsPerFile) return false;
    for (const symbol of file.symbols) if (Object.keys(symbol).sort().join() !== "kind,line,name" || !safeContextIdentifier(symbol.name)
      || !["function", "class", "interface", "type", "enum", "trait", "method", "variable"].includes(symbol.kind) || !Number.isSafeInteger(symbol.line) || symbol.line < 1 || symbol.line > entry.size + 1) return false;
    for (const item of file.imports) if (Object.keys(item).some((key) => !["specifier", "target", "line", "resolved"].includes(key))
      || item.specifier !== undefined && !safeContextSpecifier(item.specifier) || item.target !== undefined && !safeRepositoryContextPath(item.target)
      || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > entry.size + 1 || typeof item.resolved !== "boolean" || item.resolved !== Boolean(item.target)) return false;
  }
  for (const file of value.files) for (const item of file.imports) if (item.target && !seen.has(item.target)) return false;
  const coverage = value.coverage;
  if (!coverage || Object.keys(coverage).sort().join() !== ["complete", "partial", "filesSeen", "filesIndexed", "parsedFiles", "pathOnlyFiles", "unresolvedImports", "excluded", "diagnostics"].sort().join()
    || typeof coverage.complete !== "boolean" || typeof coverage.partial !== "boolean" || coverage.complete === coverage.partial
    || ![coverage.filesSeen, coverage.filesIndexed, coverage.parsedFiles, coverage.pathOnlyFiles, coverage.unresolvedImports].every((value) => Number.isSafeInteger(value) && value >= 0)
    || coverage.filesIndexed !== value.files.length || !coverage.excluded || typeof coverage.excluded !== "object" || !Array.isArray(coverage.diagnostics) || coverage.diagnostics.length > 100) return false;
  if (Object.entries(coverage.excluded).some(([key, count]) => !["unsafe_path", "private_or_generated", "private_or_binary", "generated_file", "non_regular_file", "context_ignore", ...DIAGNOSTIC_REASONS].includes(key) || !Number.isSafeInteger(count) || count < 0)) return false;
  return coverage.diagnostics.every((item) => Object.keys(item).every((key) => ["path", "reason"].includes(key)) && DIAGNOSTIC_REASONS.has(item.reason) && (item.path === undefined || safeRepositoryContextPath(item.path)));
}

/** Cache is disposable metadata: invalid reads rebuild; cache filesystem errors do not block indexing. */
export async function loadOrBuildRepositoryContextIndex(input) {
  const context = await snapshot(input);
  let cachePath;
  try {
    const cacheRoot = await secureDirectory(input.cacheRoot || path.join(studioOpsHome(), "cache", "repository-context"));
    const partition = sha256Digest(context.binding.project).slice(7);
    const directory = await secureDirectory(path.join(cacheRoot, partition));
    cachePath = path.join(directory, `${sha256Digest(context.binding).slice(7)}.json`);
    let handle;
    try {
      handle = await open(cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES || (stat.mode & 0o077) !== 0) throw failure("cache_file_unsafe");
      const cached = JSON.parse(await handle.readFile("utf8"));
      if (validCache(cached, context)) return { ...cached, cacheHit: true };
    } catch { /* Missing, corrupt or unsafe entries cannot provide context. */ }
    finally { await handle?.close(); }
  } catch { cachePath = ""; }
  const built = await buildSnapshot(context);
  if (cachePath && !transientIncomplete(built)) {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(built);
      if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) return built;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized); } finally { await handle.close(); }
      await rename(temporary, cachePath);
    } catch { /* Advisory availability does not depend on writable cache storage. */ }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return built;
}
