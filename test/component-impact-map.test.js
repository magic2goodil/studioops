import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ComponentMapIsolationError,
  loadProjectComponentImpactMap,
  loadProjectComponentImpactMapAtCommit,
  sha256Digest,
  validateComponentImpactMap,
} from "../src/component-impact-map.js";
import {
  assertChangedFileEvidenceMatches,
  assertChangedFilesWithinImpactPlan,
  assertImpactPlanProjectBinding,
  exactCandidateChangedFiles,
  formatImpactPlanForPrompt,
  pathMatchesImpactScope,
  resolveProjectImpactPlan,
  writeBoundedDiscoveryArtifact,
} from "../src/impact-planner.js";
import { dispatchSupervisorActions } from "../src/dispatcher.js";

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
