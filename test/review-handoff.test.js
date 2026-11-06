import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadProjectComponentImpactMapAtCommit, sha256Digest } from "../src/component-impact-map.js";
import { normalizeOperatorAdoptionRequest, verifyAdoptionCandidate } from "../src/impact-planner.js";
import test from "node:test";
import {
  createRemediationHandoff,
  currentRemediationHandoff,
  REMEDIATION_HANDOFF_LIMITS,
  remediationPromptSection,
  supersedeRemediationHandoff,
} from "../src/remediation-handoff.js";
import {
  addProject,
  addTask,
  adoptOperatorCandidate,
  readStateReadOnly,
  mutateState,
  transitionTask,
  generatePrompt,
  readState,
  recordReview,
  recordReviewInState,
  taskWithProject,
  updateTask,
  updateProject,
} from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

function review(id, body, patch = {}) {
  return {
    id,
    taskId: "task_1",
    projectId: "project_1",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: SUBJECT_SHA,
    stageKey: "backend",
    status: "backend_review",
    role: "backend-reviewer",
    outcome: "changes_requested",
    author: "Backend Lead",
    body,
    createdAt: `2026-08-17T10:00:0${id.replace(/\D/g, "") || 0}.000Z`,
    ...patch,
  };
}

function fixtureState() {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      validationCommands: ["npm test"],
      reviewPipeline: [
        {
          key: "backend",
          label: "Backend Review",
          role: "backend-reviewer",
          status: "backend_review",
          required: true,
        },
        {
          key: "lead",
          label: "Primary Lead Review",
          role: "lead-reviewer",
          status: "lead_review",
          required: true,
        },
      ],
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Repair candidate",
      type: "bug",
      status: "backend_review",
      priority: "high",
      branchName: "codex/demo-task_1",
      prUrl: "https://github.com/example/demo/pull/1",
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: SUBJECT_SHA,
      acceptanceCriteria: ["The rejected behavior is fixed."],
    }],
    runs: [],
    reviews: [],
    comments: [],
    events: [],
  };
}

test("handoffs deduplicate findings, preserve attribution, order severity, and redact sensitive data", () => {
  const task = fixtureState().tasks[0];
  const handoff = createRemediationHandoff(task, [
    review("review_1", "High: authorization bypass. Token: github_pat_abcdefghijk and owner@example.com in /Users/example/project."),
    review("review_2", "High: authorization bypass. Token: github_pat_abcdefghijk and owner@example.com in /Users/example/project.", {
      stageKey: "lead",
      role: "lead-reviewer",
      author: "Primary Lead",
    }),
    review("review_3", "Low: align the label spacing."),
  ], "2026-08-17T10:05:00.000Z");

  assert.equal(handoff.findings.length, 2);
  assert.equal(handoff.findings[0].severity, "high");
  assert.equal(handoff.findings[0].sources.length, 2);
  assert.deepEqual(handoff.findings[0].sources.map((source) => source.reviewId), ["review_1", "review_2"]);
  assert.doesNotMatch(JSON.stringify(handoff), /github_pat_|owner@example\.com|\/Users\/example/);
  assert.match(JSON.stringify(handoff), /REDACTED/);
});

test("recorded changes create an exact-candidate builder handoff without another discovery pass", () => {
  const state = fixtureState();
  state.tasks[0].candidateIdentity = {
    commitSha: SUBJECT_SHA,
    treeSha: "b".repeat(40),
    baseSha: "c".repeat(40),
    branch: "codex/exact-candidate",
    candidateCycle: 1,
  };
  const result = recordReviewInState(state, "task_1", {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "High: preserve the idempotency key across retries.\nRepro: retry a timed-out request.\nEvidence: https://local.test/evidence/1\nPatch boundary: src/retry.js only.",
  });
  const task = state.tasks[0];
  const prompt = generatePrompt(state, task.id, "builder");
  const detailed = taskWithProject(state, task);

  assert.equal(result.review.id, "review_1");
  assert.equal(task.status, "needs_changes");
  assert.equal(task.remediationHandoff.taskId, task.id);
  assert.equal(task.remediationHandoff.candidateCycle, 1);
  assert.equal(task.remediationHandoff.subjectSha, SUBJECT_SHA);
  assert.equal(detailed.currentRemediationHandoff.subjectSha, SUBJECT_SHA);
  assert.match(prompt, /Current reviewer remediation handoff/);
  assert.match(prompt, /preserve the idempotency key across retries/);
  assert.match(prompt, /Reproduction: retry a timed-out request/);
  assert.match(prompt, /Evidence: https:\/\/local\.test\/evidence\/1/);
  assert.match(prompt, /Approved patch boundary: src\/retry\.js only/);
  assert.match(prompt, /backend\/backend-reviewer \(review_1\)/);
  assert.match(prompt, new RegExp(SUBJECT_SHA));
  assert.match(prompt, /candidate tree: b{40}/);
  assert.match(prompt, /candidate base: c{40}/);
  assert.match(prompt, /candidate branch: codex\/exact-candidate/);
  assert.match(prompt, /Context efficiency contract:/);
  assert.match(prompt, /Cap ordinary inspection output at roughly 200 lines or 12 KB per command/);
  assert.match(prompt, /Do not push intermediate commits/);
  assert.match(prompt, /state-only updates must not push/);
});

test("superseded candidate findings are archived and excluded from later prompts", () => {
  const state = fixtureState();
  const task = state.tasks[0];
  task.remediationHandoff = createRemediationHandoff(task, [
    review("review_1", "Medium: fix the stale candidate only."),
  ]);

  supersedeRemediationHandoff(task, {
    status: "submitted",
    replacementSubjectSha: NEXT_SHA,
    resolution: "Builder submitted a replacement candidate.",
  });
  task.reviewSubjectCycle = 2;
  task.reviewSubjectSha = NEXT_SHA;
  const prompt = remediationPromptSection(task);

  assert.equal(currentRemediationHandoff(task), null);
  assert.equal(task.remediationHistory.at(-1).status, "submitted");
  assert.equal(task.remediationHistory.at(-1).replacementSubjectSha, NEXT_SHA);
  assert.doesNotMatch(prompt, /fix the stale candidate only/);
  assert.match(prompt, /No current reviewer remediation handoff/);
});

test("a persisted builder resubmission resolves the prior handoff and excludes it from the next candidate", async (t) => {
  const f = await operatorFixture(t);
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  await recordReview(f.task.id, {
    stage: "backend", outcome: "changes_requested", subjectSha: f.request.candidate.commitSha,
    candidateCycle: 1, body: "High: make the retry path idempotent.",
  });
  await writeFile(path.join(f.root, "src/catalog.js"), "export const version=3;\n");
  f.git("add", "."); f.git("commit", "-m", "Apply actual reviewer remediation");
  const nextSha = f.git("rev-parse", "HEAD");
  await updateTask(f.task.id, {
    status: "builder_review", subjectSha: nextSha, branchName: "feature/operator",
    candidateIdentity: { commitSha: nextSha, baseSha: f.request.candidate.baseSha, treeSha: f.git("rev-parse", "HEAD^{tree}"), branch: "feature/operator" },
    impactEvidence: { changedFiles: ["src/catalog.js"], unknown: false, backendRequired: true },
  });
  const state = await readState();
  const updated = state.tasks.find((item) => item.id === f.task.id);
  assert.equal(updated.remediationHandoff, null);
  assert.equal(updated.remediationHistory.at(-1).status, "submitted");
  assert.equal(updated.remediationHistory.at(-1).replacementSubjectSha, nextSha);
  assert.doesNotMatch(generatePrompt(state, f.task.id, "builder"), /make the retry path idempotent/);
});

test("builder prompt remediation text is bounded and points to an exact local artifact", () => {
  const task = fixtureState().tasks[0];
  task.remediationHandoff = createRemediationHandoff(
    task,
    Array.from({ length: REMEDIATION_HANDOFF_LIMITS.maxFindings + 4 }, (_, index) => (
      review(`review_${index + 1}`, `Medium: finding ${index + 1} ${"detail ".repeat(900)}`)
    )),
  );
  const prompt = remediationPromptSection(task);

  assert.ok(prompt.length <= REMEDIATION_HANDOFF_LIMITS.maxPromptCharacters + 500);
  assert.match(prompt, /additional finding\(s\) are available/);
  assert.match(prompt, new RegExp(`/api/tasks/task_1/remediation-handoff\\?candidateCycle=1&subjectSha=${SUBJECT_SHA}`));
});

test("task UI and local artifact route expose remediation status and pull request context", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function renderRemediationPanel\(task\)/);
  assert.match(app, /Reviewer Remediation/);
  assert.match(app, /Open PR/);
  assert.match(app, /Prior handoffs/);
  assert.match(server, /remediation-handoff/);
  assert.match(server, /Current remediation handoff not found for that exact candidate/);
});


async function operatorFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "operator-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture@example.invalid");
  const key = `operator-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
  const repository = `https://github.com/example/${key}`;
  git("remote", "add", "origin", repository);
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, "test")); await mkdir(path.join(root, "docs/architecture"), { recursive: true });
  await writeFile(path.join(root, "src/catalog.js"), "export const version=1;\n");
  await writeFile(path.join(root, "test/catalog.test.js"), "// Generic owned fixture test.\n");
  const map = { schemaVersion: 1, project: { key, repository }, aggregateCommand: "npm run check", components: {
    catalog: { publicContracts: ["catalog query"], services: ["catalog service"], owner: "fixture-engineering", aliases: [], capabilities: ["catalog"], paths: ["src/catalog.js", "test/catalog.test.js"],
      dependsOn: [], tests: [{ command: "node --test test/catalog.test.js", layer: "unit" }], reviewOwners: ["backend-reviewer"], rollback: "Restore the prior fixture revision." }
  } };
  await writeFile(path.join(root, "docs/architecture/components.json"), JSON.stringify(map));
  git("add", "."); git("commit", "-m", "Fixture base"); const baseSha = git("rev-parse", "HEAD");
  git("switch", "-c", "feature/operator");
  await writeFile(path.join(root, "src/catalog.js"), "export const version=2;\n");
  git("add", "."); git("commit", "-m", "Real fixture implementation");
  const project = await addProject({ key, name: "Generic operator fixture", workflowMode: "local", repoPath: root, sourceRepoPath: root, repoUrl: repository });
  const task = await addTask({ projectId: project.id, title: "Adopt real catalog repair", type: "bug", description: "A real local candidate enters engineering review.",
    status: "blocked", architectureRequired: false, workAreas: ["src/catalog.js"] });
  const head = git("rev-parse", "HEAD");
  const loaded = loadProjectComponentImpactMapAtCommit(project, head, { repoRoot: root });
  const current = (await readStateReadOnly()).tasks.find((item) => item.id === task.id);
  const request = { schemaVersion: 1, expectedStateVersion: current.stateVersion, projectId: project.id, repository,
    candidate: { baseSha, commitSha: head, treeSha: git("rev-parse", "HEAD^{tree}"), branch: "feature/operator" },
    mapDigest: loaded.digest, reviewedFiles: ["src/catalog.js"], reason: "Adopt the real locally prepared source repair.", prerequisites: [] };
  const authority = { assertNoConflicts: () => {}, confirm: async () => "local-os:fixture" };
  return { root, git, project, task, request, authority };
}

test("operator adoption strictly validates request data before authority or mutation", async (t) => {
  const f = await operatorFixture(t);
  for (const injected of [{ actorContext: { trusted: true } }, { plan: {} }, { provenance: "builder" }, { runId: "invented" }, { cycle: 9 }]) {
    await assert.rejects(adoptOperatorCandidate(f.task.id, { ...f.request, ...injected }, f.authority), /adoption_request_fields_invalid/);
  }
  for (const files of [["src/*"], ["../src/catalog.js"], ["src/catalog.js", "src/catalog.js"], ["src/catalog.js/"]]) {
    assert.throws(() => normalizeOperatorAdoptionRequest({ ...f.request, reviewedFiles: files }), /adoption_/);
  }
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { actorContext: { trusted: true } }), /adoption_executable_authority_required/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === f.task.id).operatorIntake, undefined);
});

test("real operator candidate preview is read-only and exact confirmed adoption is replay-idempotent", async (t) => {
  const f = await operatorFixture(t);
  const before = await readStateReadOnly();
  const preview = await adoptOperatorCandidate(f.task.id, f.request, f.authority, { preview: true });
  assert.equal(preview.candidate.commitSha, f.request.candidate.commitSha);
  assert.equal((await readStateReadOnly()).events.length, before.events.length);
  let confirmations = 0;
  const result = await adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async (binding) => {
    confirmations++; assert.deepEqual(binding, preview); return "local-os:fixture";
  } });
  let state = await readStateReadOnly();
  let task = state.tasks.find((item) => item.id === f.task.id);
  assert.equal(result.held, false); assert.equal(task.status, "builder_review");
  assert.deepEqual(task.impactScopePlan.allowedFileScope, ["src/catalog.js"]);
  assert.equal(task.operatorIntake.source, "operator"); assert.equal(task.reviewCycle, 1);
  assert.equal(state.runs.filter((run) => run.taskId === task.id).length, 0);
  const events = state.events.length;
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  state = await readStateReadOnly(); task = state.tasks.find((item) => item.id === f.task.id);
  assert.equal(task.reviewCycle, 1); assert.equal(state.events.length, events); assert.equal(confirmations, 1);
});

test("adoption retains incomplete dependencies and fails stale confirmation CAS atomically", async (t) => {
  const f = await operatorFixture(t);
  const dependency = await addTask({ projectId: f.project.id, title: "Existing prerequisite", description: "Real unfinished prerequisite remains intact.", type: "bug", status: "blocked", architectureRequired: false });
  await updateTask(f.task.id, { dependsOnTaskIds: [dependency.id] });
  const current = (await readStateReadOnly()).tasks.find((item) => item.id === f.task.id);
  f.request.expectedStateVersion = current.stateVersion;
  const result = await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  assert.equal(result.held, true); assert.deepEqual(result.unresolvedDependencies, [dependency.id]);
  const held = (await readStateReadOnly()).tasks.find((item) => item.id === f.task.id);
  assert.equal(held.status, "builder_review"); assert.deepEqual(held.dependsOnTaskIds, [dependency.id]);
  const g = await operatorFixture(t);
  await assert.rejects(adoptOperatorCandidate(g.task.id, g.request, { ...g.authority, confirm: async () => {
    await updateTask(g.task.id, { assignedThreadId: "competing-owner" }); return "local-os:fixture";
  } }), /adoption_task_stale/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === g.task.id).operatorIntake, undefined);
});

test("operator immutable verification rejects mismatched refs maps reviewed paths and unsafe Git types", async (t) => {
  const f = await operatorFixture(t);
  for (const request of [
    { ...f.request, mapDigest: `sha256:${"0".repeat(64)}` },
    { ...f.request, reviewedFiles: ["test/catalog.test.js"] },
    { ...f.request, candidate: { ...f.request.candidate, treeSha: "f".repeat(40) } },
    { ...f.request, candidate: { ...f.request.candidate, branch: "main" } },
  ]) await assert.rejects(adoptOperatorCandidate(f.task.id, request, f.authority), /adoption_/);
  const { symlink } = await import("node:fs/promises");
  await rm(path.join(f.root, "src/catalog.js")); await symlink("/etc/passwd", path.join(f.root, "src/catalog.js"));
  f.git("add", "."); f.git("commit", "-m", "Unsafe fixture type");
  const candidate = { ...f.request.candidate, commitSha: f.git("rev-parse", "HEAD"), treeSha: f.git("rev-parse", "HEAD^{tree}") };
  assert.throws(() => verifyAdoptionCandidate(f.project, candidate, { reviewedFiles: f.request.reviewedFiles, expectedMapDigest: f.request.mapDigest }), /adoption_/);
});


test("adoption rechecks moved refs after confirmation and preserves existing scope authority", async (t) => {
  const f = await operatorFixture(t);
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
    f.git("branch", "-f", "feature/moved", f.request.candidate.baseSha);
    f.git("update-ref", "refs/heads/feature/operator", f.request.candidate.baseSha);
    return "local-os:fixture";
  } }), /adoption_branch_moved/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === f.task.id).operatorIntake, undefined);
  const g = await operatorFixture(t);
  const first = await adoptOperatorCandidate(g.task.id, g.request, g.authority);
  const prior = (await readStateReadOnly()).tasks.find((item) => item.id === g.task.id);
  const frozen = structuredClone(prior.impactScopePlan);
  assert.equal(first.scopeDigest, prior.operatorIntake.scopeDigest);
  await adoptOperatorCandidate(g.task.id, g.request, g.authority);
  assert.deepEqual((await readStateReadOnly()).tasks.find((item) => item.id === g.task.id).impactScopePlan, frozen);
});

test("adoption refuses active ownership, unchanged failed material and cancelled confirmation", async (t) => {
  const f = await operatorFixture(t);
  await mutateState((state) => state.runs.push({ id: `fixture-run-${f.task.id}`, taskId: f.task.id, projectId: f.project.id,
    role: "builder", status: "failed", candidateIdentity: f.request.candidate, createdAt: new Date().toISOString() }));
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_unchanged_failed_material/);
  const g = await operatorFixture(t);
  await mutateState((state) => state.runs.push({ id: `fixture-run-${g.task.id}`, taskId: g.task.id, projectId: g.project.id,
    role: "builder", status: "queued", createdAt: new Date().toISOString() }));
  await assert.rejects(adoptOperatorCandidate(g.task.id, g.request, g.authority), /adoption_active_run/);
  const h = await operatorFixture(t);
  await assert.rejects(adoptOperatorCandidate(h.task.id, h.request, { ...h.authority, confirm: async () => undefined }), /adoption_owner_confirmation_invalid/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === h.task.id).operatorIntake, undefined);
});

test("verified prerequisite administrative disposition and adoption commit together with real immutable receipts", async (t) => {
  const f = await operatorFixture(t);
  const dependency = await addTask({ projectId: f.project.id, title: "Existing verified fixture map", description: "Current immutable artifact was already available.", type: "bug", status: "blocked", architectureRequired: false });
  const loaded = loadProjectComponentImpactMapAtCommit(f.project, f.request.candidate.baseSha, { repoRoot: f.root });
  const file = path.join(f.root, "verification-receipt.json");
  const bytes = JSON.stringify({ sourceSha: f.request.candidate.baseSha, mapDigest: loaded.digest, scope: "Generic existing inventory evidence" });
  await writeFile(file, bytes);
  const merge = { kind: "preexisting_merged_artifact", sourceSha: f.request.candidate.baseSha };
  const verification = { kind: "existing_current_inventory_verification", subjectSha: merge.sourceSha, mapDigest: loaded.digest,
    evidenceRefs: [{ path: file, sha256: createHash("sha256").update(bytes).digest("hex") }] };
  await updateTask(dependency.id, { mergeEvidence: merge, verificationEvidence: verification });
  await updateTask(f.task.id, { dependsOnTaskIds: [dependency.id] });
  const state = await readStateReadOnly();
  f.request.expectedStateVersion = state.tasks.find((item) => item.id === f.task.id).stateVersion;
  f.request.prerequisites = [{ taskId: dependency.id, expectedStateVersion: state.tasks.find((item) => item.id === dependency.id).stateVersion,
    evidenceDigest: sha256Digest({ merge, verification }), reason: "Dispose of already verified fixture inventory work." }];
  const wrong = structuredClone(f.request); wrong.prerequisites[0].evidenceDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(adoptOperatorCandidate(f.task.id, wrong, f.authority), /adoption_prerequisite_evidence_invalid/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === dependency.id).status, "blocked");
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  const after = await readStateReadOnly();
  assert.equal(after.tasks.find((item) => item.id === dependency.id).status, "closed");
  assert.equal(after.tasks.find((item) => item.id === dependency.id).preexistingWorkDisposition.kind, "preexisting_work_verified");
  assert.equal(after.tasks.find((item) => item.id === f.task.id).status, "builder_review");
  assert.equal(after.runs.filter((item) => [f.task.id, dependency.id].includes(item.taskId)).length, 0);
});

test("local CLI previews real candidate but denies noninteractive or spoofed owner commit", async (t) => {
  const f = await operatorFixture(t);
  const requestPath = path.join(f.root, "request.json"); await writeFile(requestPath, JSON.stringify(f.request));
  const cli = new URL("../src/mission-control-cli.js", import.meta.url).pathname;
  const run = (...args) => execFileSync(process.execPath, [cli, "adopt-candidate", f.task.id, "--request-file", requestPath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(run("--preview"));
  assert.equal(result.candidate.commitSha, f.request.candidate.commitSha);
  assert.throws(() => run(), /adoption_interactive_owner_required/);
  assert.throws(() => run("--actor-id", "forged", "--confirm", "ADOPT_CANDIDATE_V1"), /adoption_cli_arguments_invalid/);
  assert.equal((await readStateReadOnly()).tasks.find((item) => item.id === f.task.id).operatorIntake, undefined);
});


test("GitHub operator intake requires its normal PR before disposition or review routing", async (t) => {
  const f = await operatorFixture(t);
  await updateProject(f.project.id, { workflowMode: "github" });
  const state = await readStateReadOnly();
  f.request.expectedStateVersion = state.tasks.find((item) => item.id === f.task.id).stateVersion;
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_github_pr_required/);
  const after = await readStateReadOnly();
  assert.equal(after.tasks.find((item) => item.id === f.task.id).operatorIntake, undefined);
  assert.equal(after.runs.length, state.runs.length);
});


test("genuine changed operator remediation preserves prior receipt while metadata-only retries stay ineligible", async (t) => {
  const f = await operatorFixture(t);
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  const original = structuredClone((await readStateReadOnly()).tasks.find((item) => item.id === f.task.id).operatorIntake);
  await recordReview(f.task.id, { stage: "backend", outcome: "changes_requested", subjectSha: f.request.candidate.commitSha,
    candidateCycle: 1, body: "Correct the actual source behavior before another review." });
  f.git("commit", "--allow-empty", "-m", "Metadata without source remediation");
  let current = (await readStateReadOnly()).tasks.find((item) => item.id === f.task.id);
  let request = { ...f.request, expectedStateVersion: current.stateVersion, reason: "A new label does not repair the same source tree.",
    candidate: { ...f.request.candidate, commitSha: f.git("rev-parse", "HEAD"), treeSha: f.git("rev-parse", "HEAD^{tree}") } };
  await assert.rejects(adoptOperatorCandidate(f.task.id, request, f.authority), /adoption_unchanged_material/);
  await writeFile(path.join(f.root, "src/catalog.js"), "export const version=4;\n");
  f.git("add", "."); f.git("commit", "-m", "Actual corrected source");
  request = { ...request, candidate: { ...request.candidate, commitSha: f.git("rev-parse", "HEAD"), treeSha: f.git("rev-parse", "HEAD^{tree}") } };
  await adoptOperatorCandidate(f.task.id, request, f.authority);
  const state = await readStateReadOnly(); current = state.tasks.find((item) => item.id === f.task.id);
  assert.equal(current.reviewCycle, 2);
  assert.notEqual(current.operatorIntake.candidate.treeSha, original.candidate.treeSha);
  assert.deepEqual(state.events.find((event) => event.taskId === f.task.id && event.type === "operator_candidate_superseded").previousOperatorIntake, original);
  assert.equal(state.runs.filter((run) => run.taskId === f.task.id).length, 0);
});
