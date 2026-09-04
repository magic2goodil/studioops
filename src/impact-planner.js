import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Digest, loadProjectComponentImpactMap, normalizeRepositoryIdentity, projectRepositoryIdentity } from "./component-impact-map.js";

const FULL_REGRESSION_WORDS = [
  "authorization", "identity", "consent", "privacy", "entitlement", "safety",
  "schema", "migration", "event version", "workflow", "deployment", "public contract",
  "dependency", "composition root", "shared kernel", "multi-component", "ambiguous",
];

function list(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function pathMatchesImpactScope(file, scope) {
  const candidate = String(file || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const pattern = String(scope || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!candidate || !pattern) return false;
  if (!pattern.includes("*")) return candidate === pattern || candidate.startsWith(`${pattern.replace(/\/$/, "")}/`);
  const regex = escapeRegex(pattern)
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${regex}$`).test(candidate);
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
        "--no-pager", "diff", "--no-ext-diff", "--no-renames", "--name-only", "--diff-filter=ACMR", "-z",
        `${baseSha}...${commitSha}`, "--",
      ]);
      return [...new Set(output.split("\0").map((item) => item.trim()).filter(Boolean))].sort();
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
  const loaded = input.loadedMap || loadProjectComponentImpactMap(project, { repoRoot: input.repoRoot });
  const candidate = task.candidateIdentity || {};
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
  const fullRegression = reasonCodes.length > 0;
  const allowedFileScope = [...new Set([
    ...selectedPaths,
    ...declaredPaths.filter((area) => selectedPaths.some((scope) => (
      pathMatchesImpactScope(area, scope) || pathMatchesImpactScope(scope, area)
    ))),
  ])].sort();
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
    targetedTests: [...new Set(selected.flatMap((component) => component.tests.map((entry) => entry.command)))],
    requiredReviewLanes: [...new Set(selected.flatMap((component) => component.reviewOwners))],
    fullRegression,
    aggregateCommand: loaded.manifest.aggregateCommand,
    reasonCodes: fullRegression ? reasonCodes : ["single_component_mapped"],
    discovery: {
      required: !selected.length || unmappedDeclaredPaths.length > 0 || unmappedImpactPaths.length > 0,
      reasonCode: !selected.length
        ? "unclassified_impact"
        : unmappedImpactPaths.length
          ? "immutable_diff_path_unmapped"
          : unmappedDeclaredPaths.length ? "declared_path_unmapped" : "",
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

export function assertChangedFilesWithinImpactPlan(plan = {}, changedFiles = []) {
  const files = list(changedFiles);
  if (!files.length || !["mapped", "unclassified"].includes(plan.status)) return true;
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

export function formatImpactPlanForPrompt(plan = {}) {
  const components = list(plan.selectedComponents?.map((item) => item.id));
  const scope = list(plan.allowedFileScope);
  const tests = list(plan.targetedTests);
  return `SCOPED CONTEXT PACKET (resolve this before repository discovery)
- Project binding: ${plan.project?.id || "(missing)"}/${plan.project?.key || "(missing)"} @ ${plan.project?.repository || "(local identity missing)"}
- Source commit binding: ${plan.sourceCommit || "assigned during workspace preflight"}
- Component manifest: ${plan.manifest?.path || "(missing)"} (${plan.manifest?.digest || "no digest"})
- Selected components: ${components.join(", ") || "(unclassified)"}
- Allowed file scope: ${scope.join(", ") || "(none; remap before editing)"}
- Targeted implementation tests: ${tests.join(" && ") || "(none; use final aggregate only)"}
- Final aggregate required: ${plan.aggregateCommand || "npm run check"}
- Full regression at integration: ${plan.fullRegression ? "yes" : "no"}
- Reason codes: ${list(plan.reasonCodes).join(", ") || "(none)"}

Context rules:
- Start with the named component paths and tests. Do not list or broadly search the repository for mapped work.
- Do not edit outside the allowed file scope. If it is incomplete or stale, stop and request a bounded remap.
- Keep broader discovery exceptional, redacted, artifact-backed, and out of the model transcript.`;
}
