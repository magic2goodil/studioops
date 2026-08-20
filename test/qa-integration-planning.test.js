import assert from "node:assert/strict";
import { projectFromConfig } from "../src/config.js";
import {
  integrationBranchName,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "../src/integration-policy.js";
import {
  githubAppLocalFallbackEnabled,
  isGitHubAppPermissionError,
  planQaIntegrations,
  projectPlanHasWork,
  qaResultFingerprint,
} from "../src/qa-integration.js";
import { qaIntegrationScenarios } from "./helpers/qa-integration-scenarios.js";

const scenario = qaIntegrationScenarios(import.meta.url);

scenario("review policy Trust Leads settings override stale top-level mirrors", () => {
  const staleProject = {
    defaultBranch: "main",
    trustLeadApprovals: false,
    integrationBranch: "qa/old",
    reviewPolicy: {
      trustLeadApprovals: true,
      integrationBranch: "qa/new",
    },
  };

  assert.equal(trustLeadApprovalsEnabled(staleProject), true);
  assert.equal(integrationBranchName(staleProject), "qa/new");
  assert.equal(projectUsesTrustLeadQa(staleProject), true);

  assert.equal(trustLeadApprovalsEnabled({
    trustLeadApprovals: true,
    reviewPolicy: { trustLeadApprovals: false },
  }), false);

  const imported = projectFromConfig(
    {
      key: "demo",
      name: "Demo",
      trustLeadApprovals: true,
      integrationBranch: "qa/imported",
    },
    {
      reviewPolicy: {
        trustLeadApprovals: false,
        integrationBranch: "",
      },
    },
  );
  assert.equal(imported.reviewPolicy.trustLeadApprovals, true);
  assert.equal(imported.reviewPolicy.integrationBranch, "qa/imported");
});

scenario("QA integration skips already-ready tasks unless explicitly forced", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      qaIntegration: { syncDefaultBranchIntoIntegration: true },
      localQaPreview: { enabled: true, checkoutPath: "/tmp/demo-preview", branch: "qa/demo" },
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Ready task",
      status: "qa_review",
      integrationStatus: "ready",
      branchName: "codex/demo-task",
    }],
  };

  assert.equal(planQaIntegrations(state, { project: "demo" }).taskCount, 0);
  assert.equal(planQaIntegrations(state, { project: "demo", force: true }).taskCount, 0);
  assert.equal(planQaIntegrations(state, {
    project: "demo",
    task: "task_1",
    force: true,
  }).taskCount, 1);
});

scenario("QA integration honors retry windows for unchanged blocked work", () => {
  const nowMs = Date.parse("2026-07-22T20:00:00.000Z");
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Blocked task",
      status: "qa_review",
      integrationStatus: "conflict",
      integrationRetryNotBefore: "2026-07-22T20:15:00.000Z",
      branchName: "codex/demo-task",
    }],
  };

  const deferredPlan = planQaIntegrations(state, { project: "demo", nowMs });
  assert.equal(deferredPlan.taskCount, 0);
  assert.equal(deferredPlan.projects[0].deferredTaskCount, 1);
  assert.equal(projectPlanHasWork(deferredPlan.projects[0]), false);
  assert.equal(planQaIntegrations(state, { project: "demo", nowMs: nowMs + 16 * 60_000 }).taskCount, 1);
  assert.equal(planQaIntegrations(state, { project: "demo", nowMs, force: true }).taskCount, 1);
});

scenario("atomic QA planning cannot silently omit filtered or retry-delayed tasks", () => {
  const nowMs = Date.parse("2026-07-22T20:00:00.000Z");
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Ready task",
        status: "qa_review",
        branchName: "codex/task-1",
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Retry-delayed task",
        status: "qa_review",
        branchName: "codex/task-2",
        integrationRetryNotBefore: "2026-07-22T20:15:00.000Z",
      },
    ],
  };

  assert.throws(
    () => planQaIntegrations(state, { project: "demo", task: "task_1", nowMs }),
    /requires explicit partial-candidate authorization/,
  );
  const deferred = planQaIntegrations(state, { project: "demo", nowMs });
  assert.equal(deferred.taskCount, 0);
  assert.equal(deferred.projects[0].deferredTaskCount, 2);
  assert.equal(projectPlanHasWork(deferred.projects[0]), false);
});

scenario("project-level force does not re-integrate already-ready QA tasks", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [
      {
        id: "task_ready",
        projectId: "project_1",
        title: "Already assembled",
        status: "qa_review",
        integrationStatus: "ready",
        branchName: "codex/ready",
      },
      {
        id: "task_retry",
        projectId: "project_1",
        title: "Needs reconciliation",
        status: "qa_review",
        integrationStatus: "pr_waiting",
        branchName: "codex/retry",
      },
    ],
  };

  const projectForce = planQaIntegrations(state, { project: "demo", force: true });
  assert.deepEqual(projectForce.projects[0].tasks.map((task) => task.id), ["task_retry"]);

  const explicitForce = planQaIntegrations({
    ...state,
    tasks: [state.tasks[0]],
  }, {
    project: "demo",
    task: "task_ready",
    force: true,
  });
  assert.deepEqual(explicitForce.projects[0].tasks.map((task) => task.id), ["task_ready"]);
});

scenario("GitHub App local fallback is opt-in and limited to permission failures", () => {
  assert.equal(githubAppLocalFallbackEnabled({}), false);
  assert.equal(githubAppLocalFallbackEnabled({ githubAppFallbackToLocalAuth: true }), true);
  assert.equal(
    isGitHubAppPermissionError(new Error("GraphQL: Resource not accessible by integration")),
    true,
  );
  assert.equal(isGitHubAppPermissionError(new Error("repository validation failed")), false);
});

scenario("QA integration plans only an explicitly authorized partial candidate subset", () => {
  const state = {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      defaultBranch: "main",
      reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    }],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Independent repair",
        status: "qa_review",
        branchName: "codex/task-1",
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Deferred enhancement",
        status: "qa_review",
        branchName: "codex/task-2",
      },
    ],
    reviews: [],
  };
  const plan = planQaIntegrations(state, {
    project: "demo",
    partialTasks: "task_1",
    partialActorId: "release-owner",
    partialReasonCode: "independent_repair",
  });

  assert.deepEqual(plan.projects[0].tasks.map((task) => task.id), ["task_1"]);
  assert.deepEqual(plan.projects[0].assembly, {
    mode: "authorized_partial",
    requestedTaskIds: ["task_1", "task_2"],
    includedTaskIds: ["task_1"],
    excludedTaskIds: ["task_2"],
    authorization: {
      actorId: "release-owner",
      reasonCode: "independent_repair",
    },
  });
  assert.throws(
    () => planQaIntegrations(state, { project: "demo", partialTasks: "task_1" }),
    /partial-actor-id/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1",
      partialActorId: "owner@example.com",
      partialReasonCode: "independent_repair",
    }),
    /non-sensitive --partial-actor-id/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1",
      partialActorId: "release-owner",
      partialReasonCode: "Contains descriptive text and a path /Users/example",
    }),
    /bounded --partial-reason-code/,
  );
  assert.throws(
    () => planQaIntegrations(state, {
      project: "demo",
      partialTasks: "task_1,task_2",
      partialActorId: "release-owner",
      partialReasonCode: "not_partial",
    }),
    /must exclude at least one/,
  );
});

scenario("QA result fingerprints ignore isolated workspace names but detect material changes", () => {
  const task = { status: "validation_failed", source: "codex/demo", output: "Tests failed" };
  const first = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-one",
    output: "Failure in /tmp/qa-one",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-one/test.js\nduration_ms 123.45\nRan 10 tests in 2.2s" }],
  }, task);
  const repeated = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-two",
    output: "Failure in /tmp/qa-two",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-two/test.js\nduration_ms 987.65\nRan 10 tests in 8.8s" }],
  }, task);
  const changed = qaResultFingerprint({
    status: "validation_failed",
    integrationBranch: "qa/demo",
    workspacePath: "/tmp/qa-three",
    output: "Different assertion failed in /tmp/qa-three",
    validation: [{ command: "npm test", ok: false, output: "at /tmp/qa-three/test.js" }],
  }, task);

  assert.equal(first, repeated);
  assert.notEqual(first, changed);
});

scenario("ready QA fingerprints ignore transient push and preview transitions", () => {
  const task = { status: "ready", source: "codex/demo" };
  const first = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "abc123",
    workspacePath: "/tmp/qa-one",
    output: "To github.com:example/demo.git\n   old..abc  HEAD -> qa/demo",
    localQaPreview: {
      status: "updated",
      before: "old",
      after: "abc123",
      output: "Local QA preview updated to abc123.",
    },
    validation: [{ command: "npm test", ok: true, output: "Duration 1.23s" }],
  }, task);
  const repeated = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "abc123",
    workspacePath: "/tmp/qa-two",
    output: "Everything up-to-date",
    localQaPreview: {
      status: "current",
      before: "abc123",
      after: "abc123",
      output: "Local QA preview already current.",
    },
    validation: [{ command: "npm test", ok: true, output: "Duration 9.87s" }],
  }, task);
  const changedCommit = qaResultFingerprint({
    status: "ready",
    integrationBranch: "qa/demo",
    commit: "def456",
    localQaPreview: { status: "updated", before: "abc123", after: "def456" },
    validation: [{ command: "npm test", ok: true, output: "Duration 1.23s" }],
  }, task);

  assert.equal(first, repeated);
  assert.notEqual(first, changedCommit);
});

scenario.assertComplete();
