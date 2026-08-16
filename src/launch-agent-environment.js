import path from "node:path";

const SYSTEM_PATHS = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);

export function launchAgentPath(nodePath) {
  const nodeDirectory = path.dirname(String(nodePath || "").trim());
  return [...new Set([nodeDirectory, ...SYSTEM_PATHS].filter(Boolean))].join(":");
}
