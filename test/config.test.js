import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  canonicalCreditPolicyConfig,
  effectiveAutomationCapacity,
  extractConfigJson,
  normalizeConfig,
  normalizeCreditPolicyConfig,
  projectFromConfig,
  renderConfigMarkdown,
  writeConfig,
} from "../src/config.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);

test("credit policy config emits the canonical versioned degraded-telemetry contract", () => {
  const config = normalizeConfig({
    defaults: {
      creditPolicy: {
        enabled: true,
        failClosedTiers: ["critical", "frontier"],
        tierBudgets: {
          critical: { estimatedCredits: 50, minRemainingPercent: 25 },
        },
      },
    },
  });
  const policy = config.defaults.creditPolicy;

  assert.equal(policy.degradedTelemetryFallback.policyVersion, 1);
  assert.equal(Object.hasOwn(policy, "failClosedTiers"), false);
  assert.equal(policy.degradedTelemetryFallback.rules.critical.mode, "fail_closed");
  assert.equal(
    policy.degradedTelemetryFallback.rules.critical.ruleId,
    "legacy-critical-fail-closed-v1",
  );
  assert.equal(policy.tierBudgets.critical.estimatedCredits, 50);
  assert.match(renderConfigMarkdown(config), /degradedTelemetryFallback/);
  assert.match(renderConfigMarkdown(config), /never model IDs/);
});

test("canonical critical fallback remains bounded and top-level overrides retain default policy values", () => {
  const defaults = normalizeCreditPolicyConfig({ enabled: true });
  const config = normalizeConfig({
    defaults: {
      creditPolicy: {
        enabled: true,
        reserveCredits: 9,
      },
    },
    creditPolicy: {
      snapshotMaxAgeMs: 30_000,
    },
  });

  assert.equal(defaults.degradedTelemetryFallback.rules.critical.mode, "bounded");
  assert.equal(defaults.degradedTelemetryFallback.rules.frontier.mode, "fail_closed");
  assert.equal(config.creditPolicy.reserveCredits, 9);
  assert.equal(config.creditPolicy.snapshotMaxAgeMs, 30_000);
  assert.equal(config.creditPolicy.degradedTelemetryFallback.rules.critical.maxAttempts, 1);
});

test("setup and tracked example configuration use canonical bounded critical defaults", async () => {
  const canonical = canonicalCreditPolicyConfig();
  const cliSource = await readFile("src/mission-control-cli.js", "utf8");
  const example = extractConfigJson(await readFile("studioops.config.example.md", "utf8"));

  assert.equal(Object.hasOwn(canonical, "failClosedTiers"), false);
  assert.equal(canonical.degradedTelemetryFallback.rules.critical.mode, "bounded");
  assert.equal(canonical.degradedTelemetryFallback.rules.frontier.mode, "fail_closed");
  assert.deepEqual(example.defaults.creditPolicy, canonical);
  assert.match(cliSource, /creditPolicy:\s*canonicalCreditPolicyConfig\(\)/);
  assert.doesNotMatch(cliSource, /failClosedTiers:\s*\["critical",\s*"frontier"\]/);
});

test("canonical missing or malformed fallback rules are preserved for fail-closed evaluation", () => {
  const policy = normalizeCreditPolicyConfig({
    enabled: true,
    degradedTelemetryFallback: {
      policyVersion: 1,
      explicitFailClosedLabels: [],
      rules: {
        critical: {
          ruleId: "invalid-critical",
          mode: "bounded",
          maxConcurrentRuns: 0,
        },
      },
    },
  });

  assert.deepEqual(Object.keys(policy.degradedTelemetryFallback.rules), ["critical"]);
  assert.equal(policy.degradedTelemetryFallback.rules.critical.maxConcurrentRuns, 0);
  assert.equal(policy.degradedTelemetryFallback.rules.critical.maxAttempts, undefined);
});

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
