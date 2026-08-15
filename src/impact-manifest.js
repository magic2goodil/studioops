import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OWNERSHIP_MANIFEST_SCHEMA_VERSION = "studioops.component-ownership.v1";
export const EXACT_SHA_EVIDENCE_SCHEMA_VERSION = "studioops.exact-sha-validation.v1";
export const DEFAULT_OWNERSHIP_MANIFEST_PATH = "config/component-ownership.json";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PATH_FIELDS = ["paths", "entryAdapters", "workflowReleaseSurfaces", "ownedTests"];

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

export function canonicalManifestJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function ownershipManifestDigest(manifest) {
  return `sha256:${createHash("sha256").update(canonicalManifestJson(manifest)).digest("hex")}`;
}

function stringList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return [...new Set(value.map((item) => requiredString(item, label)))].sort();
}

function normalizePattern(value, label) {
  const pattern = requiredString(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(pattern) || pattern.split("/").includes("..")) {
    throw new Error(`${label} must be repository-relative.`);
  }
  return pattern.replace(/^\.\//, "");
}

function findCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function validateOwnershipManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Ownership manifest must be an object.");
  }
  if (input.schemaVersion !== OWNERSHIP_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported ownership manifest schema: ${String(input.schemaVersion || "missing")}`);
  }
  const ids = Object.keys(input.components || {}).sort();
  if (!ids.length) throw new Error("Ownership manifest requires at least one component.");
  const known = new Set(ids);
  const components = {};
  for (const id of ids) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`Invalid component ID: ${id}`);
    const source = input.components[id];
    const classification = requiredString(source?.classification, `${id} classification`);
    if (!new Set(["bounded", "shared"]).has(classification)) {
      throw new Error(`${id} classification must be bounded or shared.`);
    }
    const component = {
      owner: requiredString(source?.owner, `${id} owner`),
      classification,
      publicContracts: stringList(source?.publicContracts, `${id} public contracts`),
      ownedData: stringList(source?.ownedData, `${id} owned data`),
      allowedDependencies: stringList(source?.allowedDependencies, `${id} allowed dependencies`),
      impactEdges: stringList(source?.impactEdges, `${id} impact edges`),
      rollbackBoundary: requiredString(source?.rollbackBoundary, `${id} rollback boundary`),
      testLayers: stringList(source?.testLayers, `${id} test layers`),
      validationCommands: stringList(source?.validationCommands, `${id} validation commands`),
    };
    for (const field of PATH_FIELDS) {
      component[field] = stringList(source?.[field], `${id} ${field}`)
        .map((pattern) => normalizePattern(pattern, `${id} ${field} pattern`));
    }
    if (!PATH_FIELDS.some((field) => component[field].length)) {
      throw new Error(`${id} must own at least one repository surface.`);
    }
    for (const dependency of [...component.allowedDependencies, ...component.impactEdges]) {
      if (!known.has(dependency)) throw new Error(`${id} references unknown component ${dependency}.`);
      if (dependency === id) throw new Error(`${id} cannot reference itself as a dependency or impact edge.`);
    }
    components[id] = component;
  }
  const dependencyGraph = new Map(ids.map((id) => [id, components[id].allowedDependencies]));
  const cycle = findCycle(dependencyGraph);
  if (cycle) throw new Error(`Prohibited component dependency cycle: ${cycle.join(" -> ")}`);
  for (const consumer of ids) {
    for (const dependency of components[consumer].allowedDependencies) {
      if (!components[dependency].impactEdges.includes(consumer)) {
        throw new Error(`Missing transitive impact edge ${dependency} -> ${consumer}.`);
      }
    }
  }
  const normalized = {
    schemaVersion: OWNERSHIP_MANIFEST_SCHEMA_VERSION,
    fullRegressionCommands: stringList(input.fullRegressionCommands, "full regression commands"),
    environmentContract: canonicalValue(input.environmentContract || {}),
    components,
  };
  if (!normalized.fullRegressionCommands.length) throw new Error("Ownership manifest requires full regression commands.");
  requiredString(normalized.environmentContract.id, "environment contract ID");
  return normalized;
}

export async function loadOwnershipManifest(repoPath, manifestPath = DEFAULT_OWNERSHIP_MANIFEST_PATH) {
  const absolutePath = path.resolve(repoPath, manifestPath);
  const relative = path.relative(path.resolve(repoPath), absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Ownership manifest path must remain inside the repository.");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Ownership manifest is missing at ${manifestPath}.`);
    if (error instanceof SyntaxError) throw new Error(`Ownership manifest is malformed: ${error.message}`);
    throw error;
  }
  const manifest = validateOwnershipManifest(parsed);
  return { path: manifestPath, manifest, digest: ownershipManifestDigest(manifest) };
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function normalizeChangedPath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Changed path is not repository-relative: ${String(value || "(empty)")}`);
  }
  return normalized;
}

function directOwners(manifest, changedPath) {
  const owners = [];
  for (const [componentId, component] of Object.entries(manifest.components)) {
    const matchedSurfaces = PATH_FIELDS.filter((field) => (
      component[field].some((pattern) => globRegex(pattern).test(changedPath))
    ));
    if (matchedSurfaces.length) owners.push({ componentId, matchedSurfaces, shared: component.classification === "shared" });
  }
  return owners;
}

function transitiveComponents(manifest, directComponents) {
  const affected = new Set(directComponents);
  const queue = [...directComponents].sort();
  while (queue.length) {
    const componentId = queue.shift();
    for (const dependent of manifest.components[componentId]?.impactEdges || []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
      queue.sort();
    }
  }
  return [...affected].sort();
}

function failClosedReason(reason) {
  return String(reason || "impact_unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function classifyChangedPaths(manifestInput, changedPaths, options = {}) {
  let manifest;
  try {
    manifest = validateOwnershipManifest(manifestInput);
  } catch (error) {
    return {
      changedPaths: [...new Set((changedPaths || []).map(String))].sort(),
      directComponents: [],
      affectedComponents: [],
      selectedComponents: [],
      pathClassifications: [],
      unknown: true,
      shared: false,
      ambiguous: true,
      multiComponent: false,
      fullRegression: true,
      fullRegressionReasons: ["malformed_manifest"],
      manifestDigest: "",
      manifestError: error.message,
      selectedCommands: [],
    };
  }
  const manifestDigest = ownershipManifestDigest(manifest);
  const paths = [...new Set((changedPaths || []).map(normalizeChangedPath))].sort();
  const pathClassifications = paths.map((changedPath) => ({
    path: changedPath,
    owners: directOwners(manifest, changedPath),
  }));
  const directComponents = [...new Set(pathClassifications.flatMap((item) => item.owners.map((owner) => owner.componentId)))].sort();
  const affectedComponents = transitiveComponents(manifest, directComponents);
  const unknown = !paths.length || pathClassifications.some((item) => item.owners.length === 0);
  const ambiguous = pathClassifications.some((item) => item.owners.length > 1);
  const shared = pathClassifications.some((item) => item.owners.some((owner) => owner.shared));
  const multiComponent = affectedComponents.length > 1;
  const expectedDigests = [...new Set([
    ...(Array.isArray(options.expectedManifestDigests) ? options.expectedManifestDigests : []),
    ...(options.expectedManifestDigest ? [options.expectedManifestDigest] : []),
  ].map((item) => String(item || "").trim()).filter(Boolean))];
  const stale = expectedDigests.some((digest) => digest !== manifestDigest);
  const missingPriorDigest = options.requireExpectedManifestDigest === true && !expectedDigests.length;
  const reasons = [];
  if (unknown) reasons.push("unknown_path");
  if (ambiguous) reasons.push("ambiguous_ownership");
  if (shared) reasons.push("shared_surface");
  if (multiComponent) reasons.push("multi_component");
  if (stale) reasons.push("stale_manifest");
  if (missingPriorDigest) reasons.push("missing_manifest_binding");
  for (const reason of options.fullRegressionReasons || []) reasons.push(failClosedReason(reason));
  const fullRegressionReasons = [...new Set(reasons)].sort();
  const fullRegression = fullRegressionReasons.length > 0;
  const selectedComponents = fullRegression ? Object.keys(manifest.components).sort() : affectedComponents;
  const selectedCommands = fullRegression
    ? manifest.fullRegressionCommands
    : [...new Set(selectedComponents.flatMap((id) => manifest.components[id].validationCommands))].sort();
  return {
    changedPaths: paths,
    directComponents,
    affectedComponents,
    selectedComponents,
    pathClassifications,
    unknown,
    shared,
    ambiguous,
    multiComponent,
    fullRegression,
    fullRegressionReasons,
    manifestDigest,
    manifestError: "",
    selectedCommands,
    environmentContract: manifest.environmentContract,
  };
}

async function gitChangedPaths(repoPath, baseSha, headSha, options = {}) {
  const result = await execFileAsync(options.gitBin || "git", [
    "diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${baseSha}...${headSha}`,
  ], { cwd: repoPath, timeout: Number(options.timeoutMs || 60_000), maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout || "").split("\0").filter(Boolean);
}

export async function classifyGitImpact(repoPath, baseSha, headSha, options = {}) {
  const paths = await gitChangedPaths(repoPath, baseSha, headSha, options);
  let loaded;
  try {
    loaded = await loadOwnershipManifest(repoPath, options.manifestPath);
  } catch (error) {
    return {
      ...classifyChangedPaths(null, paths),
      fullRegressionReasons: [error.message.includes("missing") ? "missing_manifest" : "malformed_manifest"],
      manifestError: error.message,
    };
  }
  return classifyChangedPaths(loaded.manifest, paths, options);
}

export function validateDependencyEdges(manifestInput, edges = []) {
  const manifest = validateOwnershipManifest(manifestInput);
  const violations = [];
  for (const edge of edges) {
    const from = requiredString(edge?.from, "dependency source component");
    const to = requiredString(edge?.to, "dependency target component");
    if (!manifest.components[from]) throw new Error(`Unknown dependency source component: ${from}`);
    if (!manifest.components[to]) throw new Error(`Unknown dependency target component: ${to}`);
    if (from !== to && !manifest.components[from].allowedDependencies.includes(to)) {
      violations.push({ from, to, sourcePath: String(edge.sourcePath || ""), targetPath: String(edge.targetPath || "") });
    }
  }
  return { ok: violations.length === 0, violations };
}

async function javascriptFiles(root) {
  const files = [];
  async function visit(relativeDirectory) {
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relativePath);
    }
  }
  await visit("src");
  await visit("scripts");
  return files;
}

function uniqueComponentOwner(manifest, repositoryPath) {
  const owners = directOwners(manifest, repositoryPath);
  return owners.length === 1 ? owners[0].componentId : "";
}

export async function validateRepositoryDependencies(repoPath, manifestInput) {
  const manifest = validateOwnershipManifest(manifestInput);
  const files = await javascriptFiles(repoPath);
  const knownFiles = new Set(files);
  const edges = [];
  const unclassified = [];
  for (const sourcePath of files) {
    const sourceOwner = uniqueComponentOwner(manifest, sourcePath);
    if (!sourceOwner) {
      unclassified.push(sourcePath);
      continue;
    }
    const contents = await readFile(path.join(repoPath, sourcePath), "utf8");
    const importPatterns = [
      /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
      /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    ];
    for (const expression of importPatterns) {
      for (const match of contents.matchAll(expression)) {
        let targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), match[1]));
        if (!path.posix.extname(targetPath)) targetPath += ".js";
        if (!knownFiles.has(targetPath)) continue;
        const targetOwner = uniqueComponentOwner(manifest, targetPath);
        if (!targetOwner) {
          unclassified.push(targetPath);
          continue;
        }
        edges.push({ from: sourceOwner, to: targetOwner, sourcePath, targetPath });
      }
    }
  }
  const dependencyResult = validateDependencyEdges(manifest, edges);
  return {
    ok: dependencyResult.ok && unclassified.length === 0,
    violations: dependencyResult.violations,
    unclassified: [...new Set(unclassified)].sort(),
    edges: edges.sort((left, right) => (
      `${left.sourcePath}:${left.targetPath}`.localeCompare(`${right.sourcePath}:${right.targetPath}`)
    )),
  };
}

function normalizeDigest(value, label) {
  const digest = requiredString(value, label).toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest;
}

function normalizeSha(value, label) {
  const sha = requiredString(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full Git object SHA.`);
  return sha;
}

function nonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`${label} must be a non-negative integer.`);
  return normalized;
}

export function normalizeExactShaEvidence(input, expected = {}) {
  if (!input || typeof input !== "object") throw new Error("Exact-SHA validation evidence is required.");
  if (input.schemaVersion !== EXACT_SHA_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported exact-SHA evidence schema: ${String(input.schemaVersion || "missing")}`);
  }
  const sourceSha = normalizeSha(input.sourceSha, "evidence source SHA");
  const manifestDigest = normalizeDigest(input.manifestDigest, "evidence ownership manifest digest");
  if (expected.sourceSha && sourceSha !== normalizeSha(expected.sourceSha, "expected evidence source SHA")) {
    throw new Error("Exact-SHA evidence is bound to a different source SHA.");
  }
  if (expected.manifestDigest && manifestDigest !== normalizeDigest(expected.manifestDigest, "expected ownership manifest digest")) {
    throw new Error("Exact-SHA evidence is bound to a stale ownership manifest.");
  }
  const commands = (Array.isArray(input.commands) ? input.commands : []).map((command, index) => {
    const normalized = {
      command: requiredString(command?.command, `evidence command ${index + 1}`),
      outcome: requiredString(command?.outcome, `evidence command ${index + 1} outcome`),
      durationMs: nonNegativeInteger(command?.durationMs, `evidence command ${index + 1} duration`),
      retries: nonNegativeInteger(command?.retries, `evidence command ${index + 1} retries`),
      skips: stringList(command?.skips || [], `evidence command ${index + 1} skips`),
      artifactDigests: stringList(command?.artifactDigests || [], `evidence command ${index + 1} artifact digests`)
        .map((digest) => normalizeDigest(digest, `evidence command ${index + 1} artifact digest`)),
    };
    if (normalized.outcome !== "passed") throw new Error(`Evidence command ${index + 1} did not pass.`);
    if (!normalized.artifactDigests.length) throw new Error(`Evidence command ${index + 1} requires an artifact digest.`);
    return normalized;
  });
  if (!commands.length) throw new Error("Exact-SHA evidence requires at least one command.");
  const evidence = {
    schemaVersion: EXACT_SHA_EVIDENCE_SCHEMA_VERSION,
    sourceSha,
    manifestDigest,
    changedPaths: stringList(input.changedPaths || [], "evidence changed paths"),
    affectedComponents: stringList(input.affectedComponents || [], "evidence affected components"),
    selectedComponents: stringList(input.selectedComponents || [], "evidence selected components"),
    unknown: input.unknown === true,
    shared: input.shared === true,
    ambiguous: input.ambiguous === true,
    multiComponent: input.multiComponent === true,
    fullRegression: input.fullRegression === true,
    fullRegressionReasons: stringList(input.fullRegressionReasons || [], "full regression reasons"),
    commands,
    environmentContract: canonicalValue(input.environmentContract || {}),
    artifactDigests: stringList(input.artifactDigests || [], "evidence artifact digests")
      .map((digest) => normalizeDigest(digest, "evidence artifact digest")),
  };
  requiredString(evidence.environmentContract.id, "evidence environment contract ID");
  if (!evidence.selectedComponents.length) throw new Error("Exact-SHA evidence requires selected components.");
  if (!evidence.artifactDigests.length) throw new Error("Exact-SHA evidence requires artifact digests.");
  const failClosedImpact = evidence.unknown
    || evidence.shared
    || evidence.ambiguous
    || evidence.multiComponent
    || evidence.affectedComponents.length > 1;
  if (evidence.fullRegression !== Boolean(evidence.fullRegressionReasons.length || failClosedImpact)) {
    throw new Error("Exact-SHA evidence full-regression decision and reasons disagree.");
  }
  if (failClosedImpact && !evidence.fullRegressionReasons.length) {
    throw new Error("Fail-closed exact-SHA evidence requires a full-regression reason.");
  }
  return evidence;
}

export function buildExactShaEvidence(input = {}) {
  const classification = input.classification || {};
  const commands = (input.commandResults || []).map((result) => {
    const outputDigest = `sha256:${createHash("sha256").update(String(result.output || "")).digest("hex")}`;
    return {
      command: result.command,
      outcome: result.ok ? "passed" : "failed",
      durationMs: result.durationMs,
      retries: result.retries || 0,
      skips: result.skips || [],
      artifactDigests: [...new Set([outputDigest, ...(result.artifactDigests || [])])].sort(),
    };
  });
  const artifactDigests = [...new Set(commands.flatMap((command) => command.artifactDigests))].sort();
  return normalizeExactShaEvidence({
    schemaVersion: EXACT_SHA_EVIDENCE_SCHEMA_VERSION,
    sourceSha: input.sourceSha,
    manifestDigest: classification.manifestDigest,
    changedPaths: classification.changedPaths,
    affectedComponents: classification.affectedComponents,
    selectedComponents: classification.selectedComponents,
    unknown: classification.unknown,
    shared: classification.shared,
    ambiguous: classification.ambiguous,
    multiComponent: classification.multiComponent,
    fullRegression: classification.fullRegression,
    fullRegressionReasons: classification.fullRegressionReasons,
    commands,
    environmentContract: {
      ...(classification.environmentContract || {}),
      nodeVersion: process.version,
      platform: os.platform(),
      architecture: os.arch(),
    },
    artifactDigests,
  }, { sourceSha: input.sourceSha, manifestDigest: classification.manifestDigest });
}

export function assertExactShaEvidenceEnvironment(input, current = {}) {
  const evidence = normalizeExactShaEvidence(input);
  const expected = {
    nodeVersion: current.nodeVersion || process.version,
    platform: current.platform || os.platform(),
    architecture: current.architecture || os.arch(),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (evidence.environmentContract[key] !== value) {
      throw new Error(`Exact-SHA evidence environment mismatch for ${key}.`);
    }
  }
  return evidence;
}
