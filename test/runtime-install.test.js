import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  activateRuntime,
  deployRuntime,
  normalizeGitRemoteUrl,
  planSourceRemoteMigration,
  restoreRuntimeCurrent,
  STUDIOOPS_IDENTITY,
  sourceCheckoutSafetyError,
} from "../src/runtime-install.js";

const execFileAsync = promisify(execFile);
const CANONICAL_REPOSITORY = "https://github.com/magic2goodil/studioops";

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function runtimeFixture(input = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-provenance-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const pluginRoot = path.join(sourceRoot, "plugins", "studioops", ".codex-plugin");
  await Promise.all([
    mkdir(path.join(sourceRoot, "src"), { recursive: true }),
    mkdir(path.join(sourceRoot, "public"), { recursive: true }),
    mkdir(path.join(sourceRoot, "scripts"), { recursive: true }),
    mkdir(path.join(sourceRoot, "deploy"), { recursive: true }),
    mkdir(path.join(sourceRoot, "standards"), { recursive: true }),
    mkdir(pluginRoot, { recursive: true }),
  ]);
  const fixtureWrites = [
    copyFile("standards/hosted-release-candidate-qa.md", path.join(sourceRoot, "standards/hosted-release-candidate-qa.md")),
    copyFile("standards/modular-architecture-and-scoped-validation.md", path.join(sourceRoot, "standards/modular-architecture-and-scoped-validation.md")),
    writeFile(path.join(sourceRoot, "src", "server.js"), "export {};\n"),
    writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify({
      name: input.packageName || "studioops",
      version: "1.2.3",
    })}\n`),
    writeFile(path.join(sourceRoot, "package-lock.json"), `${JSON.stringify({
      name: input.packageName || "studioops",
      version: "1.2.3",
      lockfileVersion: 3,
      packages: {},
    })}\n`),
  ];
  if (!input.omitPlugin) {
    fixtureWrites.push(writeFile(path.join(pluginRoot, "plugin.json"), `${JSON.stringify({
      name: input.pluginName || "studioops",
      version: "4.5.6",
      repository: input.pluginRepository || CANONICAL_REPOSITORY,
      homepage: CANONICAL_REPOSITORY,
    })}\n`));
  }
  if (input.ignoredPayload) {
    fixtureWrites.push(writeFile(path.join(sourceRoot, ".gitignore"), "src/ignored.js\n"));
  }
  await Promise.all(fixtureWrites);
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["checkout", "-b", "main"]);
  await git(sourceRoot, ["remote", "add", "origin", input.origin || CANONICAL_REPOSITORY]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["-c", "user.name=StudioOps Fixture", "-c", "user.email=fixture", "commit", "-m", "fixture"]);
  if (input.ignoredPayload) {
    await writeFile(path.join(sourceRoot, "src", "ignored.js"), "ignored but not committed\n");
  }
  const npmBin = path.join(root, "npm-fixture");
  await writeFile(npmBin, "#!/bin/sh\nexit 0\n");
  await chmod(npmBin, 0o755);
  return { root, sourceRoot, runtimeRoot, npmBin };
}

test("staged runtime activation can restore the previous immutable release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-runtime-"));
  const oldRelease = path.join(root, "releases", "old");
  const newRelease = path.join(root, "releases", "new");
  try {
    await mkdir(oldRelease, { recursive: true });
    await mkdir(newRelease, { recursive: true });
    await symlink(oldRelease, path.join(root, "current"), "dir");
    const runtime = {
      runtimeRoot: root,
      releasePath: newRelease,
      previousCurrentTarget: oldRelease,
    };
    await activateRuntime(runtime, { prune: false });
    assert.equal(await readlink(path.join(root, "current")), newRelease);
    await restoreRuntimeCurrent(runtime);
    assert.equal(await readlink(path.join(root, "current")), oldRelease);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git remote normalization treats supported GitHub URL forms as equivalent", () => {
  assert.equal(
    normalizeGitRemoteUrl("git@github.com:Magic2GoodIL/StudioOps.git"),
    "github.com/magic2goodil/studioops",
  );
  assert.equal(
    normalizeGitRemoteUrl("https://github.com/magic2goodil/studioops/"),
    "github.com/magic2goodil/studioops",
  );
});

test("source migration permits only the recognized repository rename", () => {
  assert.equal(
    planSourceRemoteMigration(
      "git@github.com:magic2goodil/codex-mission-control.git",
      "https://github.com/magic2goodil/studioops.git",
    ).action,
    "migrate",
  );
  assert.equal(
    planSourceRemoteMigration(
      "git@github.com:magic2goodil/studioops.git",
      "https://github.com/magic2goodil/studioops.git",
    ).action,
    "keep",
  );
});

test("source migration rejects unrelated repositories and owners", () => {
  assert.equal(
    planSourceRemoteMigration(
      "git@github.com:someone-else/codex-mission-control.git",
      "git@github.com:magic2goodil/studioops.git",
    ).action,
    "reject",
  );
  assert.equal(
    planSourceRemoteMigration(
      "git@github.com:magic2goodil/unrelated.git",
      "git@github.com:magic2goodil/studioops.git",
    ).action,
    "reject",
  );
});

test("source checkout safety rejects dirty, detached, wrong-branch, and divergent states", () => {
  assert.match(sourceCheckoutSafetyError({ statusOutput: " M file.js", currentBranch: "main" }), /uncommitted/);
  assert.match(sourceCheckoutSafetyError({ currentBranch: "" }), /detached HEAD/);
  assert.match(sourceCheckoutSafetyError({ currentBranch: "feature", sourceBranch: "main" }), /must be on main/);
  assert.match(sourceCheckoutSafetyError({ currentBranch: "main", ahead: 1 }), /local commits/);
  assert.equal(sourceCheckoutSafetyError({ currentBranch: "main", ahead: 0 }), "");
});

test("clean canonical sources stage a versioned provenance manifest and matching plugin identity", async () => {
  const fixture = await runtimeFixture();
  try {
    const runtime = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      runtimeRoot: fixture.runtimeRoot,
      npmBin: fixture.npmBin,
      activate: false,
    });
    assert.match(runtime.version, /^[0-9a-f]{40}$/);
    const manifest = JSON.parse(
      await readFile(path.join(runtime.releasePath, STUDIOOPS_IDENTITY.provenanceFile), "utf8"),
    );
    const { payload, ...identity } = manifest;
    assert.deepEqual(identity, {
      schemaVersion: 1,
      product: "StudioOps",
      repository: CANONICAL_REPOSITORY,
      source: {
        origin: CANONICAL_REPOSITORY,
        normalizedOrigin: "github.com/magic2goodil/studioops",
        commit: runtime.version,
        clean: true,
      },
      package: { name: "studioops", version: "1.2.3" },
      plugin: {
        name: "studioops",
        version: "4.5.6",
        repository: CANONICAL_REPOSITORY,
        homepage: CANONICAL_REPOSITORY,
      },
    });
    assert.equal(payload.algorithm, "sha256");
    assert.match(payload.digest, /^[0-9a-f]{64}$/);
    assert.equal(payload.fileCount, payload.files.length);
    assert.ok(payload.totalBytes > 0);
    assert.ok(payload.files.some((item) => item.path === "src/server.js" && /^[0-9a-f]{64}$/.test(item.sha256)));
    assert.ok(payload.files.some((item) => item.path === "standards/hosted-release-candidate-qa.md" && /^[0-9a-f]{64}$/.test(item.sha256)));
    assert.equal(await readFile(path.join(runtime.releasePath, "standards/hosted-release-candidate-qa.md"), "utf8"),
      await readFile("standards/hosted-release-candidate-qa.md", "utf8"));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(runtime.releasePath, "plugins", "studioops", ".codex-plugin", "plugin.json"))),
      manifest.plugin,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installed built-in standards resolve independently of cwd and tampering breaks provenance", async () => {
  const fixture = await runtimeFixture();
  try {
    // Stage the real config module and its dependency closure so resolution is
    // exercised from the installed immutable payload, not a mocked root option.
    for (const name of ["config.js", "runtime-paths.js", "integration-policy.js", "credit-policy.js"]) {
      await copyFile(path.join("src", name), path.join(fixture.sourceRoot, "src", name));
    }
    await git(fixture.sourceRoot, ["add", "."]);
    await git(fixture.sourceRoot, ["-c", "user.name=StudioOps Fixture", "-c", "user.email=fixture", "commit", "-m", "installed config"]);
    const runtime = await deployRuntime({ ...fixture, activate: false });
    const moduleUrl = pathToFileURL(path.join(runtime.releasePath, "src/config.js")).href;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import {resolveStandardReference,HOSTED_RC_STANDARD,MODULAR_ARCHITECTURE_STANDARD} from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify([HOSTED_RC_STANDARD,MODULAR_ARCHITECTURE_STANDARD,'/private/custom.md','docs/PROJECT_POLICY.md',
        './standards/hosted-release-candidate-qa.md','https://example.invalid/custom.md'].map(resolveStandardReference)));
    `], { cwd: fixture.root });
    assert.deepEqual(JSON.parse(stdout), [
      path.join(runtime.releasePath, "standards/hosted-release-candidate-qa.md"),
      path.join(runtime.releasePath, "standards/modular-architecture-and-scoped-validation.md"),
      "/private/custom.md", path.join(fixture.root, "docs/PROJECT_POLICY.md"),
      path.join(fixture.root, "standards/hosted-release-candidate-qa.md"), "https://example.invalid/custom.md",
    ]);
    await writeFile(path.join(runtime.releasePath, "standards/hosted-release-candidate-qa.md"), "tampered standard");
    await assert.rejects(deployRuntime({ ...fixture, activate: false }), /runtime payload content contradicts its provenance/);
    await assert.rejects(readlink(path.join(fixture.runtimeRoot, "current")), { code: "ENOENT" });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("runtime staging rejects dirty, unrelated, and non-StudioOps sources before activation", async (t) => {
  for (const scenario of [
    {
      name: "dirty source",
      prepare: async (fixture) => writeFile(path.join(fixture.sourceRoot, "src", "dirty.js"), "dirty\n"),
      pattern: /uncommitted changes/,
    },
    {
      name: "unrelated origin",
      prepare: async (fixture) => git(fixture.sourceRoot, ["remote", "set-url", "origin", "https://github.com/example/other"]),
      pattern: /origin must be/,
    },
    {
      name: "non-StudioOps plugin",
      fixture: { pluginName: "other-plugin" },
      prepare: async () => {},
      pattern: /plugin identity/,
    },
    {
      name: "missing plugin",
      fixture: { omitPlugin: true },
      prepare: async () => {},
      pattern: /plugin\.json/,
    },
    {
      name: "ignored content outside the commit",
      fixture: { ignoredPayload: true },
      prepare: async () => {},
      pattern: /payload paths do not exactly match the tracked HEAD tree/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await runtimeFixture(scenario.fixture);
      try {
        await scenario.prepare(fixture);
        await assert.rejects(
          deployRuntime({
            sourceRoot: fixture.sourceRoot,
            runtimeRoot: fixture.runtimeRoot,
            npmBin: fixture.npmBin,
          }),
          scenario.pattern,
        );
        await assert.rejects(readlink(path.join(fixture.runtimeRoot, "current")), /ENOENT/);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("same-commit releases with contradictory metadata are rejected without activation or pruning", async () => {
  const fixture = await runtimeFixture();
  try {
    const staged = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      runtimeRoot: fixture.runtimeRoot,
      npmBin: fixture.npmBin,
      activate: false,
    });
    const retainedRelease = path.join(fixture.runtimeRoot, "releases", "retained-release");
    await mkdir(retainedRelease);
    const packagePath = path.join(staged.releasePath, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.name = "unrelated";
    await chmod(packagePath, 0o644);
    await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`);

    await assert.rejects(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        runtimeRoot: fixture.runtimeRoot,
        npmBin: fixture.npmBin,
      }),
      /cannot be reused: runtime package identity contradicts its provenance/,
    );
    await assert.rejects(readlink(path.join(fixture.runtimeRoot, "current")), /ENOENT/);
    assert.equal(await readFile(packagePath, "utf8"), `${JSON.stringify(packageJson)}\n`);
    assert.deepEqual(await readdir(retainedRelease), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-commit releases with modified payload content are rejected before activation", async () => {
  const fixture = await runtimeFixture();
  try {
    const staged = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      runtimeRoot: fixture.runtimeRoot,
      npmBin: fixture.npmBin,
      activate: false,
    });
    const serverPath = path.join(staged.releasePath, "src", "server.js");
    await writeFile(serverPath, `${await readFile(serverPath, "utf8")}export const tampered = true;\n`);

    await assert.rejects(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        runtimeRoot: fixture.runtimeRoot,
        npmBin: fixture.npmBin,
      }),
      /runtime payload content contradicts its provenance/,
    );
    await assert.rejects(readlink(path.join(fixture.runtimeRoot, "current")), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
