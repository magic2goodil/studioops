import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepositoryContextIndex, loadOrBuildRepositoryContextIndex, safeRepositoryContextPath } from "../src/repository-context-index.js";
import { extractRepositoryContext } from "../src/repository-context-extractor.js";
import { sha256Digest } from "../src/component-impact-map.js";

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-context-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo"), cacheRoot = path.join(root, "cache");
  await mkdir(repoRoot);
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Context Test"); git("config", "user.email", "context-test@example.invalid");
  const put = async (file, content) => { await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true }); await writeFile(path.join(repoRoot, file), content); };
  for (const [file, content] of Object.entries(files)) await put(file, content);
  const commit = () => { git("add", "."); git("commit", "-qm", "Fixture"); return git("rev-parse", "HEAD"); };
  const commitSha = commit();
  return { root, repoRoot, cacheRoot, project: { key: "context-fixture", repoPath: repoRoot }, commitSha, put, commit, git };
}

test("WASM syntax extraction covers JS, TSX, Python and PHP without parsing comments or copying literals", async () => {
  const cases = [
    ["javascript", '// function fake() {}\nconst text = "function invented() {}";\nexport async function loadCatalog() {}\nconst adapter = () => {};\nrequire("./store.js");\nimport("https://secret.invalid/token-value");', ["text", "loadCatalog", "adapter"]],
    ["tsx", 'interface Catalog { title: string }\ntype Entry = string;\nexport function CatalogView(){ return <main/>; }', ["Catalog", "Entry", "CatalogView"]],
    ["python", 'from .helpers import send\nclass Catalog:\n    def load(self):\n        return "private literal"\n', ["Catalog", "load"]],
    ["php", '<?php use App\\Catalog; require_once "./store.php"; class Catalog { function load() {} }', ["Catalog", "load"]],
  ];
  for (const [language, source, expected] of cases) {
    const result = await extractRepositoryContext(source, language);
    assert.deepEqual(result.symbols.map((symbol) => symbol.name), expected, language);
    assert.deepEqual(result.diagnostics, [], language);
    assert.doesNotMatch(JSON.stringify(result), /private literal|secret\.invalid|token-value|invented|fake/);
  }
});

test("immutable index batches tracked blobs, resolves local imports, and ignores dirty/untracked source", async (t) => {
  const input = await fixture(t, {
    "src/main.js": 'import { loadStore } from "./store.js";\nexport function loadCatalog() { return loadStore(); }',
    "src/store.js": "export function loadStore() {}", "src/view.tsx": "export function CatalogView(){ return <main/>; }",
    "pkg/main.py": "from .helpers import send\ndef load_catalog(): pass\n", "pkg/helpers.py": "def send(): pass\n",
    "php/main.php": '<?php require_once "./store.php"; function show_catalog() {}', "php/store.php": "<?php function store() {}",
    "templates/main.twig": "private template contents",
  });
  await input.put("src/main.js", "export function dirtyOnly() {}");
  await input.put("src/untracked.js", "export function untrackedOnly() {}");
  const result = await buildRepositoryContextIndex(input);
  const main = result.files.find((file) => file.path === "src/main.js");
  assert.deepEqual(main.symbols.map((symbol) => symbol.name), ["loadCatalog"]);
  assert.equal(main.imports[0].target, "src/store.js");
  assert.equal(result.files.find((file) => file.path === "pkg/main.py").imports[0].target, "pkg/helpers.py");
  assert.equal(result.files.find((file) => file.path === "php/main.php").imports[0].target, "php/store.php");
  assert.equal(result.files.find((file) => file.path === "templates/main.twig").language, "unsupported");
  assert.equal(result.coverage.pathOnlyFiles, 1);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.mapDigest, sha256Digest(null));
  assert.equal(result.cacheHit, false);
  assert.doesNotMatch(JSON.stringify(result), /dirtyOnly|untrackedOnly|private template contents/);
  const { digest, cacheHit, ...material } = result;
  assert.equal(digest, sha256Digest(material));
  assert.equal((await buildRepositoryContextIndex(input)).digest, digest);
});

test("excludes committed secrets, binaries, generated trees, symlinks and ignore patterns", async (t) => {
  const input = await fixture(t, { "src/main.js": "export function safeName() {}", ".env.production": "PRIVATE_SENTINEL",
    "secrets/keys.js": "export function secretValue() {}", "node_modules/dependency.js": "export function vendored() {}",
    "vendor_square_backup_new/dependency.php": "<?php function vendored_backup() {}",
    "src/ignored.js": "export function ignored() {}", ".studioops-contextignore": "src/ignored.js\nextra/**\n",
    "extra/nested/code.js": "export function excluded() {}", "database.sqlite": "PRIVATE_SENTINEL", "src/binary.js": Buffer.from([0, 1, 2]),
    "src/injection`name.js": "export function misleading() {}" });
  await symlink("main.js", path.join(input.repoRoot, "src/link.js"));
  input.commitSha = input.commit();
  const result = await buildRepositoryContextIndex(input);
  assert.deepEqual(result.files.map((file) => file.path), [".studioops-contextignore", "src/main.js"]);
  assert.equal(result.coverage.excluded.context_ignore, 2);
  assert.equal(result.coverage.excluded.non_regular_file, 1);
  assert.equal(result.coverage.excluded.binary_file, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|secretValue|vendored|misleading/);
  assert.equal(safeRepositoryContextPath("../outside.js"), false);
});

test("cache is private, bound to repository/commit/limits, and corrupt entries rebuild", async (t) => {
  const input = await fixture(t, { "src/main.js": "export function loadCatalog() {}" });
  const first = await loadOrBuildRepositoryContextIndex(input);
  const second = await loadOrBuildRepositoryContextIndex(input);
  assert.equal(second.cacheHit, true);
  assert.equal(second.digest, first.digest);
  const partition = path.join(input.cacheRoot, (await readdir(input.cacheRoot))[0]);
  const cacheFile = path.join(partition, (await readdir(partition))[0]);
  assert.equal((await stat(input.cacheRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  await writeFile(cacheFile, '{"arbitrary":"PRIVATE_SENTINEL"}');
  assert.equal((await loadOrBuildRepositoryContextIndex(input)).cacheHit, false);
  assert.doesNotMatch(await readFile(cacheFile, "utf8"), /PRIVATE_SENTINEL/);
  const poisoned = JSON.parse(await readFile(cacheFile, "utf8"));
  poisoned.files[0].blobSha = "a".repeat(40);
  const { digest: ignoredDigest, cacheHit: ignoredHit, ...poisonMaterial } = poisoned;
  poisoned.digest = sha256Digest(poisonMaterial);
  await writeFile(cacheFile, JSON.stringify(poisoned));
  assert.equal((await loadOrBuildRepositoryContextIndex(input)).cacheHit, false, "rehashed stale blob metadata must be rejected");
  const limited = await loadOrBuildRepositoryContextIndex({ ...input, limits: { maxFileBytes: 5 } });
  assert.equal(limited.cacheHit, false);
  assert.equal(limited.coverage.excluded.file_too_large, 1);
  assert.equal(limited.files[0].symbols.length, 0);
  await input.put("src/main.js", "export function newer() {}");
  const newer = await loadOrBuildRepositoryContextIndex({ ...input, commitSha: input.commit() });
  assert.notEqual(newer.digest, first.digest);
  assert.equal(newer.cacheHit, false);
  assert.equal(newer.files[0].symbols[0].name, "newer");
});

test("rejects unbound identities and does not follow a cache symlink", async (t) => {
  const input = await fixture(t, { "src/main.js": "export function safeName() {}" });
  await assert.rejects(buildRepositoryContextIndex({ ...input, commitSha: "HEAD" }), { code: "full_commit_required" });
  await assert.rejects(buildRepositoryContextIndex({ ...input, project: { key: "context-fixture", repoUrl: "https://user:PRIVATE_SENTINEL@example.invalid/repo" } }), { code: "repository_identity_unsafe" });
  input.git("remote", "add", "origin", "https://github.com/example/right.git");
  await assert.rejects(buildRepositoryContextIndex({ ...input, project: { key: "context-fixture", repoUrl: "https://github.com/example/wrong" } }), { code: "repository_identity_mismatch" });
  const outside = path.join(input.root, "outside"); await mkdir(outside);
  await symlink(outside, input.cacheRoot);
  const result = await loadOrBuildRepositoryContextIndex(input);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(await readdir(outside), []);
});

test("ownership and ignore policy come only from the exact committed snapshot", async (t) => {
  const manifest = { schemaVersion: 1, project: { key: "context-fixture", repository: "local:context-fixture" }, components: {
    catalog: { owner: "catalog-team", paths: ["src"], workflows: ["catalog"], publicContracts: ["catalog lookup"],
      reviewOwners: ["backend-reviewer"], tests: ["npm run check"], rollback: "Restore previous version." },
  } };
  const input = await fixture(t, { "src/main.js": "export function catalog() {}", "docs/architecture/components.json": JSON.stringify(manifest) });
  const original = await buildRepositoryContextIndex({ ...input, manifest });
  assert.equal(original.files.find((file) => file.path === "src/main.js").owner, "catalog");
  await input.put("docs/architecture/components.json", "invalid dirty map");
  assert.equal((await buildRepositoryContextIndex(input)).mapDigest, original.mapDigest);
  const stale = structuredClone(manifest); stale.components.catalog.owner = "other-team";
  await assert.rejects(buildRepositoryContextIndex({ ...input, manifest: stale }), { code: "component_map_snapshot_mismatch" });
  await input.put("docs/architecture/components.json", JSON.stringify(manifest));
  await input.put(".studioops-contextignore", "!src/main.js\n");
  await assert.rejects(buildRepositoryContextIndex({ ...input, commitSha: input.commit() }), { code: "context_ignore_invalid" });
});

test("Git commit and blob replacement refs cannot change immutable context", async (t) => {
  const input = await fixture(t, { "src/main.js": "export function originalSymbol() {}" });
  const original = await buildRepositoryContextIndex(input);
  const originalBlob = input.git("rev-parse", `${input.commitSha}:src/main.js`);
  await input.put("src/main.js", "export function replacementSymbol() {}");
  const replacementCommit = input.commit();
  const replacementBlob = input.git("rev-parse", `${replacementCommit}:src/main.js`);
  input.git("replace", input.commitSha, replacementCommit);
  assert.equal((await buildRepositoryContextIndex(input)).digest, original.digest, "commit replacements must be ignored");
  input.git("replace", "-d", input.commitSha);
  input.git("replace", originalBlob, replacementBlob);
  assert.equal((await buildRepositoryContextIndex(input)).digest, original.digest, "blob replacements must be ignored");
});

test("transient parser timeouts are retried instead of persisting a weak index", async (t) => {
  const input = await fixture(t, { "src/large.js": "call();\n".repeat(30000) });
  const bounded = { ...input, limits: { parseTimeoutMs: 1 } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await loadOrBuildRepositoryContextIndex(bounded);
    assert.equal(result.cacheHit, false);
    assert.equal(result.coverage.partial, true);
    assert.ok(result.coverage.diagnostics.some((item) => ["parse_timeout", "extraction_limit"].includes(item.reason)));
  }
  const partitions = await readdir(input.cacheRoot);
  assert.equal(partitions.length, 1);
  assert.deepEqual(await readdir(path.join(input.cacheRoot, partitions[0])), [], "transient partial metadata must not become a persistent cache entry");
});

test("file, byte, parser and duration bounds retain explicit partial coverage", async (t) => {
  const input = await fixture(t, { "a.js": "export function first() {}", "b.js": "export function second() {}", "c.js": "function broken(" });
  const limited = await buildRepositoryContextIndex({ ...input, limits: { maxFiles: 1 } });
  assert.equal(limited.files.length, 1);
  assert.equal(limited.coverage.excluded.file_limit, 2);
  assert.equal(limited.coverage.partial, true);
  const byteLimited = await buildRepositoryContextIndex({ ...input, limits: { maxTotalBytes: 25 } });
  assert.ok(byteLimited.coverage.excluded.total_byte_limit > 0);
  const parsed = await buildRepositoryContextIndex(input);
  assert.ok(parsed.coverage.diagnostics.some((item) => item.reason === "parse_error" && item.path === "c.js"));
  await assert.rejects(buildRepositoryContextIndex({ ...input, limits: { maxDurationMs: 1 } }), (error) => ["duration_limit", "git_snapshot_unavailable"].includes(error.code));
});
