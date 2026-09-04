import { sha256Digest, loadProjectComponentImpactMap, normalizeRepositoryIdentity, projectRepositoryIdentity } from "./component-impact-map.js";

const FULL_REGRESSION_WORDS = [
  "authorization", "identity", "safety", "schema", "migration", "workflow",
  "deployment", "composition root", "shared kernel", "multi-component", "ambiguous",
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
  const sourceCommit = input.sourceCommit || task.candidateIdentity?.baseSha || task.reviewSubjectSha || "";
  if (!loaded.manifest) return fallbackPlan(project, task, loaded, sourceCommit);
  const text = taskSearchText(task);
  const matches = Object.values(loaded.manifest.components)
    .filter((component) => componentMatchesTask(component, task, text));
  const selected = matches.length ? matches : [];
  const selectedPaths = [...new Set(selected.flatMap((component) => component.paths))].sort();
  const declaredPaths = list(task.workAreas);
  const unmappedDeclaredPaths = declaredPaths.filter((area) => (
    !selectedPaths.some((scope) => pathMatchesImpactScope(area, scope) || pathMatchesImpactScope(scope, area))
  ));
  const sensitive = FULL_REGRESSION_WORDS.filter((word) => text.includes(word));
  const reasonCodes = [];
  if (!selected.length) reasonCodes.push("unclassified_impact");
  if (selected.length > 1) reasonCodes.push("multi_component_impact");
  if (selected.some((component) => component.shared)) reasonCodes.push("shared_component_impact");
  if (unmappedDeclaredPaths.length) reasonCodes.push("declared_path_unmapped");
  if (sensitive.length) reasonCodes.push("release_sensitive_impact");
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
      required: !selected.length || unmappedDeclaredPaths.length > 0,
      reasonCode: !selected.length ? "unclassified_impact" : unmappedDeclaredPaths.length ? "declared_path_unmapped" : "",
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
