import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultStudioOpsCredentialsRoot,
  defaultStudioOpsGitLockRoot,
  defaultStudioOpsRuntimeRoot,
  defaultStudioOpsSourceRoot,
  defaultStudioOpsWorkingRoot,
  defaultStudioOpsWorkspaceRoot,
  missionControlDataDir,
  missionControlRoot,
  studioOpsHome,
} from "../src/runtime-paths.js";

test("StudioOps operational defaults stay under the local Codex home", () => {
  const previous = process.env.STUDIOOPS_HOME;
  delete process.env.STUDIOOPS_HOME;
  try {
    const expectedHome = path.join(os.homedir(), ".codex", "studioops");
    assert.equal(studioOpsHome(), expectedHome);
    assert.equal(defaultStudioOpsWorkingRoot(), path.join(expectedHome, "control-plane"));
    assert.equal(defaultStudioOpsRuntimeRoot(), path.join(expectedHome, "runtime"));
    assert.equal(defaultStudioOpsSourceRoot(), path.join(expectedHome, "source"));
    assert.equal(defaultStudioOpsWorkspaceRoot("run"), path.join(expectedHome, "run-workspaces"));
    assert.equal(defaultStudioOpsWorkspaceRoot("qa"), path.join(expectedHome, "qa-workspaces"));
    assert.equal(defaultStudioOpsWorkspaceRoot("promotion"), path.join(expectedHome, "promotion-workspaces"));
    assert.equal(defaultStudioOpsGitLockRoot(), path.join(expectedHome, "locks", "git"));
    assert.equal(defaultStudioOpsCredentialsRoot(), path.join(expectedHome, "credentials", "github-apps"));
  } finally {
    if (previous === undefined) delete process.env.STUDIOOPS_HOME;
    else process.env.STUDIOOPS_HOME = previous;
  }
});

test("STUDIOOPS_HOME supports an explicit home-relative local root", () => {
  const previous = process.env.STUDIOOPS_HOME;
  process.env.STUDIOOPS_HOME = "~/.codex/custom-studioops";
  try {
    assert.equal(studioOpsHome(), path.join(os.homedir(), ".codex", "custom-studioops"));
  } finally {
    if (previous === undefined) delete process.env.STUDIOOPS_HOME;
    else process.env.STUDIOOPS_HOME = previous;
  }
});

test("STUDIOOPS_WORKING_ROOT selects the CLI and maintenance database instance", () => {
  const previousRoot = process.env.STUDIOOPS_ROOT;
  const previousWorkingRoot = process.env.STUDIOOPS_WORKING_ROOT;
  delete process.env.STUDIOOPS_ROOT;
  process.env.STUDIOOPS_WORKING_ROOT = "~/.codex/studioops-test-control-plane";
  try {
    const expected = path.join(os.homedir(), ".codex", "studioops-test-control-plane");
    assert.equal(missionControlRoot(), expected);
    assert.equal(missionControlDataDir(), path.join(expected, "data"));
  } finally {
    if (previousRoot === undefined) delete process.env.STUDIOOPS_ROOT;
    else process.env.STUDIOOPS_ROOT = previousRoot;
    if (previousWorkingRoot === undefined) delete process.env.STUDIOOPS_WORKING_ROOT;
    else process.env.STUDIOOPS_WORKING_ROOT = previousWorkingRoot;
  }
});
