import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { hostedRcFixture } from "./hosted-rc-evidence.test.js";
import { hostedRcDigest, hostedRcPublicKeyFingerprint } from "../src/hosted-rc-evidence.js";
import { evaluateReleaseQualification, normalizeReleaseQualification, releaseQualificationInputs, normalizeReleaseReviewStages, normalizeReleaseQaPolicy, normalizeReleaseDecisionObservation } from "../src/release-qualification.js";

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


test("canonical key material, not role-map labels or PEM wrapping, separates authority", () => {
  for (const [sourceRole, targetRole, code] of [["producer", "observer", "untrusted_observation"], ["producer", "owner", "untrusted_decision"], ["observer", "owner", "untrusted_decision"], ["producer", "policy", "untrusted_policy"], ["observer", "policy", "untrusted_policy"]]) {
    for (const rewrap of [false, true]) {
      const f = hostedRcFixture();
      const maps = {producer:"producerKeys",observer:"observerKeys",owner:"actorKeys",policy:"policyKeys"};
      const pem = f.context[maps[sourceRole]][sourceRole];
      const encoded = pem.split(/\r?\n/).filter(line => line && !line.startsWith("---")).join("");
      const equivalent = "-----BEGIN PUBLIC KEY-----\r\n" + encoded.match(/.{1,16}/g).join("\r\n") + "\r\n-----END PUBLIC KEY-----\r\n";
      assert.equal(hostedRcPublicKeyFingerprint(pem),hostedRcPublicKeyFingerprint(equivalent));
      const alias = "independent-looking-alias";
      f.context[maps[targetRole]] = {[alias]:rewrap ? equivalent : pem};
      const kind = targetRole === "owner" ? "decision" : targetRole === "policy" ? "policy" : "observation";
      if (kind === "policy") f.context.policyProof = {...f.proof(kind,f.context.policy,sourceRole),keyId:alias};
      else f.context[kind].proof = {...f.proof(kind,f.context[kind].payload,sourceRole),keyId:alias};
      assert.deepEqual(evaluateReleaseQualification(f.input,f.context).reasons,[code]);
    }
  }
});

test("distinct producer observer owner keys qualify while policy and owner may share a channel", () => {
  const f = hostedRcFixture();
  f.context.policyKeys = {policy:f.context.actorKeys.owner};
  f.context.policyProof = {...f.proof("policy",f.context.policy,"owner"),keyId:"policy"};
  assert.equal(evaluateReleaseQualification(f.input,f.context).eligible,true);
  f.context.producerKeys.unusedAlias = f.context.observerKeys.observer;
  assert.deepEqual(evaluateReleaseQualification(f.input,f.context).reasons,["untrusted_observation"]);
});


function reviewStageFixture(skipped = false) {
  const f = hostedRcFixture();
  const roles = ["backend","frontend","accessibility","regression-release","lead"];
  f.context.currentReviews = roles.map(role => ({...f.context.currentReviews[0],id:`review_${role}`,role,
    actorId:skipped && ["frontend","accessibility"].includes(role) ? "routing-applicability" : `reviewer_${role}`,
    outcome:skipped && ["frontend","accessibility"].includes(role) ? "skipped" : "approved",evidenceDigest:f.digest(role)}));
  const stages = normalizeReleaseReviewStages({schemaVersion:"studioops.release-review-stages.v1",tasks:[{taskId:"task_1",
    stages:f.context.currentReviews.map(row => ({stageId:row.role,workflowRequired:true,
      disposition:row.outcome === "skipped" ? "not_applicable" : "required",dispositionDigest:row.outcome === "skipped" ? row.evidenceDigest : null}))}]});
  f.context.policy.schemaVersion = "studioops.release-qa-policy.v2";
  delete f.context.policy.requiredReviewRoles;
  f.context.policy.reviewStages = stages;
  f.context.currentReviewStages = structuredClone(stages);
  f.seal();
  return f;
}

test("v2 binds default accessibility, custom stages and explicit skipped dispositions without approval credit", () => {
  for (const skipped of [false,true]) {
    const f = reviewStageFixture(skipped);
    const result = evaluateReleaseQualification(f.input,f.context);
    assert.equal(result.eligible,true,JSON.stringify(result.reasons));
    assert.equal(result.qualification.schemaVersion,"studioops.release-qualification.v2");
    f.context.currentReviews.find(r=>r.role === "lead").actorId = f.context.currentReviews.find(r=>r.role === "backend").actorId;
    f.seal();
    assert.deepEqual(evaluateReleaseQualification(f.input,f.context).reasons,["review_changed"]);
  }
});

test("v2 current-stage omissions, additions, revocations and changed applicability fail closed", () => {
  for (const change of [
    f=>f.context.currentReviews.pop(),
    f=>{f.context.currentReviews[0].outcome="revoked";},
    f=>{f.context.currentReviewStages.tasks[0].stages.push({stageId:"new-regression",workflowRequired:true,disposition:"required",dispositionDigest:null});},
    f=>{f.context.currentReviewStages.tasks[0].stages.find(s=>s.stageId==="frontend").dispositionDigest=f.digest("changed-skip");},
    f=>{f.context.currentReviewStages.tasks[0].stages.find(s=>s.stageId==="frontend").workflowRequired=false;},
    f=>{delete f.context.currentReviewStages;},
  ]) {
    const f = reviewStageFixture(true);change(f);
    assert.equal(evaluateReleaseQualification(f.input,f.context).eligible,false);
  }
});

test("v2 stage maps are bounded canonical sets; malformed IDs, duplicates, unsupported and mixed versions reject", () => {
  const f = reviewStageFixture();const original = f.context.policy.reviewStages;
  const reversed = structuredClone(original);reversed.tasks[0].stages.reverse();
  assert.deepEqual(normalizeReleaseReviewStages(reversed),original);
  for (const change of [
    v=>{v.schemaVersion="studioops.release-review-stages.v2";},
    v=>{v.tasks[0].stages[0].stageId="Invalid Stage!";},
    v=>{v.tasks[0].stages.push({...v.tasks[0].stages[0],workflowRequired:false,disposition:"not_applicable",dispositionDigest:f.digest("skip")});},
    v=>{v.tasks.push(structuredClone(v.tasks[0]));},
    v=>{v.tasks[0].stages=Array.from({length:33},(_,i)=>({stageId:`stage-${i}`,workflowRequired:true,disposition:"required",dispositionDigest:null}));},
    v=>{v.tasks[0].stages.find(s=>s.stageId==="lead").disposition="not_applicable";},
  ]) {const value=structuredClone(original);change(value);assert.throws(()=>normalizeReleaseReviewStages(value));}
  const policy=structuredClone(f.context.policy);policy.schemaVersion="studioops.release-qa-policy.v3";
  assert.throws(()=>normalizeReleaseQaPolicy(policy));
  // Even when only legacy role names are present, a v1 decision cannot bind v2 policy/inputs.
  const legacy=hostedRcFixture();legacy.context.policy.schemaVersion="studioops.release-qa-policy.v2";
  delete legacy.context.policy.requiredReviewRoles;
  legacy.context.policy.reviewStages={schemaVersion:"studioops.release-review-stages.v1",tasks:[{taskId:"task_1",stages:["backend","lead"].map(stageId=>({stageId,workflowRequired:true,disposition:"required",dispositionDigest:null}))}]};
  legacy.context.currentReviewStages=structuredClone(legacy.context.policy.reviewStages);legacy.seal();
  legacy.context.decision.payload.schemaVersion="studioops.release-decision-observation.v1";
  legacy.context.decision.proof=legacy.proof("decision",legacy.context.decision.payload,"owner");
  assert.deepEqual(evaluateReleaseQualification(legacy.input,legacy.context).reasons,["policy_mismatch"]);
});


test("accepted v1 canonical bytes remain unchanged across the v2 addition", () => {
  const f=hostedRcFixture();
  assert.equal(hostedRcDigest(normalizeReleaseQaPolicy(f.context.policy)),"sha256:74467401ee1aa8c6192057a96f151cad058c3e166615f14dc351f027227bdb48");
  const input=releaseQualificationInputs({binding:f.context.binding,evidenceDigest:hostedRcDigest(f.input.evidence),policyDigest:f.input.evidence.policyDigest,revocationGeneration:0,reviews:f.context.currentReviews});
  assert.equal(hostedRcDigest(input),"sha256:7bef1f791e98fc6a48bac7c04b68fb6956e17c9e9337d7a5a15a18681a69243f");
  assert.equal(hostedRcDigest(f.context.decision.payload),"sha256:1452b2aa62db95eebb033927665b3958f1b33c29cb1c1b7420fd9b4515737870");
  assert.equal(hostedRcDigest(evaluateReleaseQualification(f.input,f.context).qualification),"sha256:16c824ece0efb92d90fb1adc3319553b1686d561117782e5645755a959efc1f5");
});


test("v1 keeps its row cap and v2 enforces task, total-stage and encoded-size limits", () => {
  const f=hostedRcFixture();
  const tasks=Array.from({length:32},(_,i)=>({taskId:`task_${i}`,stages:["backend","frontend","accessibility","lead"].map(stageId=>
    ({stageId,workflowRequired:true,disposition:"required",dispositionDigest:null}))}));
  const reviewStages=normalizeReleaseReviewStages({schemaVersion:"studioops.release-review-stages.v1",tasks});
  const rows=tasks.flatMap((task,i)=>task.stages.map(stage=>({...f.context.currentReviews[0],id:`review_${i}_${stage.stageId}`,
    taskId:task.taskId,role:stage.stageId,actorId:`actor_${i}_${stage.stageId}`})));
  const base={binding:f.context.binding,evidenceDigest:hostedRcDigest(f.input.evidence),policyDigest:f.input.evidence.policyDigest,revocationGeneration:0};
  assert.equal(releaseQualificationInputs({...base,reviews:rows,reviewStages}).reviews.length,128);
  assert.throws(()=>releaseQualificationInputs({...base,reviews:Array.from({length:33},(_,i)=>({...f.context.currentReviews[0],id:`review_${i}`}))}));
  const tooMany=structuredClone(reviewStages);tooMany.tasks.push({...structuredClone(tasks[0]),taskId:"task_extra"});
  assert.throws(()=>normalizeReleaseReviewStages(tooMany));
  const tooManyStages=structuredClone(reviewStages);tooManyStages.tasks[0].stages.push({stageId:"regression-extra",workflowRequired:true,disposition:"required",dispositionDigest:null});
  assert.throws(()=>normalizeReleaseReviewStages(tooManyStages));
  const large=rows.map((row,i)=>({...row,id:`r${String(i).padStart(3,"0")}${"x".repeat(155)}`,actorId:`a${String(i).padStart(3,"0")}${"x".repeat(155)}`}));
  assert.throws(()=>releaseQualificationInputs({...base,reviews:large,reviewStages}),{code:"payload_too_large"});
  assert.throws(()=>normalizeReleaseDecisionObservation({...f.context.decision.payload,schemaVersion:"studioops.release-decision-observation.v2",reviews:large}),{code:"payload_too_large"});
});
