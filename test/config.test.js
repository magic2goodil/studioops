import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  effectiveAutomationCapacity,
  normalizeConfig,
  normalizeWorkspaceRetention,
  projectFromConfig,
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

test("workspace retention defaults and invalid values fail safe deterministically", () => {
  assert.deepEqual(normalizeConfig({ defaults: {} }).defaults.runner.workspaceRetention, {
    enabled: true,
    retainForHours: { completed: 168, failed: 336, cancelled: 168 },
    pressureMinAgeHours: 24,
    maxRetainedBytes: 53687091200,
    maxDeletesPerSweep: 25,
    sweepIntervalSeconds: 600,
    cleanupLeaseSeconds: 900,
  });
  assert.deepEqual(normalizeWorkspaceRetention({
    enabled: true,
    retainForHours: { completed: 1, failed: 2, cancelled: 3 },
    pressureMinAgeHours: 4,
    maxRetainedBytes: 5,
    maxDeletesPerSweep: 6,
    sweepIntervalSeconds: 7,
    cleanupLeaseSeconds: 8,
  }), {
    enabled: true,
    retainForHours: { completed: 1, failed: 2, cancelled: 3 },
    pressureMinAgeHours: 4,
    maxRetainedBytes: 5,
    maxDeletesPerSweep: 6,
    sweepIntervalSeconds: 7,
    cleanupLeaseSeconds: 8,
  });
  assert.equal(normalizeWorkspaceRetention({ terminalStatuses: ["running"] }).enabled, false);
  assert.equal(normalizeWorkspaceRetention({ maxRetainedBytes: -1, cleanupLeaseSeconds: Infinity }).maxRetainedBytes, 53687091200);
  assert.deepEqual(normalizeWorkspaceRetention({
    retainForHours: { completed: null, failed: " ", cancelled: true },
    pressureMinAgeHours: null,
    maxRetainedBytes: "",
    maxDeletesPerSweep: true,
    sweepIntervalSeconds: null,
    cleanupLeaseSeconds: false,
  }), {
    enabled: true,
    retainForHours: { completed: 168, failed: 336, cancelled: 168 },
    pressureMinAgeHours: 24,
    maxRetainedBytes: 53687091200,
    maxDeletesPerSweep: 25,
    sweepIntervalSeconds: 600,
    cleanupLeaseSeconds: 900,
  });
});
