import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  effectiveAutomationCapacity,
  normalizeOperationalCapabilityBlockers,
  normalizeConfig,
  normalizeStandingReleaseAuthorizationCommand,
  normalizeStandingReleaseAuthorizationGrant,
  projectFromConfig,
  standingReleaseAuthorizationState,
  writeConfig,
} from "../src/config.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);

test("missing installed automation capacity normalizes to three builders, reviewers, and runners", () => {
  const config = normalizeConfig({ defaults: {} });

  assert.equal(config.defaults.dispatcher.builderConcurrency, 3);
  assert.equal(config.defaults.dispatcher.reviewerConcurrency, 3);
  assert.equal(config.defaults.runner.limit, 3);
  assert.deepEqual(effectiveAutomationCapacity(config), {
    builderConcurrency: 3,
    reviewerConcurrency: 3,
    runnerLimit: 3,
  });
});

test("intentional lower positive automation limits remain the effective configured capacity", () => {
  const config = normalizeConfig({
    defaults: {
      dispatcher: { builderConcurrency: 1, reviewerConcurrency: 2 },
      runner: { limit: 1 },
    },
  });

  assert.equal(config.defaults.dispatcher.builderConcurrency, 1);
  assert.equal(config.defaults.dispatcher.reviewerConcurrency, 2);
  assert.equal(config.defaults.runner.limit, 1);
  assert.deepEqual(effectiveAutomationCapacity(config), {
    builderConcurrency: 1,
    reviewerConcurrency: 2,
    runnerLimit: 1,
  });
});

test("legacy supervisor limits remain effective when dispatcher limits are missing", () => {
  const config = normalizeConfig({
    defaults: {
      supervisor: { builderConcurrency: 1, reviewerConcurrency: 2 },
    },
  });

  assert.equal(config.defaults.dispatcher.builderConcurrency, 1);
  assert.equal(config.defaults.dispatcher.reviewerConcurrency, 2);
  assert.deepEqual(effectiveAutomationCapacity(config), {
    builderConcurrency: 1,
    reviewerConcurrency: 2,
    runnerLimit: 3,
  });
});

test("top-level installed overrides determine effective capacity without rewriting defaults", () => {
  const config = normalizeConfig({
    defaults: {},
    dispatcher: { builderConcurrency: 2, reviewerConcurrency: 1 },
    runner: { maxRuns: 2 },
  });

  assert.deepEqual(effectiveAutomationCapacity(config), {
    builderConcurrency: 2,
    reviewerConcurrency: 1,
    runnerLimit: 2,
  });
});

test("installed runner entrypoint reports the default and explicit lower capacity", async () => {
  const isolated = await createHermeticTestEnvironment();
  try {
    const command = [
      path.resolve("src/mission-control-runner.js"),
      "--plan",
      "--json",
    ];
    const runPlan = () => execFileAsync(process.execPath, command, {
      cwd: process.cwd(),
      env: isolated.env,
      timeout: 30_000,
    });
    const defaultReport = JSON.parse((await runPlan()).stdout);

    assert.equal(defaultReport.limit, 3);

    await writeConfig({ defaults: { runner: { limit: 1 } } }, isolated.configRoot);
    const configuredReport = JSON.parse((await runPlan()).stdout);

    assert.equal(configuredReport.limit, 1);

    await writeConfig({ defaults: {}, runner: { maxRuns: 2 } }, isolated.configRoot);
    const legacyTopLevelReport = JSON.parse((await runPlan()).stdout);

    assert.equal(legacyTopLevelReport.limit, 2);
  } finally {
    await isolated.cleanup();
  }
});

test("project-level prototype fast lane policy survives config import", () => {
  const project = projectFromConfig({
    key: "prototype",
    name: "Prototype",
    deliveryPolicy: { profile: "prototype-fast-lane" },
  });

  assert.deepEqual(project.deliveryPolicy, { profile: "prototype-fast-lane" });
});

function validStandingReleaseGrant(overrides = {}) {
  return {
    authorizationId: "authorization_01",
    ownerActorId: "owner_actor_01",
    grantedAt: "2026-08-16T12:00:00.000Z",
    repository: "https://github.com/Example/StudioOps.git",
    targetHostname: "Release.Example.com",
    deploymentWorkflow: ".github/workflows/deploy.yml",
    environment: "production",
    artifactName: "web-dist",
    healthPath: "/healthz",
    rollbackWorkflow: ".github/workflows/rollback.yml",
    rollbackReference: "refs/tags/v1.2.2",
    ...overrides,
  };
}

test("missing standing release policy is disabled for existing and imported projects", () => {
  assert.deepEqual(standingReleaseAuthorizationState({}), {
    enabled: false,
    activeAuthorization: null,
    history: [],
  });

  const project = projectFromConfig({ key: "demo", name: "Demo" });
  assert.deepEqual(project.standingReleaseAuthorizationHistory, []);
  assert.equal(standingReleaseAuthorizationState(project).enabled, false);
});

test("standing release grants normalize exact non-sensitive release coordinates", () => {
  const grant = normalizeStandingReleaseAuthorizationGrant(validStandingReleaseGrant());

  assert.deepEqual(grant, {
    ...validStandingReleaseGrant(),
    repository: "example/studioops",
    targetHostname: "release.example.com",
    revocation: null,
  });
  assert.equal(normalizeStandingReleaseAuthorizationCommand({
    action: "grant",
    ...validStandingReleaseGrant(),
  }).grant.authorizationId, "authorization_01");
});

test("standing release grants fail closed on malformed identity and target bindings", () => {
  assert.throws(
    () => normalizeStandingReleaseAuthorizationGrant(validStandingReleaseGrant({
      ownerActorId: "owner@example.com",
    })),
    /opaque/,
  );
  assert.throws(
    () => normalizeStandingReleaseAuthorizationGrant(validStandingReleaseGrant({
      targetHostname: "https://release.example.com/",
    })),
    /hostname/,
  );
  assert.throws(
    () => normalizeStandingReleaseAuthorizationGrant(validStandingReleaseGrant({
      healthPath: "/healthz?token=secret",
    })),
    /health path/,
  );
  assert.throws(
    () => normalizeStandingReleaseAuthorizationCommand({
      action: "revoke",
      authorizationId: "authorization_01",
      revokedByActorId: "owner_actor_02",
      revokedAt: "2026-08-16T13:00:00.000Z",
      reasonCode: "free form reason",
    }),
    /reason code/,
  );
});

test("operational capability blockers are release-scoped and deduplicated", () => {
  assert.deepEqual(normalizeOperationalCapabilityBlockers([
    "standing-production-release",
    { capabilityKey: "standing-production-release" },
    { governingTaskId: "task_534" },
  ]), [
    {
      scope: "release",
      capabilityKey: "standing-production-release",
      governingTaskId: "",
    },
    {
      scope: "release",
      capabilityKey: "",
      governingTaskId: "task_534",
    },
  ]);
});

test("release governance ownership manifest is classified and acyclic", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../docs/release-governance-ownership.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.impact.classification, "full-regression");
  assert.equal(manifest.impact.requiredAggregate, "npm run check");
  const components = new Map(manifest.components.map((component) => [component.id, component]));
  assert.deepEqual([...components.keys()], [
    "release-governance",
    "release-orchestration",
    "production-release-adapter",
    "owner-assurance",
  ]);
  const ownedPaths = manifest.components.flatMap((component) => component.paths);
  assert.equal(new Set(ownedPaths).size, ownedPaths.length, "Every owned path has one component");
  for (const expectedPath of [
    "src/config.js",
    "src/store.js",
    "src/supervisor.js",
    "src/dispatcher.js",
    "src/promotion.js",
    "src/notifier.js",
    "test/config.test.js",
    "test/automation-blocker.test.js",
    "test/state-database.test.js",
    "docs/RELEASE_GOVERNANCE.md",
  ]) {
    assert.equal(ownedPaths.includes(expectedPath), true, `Unowned required path ${expectedPath}`);
  }
  for (const component of components.values()) {
    assert.equal(component.owner.length > 0, true);
    assert.equal(component.publicContracts.length > 0, true);
    assert.equal(component.ownedData.length > 0, true);
    assert.equal(component.rollbackBoundary.length > 0, true);
    assert.deepEqual(Object.keys(component.testLayers), [
      "unit",
      "contract",
      "persistence",
      "composition",
    ]);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(componentId) {
    assert.equal(components.has(componentId), true, `Unknown component ${componentId}`);
    assert.equal(visiting.has(componentId), false, `Dependency cycle at ${componentId}`);
    if (visited.has(componentId)) return;
    visiting.add(componentId);
    for (const dependency of components.get(componentId).dependsOn) visit(dependency);
    visiting.delete(componentId);
    visited.add(componentId);
  }
  for (const componentId of components.keys()) visit(componentId);
});
