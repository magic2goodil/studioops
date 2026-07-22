import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitRemoteUrl, planSourceRemoteMigration } from "../src/runtime-install.js";

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
