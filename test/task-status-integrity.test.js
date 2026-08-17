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
      await writeLegacyState(root, builderReviewStatusState(workflowMode, prUrl));
      const env = await environmentForTestControlRoot(root);
      const subjectSha = "b".repeat(40);
      await execFileAsync(process.execPath, [
        cliPath,
        "status",
        "task_1",
        "--status",
        "builder_review",
        "--subject-sha",
        subjectSha,
      ], { cwd: root, env });

      const state = await readPersistedState(root, env);
      const task = state.tasks[0];
      assert.equal(task.status, "builder_review");
      assert.equal(task.reviewSubjectSha, subjectSha);
      assert.equal(task.reviewCycle, 1);
      assert.equal(task.reviewSubjectCycle, 1);
      assert.equal(task.stateVersion, 2);
      const lifecycleEvent = state.events.find((event) => event.type === "lifecycle_transition");
      assert.equal(lifecycleEvent?.action, "record_builder_handoff");
      assert.equal(lifecycleEvent?.fromVersion, 1);
      assert.equal(lifecycleEvent?.toVersion, 2);
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
    await writeLegacyState(root, builderReviewStatusState("github", "https://github.com/example/demo/pull/1"));
    const env = await environmentForTestControlRoot(root);
    const subjectSha = "d".repeat(40);
    const treeSha = "e".repeat(40);
    const baseSha = "f".repeat(40);
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
    await writeLegacyState(root, invalidStatusState());
    const env = await environmentForTestControlRoot(root);
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { repairLegacyTaskStatus } from ${JSON.stringify(path.resolve("src/store.js"))}; await repairLegacyTaskStatus("task_1", "builder_review");`,
    ], { cwd: root, env });

    const task = (await readPersistedState(root, env)).tasks[0];
    assert.equal(task.status, "builder_review");
    assert.equal(task.reviewCycle, 2);
    assert.equal(task.reviewSubjectCycle, 2);
    assert.equal(task.reviewSubjectSha, "a".repeat(40));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
