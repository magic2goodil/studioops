import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeStudioOpsRuns,
  acquireStudioOpsMaintenanceLease,
  assertNoActiveStudioOpsRuns,
  migrateLegacyStudioOpsHome,
  migrateLocalStudioOpsState,
  releaseStudioOpsMaintenanceLease,
} from "../src/local-state-migration.js";

async function createLegacyRoot(root) {
  const dataDir = path.join(root, "data");
  await mkdir(path.join(dataDir, "local-attachments"), { recursive: true });
  await writeFile(path.join(root, "mission-control.config.md"), `# legacy config

\`\`\`json mission-control-config
${JSON.stringify({
  defaults: {
    runner: {
      workspaceRoot: "~/.mission-control/run-workspaces",
      githubAppCredentialsDir: ".mission-control/github-apps",
    },
  },
})}
\`\`\`
`, "utf8");
  await writeFile(path.join(dataDir, "local-attachments", "task-image.txt"), "attachment", "utf8");
  const credentials = path.join(root, ".mission-control", "github-apps", "default");
  await mkdir(credentials, { recursive: true });
  await writeFile(path.join(credentials, "private-key.pem"), "test-key", "utf8");

  const databasePath = path.join(dataDir, "mission-control.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE state_meta (
      singleton_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO state_meta VALUES (1, ?, 1, ?)").run("{}", "2026-07-22T00:00:00.000Z");
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "run_1",
    0,
    "project_1",
    "task_1",
    "running",
    "builder",
    "2026-07-22T00:00:00.000Z",
    JSON.stringify({ id: "run_1", taskId: "task_1", status: "running" }),
  );
  db.close();
  return databasePath;
}

test("local state migration refuses active runs and preserves state securely once idle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-migration-"));
  const sourceRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "studioops", "control-plane");
  const credentialsRoot = path.join(root, "studioops", "credentials", "github-apps");
  try {
    const sourceDatabase = await createLegacyRoot(sourceRoot);
    assert.equal((await activeStudioOpsRuns(sourceRoot)).length, 1);
    await assert.rejects(
      assertNoActiveStudioOpsRuns([sourceRoot]),
      /Refusing to restart StudioOps while active runs exist/,
    );

    const db = new DatabaseSync(sourceDatabase);
    db.prepare("UPDATE runs SET status = 'completed'").run();
    db.close();
    assert.equal((await activeStudioOpsRuns(sourceRoot)).length, 0);

    const maintenance = await acquireStudioOpsMaintenanceLease(sourceRoot, { nowMs: Date.parse("2026-07-22T01:00:00.000Z") });
    assert.match(maintenance.lease.id, /^local_root_migration_/);
    await assert.rejects(
      acquireStudioOpsMaintenanceLease(sourceRoot, { nowMs: Date.parse("2026-07-22T01:01:00.000Z") }),
      /maintenance is already in progress/,
    );
    assert.equal(await releaseStudioOpsMaintenanceLease(sourceRoot, maintenance.lease.id), true);

    const studioHome = path.join(root, "studioops");
    const result = await migrateLocalStudioOpsState({
      sourceRoot,
      targetRoot,
      credentialsRoot,
      legacyHome: path.join(root, ".mission-control"),
      studioHome,
    });
    assert.equal(result.status, "migrated");
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(targetRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(credentialsRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(credentialsRoot, "default", "private-key.pem"))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(path.join(targetRoot, "data", "local-attachments", "task-image.txt"), "utf8"),
      "attachment",
    );
    const migratedConfig = await readFile(path.join(targetRoot, "studioops.config.md"), "utf8");
    assert.match(migratedConfig, new RegExp(path.join(studioHome, "run-workspaces").replaceAll("\\", "\\\\")));
    assert.match(migratedConfig, new RegExp(credentialsRoot.replaceAll("\\", "\\\\")));
    assert.equal((await activeStudioOpsRuns(targetRoot)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local state migration refuses to overwrite an existing target database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-migration-existing-"));
  const sourceRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "studioops", "control-plane");
  try {
    const sourceDatabase = await createLegacyRoot(sourceRoot);
    const db = new DatabaseSync(sourceDatabase);
    db.prepare("UPDATE runs SET status = 'completed'").run();
    db.close();
    await mkdir(path.join(targetRoot, "data"), { recursive: true });
    await writeFile(path.join(targetRoot, "data", "mission-control.sqlite3"), "existing", "utf8");
    await assert.rejects(
      migrateLocalStudioOpsState({
        sourceRoot,
        targetRoot,
        credentialsRoot: path.join(root, "studioops", "credentials", "github-apps"),
      }),
      /Refusing to overwrite an existing StudioOps database/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local state migration refuses to merge into an existing target root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-local-migration-root-"));
  const sourceRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "studioops", "control-plane");
  try {
    const sourceDatabase = await createLegacyRoot(sourceRoot);
    const db = new DatabaseSync(sourceDatabase);
    db.prepare("UPDATE runs SET status = 'completed'").run();
    db.close();
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "keep.txt"), "existing", "utf8");
    await assert.rejects(
      migrateLocalStudioOpsState({
        sourceRoot,
        targetRoot,
        credentialsRoot: path.join(root, "studioops", "credentials", "github-apps"),
      }),
      /Refusing to merge migration state into an existing StudioOps working root/,
    );
    assert.equal(await readFile(path.join(targetRoot, "keep.txt"), "utf8"), "existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy operational workspaces move under the StudioOps home without overwriting targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-home-"));
  const sourceHome = path.join(root, ".mission-control");
  const targetHome = path.join(root, ".codex", "studioops");
  try {
    await mkdir(path.join(sourceHome, "run-workspaces", "demo"), { recursive: true });
    await mkdir(path.join(sourceHome, "qa-workspaces", "demo"), { recursive: true });
    await writeFile(path.join(sourceHome, "run-workspaces", "demo", "run.txt"), "run", "utf8");
    await writeFile(path.join(sourceHome, "qa-workspaces", "demo", "qa.txt"), "qa", "utf8");
    const result = await migrateLegacyStudioOpsHome({ sourceHome, targetHome });
    assert.deepEqual(result.copied.sort(), ["qa-workspaces", "run-workspaces"]);
    assert.equal(await readFile(path.join(targetHome, "run-workspaces", "demo", "run.txt"), "utf8"), "run");
    assert.equal(await readFile(path.join(targetHome, "qa-workspaces", "demo", "qa.txt"), "utf8"), "qa");
    assert.equal((await stat(targetHome)).mode & 0o777, 0o700);

    await writeFile(path.join(sourceHome, "run-workspaces", "demo", "run.txt"), "changed", "utf8");
    const repeated = await migrateLegacyStudioOpsHome({ sourceHome, targetHome });
    assert.deepEqual(repeated.copied, []);
    assert.equal(await readFile(path.join(targetHome, "run-workspaces", "demo", "run.txt"), "utf8"), "run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
