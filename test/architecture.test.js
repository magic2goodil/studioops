import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSupervisorActions } from "../src/dispatcher.js";
import { resolveExecutionPolicy } from "../src/execution-policy.js";
import { claimRuns, successfulHandoffFailure } from "../src/runner.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { projectFromConfig } from "../src/config.js";
import {
  evaluateSelfPromotionEligibility,
  evaluateSelfPromotionProjectPolicy,
  normalizeOwnerRequestProvenance,
  normalizeSelfPromotionPolicy,
  SELF_PROMOTION_PROHIBITED_CAPABILITIES,
  STUDIOOPS_SELF_PROMOTION_CAPABILITIES,
} from "../src/integration-policy.js";
import {
  completeArchitectureInState,
  functionalDeliveryContract,
  generatePrompt,
  taskRequiresArchitecture,
} from "../src/store.js";

function fixtureState(taskPatch = {}) {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      contextLinks: ["README.md"],
      standards: [],
      safetyRules: [],
      validationCommands: ["npm test"],
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Build the product from this mockup",
      description: "A modern app with durable user state.",
      type: "epic",
      status: "architecture_pending",
      architectureRequired: true,
      architectureStatus: "pending",
      attachments: [{ type: "image", label: "mockup", url: "/tmp/mockup.png" }],
      acceptanceCriteria: ["The product works locally."],
      deliveryMode: "functional",
      priority: "high",
      ...taskPatch,
    }],
    runs: [],
    comments: [],
    reviews: [],
    events: [],
    qaBundles: [],
  };
}

function governedChild(taskPatch = {}) {
  return {
    id: "task_2",
    projectId: "project_1",
    title: "Implement the durable data slice",
    description: "Apply the parent architecture's persistence, API, and failure-handling constraints.",
    type: "feature",
    status: "architecture_pending",
    parentTaskId: "task_1",
    dependsOnTaskIds: [],
    userStory: "As a user, I want durable product data, so that my work survives restarts.",
    expectedOutcome: "The data slice runs locally with durable storage and bounded API behavior.",
    acceptanceCriteria: ["The core write and read path has executable integration coverage."],
    lane: "backend",
    workAreas: ["src/**", "test/**"],
    architectureRequired: true,
    architectureStatus: "pending",
    architectureParentTaskId: "task_1",
    deliveryMode: "functional",
    ...taskPatch,
  };
}

function canonicalStudioOpsProject(patch = {}) {
  const repoPath = "/Users/example/.codex/studioops/source";
  return {
    id: "project_1",
    key: "studioops",
    name: "StudioOps",
    repoPath,
    repoUrl: "https://github.com/magic2goodil/studioops.git",
    defaultBranch: "main",
    reviewPolicy: {
      selfPromotion: {
        version: 1,
        enabled: true,
        productId: "studioops",
        repositoryId: "magic2goodil/studioops",
        sourceRoot: repoPath,
        targetBranch: "main",
      },
    },
    ...patch,
  };
}

function explicitOwnerRequest(patch = {}) {
  return {
    version: 1,
    kind: "explicit_owner_request",
    ownerActorId: "owner:opaque-1234",
    requestId: "request:opaque-5678",
    projectId: "project_1",
    capabilities: [...STUDIOOPS_SELF_PROMOTION_CAPABILITIES],
    ...patch,
  };
}

test("broad epics and app mockups require architecture unless explicitly waived", () => {
  assert.equal(taskRequiresArchitecture({ type: "epic", title: "New product" }), true);
  assert.equal(taskRequiresArchitecture({
    type: "feature",
    title: "Build a new SaaS platform",
  }), true);
  assert.equal(taskRequiresArchitecture({
    type: "feature",
    title: "Build the mobile app",
    attachments: ["/tmp/mockup.png"],
  }), true);
  assert.equal(taskRequiresArchitecture({
    type: "bug",
    title: "Fix button spacing",
    attachments: ["/tmp/screenshot.png"],
  }), false);
  assert.equal(taskRequiresArchitecture({
    type: "epic",
    title: "Document an existing decision",
    architectureRequired: false,
  }), false);
});

test("StudioOps self-promotion policy is versioned, default-disabled, and canonical-identity bound", () => {
  assert.deepEqual(normalizeSelfPromotionPolicy(), {
    version: 1,
    enabled: false,
    productId: "studioops",
    repositoryId: "magic2goodil/studioops",
    sourceRoot: "",
    targetBranch: "main",
    allowedCapabilities: [...STUDIOOPS_SELF_PROMOTION_CAPABILITIES],
    prohibitedCapabilities: [...SELF_PROMOTION_PROHIBITED_CAPABILITIES],
  });
  assert.deepEqual(normalizeOwnerRequestProvenance(), {
    version: 1,
    kind: "",
    ownerActorId: "",
    requestId: "",
    projectId: "",
    capabilities: [],
    inheritedFromTaskId: "",
    inheritanceKind: "",
    inheritedAt: "",
  });
  assert.deepEqual(normalizeSelfPromotionPolicy({
    enabled: true,
    sourceRoot: "/tmp/legacy-studioops",
  }), {
    version: 0,
    enabled: true,
    productId: "",
    repositoryId: "",
    sourceRoot: "/tmp/legacy-studioops",
    targetBranch: "",
    allowedCapabilities: [...STUDIOOPS_SELF_PROMOTION_CAPABILITIES],
    prohibitedCapabilities: [...SELF_PROMOTION_PROHIBITED_CAPABILITIES],
  });
  assert.equal(evaluateSelfPromotionProjectPolicy({
    key: "studioops",
    name: "StudioOps",
  }).reason, "policy_disabled");

  const canonical = canonicalStudioOpsProject();
  assert.equal(evaluateSelfPromotionProjectPolicy(canonical).reason, "eligible");
  assert.equal(evaluateSelfPromotionProjectPolicy({
    ...canonical,
    reviewPolicy: {
      selfPromotion: {
        enabled: true,
        sourceRoot: canonical.repoPath,
      },
    },
  }).reason, "policy_version_missing");
  const importedLegacyPolicy = projectFromConfig({
    key: "studioops",
    name: "StudioOps",
    repoPath: canonical.repoPath,
    repoUrl: canonical.repoUrl,
    defaultBranch: "main",
    reviewPolicy: {
      selfPromotion: {
        enabled: true,
        sourceRoot: canonical.repoPath,
      },
    },
  });
  assert.equal(importedLegacyPolicy.reviewPolicy.selfPromotion.version, 0);
  assert.equal(importedLegacyPolicy.selfPromotionEligibility.reason, "policy_version_unsupported");
  for (const [field, reason] of [
    ["productId", "policy_product_identity_missing"],
    ["repositoryId", "policy_repository_identity_missing"],
    ["targetBranch", "policy_target_branch_missing"],
  ]) {
    const incomplete = structuredClone(canonical);
    delete incomplete.reviewPolicy.selfPromotion[field];
    assert.equal(evaluateSelfPromotionProjectPolicy(incomplete).reason, reason, field);
  }
  assert.equal(evaluateSelfPromotionProjectPolicy({
    ...canonical,
    repoUrl: "https://github.com/example/client",
  }).reason, "project_repository_identity_mismatch");
  assert.equal(evaluateSelfPromotionProjectPolicy({
    ...canonical,
    repoPath: "/tmp/spoofed-studioops",
  }).reason, "project_source_root_mismatch");
  assert.equal(evaluateSelfPromotionProjectPolicy({
    ...canonical,
    defaultBranch: "release",
  }).reason, "project_default_branch_mismatch");
});

test("self-promotion eligibility denies managed projects, spoofed keys, mixed scope, and forbidden capabilities", () => {
  const task = {
    id: "task_1",
    projectId: "project_1",
    requestProvenance: explicitOwnerRequest(),
  };
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), task).reason, "eligible");

  for (const [key, name, repoUrl] of [
    ["dollos", "DollOS", "https://github.com/example/dollos"],
    ["team-robison", "Team Robison", "https://github.com/example/team-robison"],
    ["sparkos", "SparkOS", "https://github.com/example/sparkos"],
    ["client", "Client Site", "https://github.com/example/client-site"],
    ["studioops", "Spoofed StudioOps", "https://github.com/example/not-studioops"],
  ]) {
    const project = canonicalStudioOpsProject({ key, name, repoUrl });
    assert.equal(
      evaluateSelfPromotionEligibility(project, task).reason,
      "project_repository_identity_mismatch",
      name,
    );
  }

  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    requestProvenance: explicitOwnerRequest({ projectId: "project_other" }),
  }).reason, "request_project_mismatch");
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    projectId: "project_other",
  }).reason, "task_project_mismatch");
  const { version: _legacyVersion, ...unversionedRequest } = explicitOwnerRequest();
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    requestProvenance: unversionedRequest,
  }).reason, "request_provenance_version_missing");
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    requestProvenance: explicitOwnerRequest({ ownerActorId: "github_pat_not-an-actor" }),
  }).reason, "request_owner_actor_invalid");
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    requestProvenance: explicitOwnerRequest({ capabilities: ["studioops.unknown"] }),
  }).reason, "request_scope_unknown");
  for (const capability of SELF_PROMOTION_PROHIBITED_CAPABILITIES) {
    assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
      ...task,
      requestProvenance: explicitOwnerRequest({
        capabilities: ["studioops.source_change", capability],
      }),
    }).reason, "request_scope_prohibited", capability);
  }
  assert.equal(evaluateSelfPromotionEligibility(canonicalStudioOpsProject(), {
    ...task,
    requestProvenance: undefined,
  }).reason, "request_provenance_missing");
});

test("governed architecture completion durably inherits only eligible same-project owner provenance", () => {
  const state = fixtureState({
    requestProvenance: explicitOwnerRequest(),
  });
  state.projects[0] = canonicalStudioOpsProject();
  state.tasks.push(governedChild());
  completeArchitectureInState(state, "task_1", {
    body: [
      "Keep the local modular monolith and its current SQLite JSON entity payloads.",
      "Bind the exact owner request to governed implementation children without adding services.",
    ].join(" "),
    taskIds: ["task_2"],
  });

  const child = state.tasks[1];
  assert.equal(child.requestProvenance.kind, "governed_architecture_inheritance");
  assert.equal(child.requestProvenance.inheritedFromTaskId, "task_1");
  assert.equal(child.requestProvenance.inheritanceKind, "governed_architecture_handoff");
  assert.equal(
    evaluateSelfPromotionEligibility(state.projects[0], child, { parentTask: state.tasks[0] }).reason,
    "eligible",
  );
  assert.ok(state.events.some((event) => event.type === "owner_request_provenance_inherited"));

  const deniedState = fixtureState();
  deniedState.projects[0] = canonicalStudioOpsProject();
  deniedState.tasks.push(governedChild());
  completeArchitectureInState(deniedState, "task_1", {
    body: [
      "Keep the local modular monolith and existing persistence boundaries unchanged.",
      "Stage governed children without inventing authorization that the parent does not carry.",
    ].join(" "),
    taskIds: ["task_2"],
  });
  assert.equal(deniedState.tasks[1].requestProvenance, undefined);
});

test("architecture is a durable xhigh pre-builder dispatch", async () => {
  const state = fixtureState();
  const supervisor = createSupervisorReport(state);
  assert.equal(supervisor.actions[0].type, "start_architecture");
  assert.equal(supervisor.actions[0].role, "systems-architect");

  const policy = resolveExecutionPolicy(state.tasks[0], supervisor.actions[0], {
    executionPolicy: {
      model: "another-model",
      reasoningEffort: "low",
      roles: {
        "systems-architect": {
          model: "gpt-4.1",
          reasoningEffort: "low",
        },
      },
    },
  });
  assert.equal(policy.model, "gpt-5.6-sol");
  assert.equal(policy.reasoningEffort, "xhigh");
  assert.equal(policy.selectionReason, "systems_architect_role");

  const report = await dispatchSupervisorActions(supervisor.actions, { state });
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].group, "architect");
  assert.equal(report.runs[0].role, "systems-architect");
  assert.equal(report.runs[0].model, "gpt-5.6-sol");
  assert.equal(report.runs[0].modelReasoningEffort, "xhigh");
  assert.equal(state.tasks[0].status, "architecture_pending");

  const claimed = await claimRuns({
    state,
    limit: 1,
    preflightRun: async () => ({
      ok: true,
      workflowMode: "local",
      originUrl: "",
    }),
  });
  assert.equal(claimed.length, 1);
  assert.equal(state.tasks[0].status, "architecture_in_progress");
});

test("architecture completion records the decision and unlocks governed child tasks", () => {
  const state = fixtureState();
  state.tasks.push(governedChild());
  const summary = [
    "Use a modular monolith with PostgreSQL as the source of truth.",
    "Bound reads with indexed queries and cursor pagination.",
    "Add queues or caches only when measured load demonstrates the need.",
  ].join(" ");

  const task = completeArchitectureInState(state, "task_1", {
    body: summary,
    taskIds: ["task_2"],
  });

  assert.equal(task.status, "architecture_ready");
  assert.equal(task.architectureStatus, "completed");
  assert.deepEqual(task.architectureDecisionTaskIds, ["task_2"]);
  assert.equal(state.tasks[1].status, "ready");
  assert.equal(state.tasks[1].architectureStatus, "inherited");
  assert.equal(state.tasks[1].architectureParentTaskId, "task_1");
  assert.ok(state.events.some((event) => event.type === "architecture_completed"));
});

test("governed children cannot dispatch before validated parent completion", () => {
  const state = fixtureState({ status: "architecture_in_progress" });
  state.tasks.push(governedChild({
    status: "ready",
    architectureStatus: "inherited",
  }));

  const report = createSupervisorReport(state, { includeWaiting: true });
  const childAction = report.actions.find((action) => action.taskId === "task_2");
  assert.equal(childAction.type, "waiting_on_architecture");
  assert.equal(report.actions.some((action) => (
    action.taskId === "task_2" && action.type === "start_builder"
  )), false);
});

test("approved child contracts are revalidated before supervisor and dispatch", async () => {
  const state = fixtureState();
  state.tasks.push(governedChild());
  completeArchitectureInState(state, "task_1", {
    body: [
      "Use a modular monolith with a durable relational source of truth.",
      "Bound reads with indexed queries and cursor pagination.",
      "Keep cache and queue infrastructure out until measured workload requires it.",
    ].join(" "),
    taskIds: ["task_2"],
  });
  const originalReport = createSupervisorReport(state);
  const builderAction = originalReport.actions.find((action) => action.taskId === "task_2");
  assert.equal(builderAction.type, "start_builder");

  state.tasks[1].description = "";
  const updatedReport = createSupervisorReport(state, { includeWaiting: true });
  const updatedChildAction = updatedReport.actions.find((action) => action.taskId === "task_2");
  assert.equal(updatedChildAction.type, "waiting_on_architecture");
  assert.match(updatedChildAction.reason, /approved architecture graph is no longer valid/i);
  assert.equal(updatedReport.actions.some((action) => (
    action.taskId === "task_2" && action.type === "start_builder"
  )), false);

  const dispatch = await dispatchSupervisorActions([builderAction], { state });
  assert.equal(dispatch.runs.length, 0);
  assert.equal(dispatch.skipped[0].reason, "architecture_handoff_invalid");
});

test("runner revalidates approved child contracts before claiming queued work", async () => {
  const state = fixtureState();
  state.tasks.push(governedChild());
  completeArchitectureInState(state, "task_1", {
    body: [
      "Use a modular monolith with a durable relational source of truth.",
      "Bound reads with indexed queries and cursor pagination.",
      "Keep cache and queue infrastructure out until measured workload requires it.",
    ].join(" "),
    taskIds: ["task_2"],
  });
  const supervisor = createSupervisorReport(state);
  const dispatch = await dispatchSupervisorActions(supervisor.actions, { state });
  assert.equal(dispatch.runs.length, 1);
  assert.equal(state.tasks[1].status, "queued");

  state.tasks[1].acceptanceCriteria = [];
  const claimed = await claimRuns({
    state,
    limit: 1,
    preflightRun: async () => ({
      ok: true,
      workflowMode: "local",
      originUrl: "",
    }),
  });
  assert.equal(claimed.length, 0);
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.runs[0].exitCode, "architecture_handoff_invalid");
  assert.equal(state.runs[0].startedAt, undefined);
});

test("architecture completion rejects empty, unlinked, or incomplete child graphs", () => {
  const summary = [
    "Use a modular monolith with a durable relational source of truth.",
    "Bound reads with indexed queries and cursor pagination.",
    "Keep cache and queue infrastructure out until measured workload requires it.",
  ].join(" ");
  const nonEpic = fixtureState({ type: "feature" });
  assert.throws(
    () => completeArchitectureInState(nonEpic, "task_1", { body: summary, taskIds: [] }),
    /at least one dependency-linked implementation child task/i,
  );

  const unlinked = fixtureState();
  unlinked.tasks.push(governedChild({
    parentTaskId: "",
    architectureParentTaskId: "",
  }));
  assert.throws(
    () => completeArchitectureInState(unlinked, "task_1", {
      body: summary,
      taskIds: ["task_2"],
    }),
    /must be parent-linked/i,
  );

  const incomplete = fixtureState();
  incomplete.tasks.push(governedChild({ workAreas: [] }));
  assert.throws(
    () => completeArchitectureInState(incomplete, "task_1", {
      body: summary,
      taskIds: ["task_2"],
    }),
    /missing required task contract fields: work areas/i,
  );

  const partial = fixtureState();
  partial.tasks.push(
    governedChild(),
    governedChild({ id: "task_3", title: "Implement the API slice" }),
  );
  assert.throws(
    () => completeArchitectureInState(partial, "task_1", {
      body: summary,
      taskIds: ["task_2"],
    }),
    /must record every staged child task/i,
  );

  const cyclic = fixtureState();
  cyclic.tasks.push(
    governedChild({ dependsOnTaskIds: ["task_3"] }),
    governedChild({
      id: "task_3",
      title: "Implement the API slice",
      dependsOnTaskIds: ["task_2"],
    }),
  );
  assert.throws(
    () => completeArchitectureInState(cyclic, "task_1", {
      body: summary,
      taskIds: ["task_2", "task_3"],
    }),
    /dependency graph contains a cycle/i,
  );
});

test("architect and functional-delivery prompts reject static mockup replicas", () => {
  const state = fixtureState();
  const prompt = generatePrompt(state, "task_1", "systems-architect");
  assert.match(prompt, /smallest modern architecture/i);
  assert.match(prompt, /supplied mockup, screenshot, logo/i);
  assert.match(prompt, /data ownership, durable persistence/i);
  assert.match(prompt, /dependency-linked StudioOps child tasks/i);
  assert.match(prompt, /gpt-5\.6-sol/);
  assert.match(prompt, /xhigh/);

  const contract = functionalDeliveryContract(state.tasks[0]);
  assert.match(contract, /not authorization to deliver a static replica/i);
  assert.match(contract, /Primary controls must execute real behavior/i);
  assert.match(contract, /survive refresh and process restart/i);
});

test("worker and reviewer prompts expose the effective self-promotion exception and exact limits", () => {
  const state = fixtureState({
    requestProvenance: explicitOwnerRequest(),
  });
  state.projects[0] = canonicalStudioOpsProject();
  for (const role of ["systems-architect", "builder", "backend-reviewer", "lead-reviewer"]) {
    const prompt = generatePrompt(state, "task_1", role);
    assert.match(prompt, /StudioOps self-promotion policy/);
    assert.match(prompt, /This task eligible: yes \(eligible\)/);
    assert.match(prompt, /studioops\.main_fast_forward/);
    assert.match(prompt, /managed_project\.production_release/);
    assert.match(prompt, /scope drift.*fail closed/i);
  }
});

test("runner rejects an architect exit that did not record a durable handoff", () => {
  const state = fixtureState({ status: "architecture_in_progress" });
  const run = {
    id: "run_1",
    taskId: "task_1",
    group: "architect",
    role: "systems-architect",
  };
  assert.equal(successfulHandoffFailure(state, run, state.tasks[0]), "architecture_handoff_missing");

  state.tasks.push(governedChild({
    status: "ready",
    architectureStatus: "inherited",
  }));
  state.tasks[0].architectureStatus = "completed";
  state.tasks[0].architectureDecisionTaskIds = ["task_2"];
  assert.equal(successfulHandoffFailure(state, run, state.tasks[0]), "");
});
