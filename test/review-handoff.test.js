import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import childProcess, { execFile, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadProjectComponentImpactMapAtCommit, sha256Digest } from "../src/component-impact-map.js";
import { normalizeOperatorAdoptionRequest, verifyAdoptionCandidate } from "../src/impact-planner.js";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
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
  addComment,
  completeArchitecture,
  addTask,
  adoptOperatorCandidate,
  applyFailureIncidentCompatibilityReadModelInState,
  readStateReadOnly,
  reconcileAutomationStateInState,
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
import {
  DATABASE_FILE,
  reconcileStateIntegrity,
  withStateDatabaseConnection,
  claimFailureContainmentPaidAttempt,
  openFailureContainmentCircuit,
  readFailureIncidents,
  recordFailureContainmentActivity,
  scheduleFailureContainmentBackoff,
} from "../src/state-database.js";
import { failureEvidence } from "../src/failure-containment.js";
import { claimCurrentFailureAttempt, claimRuns, completeRun, failureEvidenceForRun } from "../src/runner.js";

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

test("real public adoption keeps Git off-lock and commits after more than four unrelated process writes", async (t) => {
  const f = await operatorFixture(t);
  const other = await addTask({ projectId: f.project.id, title: "Independent metadata record", type: "bug", status: "blocked", architectureRequired: false, workAreas: ["test/catalog.test.js"] });
  await mutateState(state => state.events.push({ id: "event_0x10000", type: "unrelated_gap", message: "Current active ID gap", createdAt: new Date().toISOString() }));
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let confirmations = 0, verifications = 0, gitReads = 0, versionBeforeCommit;
  const actualGit = childProcess.execFileSync;
  childProcess.execFileSync = (binary, args, options) => {
    if (binary === "/usr/bin/git" && args.includes(f.root)) {
      const db = new DatabaseSync(DATABASE_FILE); db.exec("PRAGMA busy_timeout = 1");
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); gitReads++; }
      finally { db.close(); }
    }
    return actualGit(binary, args, options);
  };
  syncBuiltinESMExports();
  let result;
  try {
    const pending = adoptOperatorCandidate(f.task.id, f.request, { ...f.authority,
      assertNoConflicts: async () => { if (++verifications === 1) { enter(); await paused; } },
      confirm: async () => { confirmations++; return "local-os:fixture"; } });
    await entered;
    const writer = `
      import { addComment, mutateState, updateTask } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
      for (let index=0; index<6; index++) {
        await addComment(${JSON.stringify(other.id)}, "Concurrent unrelated comment " + index, "Fixture writer");
        await mutateState(state => { state.meta.adoptionCounter = (state.meta.adoptionCounter || 0) + 1; });
      }
      await updateTask(${JSON.stringify(other.id)}, { prUrl: "https://example.invalid/pull/1" });
    `;
    try {
      await Promise.race([new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", writer], { env: process.env }, (error) => error ? reject(error) : resolve())),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Off-lock adoption blocked unrelated writer")), 5000))]);
      const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
      try { versionBeforeCommit = db.prepare("SELECT version FROM state_meta").get().version; } finally { db.close(); }
    } finally { resume(); }
    result = await pending;
  } finally { childProcess.execFileSync = actualGit; syncBuiltinESMExports(); }
  const state = await readStateReadOnly(), task = state.tasks.find(item => item.id === f.task.id);
  assert.equal(confirmations, 1); assert.equal(verifications, 2); assert.ok(gitReads > 0);
  assert.equal(state.meta.adoptionCounter, 6); assert.equal(state.comments.filter(item => item.taskId === other.id).length, 6);
  assert.equal(state.tasks.find(item => item.id === other.id).prUrl, "https://example.invalid/pull/1");
  assert.equal(task.status, "builder_review"); assert.equal(task.reviewCycle, 1); assert.equal(result.held, false);
  const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
  try { assert.equal(db.prepare("SELECT version FROM state_meta").get().version, versionBeforeCommit + 1); } finally { db.close(); }
  const adoptionEvents = state.events.filter(item => item.taskId === task.id && ["operator_candidate_adopted", "lifecycle_transition"].includes(item.type));
  assert.equal(adoptionEvents.length, 2); assert.equal(new Set(state.events.map(item => item.id)).size, state.events.length);
  assert.ok(adoptionEvents.every(item => Number(item.id.split("_")[1]) > 0x10000 + 6));
});

test("real public adoption bounds its complete writer at retained payload scale", async (t) => {
  const f = await operatorFixture(t);
  const padded = (value, bytes, label) => ({ ...value, neutralMetadata: label.repeat(Math.max(0, bytes - Buffer.byteLength(JSON.stringify(value)))) });
  const seeded = {}, sizes = {}, currentTaskId = f.task.id;
  let writer, originalPrepare, originalExec, recording = false, beganAt, writerMs = 0, returnedPayloadBytes = 0;
  const statements = [];
  await withStateDatabaseConnection((db) => {
    writer = db;
    const seed = (table, prefix, count, bytes, make) => {
      const used = db.prepare(`SELECT id FROM ${table}`).all().map(row => Number(row.id.split("_")[1])).filter(Number.isFinite);
      const base = Math.max(1000000, ...used) + 1, rows = [];
      const columns = Object.keys(db.prepare(`PRAGMA table_info(${table})`).all().reduce((all, row) => ({ ...all, [row.name]: true }), {}));
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (let index = 0; index < count; index++) {
        const id = `${prefix}_${base + index}`, value = padded(make(id, index), bytes, "x"), payload = JSON.stringify(value);
        const row = { id, sequence: base + index, project_id: value.projectId || "", task_id: value.taskId || "", key: value.key || "",
          status: value.status || "", state_version: value.stateVersion || 1, assigned_role: value.assignedRole || "",
          role: value.role || "", outcome: value.outcome || "", type: value.type || "", manifest_digest: value.manifestDigest || "",
          integration_commit: value.integrationCommit || "", created_at: value.createdAt || "", updated_at: value.updatedAt || "", payload };
        insert.run(...columns.map(column => row[column])); rows.push(id);
        sizes[table] = (sizes[table] || 0) + Buffer.byteLength(payload);
      }
      seeded[table] = rows; return rows;
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      const projectIds = seed("projects", "project", 15, 2400, (id, i) => ({ id, key: `neutral-${i}`, repoPath: `/nonexistent/neutral-${i}`, repoUrl: `https://example.invalid/neutral-${i}` }));
      const taskIds = seed("tasks", "task", 1159, 9000, (id, i) => ({ ...f.task, id, projectId: projectIds[i % projectIds.length],
        title: "Independent retained task", status: "blocked", stateVersion: 1, dependsOnTaskIds: [], parentTaskId: "", architectureParentTaskId: "",
        architectureDecisionTaskIds: [], candidateId: "", qaBundleId: "", workAreas: ["test/catalog.test.js"] }));
      seed("runs", "run", 2502, 14500, id => ({ id, projectId: projectIds[0], taskId: taskIds[0], role: "builder", group: "builder", status: "completed" }));
      const candidateIds = seed("candidates", "candidate", 107, 20400, id => ({
        ...createCandidateEnvelope({ candidateId: id, projectId: projectIds[0],
          base: { branch: "main", sha: f.request.candidate.baseSha },
          sources: [{ taskId: taskIds[0], sourceRef: "refs/heads/feature/operator", headSha: f.request.candidate.commitSha, candidateCycle: 1,
            reviews: [{ id: `review_${id}`, stageKey: "lead", role: "lead-reviewer", outcome: "approved", subjectSha: f.request.candidate.commitSha,
              candidateCycle: 1, reviewedAt: "2026-01-01T00:00:00.000Z" }] }],
          assembly: { mode: "atomic", requestedTaskIds: [taskIds[0]], includedTaskIds: [taskIds[0]], excludedTaskIds: [] },
          integration: { branch: "qa/neutral", sha: f.request.candidate.commitSha },
          checks: [{ id: `check_${id}`, kind: "local-validation", name: "Neutral retained fixture", outcome: "passed", subjectSha: f.request.candidate.commitSha, evidenceDigest: sha256Digest(id) }],
          preview: { url: "http://127.0.0.1:4174/", status: "healthy", commitSha: f.request.candidate.commitSha,
            verifiedAt: "2026-01-01T00:00:00.000Z", attestation: { kind: "header", key: "x-studioops-commit", observedSha: f.request.candidate.commitSha } } }),
        status: "invalidated", invalidation: { reason: "Neutral retained fixture", observedAt: "2026-01-01T00:00:00.000Z", expected: "", observed: "" },
      }));
      seed("qa_bundles", "qa_bundle", 115, 21000, id => ({ id, projectId: projectIds[0], status: "invalidated", candidateId: candidateIds[0], integrationCommit: "", tasks: [{ id: taskIds[0] }] }));
      seed("reviews", "review", 2546, 1200, id => ({ id, taskId: taskIds[0], projectId: projectIds[0], role: "backend-reviewer", outcome: "changes_requested" }));
      seed("events", "event", 29549, 320, id => ({ id, taskId: taskIds[0], projectId: projectIds[0], type: "neutral_metadata", machineGenerated: true }));
      // Use the real owner normalization for retained inactive records, rather
      // than inventing a candidate/bundle schema or bypassing its later guards.
      const fixtureState = { meta: {}, notificationOutbox: [] };
      for (const [key, table] of Object.entries({ projects: "projects", tasks: "tasks", candidates: "candidates", qaBundles: "qa_bundles" })) {
        fixtureState[key] = db.prepare(`SELECT payload FROM ${table}`).all().map(row => JSON.parse(row.payload));
      }
      reconcileStateIntegrity(fixtureState);
      for (const [key, table] of Object.entries({ tasks: "tasks", candidates: "candidates", qaBundles: "qa_bundles" })) {
        const ids = new Set(seeded[table]), update = db.prepare(`UPDATE ${table} SET payload = ?, status = ? WHERE id = ?`);
        for (const row of fixtureState[key]) if (ids.has(row.id)) update.run(JSON.stringify(row), row.status, row.id);
      }
      const insert = db.prepare("INSERT INTO events (id,sequence,project_id,task_id,type,created_at,payload) VALUES (?,?,?,?,?,?,?)");
      for (let index = 0; index < 55; index++) {
        const id = `event_${2000000 + index}`, event = { id, taskId: currentTaskId, projectId: f.project.id,
          type: "lifecycle_transition", machineGenerated: true, createdAt: "2026-01-01T00:00:00.000Z", message: "Retained transition metadata" };
        insert.run(id, 2000000 + index, f.project.id, currentTaskId, event.type, event.createdAt, JSON.stringify(event));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    originalPrepare = db.prepare; originalExec = db.exec;
    db.exec = function(sql) {
      if (sql === "BEGIN IMMEDIATE") { recording = true; beganAt = performance.now(); }
      try { return originalExec.call(this, sql); }
      finally { if (["COMMIT", "ROLLBACK"].includes(sql) && recording) { writerMs = performance.now() - beganAt; recording = false; } }
    };
    db.prepare = function(sql) {
      const statement = originalPrepare.call(this, sql);
      if (!recording) return statement;
      statements.push(sql);
      const observe = row => { if (typeof row?.payload === "string") returnedPayloadBytes += Buffer.byteLength(row.payload); return row; };
      return new Proxy(statement, { get(target, key) {
        if (key === "all") return (...args) => target.all(...args).map(observe);
        if (key === "get") return (...args) => observe(target.get(...args));
        if (key === "iterate") return function*(...args) { for (const row of target.iterate(...args)) yield observe(row); };
        const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
      } });
    };
  });
  t.after(async () => {
    if (writer && originalPrepare) { writer.prepare = originalPrepare; writer.exec = originalExec; }
    await withStateDatabaseConnection(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [table, ids] of Object.entries(seeded)) {
          const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`); for (const id of ids) remove.run(id);
        }
        const removeArchive = db.prepare("DELETE FROM operational_archive WHERE entity_type = 'events' AND entity_id = ?");
        for (const id of seeded.events || []) removeArchive.run(id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  });
  let result;
  try { result = await adoptOperatorCandidate(f.task.id, f.request, f.authority); }
  finally { writer.prepare = originalPrepare; writer.exec = originalExec; }
  assert.equal(result.status, "builder_review");
  const db = new DatabaseSync(DATABASE_FILE, { readOnly: true });
  try {
    const task = JSON.parse(db.prepare("SELECT payload FROM tasks WHERE id = ?").get(f.task.id).payload);
    assert.equal(task.status, "builder_review"); assert.equal(task.reviewCycle, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'operator_candidate_adopted'").get(f.task.id).n, 1);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM operational_archive WHERE task_id = ? AND entity_type = 'events'").get(f.task.id).n > 0, "actual retained transition group was archived");
    const event = db.prepare("SELECT id FROM events WHERE task_id = ? AND type = 'operator_candidate_adopted'").get(f.task.id);
    assert.ok(Number(event.id.split("_")[1]) > 2000054, "events use the actual current active namespace");
  } finally { db.close(); }
  assert.ok(sizes.tasks > 10000000 && sizes.runs > 36000000 && sizes.candidates > 2000000 && sizes.qa_bundles > 2300000);
  assert.ok(writerMs > 0 && writerMs < 1000, `complete writer took ${writerMs.toFixed(1)}ms`);
  assert.ok(returnedPayloadBytes < 1000000, "unrelated large payload bodies stay outside the lock-held current read set");
  assert.ok(!statements.some(sql => /SUM\(length\(CAST\(payload AS BLOB\)/.test(sql)), "no duplicate whole-payload byte scan");
  assert.ok(!statements.some(sql => /SELECT \*.*FROM (?:candidates|qa_bundles) LIMIT/.test(sql)), "proof bodies use current related selectors");
  t.diagnostic(JSON.stringify({ seededPayloadBytes: sizes, lockHeldMs: writerMs, lockHeldReturnedPayloadBytes: returnedPayloadBytes, queries: statements.length }));
});

test("projected adoption directories retain typed absence and new graph-child semantics", async (t) => {
  for (const variant of ["missing-to-null", "array-to-string", "repository-false", "existing-child"]) await t.test(variant, async () => {
    const f = await operatorFixture(t);
    const project = await addProject({ key: `neutral-${variant}-${f.task.id}`, name: "Independent directory fixture", workflowMode: "local" });
    const other = await addTask({ projectId: project.id, title: "Independent directory member", status: "blocked", type: "bug", architectureRequired: false, workAreas: ["test/catalog.test.js"] });
    const change = (table, id, mutate) => withStateDatabaseConnection(db => {
      const row = JSON.parse(db.prepare(`SELECT payload FROM ${table} WHERE id = ?`).get(id).payload);
      mutate(row); db.prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`).run(JSON.stringify(row), id);
    });
    if (variant === "missing-to-null") await change("tasks", other.id, row => { delete row.description; });
    if (variant === "repository-false") await change("projects", project.id, row => { delete row.remoteUrl; });
    await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
      if (variant === "missing-to-null") await change("tasks", other.id, row => { row.description = null; });
      if (variant === "array-to-string") await change("tasks", other.id, row => { row.workAreas = "test/catalog.test.js"; });
      if (variant === "repository-false") await change("projects", project.id, row => { row.remoteUrl = false; });
      if (variant === "existing-child") await change("tasks", other.id, row => { row.architectureParentTaskId = f.task.id; });
      return "local-os:fixture";
    } }), /adoption_preimage_stale/);
    const task = (await readStateReadOnly()).tasks.find(row => row.id === f.task.id);
    assert.equal(task.operatorIntake, undefined); assert.equal(task.status, "blocked"); assert.equal(task.stateVersion, f.request.expectedStateVersion);
  });
});

test("adoption rejects changed relevant footprints and new conflict-directory membership atomically", async (t) => {
  for (const scenario of ["project_policy", "scope", "new_task", "new_queue", "failed_material", "material_history", "repository_alias", "dependency"]) {
    await t.test(scenario, async (t) => {
      const f = await operatorFixture(t);
      const peer = await addTask({ projectId: f.project.id, title: "Existing separate owner", type: "bug", status: "blocked", architectureRequired: false, workAreas: ["test/catalog.test.js"] });
      if (scenario === "dependency") { await updateTask(f.task.id, { dependsOnTaskIds: [peer.id] });
        f.request.expectedStateVersion = (await readStateReadOnly()).tasks.find(item => item.id === f.task.id).stateVersion; }
      let changed;
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
        if (scenario === "project_policy") await updateProject(f.project.id, { standards: ["changed-review-standard"] });
        if (scenario === "scope") await updateTask(peer.id, { workAreas: ["src/catalog.js"] });
        if (scenario === "new_task") await addTask({ projectId: f.project.id, title: "New overlapping task", type: "bug", status: "blocked", architectureRequired: false, workAreas: ["src/catalog.js"] });
        if (scenario === "new_queue") await mutateState(state => state.runs.push({ id: `run_concurrent_${peer.id}`, projectId: f.project.id, taskId: peer.id, role: "builder", status: "queued" }));
        if (scenario === "failed_material") await mutateState(state => state.runs.push({ id: `run_failed_${f.task.id}`, projectId: f.project.id, taskId: f.task.id, role: "builder", status: "failed", candidateIdentity: f.request.candidate }));
        if (scenario === "material_history") await mutateState(state => state.events.push({ id: `event_other_${f.task.id}`, projectId: f.project.id, taskId: f.task.id, type: "operator_candidate_adopted", candidate: f.request.candidate }));
        if (scenario === "repository_alias") await updateProject(f.project.id, { sourceRepoPath: path.join(f.root, "changed-root") });
        if (scenario === "dependency") await updateTask(peer.id, { assignedThreadId: "new-dependency-owner" });
        changed = await readStateReadOnly(); return "local-os:fixture";
      } }), /adoption_(?:preimage|task|prerequisite)_stale|operator_candidate_active_run/);
      const after = await readStateReadOnly();
      assert.deepEqual(after.tasks, changed.tasks); assert.deepEqual(after.events, changed.events); assert.deepEqual(after.runs, changed.runs);
      assert.equal(after.tasks.find(item => item.id === f.task.id).operatorIntake, undefined);
    });
  }
});

test("adoption reads the real inherited architecture graph before confirmation", async (t) => {
  const f = await operatorFixture(t);
  const parent = await addTask({ projectId: f.project.id, title: "Architecture gate", type: "architecture", status: "architecture_pending", architectureRequired: true });
  const contract = { architectureRequired: true, architectureApproved: true, architectureParentTaskId: parent.id,
    parentTaskId: parent.id, lane: "backend", userStory: "As a fixture owner I need a bounded implementation.",
    expectedOutcome: "A reviewable exact source candidate.", acceptanceCriteria: ["Canonical scope is retained."], description: "Existing architecture constraints.", workAreas: ["src/catalog.js"] };
  await updateTask(f.task.id, { ...contract, status: "architecture_pending" });
  const sibling = await addTask({ ...contract, projectId: f.project.id, title: "Related graph child", type: "bug", status: "idea", architectureApproved: true });
  await completeArchitecture(parent.id, { taskIds: [f.task.id, sibling.id], summary: "Keep one canonical catalog owner and immutable review coordinates. Each child preserves existing scope and completes its registered focused and full regression before release." });
  f.request.expectedStateVersion = (await readStateReadOnly()).tasks.find(item => item.id === f.task.id).stateVersion;
  let changed;
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
    await updateTask(sibling.id, { acceptanceCriteria: [] }); changed = await readStateReadOnly(); return "local-os:fixture";
  } }), /adoption_preimage_stale/);
  const after = await readStateReadOnly(); assert.deepEqual(after.tasks, changed.tasks); assert.deepEqual(after.events, changed.events);
});

test("public adoption keeps its authoritative late coordination fence", async (t) => {
  const f = await operatorFixture(t);
  const { claimResourceLease } = await import("../src/coordination.js");
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
    const result = await claimResourceLease({ resourceKey: `adoption:${f.task.id}`, aggregateType: "task", aggregateId: f.task.id,
      ownerProcessIdentity: "fixture:competing-owner", expectedStateVersion: f.request.expectedStateVersion, leaseTtlMs: 10000 });
    assert.equal(result.acquired, true); return "local-os:fixture";
  } }), /operator_candidate_coordination_lease_active/);
  assert.equal((await readStateReadOnly()).tasks.find(item => item.id === f.task.id).operatorIntake, undefined);
});

test("new related proof membership without a task version change invalidates adoption", async (t) => {
  for (const kind of ["review", "candidate", "bundle"]) await t.test(kind, async (t) => {
    const f = await operatorFixture(t); let expected;
    t.after(async () => withStateDatabaseConnection(db => {
      const table = {review: "reviews", candidate: "candidates", bundle: "qa_bundles"}[kind];
      // Remove only the row introduced by this isolated negative fixture.
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(`${kind}_race_${f.task.id}`);
    }));
    await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
      // Isolated storage race: an independent authority row can appear without
      // changing the task/global version. No QA grant or fake scope is minted.
      await withStateDatabaseConnection(db => {
        if (kind === "review") {
          const row = { id: `review_race_${f.task.id}`, taskId: f.task.id, outcome: "changes_requested" };
          db.prepare("INSERT INTO reviews(id, sequence, task_id, outcome, created_at, payload) VALUES (?, 900000, ?, ?, '', ?)").run(row.id, f.task.id, row.outcome, JSON.stringify(row));
        } else if (kind === "candidate") {
          const row = { id: `candidate_race_${f.task.id}`, projectId: f.project.id, status: "frozen", manifestDigest: "sha256:" + "a".repeat(64), manifest: { sources: [{taskId: f.task.id}] } };
          db.prepare("INSERT INTO candidates(id, sequence, project_id, status, manifest_digest, updated_at, payload) VALUES (?, 900000, ?, ?, ?, '', ?)").run(row.id, row.projectId, row.status, row.manifestDigest, JSON.stringify(row));
        } else {
          const row = { id: `bundle_race_${f.task.id}`, projectId: f.project.id, status: "ready", tasks: [{id: f.task.id}] };
          db.prepare("INSERT INTO qa_bundles(id, sequence, project_id, status, integration_commit, updated_at, payload) VALUES (?, 900000, ?, ?, '', '', ?)").run(row.id, row.projectId, row.status, JSON.stringify(row));
        }
      });
      expected = await readStateReadOnly(); return "local-os:fixture";
    } }), /adoption_preimage_stale/);
    const after = await readStateReadOnly(); assert.deepEqual(after.tasks, expected.tasks); assert.deepEqual(after.events, expected.events);
    assert.equal(after.tasks.find(item => item.id === f.task.id).operatorIntake, undefined);
  });
});

test("concurrent same-digest confirmations create one intake and later exact replay stays read-only", async (t) => {
  const f = await operatorFixture(t); let confirmed = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  const authority = { ...f.authority, confirm: async () => { if (++confirmed === 2) release(); await both; return "local-os:fixture"; } };
  const results = await Promise.allSettled([adoptOperatorCandidate(f.task.id, f.request, authority), adoptOperatorCandidate(f.task.id, f.request, authority)]);
  assert.equal(confirmed, 2); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.code, /adoption_task_stale/);
  const before = await readStateReadOnly();
  assert.equal(before.events.filter(event => event.taskId === f.task.id && event.type === "operator_candidate_adopted").length, 1);
  const replay = await adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => { throw new Error("Replay must not confirm again"); } });
  assert.equal(replay.replay, true); assert.deepEqual(await readStateReadOnly(), before);
});

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

async function prerequisiteFailureFixture(t, options = {}) {
  const f = await operatorFixture(t);
  const dependency = await addTask({ projectId: f.project.id, title: "Existing verified prerequisite", description: "Previously produced inventory has immutable source verification.", type: "bug", status: "blocked", architectureRequired: false });
  const loaded = loadProjectComponentImpactMapAtCommit(f.project, f.request.candidate.baseSha, { repoRoot: f.root });
  const receiptPath = path.join(f.root, "prerequisite-verification.json");
  const bytes = JSON.stringify({ sourceSha: f.request.candidate.baseSha, mapDigest: loaded.digest, scope: "Generic prerequisite inventory" });
  await writeFile(receiptPath, bytes);
  const merge = { kind: "preexisting_merged_artifact", sourceSha: f.request.candidate.baseSha };
  const verification = { kind: "existing_current_inventory_verification", subjectSha: merge.sourceSha, mapDigest: loaded.digest,
    evidenceRefs: [{ path: receiptPath, sha256: createHash("sha256").update(bytes).digest("hex") }] };
  await updateTask(dependency.id, { mergeEvidence: merge, verificationEvidence: verification });
  await updateTask(f.task.id, { dependsOnTaskIds: [dependency.id] });
  const ledgerTask = options.wrongTask
    ? await addTask({ projectId: f.project.id, title: "Unrelated failure owner", description: "A different task cannot authorize prerequisite recovery.", type: "bug", status: "blocked", architectureRequired: false })
    : dependency;
  const run = { id: `run_prerequisite_${dependency.id}`, taskId: ledgerTask.id, projectId: f.project.id,
    group: "builder", role: "builder", actionType: "start_builder", provider: "codex-sdk", status: "running",
    startedAt: new Date(Date.now() - 100).toISOString(), executionCommitSha: f.request.candidate.baseSha, candidateCycle: 0,
    impactPlan: { manifest: { digest: loaded.digest } },
    failureContainmentAdmission: { consulted: true, decision: "admitted", authority: "dispatcher_read_only",
      claimBoundary: "runner_pre_provider_launch", actionIdentity: "start_builder", provider: "codex" } };
  const evidence = options.native ? failureEvidence(failureEvidenceForRun({ ...run, project: f.project, task: dependency }, await readStateReadOnly()))
    : failureEvidence({ repository: { branch: "main", commitSha: f.request.candidate.baseSha },
    configurationDigest: `sha256:${"1".repeat(64)}`, policyDigest: `sha256:${"2".repeat(64)}`, componentMapDigest: loaded.digest });
  const input = { taskId: ledgerTask.id, action: "start_builder", provider: "codex", reasonCode: "output_guard_exceeded",
    candidateIdentity: { commitSha: f.request.candidate.baseSha }, evidence: evidence.value };
  let ancestor, providerInput, providerSuccessor;
  const time = (offset) => new Date(Date.now() + offset).toISOString();
  assert.equal((await claimFailureContainmentPaidAttempt({ ...input, initiator: "runner", transport: "codex_sdk",
    now: options.native ? time(-5000) : "2026-10-01T00:00:00.000Z" })).admitted, true);
  if (options.native) {
    if (options.twoReasons) {
      providerInput = { ...input, reasonCode: "provider_unavailable" };
      await claimFailureContainmentPaidAttempt({ ...providerInput, initiator: "runner", transport: "codex_sdk", now: time(-4000) });
      await recordFailureContainmentActivity({ ...providerInput, type: "cheap_probe", outcome: "failed",
        verifier: { id: "service_health_probe" }, now: time(-3500) });
      await claimFailureContainmentPaidAttempt({ ...providerInput, initiator: "runner", transport: "codex_sdk", now: time(-3000) });
      const repaired = failureEvidence({ ...evidence.value, configurationDigest: `sha256:${"5".repeat(64)}` });
      providerSuccessor = await recordFailureContainmentActivity({ ...providerInput, evidence: repaired.value,
        type: "cheap_probe", outcome: "passed", now: time(-1000),
        verifier: { id: "service_health_probe", outcome: "passed", evidenceDigest: repaired.digest } });
      providerInput = { ...providerInput, evidence: repaired.value };
    }
    const cancelled = options.twoReasons ? [1, 2].map((index) => ({ id: `${run.id}_queued_${index}`, taskId: ledgerTask.id,
      projectId: f.project.id, group: "builder", role: "builder", actionType: "start_builder", provider: "codex-cli",
      status: "queued", createdAt: time(-500 + index), attempt: 3, maxAttempts: 2,
      failureContainmentAdmission: structuredClone(run.failureContainmentAdmission) })) : [];
    if (cancelled.length) {
      assert.deepEqual(await claimRuns({ state: { meta: {}, projects: [f.project], tasks: [dependency], runs: cancelled, events: [], comments: [] } }), []);
      for (const row of cancelled) { assert.equal(row.status, "cancelled"); assert.equal(row.startedAt, undefined); assert.equal(row.failureContainmentClaim, undefined); }
    }
    run.startedAt = time(0);
    await mutateState((state) => { state.runs.push(...structuredClone(cancelled), structuredClone(run)); });
    if (options.twoReasons) {
      const claimed = await claimCurrentFailureAttempt(run);
      assert.equal(claimed.admitted, true);
      assert.equal(claimed.incident.incidentId, providerSuccessor.incidentId);
      assert.equal(run.failureContainmentClaim.reasonCode, "provider_unavailable");
    }
    const terminal = await completeRun(run.id, { status: "failed", exitCode: "command_output_budget_exceeded" });
    assert.equal(terminal.failureContainmentError, undefined);
    assert.equal(terminal.failureContainmentClaim.reasonCode, "output_guard_exceeded", "The native producer overwrites the prior admission claim");
    ancestor = (await readFailureIncidents({ taskId: ledgerTask.id })).find((item) => item.reasonCode === "output_guard_exceeded");
    await mutateState((state) => reconcileAutomationStateInState(state));
    const task = (await readStateReadOnly()).tasks.find((item) => item.id === dependency.id);
    assert.deepEqual(Object.keys(task.automationBlocker).sort(), ["type", "reason", "incidentId", "resource", "retryAt", "blockedAt"].sort());
    assert.equal(task.automationBlocker.type, "failure_containment");
    assert.equal(task.automationCircuit.state, "superseded");
  } else {
    assert.equal((await claimFailureContainmentPaidAttempt({ ...input, now: "2026-10-01T00:00:01.000Z" })).admitted, true);
    ancestor = await openFailureContainmentCircuit({ ...input, now: "2026-10-01T00:00:02.000Z" });
    await mutateState((state) => {
    const task = state.tasks.find((item) => item.id === dependency.id);
    const projected = { ...structuredClone(task), id: ledgerTask.id };
    applyFailureIncidentCompatibilityReadModelInState({ events: [] }, projected, ancestor, { snapshot: { status: "blocked" } });
    // Model the existing stale pointer, without manufacturing an independent
    // open compatibility circuit or changing the authoritative ledger rows.
    task.automationBlocker = structuredClone(projected.automationBlocker);
    });
  }
  const changed = failureEvidence({ ...evidence.value, policyDigest: `sha256:${"3".repeat(64)}` });
  async function recover(overrides = {}) {
    return recordFailureContainmentActivity({ ...input, evidence: changed.value, type: "cheap_probe", outcome: "passed",
      verifier: { id: "policy_probe", outcome: "passed", evidenceDigest: changed.digest },
      now: options.native ? time(0) : "2026-10-01T00:01:00.000Z", ...overrides });
  }
  async function refreshRequestVersions() {
    const state = await readStateReadOnly();
    f.request.expectedStateVersion = state.tasks.find((item) => item.id === f.task.id).stateVersion;
    f.request.prerequisites = [{ taskId: dependency.id, expectedStateVersion: state.tasks.find((item) => item.id === dependency.id).stateVersion,
      evidenceDigest: sha256Digest({ merge, verification }), reason: "Close the already verified prerequisite during actual source adoption." }];
  }
  await refreshRequestVersions();
  return { ...f, dependency, ledgerTask, ancestor, input, changed, recover, refreshRequestVersions,
    run, providerInput, providerSuccessor };
}

async function prerequisiteTasksSnapshot(f) {
  const state = await readStateReadOnly();
  const ids = new Set([f.task.id, f.dependency.id]);
  return { tasks: state.tasks.filter((item) => ids.has(item.id)), runs: state.runs.filter((item) => ids.has(item.taskId)),
    events: state.events.filter((item) => ids.has(item.taskId)) };
}

test("actual native failure producer's minimal stale pointer closes atomically after verified recovery", async (t) => {
  const f = await prerequisiteFailureFixture(t, { native: true });
  await f.recover();
  const before = await prerequisiteTasksSnapshot(f);
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  const after = await prerequisiteTasksSnapshot(f), prerequisite = after.tasks.find((item) => item.id === f.dependency.id);
  assert.equal(prerequisite.status, "closed");
  assert.equal(prerequisite.automationBlocker, undefined);
  assert.deepEqual(prerequisite.preexistingWorkDisposition.failureRecovery.previousBlocker,
    before.tasks.find((item) => item.id === f.dependency.id).automationBlocker);
  assert.equal(prerequisite.preexistingWorkDisposition.failureRecovery.ancestorGeneration, 1);
  assert.deepEqual(after.runs, before.runs);
});

test("native stale-pointer recovery rejects unknown shape and supplied identity conflicts", async (t) => {
  for (const scenario of ["wrong_resource", "wrong_reason", "wrong_incident", "supplied_generation", "supplied_evidence", "unknown_field", "unknown_type"]) {
    await t.test(scenario, async (t) => {
      const f = await prerequisiteFailureFixture(t, { native: true });
      const successor = await f.recover();
      await mutateState((state) => {
        const blocker = state.tasks.find((item) => item.id === f.dependency.id).automationBlocker;
        if (scenario === "wrong_resource") blocker.resource = `${f.project.id}:another-task`;
        if (scenario === "wrong_reason") blocker.reason = "provider_unavailable";
        if (scenario === "wrong_incident") blocker.incidentId = successor.incidentId;
        if (scenario === "supplied_generation") blocker.incidentGeneration = 9;
        if (scenario === "supplied_evidence") blocker.evidenceDigest = `sha256:${"0".repeat(64)}`;
        if (scenario === "unknown_field") blocker.verified = true;
        if (scenario === "unknown_type") blocker.type = "legacy_failure";
      });
      await f.refreshRequestVersions();
      const before = await prerequisiteTasksSnapshot(f);
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_prerequisite_unresolved_incident/);
      assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    });
  }
});

test("repaired provider admission followed by an actual different native output failure is historical bookkeeping", async (t) => {
  const f = await prerequisiteFailureFixture(t, { native: true, twoReasons: true });
  const successor = await f.recover();
  const before = await prerequisiteTasksSnapshot(f), ledger = await readFailureIncidents({ taskId: f.dependency.id });
  await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  const after = await prerequisiteTasksSnapshot(f), prerequisite = after.tasks.find((item) => item.id === f.dependency.id);
  assert.equal(prerequisite.status, "closed");
  assert.equal(after.tasks.find((item) => item.id === f.task.id).status, "builder_review");
  const recovery = prerequisite.preexistingWorkDisposition.failureRecovery;
  assert.equal(recovery.successorIncidentId, successor.incidentId);
  assert.equal(recovery.supportingAdmissions.length, 1);
  const support = recovery.supportingAdmissions[0];
  assert.equal(support.successorIncidentId, f.providerSuccessor.incidentId);
  assert.equal(support.terminalRunId, f.run.id);
  assert.equal(support.association, "corroborated_native_admission_with_overwritten_prior_claim");
  for (const field of ["ancestorRecordDigest", "successorRecordDigest", "terminalRunRecordDigest", "runInventoryRecordDigest", "taskRunBindingDigest"]) assert.match(support[field], /^sha256:[a-f0-9]{64}$/);
  assert.equal(after.runs.filter((item) => item.status === "cancelled" && !Object.hasOwn(item, "startedAt")).length, 2);
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(await readFailureIncidents({ taskId: f.dependency.id }), ledger, "No historical admission, failure or paid counter is rewritten");
});

test("historical admission requires complete native evidence and no conflicting subsequent work", async (t) => {
  for (const scenario of ["open", "backoff", "exhausted", "changed_probe", "new_generation", "new_active_fault",
    "missing_task_link", "wrong_candidate", "wrong_admission", "wrong_terminal_claim", "wrong_raw_failure", "missing_probe", "overlapping_run", "later_run", "unknown_run",
    "cancelled_claim", "cancelled_open_end", "cancelled_later", "cancelled_unknown_reason"]) {
    await t.test(scenario, async (t) => {
      const f = await prerequisiteFailureFixture(t, { native: true, twoReasons: true });
      await f.recover();
      if (scenario === "open") await openFailureContainmentCircuit(f.providerInput);
      if (scenario === "backoff") await scheduleFailureContainmentBackoff({ ...f.providerInput, delayMs: 1000 });
      if (scenario === "exhausted") await claimFailureContainmentPaidAttempt(f.providerInput);
      if (scenario === "changed_probe") await recordFailureContainmentActivity({ ...f.providerInput, type: "cheap_probe", outcome: "passed", verifier: { id: "service_health_probe" } });
      if (scenario === "new_generation") {
        const evidence = failureEvidence({ ...f.providerInput.evidence, configurationDigest: `sha256:${"6".repeat(64)}` });
        await recordFailureContainmentActivity({ ...f.providerInput, evidence: evidence.value, type: "cheap_probe", outcome: "passed",
          verifier: { id: "service_health_probe", outcome: "passed", evidenceDigest: evidence.digest } });
      }
      if (scenario === "new_active_fault") await claimFailureContainmentPaidAttempt({ ...f.input, reasonCode: "configuration_invalid" });
      await mutateState((state) => {
        const run = state.runs.find((item) => item.id === f.run.id), task = state.tasks.find((item) => item.id === f.dependency.id);
        if (scenario === "missing_task_link") delete task.lastAutomationFailureRunId;
        if (scenario === "wrong_candidate") run.executionCommitSha = "f".repeat(40);
        if (scenario === "wrong_admission") run.failureContainmentAdmission.provider = "local";
        if (scenario === "wrong_terminal_claim") run.failureContainmentClaim.incidentId = f.providerSuccessor.incidentId;
        if (scenario === "wrong_raw_failure") run.rawFailureCode = "sdk_error";
        if (scenario === "missing_probe") delete run.failureContainmentProbe;
        const cancelled = state.runs.find((item) => item.id === `${f.run.id}_queued_1`);
        if (scenario === "cancelled_claim") cancelled.failureContainmentClaim = structuredClone(run.failureContainmentClaim);
        if (scenario === "cancelled_open_end") delete cancelled.completedAt;
        if (scenario === "cancelled_later") cancelled.completedAt = cancelled.updatedAt = run.completedAt;
        if (scenario === "cancelled_unknown_reason") cancelled.exitCode = "unknown_cancellation";
        if (["overlapping_run", "later_run", "unknown_run"].includes(scenario)) state.runs.push({ id: `${f.run.id}_conflict`,
          taskId: f.dependency.id, projectId: f.project.id, role: "builder", status: "failed",
          ...(scenario === "unknown_run" ? {} : { startedAt: scenario === "overlapping_run" ? run.startedAt : run.completedAt,
            completedAt: run.completedAt }) });
      });
      await f.refreshRequestVersions();
      const before = await prerequisiteTasksSnapshot(f);
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_prerequisite_unresolved_incident/);
      assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    });
  }
});

test("verified cheap-probe lineage resolves only its stale prerequisite pointer during real source adoption", async (t) => {
  const f = await prerequisiteFailureFixture(t);
  const successor = await f.recover();
  const before = await prerequisiteTasksSnapshot(f);
  const result = await adoptOperatorCandidate(f.task.id, f.request, f.authority);
  const after = await prerequisiteTasksSnapshot(f);
  const dependency = after.tasks.find((item) => item.id === f.dependency.id);
  const child = after.tasks.find((item) => item.id === f.task.id);
  assert.equal(result.held, false);
  assert.equal(dependency.status, "closed");
  assert.equal(dependency.automationBlocker, undefined);
  assert.equal(dependency.preexistingWorkDisposition.kind, "preexisting_work_verified");
  const recovery = dependency.preexistingWorkDisposition.failureRecovery;
  assert.equal(recovery.taskId, dependency.id);
  assert.equal(recovery.ancestorIncidentId, f.ancestor.incidentId);
  assert.equal(recovery.ancestorGeneration, f.ancestor.generation);
  assert.equal(recovery.ancestorEvidenceDigest, f.ancestor.evidenceDigest);
  assert.equal(recovery.successorIncidentId, successor.incidentId);
  assert.equal(recovery.successorGeneration, successor.generation);
  assert.equal(recovery.successorEvidenceDigest, successor.evidenceDigest);
  assert.equal(recovery.verifier, "policy_probe"); assert.equal(recovery.outcome, "passed");
  assert.deepEqual(recovery.previousBlocker, before.tasks.find((item) => item.id === dependency.id).automationBlocker);
  assert.match(recovery.ancestorRecordDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(recovery.successorRecordDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(recovery.ancestorRecordDigest, recovery.successorRecordDigest);
  assert.equal(child.status, "builder_review");
  assert.equal(child.operatorIntake.candidate.commitSha, f.request.candidate.commitSha);
  assert.deepEqual(child.operatorIntake.dispositions[0].failureRecovery, recovery);
  for (const task of after.tasks) assert.ok(task.stateVersion > before.tasks.find((item) => item.id === task.id).stateVersion);
  assert.deepEqual(after.runs, before.runs);
  const incidents = await readFailureIncidents({ taskId: f.dependency.id });
  const old = incidents.find((item) => item.incidentId === f.ancestor.incidentId);
  const current = incidents.find((item) => item.incidentId === successor.incidentId);
  assert.equal(old.state, "superseded"); assert.equal(old.paidAttempts, 2);
  assert.deepEqual(old.history, f.ancestor.history);
  assert.equal(current.state, "active"); assert.equal(current.paidAttempts, 0); assert.equal(current.cheapProbeAttempts, 1);
});

test("open unchanged or unsuccessful prerequisite failures cannot authorize atomic adoption", async (t) => {
  for (const scenario of ["still_open", "unchanged_evidence", "failed_activity"]) {
    await t.test(scenario, async (t) => {
      const f = await prerequisiteFailureFixture(t);
      if (scenario === "unchanged_evidence") await f.recover({ evidence: f.input.evidence,
        verifier: { id: "policy_probe", outcome: "passed", evidenceDigest: f.ancestor.evidenceDigest } });
      if (scenario === "failed_activity") await f.recover({ outcome: "failed" });
      const before = await prerequisiteTasksSnapshot(f);
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_prerequisite_/);
      assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    });
  }
});

test("a wrong-task or forged stale prerequisite pointer cannot borrow genuine recovery evidence", async (t) => {
  for (const scenario of ["wrong_task", "wrong_evidence", "wrong_generation", "wrong_incident"]) {
    await t.test(scenario, async (t) => {
      const f = await prerequisiteFailureFixture(t, { wrongTask: scenario === "wrong_task" });
      const successor = await f.recover();
      if (scenario !== "wrong_task") {
        await mutateState((state) => {
          const blocker = state.tasks.find((item) => item.id === f.dependency.id).automationBlocker;
          if (scenario === "wrong_evidence") blocker.evidenceDigest = `sha256:${"0".repeat(64)}`;
          if (scenario === "wrong_generation") blocker.incidentGeneration += 1;
          if (scenario === "wrong_incident") blocker.incidentId = successor.incidentId;
        });
        await f.refreshRequestVersions();
      }
      const before = await prerequisiteTasksSnapshot(f);
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_prerequisite_/);
      assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    });
  }
});

test("a new fault or consumed held successor keeps both adoption tasks unchanged", async (t) => {
  for (const scenario of ["unrelated_fault", "successor_open", "successor_backoff", "successor_paid", "new_verified_generation", "open_compatibility_circuit"]) {
    await t.test(scenario, async (t) => {
      const f = await prerequisiteFailureFixture(t);
      await f.recover();
      const current = { ...f.input, evidence: f.changed.value, now: "2026-10-01T00:02:00.000Z" };
      if (scenario === "unrelated_fault") await recordFailureContainmentActivity({ ...current, reasonCode: "configuration_invalid", type: "cheap_probe", outcome: "failed" });
      if (scenario === "successor_open") await openFailureContainmentCircuit(current);
      if (scenario === "successor_backoff") await scheduleFailureContainmentBackoff({ ...current, delayMs: 1000 });
      if (scenario === "successor_paid") assert.equal((await claimFailureContainmentPaidAttempt(current)).admitted, true);
      if (scenario === "new_verified_generation") {
        const evidence = failureEvidence({ ...f.changed.value, configurationDigest: `sha256:${"4".repeat(64)}` });
        await recordFailureContainmentActivity({ ...current, evidence: evidence.value, type: "cheap_probe", outcome: "passed",
          verifier: { id: "policy_probe", outcome: "passed", evidenceDigest: evidence.digest } });
      }
      if (scenario === "open_compatibility_circuit") {
        await mutateState((state) => applyFailureIncidentCompatibilityReadModelInState(state,
          state.tasks.find((item) => item.id === f.dependency.id), f.ancestor, { snapshot: { status: "blocked" } }));
        await f.refreshRequestVersions();
      }
      const before = await prerequisiteTasksSnapshot(f);
      await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, f.authority), /adoption_prerequisite_/);
      assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    });
  }
});

test("a public failure-ledger change during owner confirmation invalidates recovery without task-version changes", async (t) => {
  const f = await prerequisiteFailureFixture(t);
  const successor = await f.recover();
  const before = await prerequisiteTasksSnapshot(f);
  let confirmations = 0;
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
    confirmations += 1;
    await openFailureContainmentCircuit({ ...f.input, evidence: f.changed.value, now: "2026-10-01T00:02:00.000Z" });
    assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
    return "local-os:fixture";
  } }), /adoption_prerequisite_|operator_prerequisite_failure_(?:unresolved|changed)/);
  assert.equal(confirmations, 1);
  assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
  assert.equal((await readFailureIncidents({ taskId: f.dependency.id })).find((item) => item.incidentId === successor.incidentId).state, "open");
});

test("recovery still respects prerequisite state CAS and active ownership", async (t) => {
  const f = await prerequisiteFailureFixture(t);
  await f.recover();
  let expected;
  await assert.rejects(adoptOperatorCandidate(f.task.id, f.request, { ...f.authority, confirm: async () => {
    await updateTask(f.dependency.id, { assignedThreadId: "competing-prerequisite-owner" });
    expected = await prerequisiteTasksSnapshot(f);
    assert.ok(expected.tasks.find((item) => item.id === f.dependency.id).stateVersion > f.request.prerequisites[0].expectedStateVersion);
    return "local-os:fixture";
  } }), /adoption_prerequisite_stale/);
  assert.deepEqual(await prerequisiteTasksSnapshot(f), expected);
  const g = await prerequisiteFailureFixture(t);
  await g.recover();
  await mutateState((state) => { state.tasks.find((item) => item.id === g.dependency.id).assignmentClaim = {
    ownerId: "another-fixture-owner", expiresAt: "2099-01-01T00:00:00.000Z" }; });
  await g.refreshRequestVersions();
  const before = await prerequisiteTasksSnapshot(g);
  await assert.rejects(adoptOperatorCandidate(g.task.id, g.request, g.authority), /adoption_active_assignment/);
  assert.deepEqual(await prerequisiteTasksSnapshot(g), before);
});

test("caller recovery flags cannot replace authoritative prerequisite ledger proof", async (t) => {
  const f = await prerequisiteFailureFixture(t);
  const before = await prerequisiteTasksSnapshot(f);
  await assert.rejects(adoptOperatorCandidate(f.task.id, { ...f.request,
    failureRecovery: { verified: true, paidAttempts: 0, state: "active" } }, f.authority), /adoption_.*fields_invalid/);
  const nested = structuredClone(f.request);
  nested.prerequisites[0].failureRecovery = { verified: true, state: "superseded" };
  await assert.rejects(adoptOperatorCandidate(f.task.id, nested, f.authority), /adoption_.*fields_invalid/);
  assert.deepEqual(await prerequisiteTasksSnapshot(f), before);
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
