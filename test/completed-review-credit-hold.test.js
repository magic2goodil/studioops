import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjectComponentImpactMapAtCommit } from "../src/component-impact-map.js";
import {
  addProject, addTask, adoptOperatorCandidate, automationTick, mutateState,
  readStateReadOnly, recordReview, workflowSnapshotForTask,
} from "../src/store.js";
import { claimFailureContainmentPaidAttempt, readFailureIncidents } from "../src/state-database.js";
import { createSupervisorReport } from "../src/supervisor.js";

const STAGES = ["backend", "frontend", "accessibility", "lead"].map(key => ({
  key, label: key, role: `${key}-reviewer`, status: `${key}_review`, required: true,
}));

async function fixture(t, { finalReview = true, optionalFrontend = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "completed-review-credit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const key = path.basename(root).toLowerCase(), repository = `https://github.com/example/${key}`;
  git("init", "-b", "main"); git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", repository);
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, "docs/architecture"), { recursive: true });
  await writeFile(path.join(root, "src/catalog.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "docs/architecture/components.json"), JSON.stringify({
    schemaVersion: 1, project: { key, repository }, aggregateCommand: "npm run check",
    components: { catalog: { owner: "fixture-engineering", paths: ["src/catalog.js"],
      publicContracts: ["catalog value"], services: ["catalog"], dependsOn: [],
      tests: [{ command: "node --check src/catalog.js", layer: "unit" }],
      reviewOwners: ["backend-reviewer"], rollback: "Restore prior fixture revision." } },
  }));
  git("add", "."); git("commit", "-m", "Synthetic base"); const baseSha = git("rev-parse", "HEAD");
  git("switch", "-c", "feature/synthetic");
  await writeFile(path.join(root, "src/catalog.js"), "export const version = 2;\n");
  git("add", "."); git("commit", "-m", "Synthetic candidate"); const sha = git("rev-parse", "HEAD");
  const project = await addProject({ key, name: "Synthetic project", workflowMode: "local", repoPath: root,
    sourceRepoPath: root, repoUrl: repository,
    reviewPipeline: STAGES.map(stage => ({ ...stage, required: !(optionalFrontend && stage.key === "frontend") })) });
  const task = await addTask({ projectId: project.id, title: "Reviewed synthetic candidate", type: "bug",
    description: "Preserve completed review evidence without launching another reviewer.", status: "blocked",
    architectureRequired: false, workAreas: ["src/catalog.js"] });
  const current = (await readStateReadOnly()).tasks.find(item => item.id === task.id);
  const request = { schemaVersion: 1, expectedStateVersion: current.stateVersion, projectId: project.id, repository,
    candidate: { baseSha, commitSha: sha, treeSha: git("rev-parse", "HEAD^{tree}"), branch: "feature/synthetic" },
    mapDigest: loadProjectComponentImpactMapAtCommit(project, sha, { repoRoot: root }).digest,
    reviewedFiles: ["src/catalog.js"], reason: "Adopt real isolated source for regression.", prerequisites: [] };
  await adoptOperatorCandidate(task.id, request, { assertNoConflicts: () => {}, confirm: async () => "local-os:fixture" });
  await automationTick({ project: project.id });
  const openedAt = new Date(Date.now() - 60_000).toISOString();
  await mutateState(state => {
    const live = state.tasks.find(item => item.id === task.id);
    live.automationCircuit = {
      state: "open", scope: "task", reasonCode: "credit_budget_insufficient",
      attemptsConsumed: 0, maxAttempts: 0, openedAt, snapshot: workflowSnapshotForTask(live),
      failureFingerprint: "preserved-credit-failure",
    };
    live.automationBlocker = { type: "circuit", reason: "prior_exhaustion_unverified", actionType: "continue_review",
      modelTier: "balanced", estimatedCredits: 15, minRemainingPercent: 5,
      resumeStatus: live.status, blockedAt: openedAt, retryAt: "" };
    live.status = "blocked"; live.assignedAgentRole = "owner";
    live.automationAttemptEpoch = 3; live.lastAutomationFailure = "prior_exhaustion_unverified";
    state.meta.operatorPause = { active: true, reason: "Isolated fixture records all approvals before reconciliation." };
  });
  for (const stage of STAGES.slice(0, finalReview ? 4 : 3)) {
    await recordReview(task.id, { stage: stage.key, outcome: optionalFrontend && stage.key === "frontend" ? "skipped" : "approved", subjectSha: sha, candidateCycle: 1,
      author: "Independent fixture reviewer" });
  }
  await mutateState(state => { state.meta.operatorPause.active = false; });
  return { projectId: project.id, taskId: task.id, sha, openedAt };
}

const taskIn = (state, f) => state.tasks.find(task => task.id === f.taskId);
const taskReviews = (state, f) => state.reviews.filter(review => review.taskId === f.taskId);
const tick = f => automationTick({ project: f.projectId });

test("completed current reviews retire only their unstarted credit hold through the normal tick", async t => {
  const f = await fixture(t), before = await readStateReadOnly(), prior = taskIn(before, f);
  const result = await tick(f), after = await readStateReadOnly(), task = taskIn(after, f);
  assert.equal(task.status, "user_review");
  assert.equal(task.assignedAgentRole, "owner");
  assert.equal(task.automationCircuit.state, "superseded");
  assert.equal(task.automationBlocker, undefined);
  assert.equal(task.automationAttemptEpoch, prior.automationAttemptEpoch);
  assert.equal(task.stateVersion, prior.stateVersion + 1);
  assert.equal(task.lastAutomationFailure, "prior_exhaustion_unverified");
  assert.deepEqual(task.candidateIdentity, prior.candidateIdentity);
  assert.deepEqual(taskReviews(after, f), taskReviews(before, f));
  assert.deepEqual(task.automationCircuit.supersededBlocker, prior.automationBlocker);
  for (const [key, value] of Object.entries(prior.automationCircuit)) {
    if (key !== "state") assert.deepEqual(task.automationCircuit[key], value);
  }
  assert.deepEqual(after.runs, before.runs);
  assert.ok(result.actions.some(action => /completed.*review.*credit/i.test(action)));
  const report = createSupervisorReport(after);
  assert.ok(report.actions.some(action => action.taskId === f.taskId && action.type === "notify_owner"));
  assert.equal(report.actions.some(action => action.taskId === f.taskId && ["start_review", "continue_review", "start_builder"].includes(action.type)), false);
  assert.deepEqual((await tick(f)).actions, []);
  assert.deepEqual(taskIn(await readStateReadOnly(), f), task);
});

test("recording the last genuine approval uses the same retirement without a duplicate review", async t => {
  const f = await fixture(t, { finalReview: false });
  assert.equal(taskIn(await readStateReadOnly(), f).status, "blocked");
  await recordReview(f.taskId, { stage: "lead", outcome: "approved", subjectSha: f.sha, candidateCycle: 1,
    author: "Independent fixture reviewer" });
  const after = await readStateReadOnly();
  assert.equal(taskIn(after, f).status, "user_review");
  assert.equal(taskReviews(after, f).length, 4);
  assert.equal(after.runs.some(run => run.taskId === f.taskId), false);
});

test("incomplete, stale, invalidated, contradictory or unordered review evidence cannot retire the hold", async t => {
  const f = await fixture(t);
  const cases = {
    incomplete: (state, task, reviews) => { reviews.at(-1).outcome = "changes_requested"; },
    oldSubject: (state, task, reviews) => { reviews[0].subjectSha = "d".repeat(40); },
    oldCycle: (state, task, reviews) => { reviews[0].candidateCycle = 9; },
    oldReviewCycle: (state, task, reviews) => { reviews[0].cycle = 9; },
    invalidated: (state, task, reviews) => { reviews[0].invalidatedAt = new Date().toISOString(); },
    invalidationLedger: (state, task, reviews) => { task.evidenceInvalidations = [{ invalidationIds: [reviews[0].id] }]; },
    newerRejection: (state, task, reviews) => { state.reviews.push({ ...reviews[0], id: "review_99990", outcome: "changes_requested", createdAt: new Date().toISOString() }); },
    equalTimeRejection: (state, task, reviews) => { state.reviews.push({ ...reviews[0], id: "review_99991", outcome: "changes_requested" }); },
    unordered: (state, task, reviews) => { reviews[0].createdAt = new Date(Date.parse(reviews.at(-1).createdAt) + 1).toISOString(); },
    skippedLead: (state, task, reviews) => { reviews.at(-1).outcome = "skipped"; },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const state = await readStateReadOnly(), task = taskIn(state, f);
    patch(state, task, taskReviews(state, f));
    const before = structuredClone(task);
    await automationTick({ state, project: f.projectId });
    assert.deepEqual(task, before, name);
  }
});

test("newer review-credit generations and unrelated holds remain blocked", async t => {
  const f = await fixture(t);
  const cases = {
    newerCircuit: (state, task) => { task.automationCircuit.openedAt = task.automationBlocker.blockedAt = new Date().toISOString(); },
    differentGeneration: (state, task) => { task.automationBlocker.blockedAt = new Date().toISOString(); },
    builderCredit: (state, task) => { task.automationBlocker.actionType = "start_builder"; },
    taskBudget: (state, task) => { task.automationCircuit.reasonCode = "task_cost_budget_insufficient"; },
    consumedAttempt: (state, task) => { task.automationCircuit.attemptsConsumed = 1; },
    durableProjection: (state, task) => { task.automationBlocker.incidentId = "failure_preserved"; },
    projectHold: state => { state.projects.find(project => project.id === f.projectId).automationCircuit = { state: "open" }; },
    ownerHold: state => { state.meta.operatorPause.active = true; },
    budgetPause: (state, task) => { task.budgetPause = { reason: "preserved" }; },
    admissionPause: (state, task) => { task.creditAdmissionPause = { active: true }; },
    dependency: (state, task) => { task.dependsOnTaskIds = ["task_missing"]; },
    adoptionHold: (state, task) => { task.adoptionHeld = true; },
    activeRun: (state, task) => { state.runs.push({ id: "run_99990", taskId: task.id, status: "running" }); },
    activeLease: (state, task) => { task.workflowLease = { expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    currentCandidateChanged: (state, task) => {
      task.reviewSubjectSha = task.candidateIdentity.commitSha = "e".repeat(40);
      task.automationCircuit.snapshot = workflowSnapshotForTask(task, { status: "backend_review", assignedAgentRole: "backend-reviewer" });
    },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const state = await readStateReadOnly(), task = taskIn(state, f);
    patch(state, task); const before = structuredClone(task);
    await automationTick({ state, project: f.projectId });
    assert.deepEqual(task, before, name);
  }
});

function incidentInput(f) {
  return { taskId: f.taskId, action: "continue_review", provider: "codex", reasonCode: "provider_rate_limited",
    candidateIdentity: { commitSha: f.sha, candidateCycle: 1 },
    evidence: { provider: "codex", reasonCode: "provider_rate_limited" } };
}

test("an actual durable incident without its legacy projection prevents retirement", async t => {
  const f = await fixture(t);
  await claimFailureContainmentPaidAttempt(incidentInput(f));
  const before = await readStateReadOnly(), incidents = await readFailureIncidents({ taskId: f.taskId });
  assert.equal(incidents.length, 1);
  await tick(f);
  assert.deepEqual(taskIn(await readStateReadOnly(), f), taskIn(before, f));
  assert.deepEqual(await readFailureIncidents({ taskId: f.taskId }), incidents);
});

test("a durable incident inserted after preparation is detected under the writer fence and replay preserves the hold", async t => {
  const f = await fixture(t), before = await readStateReadOnly();
  let attempts = 0;
  await mutateState(async state => {
    await automationTick({ state, project: f.projectId });
    if (++attempts === 1) {
      assert.equal(taskIn(state, f).status, "user_review");
      await claimFailureContainmentPaidAttempt(incidentInput(f));
    }
  }, { operationName: "test.review_credit_incident_race" });
  const after = await readStateReadOnly();
  assert.equal(attempts, 2);
  assert.deepEqual(taskIn(after, f), taskIn(before, f));
  assert.equal(after.events.some(event => event.taskId === f.taskId && event.type === "review_credit_hold_superseded"), false);
  assert.equal((await readFailureIncidents({ taskId: f.taskId })).length, 1);
});

test("invalidated tied rejections and explicitly optional skipped lanes do not invalidate complete current approvals", async t => {
  const f = await fixture(t, { optionalFrontend: true });
  await mutateState(state => {
    const reviews = taskReviews(state, f);
    const invalidatedAt = new Date().toISOString();
    state.reviews.push({ ...reviews[0], id: "review_99992", outcome: "changes_requested",
      invalidatedAt, invalidation: { action: "fixture_invalidation", reasonCode: "superseded", invalidatedAt } });
  });
  await tick(f);
  assert.equal(taskIn(await readStateReadOnly(), f).status, "user_review");
});

test("a newer circuit committed during preparation survives ordinary state replay", async t => {
  const f = await fixture(t);
  let attempts = 0, newer;
  await mutateState(async state => {
    await automationTick({ state, project: f.projectId });
    if (++attempts === 1) {
      assert.equal(taskIn(state, f).status, "user_review");
      await mutateState(current => {
        const task = taskIn(current, f);
        task.automationCircuit.openedAt = task.automationBlocker.blockedAt = new Date().toISOString();
        task.automationCircuit.failureFingerprint = "newer-credit-generation";
        newer = structuredClone(task);
      });
    }
  }, { operationName: "test.review_credit_circuit_race" });
  assert.equal(attempts, 2);
  assert.deepEqual(taskIn(await readStateReadOnly(), f), newer);
});

test("a serialized snapshot cannot manufacture the private failure-ledger admission", async t => {
  const f = await fixture(t), original = await readStateReadOnly();
  const state = structuredClone(original);
  await automationTick({ state, project: f.projectId });
  assert.deepEqual(taskIn(state, f), taskIn(original, f));
});
