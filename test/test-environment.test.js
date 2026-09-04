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
import { pathToFileURL } from "node:url";
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

test("suite launcher applies repeatable test-file exclusions without falling back to discovery", async () => {
  const selected = await execFileAsync(process.execPath, [
    testRunner,
    "--test-file",
    "test/candidate-manifest.test.js",
    "--test-file",
    "test/studioops-plugin-client.test.js",
    "--exclude-test-file",
    "test/studioops-plugin-client.test.js",
  ], {
    cwd: repositoryRoot,
    timeout: 60_000,
  });
  assert.match(selected.stdout, /\[StudioOps\] Running 1 test files/);
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.doesNotMatch(packageJson.scripts["test:release"], /test\/qa-integration\.test\.js/);
  assert.match(packageJson.scripts["test:release"], /test\/studioops-plugin-client\.test\.js/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      testRunner,
      "--test-file",
      "test/candidate-manifest.test.js",
      "--exclude-test-file",
      "test/candidate-manifest.test.js",
    ], {
      cwd: repositoryRoot,
      timeout: 30_000,
    }),
    (error) => {
      assert.match(error.stderr, /selection is empty after applying exclusions/);
      return true;
    },
  );
});

test("suite launcher gives sandboxed Git fixtures a deterministic non-personal identity", async () => {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-git-identity-probe-"));
  const probePath = path.join(probeRoot, "probe.mjs");
  await writeFile(probePath, `console.log(JSON.stringify({
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  }));\n`, "utf8");
  try {
    const result = await execFileAsync(process.execPath, [testRunner, "--probe", probePath], {
      cwd: repositoryRoot,
      timeout: 30_000,
    });
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      authorName: "StudioOps Test",
      authorEmail: "studioops-test@example.invalid",
      committerName: "StudioOps Test",
      committerEmail: "studioops-test@example.invalid",
    });
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test("test-only promotion authority is revoked after any boot-realm identity pivot", async () => {
  const isolated = await createHermeticTestEnvironment();
  const realmUrl = pathToFileURL(path.join(repositoryRoot, "src", "test-authority-realm.js")).href;
  const remoteUrl = pathToFileURL(path.join(repositoryRoot, "src", "promotion-remote-observation.js")).href;
  const harnessUrl = pathToFileURL(path.join(repositoryRoot, "test", "support", "promotion-authority-harness.js")).href;
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const { assertPromotionRemoteObservation } = await import(${JSON.stringify(remoteUrl)});
    const {
      createPromotionRemoteTestObservation,
      createPromotionTestGitRunner,
    } = await import(${JSON.stringify(harnessUrl)});
    const {
      consumeIsolatedTestAuthority,
      isolatedTestAdapterRun,
    } = await import(${JSON.stringify(realmUrl)});
    const sha = "1".repeat(40);
    const digest = "sha256:" + "a".repeat(64);
    const bindingDigest = "sha256:" + "b".repeat(64);
    const candidate = {
      id: "candidate_realm",
      projectId: "project_realm",
      manifestDigest: digest,
      manifest: {
        base: { branch: "main", sha: "0".repeat(40) },
        integration: { branch: "qa/candidate-realm", sha },
      },
    };
    const authority = {
      projectId: candidate.projectId,
      repoUrl: "https://github.com/example/realm",
      targetBranch: "main",
      promotionBranch: "qa/promotion-realm",
      headSha: sha,
      candidate,
      subjectCandidate: candidate,
      claim: {
        claimId: "claim_realm",
        fence: 1,
        bindingDigest,
        projectId: candidate.projectId,
        candidateId: candidate.id,
        qaDecision: { candidateId: candidate.id, manifestDigest: digest, integrationSha: sha },
      },
    };
    const pr = {
      number: 1,
      url: "https://github.com/example/realm/pull/1",
      state: "OPEN",
      mergedAt: "",
      mergeCommit: "",
      baseRefName: "main",
      headRefName: "qa/promotion-realm",
      headRefOid: sha,
      headRepository: { nameWithOwner: "example/realm" },
      body: "<!-- studioops-candidate:candidate_realm:" + digest + " -->",
    };
    const adapter = createPromotionTestGitRunner(async () => ({ ok: true }));
    const observation = createPromotionRemoteTestObservation(authority, pr);
    assert.equal(assertPromotionRemoteObservation(authority, observation), observation);
    const rejectAll = () => {
      assert.throws(() => consumeIsolatedTestAuthority((capability) => capability), /test authority/i);
      assert.throws(() => createPromotionTestGitRunner(async () => ({ ok: true })), /test authority/i);
      assert.throws(() => isolatedTestAdapterRun(adapter, "promotion-git"), /test authority/i);
      assert.throws(() => createPromotionRemoteTestObservation(authority, pr), /test authority/i);
      assert.throws(() => assertPromotionRemoteObservation(authority, observation), /test authority|attested/i);
    };
    for (const [key, replacement] of [
      ["NODE_ENV", "production"],
      ["STUDIOOPS_TEST_ISOLATION", "0"],
      ["STUDIOOPS_TEST_ROOT", path.join(process.env.STUDIOOPS_TEST_ROOT, "pivot")],
      ["STUDIOOPS_TEST_ISOLATION_TOKEN", "wrong-token"],
      ["STUDIOOPS_ROOT", path.join(process.env.STUDIOOPS_TEST_ROOT, "pivot-control")],
      ["STUDIOOPS_DATA_DIR", path.join(process.env.STUDIOOPS_TEST_ROOT, "pivot-data")],
      ["STUDIOOPS_CONFIG_ROOT", path.join(process.env.STUDIOOPS_TEST_ROOT, "pivot-config")],
    ]) {
      const original = process.env[key];
      process.env[key] = replacement;
      rejectAll();
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
      assert.equal(assertPromotionRemoteObservation(authority, observation), observation);
    }
    const marker = path.join(process.env.STUDIOOPS_TEST_ROOT, ".studioops-test-isolation");
    const markerToken = readFileSync(marker, "utf8");
    writeFileSync(marker, "wrong-token\\n", { mode: 0o600 });
    rejectAll();
    writeFileSync(marker, markerToken, { mode: 0o600 });
    assert.equal(assertPromotionRemoteObservation(authority, observation), observation);
    unlinkSync(marker);
    writeFileSync(marker, markerToken, { mode: 0o600 });
    rejectAll();
  `;
  try {
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repositoryRoot,
      env: isolated.env,
      timeout: 30_000,
    });
  } finally {
    await isolated.cleanup();
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
