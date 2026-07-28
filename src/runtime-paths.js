import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_ISOLATION_MARKER_FILE = ".studioops-test-isolation";

export function expandLocalPath(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function studioOpsHome() {
  return path.resolve(expandLocalPath(
    process.env.STUDIOOPS_HOME || path.join(os.homedir(), ".codex", "studioops"),
  ));
}

export function defaultStudioOpsWorkingRoot() {
  return path.join(studioOpsHome(), "control-plane");
}

export function defaultStudioOpsRuntimeRoot() {
  return path.join(studioOpsHome(), "runtime");
}

export function defaultStudioOpsSourceRoot() {
  return path.join(studioOpsHome(), "source");
}

export function defaultStudioOpsWorkspaceRoot(kind) {
  return path.join(studioOpsHome(), `${kind}-workspaces`);
}

export function defaultStudioOpsGitLockRoot() {
  return path.join(studioOpsHome(), "locks", "git");
}

export function defaultStudioOpsCredentialsRoot() {
  return path.join(studioOpsHome(), "credentials", "github-apps");
}

export function missionControlRoot() {
  return path.resolve(expandLocalPath(
    process.env.STUDIOOPS_ROOT
      || process.env.MISSION_CONTROL_ROOT
      || process.env.STUDIOOPS_WORKING_ROOT
      || process.env.MISSION_CONTROL_WORKING_ROOT
      || defaultStudioOpsWorkingRoot(),
  ));
}

export function missionControlDataDir() {
  return path.resolve(expandLocalPath(
    process.env.STUDIOOPS_DATA_DIR || process.env.MISSION_CONTROL_DATA_DIR || path.join(missionControlRoot(), "data"),
  ));
}

export function missionControlConfigRoot() {
  return path.resolve(expandLocalPath(
    process.env.STUDIOOPS_CONFIG_ROOT || process.env.MISSION_CONTROL_CONFIG_ROOT || missionControlRoot(),
  ));
}

function pathIsWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertIsolatedTestEnvironment(env = process.env) {
  const testContextActive = Boolean(env.NODE_TEST_CONTEXT || env.STUDIOOPS_TEST_ISOLATION);
  if (!testContextActive) return;

  const testRootValue = String(env.STUDIOOPS_TEST_ROOT || "").trim();
  const isolationToken = String(env.STUDIOOPS_TEST_ISOLATION_TOKEN || "").trim();
  if (!testRootValue || !isolationToken) {
    const error = new Error(
      "StudioOps refused database access from a test process without a verified temporary test root. "
      + "Run tests through `npm run test:isolated`.",
    );
    error.code = "STUDIOOPS_TEST_ISOLATION_REQUIRED";
    throw error;
  }

  const testRoot = path.resolve(expandLocalPath(testRootValue));
  let markerToken = "";
  try {
    markerToken = readFileSync(path.join(testRoot, TEST_ISOLATION_MARKER_FILE), "utf8").trim();
  } catch {
    // The generic error below intentionally avoids exposing unrelated host paths.
  }
  if (!markerToken || markerToken !== isolationToken) {
    const error = new Error(
      "StudioOps refused database access because the temporary test-root marker is missing or invalid.",
    );
    error.code = "STUDIOOPS_TEST_ISOLATION_INVALID";
    throw error;
  }

  let realTestRoot;
  let realTemporaryRoot;
  let configuredPaths;
  try {
    realTestRoot = realpathSync(testRoot);
    realTemporaryRoot = realpathSync(os.tmpdir());
    configuredPaths = [
      ["control root", realpathSync(missionControlRoot())],
      ["data directory", realpathSync(missionControlDataDir())],
      ["config root", realpathSync(missionControlConfigRoot())],
    ];
  } catch {
    const error = new Error(
      "StudioOps refused database access because a temporary test path could not be verified.",
    );
    error.code = "STUDIOOPS_TEST_ISOLATION_UNVERIFIED";
    throw error;
  }
  if (!pathIsWithin(realTemporaryRoot, realTestRoot)) {
    const error = new Error(
      "StudioOps refused database access because the marked test root is not inside the system temporary directory.",
    );
    error.code = "STUDIOOPS_TEST_ISOLATION_NOT_TEMPORARY";
    throw error;
  }
  const escaped = configuredPaths.find(([, candidatePath]) => !pathIsWithin(realTestRoot, candidatePath));
  if (escaped) {
    const error = new Error(
      `StudioOps refused database access because the configured ${escaped[0]} escapes the temporary test root.`,
    );
    error.code = "STUDIOOPS_TEST_ISOLATION_ESCAPE";
    throw error;
  }
}
