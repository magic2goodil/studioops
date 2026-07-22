import path from "node:path";

export function missionControlRoot() {
  return path.resolve(process.env.STUDIOOPS_ROOT || process.env.MISSION_CONTROL_ROOT || process.cwd());
}

export function missionControlDataDir() {
  return path.resolve(process.env.STUDIOOPS_DATA_DIR || process.env.MISSION_CONTROL_DATA_DIR || path.join(missionControlRoot(), "data"));
}

export function missionControlConfigRoot() {
  return path.resolve(process.env.STUDIOOPS_CONFIG_ROOT || process.env.MISSION_CONTROL_CONFIG_ROOT || missionControlRoot());
}
