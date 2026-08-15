import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityRoutingForTask,
  candidateIdentityIsComplete,
  normalizeDeliveryPolicy,
} from "../src/store.js";
import { createSupervisorReport } from "../src/supervisor.js";

test("delivery policy fails closed and never enables merge or deployment", () => {
  assert.equal(normalizeDeliveryPolicy({ profile: "ambiguous" }).profile, "standard");
  assert.deepEqual(
    normalizeDeliveryPolicy({ profile: "prototype-fast-lane" }),
    {
      profile: "prototype-fast-lane",
      automaticMerge: false,
      automaticDeployment: false,
      architectureRequiredForBroadProducts: true,
      primaryLeadRequired: true,
      humanProductionReleaseRequired: true,
    },
  );
});

test("prototype UI impact skips backend but retains accessibility and lead", () => {
  const routing = capabilityRoutingForTask(
    { deliveryPolicy: { profile: "prototype-fast-lane" } },
    { reviewSubjectSha: "a".repeat(40), reviewSubjectCycle: 2, impactEvidence: { changedFiles: ["src/App.jsx"] } },
  );
  assert.deepEqual(routing.required, ["frontend", "accessibility", "lead"]);
  assert.equal(routing.skipped[0].stageKey, "backend");
  assert.equal(routing.skipped[0].candidateCycle, 2);
  assert.equal(routing.skipped[0].subjectSha, "a".repeat(40));
});

test("unknown impact fails closed to backend and all specialist lanes", () => {
  const routing = capabilityRoutingForTask({ deliveryPolicy: { profile: "prototype-fast-lane" } }, {});
  assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
  assert.equal(routing.evidence.unknown, true);
});

test("stale or conflicting impact evidence fails closed to every specialist lane", () => {
  for (const flag of ["stale", "conflicting"]) {
    const routing = capabilityRoutingForTask(
      { deliveryPolicy: { profile: "prototype-fast-lane" } },
      { impactEvidence: { changedFiles: ["src/App.jsx"], [flag]: true } },
    );
    assert.deepEqual(routing.required, ["backend", "frontend", "accessibility", "lead"]);
  }
});

test("explicit local mode requires a verified candidate while GitHub requires an exact subject", () => {
  const base = {
    id: "task_1", projectId: "project_1", title: "Candidate", status: "builder_review",
    branchName: "feature/candidate", reviewCycle: 1, reviewSubjectCycle: 1,
  };
  const local = createSupervisorReport({
    projects: [{ id: "project_1", workflowMode: "local", reviewPipeline: [] }],
    tasks: [base], reviews: [], events: [], comments: [],
  });
  assert.equal(local.actions[0].type, "return_to_builder");

  const github = createSupervisorReport({
    projects: [{ id: "project_1", workflowMode: "github", reviewPipeline: [] }],
    tasks: [{ ...base, prUrl: "https://github.com/example/repo/pull/1" }], reviews: [], events: [], comments: [],
  });
  assert.equal(github.actions[0].type, "return_to_builder");
});

test("candidate identity requires immutable repository coordinates", () => {
  const complete = { commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/x", candidateCycle: 1 };
  assert.equal(candidateIdentityIsComplete(complete), true);
  assert.equal(candidateIdentityIsComplete({ ...complete, treeSha: "" }), false);
});
