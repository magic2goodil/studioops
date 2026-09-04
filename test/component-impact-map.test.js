import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ComponentMapIsolationError,
  loadProjectComponentImpactMap,
  sha256Digest,
  validateComponentImpactMap,
} from "../src/component-impact-map.js";
import {
  assertChangedFilesWithinImpactPlan,
  assertImpactPlanProjectBinding,
  formatImpactPlanForPrompt,
  pathMatchesImpactScope,
  resolveProjectImpactPlan,
} from "../src/impact-planner.js";
import { dispatchSupervisorActions } from "../src/dispatcher.js";

function manifest(key, repository, componentPath = "src/catalog.js") {
  return {
    schemaVersion: 1,
    project: { key, repository },
    aggregateCommand: "npm run check",
    fullRegressionTriggers: ["schema"],
    components: {
      catalog: {
        owner: "catalog-owner",
        aliases: ["audio catalog"],
        capabilities: ["library browsing"],
        paths: [componentPath, "test/catalog.test.js"],
        routes: ["/catalog"],
        ui: ["catalog screen"],
        services: ["catalog service"],
        data: ["catalog items"],
        tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }],
        reviewOwners: ["backend-reviewer"],
        dependsOn: [],
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
    assert.deepEqual(dollos.manifest.components.catalog.paths, ["src/dollos-catalog.js", "test/catalog.test.js"]);
    assert.deepEqual(team.manifest.components.catalog.paths, ["src/team-catalog.js", "test/catalog.test.js"]);
    assert.notEqual(dollos.digest, team.digest);
    assert.throws(() => loadProjectComponentImpactMap({
      id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos", repoPath: teamRoot,
    }), ComponentMapIsolationError);
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
  assert.match(formatImpactPlanForPrompt(plan), /Do not list or broadly search/);
});

test("unmapped, sensitive, shared, and multi-component impact fails closed", () => {
  const project = { id: "project_1", key: "dollos", repoUrl: "https://github.com/example/dollos" };
  const raw = manifest("dollos", project.repoUrl);
  raw.components.identity = {
    owner: "identity-owner",
    aliases: ["authorization"],
    paths: ["src/auth.js"],
    tests: ["node --test test/auth.test.js"],
    reviewOwners: ["security-reviewer"],
    dependsOn: [],
    shared: true,
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
    assert.deepEqual(report.runs[0].fileScope, ["src/catalog.js", "test/catalog.test.js"]);
    assert.equal(task.impactPlan.manifest.digest, report.runs[0].impactPlan.manifest.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
