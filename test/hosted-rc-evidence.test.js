import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import { HOSTED_RC_EVIDENCE_VERSION, HOSTED_RC_ISOLATION_CONTROLS, hostedRcDigest, hostedRcSigningBytes,
  normalizeHostedRcEvidence, normalizeHostedRcObservation } from "../src/hosted-rc-evidence.js";
import { RELEASE_QA_POLICY_VERSION, normalizeReleaseQaPolicy, normalizeReleaseDecisionObservation,
  releaseQualificationInputs, evaluateReleaseQualification } from "../src/release-qualification.js";

// Executable contract fixtures: only generated test keys, opaque identities and digest metadata.
// Consumers can import this factory without registering this file's tests a second time.
export function hostedRcFixture() {
  const digest = (label) => hostedRcDigest({ label });
  const keys = Object.fromEntries(["producer", "observer", "policy", "owner"].map((id) => [id, generateKeyPairSync("ed25519")]));
  const publicKeys = (id) => ({ [id]: keys[id].publicKey.export({ type: "spki", format: "pem" }) });
  const proof = (kind, payload, keyId) => ({ keyId, signature: sign(null, hostedRcSigningBytes(kind, payload), keys[keyId].privateKey).toString("base64") });
  const runtime = { platform: "linux", architecture: "arm64", runtimeDigest: digest("runtime"), dependencyDigest: digest("dependencies"), configSchemaDigest: digest("config-schema") };
  const policy = normalizeReleaseQaPolicy({ schemaVersion: RELEASE_QA_POLICY_VERSION, projectId: "project_1", revision: 1,
    applicability: "web", applicabilityReview: null, allowedOrigins: ["https://rc.example.invalid"], allowedPrivateOrigins: [],
    allowedDistributionIds: ["controlled-distribution"], approvedDataSourceId: "data-source", approvedSnapshotModes: ["masked_copy"],
    environmentContractDigest: digest("environment"), runtime, requiredDevices: [{ id: "desktop", kind: "physical" }],
    requiredScenarios: ["normal-login"], requiredReviewRoles: ["backend", "lead"], maxEvidenceAgeMs: 86400000,
    maxSnapshotAgeMs: 86400000, maxObservationAgeMs: 300000, isolationPolicyDigest: digest("isolation-policy") });
  const binding = { projectId: "project_1", candidateId: "candidate_1", repository: "https://github.com/example/project",
    sourceSha: "b".repeat(40), integrationSha: "c".repeat(40), manifestDigest: digest("manifest"), ownershipDigest: digest("ownership"),
    artifactDigest: digest("artifact"), provenanceDigest: digest("provenance"), fullRegressionDigest: digest("full-regression") };
  const evidence = normalizeHostedRcEvidence({ schemaVersion: HOSTED_RC_EVIDENCE_VERSION, binding, policyDigest: hostedRcDigest(policy),
    environment: { deploymentId: "deployment_1", environmentId: "rc_1", origin: "https://rc.example.invalid", contractDigest: policy.environmentContractDigest,
      runtime, differencesDigest: digest("explicit-differences") },
    snapshot: { id: "snapshot_1", fingerprint: digest("snapshot"), consistencyPoint: "transaction_1", authorizationId: "authorization_1",
      sourceId: "data-source", mode: "masked_copy", createdAt: "2026-09-06T01:00:00.000Z", restoredAt: "2026-09-06T01:15:00.000Z",
      restoreEvidenceDigest: digest("restore"), accessPolicyDigest: digest("access"), retentionExpiresAt: "2026-09-07T01:00:00.000Z" },
    migration: { planDigest: digest("migration"), preSchemaDigest: digest("schema-1"), postSchemaDigest: digest("schema-2"),
      result: "passed", evidenceDigest: digest("rehearsal"), dataTransferMode: "none" },
    isolation: Object.fromEntries(HOSTED_RC_ISOLATION_CONTROLS.map((id) => [id, { mode: ["secrets", "sessions", "writableContent"].includes(id) ? "isolated" : "disabled", evidenceDigest: digest(id) }])),
    scenarios: [{ id: "normal-login", deviceId: "desktop", deviceKind: "physical", authentication: "normal", result: "passed", evidenceDigest: digest("scenario") }],
    native: null, producer: { id: "build-adapter", keyId: "producer" }, capturedAt: "2026-09-06T02:00:00.000Z",
    expiresAt: "2026-09-07T02:00:00.000Z", result: "passed", evidenceDigests: [digest("private-log")] });
  const context = { policy, binding, now: "2026-09-06T02:01:00.000Z", producerKeys: publicKeys("producer"),
    observerKeys: publicKeys("observer"), actorKeys: publicKeys("owner"), policyKeys: publicKeys("policy"),
    approvedProducerIds: ["build-adapter"], approvedObserverIds: ["deployment-adapter"], approvedOwnerIds: ["release-owner"],
    productionOrigins: ["https://app.example.invalid"], deploymentId: "deployment_1", environmentId: "rc_1",
    snapshotFingerprint: evidence.snapshot.fingerprint, snapshotAuthorizationId: "authorization_1", migrationPlanDigest: evidence.migration.planDigest,
    nativeBuildDigest: digest("native-build"), ownerPacketDigest: digest("packet"), decisionDigest: digest("decision"),
    revocationGeneration: 0, reviewSubjects: [{ taskId: "task_1", subjectSha: binding.sourceSha, cycle: 1 }],
    currentReviews: ["backend", "lead"].map((role) => ({ id: `review_${role}`, taskId: "task_1", actorId: `reviewer_${role}`, role, cycle: 1,
      subjectSha: binding.sourceSha, outcome: "approved", evidenceDigest: digest(role) })) };
  const input = { evidence };
  function seal() {
    context.policy = normalizeReleaseQaPolicy(context.policy);
    context.policyProof = proof("policy", context.policy, "policy");
    input.evidence.policyDigest = hostedRcDigest(context.policy);
    input.evidence = normalizeHostedRcEvidence(input.evidence);
    input.proof = proof("evidence", input.evidence, "producer");
    const e = input.evidence;
    const observation = normalizeHostedRcObservation({ schemaVersion: "studioops.hosted-rc-observation.v1",
      binding: e.binding, evidenceDigest: hostedRcDigest(e), policyDigest: e.policyDigest,
      deploymentId: e.environment.deploymentId, environmentId: e.environment.environmentId, origin: e.environment.origin,
      resolvedAddressClass: "public", runtimeDigest: hostedRcDigest(e.environment.runtime), environmentContractDigest: e.environment.contractDigest,
      snapshotFingerprint: e.snapshot.fingerprint, snapshotAuthorizationId: e.snapshot.authorizationId, migrationDigest: hostedRcDigest(e.migration),
      isolationDigest: hostedRcDigest(e.isolation), scenariosDigest: hostedRcDigest(e.scenarios), nativeDigest: hostedRcDigest(e.native),
      observerId: "deployment-adapter", observedAt: "2026-09-06T02:00:30.000Z" });
    context.observation = { payload: observation, proof: proof("observation", observation, "observer") };
    const inputs = releaseQualificationInputs({ binding: e.binding, evidenceDigest: hostedRcDigest(e), policyDigest: e.policyDigest,
      revocationGeneration: context.revocationGeneration, reviews: context.currentReviews,
      ...(context.policy.reviewStages ? {reviewStages:context.policy.reviewStages} : {}) });
    const decision = normalizeReleaseDecisionObservation({ schemaVersion: context.policy.reviewStages
      ? "studioops.release-decision-observation.v2" : "studioops.release-decision-observation.v1",
      binding: e.binding, inputsDigest: hostedRcDigest(inputs), evidenceDigest: hostedRcDigest(e), policyDigest: e.policyDigest,
      ownerPacketDigest: context.ownerPacketDigest, decisionDigest: context.decisionDigest, actorId: "release-owner", outcome: "approved",
      revocationGeneration: context.revocationGeneration, reviews: context.currentReviews, decidedAt: "2026-09-06T02:00:45.000Z" });
    context.decision = { payload: decision, proof: proof("decision", decision, "owner") };
  }
  seal();
  return { input, context, seal, proof, digest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test("hosted RC fixture is qualified through independently signed evidence and observations", () => {
    const f = hostedRcFixture(); assert.equal(evaluateReleaseQualification(f.input, f.context).eligible, true);
  });
  test("normalization binds every supported field and rejects arbitrary metadata/secrets", () => {
    const f = hostedRcFixture();
    const e = f.input.evidence;
    assert.equal(hostedRcDigest(e), hostedRcDigest(Object.fromEntries(Object.entries(e).reverse())));
    for (const field of ["metadata", "token", "passed", "hash", "force"]) {
      assert.throws(() => normalizeHostedRcEvidence({ ...e, [field]: "forbidden" }), { code: "evidence_malformed" });
    }
    assert.throws(() => normalizeHostedRcEvidence({ ...e, metadata: "x".repeat(65536) }), { code: "payload_too_large" });
    assert.throws(() => normalizeHostedRcEvidence({ ...e, binding: { ...e.binding, projectId: "personal@example.invalid" } }));
  });
  test("HTTPS origin rejects credentials, localhost, fragments, query secrets and paths", () => {
    const f = hostedRcFixture();
    for (const origin of ["http://rc.example.invalid", "https://a:secret@rc.example.invalid", "https://127.0.0.1", "https://[::1]", "https://rc.example.invalid/?token=x", "https://rc.example.invalid/path", "https://rc.example.invalid/#x"]) {
      assert.throws(() => normalizeHostedRcEvidence({ ...f.input.evidence, environment: { ...f.input.evidence.environment, origin } }));
    }
  });
  test("signature trust cannot be asserted through hashes, labels, proofs from other keys or booleans", () => {
    const f = hostedRcFixture();
    assert.equal(evaluateReleaseQualification({ ...f.input, proof: { keyId: "producer", signature: "A".repeat(86) + "==" } }, f.context).reasons[0], "untrusted_producer");
    assert.equal(evaluateReleaseQualification(f.input, { ...f.context, producerKeys: {} }).reasons[0], "untrusted_producer");
    assert.equal(evaluateReleaseQualification(f.input, { ...f.context, observation: { payload: f.context.observation.payload, proof: true } }).reasons[0], "untrusted_observation");
    f.input.evidence.binding.artifactDigest = f.digest("changed");
    f.context.binding = f.input.evidence.binding;
    assert.equal(evaluateReleaseQualification(f.input, f.context).reasons[0], "untrusted_producer");
  });
}
