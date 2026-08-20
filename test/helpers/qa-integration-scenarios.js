import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

export const qaIntegrationScenarioInventory = Object.freeze({
  "qa-integration-planning.test.js": Object.freeze([
    "review policy Trust Leads settings override stale top-level mirrors",
    "QA integration skips already-ready tasks unless explicitly forced",
    "QA integration honors retry windows for unchanged blocked work",
    "atomic QA planning cannot silently omit filtered or retry-delayed tasks",
    "project-level force does not re-integrate already-ready QA tasks",
    "GitHub App local fallback is opt-in and limited to permission failures",
    "QA integration plans only an explicitly authorized partial candidate subset",
    "QA result fingerprints ignore isolated workspace names but detect material changes",
    "ready QA fingerprints ignore transient push and preview transitions",
  ]),
  "qa-integration-validation.test.js": Object.freeze([
    "validation commands use the QA integration PATH override",
    "QA integration removes repository credentials from validation environments",
    "failed validation leaves the owner checkout untouched and does not push",
    "QA integration rejects source drift before merge or candidate push",
    "successful QA integration freezes an immutable candidate at the healthy preview commit",
  ]),
  "qa-integration-workspace.test.js": Object.freeze([
    "QA integration can sync default branch changes into QA and refresh a local preview checkout",
    "QA integration preserves a distinct origin push URL in the isolated workspace",
    "QA integration refuses a repo without origin instead of pushing back into the registered repo",
    "QA integration refuses workspace roots inside the registered repo",
    "GitHub QA integration fails explicitly when app credentials are missing",
    "QA integration keeps sanitized project workspace segments inside the workspace root",
  ]),
  "qa-integration-protected-branch.test.js": Object.freeze([
    "protected QA branches use one idempotent integration PR and advance only after policy merge",
    "merged protected QA handoff validates a squash result without repushing source commits",
    "new QA tasks wait behind an existing protected integration handoff",
    "failed protected handoffs are audited and safely replaced after new source review",
    "protected QA handoff refuses changed candidate heads without force-pushing",
  ]),
});

export const qaIntegrationScenarioCount = Object.values(qaIntegrationScenarioInventory)
  .reduce((count, scenarios) => count + scenarios.length, 0);

export function qaIntegrationScenarios(moduleUrl) {
  const moduleName = path.basename(fileURLToPath(moduleUrl));
  const expected = qaIntegrationScenarioInventory[moduleName];
  assert.ok(expected, `QA integration module ${moduleName} must be present in the coverage inventory.`);
  const registered = [];

  function scenario(name, fn) {
    assert.equal(
      name,
      expected[registered.length],
      `QA integration scenario ${registered.length + 1} in ${moduleName} must match the coverage inventory.`,
    );
    registered.push(name);
    return test(name, fn);
  }

  scenario.assertComplete = () => {
    assert.deepEqual(
      registered,
      expected,
      `${moduleName} must register every inventoried QA integration scenario exactly once.`,
    );
  };
  return scenario;
}
