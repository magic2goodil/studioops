import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export const COMPONENT_IMPACT_SCHEMA_VERSION = 1;
export const DEFAULT_COMPONENT_MAP_PATH = "docs/architecture/components.json";

export class ComponentMapIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ComponentMapIsolationError";
    this.code = "component_map_project_mismatch";
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

export function normalizeRepositoryIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^git@([^:]+):/i, "https://$1/")
    .replace(/^ssh:\/\/git@/i, "https://")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function projectRepositoryIdentity(project = {}) {
  const remote = normalizeRepositoryIdentity(
    project.repoUrl || project.repositoryUrl || project.repository || project.remoteUrl,
  );
  if (remote) return remote;
  const localKey = String(project.key || project.id || "").trim().toLowerCase();
  return localKey ? `local:${localKey}` : "";
}

function list(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function safeRelativePath(value, label) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new Error(`${label} must be a repository-relative path: ${value || "(missing)"}`);
  }
  return normalized;
}

function normalizeTest(test, componentId) {
  if (typeof test === "string") {
    const command = test.trim();
    if (!command) throw new Error(`Component ${componentId} has an empty test command.`);
    return { command, layer: "component" };
  }
  const command = String(test?.command || "").trim();
  if (!command) throw new Error(`Component ${componentId} has a test without a command.`);
  return {
    command,
    layer: String(test.layer || "component").trim(),
  };
}

function normalizeComponent(id, input = {}) {
  const owner = String(input.owner || "").trim();
  if (!owner) throw new Error(`Component ${id} must declare an owner.`);
  const paths = list(input.paths).map((item) => safeRelativePath(item, `Component ${id} path`));
  if (!paths.length) throw new Error(`Component ${id} must declare at least one repository-relative path.`);
  return {
    id,
    owner,
    aliases: list(input.aliases),
    capabilities: list(input.capabilities),
    paths,
    routes: list(input.routes),
    ui: list(input.ui || input.uiSurfaces),
    services: list(input.services || input.adapters),
    data: list(input.data || input.ownedData),
    jobs: list(input.jobs),
    events: list(input.events || input.ownedEvents),
    workflows: list(input.workflows),
    deploySurfaces: list(input.deploySurfaces),
    publicContracts: list(input.publicContracts),
    dependsOn: list(input.dependsOn),
    reviewOwners: list(input.reviewOwners || input.reviewers),
    tests: (Array.isArray(input.tests) ? input.tests : []).map((test) => normalizeTest(test, id)),
    shared: input.shared === true,
    rollback: String(input.rollback || "").trim(),
  };
}

function assertAcyclic(components) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) throw new Error(`Component dependency cycle: ${[...trail, id].join(" -> ")}`);
    if (visited.has(id)) return;
    const component = components[id];
    if (!component) throw new Error(`Unknown component dependency: ${id}`);
    visiting.add(id);
    for (const dependency of component.dependsOn) {
      if (!components[dependency]) throw new Error(`Component ${id} depends on unknown component ${dependency}.`);
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of Object.keys(components)) visit(id);
}

export function validateComponentImpactMap(input, expected = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Component impact map must be a JSON object.");
  }
  if (Number(input.schemaVersion) !== COMPONENT_IMPACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported component impact map schemaVersion: ${input.schemaVersion ?? "(missing)"}`);
  }
  const projectKey = String(input.project?.key || "").trim();
  const repository = normalizeRepositoryIdentity(input.project?.repository);
  if (!projectKey || !repository) {
    throw new Error("Component impact map must bind project.key and project.repository.");
  }
  if (expected.projectKey && projectKey !== expected.projectKey) {
    throw new ComponentMapIsolationError(`Component map project ${projectKey} does not match ${expected.projectKey}.`);
  }
  const expectedRepository = normalizeRepositoryIdentity(expected.repository);
  if (expectedRepository && repository !== expectedRepository) {
    throw new ComponentMapIsolationError(`Component map repository ${repository} does not match ${expectedRepository}.`);
  }
  const entries = Object.entries(input.components || {});
  if (!entries.length) throw new Error("Component impact map must contain at least one component.");
  const components = Object.fromEntries(entries.map(([rawId, value]) => {
    const id = String(rawId || "").trim();
    if (!id) throw new Error("Component IDs cannot be empty.");
    return [id, normalizeComponent(id, value)];
  }));
  assertAcyclic(components);
  return {
    schemaVersion: COMPONENT_IMPACT_SCHEMA_VERSION,
    project: { key: projectKey, repository },
    aggregateCommand: String(input.aggregateCommand || "npm run check").trim(),
    fullRegressionTriggers: list(input.fullRegressionTriggers),
    components,
  };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function loadLegacyMaps(repoRoot, project) {
  const architectureRoot = path.join(repoRoot, "docs", "architecture");
  if (!existsSync(architectureRoot)) return null;
  const files = readdirSync(architectureRoot)
    .filter((name) => name.endsWith(".components.json") && name !== "components.json")
    .sort();
  if (!files.length) return null;
  const components = {};
  for (const file of files) {
    const legacy = JSON.parse(readFileSync(path.join(architectureRoot, file), "utf8"));
    for (const [rawId, component] of Object.entries(legacy.components || {})) {
      let id = rawId;
      if (components[id]) id = `${file.replace(/\.components\.json$/, "")}:${rawId}`;
      const paths = list(component.paths);
      if (!paths.length) continue;
      components[id] = {
        ...component,
        paths,
        dependsOn: list(component.dependsOn).filter((dependency) => Object.hasOwn(legacy.components || {}, dependency)),
        tests: list(component.tests),
      };
    }
  }
  if (!Object.keys(components).length) return null;
  return {
    schemaVersion: COMPONENT_IMPACT_SCHEMA_VERSION,
    project: {
      key: String(project.key || project.id || "").trim(),
      repository: projectRepositoryIdentity(project),
    },
    aggregateCommand: "npm run check",
    fullRegressionTriggers: ["legacy component map compatibility mode"],
    components,
  };
}

export function loadProjectComponentImpactMap(project = {}, options = {}) {
  const repoRootInput = options.repoRoot || project.sourceRepoPath || project.repoPath;
  if (!repoRootInput || !existsSync(repoRootInput)) {
    return { status: "missing", reason: "repository_root_missing", manifest: null, digest: "", path: "" };
  }
  const repoRoot = realpathSync(repoRootInput);
  const relativeManifestPath = safeRelativePath(
    project.componentImpactMapPath || options.manifestPath || DEFAULT_COMPONENT_MAP_PATH,
    "Component map path",
  );
  const requestedPath = path.resolve(repoRoot, relativeManifestPath);
  if (!inside(repoRoot, requestedPath)) {
    throw new ComponentMapIsolationError("Component map path escapes the project repository.");
  }
  let raw;
  let source = "primary";
  if (existsSync(requestedPath)) {
    const realManifestPath = realpathSync(requestedPath);
    if (!inside(repoRoot, realManifestPath)) {
      throw new ComponentMapIsolationError("Component map resolves outside the project repository.");
    }
    raw = JSON.parse(readFileSync(realManifestPath, "utf8"));
  } else {
    raw = loadLegacyMaps(repoRoot, project);
    source = "legacy";
  }
  if (!raw) {
    return { status: "missing", reason: "component_map_missing", manifest: null, digest: "", path: relativeManifestPath };
  }
  const manifest = validateComponentImpactMap(raw, {
    projectKey: String(project.key || project.id || "").trim(),
    repository: projectRepositoryIdentity(project),
  });
  return {
    status: source === "primary" ? "mapped" : "legacy",
    reason: source === "primary" ? "component_map_loaded" : "legacy_component_maps_loaded",
    manifest,
    digest: sha256Digest(manifest),
    path: source === "primary" ? relativeManifestPath : "docs/architecture/*.components.json",
  };
}
