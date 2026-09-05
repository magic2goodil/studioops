import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  sha256Digest,
  loadProjectComponentImpactMap,
  loadProjectComponentImpactMapAtCommit,
  normalizeRepositoryIdentity,
  projectRepositoryIdentity,
  pathMatchesImpactScope,
} from "./component-impact-map.js";

export { pathMatchesImpactScope } from "./component-impact-map.js";

const FULL_REGRESSION_WORDS = [
  "authorization", "identity", "consent", "privacy", "entitlement", "safety",
  "schema", "migration", "event version", "workflow", "deployment", "public contract",
  "dependency", "composition root", "shared kernel", "multi-component", "ambiguous",
];

function list(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  return [];
}

function taskSearchText(task) {
  return [
    task.title,
    task.description,
    task.userStory,
    task.expectedOutcome,
    ...list(task.labels),
    ...list(task.affectedSurfaces),
    ...list(task.workAreas),
  ].filter(Boolean).join("\n").toLowerCase();
}

function componentTerms(component) {
  return [
    component.id,
    ...component.aliases,
    ...component.capabilities,
    ...component.routes,
    ...component.ui,
    ...component.services,
    ...component.data,
    ...component.jobs,
    ...component.events,
    ...component.workflows,
    ...component.deploySurfaces,
    ...component.publicContracts,
  ].map((item) => String(item || "").trim().toLowerCase()).filter((item) => item.length >= 3);
}

function componentMatchesTask(component, task, text) {
  const workAreas = list(task.workAreas);
  if (workAreas.some((area) => component.paths.some((scope) => (
    pathMatchesImpactScope(area, scope) || pathMatchesImpactScope(scope, area)
  )))) return true;
  return componentTerms(component).some((term) => text.includes(term));
}

function exactSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

function trustedGit(repoRoot, args) {
  return execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    },
  });
}

function candidateRepositoryRoots(project = {}, cwd = process.cwd()) {
  return [...new Set([
    cwd,
    project.repoPath,
    project.sourceRepoPath,
  ].map((item) => String(item || "").trim()).filter((item) => path.isAbsolute(item) && existsSync(item)))]
    .map((item) => realpathSync(item));
}

export function exactCandidateChangedFiles(project = {}, candidate = {}, options = {}) {
  const baseSha = exactSha(candidate.baseSha);
  const commitSha = exactSha(candidate.commitSha);
  if (!baseSha || !commitSha) {
    const error = new Error("Exact candidate diff requires full base and commit SHAs.");
    error.code = "candidate_diff_identity_incomplete";
    throw error;
  }
  const expectedRepository = projectRepositoryIdentity(project);
  let lastError;
  for (const repoRoot of candidateRepositoryRoots(project, options.cwd)) {
    try {
      const remote = (() => {
        try {
          return normalizeRepositoryIdentity(trustedGit(repoRoot, ["remote", "get-url", "origin"]).trim());
        } catch {
          return "";
        }
      })();
      if (!expectedRepository.startsWith("local:") && remote !== expectedRepository) continue;
      trustedGit(repoRoot, ["cat-file", "-e", `${baseSha}^{commit}`]);
      trustedGit(repoRoot, ["cat-file", "-e", `${commitSha}^{commit}`]);
      const output = trustedGit(repoRoot, [
        "--no-pager", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z",
        `${baseSha}...${commitSha}`, "--",
      ]);
      return [...new Set(output.split("\0").filter(Boolean))].sort();
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`Exact candidate diff is unavailable in the bound project repository${lastError?.message ? `: ${lastError.message}` : "."}`);
  error.code = "candidate_diff_unavailable";
  throw error;
}

export function assertChangedFileEvidenceMatches(actualFiles = [], reportedFiles = []) {
  const actual = list(actualFiles).sort();
  const reported = list(reportedFiles).sort();
  if (JSON.stringify(actual) !== JSON.stringify(reported)) {
    const omitted = actual.filter((file) => !reported.includes(file));
    const invented = reported.filter((file) => !actual.includes(file));
    const error = new Error(`Builder changed-file evidence does not match the immutable Git diff. Omitted: ${omitted.join(", ") || "none"}; unverified: ${invented.join(", ") || "none"}.`);
    error.code = "candidate_diff_evidence_mismatch";
    error.omittedFiles = omitted;
    error.unverifiedFiles = invented;
    throw error;
  }
  return true;
}

function artifactSlug(value, fallback) {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function redactDiscoveryOutput(value) {
  return String(value || "")
    .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]");
}

export async function writeBoundedDiscoveryArtifact(input = {}) {
  const artifactRoot = String(input.artifactRoot || "").trim();
  if (!path.isAbsolute(artifactRoot)) throw new Error("Discovery artifact root must be absolute.");
  const reasonCode = artifactSlug(input.reasonCode, "bounded_discovery");
  const projectKey = artifactSlug(input.projectKey, "project");
  const runId = artifactSlug(input.runId || input.taskId, "run");
  const maxBytes = Math.max(1, Math.min(25 * 1024 * 1024, Number(input.maxBytes || 1024 * 1024)));
  const redacted = redactDiscoveryOutput(input.output);
  const encoded = Buffer.from(redacted, "utf8");
  const bounded = encoded.subarray(0, maxBytes);
  const digest = sha256Digest(bounded);
  const directory = path.join(artifactRoot, projectKey, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const artifactPath = path.join(directory, `${reasonCode}-${digest.slice("sha256:".length, "sha256:".length + 16)}.log`);
  await writeFile(artifactPath, bounded, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  return {
    reasonCode,
    path: artifactPath,
    digest,
    bytes: bounded.length,
    originalBytes: encoded.length,
    truncated: encoded.length > bounded.length,
    summary: `Discovery output stored locally (${bounded.length} bytes, ${digest}${encoded.length > bounded.length ? ", truncated" : ""}).`,
  };
}

function fallbackPlan(project, task, loaded, sourceCommit) {
  const allowedFileScope = list(task.workAreas);
  return {
    schemaVersion: 1,
    status: loaded.status,
    project: {
      id: String(project.id || ""),
      key: String(project.key || project.id || ""),
      repository: projectRepositoryIdentity(project),
    },
    sourceCommit: String(sourceCommit || ""),
    manifest: { path: loaded.path || "", digest: loaded.digest || "", schemaVersion: 0 },
    selectedComponents: [],
    allowedFileScope,
    targetedTests: [],
    requiredReviewLanes: [],
    fullRegression: true,
    aggregateCommand: "npm run check",
    reasonCodes: [loaded.reason || "component_map_missing", "full_regression_required"],
    discovery: { required: true, reasonCode: loaded.reason || "component_map_missing" },
  };
}

export function resolveProjectImpactPlan(input = {}) {
  const project = input.project || {};
  const task = input.task || {};
  const candidate = task.candidateIdentity || {};
  const candidateCommit = exactSha(candidate.commitSha);
  const loaded = input.loadedMap || (candidateCommit
    ? loadProjectComponentImpactMapAtCommit(project, candidateCommit, { repoRoot: input.repoRoot })
    : loadProjectComponentImpactMap(project, { repoRoot: input.repoRoot }));
  const sourceCommit = input.sourceCommit || candidate.commitSha || task.reviewSubjectSha || candidate.baseSha || "";
  if (!loaded.manifest) return fallbackPlan(project, task, loaded, sourceCommit);
  const text = taskSearchText(task);
  const declaredPaths = list(task.workAreas);
  const immutableChangedFiles = list(input.changedFiles || candidate.impactEvidence?.changedFiles || task.impactEvidence?.changedFiles);
  const immutableCandidate = Boolean(exactSha(candidate.baseSha) && exactSha(candidate.commitSha));
  const classificationPaths = immutableCandidate ? immutableChangedFiles : declaredPaths;
  const matches = Object.values(loaded.manifest.components)
    .filter((component) => (
      classificationPaths.some((changedPath) => component.paths.some((scope) => pathMatchesImpactScope(changedPath, scope)))
      || (!classificationPaths.length && componentMatchesTask(component, task, text))
    ));
  const selected = matches.length ? matches : [];
  const selectedPaths = [...new Set(selected.flatMap((component) => component.paths))].sort();
  const unmappedDeclaredPaths = declaredPaths.filter((area) => (
    !selectedPaths.some((scope) => pathMatchesImpactScope(area, scope) || pathMatchesImpactScope(scope, area))
  ));
  const unmappedImpactPaths = classificationPaths.filter((changedPath) => (
    !Object.values(loaded.manifest.components).some((component) => (
      component.paths.some((scope) => pathMatchesImpactScope(changedPath, scope))
    ))
  ));
  const sensitiveKeywords = [...new Set([
    ...FULL_REGRESSION_WORDS,
    ...list(loaded.manifest.fullRegressionKeywords).map((item) => item.toLowerCase()),
  ])].filter((word) => text.includes(word));
  const sensitivePaths = classificationPaths.filter((changedPath) => (
    loaded.manifest.releaseSensitivePaths.some((scope) => pathMatchesImpactScope(changedPath, scope))
    || selected.some((component) => component.fullRegressionPaths.some((scope) => pathMatchesImpactScope(changedPath, scope)))
  ));
  const reasonCodes = [];
  if (!selected.length) reasonCodes.push("unclassified_impact");
  if (selected.length > 1) reasonCodes.push("multi_component_impact");
  if (selected.some((component) => component.shared)) reasonCodes.push("shared_component_impact");
  if (unmappedDeclaredPaths.length) reasonCodes.push("declared_path_unmapped");
  if (unmappedImpactPaths.length) reasonCodes.push("immutable_diff_path_unmapped");
  if (immutableCandidate && !immutableChangedFiles.length) reasonCodes.push("immutable_diff_evidence_missing");
  if (sensitiveKeywords.length || sensitivePaths.length) reasonCodes.push("release_sensitive_impact");
  if (loaded.status === "legacy") reasonCodes.push("legacy_manifest_compatibility");
  if (loaded.coverage?.checked && !loaded.coverage.complete) reasonCodes.push("component_map_coverage_drift");
  const fullRegression = reasonCodes.length > 0;
  const allowedFileScope = [...new Set([
    ...selectedPaths,
    ...declaredPaths.filter((area) => selectedPaths.some((scope) => (
      pathMatchesImpactScope(area, scope) || pathMatchesImpactScope(scope, area)
    ))),
  ])].sort();
  // Read supporting contracts without granting edit authority to dependencies.
  const selectedIds = new Set(selected.map((component) => component.id));
  const supportingIds = new Set();
  const visitDependencies = (id) => {
    for (const dependency of loaded.manifest.components[id].dependsOn) {
      if (supportingIds.has(dependency) || selectedIds.has(dependency)) continue;
      supportingIds.add(dependency);
      visitDependencies(dependency);
    }
  };
  for (const id of selectedIds) visitDependencies(id);
  const supporting = [...supportingIds].sort().map((id) => loaded.manifest.components[id]);
  // Dependents own contract/composition checks affected by a changed provider.
  const testIds = new Set(selectedIds);
  let added = true;
  while (added) {
    added = false;
    for (const component of Object.values(loaded.manifest.components)) {
      if (!testIds.has(component.id) && component.dependsOn.some((id) => testIds.has(id))) {
        testIds.add(component.id);
        added = true;
      }
    }
  }
  const dependentTests = [...testIds].filter((id) => !selectedIds.has(id))
    .flatMap((id) => loaded.manifest.components[id].tests.map((entry) => entry.command));
  return {
    schemaVersion: 1,
    status: selected.length ? "mapped" : "unclassified",
    project: {
      id: String(project.id || ""),
      key: String(project.key || project.id || ""),
      repository: projectRepositoryIdentity(project),
    },
    sourceCommit: String(sourceCommit || ""),
    candidateBinding: {
      baseSha: exactSha(candidate.baseSha),
      commitSha: exactSha(candidate.commitSha) || exactSha(sourceCommit),
      changedFilesDigest: immutableChangedFiles.length ? sha256Digest(immutableChangedFiles.sort()) : "",
      classificationSource: immutableCandidate ? "immutable_git_diff" : "declared_task_scope",
    },
    manifest: {
      path: loaded.path,
      digest: loaded.digest,
      schemaVersion: loaded.manifest.schemaVersion,
    },
    selectedComponents: selected.map((component) => ({
      id: component.id,
      owner: component.owner,
      digest: sha256Digest(component),
    })),
    allowedFileScope,
    supportingContext: supporting.map((component) => ({
      id: component.id, owner: component.owner, paths: component.paths,
      publicContracts: component.publicContracts, digest: sha256Digest(component),
    })),
    supportingFileScope: [...new Set(supporting.flatMap((component) => component.paths))].sort(),
    dependentTests: [...new Set(dependentTests)],
    targetedTests: [...new Set(selected.flatMap((component) => component.tests.map((entry) => entry.command)))],
    requiredReviewLanes: [...new Set(selected.flatMap((component) => component.reviewOwners))],
    fullRegression,
    aggregateCommand: loaded.manifest.aggregateCommand,
    coverage: loaded.coverage || null,
    reasonCodes: fullRegression ? reasonCodes : ["single_component_mapped"],
    discovery: {
      required: !selected.length || unmappedDeclaredPaths.length > 0 || unmappedImpactPaths.length > 0 || Boolean(loaded.coverage?.checked && !loaded.coverage.complete),
      reasonCode: !selected.length
        ? "unclassified_impact"
        : unmappedImpactPaths.length
          ? "immutable_diff_path_unmapped"
          : unmappedDeclaredPaths.length ? "declared_path_unmapped" : loaded.coverage?.checked && !loaded.coverage.complete ? "component_map_coverage_drift" : "",
    },
  };
}

export function assertImpactPlanProjectBinding(plan = {}, project = {}) {
  const expectedKey = String(project.key || project.id || "");
  const expectedRepository = projectRepositoryIdentity(project);
  if (plan.project?.id && project.id && plan.project.id !== project.id) {
    throw new Error(`Impact plan project ID ${plan.project.id} does not match ${project.id}.`);
  }
  if (plan.project?.key !== expectedKey) {
    throw new Error(`Impact plan project key ${plan.project?.key || "(missing)"} does not match ${expectedKey}.`);
  }
  if (expectedRepository && normalizeRepositoryIdentity(plan.project?.repository) !== expectedRepository) {
    throw new Error("Impact plan repository binding does not match the dispatched project repository.");
  }
  return true;
}

export function impactScopeDigest(plan = {}) {
  return sha256Digest({ project: plan.project, manifest: plan.manifest, allowedFileScope: list(plan.allowedFileScope).sort() });
}

/** Deliberate, compare-and-swap remapping is separate from builder submission. */
export function remapTaskImpactScope(project, task, remap = {}, options = {}) {
  const previous = task.impactScopePlan || task.impactPlan;
  if (!previous) throw new Error("A dispatched impact scope is required before recording a remap.");
  assertImpactPlanProjectBinding(previous, project);
  if (remap.expectedPlanDigest !== impactScopeDigest(previous)) throw new Error("Impact remap scope digest is stale; read the current scope before remapping.");
  const reason = String(remap.reason || "").trim();
  const workAreas = list(remap.workAreas);
  if (reason.length < 20 || !workAreas.length) throw new Error("Impact remap requires explicit work areas and a substantive reason (at least 20 characters).");
  const commitSha = remap.commitSha ? exactSha(remap.commitSha) : "";
  if (remap.commitSha && !commitSha) throw new Error("Impact remap commit must be a full Git SHA.");
  const plan = resolveProjectImpactPlan({
    project, task: { ...task, workAreas, candidateIdentity: commitSha ? { commitSha } : {}, impactEvidence: {} },
    repoRoot: options.repoRoot || project.sourceRepoPath || project.repoPath,
    sourceCommit: commitSha,
    ...(options.loadedMap ? { loadedMap: options.loadedMap } : {}),
  });
  assertImpactPlanProjectBinding(plan, project);
  if (plan.status !== "mapped" || plan.discovery.required) throw new Error("Impact remap requires complete, unambiguous component ownership; update the repository map first.");
  return {
    plan, workAreas,
    record: { reason, previousDigest: impactScopeDigest(previous), nextDigest: impactScopeDigest(plan),
      previousScope: list(previous.allowedFileScope), nextScope: list(plan.allowedFileScope),
      manifestDigest: plan.manifest.digest, sourceCommit: plan.sourceCommit },
  };
}

export function assertChangedFilesWithinImpactPlan(plan = {}, changedFiles = []) {
  const files = list(changedFiles);
  if (!files.length) return true;
  const scope = list(plan.allowedFileScope);
  const outside = files.filter((file) => !scope.some((pattern) => pathMatchesImpactScope(file, pattern)));
  if (outside.length) {
    const error = new Error(`Changed files fall outside the approved component scope: ${outside.join(", ")}. Remap impact before builder handoff.`);
    error.code = "impact_scope_mismatch";
    error.outsideFiles = outside;
    throw error;
  }
  return true;
}

/** Only a trusted base/config allowlist can authorize candidate-selected commands. */
export function selectImpactValidationCommands({ plan = {}, aggregateCommands = [], approvedTargetedCommands = [], expectedCommitSha = "" } = {}) {
  const fallback = (reason) => ({ commands: list(aggregateCommands), mode: "aggregate", reason });
  if (!exactSha(expectedCommitSha) || plan.candidateBinding?.commitSha !== expectedCommitSha) return fallback("candidate_binding_unverified");
  if (plan.status !== "mapped" || plan.fullRegression || plan.discovery?.required || plan.selectedComponents?.length !== 1) return fallback("full_regression_required");
  const commands = list([...(plan.targetedTests || []), ...(plan.dependentTests || [])]);
  const approved = new Set(list(approvedTargetedCommands));
  if (!commands.length || commands.some((command) => !approved.has(command))) return fallback("targeted_commands_not_approved");
  return { commands, mode: "scoped", reason: "verified_single_component" };
}

export function formatImpactPlanForPrompt(plan = {}) {
  const components = list(plan.selectedComponents?.map((item) => item.id));
  const scope = list(plan.allowedFileScope);
  const tests = list(plan.targetedTests);
  return `SCOPED CONTEXT PACKET (resolve this before repository discovery)
- Project binding: ${plan.project?.id || "(missing)"}/${plan.project?.key || "(missing)"} @ ${plan.project?.repository || "(local identity missing)"}
- Source commit binding: ${plan.sourceCommit || "assigned during workspace preflight"}
- Component manifest: ${plan.manifest?.path || "(missing)"} (${plan.manifest?.digest || "no digest"})
- Manifest digest contract: SHA-256 of canonical JSON after schema validation and normalization; this is intentionally not the raw file-byte hash.
- Selected components: ${components.join(", ") || "(unclassified)"}
- Allowed file scope: ${scope.join(", ") || "(none; remap before editing)"}
- Scope digest for an explicit remap: ${plan.editScopeDigest || impactScopeDigest(plan)}
- Supporting read-only paths: ${list(plan.supportingFileScope).join(", ") || "(none)"}
- Supporting contracts: ${(plan.supportingContext || []).map((item) => `${item.id}: ${list(item.publicContracts).join("; ")}`).join(" | ") || "(none)"}
- Targeted implementation tests: ${tests.join(" && ") || "(none; use final aggregate only)"}
- Dependent contract/composition tests: ${list(plan.dependentTests).join(" && ") || "(none)"}
- Final aggregate required: ${plan.aggregateCommand || "npm run check"}
- Full regression at integration: ${plan.fullRegression ? "yes" : "no"}
- Reason codes: ${list(plan.reasonCodes).join(", ") || "(none)"}

Context rules:
- Start with the named component paths and tests. Do not list or broadly search the repository for mapped work.
- Read supporting paths only as needed to understand the named contracts; supporting paths do not grant edit permission.
- Do not edit outside the allowed file scope. If it is incomplete or stale, stop and request a bounded remap.
- Keep broader discovery exceptional, redacted, artifact-backed, and out of the model transcript.`;
}
