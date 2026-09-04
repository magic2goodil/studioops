import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { promisify } from "node:util";
import {
  cleanupProjectValidationSandbox,
  installPreparedProjectValidationDependencies,
  prepareProjectValidationSandbox,
  prepareProjectValidationDependencies,
  PROJECT_VALIDATION_SANDBOX_ISOLATION,
  PROJECT_VALIDATION_SANDBOX_POLICY_ID,
  runProjectValidationCommand,
  verifyProjectValidationSandbox,
} from "../src/project-validation-sandbox.js";

const execFileAsync = promisify(execFile);
const NESTED_PROJECT_SANDBOX = Boolean(process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX);

test("the release suite observes the active outer data-and-egress boundary", {
  skip: !NESTED_PROJECT_SANDBOX,
  timeout: 10_000,
}, async () => {
  assert.equal(process.env.STUDIOOPS_PROJECT_VALIDATION_SANDBOX, PROJECT_VALIDATION_SANDBOX_POLICY_ID);
  await assert.rejects(
    readFile("/private/etc/hosts", "utf8"),
    (error) => ["EACCES", "EPERM"].includes(error?.code),
  );
  const networkResult = await new Promise((resolve) => {
    const server = createServer();
    const timer = setTimeout(() => {
      server.close();
      resolve("timeout");
    }, 2_000);
    server.once("error", (error) => {
      clearTimeout(timer);
      resolve(error?.code || "error");
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      server.close(() => resolve("allowed"));
    });
  });
  assert.notEqual(networkResult, "allowed");
  assert.notEqual(networkResult, "timeout");
});

async function git(repoPath, args) {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function repositoryFixture(root) {
  const repoPath = path.join(root, "source");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.name", "StudioOps Test"]);
  await git(repoPath, ["config", "user.email", "studioops-test@localhost"]);
  await writeFile(path.join(repoPath, "tracked.txt"), "exact candidate\n", "utf8");
  await git(repoPath, ["add", "tracked.txt"]);
  await git(repoPath, ["commit", "-m", "candidate"]);
  return { repoPath, head: await git(repoPath, ["rev-parse", "HEAD"]) };
}

test("project validation uses a disposable no-network sandbox and cannot reach sibling host data", {
  skip: process.platform !== "darwin" || NESTED_PROJECT_SANDBOX,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-sandbox-"));
  const { repoPath, head } = await repositoryFixture(root);
  const workspaceRoot = path.join(root, "workspaces");
  const outsideSecret = path.join(root, "outside-secret.txt");
  const secret = "must-not-cross-validation-boundary";
  await writeFile(outsideSecret, secret, { mode: 0o600 });
  const privateExecutableDir = path.join(root, "private-executable");
  const privateExecutableSource = path.join(privateExecutableDir, "private.c");
  const privateExecutable = path.join(privateExecutableDir, "private-helper");
  const privateExecutableSentinel = `private-exec-${randomUUID()}`;
  await mkdir(privateExecutableDir, { recursive: true, mode: 0o700 });
  await writeFile(
    privateExecutableSource,
    `#include <stdio.h>\nint main(void) { puts(${JSON.stringify(privateExecutableSentinel)}); return 0; }\n`,
    { mode: 0o600 },
  );
  await execFileAsync("/usr/bin/clang", [privateExecutableSource, "-o", privateExecutable]);
  let sandbox;
  let detachedPid = 0;
  let hostSentinelProcess = null;
  const boundedDetachedPids = [];
  try {
    sandbox = await prepareProjectValidationSandbox({
      sourceRepoPath: repoPath,
      workspaceRoot,
      expectedHeadSha: head,
    });
    assert.equal(sandbox.policyId, PROJECT_VALIDATION_SANDBOX_POLICY_ID);
    assert.notEqual(sandbox.repoPath, repoPath);
    assert.deepEqual(sandbox.processPolicy, PROJECT_VALIDATION_SANDBOX_ISOLATION);

    const nodeOs = await runProjectValidationCommand(
      sandbox,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const os=require('node:os'); process.stdout.write(JSON.stringify({type:os.type(),release:os.release(),arch:os.arch(),memory:os.totalmem(),uptime:os.uptime(),cpus:os.cpus().length,load:os.loadavg().length}))")}`,
    );
    assert.equal(nodeOs.ok, true, nodeOs.output);
    assert.equal(JSON.parse(nodeOs.stdout).load, 3);

    const npmRuntime = await runProjectValidationCommand(sandbox, "npm --version");
    assert.equal(npmRuntime.ok, true, npmRuntime.output);

    const frameworkPython = "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3";
    const frameworkPythonAvailable = await readFile(frameworkPython)
      .then(() => true)
      .catch(() => false);
    if (frameworkPythonAvailable) {
      const pythonRuntime = await runProjectValidationCommand(
        sandbox,
        `${JSON.stringify(frameworkPython)} --version`,
      );
      assert.equal(pythonRuntime.ok, true, pythonRuntime.output);
      assert.match(pythonRuntime.stdout, /^Python 3\.11\./);
    }

    const hostSentinel = `host-process-${randomUUID()}`;
    hostSentinelProcess = spawn("/bin/sleep", ["30"], {
      env: { ...process.env, STUDIOOPS_SANDBOX_HOST_SENTINEL: hostSentinel },
      stdio: "ignore",
    });
    const processInspection = await runProjectValidationCommand(
      sandbox,
      `/bin/ps eww -p ${hostSentinelProcess.pid}`,
      { timeoutMs: 5_000 },
    );
    assert.equal(processInspection.output.includes(hostSentinel), false);

    const privateExecution = await runProjectValidationCommand(
      sandbox,
      JSON.stringify(privateExecutable),
      { timeoutMs: 5_000 },
    );
    assert.equal(privateExecution.ok, false);
    assert.equal(privateExecution.output.includes(privateExecutableSentinel), false);

    const allowed = await runProjectValidationCommand(
      sandbox,
      "test -f tracked.txt && test -d \"$HOME\" && printf allowed > generated.txt",
    );
    assert.equal(allowed.ok, true, allowed.output);
    assert.equal(await readFile(path.join(sandbox.repoPath, "generated.txt"), "utf8"), "allowed");

    const directRead = await runProjectValidationCommand(
      sandbox,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(outsideSecret)}, "utf8"))`)}`,
    );
    assert.equal(directRead.ok, false);
    assert.equal(directRead.output.includes(secret), false);

    for (const deniedSystemPath of [
      "/private/etc/hosts",
      "/Library/Preferences/com.apple.loginwindow.plist",
    ]) {
      const systemRead = await runProjectValidationCommand(
        sandbox,
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").readFileSync(${JSON.stringify(deniedSystemPath)})`)}`,
      );
      assert.equal(systemRead.ok, false, `validation unexpectedly read ${deniedSystemPath}`);
    }

    const symlinkRead = await runProjectValidationCommand(
      sandbox,
      `ln -s ${JSON.stringify(outsideSecret)} escape-link && cat escape-link`,
    );
    assert.equal(symlinkRead.ok, false);
    assert.equal(symlinkRead.output.includes(secret), false);

    const network = await runProjectValidationCommand(
      sandbox,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:net').createServer().listen(0, '127.0.0.1')")}`,
      { timeoutMs: 5_000 },
    );
    assert.equal(network.ok, false);

    const background = await runProjectValidationCommand(
      sandbox,
      "sh -c 'while :; do :; done' >/dev/null 2>&1 & printf \"$!\"",
      { timeoutMs: 5_000 },
    );
    assert.equal(background.ok, true, background.output);
    const backgroundPid = Number(background.stdout);
    assert.equal(Number.isInteger(backgroundPid) && backgroundPid > 0, true);
    let backgroundAlive = true;
    for (let attempt = 0; attempt < 20 && backgroundAlive; attempt += 1) {
      try {
        process.kill(backgroundPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        backgroundAlive = false;
      }
    }
    assert.equal(backgroundAlive, false, "sandbox descendants must not survive command completion");

    // Seatbelt is inherited by detached descendants, but macOS exposes no
    // public unprivileged job/coalition API that can atomically terminate a
    // child after it creates a new session. Characterize that limitation
    // explicitly while proving the surviving child retains the data/egress
    // boundary. The test harness terminates only the exact captured PID.
    const detachedPidPath = path.join(sandbox.repoPath, "detached.pid");
    const detachedResultPath = path.join(sandbox.repoPath, "detached-result.json");
    const forbiddenDetachedWrite = path.join(root, "detached-host-write.txt");
    const detachedChildScript = [
      "const fs = require('node:fs')",
      "const net = require('node:net')",
      `let readDenied = false; try { fs.readFileSync(${JSON.stringify(outsideSecret)}) } catch { readDenied = true }`,
      `let writeDenied = false; try { fs.writeFileSync(${JSON.stringify(forbiddenDetachedWrite)}, 'forbidden') } catch { writeDenied = true }`,
      "const server = net.createServer()",
      "let finished = false",
      "const finish = (networkDenied) => { if (finished) return; finished = true; try { server.close() } catch {} fs.writeFileSync('detached-result.json', JSON.stringify({ readDenied, writeDenied, networkDenied })); setInterval(() => {}, 1000) }",
      "server.once('error', () => finish(true))",
      "server.listen(0, '127.0.0.1', () => finish(false))",
      "setTimeout(() => finish(false), 1000)",
    ].join(";");
    const detachedLauncherScript = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(detachedChildScript)}], { detached: true, stdio: 'ignore' })`,
      "writeFileSync('detached.pid', String(child.pid))",
      "child.unref()",
    ].join(";");
    const detached = await runProjectValidationCommand(
      sandbox,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(detachedLauncherScript)}`,
      { timeoutMs: 5_000 },
    );
    assert.equal(detached.ok, true, detached.output);
    detachedPid = Number(await readFile(detachedPidPath, "utf8"));
    assert.equal(Number.isInteger(detachedPid) && detachedPid > 0, true);
    let detachedResult = null;
    for (let attempt = 0; attempt < 80 && !detachedResult; attempt += 1) {
      try {
        detachedResult = JSON.parse(await readFile(detachedResultPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.deepEqual(detachedResult, { readDenied: true, writeDenied: true, networkDenied: true });
    assert.equal(await readFile(forbiddenDetachedWrite, "utf8").then(() => true).catch(() => false), false);
    assert.doesNotThrow(() => process.kill(detachedPid, 0));

    for (const scenario of ["timeout", "overflow"]) {
      const pidPath = path.join(sandbox.repoPath, `bounded-detached-${scenario}.pid`);
      const childScript = "setInterval(() => {}, 1000)";
      const launcher = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'inherit' })`,
        `writeFileSync(${JSON.stringify(path.basename(pidPath))}, String(child.pid))`,
        "child.unref()",
        scenario === "timeout"
          ? "setInterval(() => {}, 1000)"
          : "process.stdout.write('x'.repeat(8192))",
      ].join(";");
      const startedAt = Date.now();
      const bounded = await runProjectValidationCommand(
        sandbox,
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(launcher)}`,
        scenario === "timeout"
          ? { timeoutMs: 250 }
          : { timeoutMs: 5_000, maxCaptureBytes: 128 },
      );
      assert.equal(bounded[scenario === "timeout" ? "timedOut" : "overflow"], true, bounded.output);
      assert.ok(Date.now() - startedAt < 2_000, `${scenario} must settle despite inherited detached stdio`);
      const boundedPid = Number(await readFile(pidPath, "utf8"));
      assert.equal(Number.isInteger(boundedPid) && boundedPid > 0, true);
      boundedDetachedPids.push(boundedPid);
      assert.doesNotThrow(() => process.kill(boundedPid, 0));
    }

    const poisoned = await runProjectValidationCommand(
      sandbox,
      "mkdir -p .git/hooks && printf '#!/bin/sh\\nexit 91\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push && git config core.hooksPath .git/hooks",
    );
    assert.equal(poisoned.ok, true, poisoned.output);
    assert.equal(await git(repoPath, ["config", "--local", "--get", "core.hooksPath"]).catch(() => ""), "");
    assert.equal(await readFile(path.join(repoPath, "tracked.txt"), "utf8"), "exact candidate\n");
    assert.deepEqual(await verifyProjectValidationSandbox(sandbox), {
      head,
      policyId: PROJECT_VALIDATION_SANDBOX_POLICY_ID,
      strategy: "disposable_full_clone",
      networkPolicy: "deny_all",
      processPolicy: PROJECT_VALIDATION_SANDBOX_ISOLATION,
    });
  } finally {
    if (hostSentinelProcess?.pid) {
      try {
        process.kill(hostSentinelProcess.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (detachedPid > 0) {
      try {
        process.kill(detachedPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    for (const pid of boundedDetachedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (sandbox) await cleanupProjectValidationSandbox(sandbox);
    await rm(root, { recursive: true, force: true });
  }
});

test("npm dependencies are acquired without lifecycle scripts and installed offline inside the sandbox", {
  skip: process.platform !== "darwin" || NESTED_PROJECT_SANDBOX,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-npm-validation-"));
  const { repoPath } = await repositoryFixture(root);
  const dependencyPath = path.join(root, "dependency");
  await mkdir(dependencyPath, { recursive: true });
  await writeFile(path.join(dependencyPath, "package.json"), JSON.stringify({
    name: "studioops-cache-fixture",
    version: "1.0.0",
    main: "index.js",
  }) + "\n");
  await writeFile(path.join(dependencyPath, "index.js"), "module.exports = 'cached';\n");
  const packed = await execFileAsync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], {
    cwd: dependencyPath,
  });
  const tarball = await readFile(path.join(root, packed.stdout.trim()));
  let registryRequests = 0;
  const registry = createHttpServer((request, response) => {
    registryRequests += 1;
    if (request.url !== "/dependency.tgz") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.byteLength });
    response.end(tarball);
  });
  await new Promise((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", resolve);
  });
  const port = registry.address().port;
  await writeFile(path.join(repoPath, "package.json"), JSON.stringify({
    name: "studioops-npm-fixture",
    version: "1.0.0",
    dependencies: { "studioops-cache-fixture": `http://127.0.0.1:${port}/dependency.tgz` },
    scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"" },
  }) + "\n");
  await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: repoPath,
  });
  await git(repoPath, ["add", "package.json", "package-lock.json"]);
  await git(repoPath, ["commit", "-m", "npm fixture"]);
  const npmHead = await git(repoPath, ["rev-parse", "HEAD"]);
  let sandbox;
  try {
    sandbox = await prepareProjectValidationSandbox({
      sourceRepoPath: repoPath,
      workspaceRoot: path.join(root, "workspaces"),
      expectedHeadSha: npmHead,
    });
    const prepared = await prepareProjectValidationDependencies(sandbox, {
      dependencyAcquisitionTimeoutMs: 15_000,
    });
    assert.equal(prepared.status, "prepared");
    assert.ok(registryRequests > 0, "cold acquisition should populate the cache from the fixture registry");
    assert.equal(await readFile(path.join(sandbox.repoPath, "lifecycle-ran"), "utf8").catch(() => ""), "");
    await new Promise((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    const warm = await prepareProjectValidationDependencies(sandbox, {
      dependencyAcquisitionTimeoutMs: 15_000,
    });
    assert.equal(warm.status, "prepared");
    const installed = await installPreparedProjectValidationDependencies(sandbox, { validationTimeoutMs: 15_000 });
    assert.equal(installed.ok, true, installed.output);
    assert.equal(await readFile(path.join(sandbox.repoPath, "lifecycle-ran"), "utf8"), "yes");
    assert.equal(sandbox.environment.npm_config_cache, prepared.cachePath);
    await rm(path.join(sandbox.repoPath, "node_modules"), { recursive: true, force: true });
    await rm(path.join(prepared.cachePath, "_cacache"), { recursive: true, force: true });
    const missing = await installPreparedProjectValidationDependencies(sandbox, { validationTimeoutMs: 15_000 });
    assert.equal(missing.ok, false);
    assert.match(missing.output, /offline|cache|ENOTCACHED/i);
  } finally {
    if (registry.listening) await new Promise((resolve) => registry.close(resolve));
    await cleanupProjectValidationSandbox(sandbox);
    await rm(root, { recursive: true, force: true });
  }
});

test("validation identity drift fails closed and an unavailable provider runs nothing", {
  skip: process.platform !== "darwin" || NESTED_PROJECT_SANDBOX,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-drift-"));
  const { repoPath, head } = await repositoryFixture(root);
  let sandbox;
  let aliasSandbox;
  try {
    await assert.rejects(
      prepareProjectValidationSandbox({
        sourceRepoPath: repoPath,
        workspaceRoot: path.join(root, "unavailable"),
        expectedHeadSha: head,
        sandboxExecutable: path.join(root, "fake-sandbox-exec"),
      }),
      (error) => error.code === "PROJECT_VALIDATION_SANDBOX_UNAVAILABLE",
    );
    const unapprovedTools = path.join(root, "unapproved-tools");
    await mkdir(unapprovedTools, { recursive: true });
    await assert.rejects(
      prepareProjectValidationSandbox({
        sourceRepoPath: repoPath,
        workspaceRoot: path.join(root, "unsafe-path"),
        expectedHeadSha: head,
        validationPath: unapprovedTools,
      }),
      (error) => error.code === "PROJECT_VALIDATION_INPUT_INVALID" && /Unsafe validation PATH entry/.test(error.message),
    );
    for (const validationPath of ["", ".", path.join(root, "missing-tools")]) {
      await assert.rejects(
        prepareProjectValidationSandbox({
          sourceRepoPath: repoPath,
          workspaceRoot: path.join(root, `invalid-path-${Buffer.from(validationPath).toString("hex") || "empty"}`),
          expectedHeadSha: head,
          validationPath,
        }),
        (error) => error.code === "PROJECT_VALIDATION_INPUT_INVALID" && /Unsafe validation PATH entry/.test(error.message),
      );
    }
    const toolAlias = path.join(root, "approved-tool-alias");
    await symlink("/usr/bin", toolAlias);
    aliasSandbox = await prepareProjectValidationSandbox({
      sourceRepoPath: repoPath,
      workspaceRoot: path.join(root, "aliased-path"),
      expectedHeadSha: head,
      validationPath: toolAlias,
    });
    assert.equal(aliasSandbox.environment.PATH, "/usr/bin");
    assert.equal((await runProjectValidationCommand(aliasSandbox, "git --version")).ok, true);
    await cleanupProjectValidationSandbox(aliasSandbox);
    aliasSandbox = null;

    const workspaceAlias = path.join(root, "workspace-alias-into-source");
    await symlink(repoPath, workspaceAlias);
    await assert.rejects(
      prepareProjectValidationSandbox({
        sourceRepoPath: repoPath,
        workspaceRoot: workspaceAlias,
        expectedHeadSha: head,
      }),
      (error) => error.code === "PROJECT_VALIDATION_INPUT_INVALID" && /outside its trusted source clone/.test(error.message),
    );
    assert.deepEqual((await readdir(repoPath)).filter((name) => name.startsWith("validation-sandbox-")), []);

    sandbox = await prepareProjectValidationSandbox({
      sourceRepoPath: repoPath,
      workspaceRoot: path.join(root, "drift"),
      expectedHeadSha: head,
    });
    const changed = await runProjectValidationCommand(sandbox, "printf changed > tracked.txt");
    assert.equal(changed.ok, true, changed.output);
    await assert.rejects(
      verifyProjectValidationSandbox(sandbox),
      (error) => error.code === "PROJECT_VALIDATION_IDENTITY_DRIFT",
    );
  } finally {
    if (aliasSandbox) await cleanupProjectValidationSandbox(aliasSandbox);
    if (sandbox) await cleanupProjectValidationSandbox(sandbox);
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox cleanup rejects forged prefix-named paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-cleanup-"));
  const victim = path.join(root, "validation-sandbox-user-data");
  const marker = path.join(victim, "keep.txt");
  try {
    await mkdir(victim, { recursive: true });
    await writeFile(marker, "keep", "utf8");
    await assert.rejects(
      cleanupProjectValidationSandbox({ rootPath: victim }),
      (error) => error.code === "PROJECT_VALIDATION_CLEANUP_UNSAFE",
    );
    assert.equal(await readFile(marker, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation integrity ignores candidate-controlled replace refs, index flags, and worktree config", {
  skip: process.platform !== "darwin" || NESTED_PROJECT_SANDBOX,
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-index-bypass-"));
  const { repoPath, head } = await repositoryFixture(root);
  const attacks = [
    [
      "printf replaced > tracked.txt",
      "git add tracked.txt",
      "tree=$(git write-tree)",
      "replacement=$(printf replacement | GIT_AUTHOR_NAME=StudioOps GIT_AUTHOR_EMAIL=studioops@example.invalid GIT_COMMITTER_NAME=StudioOps GIT_COMMITTER_EMAIL=studioops@example.invalid git commit-tree \"$tree\" -p HEAD)",
      "git replace HEAD \"$replacement\"",
    ].join(" && "),
    "git update-index --assume-unchanged tracked.txt && printf assumed > tracked.txt",
    "git update-index --skip-worktree tracked.txt && printf skipped > tracked.txt",
    "mkdir ../alternate-worktree && cp tracked.txt ../alternate-worktree/tracked.txt && git config core.worktree ../alternate-worktree && printf redirected > tracked.txt",
  ];
  try {
    for (let index = 0; index < attacks.length; index += 1) {
      let sandbox;
      try {
        sandbox = await prepareProjectValidationSandbox({
          sourceRepoPath: repoPath,
          workspaceRoot: path.join(root, `workspaces-${index}`),
          expectedHeadSha: head,
        });
        const attack = await runProjectValidationCommand(sandbox, attacks[index]);
        assert.equal(attack.ok, true, attack.output);
        await assert.rejects(
          verifyProjectValidationSandbox(sandbox),
          (error) => error.code === "PROJECT_VALIDATION_IDENTITY_DRIFT",
        );
      } finally {
        if (sandbox) await cleanupProjectValidationSandbox(sandbox);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambient Git configuration cannot redirect the trusted validation clone", {
  skip: process.platform !== "darwin" || NESTED_PROJECT_SANDBOX,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-git-env-"));
  const source = await repositoryFixture(path.join(root, "source-fixture"));
  const alternate = await repositoryFixture(path.join(root, "alternate-fixture"));
  await writeFile(path.join(alternate.repoPath, "tracked.txt"), "redirected candidate\n", "utf8");
  await git(alternate.repoPath, ["commit", "-am", "redirected candidate"]);
  const alternateHead = await git(alternate.repoPath, ["rev-parse", "HEAD"]);
  const injected = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${alternate.repoPath}.insteadOf`,
    GIT_CONFIG_VALUE_0: source.repoPath,
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  let sandbox;
  try {
    const redirected = await execFileAsync("/usr/bin/git", ["ls-remote", source.repoPath, "HEAD"], {
      env: { ...process.env, ...injected },
    });
    assert.match(redirected.stdout, new RegExp(`^${alternateHead}\\s+HEAD`, "m"));

    Object.assign(process.env, injected);
    sandbox = await prepareProjectValidationSandbox({
      sourceRepoPath: source.repoPath,
      workspaceRoot: path.join(root, "workspaces"),
      expectedHeadSha: source.head,
    });
    assert.equal(sandbox.expectedHeadSha, source.head);
    assert.equal(await readFile(path.join(sandbox.repoPath, "tracked.txt"), "utf8"), "exact candidate\n");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (sandbox) await cleanupProjectValidationSandbox(sandbox);
    await rm(root, { recursive: true, force: true });
  }
});
