import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  const material = typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : canonicalJson(value);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
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
    || normalized.split("/").includes("..")
    || normalized.includes("\0")
  ) {
    throw new Error(`${label} must be a repository-relative path: ${value || "(missing)"}`);
  }
  return normalized;
}

export function pathMatchesImpactScope(file, scope) {
  const candidate = String(file || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const pattern = String(scope || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!candidate || !pattern) return false;
  if (!pattern.includes("*")) return candidate === pattern || candidate.startsWith(`${pattern.replace(/\/$/, "")}/`);
  const regex = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
  return new RegExp(`^${regex}$`).test(candidate);
}

/** Compare tracked source inventory with ownership, never source contents. */
export function inspectComponentMapCoverage(manifest, files = []) {
  const roots = manifest.coverageRoots || [];
  const relevant = list(files).filter((file) => roots.some((root) => pathMatchesImpactScope(file, root)));
  const uncoveredFiles = [];
  const conflictingFiles = [];
  for (const file of relevant) {
    const owners = Object.values(manifest.components).filter((component) => component.paths.some((scope) => pathMatchesImpactScope(file, scope)));
    if (!owners.length) uncoveredFiles.push(file);
    if (owners.length > 1) conflictingFiles.push({ path: file, owners: owners.map((owner) => owner.id).sort() });
  }
  return {
    checked: roots.length > 0,
    fileCount: relevant.length,
    mappedFileCount: relevant.length - uncoveredFiles.length - conflictingFiles.length,
    uncoveredFiles: uncoveredFiles.sort(),
    conflictingFiles,
    complete: !uncoveredFiles.length && !conflictingFiles.length,
  };
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

function normalizeComponent(id, input = {}, options = {}) {
  const owner = String(input.owner || "").trim();
  if (!owner) throw new Error(`Component ${id} must declare an owner.`);
  const paths = list(input.paths).map((item) => safeRelativePath(item, `Component ${id} path`));
  if (!paths.length) throw new Error(`Component ${id} must declare at least one repository-relative path.`);
  const component = {
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
    policyAuthorities: list(input.policyAuthorities),
    dependsOn: list(input.dependsOn),
    reviewOwners: list(input.reviewOwners || input.reviewers),
    tests: (Array.isArray(input.tests) ? input.tests : []).map((test) => normalizeTest(test, id)),
    fullRegressionPaths: list(input.fullRegressionPaths).map((item) => safeRelativePath(item, `Component ${id} full-regression path`)),
    shared: input.shared === true,
    rollback: String(input.rollback || "").trim(),
  };
  if (!options.compatibility) {
    if (!component.publicContracts.length) throw new Error(`Component ${id} must classify its public contracts.`);
    if (!component.reviewOwners.length) throw new Error(`Component ${id} must declare review owners.`);
    if (!component.tests.length) throw new Error(`Component ${id} must declare owned tests.`);
    if (!component.rollback) throw new Error(`Component ${id} must declare a rollback boundary.`);
    if (![component.routes, component.ui, component.services, component.data, component.jobs, component.events, component.workflows, component.deploySurfaces].some((items) => items.length)) {
      throw new Error(`Component ${id} must classify at least one runtime, data, workflow, or deploy surface.`);
    }
  }
  return component;
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
    return [id, normalizeComponent(id, value, { compatibility: expected.compatibility === true })];
  }));
  assertAcyclic(components);
  if (!expected.compatibility) {
    const pathOwners = new Map();
    const policyOwners = new Map();
    for (const component of Object.values(components)) {
      for (const ownedPath of component.paths) {
        const owners = pathOwners.get(ownedPath) || [];
        owners.push(component.id);
        pathOwners.set(ownedPath, owners);
      }
      for (const authority of component.policyAuthorities) {
        const owners = policyOwners.get(authority) || [];
        owners.push(component.id);
        policyOwners.set(authority, owners);
      }
    }
    const duplicatePath = [...pathOwners].find(([, owners]) => owners.length > 1);
    if (duplicatePath) throw new Error(`Repository path ${duplicatePath[0]} has duplicate component authorities: ${duplicatePath[1].join(", ")}.`);
    const duplicatePolicy = [...policyOwners].find(([, owners]) => owners.length > 1);
    if (duplicatePolicy) throw new Error(`Business policy ${duplicatePolicy[0]} has duplicate component authorities: ${duplicatePolicy[1].join(", ")}.`);
  }
  const prohibitedDependencies = (Array.isArray(input.prohibitedDependencies) ? input.prohibitedDependencies : []).map((edge) => ({
    from: String(edge?.from || "").trim(),
    to: String(edge?.to || "").trim(),
  }));
  for (const edge of prohibitedDependencies) {
    if (!edge.from || !edge.to) throw new Error("Prohibited dependency entries require from and to component IDs.");
    if (components[edge.from]?.dependsOn.includes(edge.to)) {
      throw new Error(`Component dependency ${edge.from} -> ${edge.to} is prohibited.`);
    }
  }
  const releaseSensitivePaths = list(input.releaseSensitivePaths)
    .map((item) => safeRelativePath(item, "Release-sensitive path"));
  for (const sensitivePath of releaseSensitivePaths) {
    const owner = Object.values(components).find((component) => component.paths.includes(sensitivePath));
    if (!owner) throw new Error(`Release-sensitive path ${sensitivePath} has no component owner.`);
    if (!owner.fullRegressionPaths.includes(sensitivePath)) {
      throw new Error(`Release-sensitive path ${sensitivePath} must be classified for full regression by ${owner.id}.`);
    }
  }
  return {
    schemaVersion: COMPONENT_IMPACT_SCHEMA_VERSION,
    project: { key: projectKey, repository },
    aggregateCommand: String(input.aggregateCommand || "npm run check").trim(),
    ...(list(input.coverageRoots).length ? { coverageRoots: list(input.coverageRoots).map((item) => safeRelativePath(item, "Coverage root")) } : {}),
    fullRegressionTriggers: list(input.fullRegressionTriggers),
    fullRegressionKeywords: list(input.fullRegressionKeywords),
    releaseSensitivePaths,
    prohibitedDependencies,
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
        publicContracts: list(component.publicContracts).length ? component.publicContracts : ["legacy component contract"],
        reviewers: list(component.reviewers).length ? component.reviewers : [component.owner || "legacy-owner"],
        tests: Array.isArray(component.tests) && component.tests.length ? component.tests : ["npm run check"],
        workflows: list(component.workflows).length ? component.workflows : ["legacy compatibility workflow"],
        rollback: component.rollback || "Disable legacy-map planning and use full regression.",
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
    compatibility: source === "legacy",
  });
  const coverage = manifest.coverageRoots?.length
    ? inspectComponentMapCoverage(manifest, trustedGit(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...manifest.coverageRoots]).split("\0").filter(Boolean))
    : inspectComponentMapCoverage(manifest);
  return {
    status: !coverage.complete ? "drifted" : source === "primary" ? "mapped" : "legacy",
    reason: source === "primary" ? "component_map_loaded" : "legacy_component_maps_loaded",
    manifest,
    digest: sha256Digest(manifest),
    path: source === "primary" ? relativeManifestPath : "docs/architecture/*.components.json",
    coverage,
  };
}

function trustedGit(repoRoot, args) {
  return execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    },
  });
}

/**
 * Load the primary component map from an immutable candidate commit without
 * changing the repository checkout. The Git root and its origin must still
 * match the task's project authority, so an object from another repository
 * cannot supply a remap.
 */
export function loadProjectComponentImpactMapAtCommit(project = {}, commitSha, options = {}) {
  const sha = String(commitSha || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Candidate component-map lookup requires a full Git SHA.");
  }
  const repoRootInput = options.repoRoot || project.sourceRepoPath || project.repoPath;
  if (!repoRootInput || !existsSync(repoRootInput)) {
    return { status: "missing", reason: "repository_root_missing", manifest: null, digest: "", path: "", sourceCommit: sha };
  }
  const repoRoot = realpathSync(repoRootInput);
  const expectedRepository = projectRepositoryIdentity(project);
  if (expectedRepository && !expectedRepository.startsWith("local:")) {
    let observedRepository = "";
    try {
      observedRepository = normalizeRepositoryIdentity(trustedGit(repoRoot, ["remote", "get-url", "origin"]).trim());
    } catch {
      throw new ComponentMapIsolationError("Candidate component-map repository origin is unavailable.");
    }
    if (observedRepository !== expectedRepository) {
      throw new ComponentMapIsolationError(`Candidate component-map repository ${observedRepository || "(missing)"} does not match ${expectedRepository}.`);
    }
  }
  trustedGit(repoRoot, ["cat-file", "-e", `${sha}^{commit}`]);
  const relativeManifestPath = safeRelativePath(
    project.componentImpactMapPath || options.manifestPath || DEFAULT_COMPONENT_MAP_PATH,
    "Component map path",
  );
  let serialized;
  try {
    serialized = trustedGit(repoRoot, ["show", `${sha}:${relativeManifestPath}`]);
  } catch {
    return {
      status: "missing",
      reason: "component_map_missing_at_candidate",
      manifest: null,
      digest: "",
      path: relativeManifestPath,
      sourceCommit: sha,
    };
  }
  const manifest = validateComponentImpactMap(JSON.parse(serialized), {
    projectKey: String(project.key || project.id || "").trim(),
    repository: expectedRepository,
  });
  const coverage = manifest.coverageRoots?.length
    ? inspectComponentMapCoverage(manifest, trustedGit(repoRoot, ["ls-tree", "-r", "--name-only", "-z", sha, "--", ...manifest.coverageRoots]).split("\0").filter(Boolean))
    : inspectComponentMapCoverage(manifest);
  return {
    status: coverage.complete ? "mapped" : "drifted",
    reason: "candidate_component_map_loaded",
    manifest,
    digest: sha256Digest(manifest),
    path: relativeManifestPath,
    sourceCommit: sha,
    coverage,
  };
}
