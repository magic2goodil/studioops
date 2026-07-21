import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;

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

async function writeLegacyState(root) {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "mission-control.json"), `${JSON.stringify(baseState(), null, 2)}\n`, "utf8");
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
