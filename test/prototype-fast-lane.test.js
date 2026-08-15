import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityRoutingForTask,
  candidateIdentityIsComplete,
  normalizeDeliveryPolicy,
} from "../src/store.js";

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

test("candidate identity requires immutable repository coordinates", () => {
  const complete = { commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseSha: "c".repeat(40), branch: "feature/x", candidateCycle: 1 };
  assert.equal(candidateIdentityIsComplete(complete), true);
  assert.equal(candidateIdentityIsComplete({ ...complete, treeSha: "" }), false);
});
