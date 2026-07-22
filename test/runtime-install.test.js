import assert from "node:assert/strict";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateRuntime,
  normalizeGitRemoteUrl,
  planSourceRemoteMigration,
  restoreRuntimeCurrent,
  sourceCheckoutSafetyError,
} from "../src/runtime-install.js";

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
