import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function readPersistedState(root, env) {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { readState } from ${JSON.stringify(path.resolve("src/store.js"))}; console.log(JSON.stringify(await readState()));`,
  ], { cwd: root, env });
  return JSON.parse(result.stdout);
}

test("status without a value and show-task leave the task unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-status-cli-"));
  try {
    await writeLegacyState(root, invalidStatusState());
    const env = await environmentForTestControlRoot(root);
    const before = invalidStatusState().tasks[0];

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "status", "task_1"], { cwd: root, env }),
      /status TASK_ID --status CANONICAL_STATUS.*show-task TASK_ID/,
    );
    const inspection = await execFileAsync(process.execPath, [cliPath, "show-task", "task_1", "--json"], { cwd: root, env });
    assert.match(inspection.stdout, /"reviewSubjectSha":/);

    const legacyTask = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8")).tasks[0];
    assert.deepEqual(legacyTask, before);
    const persisted = await readPersistedState(root, env);
    assert.deepEqual({
      task: persisted.tasks[0],
      comments: persisted.comments,
      events: persisted.events,
    }, {
      task: before,
      comments: [],
      events: [],
    });
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

test("a recovered current-candidate backend approval routes to the next required lane", () => {
  const state = invalidStatusState();
  state.tasks[0].status = "backend_review";
  const report = createSupervisorReport(state);
  assert.equal(report.integrityFaults.length, 0);
  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "frontend-reviewer");
  assert.equal(report.actions[0].nextStatus, "frontend_review");
});
