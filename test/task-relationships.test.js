import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import {
  recordOperationalRepairInState,
  repairLegacyTaskRelationshipsInState,
  validateTaskRelationships,
} from "../src/store.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const storePath = path.resolve("src/store.js");

function fixtureState() {
  return {
    meta: { stateIntegrityVersion: 4 },
    projects: [
      { id: "project_1", key: "product", name: "Product" },
      { id: "project_2", key: "studioops", name: "StudioOps" },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Product delivery",
        status: "queued",
        parentTaskId: "",
        dependsOnTaskIds: ["task_2"],
        reviewCycle: 2,
        reviewSubjectSha: "a".repeat(40),
        reviewSubjectCycle: 2,
      },
      {
        id: "task_2",
        projectId: "project_1",
        title: "Product foundation",
        status: "done",
        parentTaskId: "",
        dependsOnTaskIds: [],
      },
      {
        id: "task_3",
        projectId: "project_2",
        title: "Repair StudioOps",
        status: "in_progress",
        parentTaskId: "",
        dependsOnTaskIds: [],
      },
    ],
    comments: [{ id: "comment_1", taskId: "task_1", author: "Reviewer", body: "Evidence" }],
    reviews: [{ id: "review_1", taskId: "task_1", outcome: "approved", subjectSha: "a".repeat(40) }],
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

async function runStoreModule(root, env, source) {
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
  });
}

test("create rejects a cross-project dependency with stable diagnostics and persists nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-task-create-project-boundary-"));
  try {
    const state = fixtureState();
    await writeLegacyState(root, state);
    const env = await environmentForTestControlRoot(root);
    const result = await runStoreModule(root, env, `
      import { addTask } from ${JSON.stringify(storePath)};
      try {
        await addTask({ project: "product", title: "Invalid cross-project child", dependsOnTaskIds: ["task_3"] });
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, diagnostic: error.diagnostic }));
      }
    `);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.code, "cross_project_dependency");
    assert.deepEqual({
      sourceTaskId: failure.diagnostic.sourceTaskId,
      sourceProjectId: failure.diagnostic.sourceProjectId,
      dependencyTaskId: failure.diagnostic.dependencyTaskId,
      dependencyProjectId: failure.diagnostic.dependencyProjectId,
    }, {
      sourceTaskId: "task_4",
      sourceProjectId: "project_1",
      dependencyTaskId: "task_3",
      dependencyProjectId: "project_2",
    });
    const persisted = readPersistedState(root);
    assert.deepEqual(persisted.tasks, state.tasks);
    assert.deepEqual(persisted.events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update validates the complete candidate before changing any task field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-task-update-project-boundary-"));
  try {
    const state = fixtureState();
    await writeLegacyState(root, state);
    const env = await environmentForTestControlRoot(root);
    const result = await runStoreModule(root, env, `
      import { updateTask } from ${JSON.stringify(storePath)};
      try {
        await updateTask("task_1", {
          title: "This title must roll back",
          dependsOnTaskIds: ["task_2", "task_3"],
        });
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, diagnostic: error.diagnostic }));
      }
    `);
    assert.equal(JSON.parse(result.stdout).code, "cross_project_dependency");
    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].title, "Product delivery");
    assert.deepEqual(persisted.tasks[0].dependsOnTaskIds, ["task_2"]);
    assert.deepEqual(persisted.events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-project dependencies and parent-cycle validation retain their behavior", () => {
  const state = fixtureState();
  assert.doesNotThrow(() => validateTaskRelationships(
    state,
    "task_1",
    "",
    ["task_2"],
    "project_1",
  ));
  state.tasks[1].parentTaskId = "task_1";
  assert.throws(
    () => validateTaskRelationships(state, "task_1", "task_2", ["task_2"], "project_1"),
    /parent relationship would create a cycle/i,
  );
});

test("operational repair references are bounded, audited, cross-project, and self-safe", () => {
  const state = fixtureState();
  const task = recordOperationalRepairInState(state, "task_1", {
    repairTaskId: "task_3",
    reasonCode: "workflow_integrity",
    resumeStatus: "queued",
  }, {
    now: "2026-08-16T12:00:00.000Z",
    author: "StudioOps Workflow",
  });
  assert.equal(task.status, "blocked");
  assert.deepEqual(task.dependsOnTaskIds, ["task_2"]);
  assert.deepEqual(task.operationalRepair, {
    repairTaskId: "task_3",
    reasonCode: "workflow_integrity",
    resumeStatus: "queued",
    recordedAt: "2026-08-16T12:00:00.000Z",
    recordedBy: "StudioOps Workflow",
    resolvedAt: "",
    resolvedBy: "",
    resolutionStatus: "",
  });
  assert.equal(state.events.at(-1).type, "operational_repair_recorded");

  for (const repairInput of [
    { repairTaskId: "task_1", reasonCode: "workflow_integrity", resumeStatus: "queued" },
    { repairTaskId: "task_3", reasonCode: "free form incident details", resumeStatus: "queued" },
    { repairTaskId: "task_3", reasonCode: "workflow_integrity", resumeStatus: "done" },
    {
      repairTaskId: "task_3",
      reasonCode: "workflow_integrity",
      resumeStatus: "queued",
      resolvedAt: "forged",
    },
  ]) {
    const isolated = fixtureState();
    assert.throws(
      () => recordOperationalRepairInState(isolated, "task_1", repairInput),
      (error) => error.code.startsWith("repair_") && isolated.tasks[0].status === "queued",
    );
  }
});

test("legacy repair atomically removes offending edges and preserves delivery and review evidence", () => {
  const state = fixtureState();
  state.tasks[0].dependsOnTaskIds = ["task_2", "task_3"];
  const before = structuredClone({
    reviewCycle: state.tasks[0].reviewCycle,
    reviewSubjectSha: state.tasks[0].reviewSubjectSha,
    reviewSubjectCycle: state.tasks[0].reviewSubjectCycle,
    comments: state.comments,
    reviews: state.reviews,
  });

  const repaired = repairLegacyTaskRelationshipsInState(state, "task_1", {
    removeDependencyTaskIds: ["task_3"],
    operationalRepair: {
      repairTaskId: "task_3",
      reasonCode: "dependency_repair",
      resumeStatus: "queued",
    },
  }, {
    now: "2026-08-16T12:00:00.000Z",
    author: "StudioOps Workflow",
  });

  assert.deepEqual(repaired.dependsOnTaskIds, ["task_2"]);
  assert.equal(repaired.operationalRepair.repairTaskId, "task_3");
  assert.equal(repaired.status, "blocked");
  assert.deepEqual({
    reviewCycle: repaired.reviewCycle,
    reviewSubjectSha: repaired.reviewSubjectSha,
    reviewSubjectCycle: repaired.reviewSubjectCycle,
    comments: state.comments,
    reviews: state.reviews,
  }, before);
  assert.ok(state.events.some((event) => event.type === "legacy_task_relationship_repaired"));
});
