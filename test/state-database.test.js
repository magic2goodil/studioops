import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { maintenanceWriteBlocker } from "../src/state-database.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

test("maintenance lease blocks non-owner writes until it expires", () => {
  const state = {
    meta: {
      selfUpdateLease: {
        id: "lease_1",
        ownerPid: "100",
        expiresAt: "2026-07-22T22:00:00.000Z",
      },
    },
  };
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "200",
  })?.id, "lease_1");
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "100",
  }), null);
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T22:00:01.000Z"),
    ownerPid: "200",
  }), null);
});

function baseState() {
  return {
    meta: { source: "legacy" },
    projects: [{ id: "project_1", key: "demo", name: "Demo" }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Persist me", status: "ready" }],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [],
  };
}

async function writeLegacyState(root, state = baseState()) {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runStoreScript(root, source) {
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: { ...process.env, MISSION_CONTROL_ROOT: root },
    timeout: 30_000,
  });
}

test("SQLite migrates legacy state once and protects persisted PII at rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-migration-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      const state = await readState();
      console.log(JSON.stringify(state));
    `);

    const state = readPersistedState(root);
    assert.equal(state.projects[0].key, "demo");
    assert.equal(state.tasks[0].title, "Persist me");
    assert.equal(state.meta.storageBackend, "sqlite");
    assert.match(state.meta.migratedFrom, /mission-control\.json$/);

    const dataMode = (await stat(path.join(root, "data"))).mode & 0o777;
    const databaseMode = (await stat(path.join(root, "data", "mission-control.sqlite3"))).mode & 0o777;
    const legacyMode = (await stat(path.join(root, "data", "mission-control.json"))).mode & 0o777;
    assert.equal(dataMode, 0o700);
    assert.equal(databaseMode, 0o600);
    assert.equal(legacyMode, 0o600);

    const backupPath = path.join(root, "backups", "snapshot.sqlite3");
    await runStoreScript(root, `
      import { backupStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      await backupStateDatabase(${JSON.stringify(backupPath)});
    `);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent worker processes serialize updates without dropping comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-concurrency-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    await Promise.all(Array.from({ length: 6 }, (_, index) => runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      await addComment("task_1", "worker-${index}", "Concurrency test");
    `)));

    const state = readPersistedState(root);
    const bodies = state.comments.map((comment) => comment.body).sort();
    assert.deepEqual(bodies, ["worker-0", "worker-1", "worker-2", "worker-3", "worker-4", "worker-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite import removes orphaned and cross-project QA bundle references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-integrity-"));
  try {
    const state = baseState();
    state.projects.push({ id: "project_2", key: "other", name: "Other" });
    state.tasks[0].qaBundleId = "qa_bundle_1";
    state.tasks.push({
      id: "task_2",
      projectId: "project_2",
      title: "Valid QA task",
      status: "qa_review",
      qaBundleId: "qa_bundle_1",
    });
    state.qaBundles.push({
      id: "qa_bundle_1",
      projectId: "project_2",
      status: "ready",
      tasks: [
        { id: "task_1", title: "Wrong project" },
        { id: "task_2", title: "Valid QA task" },
      ],
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").qaBundleId, undefined);
    assert.equal(persisted.tasks.find((task) => task.id === "task_2").qaBundleId, "qa_bundle_1");
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite migration reconstructs bundles for previously integrated QA tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-backfill-"));
  try {
    const state = baseState();
    state.projects[0].repoUrl = "git@github.com:example/demo.git";
    state.projects[0].localQaPreview = {
      checkoutPath: "/tmp/demo-qa",
      previewUrl: "http://127.0.0.1:4174/",
    };
    Object.assign(state.tasks[0], {
      status: "qa_review",
      qaBundleId: "qa_bundle_99",
      localQaPreview: {
        status: "current",
        branch: "qa/demo",
        after: "abc123",
        checkoutPath: "/tmp/demo-qa",
      },
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.qaBundles.length, 1);
    assert.equal(persisted.qaBundles[0].projectId, "project_1");
    assert.equal(persisted.qaBundles[0].previewUrl, "http://127.0.0.1:4174/");
    assert.equal(persisted.qaBundles[0].integrationBranchUrl, "https://github.com/example/demo/tree/qa/demo");
    assert.equal(persisted.tasks[0].qaBundleId, persisted.qaBundles[0].id);
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite archives excess machine QA history without compacting human comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-history-compaction-"));
  try {
    const state = baseState();
    const machineComments = Array.from({ length: 30 }, (_, index) => ({
      id: `comment_${index + 1}`,
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: `QA integration blocked report ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    }));
    state.comments = [...machineComments];
    state.comments.splice(5, 0, {
      id: "comment_human",
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: "QA integration is a name I used for this human decision.",
      createdAt: "2026-07-01T00:05:30.000Z",
    });
    state.events = Array.from({ length: 50 }, (_, index) => ({
      id: `event_${index + 1}`,
      type: "qa_integration_blocked",
      projectId: "project_1",
      taskId: "task_1",
      message: `Blocked ${index + 1}`,
      createdAt: index < machineComments.length
        ? machineComments[index].createdAt
        : new Date(Date.UTC(2026, 6, 1, 1, index)).toISOString(),
    }));
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    let persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human").length, 20);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);

    const backupPath = persisted.meta.operationalArchive.backupPath;
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare("SELECT count(*) count FROM comments").get().count, 31);
      assert.equal(backupDb.prepare("SELECT count(*) count FROM events").get().count, 50);
    } finally {
      backupDb.close();
    }

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        for (let index = 1; index <= 5; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 6, 2, 0, index)).toISOString();
          state.comments.push({
            id: \`comment_new_\${index}\`,
            taskId: "task_1",
            author: "StudioOps QA Integration",
            systemGenerated: true,
            kind: "qa_integration",
            body: \`QA integration blocked new report \${index}\`,
            createdAt,
          });
          state.events.push({
            id: \`event_new_\${index}\`,
            type: "qa_integration_blocked",
            projectId: "project_1",
            taskId: "task_1",
            message: \`New blocked report \${index}\`,
            createdAt,
          });
        }
      });
    `);
    persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human").length, 20);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);

    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const archived = db.prepare("SELECT entity_type, count(*) count FROM operational_archive GROUP BY entity_type ORDER BY entity_type")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(archived, [
        { entity_type: "comments", count: 15 },
        { entity_type: "events", count: 15 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
