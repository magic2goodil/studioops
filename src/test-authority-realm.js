import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  assertIsolatedTestEnvironment,
  missionControlConfigRoot,
  missionControlDataDir,
  missionControlRoot,
  TEST_ISOLATION_MARKER_FILE,
} from "./runtime-paths.js";

const REALM_ENV_KEYS = Object.freeze([
  "STUDIOOPS_HOME",
  "STUDIOOPS_ROOT",
  "STUDIOOPS_WORKING_ROOT",
  "STUDIOOPS_DATA_DIR",
  "STUDIOOPS_CONFIG_ROOT",
  "MISSION_CONTROL_ROOT",
  "MISSION_CONTROL_WORKING_ROOT",
  "MISSION_CONTROL_DATA_DIR",
  "MISSION_CONTROL_CONFIG_ROOT",
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
]);

let isolatedTestCapability = null;
let isolatedTestRealm = null;
const registeredAdapters = new WeakMap();

function identity(value) {
  const resolved = realpathSync(value);
  const info = lstatSync(resolved);
  return Object.freeze({
    path: resolved,
    device: Number(info.dev),
    inode: Number(info.ino),
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  });
}

function sameIdentity(expected, value) {
  try {
    const current = identity(value);
    return current.path === expected.path
      && current.device === expected.device
      && current.inode === expected.inode
      && current.type === expected.type;
  } catch {
    return false;
  }
}

function captureRealm() {
  assertIsolatedTestEnvironment(process.env);
  const testRoot = realpathSync(path.resolve(process.env.STUDIOOPS_TEST_ROOT));
  const markerPath = path.join(testRoot, TEST_ISOLATION_MARKER_FILE);
  const markerInfo = lstatSync(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error("StudioOps isolated test marker must be a regular file.");
  }
  const token = String(process.env.STUDIOOPS_TEST_ISOLATION_TOKEN || "").trim();
  if (!token || readFileSync(markerPath, "utf8").trim() !== token) {
    throw new Error("StudioOps isolated test marker identity changed.");
  }
  return Object.freeze({
    testRoot: identity(testRoot),
    controlRoot: identity(missionControlRoot()),
    dataDir: identity(missionControlDataDir()),
    configRoot: identity(missionControlConfigRoot()),
    marker: identity(markerPath),
    token,
    env: Object.freeze(Object.fromEntries(REALM_ENV_KEYS.map((key) => [key, String(process.env[key] || "")]))),
  });
}

if (process.env.NODE_ENV === "test" && process.env.STUDIOOPS_TEST_ISOLATION === "1") {
  try {
    isolatedTestRealm = captureRealm();
    isolatedTestCapability = Object.freeze({
      kind: "studioops-isolated-test-authority",
    });
  } catch {
    isolatedTestRealm = null;
    isolatedTestCapability = null;
  }
}

/** Re-attest the immutable boot realm before every test-authority operation. */
export function assertCurrentIsolatedTestAuthority(capability) {
  if (!isolatedTestCapability || capability !== isolatedTestCapability || !isolatedTestRealm) {
    throw new Error("StudioOps isolated test authority is unavailable.");
  }
  if (
    process.env.NODE_ENV !== "test"
    || process.env.STUDIOOPS_TEST_ISOLATION !== "1"
    || String(process.env.STUDIOOPS_TEST_ISOLATION_TOKEN || "").trim() !== isolatedTestRealm.token
    || REALM_ENV_KEYS.some((key) => String(process.env[key] || "") !== isolatedTestRealm.env[key])
  ) {
    throw new Error("StudioOps isolated test authority no longer matches its boot realm.");
  }
  try {
    assertIsolatedTestEnvironment(process.env);
  } catch {
    throw new Error("StudioOps isolated test authority could not re-attest its boot realm.");
  }
  const markerPath = path.join(isolatedTestRealm.testRoot.path, TEST_ISOLATION_MARKER_FILE);
  if (
    !sameIdentity(isolatedTestRealm.testRoot, process.env.STUDIOOPS_TEST_ROOT)
    || !sameIdentity(isolatedTestRealm.controlRoot, missionControlRoot())
    || !sameIdentity(isolatedTestRealm.dataDir, missionControlDataDir())
    || !sameIdentity(isolatedTestRealm.configRoot, missionControlConfigRoot())
    || !sameIdentity(isolatedTestRealm.marker, markerPath)
    || readFileSync(markerPath, "utf8").trim() !== isolatedTestRealm.token
  ) {
    throw new Error("StudioOps isolated test authority filesystem identity changed.");
  }
  return true;
}

/** Register a consumer only while the canonical boot realm remains attested. */
export function consumeIsolatedTestAuthority(consumer) {
  if (!isolatedTestCapability) return null;
  if (typeof consumer !== "function") {
    throw new Error("StudioOps test authority consumer must be a function.");
  }
  assertCurrentIsolatedTestAuthority(isolatedTestCapability);
  return consumer(isolatedTestCapability);
}

/** Register an adapter that remains usable only inside its exact boot realm. */
export function registerIsolatedTestAdapter(capability, kind, run) {
  assertCurrentIsolatedTestAuthority(capability);
  if (typeof run !== "function") {
    throw new Error("StudioOps isolated test adapter registration was rejected.");
  }
  const normalizedKind = String(kind || "").trim();
  if (!normalizedKind) throw new Error("StudioOps isolated test adapter kind is required.");
  const adapter = Object.freeze({ kind: normalizedKind, run });
  registeredAdapters.set(adapter, { capability, kind: normalizedKind, run });
  return adapter;
}

/** Resolve a registered adapter only after re-attesting the exact boot realm. */
export function isolatedTestAdapterRun(adapter, kind) {
  if (!isolatedTestCapability || !adapter || typeof adapter !== "object") return null;
  const registration = registeredAdapters.get(adapter);
  if (!registration || registration.kind !== String(kind || "")) return null;
  assertCurrentIsolatedTestAuthority(registration.capability);
  return registration.run;
}
