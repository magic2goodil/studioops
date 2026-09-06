import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { hostedRcFixture } from "./hosted-rc-evidence.test.js";
import { hostedRcDigest, normalizeHostedRcObservation, normalizeHostedRcBinding } from "../src/hosted-rc-evidence.js";
import { observeHostedRc, hostedAddressClass } from "../src/hosted-rc-transport.js";
import { normalizeProjectValidationFixtureNetwork, PROJECT_VALIDATION_FIXTURE_NETWORK_ENV,
  PROJECT_VALIDATION_NETWORK_POLICY_FIXTURE } from "../src/project-validation-sandbox.js";

const exec = promisify(execFile);
const promotionFixtures = [];

export function hostedFixtureNetwork() {
  const serialized = process.env[PROJECT_VALIDATION_FIXTURE_NETWORK_ENV];
  if (serialized !== undefined || process.env.STUDIOOPS_PROJECT_VALIDATION_NETWORK_POLICY === PROJECT_VALIDATION_NETWORK_POLICY_FIXTURE) {
    assert.equal(process.env.STUDIOOPS_PROJECT_VALIDATION_NETWORK_POLICY, PROJECT_VALIDATION_NETWORK_POLICY_FIXTURE);
    return normalizeProjectValidationFixtureNetwork(JSON.parse(serialized || "null"));
  }
  const address = Object.values(networkInterfaces()).flat().find((v) => v.family === "IPv4" && !v.internal
    && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(v.address))?.address;
  assert.ok(address, "Hermetic HTTPS fixture requires a local RFC1918 interface");
  return { address, ports: [0] };
}

export async function listenHostedFixture(server, binding = hostedFixtureNetwork()) {
  for (const port of binding.ports) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready);
        server.listen({ host: binding.address, port, exclusive: true });
      });
      server.unref();
      return;
    } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw Object.assign(new Error("fixture_ports_exhausted"), { code: "FIXTURE_PORTS_EXHAUSTED" });
}

/** Upgrade historical promotion TEST seeds to authentic hosted contracts before
 * exercising existing Git/PR adapters. This is deliberately test-only SQL seed
 * construction, never a product ingestion route. */
export async function installHostedPromotionFixture(root) {
  const installed = [];
  const { DatabaseSync } = await import("node:sqlite");
  const { buildHostedOwnerQaPacket } = await import("../src/owner-qa-packet.js");
  const { assertReleaseQualification, releaseQualificationInputs } = await import("../src/release-qualification.js");
  const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"));
  try {
    const candidates = db.prepare("SELECT payload FROM candidates").all().map((r) => JSON.parse(r.payload));
    for (const candidate of candidates) {
      if (candidate.hostedRc || candidate.qaDecision?.outcome !== "passed" || !candidate.qaPacket) continue;
      const project = JSON.parse(db.prepare("SELECT payload FROM projects WHERE id=?").get(candidate.projectId).payload);
      const ids = candidate.manifest.sources.flatMap((s) => s.reviews.map((r) => r.id));
      const reviews = db.prepare("SELECT payload FROM reviews").all().map((r) => JSON.parse(r.payload)).filter((r) => ids.includes(r.id));
      const f = await createHostedAdapterFixture({ configRoot: root, candidate, project, reviews });
      promotionFixtures.push(f);
      installed.push(f);
      const context = f.context;
      context.currentReviews = reviews.map((row) => ({ id: row.id, taskId: row.taskId, actorId: `actor-${row.id}`, role: row.stageKey,
        cycle: row.candidateCycle, subjectSha: row.subjectSha, outcome: row.outcome, evidenceDigest: hostedRcDigest(row) }));
      context.reviewSubjects = candidate.manifest.sources.map((s) => ({ taskId: s.taskId, subjectSha: s.headSha, cycle: s.candidateCycle }));
      const inputs = releaseQualificationInputs({ binding: context.binding, evidenceDigest: hostedRcDigest(f.input.evidence),
        policyDigest: f.input.evidence.policyDigest, revocationGeneration: 0, reviews: context.currentReviews });
      const packet = buildHostedOwnerQaPacket(candidate, inputs, f.readiness, f.input.evidence);
      context.ownerPacketDigest = packet.packetDigest; context.decisionDigest = hostedRcDigest(candidate.qaDecision);
      const now = new Date().toISOString(); context.now = now;
      const observed = { ...context.observation.payload, observedAt: now, resolvedAddressClass: "private" };
      context.observation = { payload: observed, proof: f.proof("observation", observed, "observer") };
      const decision = { schemaVersion: "studioops.release-decision-observation.v1", binding: context.binding,
        inputsDigest: packet.inputsDigest, evidenceDigest: inputs.evidenceDigest, policyDigest: inputs.policyDigest,
        ownerPacketDigest: packet.packetDigest, decisionDigest: context.decisionDigest, actorId: "release-owner", outcome: "approved",
        revocationGeneration: 0, reviews: inputs.reviews, decidedAt: now };
      context.decision = { payload: decision, proof: f.proof("decision", decision, "owner") };
      const qualification = assertReleaseQualification(f.input, context);
      project.hostedRc = { schemaVersion: "studioops.hosted-rc-state.v1", version: 1, generation: 1,
        policies: [{ digest: inputs.policyDigest, policy: context.policy, proof: context.policyProof }],
        activePolicyDigest: inputs.policyDigest, audit: [], evidence: [], qualifications: [] };
      candidate.hostedRc = { schemaVersion: "studioops.hosted-rc-state.v1", version: 3, generation: 0,
        policies: [], activePolicyDigest: "", audit: [], evidence: [{ ...f.input, digest: inputs.evidenceDigest }],
        packets: [{ packet, digest: hostedRcDigest(packet) }],
        qualifications: [{ qualification, digest: hostedRcDigest(qualification), decisionObservation: context.decision,
          projectPolicyGeneration: 1, reviewState: [] }] };
      db.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(project), project.id);
      db.prepare("UPDATE candidates SET payload=? WHERE id=?").run(JSON.stringify(candidate), candidate.id);
    }
  } finally { db.close(); }
  return installed;
}
export async function cleanupHostedPromotionFixtures() {
  await Promise.all(promotionFixtures.splice(0).map((f) => f.cleanup()));
}

/** Hermetic real TLS producer/observer fixture; never production QA evidence.
 * Importing this factory does not register tests. No product test-hook exists. */
export async function createHostedAdapterFixture({ configRoot, candidate = null, project = null, reviews = [], productionTarget = null, reviewStages = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "hrc-"));
  const binding = hostedFixtureNetwork();
  const ip = binding.address;
  const opensslConfig = path.join(root, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
  await exec("openssl", ["req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=StudioOps hermetic hosted fixture", "-addext", `subjectAltName=IP:${ip}`,
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { maxBuffer: 8192 });
  const ca = await readFile(path.join(root, "cert.pem"), "utf8");
  const f = hostedRcFixture();
  const stats = { observations: 0, mode: "ok" };
  const server = createServer({ key: await readFile(path.join(root, "key.pem")), cert: ca }, (request, response) => {
    stats.observations += 1;
    stats.beforeResponse?.();
    if (stats.mode === "offline") { request.socket.destroy(); return; }
    if (stats.mode === "redirect") { response.writeHead(302, { location: "https://127.0.0.1" }); response.end(); return; }
    const nonce = new URL(request.url, "https://fixture.invalid").searchParams.get("nonce");
    const payload = normalizeHostedRcObservation({ ...f.context.observation.payload, observedAt: new Date().toISOString(), resolvedAddressClass: "private" });
    if (stats.mode === "wrong-artifact") payload.binding.artifactDigest = f.digest("wrong-artifact");
    if (stats.mode === "stale") payload.observedAt = "2000-01-01T00:00:00.000Z";
    const proof = f.proof("observation", payload, "observer");
    const message = { nonce: stats.mode === "replay" ? "0".repeat(64) : nonce, payload, proof };
    const body = JSON.stringify({ ...message, transportProof: f.proof("observation-response", message, "observer") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(stats.mode === "oversize" ? " ".repeat(65537) : body);
  });
  await listenHostedFixture(server, binding);
  const origin = `https://${ip}:${server.address().port}`;
  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString();
  if (candidate) {
    f.context.binding.candidateId = candidate.id;
    f.context.binding.projectId = candidate.projectId;
    f.context.binding.manifestDigest = candidate.manifestDigest;
    f.context.binding.sourceSha = candidate.manifest.integration.sha;
    f.context.binding.integrationSha = candidate.manifest.integration.sha;
    f.context.binding.repository = project.repoUrl;
    f.context.policy.projectId = project.id;
  } else f.context.binding.sourceSha = f.context.binding.integrationSha;
  if (productionTarget) {
    for (const key of ["projectId", "repository", "sourceSha", "artifactDigest", "provenanceDigest"]) f.context.binding[key] = productionTarget[key];
    f.context.binding.integrationSha = productionTarget.sourceSha;
    f.context.policy.runtime.runtimeDigest = productionTarget.runtimeDigest;
  }
  f.context.binding = normalizeHostedRcBinding(f.context.binding);
  const target = productionTarget || { projectId: f.context.binding.projectId, repository: f.context.binding.repository,
    sourceSha: f.context.binding.sourceSha, artifactDigest: f.context.binding.artifactDigest,
    provenanceDigest: f.context.binding.provenanceDigest, runtimeDigest: f.context.policy.runtime.runtimeDigest,
    runtimeRoot: path.join(root, "production-runtime") };
  const readiness = { schemaVersion: "studioops.hosted-deployment-readiness.v1", target,
    backup: { id: "verified-backup", artifactDigest: f.digest("backup"), evidenceDigest: f.digest("backup-check"), verifiedAt: at(-3000), expiresAt: at(3600000) },
    rollback: { sourceSha: "a".repeat(40), artifactDigest: f.digest("rollback"), provenanceDigest: f.digest("rollback-provenance"),
      runtimeDigest: f.digest("rollback-runtime"), evidenceDigest: f.digest("rollback-check"), verifiedAt: at(-3000), expiresAt: at(3600000) },
    dataTransferMode: "none" };
  f.context.policy.environmentContractDigest = hostedRcDigest(readiness);
  f.context.policy.allowedOrigins = [origin]; f.context.policy.allowedPrivateOrigins = [origin];
  f.input.evidence.binding = structuredClone(f.context.binding);
  f.input.evidence.environment.origin = origin;
  f.input.evidence.environment.contractDigest = hostedRcDigest(readiness);
  f.input.evidence.environment.runtime = structuredClone(f.context.policy.runtime);
  f.input.evidence.capturedAt = at(-1000); f.input.evidence.expiresAt = at(3600000);
  f.input.evidence.snapshot.createdAt = at(-10000); f.input.evidence.snapshot.restoredAt = at(-5000);
  f.input.evidence.snapshot.retentionExpiresAt = at(3600000);
  f.context.now = at(0);
  const reviewActors = Object.fromEntries(reviews.map((r) => [r.actorId || r.author, `actor-${r.id}`]));
  if (reviewStages) {
    f.context.policy.schemaVersion = "studioops.release-qa-policy.v2";
    delete f.context.policy.requiredReviewRoles;
    f.context.policy.reviewStages = reviewStages;
    f.context.currentReviewStages = reviewStages;
    f.context.currentReviews = reviews.map(row => ({id:row.id, taskId:row.taskId, actorId:reviewActors[row.actorId || row.author],
      role:row.stageKey, cycle:row.candidateCycle, subjectSha:row.subjectSha, outcome:row.outcome, evidenceDigest:hostedRcDigest(row)}));
  }
  f.seal();
  f.context.binding = structuredClone(f.input.evidence.binding);
  const trust = { schemaVersion: "studioops.hosted-qa-trust.v1", projects: {
    [f.context.binding.projectId]: { producerKeys: f.context.producerKeys, observerKeys: f.context.observerKeys,
      actorKeys: f.context.actorKeys, policyKeys: f.context.policyKeys,
      approvedProducerIds: f.context.approvedProducerIds, approvedObserverIds: f.context.approvedObserverIds,
      approvedOwnerIds: f.context.approvedOwnerIds, productionOrigins: f.context.productionOrigins,
      certificateAuthorityPem: ca, reviewActors, deployments: { [f.context.binding.candidateId]: {
        binding: f.context.binding, readiness, origin, deploymentId: f.context.deploymentId, environmentId: f.context.environmentId,
        snapshotFingerprint: f.context.snapshotFingerprint, snapshotAuthorizationId: f.context.snapshotAuthorizationId,
        migrationPlanDigest: f.context.migrationPlanDigest, nativeBuildDigest: f.context.nativeBuildDigest,
      } } },
  } };
  async function writeTrust() {
    if (configRoot) { await mkdir(configRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(configRoot, "hosted-qa-trust.json"), JSON.stringify(trust), { mode: 0o600 }); }
  }
  await writeTrust();
  return { ...f, origin, readiness, target, trust, stats, writeTrust,
    transport: { origin, policy: f.context.policy, productionOrigins: f.context.productionOrigins,
      observerKeys: f.context.observerKeys, certificateAuthorityPem: ca },
    cleanup: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test("authenticated HTTPS adapter observes a nonce-bound identity and rejects redirect/replay/oversize/offline", async () => {
    const f = await createHostedAdapterFixture();
    try {
      const observation = await observeHostedRc(f.transport);
      assert.equal(observation.payload.origin, f.origin);
      assert.equal(observation.payload.evidenceDigest, hostedRcDigest(f.input.evidence));
      for (const mode of ["redirect", "replay", "oversize", "offline"]) {
        f.stats.mode = mode;
        await assert.rejects(observeHostedRc(f.transport));
      }
      f.stats.mode = "ok";
      await assert.rejects(observeHostedRc({ ...f.transport, observerKeys: {} }));
      await assert.rejects(observeHostedRc({ ...f.transport, policy: { ...f.context.policy, allowedPrivateOrigins: [] } }));
      await assert.rejects(observeHostedRc({ ...f.transport, productionOrigins: [f.origin] }));
      await assert.rejects(observeHostedRc({ ...f.transport, origin: f.origin.replace("https:", "http:") }));
    } finally { await f.cleanup(); }
  });
  test("address classification rejects loopback, link-local and metadata substitutions", () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fe80::1", "2002:7f00:1::"]) {
      assert.throws(() => hostedAddressClass(ip));
    }
    assert.equal(hostedAddressClass("10.0.0.1"), "private");
    assert.equal(hostedAddressClass("8.8.8.8"), "public");
    assert.equal(hostedAddressClass("2001:4860:4860::8888"), "public");
  });
  test("CLI collection, signed owner decision, restart, promotion admission and revocation form one vertical flow", async () => {
    const { createHermeticTestEnvironment } = await import("../scripts/test-environment.js");
    const environment = await createHermeticTestEnvironment({ tempParent: tmpdir() });
    Object.assign(process.env, environment.env);
    const store = await import("../src/store.js");
    const { DATABASE_FILE } = await import("../src/state-database.js");
    const { missionControlConfigRoot } = await import("../src/runtime-paths.js");
    const { DatabaseSync } = await import("node:sqlite");
    const { createCandidateEnvelope } = await import("../src/candidate-manifest.js");
    const { prepareHostedQaAdmission } = await import("../src/hosted-qa-adapter.js");
    const { normalizeReleaseDecisionObservation } = await import("../src/release-qualification.js");
    const initial = hostedRcFixture();
    const stageCase = process.env.STUDIOOPS_TEST_HOSTED_STAGE_CASE || "legacy";
    const v2 = stageCase !== "legacy";
    const skipped = ["skipped", "prototype"].includes(stageCase);
    const stageKeys = v2 ? ["backend", "frontend", "accessibility", ...(stageCase === "custom" ? ["regression-release"] : []), "lead"] : ["backend", "lead"];
    const project = {id:"project_1",key:"fixture",repoUrl:"https://github.com/example/project",
      reviewPipeline: v2 ? [] : stageKeys.map(key => ({key,role:`${key}-reviewer`,status:`${key}_review`,required:true}))};
    if (stageCase === "custom") project.reviewPipeline = store.normalizeReviewPipeline([
      ...store.DEFAULT_REVIEW_PIPELINE.slice(0,-1), {key:"regression-release",role:"regression-reviewer",status:"regression_review",required:true}, store.DEFAULT_REVIEW_PIPELINE.at(-1)]);
    if (stageCase === "prototype") project.deliveryPolicy = {profile:"prototype-fast-lane"};
    const task = {id:"task_1",projectId:project.id,candidateId:"candidate_1",reviewSubjectSha:"b".repeat(40),reviewSubjectCycle:1,reviewCycle:1,
      impactEvidence:{changedFiles:["src/store.js"]}};
    const reviews = stageKeys.map(role => ({id:`review_${role}`,taskId:task.id,projectId:project.id,stageKey:role,role:`${role}-reviewer`,
      candidateCycle:1,cycle:1,subjectSha:task.reviewSubjectSha,outcome:skipped && ["frontend","accessibility"].includes(role) ? "skipped" : "approved",
      author:`reviewer_${role}`,createdAt:"2026-09-06T01:00:00.000Z"}));
    // A retained source skip may have been issued by the full workflow before
    // current prototype routing excludes it. Both public policies are exercised.
    const assemblyProject = {...project, deliveryPolicy:undefined};
    const workflow = store.candidateReviewEvidenceForTask({projects:[assemblyProject],reviews},task);
    assert.equal(workflow.ok,true,workflow.error);
    const required = new Set(store.reviewStagesForTask(project,task).filter(s => s.required !== false).map(s => s.key));
    if (stageCase === "prototype") assert.deepEqual([...required],["backend","lead"]);
    const reviewStages = v2 ? {schemaVersion:"studioops.release-review-stages.v1",tasks:[{taskId:task.id,stages:reviews.map(row => ({
      stageId:row.stageKey,workflowRequired:required.has(row.stageKey),disposition:row.outcome === "skipped" ? "not_applicable" : "required",
      dispositionDigest:row.outcome === "skipped" ? hostedRcDigest(row) : null}))}]} : null;
    const candidate = createCandidateEnvelope({ qaBundleId: "qa_bundle_1", manifest: {
      candidateId: "candidate_1", projectId: "project_1", base: { branch: "main", sha: "a".repeat(40) },
      sources: [{ taskId: "task_1", sourceRef: "refs/heads/codex/fixture", headSha: "b".repeat(40), candidateCycle: 1,
        reviews: workflow.reviews }],
      integration: { branch: "qa/fixture", sha: "c".repeat(40) },
      checks: [{ id: "check_1", kind: "local-validation", name: "fixture", outcome: "passed", subjectSha: "c".repeat(40), evidenceDigest: initial.digest("check") }],
      preview: { url: "http://127.0.0.1:4174/", status: "healthy", commitSha: "c".repeat(40), verifiedAt: "2026-09-06T01:30:00.000Z",
        attestation: { kind: "header", key: "commit", observedSha: "c".repeat(40) } },
      assembly: { mode: "atomic", requestedTaskIds: ["task_1"], includedTaskIds: ["task_1"], excludedTaskIds: [] },
    } });
    // Explicit imported historical diagnostic fixture, not a product write path.
    candidate.qaPacket = { packetDigest: initial.digest("diagnostic-packet") };
    candidate.qaDecision = { outcome: "passed", candidateId: candidate.id, ownerQaPacketDigest: candidate.qaPacket.packetDigest };
    await store.readState();
    const db = new DatabaseSync(DATABASE_FILE);
    db.prepare("INSERT INTO tasks(id,sequence,project_id,status,payload) VALUES (?,?,?,?,?)").run(task.id,1,project.id,"qa_passed",JSON.stringify(task));
    db.prepare("INSERT OR REPLACE INTO projects(id,sequence,key,payload) VALUES (?,?,?,?)").run(project.id, 1, project.key, JSON.stringify(project));
    db.prepare("INSERT INTO candidates(id,sequence,project_id,status,manifest_digest,payload) VALUES (?,?,?,?,?,?)")
      .run(candidate.id, 1, project.id, candidate.status, candidate.manifestDigest, JSON.stringify(candidate));
    for (const [i, r] of reviews.entries()) db.prepare("INSERT INTO reviews(id,sequence,task_id,outcome,payload) VALUES (?,?,?,?,?)")
      .run(r.id, i, r.taskId, r.outcome, JSON.stringify(r));
    db.close();
    const f = await createHostedAdapterFixture({ configRoot: missionControlConfigRoot(), candidate, project, reviews, reviewStages });
    const files = await mkdtemp(path.join(tmpdir(), "hc-cli-"));
    const cli = async (action, value) => {
      const args = ["src/mission-control-cli.js", "hosted-qa", action, "--project", project.id, "--candidate", candidate.id];
      if (value) {
        const filename = path.join(files, `${action}.json`);
        await writeFile(filename, JSON.stringify(value), { mode: 0o600 }); args.push("--file", filename);
      }
      const { stdout } = await exec(process.execPath, args, { env: process.env, maxBuffer: 65536 });
      return JSON.parse(stdout);
    };
    try {
      assert.equal((await cli("status")).status, "setup_missing");
      await assert.rejects(prepareHostedQaAdmission({ projectId: project.id, candidateId: candidate.id }));
      await cli("policy", { policy: f.context.policy, proof: f.context.policyProof });
      const forged = structuredClone(f.input); forged.evidence.binding.artifactDigest = f.digest("forged");
      await assert.rejects(cli("collect", forged));
      const collected = await cli("collect", f.input);
      assert.equal(collected.status, "collecting");
      const duplicate = await cli("collect", f.input);
      assert.equal(duplicate.version, collected.version);
      assert.equal(duplicate.packet.packetDigest, collected.packet.packetDigest);
      await assert.rejects(prepareHostedQaAdmission({ projectId: project.id, candidateId: candidate.id }));
      const packet = collected.packet;
      assert.equal(packet.schemaVersion,v2 ? "studioops.hosted-owner-qa-packet.v2" : "studioops.hosted-owner-qa-packet.v1");
      const decision = normalizeReleaseDecisionObservation({ schemaVersion: v2 ? "studioops.release-decision-observation.v2" : "studioops.release-decision-observation.v1",
        binding: f.input.evidence.binding, inputsDigest: packet.inputsDigest,
        evidenceDigest: hostedRcDigest(f.input.evidence), policyDigest: f.input.evidence.policyDigest,
        ownerPacketDigest: packet.packetDigest, decisionDigest: hostedRcDigest(candidate.qaDecision),
        actorId: "release-owner", outcome: "approved", revocationGeneration: 0,
        reviews: packet.inputs.reviews, decidedAt: new Date().toISOString() });
      const signed = { payload: decision, proof: f.proof("decision", decision, "owner") };
      await cli("decide", signed);
      assert.equal((await cli("verify")).status, "qualified");
      const admission = await prepareHostedQaAdmission({ projectId: project.id, candidateId: candidate.id, productionTarget: f.target });
      assert.equal(admission.qualification.binding.artifactDigest, f.target.artifactDigest);
      assert.throws(() => admission.assertRollback({ ...f.target }));
      const rollback = f.readiness.rollback;
      admission.assertRollback(Object.fromEntries(["sourceSha", "artifactDigest", "provenanceDigest", "runtimeDigest"].map((k) => [k, rollback[k]])));
      const before = f.stats.observations;
      await cli("verify"); assert.ok(f.stats.observations > before, "reuse must re-observe HTTPS");
      const coordinates = await store.readHostedQaCoordinates(project.id, candidate.id);
      assert.deepEqual(coordinates.candidate.manifest, candidate.manifest);
      assert.deepEqual(coordinates.candidate.qaPacket, candidate.qaPacket);
      const raceDb = new DatabaseSync(DATABASE_FILE);
      const originalReview = raceDb.prepare("SELECT * FROM reviews WHERE id=?").get("review_backend");
      const originalTask = raceDb.prepare("SELECT * FROM tasks WHERE id=?").get(task.id);
      const originalProject = raceDb.prepare("SELECT * FROM projects WHERE id=?").get(project.id);
      const snapshot = () => ["tasks","projects","candidates","reviews","events","comments","state_meta"].map(table =>
        raceDb.prepare(`SELECT * FROM ${table} ORDER BY ${table === "state_meta" ? "singleton_id" : "id"}`).all());
      const rejectWithoutWrites = async () => {
        const before = snapshot();
        await assert.rejects(cli("collect",f.input));
        await assert.rejects(cli("verify"));
        assert.equal((await cli("status")).status,"stale");
        assert.deepEqual(snapshot(),before);
      };
      try {
        for (const tie of [false,true]) {
          const replacement = {...JSON.parse(originalReview.payload),id:"a-review-replacement",createdAt:tie ? reviews[0].createdAt : new Date().toISOString()};
          raceDb.prepare("INSERT INTO reviews(id,sequence,task_id,outcome,created_at,payload) VALUES (?,?,?,?,?,?)")
            .run(replacement.id,99,task.id,replacement.outcome,tie ? originalReview.created_at : replacement.createdAt,JSON.stringify(replacement));
          await rejectWithoutWrites();
          raceDb.prepare("DELETE FROM reviews WHERE id=?").run(replacement.id);
        }
        raceDb.prepare("DELETE FROM reviews WHERE id=?").run(originalReview.id);
        await rejectWithoutWrites();
        raceDb.prepare("INSERT INTO reviews(id,sequence,task_id,outcome,created_at,payload) VALUES (?,?,?,?,?,?)")
          .run(...["id","sequence","task_id","outcome","created_at","payload"].map(k=>originalReview[k]));
        raceDb.prepare("UPDATE reviews SET payload=? WHERE id=?").run(JSON.stringify({...JSON.parse(originalReview.payload),invalidatedAt:new Date().toISOString()}),originalReview.id);
        await rejectWithoutWrites();
        raceDb.prepare("UPDATE reviews SET payload=? WHERE id=?").run(originalReview.payload,originalReview.id);
        for (const patch of [{reviewSubjectSha:"d".repeat(40)},{reviewSubjectCycle:2},{projectId:"wrong-project"}]) {
          raceDb.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify({...task,...patch}),task.id);
          await rejectWithoutWrites();
        }
        raceDb.prepare("UPDATE tasks SET payload=? WHERE id=?").run(originalTask.payload,task.id);
        raceDb.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
        await rejectWithoutWrites();
        raceDb.prepare("INSERT INTO tasks(id,sequence,project_id,status,payload) VALUES (?,?,?,?,?)")
          .run(originalTask.id,originalTask.sequence,originalTask.project_id,originalTask.status,originalTask.payload);
        const changedProject = JSON.parse(originalProject.payload);
        changedProject.reviewPipeline = [...store.reviewStagesForProject(changedProject),{key:"regression-new",role:"regression-reviewer",required:true}];
        raceDb.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(changedProject),project.id);
        await rejectWithoutWrites();
        raceDb.prepare("UPDATE projects SET payload=? WHERE id=?").run(originalProject.payload,project.id);
        if (skipped) {
          const saved = raceDb.prepare("SELECT payload FROM reviews WHERE id='review_frontend'").get().payload;
          raceDb.prepare("UPDATE reviews SET payload=? WHERE id='review_frontend'").run(JSON.stringify({...JSON.parse(saved),outcome:"approved"}));
          await rejectWithoutWrites();
          raceDb.prepare("UPDATE reviews SET payload=? WHERE id='review_frontend'").run(saved);
        }
        if (stageCase === "prototype") {
          const changed = JSON.parse(originalProject.payload);delete changed.deliveryPolicy;
          raceDb.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(changed),project.id);
          await rejectWithoutWrites();
          raceDb.prepare("UPDATE projects SET payload=? WHERE id=?").run(originalProject.payload,project.id);
        }
      } finally { raceDb.close(); }
      const changedReviews = structuredClone(coordinates);
      changedReviews.reviews[0].outcome = "revoked";
      assert.throws(() => admission.assertCurrent(changedReviews));
      const trustPath = path.join(missionControlConfigRoot(), "hosted-qa-trust.json");
      await chmod(trustPath, 0o644);
      await assert.rejects(cli("verify"));
      await chmod(trustPath, 0o600);
      const trustedConfig = await readFile(trustPath, "utf8");
      for (const [source, target] of [["producerKeys", "observerKeys"], ["producerKeys", "actorKeys"], ["observerKeys", "actorKeys"], ["producerKeys", "policyKeys"], ["observerKeys", "policyKeys"]]) {
        const substituted = JSON.parse(trustedConfig);
        substituted.projects[project.id][target].aliased = Object.values(substituted.projects[project.id][source])[0];
        await writeFile(trustPath, JSON.stringify(substituted), {mode:0o600});
        assert.throws(() => admission.assertCurrent(coordinates));
        await assert.rejects(cli("verify"));
      }
      const removed = JSON.parse(trustedConfig);
      removed.projects[project.id].observerKeys = {};
      await writeFile(trustPath,JSON.stringify(removed),{mode:0o600});
      await assert.rejects(cli("verify"));
      await writeFile(trustPath,trustedConfig,{mode:0o600});
      const originalExpiry = f.readiness.backup.expiresAt;
      f.readiness.backup.expiresAt = "2000-01-01T00:00:00.000Z";
      await f.writeTrust();
      assert.throws(() => admission.assertCurrent(coordinates), { code: "policy_mismatch" });
      await assert.rejects(cli("verify"));
      f.readiness.backup.expiresAt = originalExpiry;
      await f.writeTrust();
      for (const mode of ["wrong-artifact", "stale", "offline"]) {
        f.stats.mode = mode; await assert.rejects(cli("verify"));
      }
      f.stats.mode = "ok";
      await assert.rejects(prepareHostedQaAdmission({ projectId: project.id, candidateId: candidate.id,
        productionTarget: { ...f.target, artifactDigest: f.digest("other") } }));
      const revoked = { id: "revoke_1", projectId: project.id, candidateId: candidate.id, generation: 1,
        reason: "owner_revoked", actorId: "release-owner", observedAt: new Date().toISOString() };
      // Revocation remains available while the hosted endpoint is offline.
      f.stats.mode = "offline";
      await cli("revoke", { payload: revoked, proof: f.proof("revocation", revoked, "owner") });
      assert.equal((await cli("status")).status, "revoked");
      const current = await store.readHostedQaCoordinates(project.id, candidate.id);
      assert.throws(() => admission.assertCurrent(current), { code: "candidate_mismatch" });
      f.stats.mode = "ok";
      await assert.rejects(cli("verify"));
    } finally { await f.cleanup(); await rm(files, { recursive: true, force: true }); await environment.cleanup(); }
  });
  test("v2 default accessibility, custom regression and signed applicability survive CLI restart", async () => {
    for (const stageCase of ["default", "custom", "skipped", "prototype"]) {
      const childEnv = {...process.env,STUDIOOPS_TEST_HOSTED_STAGE_CASE:stageCase};
      delete childEnv.NODE_TEST_CONTEXT;
      const result = await exec(process.execPath,["--test","--test-name-pattern=^CLI collection",fileURLToPath(import.meta.url)],
        {env:childEnv,maxBuffer:65536});
      assert.match(result.stdout,/pass 1/);
    }
  });

}
