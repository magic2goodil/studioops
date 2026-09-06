import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { hostedRcFixture } from "./hosted-rc-evidence.test.js";
import { hostedRcDigest } from "../src/hosted-rc-evidence.js";
import { evaluateReleaseQualification, normalizeReleaseQualification, releaseQualificationInputs } from "../src/release-qualification.js";

test("valid immutable receipt is distinct from owner packet qualification inputs", () => {
  const f = hostedRcFixture(); const result = evaluateReleaseQualification(f.input, f.context);
  assert.equal(result.eligible, true);
  assert.deepEqual(normalizeReleaseQualification(result.qualification), result.qualification);
  assert.equal(result.qualification.inputsDigest, hostedRcDigest(releaseQualificationInputs({ binding: f.context.binding,
    evidenceDigest: hostedRcDigest(f.input.evidence), policyDigest: f.input.evidence.policyDigest,
    revocationGeneration: 0, reviews: f.context.currentReviews })));
  assert.notEqual(hostedRcDigest(result.qualification), result.qualification.inputsDigest);
});
const invalidCases = [
  ["missing", "evidence_missing", (f) => { f.input.evidence = null; }, false],
  ["project", "project_mismatch", (f) => { f.input.evidence.binding.projectId = "other"; }],
  ["repository", "repository_mismatch", (f) => { f.input.evidence.binding.repository = "https://github.com/other/project"; }],
  ["source", "source_mismatch", (f) => { f.input.evidence.binding.sourceSha = "d".repeat(40); }],
  ["integration", "source_mismatch", (f) => { f.input.evidence.binding.integrationSha = "d".repeat(40); }],
  ["artifact", "artifact_mismatch", (f) => { f.input.evidence.binding.artifactDigest = f.digest("wrong"); }],
  ["provenance", "artifact_mismatch", (f) => { f.input.evidence.binding.provenanceDigest = f.digest("wrong"); }],
  ["candidate", "candidate_mismatch", (f) => { f.input.evidence.binding.candidateId = "other"; }],
  ["deployment", "deployment_mismatch", (f) => { f.input.evidence.environment.deploymentId = "other"; }],
  ["production origin", "deployment_mismatch", (f) => { f.context.productionOrigins = [f.input.evidence.environment.origin]; }],
  ["runtime", "runtime_mismatch", (f) => { f.input.evidence.environment.runtime.runtimeDigest = f.digest("wrong"); }],
  ["snapshot", "snapshot_mismatch", (f) => { f.input.evidence.snapshot.fingerprint = f.digest("wrong"); }],
  ["snapshot authorization", "snapshot_mismatch", (f) => { f.input.evidence.snapshot.authorizationId = "other"; }],
  ["snapshot age", "snapshot_stale", (f) => { f.input.evidence.snapshot.createdAt = "2026-09-01T01:00:00.000Z"; }],
  ["expiry", "evidence_stale", (f) => { f.context.now = "2026-09-08T02:00:00.000Z"; }],
  ["observation age", "observation_stale", (f) => { f.context.now = "2026-09-06T02:10:00.000Z"; }],
  ["isolation", "unsafe_isolation", (f) => { f.input.evidence.isolation.payments.mode = "unsafe"; }],
  ["copied sessions", "unsafe_isolation", (f) => { f.input.evidence.isolation.sessions.mode = "sandbox"; }],
  ["migration", "migration_failed", (f) => { f.input.evidence.migration.result = "failed"; }],
  ["device", "device_missing", (f) => { f.input.evidence.scenarios = []; }],
  ["physical device", "device_missing", (f) => { f.input.evidence.scenarios[0].deviceKind = "simulated"; }],
  ["normal auth", "scenario_failed", (f) => { f.input.evidence.scenarios[0].authentication = "test_bypass"; }],
  ["unknown applicability", "applicability_unknown", (f) => { f.context.policy.applicability = "unknown"; }],
  ["native omission", "native_backend_mismatch", (f) => { f.context.policy.applicability = "native"; }],
  ["policy signature", "untrusted_policy", (f) => { f.context.policyKeys = {}; }],
  ["owner omission", "owner_decision_missing", (f) => { f.context.decision = null; }, false],
  ["revocation", "revoked", (f) => { f.context.revocationGeneration = 1; }, false],
  ["review cycle", "review_changed", (f) => { f.context.reviewSubjects[0].cycle = 2; }],
  ["revoked review", "review_changed", (f) => { f.context.currentReviews[0].outcome = "revoked"; }, false],
  ["self review", "review_changed", (f) => { f.context.currentReviews[0].actorId = "build-adapter"; }],
];
for (const [name, reason, mutate, seal = true] of invalidCases) test(`qualification blocks ${name}`, () => {
  const f = hostedRcFixture();
  // Detach context binding/runtime from evidence so a test mutation cannot change its trust anchor.
  f.context.binding = structuredClone(f.context.binding); f.context.policy = structuredClone(f.context.policy);
  mutate(f); if (seal) f.seal();
  const result = evaluateReleaseQualification(f.input, f.context);
  assert.equal(result.eligible, false); assert.equal(result.reasons[0], reason);
});
test("native backend and distribution are exact; private origins need reviewed policy", () => {
  const f = hostedRcFixture(); f.context.policy.applicability = "native";
  f.input.evidence.native = { distributionId: "controlled-distribution", buildDigest: f.context.nativeBuildDigest,
    backendOrigin: f.input.evidence.environment.origin, backendArtifactDigest: f.input.evidence.binding.artifactDigest };
  f.seal(); assert.equal(evaluateReleaseQualification(f.input, f.context).eligible, true);
  f.input.evidence.native.backendArtifactDigest = f.digest("other"); f.seal();
  assert.equal(evaluateReleaseQualification(f.input, f.context).reasons[0], "native_backend_mismatch");
});
test("pure qualification remains below 100ms on bounded signed fixtures", (t) => {
  const f = hostedRcFixture();
  const start = performance.now();
  for (let i = 0; i < 30; i++) assert.equal(evaluateReleaseQualification(f.input, f.context).eligible, true);
  const averageMs = (performance.now() - start) / 30;
  t.diagnostic(JSON.stringify({ iterations: 30, averageMs, envelopeBytes: Buffer.byteLength(JSON.stringify(f.input.evidence)) }));
  assert.ok(averageMs < 100);
});

test("policy/device/decision changes cannot be waived by general flags or prior approval", () => {
  const f = hostedRcFixture();
  f.input.evidence.policyDigest = f.digest("other-policy");
  assert.equal(evaluateReleaseQualification({ ...f.input, force: true, approved: true }, f.context).reasons[0], "policy_mismatch");
  const g = hostedRcFixture();
  g.context.decision.payload.ownerPacketDigest = g.digest("other-packet");
  g.context.decision.proof = g.proof("decision", g.context.decision.payload, "owner");
  assert.equal(evaluateReleaseQualification(g.input, g.context).reasons[0], "owner_decision_missing");
});
test("observation binds actual controls and rejects unapproved private destinations", () => {
  const f = hostedRcFixture();
  f.context.observation.payload.resolvedAddressClass = "private";
  f.context.observation.proof = f.proof("observation", f.context.observation.payload, "observer");
  assert.equal(evaluateReleaseQualification(f.input, f.context).reasons[0], "deployment_mismatch");
  f.context.policy.allowedPrivateOrigins = [f.input.evidence.environment.origin]; f.seal();
  f.context.observation.payload.resolvedAddressClass = "private";
  f.context.observation.proof = f.proof("observation", f.context.observation.payload, "observer");
  assert.equal(evaluateReleaseQualification(f.input, f.context).eligible, true);
  f.context.observation.payload.isolationDigest = f.digest("other-controls");
  f.context.observation.proof = f.proof("observation", f.context.observation.payload, "observer");
  assert.equal(evaluateReleaseQualification(f.input, f.context).reasons[0], "unsafe_isolation");
});
test("non-deployable applicability requires authenticated classification and never creates a hosted receipt", async () => {
  const { evaluateReleaseQaApplicability } = await import("../src/release-qualification.js");
  const f = hostedRcFixture();
  f.context.policy.applicability = "non_deployable";
  f.context.policy.applicabilityReview = { actorId: "release-owner", reasonId: "reviewed-documentation-only" };
  f.seal();
  const context = { ...f.context, projectId: "project_1", projectKind: "web", applicabilityReview: f.context.policy.applicabilityReview };
  assert.equal(evaluateReleaseQaApplicability(f.context.policy, context).applicable, null);
  context.projectKind = "non_deployable";
  assert.equal(evaluateReleaseQaApplicability(f.context.policy, context).applicable, false);
  assert.equal(evaluateReleaseQualification(f.input, context).eligible, false);
});

test("composed candidates retain distinct task source SHAs and review cycles", () => {
  const f = hostedRcFixture();
  f.context.reviewSubjects.push({ taskId: "task_2", subjectSha: "d".repeat(40), cycle: 2 });
  f.context.currentReviews.push(...f.context.currentReviews.map((r) => ({ ...r, id: `${r.id}_second`, taskId: "task_2", subjectSha: "d".repeat(40), cycle: 2 })));
  f.seal();
  assert.equal(evaluateReleaseQualification(f.input, f.context).eligible, true);
  f.context.currentReviews.find((r) => r.taskId === "task_2").subjectSha = "e".repeat(40);
  f.seal();
  assert.equal(evaluateReleaseQualification(f.input, f.context).reasons[0], "review_changed");
});
