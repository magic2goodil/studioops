import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { activateRuntime, deployRuntime } from "../src/runtime-install.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const VERIFY_SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "install-launchagents.js");
const CANONICAL_REPOSITORY = "https://github.com/magic2goodil/studioops";

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout || "").trim();
}

async function verificationFixture(input = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-identity-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const pluginRoot = path.join(sourceRoot, "plugins", "studioops", ".codex-plugin");
  for (const directory of ["src", "public", "scripts", "deploy", "data", "logs", "credentials", "node_modules"]) {
    await mkdir(path.join(sourceRoot, directory), { recursive: true });
  }
  await mkdir(pluginRoot, { recursive: true });
  const packageJson = { name: "studioops", version: "2.0.0" };
  const pluginJson = {
    name: "studioops",
    version: "2.1.0",
    repository: CANONICAL_REPOSITORY,
    homepage: CANONICAL_REPOSITORY,
  };
  await Promise.all([
    writeFile(path.join(sourceRoot, ".gitignore"), "data/\nlogs/\ncredentials/\nnode_modules/\n"),
    writeFile(path.join(sourceRoot, "README.md"), input.stale ? "Mission Control owner guide\n" : "StudioOps owner guide\n"),
    writeFile(path.join(sourceRoot, "src", "server.js"), "export {};\n"),
    writeFile(
      path.join(sourceRoot, "src", "compatibility.js"),
      "export const legacyLabel = \"com.codex.mission-control.web\";\n"
        + "export const legacyVariable = \"MISSION_CONTROL_RUNTIME_ROOT\";\n"
        + "export const historicalAuthor = \"Mission Control QA Integration\";\n",
    ),
    writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify(packageJson)}\n`),
    writeFile(path.join(sourceRoot, "package-lock.json"), `${JSON.stringify({
      ...packageJson,
      lockfileVersion: 3,
      packages: {},
    })}\n`),
    writeFile(path.join(pluginRoot, "plugin.json"), `${JSON.stringify(pluginJson)}\n`),
    writeFile(path.join(sourceRoot, "data", "mission-control.sqlite3"), "fixture database must not be opened\n"),
    writeFile(path.join(sourceRoot, "logs", "ignored.txt"), "Mission Control ignored log\n"),
    writeFile(path.join(sourceRoot, "credentials", "ignored.txt"), "Mission Control ignored credential\n"),
    writeFile(path.join(sourceRoot, "node_modules", "ignored.js"), "Mission Control ignored dependency\n"),
    writeFile(
      path.join(sourceRoot, "public", "oversized.txt"),
      `${"x".repeat((512 * 1024) + 1)}Mission Control oversized\n`,
    ),
    writeFile(
      path.join(sourceRoot, "public", "binary.txt"),
      Buffer.from("StudioOps\0Mission Control binary", "utf8"),
    ),
  ]);
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["checkout", "-b", "main"]);
  await git(sourceRoot, ["remote", "add", "origin", CANONICAL_REPOSITORY]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["-c", "user.name=StudioOps Fixture", "-c", "user.email=fixture", "commit", "-m", "fixture"]);

  const npmBin = path.join(root, "npm-fixture");
  await writeFile(npmBin, "#!/bin/sh\nexit 0\n");
  await chmod(npmBin, 0o755);
  const staged = await deployRuntime({ sourceRoot, runtimeRoot, npmBin, activate: false });
  await activateRuntime(staged, { prune: false });
  return { root, sourceRoot, runtimeRoot, staged };
}

function verificationEnvironment(fixture, extra = {}) {
  const env = { ...process.env };
  delete env.STUDIOOPS_SOURCE_ROOT;
  delete env.STUDIOOPS_RUNTIME_ROOT;
  delete env.MISSION_CONTROL_SOURCE_ROOT;
  delete env.MISSION_CONTROL_RUNTIME_ROOT;
  Object.assign(env, extra);
  env.STUDIOOPS_SOURCE_ROOT = fixture.sourceRoot;
  env.STUDIOOPS_RUNTIME_ROOT = fixture.runtimeRoot;
  return env;
}

async function runVerify(fixture, args = ["--json"], extra = {}) {
  return execFileAsync(process.execPath, [VERIFY_SCRIPT, "verify", ...args], {
    cwd: REPOSITORY_ROOT,
    env: verificationEnvironment(fixture, extra),
    timeout: 5_000,
  });
}

test("verify reports deterministic canonical source, runtime, package, plugin, and compatibility identity", async () => {
  const fixture = await verificationFixture();
  try {
    const { stdout } = await runVerify(fixture);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.source.origin, CANONICAL_REPOSITORY);
    assert.match(report.source.head, /^[0-9a-f]{40}$/);
    assert.equal(report.source.clean, true);
    assert.equal(report.runtime.currentTarget, fixture.staged.releasePath);
    assert.equal(report.runtime.commit, report.source.head);
    assert.deepEqual(report.package.runtime, { name: "studioops", version: "2.0.0" });
    assert.deepEqual(report.plugin.runtime, {
      name: "studioops",
      version: "2.1.0",
      repository: CANONICAL_REPOSITORY,
      homepage: CANONICAL_REPOSITORY,
    });
    assert.equal(report.provenance.valid, true);
    assert.equal(report.payload.valid, true);
    assert.match(report.payload.runtime.digest, /^[0-9a-f]{64}$/);
    assert.equal(report.staleUserFacingFindings.length, 0);
    assert.ok(report.compatibility.findings.some((finding) => finding.identifier === "legacy_launchagent_label"));
    assert.ok(report.compatibility.findings.some((finding) => finding.identifier === "legacy_environment_variable"));
    assert.ok(report.compatibility.findings.some((finding) => (
      finding.identifier === "historical_qa_integration_author"
    )));
    assert.equal(report.scan.truncated, false);
    assert.ok(report.scan.filesInspected < report.scan.maxFiles);

    const human = await runVerify(fixture, []);
    assert.match(human.stdout, /StudioOps identity verification: PASS/);
    assert.match(human.stdout, /Compatibility detail/);
    assert.doesNotMatch(human.stdout, /fixture database must not be opened/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify is bounded and read-only and honors STUDIOOPS variables before legacy fallbacks", async () => {
  const fixture = await verificationFixture();
  try {
    const fakeBin = path.join(fixture.root, "bin");
    const commandLog = path.join(fixture.root, "command-log");
    await mkdir(fakeBin);
    for (const command of ["launchctl", "npm"]) {
      const wrapper = path.join(fakeBin, command);
      await writeFile(
        wrapper,
        "#!/bin/sh\n"
          + `printf '${command}\\n' >> "$STUDIOOPS_COMMAND_LOG"\n`
          + "exit 97\n",
      );
      await chmod(wrapper, 0o755);
    }

    const databasePath = path.join(fixture.sourceRoot, "data", "mission-control.sqlite3");
    const packagePath = path.join(fixture.sourceRoot, "package.json");
    const refreshedMtime = new Date(Date.now() + 5_000);
    await utimes(packagePath, refreshedMtime, refreshedMtime);
    const watchedPaths = [
      path.join(fixture.sourceRoot, "README.md"),
      packagePath,
      path.join(fixture.sourceRoot, ".git", "index"),
      databasePath,
      path.join(fixture.staged.releasePath, "studioops-runtime-provenance.v1.json"),
      path.join(fixture.runtimeRoot, "current"),
    ];
    const before = await Promise.all(watchedPaths.map(async (item) => ({
      item,
      mtimeMs: (await lstat(item)).mtimeMs,
    })));
    const beforeTarget = await readlink(path.join(fixture.runtimeRoot, "current"));
    const beforeOrigin = await git(fixture.sourceRoot, ["remote", "get-url", "origin"]);
    const startedAt = Date.now();
    const { stdout } = await runVerify(fixture, ["--json"], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      STUDIOOPS_COMMAND_LOG: commandLog,
      GIT_TRACE: commandLog,
      MISSION_CONTROL_SOURCE_ROOT: path.join(fixture.root, "wrong-source"),
      MISSION_CONTROL_RUNTIME_ROOT: path.join(fixture.root, "wrong-runtime"),
    });
    const elapsedMs = Date.now() - startedAt;
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.source.root, fixture.sourceRoot);
    assert.equal(report.runtime.root, fixture.runtimeRoot);
    assert.ok(elapsedMs < 2_000, `verification took ${elapsedMs}ms`);
    assert.equal(await readlink(path.join(fixture.runtimeRoot, "current")), beforeTarget);
    assert.equal(await git(fixture.sourceRoot, ["remote", "get-url", "origin"]), beforeOrigin);
    const after = await Promise.all(watchedPaths.map(async (item) => ({
      item,
      mtimeMs: (await lstat(item)).mtimeMs,
    })));
    assert.deepEqual(after, before);
    assert.equal((await stat(databasePath)).size, "fixture database must not be opened\n".length);
    const commands = await readFile(commandLog, "utf8");
    assert.match(commands, /built-in: git '?remote'? '?get-url'? '?origin'?/);
    assert.match(commands, /built-in: git '?rev-parse'? '?HEAD'?/);
    assert.match(commands, /built-in: git '?status'? '?--porcelain'? '?--untracked-files=normal'?/);
    assert.match(commands, /built-in: git '?ls-tree'? '?-r'? '?--name-only'? '?-z'? '?HEAD'?/);
    assert.doesNotMatch(commands, /\bfetch\b|remote set-url|launchctl|npm|restart|sqlite/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify reports stale user-facing identity by path and line while excluding unsafe scan areas", async () => {
  const fixture = await verificationFixture({ stale: true });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      runVerify(fixture),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.ok(report.errors.some((item) => item.code === "stale_user_facing_identity"));
        assert.deepEqual(
          report.staleUserFacingFindings.filter((finding) => finding.path === "README.md"),
          [{ scope: "source", path: "README.md", line: 1, match: "legacy_product_name" }],
        );
        assert.ok(!report.staleUserFacingFindings.some((finding) => (
          /node_modules|data|logs|credentials|oversized|binary/.test(finding.path)
        )));
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify exits nonzero with actionable details when runtime provenance is contradictory", async () => {
  const fixture = await verificationFixture();
  try {
    const provenancePath = path.join(fixture.staged.releasePath, "studioops-runtime-provenance.v1.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.product = "Unrelated";
    await chmod(provenancePath, 0o644);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    await assert.rejects(
      runVerify(fixture),
      (error) => {
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.provenance.valid, false);
        assert.ok(report.errors.some((item) => item.code === "runtime_provenance_mismatch"));
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify detects modified runtime payload content", async () => {
  const fixture = await verificationFixture();
  try {
    const serverPath = path.join(fixture.staged.releasePath, "src", "server.js");
    await writeFile(serverPath, `${await readFile(serverPath, "utf8")}export const tampered = true;\n`);
    await assert.rejects(
      runVerify(fixture),
      (error) => {
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.provenance.valid, false);
        assert.equal(report.payload.valid, false);
        assert.ok(report.errors.some((item) => item.code === "runtime_payload_mismatch"));
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify rejects symlinked releases without scanning outside the runtime root", async () => {
  const fixture = await verificationFixture();
  try {
    const externalRelease = path.join(fixture.root, "external-release");
    await rename(fixture.staged.releasePath, externalRelease);
    await writeFile(path.join(externalRelease, "src", "outside.js"), "Mission Control outside runtime\n");
    await symlink(externalRelease, fixture.staged.releasePath, "dir");

    await assert.rejects(
      runVerify(fixture),
      (error) => {
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.runtime.releasePath, "");
        assert.ok(report.errors.some((item) => item.code === "runtime_target_untrusted"));
        assert.ok(!report.staleUserFacingFindings.some((finding) => finding.path === "src/outside.js"));
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
