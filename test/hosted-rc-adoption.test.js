import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { assertCurrentOwnerQaPacket, buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { HOSTED_RC_STANDARD, MODULAR_ARCHITECTURE_STANDARD, projectFromConfig } from "../src/config.js";
import { planHostedRcAdoption } from "../src/hosted-rc-adoption.js";
import { createReleaseQualificationAuthority, RELEASE_QA_POLICY_VERSION } from "../src/release-qualification.js";
import { hostedRcDigest } from "../src/hosted-rc-evidence.js";
import { hostedRcFixture } from "./hosted-rc-evidence.test.js";
import { claimPromotionAttemptInState, promotionProjectPolicyBinding } from "../src/promotion-attempt-claim.js";

const run = promisify(execFile);
const environment = await createHermeticTestEnvironment();
Object.assign(process.env, environment.env);
test.after(() => environment.cleanup());
const store = await import("../src/store.js");
const { planPromotions } = await import("../src/promotion.js");
const { DATABASE_FILE } = await import("../src/state-database.js");
const NOW = "2026-09-06T01:30:00.000Z";
const SHA = "b".repeat(40), INTEGRATION = "c".repeat(40);

function historicalState(project) {
  const state = { meta: {}, projects: [project], tasks: [], candidates: [], reviews: [], qaBundles: [],
    runs: [], events: [], comments: [{ id: "comment_history", taskId: "task_1", author: "Fixture", body: "Completed historical work", createdAt: NOW }] };
  for (let i = 1; i <= 2; i++) {
    const taskId = `task_${i}`, candidateId = `candidate_${i}`, bundleId = `qa_bundle_${i}`;
    const reviews = ["backend", "lead"].map((role) => ({ id: `review_${i}_${role}`, taskId, projectId: project.id,
      stageKey: role, role: `${role}-reviewer`, outcome: "approved", subjectSha: SHA, candidateCycle: 1,
      author: "Fixture Reviewer", createdAt: NOW }));
    state.reviews.push(...reviews);
    const candidate = createCandidateEnvelope({ qaBundleId: bundleId, createdAt: NOW, manifest: {
      candidateId, projectId: project.id, base: { branch: "main", sha: "a".repeat(40) },
      sources: [{ taskId, sourceRef: `refs/heads/feature/${taskId}`, headSha: SHA, candidateCycle: 1,
        reviews: reviews.map((review) => ({ ...review, reviewedAt: NOW })) }],
      integration: { branch: `qa/${candidateId}`, sha: INTEGRATION },
      checks: [{ id: `check_${i}`, kind: "local-validation", name: "fixture", outcome: "passed",
        subjectSha: INTEGRATION, evidenceDigest: hostedRcDigest({ fixture: i }) }],
      preview: { url: `http://127.0.0.1:4393/${candidateId}`, status: "healthy", commitSha: INTEGRATION,
        verifiedAt: NOW, attestation: { kind: "json", key: "commitSha", observedSha: INTEGRATION } },
      assembly: { mode: "atomic", requestedTaskIds: [taskId], includedTaskIds: [taskId], excludedTaskIds: [] },
    } });
    const task = { id: taskId, projectId: project.id, title: `Historical ${i}`, status: "qa_review", stateVersion: 1,
      architectureRequired: false, architectureStatus: "not_required", assignedAgentRole: "owner", reviewCycle: 1,
      reviewSubjectSha: SHA, reviewSubjectCycle: 1, integrationStatus: "ready", integrationCommit: INTEGRATION,
      integrationBranch: candidate.manifest.integration.branch, candidateId, candidateManifestDigest: candidate.manifestDigest, qaBundleId: bundleId };
    const bundle = { id: bundleId, projectId: project.id, candidateId, manifestDigest: candidate.manifestDigest,
      integrationCommit: INTEGRATION, integrationBranch: candidate.manifest.integration.branch, previewUrl: candidate.manifest.preview.url,
      tasks: [{ id: taskId, title: task.title, prUrl: "", branchName: "", acceptanceCriteria: [] }], status: "ready", createdAt: NOW };
    state.tasks.push(task); state.candidates.push(candidate); state.qaBundles.push(bundle);
    candidate.qaPacket = buildOwnerQaPacket(state, candidate, { bundle, generatedAt: NOW });
    bundle.qaPacket = structuredClone(candidate.qaPacket); bundle.packetDigest = candidate.qaPacket.packetDigest;
    candidate.qaDecision = { outcome: "passed", candidateId, ownerQaPacketDigest: candidate.qaPacket.packetDigest,
      manifestDigest: candidate.manifestDigest, integrationSha: INTEGRATION, taskIds: [taskId],
      author: "Fixture Owner", repositoryVerifiedAt: NOW, decidedAt: NOW };
  }
  state.tasks.push({ id: "task_completed", projectId: project.id, title: "Completed work", status: "done", stateVersion: 1 });
  return state;
}

function projectFixture() {
  return { id: "project_1", key: "demo", name: "Demo", repoPath: "/private/fixture/demo",
    repoUrl: "https://github.com/example/demo", defaultBranch: "main", workflowMode: "github",
    standards: ["/private/custom/standard.md", "docs/PROJECT_POLICY.md"], safetyRules: ["Keep project-specific identity boundaries."],
    reviewPolicy: { trustLeadApprovals: true, integrationBranch: "qa/demo" },
    providers: { mode: "custom" }, customPolicy: { keep: [1, 2, 3] } };
}

test("adoption preserves multiple frozen candidates, approval audit and completed work while new QA needs current requirements", () => {
  const state = historicalState(projectFixture());
  for (const candidate of state.candidates) assertCurrentOwnerQaPacket(state, candidate);
  const before = structuredClone(state);
  const result = store.adoptDefaultProjectStandardsInState(state, "project_1", { now: NOW });
  assert.deepEqual(result.added, [MODULAR_ARCHITECTURE_STANDARD, HOSTED_RC_STANDARD]);
  for (const key of ["tasks", "candidates", "reviews", "qaBundles", "comments", "runs"]) {
    assert.deepEqual(state[key], before[key], `${key} must survive adoption unchanged`);
  }
  const { standards, updatedAt, ...preserved } = state.projects[0];
  const { standards: originalStandards, ...original } = before.projects[0];
  assert.deepEqual(preserved, original);
  assert.ok(originalStandards.every((item) => standards.includes(item)));
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].scope, "future_releases");
  for (const candidate of state.candidates) assert.throws(() => assertCurrentOwnerQaPacket(state, candidate), /no longer matches/);
  const adopted = structuredClone(state);
  assert.equal(store.adoptDefaultProjectStandardsInState(state, "demo", { now: "2026-09-07T00:00:00.000Z" }).changed, false);
  assert.deepEqual(state, adopted, "unchanged adoption cannot mutate timestamps, audit or historical authority");
});

test("bounded rollout inventory consumes current policy contracts and creates no setup or qualification", () => {
  const f = hostedRcFixture();
  const configured = projectFixture();
  configured.hostedRc = { activePolicyDigest: hostedRcDigest(f.context.policy), policies: [{ digest: hostedRcDigest(f.context.policy), policy: f.context.policy }] };
  const projects = Array.from({ length: 53 }, (_, index) => ({ ...projectFixture(), id: `project_${String(index).padStart(3, "0")}` }));
  const before = structuredClone(projects);
  const page = planHostedRcAdoption(projects);
  assert.equal(page.items.length, 50); assert.equal(page.nextAfter, "project_049");
  assert.equal(planHostedRcAdoption(projects, { after: page.nextAfter }).items.length, 3);
  assert.deepEqual(projects, before);
  assert.ok(page.items.every((item) => item.status === "setup_missing" && item.requiredPolicyVersion === RELEASE_QA_POLICY_VERSION));
  assert.equal(page.releaseAuthority, "not_evaluated");
  const item = () => planHostedRcAdoption([configured]).items[0];
  assert.equal(item().status, "evidence_required");
  configured.hostedRc.activePolicyDigest = "PRIVATE_SENTINEL";
  assert.equal(item().status, "policy_invalid");
  assert.doesNotMatch(JSON.stringify(item()), /PRIVATE_SENTINEL/);
  f.context.policy.applicability = "unknown";
  configured.hostedRc = { activePolicyDigest: hostedRcDigest(f.context.policy), policies: [{ digest: hostedRcDigest(f.context.policy), policy: f.context.policy }] };
  assert.equal(item().status, "applicability_review_required");
  for (const limit of [0, 51, 1.5, Infinity]) assert.throws(() => planHostedRcAdoption(projects, { limit }), /limit/);
  assert.throws(() => planHostedRcAdoption(projects, { after: "../private" }), /cursor/);
});

test("persistent adoption is atomic, race-idempotent, CLI-plan read-only and preserves hosted policy/history", async () => {
  const registered = await store.addProject(projectFromConfig({ key: "demo", name: "Demo", repoUrl: "https://github.com/example/demo", repoPath: "/private/fixture/demo" }));
  assert.ok(registered.standards.includes(HOSTED_RC_STANDARD));
  const f = hostedRcFixture();
  const authority = createReleaseQualificationAuthority(() => f.context);
  await store.recordReleaseQaPolicy({ projectId: registered.id, expectedVersion: 0, policy: f.context.policy, proof: f.context.policyProof }, authority);
  const project = (await store.readStateReadOnly()).projects[0];
  const historical = historicalState({ ...project, standards: projectFixture().standards });
  // Explicit hermetic legacy fixture. Product adoption uses only the public
  // fenced store API; no authority is seeded in a live control plane.
  const db = new DatabaseSync(DATABASE_FILE);
  try {
    db.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(historical.projects[0]), registered.id);
    for (const [i, candidate] of historical.candidates.entries()) db.prepare("INSERT INTO candidates(id,sequence,project_id,status,manifest_digest,payload) VALUES(?,?,?,?,?,?)")
      .run(candidate.id, i, candidate.projectId, candidate.status, candidate.manifestDigest, JSON.stringify(candidate));
    for (const [i, task] of historical.tasks.entries()) db.prepare("INSERT INTO tasks(id,sequence,project_id,status,state_version,payload) VALUES(?,?,?,?,?,?)")
      .run(task.id, i, task.projectId, task.status, task.stateVersion, JSON.stringify(task));
    for (const [i, review] of historical.reviews.entries()) db.prepare("INSERT INTO reviews(id,sequence,task_id,outcome,payload) VALUES(?,?,?,?,?)")
      .run(review.id, i, review.taskId, review.outcome, JSON.stringify(review));
    for (const [i, bundle] of historical.qaBundles.entries()) db.prepare("INSERT INTO qa_bundles(id,sequence,project_id,status,integration_commit,payload) VALUES(?,?,?,?,?,?)")
      .run(bundle.id, i, bundle.projectId, bundle.status, bundle.integrationCommit, JSON.stringify(bundle));
  } finally { db.close(); }
  const before = await store.readStateReadOnly();
  const failureFiles = () => readdir(path.join(environment.dataDir, "database-contention-failures")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const failuresBefore = await failureFiles();
  const cli = (...args) => run(process.execPath, ["src/mission-control-cli.js", "adopt-default-standards", ...args], { env: process.env });
  const plan = JSON.parse((await cli("--all", "--plan", "--json", "--limit", "1")).stdout);
  assert.equal(plan.items[0].changed, true);
  assert.deepEqual(await store.readStateReadOnly(), before, "--plan must not advance state or events");
  const adopted = await Promise.all([store.adoptDefaultProjectStandards(registered.id), store.adoptDefaultProjectStandards(registered.id)]);
  assert.equal(adopted.filter((item) => item.changed).length, 1);
  const after = await store.readStateReadOnly();
  assert.deepEqual(await failureFiles(), failuresBefore, "raced no-op adoption is not a failed mutation");
  for (const key of ["tasks", "candidates", "reviews", "qaBundles", "comments", "runs"]) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.projects[0].hostedRc, before.projects[0].hostedRc, "signed custom policy and generation are not rewritten by adoption");
  assert.equal(after.events.filter((event) => event.type === "project_default_standards_adopted").length, 1);
  for (const candidate of after.candidates) assert.equal((await store.getCurrentReleaseQualification(registered.id, candidate.id)).reason, "qualification_missing");
  const unchanged = JSON.parse((await cli("demo", "--json")).stdout);
  assert.equal(unchanged.results[0].changed, false);
  assert.deepEqual(await store.readStateReadOnly(), after, "unchanged apply must not write even database metadata");
  await store.mutateState(() => ({ changed: false }), { operationName: "project.adopt_standards" });
  assert.deepEqual(await store.readStateReadOnly(), after, "raced storage no-op cannot commit metadata");
  assert.deepEqual(store.qaDecisionCoordinatesForState(after), { tasks: {}, bundles: {} }, "old packets expose no new owner decision");
  for (const candidate of after.candidates) {
    await assert.rejects(store.recordQaBundleDecision(candidate.qaBundleId, {
      outcome: "passed", candidateId: candidate.id, manifestDigest: candidate.manifestDigest,
      integrationSha: INTEGRATION, ownerQaPacketDigest: candidate.qaPacket.packetDigest,
    }), /no longer matches/);
    assert.throws(() => claimPromotionAttemptInState(structuredClone(after), {
      projectId: registered.id, candidateId: candidate.id, mode: "create",
      policyDigest: hostedRcDigest({ validation: "fixture" }), projectPolicy: promotionProjectPolicyBinding(after.projects[0]),
    }), /no longer matches/);
  }
  assert.equal(planPromotions(after, { project: registered.id }).projects.length, 0);
  const mutations = [
    (state) => { state.projects[0].standards = state.projects[0].standards.filter((ref) => !ref.startsWith("/private/custom")); },
    (state) => { state.projects[0].standards.push("docs/UNRELATED.md"); },
    (state) => { state.projects[0].standards[2] = "/private/changed-policy.md"; },
    (state) => { state.projects[0].safetyRules = ["Changed unrelated safety policy"]; },
    (state) => { state.tasks[0].title = "Changed frozen source task"; },
    (state) => { state.candidates[0].manifest.sources[0].headSha = "f".repeat(40); },
    (state) => { state.qaBundles[0].qaPacket.project.name = "Tampered mirror"; },
    (state) => { state.candidates[0].qaDecision.author = "Replacement authority"; },
    (state) => { state.meta.promotionAttemptClaims = { candidate_1: { status: "active" } }; },
  ];
  for (const mutate of mutations) {
    await assert.rejects(store.mutateState((state) => { mutate(state); return { changed: false }; }, { operationName: "project.adopt_standards" }));
    assert.deepEqual(await store.readStateReadOnly(), after, "failed unrelated/tampered write must be atomic");
  }
  const drifted = { ...after.projects[0], standards: [...after.projects[0].standards, "docs/UNRELATED_DRIFT.md"] };
  const replaceFixtureProject = (value) => {
    const fixtureDb = new DatabaseSync(DATABASE_FILE);
    try { fixtureDb.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(value), registered.id); }
    finally { fixtureDb.close(); }
  };
  replaceFixtureProject(drifted);
  try {
    await assert.rejects(store.mutateState((state) => { state.projects[0].standards = after.projects[0].standards; }), /no longer matches/);
    assert.deepEqual((await store.readStateReadOnly()).projects[0], drifted, "the guard cannot erase unrelated prior standard drift");
  } finally { replaceFixtureProject(after.projects[0]); }
  await store.addComment("task_completed", "A deliberate new comment remains possible after adoption.", "Fixture");
  const commented = await store.readStateReadOnly();
  assert.deepEqual(commented.candidates, after.candidates);
  assert.deepEqual(commented.tasks, after.tasks);
  assert.equal(commented.comments.length, after.comments.length + 1);
  f.context.policy.revision = 2; f.seal();
  await store.recordReleaseQaPolicy({ projectId: registered.id, expectedVersion: 1, policy: f.context.policy, proof: f.context.policyProof }, authority);
  const current = await store.getReleaseQaPolicy(registered.id);
  assert.equal(current.policyDigest, hostedRcDigest(f.context.policy));
  assert.equal(current.generation, 2);
  const final = await store.readStateReadOnly();
  assert.deepEqual(final.candidates, after.candidates);
  assert.deepEqual(final.tasks, after.tasks);
});

test("bundled hosted standard covers real environment, data, migration, native and preservation requirements", async () => {
  const standard = await readFile(HOSTED_RC_STANDARD, "utf8");
  for (const requirement of [/HTTPS/, /transactionally consistent/, /authorized production-data snapshot/, /revoke copied sessions/,
    /Notifications, payments/, /writable content\/media/, /Rehearse migrations/, /physical device/, /matching hosted RC backend/,
    /same tested revision and artifact/, /production backup/, /dataTransferMode is none/, /creates no\s+environment/,
    /must not reopen, requeue or rebuild/, /Standing production authorization/]) assert.match(standard, requirement);
});
