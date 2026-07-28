import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const testRunner = path.join(repositoryRoot, "scripts", "run-tests.js");
const probe = path.join("test", "test-environment-probe.js");

function conflictingEnvironment(root) {
  const dataDir = path.join(root, "live-data");
  const configRoot = path.join(root, "live-config");
  return {
    ...process.env,
    STUDIOOPS_HOME: root,
    STUDIOOPS_ROOT: root,
    STUDIOOPS_WORKING_ROOT: root,
    STUDIOOPS_DATA_DIR: dataDir,
    STUDIOOPS_CONFIG_ROOT: configRoot,
    MISSION_CONTROL_ROOT: root,
    MISSION_CONTROL_WORKING_ROOT: root,
    MISSION_CONTROL_DATA_DIR: dataDir,
    MISSION_CONTROL_CONFIG_ROOT: configRoot,
    GH_TOKEN: "must-not-reach-tests",
    OPENAI_API_KEY: "must-not-reach-tests",
  };
}

test("suite launcher overrides conflicting inherited StudioOps paths", async () => {
  const inheritedRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-inherited-live-"));
  const sentinel = path.join(inheritedRoot, "sentinel.txt");
  await writeFile(sentinel, "unchanged\n", "utf8");
  try {
    const result = await execFileAsync(process.execPath, [testRunner, "--probe", probe], {
      cwd: repositoryRoot,
      env: conflictingEnvironment(inheritedRoot),
      timeout: 30_000,
    });
    const lines = result.stdout.trim().split("\n");
    const paths = JSON.parse(lines.at(-1));
    assert.notEqual(paths.testRoot, inheritedRoot);
    assert.equal(path.relative(paths.testRoot, paths.controlRoot).startsWith(".."), false);
    assert.equal(path.relative(paths.testRoot, paths.dataDir).startsWith(".."), false);
    assert.equal(path.relative(paths.testRoot, paths.configRoot).startsWith(".."), false);
    assert.equal(path.relative(paths.testRoot, paths.databaseFile).startsWith(".."), false);
    assert.deepEqual(paths.inheritedCredentialKeys, []);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
    await assert.rejects(access(path.join(inheritedRoot, "live-data", "mission-control.sqlite3")));
  } finally {
    await rm(inheritedRoot, { recursive: true, force: true });
  }
});

test("database access fails closed in an unmarked Node test context", async () => {
  const inheritedRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-unmarked-test-"));
  const inheritedDataDir = path.join(inheritedRoot, "live-data");
  const inheritedDatabase = path.join(inheritedDataDir, "mission-control.sqlite3");
  await mkdir(inheritedDataDir);
  await writeFile(inheritedDatabase, "live-database-sentinel\n", "utf8");
  await chmod(inheritedDataDir, 0o755);
  await chmod(inheritedDatabase, 0o644);
  try {
    const env = conflictingEnvironment(inheritedRoot);
    delete env.STUDIOOPS_TEST_ISOLATION;
    delete env.STUDIOOPS_TEST_ROOT;
    delete env.STUDIOOPS_TEST_ISOLATION_TOKEN;
    env.NODE_TEST_CONTEXT = "child-v8";
    await assert.rejects(
      execFileAsync(process.execPath, [probe], {
        cwd: repositoryRoot,
        env,
        timeout: 30_000,
      }),
      (error) => {
        assert.match(error.stderr, /verified temporary test root/);
        return true;
      },
    );
    assert.equal(await readFile(inheritedDatabase, "utf8"), "live-database-sentinel\n");
    assert.equal((await stat(inheritedDataDir)).mode & 0o777, 0o755);
    assert.equal((await stat(inheritedDatabase)).mode & 0o777, 0o644);
  } finally {
    await rm(inheritedRoot, { recursive: true, force: true });
  }
});

test("database access rejects a symlink that escapes the marked test root", async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-symlink-test-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-symlink-outside-"));
  try {
    const isolated = await createHermeticTestEnvironment({ testRoot });
    await rm(isolated.dataDir, { recursive: true, force: true });
    await symlink(outsideRoot, isolated.dataDir, "dir");
    await assert.rejects(
      execFileAsync(process.execPath, [probe], {
        cwd: repositoryRoot,
        env: isolated.env,
        timeout: 30_000,
      }),
      (error) => {
        assert.match(error.stderr, /data directory escapes the temporary test root/);
        return true;
      },
    );
    await assert.rejects(access(path.join(outsideRoot, "mission-control.sqlite3")));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
