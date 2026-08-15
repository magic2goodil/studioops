import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MODULAR_ARCHITECTURE_STANDARD,
  projectFromConfig,
  withDefaultProjectStandards,
} from "../src/config.js";
import {
  adoptDefaultProjectStandardsInState,
  generatePrompt,
  modularArchitectureAndValidationContract,
} from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);

function fixtureState(projectPatch = {}, taskPatch = {}) {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      validationCommands: ["npm run check"],
      standards: [MODULAR_ARCHITECTURE_STANDARD, "docs/PROJECT_POLICY.md"],
      safetyRules: ["Preserve the hardware emergency stop gate."],
      reviewPipeline: [{
        key: "regression",
        label: "Regression QA",
        role: "qa-reviewer",
        status: "regression_review",
        required: true,
        description: "Review exact-candidate regression evidence.",
      }, {
        key: "lead",
        label: "Primary Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
      }],
      reviewPolicy: {
        trustLeadApprovals: true,
        integrationBranch: "qa/demo",
      },
      ...projectPatch,
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Change checkout policy",
      description: "Update one bounded checkout rule.",
      status: "builder_review",
      type: "feature",
      branchName: "codex/demo-task_1-checkout",
      prUrl: "https://github.com/example/demo/pull/1",
      reviewSubjectSha: SUBJECT_SHA,
      reviewCycle: 1,
      acceptanceCriteria: ["Impact selection is deterministic."],
      ...taskPatch,
    }],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
  };
}

test("the bundled standard defines fail-closed component and exact-SHA policy", async () => {
  const standard = await readFile(MODULAR_ARCHITECTURE_STANDARD, "utf8");

  assert.match(standard, /deterministic\s+ownership and dependency manifest/i);
  assert.match(standard, /ambiguous paths fail\s+closed to shared\/full validation/i);
  assert.match(standard, /one stable required aggregate check/i);
  assert.match(standard, /equivalent push and pull-request copies/i);
  assert.match(standard, /exact immutable candidate SHA/i);
  assert.match(standard, /concise\s+cross-system smoke rather than repeat an unchanged full suite/i);
  assert.match(standard, /project-specific safety\s+gates always remain additive/i);
});

test("new config projects receive the required standard while preserving explicit policy", () => {
  const project = projectFromConfig({
    key: "demo",
    name: "Demo",
    standards: ["docs/PROJECT_POLICY.md"],
    safetyRules: ["Never skip device-stop validation."],
  }, {
    standards: ["standards/engineering.md"],
    safetyRules: ["Default safety rule."],
  });

  assert.deepEqual(project.standards, [
    MODULAR_ARCHITECTURE_STANDARD,
    "docs/PROJECT_POLICY.md",
  ]);
  assert.deepEqual(project.safetyRules, ["Never skip device-stop validation."]);

  const inherited = projectFromConfig({ key: "inherited", name: "Inherited" }, {
    standards: ["standards/engineering.md"],
  });
  assert.deepEqual(inherited.standards, [
    MODULAR_ARCHITECTURE_STANDARD,
    "standards/engineering.md",
  ]);
  assert.deepEqual(
    withDefaultProjectStandards([MODULAR_ARCHITECTURE_STANDARD, MODULAR_ARCHITECTURE_STANDARD]),
    [MODULAR_ARCHITECTURE_STANDARD],
  );
});

test("existing project adoption is idempotent and preserves standards and safety rules", () => {
  const state = fixtureState({
    standards: ["docs/PROJECT_POLICY.md"],
    safetyRules: ["Never skip device-stop validation."],
  });
  const safetyRules = structuredClone(state.projects[0].safetyRules);
  const first = adoptDefaultProjectStandardsInState(state, "demo", {
    now: "2026-08-15T00:00:00.000Z",
  });
  const second = adoptDefaultProjectStandardsInState(state, "project_1", {
    now: "2026-08-15T00:01:00.000Z",
  });

  assert.equal(first.changed, true);
  assert.deepEqual(first.added, [MODULAR_ARCHITECTURE_STANDARD]);
  assert.deepEqual(state.projects[0].standards, [
    MODULAR_ARCHITECTURE_STANDARD,
    "docs/PROJECT_POLICY.md",
  ]);
  assert.deepEqual(state.projects[0].safetyRules, safetyRules);
  assert.equal(second.changed, false);
  assert.equal(state.events.length, 1);
});

test("builder and architect prompts carry bounded ownership and fail-closed selection", () => {
  const state = fixtureState();
  const builder = generatePrompt(state, "task_1", "builder");
  const architect = generatePrompt(state, "task_1", "systems-architect");

  assert.match(builder, /status task_1 --status builder_review --subject-sha <full-head-sha>/);

  for (const prompt of [builder, architect]) {
    assert.match(prompt, /owning component|component(?:'s|, identify its) owner/i);
    assert.match(prompt, /public contracts/i);
    assert.match(prompt, /owned data/i);
    assert.match(prompt, /dependency direction/i);
    assert.match(prompt, /rollback.*boundary/i);
    assert.match(prompt, /owned.*test layers/i);
    assert.match(prompt, /full regression for .*ambiguous/i);
    assert.match(prompt, /one stable required aggregate check/i);
    assert.match(prompt, /equivalent push and pull-request validation/i);
    assert.match(prompt, /project-specific.*safety/i);
  }
  assert.match(architect, /duplicate-workflow-count.*budgets/i);
  assert.match(builder, /transitively affected components/i);
});

test("review and QA prompts reject modularity violations and require exact evidence", () => {
  const state = fixtureState();
  const lead = generatePrompt(state, "task_1", "lead-reviewer");
  const qa = generatePrompt(state, "task_1", "qa-reviewer");

  for (const prompt of [lead, qa]) {
    assert.match(prompt, /Reject god modules/i);
    assert.match(prompt, /duplicated policy/i);
    assert.match(prompt, /cross-component internal imports/i);
    assert.match(prompt, /dependency cycles/i);
    assert.match(prompt, /unowned release surfaces/i);
    assert.match(prompt, /unjustified microservice or database proliferation/i);
    assert.match(prompt, /exact-SHA evidence/i);
  }
  assert.match(qa, /Review exact-candidate regression evidence/i);
  assert.match(qa, /Missing, stale, cross-SHA, malformed, unsuccessful/i);
});

test("release prompts reuse valid exact-SHA QA evidence and retain safety gates", () => {
  const prompt = generatePrompt(fixtureState(), "task_1", "release-manager");

  assert.match(prompt, new RegExp(SUBJECT_SHA));
  assert.match(prompt, /reachable from the protected integration branch/i);
  assert.match(prompt, /Reuse the complete regression attestation only when/i);
  assert.match(prompt, /run only concise provenance.*cross-system smoke/i);
  assert.match(prompt, /do not repeat an unchanged full suite/i);
  assert.match(prompt, /Missing, stale, malformed, cross-SHA.*requires a new complete regression/i);
  assert.match(prompt, /Evidence reuse never authorizes production deployment/i);
  assert.match(prompt, /Preserve the hardware emergency stop gate/i);
});

test("the shared contract is deterministic and treats unclassified changes as full impact", () => {
  const contract = modularArchitectureAndValidationContract();

  assert.equal(contract, modularArchitectureAndValidationContract());
  assert.match(contract, /base\/head diff plus an executable ownership and dependency manifest/i);
  assert.match(contract, /multi-component, ambiguous, or unclassified changes/i);
  assert.match(contract, /A selected failure or cancellation fails it/i);
});
