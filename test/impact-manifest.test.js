import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildExactShaEvidence,
  assertExactShaEvidenceEnvironment,
  classifyChangedPaths,
  normalizeExactShaEvidence,
  ownershipManifestDigest,
  parseGitNameStatus,
  validateDependencyEdges,
  validateOwnershipManifest,
  validateRepositoryDependencies,
  validateSurfaceCoverage,
  validateTrackedSurfaceCoverage,
  verifyExactShaEvidenceAgainstGit,
} from "../src/impact-manifest.js";

const execFileAsync = promisify(execFile);

const manifest = validateOwnershipManifest(JSON.parse(await readFile("config/component-ownership.json", "utf8")));

test("classified paths emit deterministic ownership and the manifest digest", () => {
  const result = classifyChangedPaths(manifest, ["public/app.js"]);
  assert.deepEqual(result.changedPaths, ["public/app.js"]);
  assert.deepEqual(result.directComponents, ["browser-ui"]);
  assert.deepEqual(result.affectedComponents, ["browser-ui"]);
  assert.equal(result.unknown, false);
  assert.equal(result.shared, false);
  assert.equal(result.fullRegression, false);
  assert.deepEqual(result.fullRegressionReasons, []);
  assert.equal(result.manifestDigest, ownershipManifestDigest(manifest));
});

test("transitive impact walks every dependent edge", () => {
  const result = classifyChangedPaths(manifest, ["src/state-database.js"]);
  assert.deepEqual(result.directComponents, ["control-plane-core"]);
  assert.deepEqual(result.affectedComponents, [
    "automation-runtime",
    "browser-ui",
    "control-plane-core",
    "entry-adapters",
    "packaging-release",
    "qa-release",
  ]);
  assert.equal(result.fullRegression, true);
  assert.ok(result.fullRegressionReasons.includes("multi_component"));
});

test("unknown and stale evidence fail closed to full regression", () => {
  const unknown = classifyChangedPaths(manifest, ["unowned/new-surface.js"]);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.fullRegression, true);
  assert.deepEqual(unknown.fullRegressionReasons, ["unknown_path"]);

  const stale = classifyChangedPaths(manifest, ["public/app.js"], {
    expectedManifestDigest: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(stale.fullRegression, true);
  assert.ok(stale.fullRegressionReasons.includes("stale_manifest"));

  const missing = classifyChangedPaths(manifest, ["public/app.js"], {
    requireExpectedManifestDigest: true,
  });
  assert.ok(missing.fullRegressionReasons.includes("missing_manifest_binding"));

  const malformed = classifyChangedPaths({ schemaVersion: "broken" }, ["src/store.js"]);
  assert.equal(malformed.fullRegression, true);
  assert.deepEqual(malformed.fullRegressionReasons, ["malformed_manifest"]);
});

test("shared and ambiguous surfaces fail closed", () => {
  const shared = classifyChangedPaths(manifest, ["config/component-ownership.json"]);
  assert.equal(shared.shared, true);
  assert.ok(shared.fullRegressionReasons.includes("shared_surface"));

  const ambiguousManifest = structuredClone(manifest);
  ambiguousManifest.components["browser-ui"].paths.push("src/store.js");
  const ambiguous = classifyChangedPaths(ambiguousManifest, ["src/store.js"]);
  assert.equal(ambiguous.ambiguous, true);
  assert.ok(ambiguous.fullRegressionReasons.includes("ambiguous_ownership"));
});

test("rename classification includes both source and destination ownership", () => {
  const changedPaths = parseGitNameStatus("R100\0src/store.js\0public/store.js\0");
  assert.deepEqual(changedPaths, ["public/store.js", "src/store.js"]);
  const result = classifyChangedPaths(manifest, changedPaths);
  assert.deepEqual(result.directComponents, ["browser-ui", "control-plane-core"]);
  assert.equal(result.multiComponent, true);
  assert.equal(result.fullRegression, true);
});

test("prohibited dependencies are executable failures", () => {
  const result = validateDependencyEdges(manifest, [
    { from: "automation-runtime", to: "control-plane-core", sourcePath: "src/runner.js", targetPath: "src/store.js" },
    { from: "control-plane-core", to: "automation-runtime", sourcePath: "src/store.js", targetPath: "src/runner.js" },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [{
    from: "control-plane-core",
    to: "automation-runtime",
    sourcePath: "src/store.js",
    targetPath: "src/runner.js",
  }]);
});

test("repository imports obey the executable component dependency direction", async () => {
  const result = await validateRepositoryDependencies(process.cwd(), manifest);
  assert.deepEqual(result.unclassified, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test("repository dependency validation rejects prohibited side-effect imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-side-effect-import-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "core.js"), "export const core = true;\n");
    await writeFile(path.join(root, "src", "adapter.js"), 'import "./core.js";\n');
    const fixtureManifest = {
      schemaVersion: "studioops.component-ownership.v1",
      fullRegressionCommands: ["npm run check"],
      environmentContract: { id: "studioops.test.v1" },
      components: {
        adapter: {
          owner: "Adapter owner",
          classification: "bounded",
          paths: ["src/adapter.js"],
          entryAdapters: [],
          workflowReleaseSurfaces: [],
          ownedTests: [],
          publicContracts: ["adapter"],
          ownedData: [],
          allowedDependencies: [],
          impactEdges: [],
          rollbackBoundary: "adapter rollback",
          testLayers: ["unit"],
          validationCommands: ["npm run check"],
        },
        core: {
          owner: "Core owner",
          classification: "bounded",
          paths: ["src/core.js"],
          entryAdapters: [],
          workflowReleaseSurfaces: [],
          ownedTests: [],
          publicContracts: ["core"],
          ownedData: [],
          allowedDependencies: [],
          impactEdges: [],
          rollbackBoundary: "core rollback",
          testLayers: ["unit"],
          validationCommands: ["npm run check"],
        },
      },
    };

    const result = await validateRepositoryDependencies(root, fixtureManifest);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, [{
      from: "adapter",
      to: "core",
      sourcePath: "src/adapter.js",
      targetPath: "src/core.js",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every tracked surface has exactly one executable owner", async () => {
  const result = await validateTrackedSurfaceCoverage(process.cwd(), manifest);
  assert.deepEqual(result.unowned, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(result.ok, true);

  const incomplete = structuredClone(manifest);
  incomplete.components["browser-ui"].paths.push("src/store.js");
  const rejected = validateSurfaceCoverage(incomplete, ["src/store.js", "unowned/release.yml"]);
  assert.deepEqual(rejected.unowned, ["unowned/release.yml"]);
  assert.deepEqual(rejected.ambiguous, [{
    path: "src/store.js",
    components: ["browser-ui", "control-plane-core"],
  }]);
  assert.equal(rejected.ok, false);
});

test("exact-SHA evidence binds classification, commands, environment, retries, skips, and artifacts", () => {
  const classification = classifyChangedPaths(manifest, ["config/component-ownership.json"]);
  const evidence = buildExactShaEvidence({
    sourceSha: "a".repeat(40),
    classification,
    commandResults: [
      { command: "npm run check", ok: true, output: "ok", durationMs: 42, retries: 1, skips: ["none"] },
      { command: "git diff --check", ok: true, output: "", durationMs: 2, retries: 0, skips: [] },
    ],
  });
  assert.equal(evidence.sourceSha, "a".repeat(40));
  assert.equal(evidence.manifestDigest, ownershipManifestDigest(manifest));
  assert.equal(evidence.commands[0].durationMs, 42);
  assert.equal(evidence.commands[0].retries, 1);
  assert.deepEqual(evidence.commands[0].skips, ["none"]);
  assert.ok(evidence.environmentContract.nodeVersion);
  assert.match(evidence.artifactDigests[0], /^sha256:/);
  assert.throws(
    () => normalizeExactShaEvidence(evidence, { sourceSha: "b".repeat(40) }),
    /different source SHA/,
  );
  assert.throws(
    () => normalizeExactShaEvidence(evidence, { manifestDigest: `sha256:${"f".repeat(64)}` }),
    /stale ownership manifest/,
  );
  assert.throws(
    () => assertExactShaEvidenceEnvironment(evidence, { platform: "different-platform" }),
    /environment mismatch/,
  );
  assert.throws(
    () => normalizeExactShaEvidence({
      ...evidence,
      selectedComponents: evidence.selectedComponents.slice(1),
    }),
    /selected components do not match/,
  );
  assert.throws(
    () => normalizeExactShaEvidence({
      ...evidence,
      commands: evidence.commands.map((command) => ({ ...command, command: "true" })),
    }),
    /missing required command/,
  );
  assert.throws(
    () => normalizeExactShaEvidence({
      ...evidence,
      affectedComponents: ["browser-ui"],
    }),
    /affected components do not match/,
  );
});

test("task evidence is verified against the manifest and diff stored at its exact Git SHA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-impact-evidence-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "studioops-test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "StudioOps Test"], { cwd: root });
    await mkdir(path.join(root, "config"), { recursive: true });
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(path.join(root, "config", "component-ownership.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(root, "public", "app.js"), "export const version = 1;\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const baseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    await writeFile(path.join(root, "public", "app.js"), "export const version = 2;\n");
    await execFileAsync("git", ["commit", "-am", "candidate"], { cwd: root });
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const treeSha = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
    const classification = classifyChangedPaths(manifest, ["public/app.js"]);
    const evidence = buildExactShaEvidence({
      sourceSha: headSha,
      classification,
      commandResults: [{ command: "npm run check", ok: true, output: "passed", durationMs: 1 }],
    });

    const verified = await verifyExactShaEvidenceAgainstGit(root, baseSha, headSha, evidence, {
      expectedTreeSha: treeSha,
    });
    assert.equal(verified.sourceSha, headSha);
    assert.equal(verified.treeSha, treeSha);
    await assert.rejects(
      () => verifyExactShaEvidenceAgainstGit(root, baseSha, "f".repeat(40), evidence),
      /different source SHA/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
