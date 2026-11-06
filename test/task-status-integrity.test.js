import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createSupervisorReport } from "../src/supervisor.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/mission-control-cli.js");

function invalidStatusState() {
  return {
    meta: { stateIntegrityVersion: 4 },
    projects: [{ id: "project_1", key: "demo", name: "Demo" }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Recovered review task",
      status: "",
      assignedAgentRole: "backend-reviewer",
      reviewCycle: 2,
      reviewSubjectSha: "a".repeat(40),
      reviewSubjectCycle: 2,
      updatedAt: "2026-07-28T12:00:00.000Z",
    }],
    comments: [],
    reviews: [{
      id: "review_1",
      taskId: "task_1",
      stageKey: "backend",
      outcome: "approved",
      subjectSha: "a".repeat(40),
      cycle: 2,
      candidateCycle: 2,
    }],
    events: [],
    runs: [],
    qaBundles: [],
    candidates: [],
  };
}

async function writeLegacyState(root, state) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify(state)}\n`);
}

function builderReviewStatusState(workflowMode, prUrl) {
  return {
    meta: { stateIntegrityVersion: 4 },
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      workflowMode,
      reviewPipeline: [{
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      }],
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Exact builder handoff",
      status: "in_progress",
      branchName: "codex/demo-exact-sha",
      prUrl,
      reviewCycle: 0,
      reviewSubjectSha: "a".repeat(40),
      reviewSubjectCycle: 0,
    }],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [],
    candidates: [],
  };
}

async function installNativeBuilderFixture(root, workflowMode, prUrl) {
  const repo = path.join(root, "source");
  await mkdir(path.join(repo, "src"), { recursive: true }); await mkdir(path.join(repo, "test"));
  await mkdir(path.join(repo, "docs/architecture"), { recursive: true });
  const git = async (...args) => (await execFileAsync("/usr/bin/git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture Author"); await git("config", "user.email", "fixture@example.invalid");
  await git("remote", "add", "origin", "https://github.com/example/demo");
  await writeFile(path.join(repo, "src/store.js"), "export const value=1;\n");
  await writeFile(path.join(repo, "test/store.test.js"), "// Generic immutable fixture test.\n");
  await writeFile(path.join(repo, "docs/architecture/components.json"), JSON.stringify({ schemaVersion: 1,
    project: { key: "demo", repository: "https://github.com/example/demo" }, aggregateCommand: "npm run check",
    components: { example: { owner: "fixture-engineering", paths: ["src/store.js", "test/store.test.js"],
      publicContracts: ["fixture value"], services: ["fixture module"], dependsOn: [],
      tests: [{ command: "node --test test/store.test.js", layer: "unit" }], reviewOwners: ["backend-reviewer"], rollback: "Restore the prior fixture commit." } } }));
  await git("add", "."); await git("commit", "-m", "Real fixture base"); const baseSha = await git("rev-parse", "HEAD");
  const branch = "codex/demo-corrected"; await git("switch", "-c", branch);
  const env = await environmentForTestControlRoot(root);
  const store = path.resolve("src/store.js"), dispatcher = path.resolve("src/dispatcher.js");
  const setup = await execFileAsync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {addProject,addTask,updateTask,updateRun,readStateReadOnly} from ${JSON.stringify(store)};
    import {dispatchSupervisorActions} from ${JSON.stringify(dispatcher)};
    const project=await addProject({key:'demo',name:'Real candidate fixture',repoPath:${JSON.stringify(repo)},sourceRepoPath:${JSON.stringify(repo)},repoUrl:'https://github.com/example/demo',workflowMode:${JSON.stringify(workflowMode)},reviewPipeline:[{key:'backend',label:'Backend Review',role:'backend-reviewer',status:'backend_review',required:true}]});
    const task=await addTask({project:project.id,title:'Real builder candidate',type:'bug',status:'ready',architectureRequired:false,branchName:${JSON.stringify(branch)},prUrl:${JSON.stringify(prUrl)},workAreas:['src/store.js','test/store.test.js'],description:'Validate atomic real candidate handoff.',userStory:'As a reviewer I need truthful source identity.',expectedOutcome:'The handoff is atomic.',acceptanceCriteria:['Exact source is retained.'],affectedSurfaces:['backend'],validationPlan:['node --test test/store.test.js'],riskClassification:'low',privacyNotes:'Generic fixture only.',securityNotes:'No executor or external network.'});
    const report=await dispatchSupervisorActions([{id:task.id+':start_builder',type:'start_builder',role:'builder',taskId:task.id,projectId:project.id,taskStatus:'ready',nextStatus:'in_progress'}],{failureIncidents:[],creditPolicy:{enabled:false}});
    assert.equal(report.runs.length,1,JSON.stringify(report.skipped));
    await updateRun(report.runs[0].id,{status:'cancelled',completedAt:new Date().toISOString(),notes:'Fixture cancelled before execution.'});
    await updateTask(task.id,{status:'in_progress'});
    const current=(await readStateReadOnly()).tasks.find(t=>t.id===task.id);console.log(JSON.stringify({taskId:task.id,stateVersion:current.stateVersion}));
  `], { cwd: root, env });
  await writeFile(path.join(repo, "src/store.js"), "export const value=2;\n");
  await writeFile(path.join(repo, "test/store.test.js"), "// Generic corrected immutable fixture test.\n");
  await git("add", "."); await git("commit", "-m", "Real fixture implementation");
  return { ...JSON.parse(setup.stdout), env, candidate: { baseSha, commitSha: await git("rev-parse", "HEAD"), treeSha: await git("rev-parse", "HEAD^{tree}"), branch },
    handoffArgs: ["--tree-sha", await git("rev-parse", "HEAD^{tree}"), "--base-sha", baseSha, "--branch", branch, "--impact-files", "src/store.js,test/store.test.js"] };
}

async function readPersistedState(root, env) {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { readState } from ${JSON.stringify(path.resolve("src/store.js"))}; console.log(JSON.stringify(await readState()));`,
  ], { cwd: root, env });
  return JSON.parse(result.stdout);
}

async function databaseFileSnapshot(root) {
  const paths = [
    path.join(root, "data", "mission-control.sqlite3"),
    path.join(root, "data", "mission-control.sqlite3-wal"),
  ];
  const snapshot = {};
  for (const filePath of paths) {
    try {
      const metadata = await stat(filePath);
      snapshot[filePath] = {
        mtimeMs: metadata.mtimeMs,
        bytes: (await readFile(filePath)).toString("base64"),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshot[filePath] = null;
    }
  }
  return snapshot;
}

test("task CLI preserves and updates required readiness evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-task-readiness-cli-"));
  try {
    await writeLegacyState(root, {
      meta: { stateIntegrityVersion: 4 },
      projects: [{ id: "project_1", key: "demo", name: "Demo" }],
      tasks: [], comments: [], reviews: [], events: [], runs: [], qaBundles: [], candidates: [],
    });
    const env = await environmentForTestControlRoot(root);
    await execFileAsync(process.execPath, [
      cliPath,
      "add-task",
      "--project", "demo",
      "--title", "Ready task",
      "--affected-surfaces", "homepage,catalog",
      "--validation-plan", "unit tests,visual QA",
      "--risk-classification", "medium",
    ], { cwd: root, env });

    let state = await readPersistedState(root, env);
    assert.deepEqual(state.tasks[0].affectedSurfaces, ["homepage", "catalog"]);
    assert.deepEqual(state.tasks[0].validationPlan, ["unit tests", "visual QA"]);
    assert.equal(state.tasks[0].riskClassification, "medium");

    await execFileAsync(process.execPath, [
      cliPath,
      "update-task", state.tasks[0].id,
      "--surfaces", "checkout",
      "--validation", "smoke test",
      "--risk", "high",
      "--privacy", "No identity data.",
      "--security", "Fail closed.",
    ], { cwd: root, env });
    state = await readPersistedState(root, env);
    assert.deepEqual(state.tasks[0].affectedSurfaces, ["checkout"]);
    assert.deepEqual(state.tasks[0].validationPlan, ["smoke test"]);
    assert.equal(state.tasks[0].riskClassification, "high");
    assert.equal(state.tasks[0].privacyNotes, "No identity data.");
    assert.equal(state.tasks[0].securityNotes, "Fail closed.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal task assignment cleanup does not rerun completion gates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-terminal-assignment-cleanup-"));
  try {
    const state = invalidStatusState();
    Object.assign(state.tasks[0], {
      status: "done",
      assignedAgentRole: "builder",
      stateVersion: 1,
    });
    await writeLegacyState(root, state);
    const env = await environmentForTestControlRoot(root);
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { updateTask } from ${JSON.stringify(path.resolve("src/store.js"))}; await updateTask("task_1", { assignedAgentRole: "" });`,
    ], { cwd: root, env });

    const persisted = await readPersistedState(root, env);
    assert.equal(persisted.tasks[0].status, "done");
    assert.equal(persisted.tasks[0].assignedAgentRole, "");
    assert.equal(
      persisted.events.some((event) => event.type === "lifecycle_transition" && event.action === "mutate_assignment"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status without a value and show-task leave the task unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-status-cli-"));
  try {
    await writeLegacyState(root, invalidStatusState());
    const env = await environmentForTestControlRoot(root);
    const before = invalidStatusState().tasks[0];
    await readPersistedState(root, env);
    const beforeDatabase = await databaseFileSnapshot(root);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "status", "task_1"], { cwd: root, env }),
      /status TASK_ID --status CANONICAL_STATUS.*show-task TASK_ID/,
    );
    const inspection = await execFileAsync(process.execPath, [cliPath, "show-task", "task_1", "--json"], { cwd: root, env });
    assert.match(inspection.stdout, /"reviewSubjectSha":/);
    assert.deepEqual(await databaseFileSnapshot(root), beforeDatabase);

    const legacyTask = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8")).tasks[0];
    assert.deepEqual(legacyTask, before);
    const persisted = await readPersistedState(root, env);
    assert.deepEqual({
      task: persisted.tasks[0],
      comments: persisted.comments,
      events: persisted.events,
    }, {
      task: { ...before, stateVersion: 1 },
      comments: [],
      events: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [workflowMode, prUrl] of [
  ["local", ""],
  ["github", "https://github.com/example/demo/pull/1"],
]) {
  test(`builder-review status atomically persists the exact SHA for ${workflowMode} workflow`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `studioops-builder-review-${workflowMode}-`));
    try {
      const fixture = await installNativeBuilderFixture(root, workflowMode, prUrl);
      const { env } = fixture;
      const subjectSha = fixture.candidate.commitSha;
      await execFileAsync(process.execPath, [
        cliPath,
        "status",
        "task_1",
        "--status",
        "builder_review",
        "--subject-sha",
        subjectSha,
        ...fixture.handoffArgs,
      ], { cwd: root, env });

      const state = await readPersistedState(root, env);
      const task = state.tasks[0];
      assert.equal(task.status, "builder_review");
      assert.equal(task.reviewSubjectSha, subjectSha);
      assert.equal(task.reviewCycle, 1);
      assert.equal(task.reviewSubjectCycle, 1);
      assert.equal(task.stateVersion, fixture.stateVersion + 1);
      const lifecycleEvent = state.events.find((event) => event.type === "lifecycle_transition" && event.action === "record_builder_handoff");
      assert.equal(lifecycleEvent?.action, "record_builder_handoff");
      assert.equal(lifecycleEvent?.fromVersion, fixture.stateVersion);
      assert.equal(lifecycleEvent?.toVersion, fixture.stateVersion + 1);
      const report = createSupervisorReport(state);
      assert.equal(report.actions[0].type, "start_review");
      assert.equal(report.actions[0].reviewSubjectSha, subjectSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("builder-review status atomically persists complete immutable candidate evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-builder-review-candidate-"));
  try {
    const fixture = await installNativeBuilderFixture(root, "github", "https://github.com/example/demo/pull/1");
    const { env } = fixture;
    const { commitSha: subjectSha, treeSha, baseSha } = fixture.candidate;
    await execFileAsync(process.execPath, [
      cliPath,
      "status",
      "task_1",
      "--status",
      "builder_review",
      "--subject-sha",
      subjectSha,
      "--tree-sha",
      treeSha,
      "--base-sha",
      baseSha,
      "--branch",
      "codex/demo-corrected",
      "--pr-url",
      "https://github.com/example/demo/pull/2",
      "--impact-files",
      "src/store.js,test/store.test.js",
      "--impact",
      "backend",
    ], { cwd: root, env });

    const task = (await readPersistedState(root, env)).tasks[0];
    assert.equal(task.status, "builder_review");
    assert.equal(task.reviewSubjectSha, subjectSha);
    assert.equal(task.branchName, "codex/demo-corrected");
    assert.equal(task.prUrl, "https://github.com/example/demo/pull/2");
    assert.equal(task.candidateIdentity.commitSha, subjectSha);
    assert.equal(task.candidateIdentity.treeSha, treeSha);
    assert.equal(task.candidateIdentity.baseSha, baseSha);
    assert.equal(task.candidateIdentity.branch, "codex/demo-corrected");
    assert.deepEqual(task.candidateIdentity.impactEvidence.changedFiles, ["src/store.js", "test/store.test.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builder-review status fails closed for missing or non-full subject SHA", async () => {
  for (const subjectSha of [null, "not-a-sha", "c".repeat(12)]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-builder-review-invalid-"));
    try {
      await writeLegacyState(root, builderReviewStatusState("github", "https://github.com/example/demo/pull/1"));
      const env = await environmentForTestControlRoot(root);
      const args = [cliPath, "status", "task_1", "--status", "builder_review"];
      if (subjectSha !== null) args.push("--subject-sha", subjectSha);
      await assert.rejects(
        execFileAsync(process.execPath, args, { cwd: root, env }),
        /full head SHA|review subject SHA/,
      );
      const task = (await readPersistedState(root, env)).tasks[0];
      assert.equal(task.status, "in_progress");
      assert.equal(task.reviewCycle, 0);
      assert.equal(task.reviewSubjectSha, "a".repeat(40));
      assert.equal(createSupervisorReport(await readPersistedState(root, env)).actions.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("show-task does not initialize a missing database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-read-only-init-"));
  try {
    const env = await environmentForTestControlRoot(root);
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "show-task", "task_1", "--json"], { cwd: root, env }),
      /read-only inspection cannot initialize it/,
    );
    await assert.rejects(stat(path.join(root, "data", "mission-control.sqlite3")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateTask rejects every malformed status patch before mutation", async () => {
  for (const status of [undefined, null, "", "   ", "not-a-status"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "studioops-update-status-"));
    try {
      await writeLegacyState(root, {
        meta: { stateIntegrityVersion: 4 },
        projects: [{ id: "project_1", key: "demo", name: "Demo" }],
        tasks: [{ id: "task_1", projectId: "project_1", title: "Task", status: "backend_review" }],
        comments: [], reviews: [], events: [], runs: [], qaBundles: [], candidates: [],
      });
      const env = await environmentForTestControlRoot(root);
      const statusExpression = status === undefined ? "undefined" : JSON.stringify(status);
      await assert.rejects(
        execFileAsync(process.execPath, ["--input-type=module", "-e", `import { updateTask } from ${JSON.stringify(path.resolve("src/store.js"))}; await updateTask("task_1", { status: ${statusExpression} });`], { cwd: root, env }),
        /Invalid status/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("supervisor reports invalid legacy status as a repairable integrity fault", () => {
  const report = createSupervisorReport(invalidStatusState());
  assert.equal(report.totals.integrityFaults, 1);
  assert.equal(report.integrityFaults[0].taskId, "task_1");
  assert.match(report.integrityFaults[0].reason, /status task_1 --status/);
});

test("noncanonical whitespace statuses are integrity faults and cannot be rewritten", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-status-boundary-"));
  try {
    const state = invalidStatusState();
    state.tasks[0].status = " backend_review ";
    await writeLegacyState(root, state);
    const env = await environmentForTestControlRoot(root);

    const report = createSupervisorReport(state);
    assert.equal(report.totals.integrityFaults, 1);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { readState, writeState } from ${JSON.stringify(path.resolve("src/store.js"))}; const state = await readState(); await writeState(state);`,
      ], { cwd: root, env }),
      /invalid workflow status/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit repair atomically fixes one invalid task while preserving another invalid record and evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-status-repair-"));
  try {
    const state = invalidStatusState();
    state.tasks.push({
      id: "task_2",
      projectId: "project_1",
      title: "Second legacy task",
      status: "not-a-status",
      assignedAgentRole: "frontend-reviewer",
      reviewCycle: 3,
      reviewSubjectSha: "b".repeat(40),
      reviewSubjectCycle: 3,
    });
    await writeLegacyState(root, state);
    const env = await environmentForTestControlRoot(root);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { updateTask } from ${JSON.stringify(path.resolve("src/store.js"))}; await updateTask("task_1", { status: "backend_review" });`,
      ], { cwd: root, env }),
      /only be changed by repairLegacyTaskStatus/,
    );
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { repairLegacyTaskStatus } from ${JSON.stringify(path.resolve("src/store.js"))}; await repairLegacyTaskStatus("task_1", "backend_review");`,
    ], { cwd: root, env });

    const persisted = await readPersistedState(root, env);
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").status, "backend_review");
    assert.equal(persisted.tasks.find((task) => task.id === "task_2").status, "not-a-status");
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").reviewSubjectSha, "a".repeat(40));
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").reviewCycle, 2);
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").reviewSubjectCycle, 2);
    assert.equal(persisted.events.filter((event) => event.type === "workflow_integrity_repaired").length, 1);
    const report = createSupervisorReport(persisted);
    assert.deepEqual(report.integrityFaults.map((fault) => fault.taskId), ["task_2"]);
    assert.equal(report.actions.find((action) => action.taskId === "task_1")?.nextStatus, "frontend_review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a builder-review status repair preserves the current review subject and cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-builder-review-repair-"));
  try {
    const fixture = await installNativeBuilderFixture(root, "local", "");
    const { env } = fixture;
    await execFileAsync(process.execPath, [cliPath, "status", fixture.taskId, "--status", "builder_review", "--subject-sha", fixture.candidate.commitSha, ...fixture.handoffArgs], { cwd: root, env });
    const before = (await readPersistedState(root, env)).tasks[0];
    // Model an actually corrupted legacy status while retaining real source and scope.
    await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import {DatabaseSync} from 'node:sqlite';import {DATABASE_FILE} from ${JSON.stringify(path.resolve("src/state-database.js"))};
      const db=new DatabaseSync(DATABASE_FILE);const row=db.prepare('SELECT payload FROM tasks WHERE id=?').get(${JSON.stringify(fixture.taskId)});const task=JSON.parse(row.payload);task.status='';db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task),task.id);db.close();
    `], { cwd: root, env });
    await execFileAsync(process.execPath, ["--input-type=module", "-e", `import {repairLegacyTaskStatus} from ${JSON.stringify(path.resolve("src/store.js"))};await repairLegacyTaskStatus(${JSON.stringify(fixture.taskId)},'builder_review');`], { cwd: root, env });
    const task = (await readPersistedState(root, env)).tasks[0];
    assert.equal(task.status, "builder_review");
    assert.equal(task.reviewCycle, before.reviewCycle);
    assert.equal(task.reviewSubjectCycle, before.reviewSubjectCycle);
    assert.equal(task.reviewSubjectSha, before.reviewSubjectSha);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a recovered current-candidate backend approval routes to the next required lane", () => {
  const state = invalidStatusState();
  state.tasks[0].status = "backend_review";
  const report = createSupervisorReport(state);
  assert.equal(report.integrityFaults.length, 0);
  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "frontend-reviewer");
  assert.equal(report.actions[0].nextStatus, "frontend_review");
});
