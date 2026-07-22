import os from "node:os";
import path from "node:path";

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
