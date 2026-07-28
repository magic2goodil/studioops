import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TEST_ISOLATION_MARKER_FILE } from "../src/runtime-paths.js";

const ROOT_ENV_KEYS = [
  "STUDIOOPS_HOME",
  "STUDIOOPS_ROOT",
  "STUDIOOPS_WORKING_ROOT",
  "STUDIOOPS_DATA_DIR",
  "STUDIOOPS_CONFIG_ROOT",
  "MISSION_CONTROL_ROOT",
  "MISSION_CONTROL_WORKING_ROOT",
  "MISSION_CONTROL_DATA_DIR",
  "MISSION_CONTROL_CONFIG_ROOT",
];

const OPERATIONAL_ENV_KEYS = [
  "STUDIOOPS_RUNTIME_ROOT",
  "MISSION_CONTROL_RUNTIME_ROOT",
  "STUDIOOPS_WORKSPACE_ROOT",
  "MISSION_CONTROL_WORKSPACE_ROOT",
  "STUDIOOPS_QA_WORKSPACE_ROOT",
  "MISSION_CONTROL_QA_WORKSPACE_ROOT",
  "STUDIOOPS_PROMOTION_WORKSPACE_ROOT",
  "MISSION_CONTROL_PROMOTION_WORKSPACE_ROOT",
  "STUDIOOPS_GIT_LOCK_ROOT",
  "MISSION_CONTROL_GIT_LOCK_ROOT",
  "STUDIOOPS_GITHUB_APPS_DIR",
  "MISSION_CONTROL_GITHUB_APPS_DIR",
];

const SENSITIVE_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "MISSION_CONTROL_GITHUB_TOKEN",
  "STUDIOOPS_GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

export const STUDIOOPS_TEST_ENV_KEYS = [
  ...ROOT_ENV_KEYS,
  ...OPERATIONAL_ENV_KEYS,
  "STUDIOOPS_TEST_ISOLATION",
  "STUDIOOPS_TEST_ROOT",
  "STUDIOOPS_TEST_ISOLATION_TOKEN",
];

function isolatedPaths(testRoot, controlRoot) {
  return {
    testRoot,
    controlRoot,
    dataDir: path.join(controlRoot, "data"),
    configRoot: controlRoot,
    runtimeRoot: path.join(testRoot, "runtime"),
    workspaceRoot: path.join(testRoot, "run-workspaces"),
    qaWorkspaceRoot: path.join(testRoot, "qa-workspaces"),
    promotionWorkspaceRoot: path.join(testRoot, "promotion-workspaces"),
    gitLockRoot: path.join(testRoot, "locks", "git"),
    credentialsRoot: path.join(testRoot, "credentials", "github-apps"),
  };
}

function environmentForPaths(baseEnv, paths, token) {
  const env = { ...baseEnv };
  for (const key of STUDIOOPS_TEST_ENV_KEYS) delete env[key];
  for (const key of SENSITIVE_ENV_KEYS) delete env[key];
  return {
    ...env,
    NODE_ENV: "test",
    STUDIOOPS_HOME: paths.testRoot,
    STUDIOOPS_ROOT: paths.controlRoot,
    STUDIOOPS_WORKING_ROOT: paths.controlRoot,
    STUDIOOPS_DATA_DIR: paths.dataDir,
    STUDIOOPS_CONFIG_ROOT: paths.configRoot,
    MISSION_CONTROL_ROOT: paths.controlRoot,
    MISSION_CONTROL_WORKING_ROOT: paths.controlRoot,
    MISSION_CONTROL_DATA_DIR: paths.dataDir,
    MISSION_CONTROL_CONFIG_ROOT: paths.configRoot,
    STUDIOOPS_RUNTIME_ROOT: paths.runtimeRoot,
    MISSION_CONTROL_RUNTIME_ROOT: paths.runtimeRoot,
    STUDIOOPS_WORKSPACE_ROOT: paths.workspaceRoot,
    MISSION_CONTROL_WORKSPACE_ROOT: paths.workspaceRoot,
    STUDIOOPS_QA_WORKSPACE_ROOT: paths.qaWorkspaceRoot,
    MISSION_CONTROL_QA_WORKSPACE_ROOT: paths.qaWorkspaceRoot,
    STUDIOOPS_PROMOTION_WORKSPACE_ROOT: paths.promotionWorkspaceRoot,
    MISSION_CONTROL_PROMOTION_WORKSPACE_ROOT: paths.promotionWorkspaceRoot,
    STUDIOOPS_GIT_LOCK_ROOT: paths.gitLockRoot,
    MISSION_CONTROL_GIT_LOCK_ROOT: paths.gitLockRoot,
    STUDIOOPS_GITHUB_APPS_DIR: paths.credentialsRoot,
    MISSION_CONTROL_GITHUB_APPS_DIR: paths.credentialsRoot,
    STUDIOOPS_TEST_ISOLATION: "1",
    STUDIOOPS_TEST_ROOT: paths.testRoot,
    STUDIOOPS_TEST_ISOLATION_TOKEN: token,
  };
}

async function ensureIsolationMarker(testRoot) {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  const markerPath = path.join(testRoot, TEST_ISOLATION_MARKER_FILE);
  const token = randomUUID();
  try {
    await writeFile(markerPath, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return token;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingToken = (await readFile(markerPath, "utf8")).trim();
    if (!existingToken) throw new Error("StudioOps test-isolation marker is empty.");
    return existingToken;
  }
}

export async function createHermeticTestEnvironment(options = {}) {
  const testRoot = options.testRoot
    ? path.resolve(options.testRoot)
    : await mkdtemp(path.join(options.tempParent || os.tmpdir(), "studioops-test-"));
  const controlRoot = path.resolve(options.controlRoot || path.join(testRoot, "control-plane"));
  const paths = isolatedPaths(testRoot, controlRoot);
  const token = await ensureIsolationMarker(testRoot);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  return {
    ...paths,
    env: environmentForPaths(options.baseEnv || process.env, paths, token),
    cleanup: options.testRoot
      ? async () => {}
      : async () => rm(testRoot, { recursive: true, force: true }),
  };
}

export async function environmentForTestControlRoot(controlRoot, baseEnv = process.env) {
  const testRoot = path.resolve(controlRoot);
  return (await createHermeticTestEnvironment({
    testRoot,
    controlRoot: testRoot,
    baseEnv,
  })).env;
}
