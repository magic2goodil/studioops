import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";
import { selectQaImpactValidation } from "../src/qa-impact-validation.js";

test("QA selects immutable mapped tests from protected base policy and fails closed on drift", async () => {
  const environment = await createHermeticTestEnvironment();
  const root = path.join(environment.testRoot, "repo");
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { env: environment.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "docs", "architecture"), { recursive: true });
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("remote", "add", "origin", "https://github.com/example/qa-map");
    const component = (file, command) => ({ owner: "fixture", paths: [file], tests: [{ command, layer: "unit" }], dependsOn: [], reviewOwners: ["backend-reviewer"], publicContracts: ["Internal module exports"], services: ["Fixture module"], rollback: "Revert the change." });
    const manifest = {
      schemaVersion: 1, project: { key: "qa-map", repository: "https://github.com/example/qa-map" },
      aggregateCommand: "full-check", coverageRoots: ["src"],
      releaseSensitivePaths: ["src/security.js"], prohibitedDependencies: [],
      components: { view: component("src/view.js", "view-check"), security: component("src/security.js", "security-check") },
    };
    manifest.components.security.fullRegressionPaths = ["src/security.js"];
    const mapPath = path.join(root, "docs", "architecture", "components.json");
    await writeFile(mapPath, JSON.stringify(manifest));
    await writeFile(path.join(root, "src", "view.js"), "export const value = 1;\n");
    await writeFile(path.join(root, "src", "security.js"), "export const safe = true;\n");
    git("add", "."); git("commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    const project = { id: "project_fixture", key: "qa-map", repoUrl: "https://github.com/example/qa-map", repoPath: root };
    const select = (changedFiles) => selectQaImpactValidation({ project, repoRoot: root, baseSha, commitSha: git("rev-parse", "HEAD"), changedFiles, aggregateCommands: ["full-check"] });
    await writeFile(path.join(root, "src", "view.js"), "export const value = 2;\n");
    git("add", "."); git("commit", "-m", "view update");
    assert.deepEqual(select(["src/view.js"]).commands, ["view-check"]);
    assert.equal(select(["src/view.js"]).mode, "scoped");
    assert.equal(select(["src/security.js"]).mode, "aggregate");
    assert.equal(select(["src/view.js", "src/security.js"]).mode, "aggregate");
    assert.equal(select([]).mode, "aggregate");
    // Candidate edits cannot replace the trusted command allowlist, even if the
    // new map labels itself complete and classifies the policy file as safe.
    manifest.components.view.tests = [{ command: "skip-all-checks", layer: "unit" }];
    await writeFile(mapPath, JSON.stringify(manifest));
    git("add", "."); git("commit", "-m", "change candidate test policy");
    assert.equal(select(["src/view.js"]).reason, "map_policy_changed");
    assert.deepEqual(select(["src/view.js"]).commands, ["full-check"]);
    await writeFile(path.join(root, "src", "unmapped.js"), "export const unknown = true;\n");
    git("add", "."); git("commit", "-m", "unmapped source");
    assert.equal(select(["src/unmapped.js"]).reason, "map_missing_or_drifted");
    await writeFile(mapPath, "invalid json");
    git("add", "."); git("commit", "-m", "invalid map");
    assert.equal(select(["src/view.js"]).reason, "map_validation_failed");
    assert.deepEqual(select(["src/view.js"]).commands, ["full-check"]);
  } finally {
    await environment.cleanup();
  }
});
