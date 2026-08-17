import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  assertCandidateEnvelope,
  invalidateCandidate,
  normalizeGitSha,
} from "./candidate-manifest.js";
import { verifyCandidateRepositoryState } from "./candidate-repository.js";
import {
  branchWebUrl,
  integrationBranchName,
  integrationBranchSafetyError,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "./integration-policy.js";
import { missionControlDataDir } from "./runtime-paths.js";
import {
  normalizeProjectWorkflowMode,
  normalizeWorkspaceRetention,
  withDefaultProjectStandards,
} from "./config.js";
import { activeSelfUpdateLease } from "./self-update-lease.js";
import {
  CANONICAL_LIFECYCLE_STATUSES,
  evaluateLifecycleTransition,
  lifecycleEvidenceChanged,
  positiveStateVersion,
} from "./lifecycle-policy.js";
import {
  DATABASE_FILE,
  LEGACY_DATA_FILE,
  ensureStateDatabase,
  mutateDatabaseState,
  readDatabaseState,
  readDatabaseStateReadOnly,
  writeDatabaseState,
} from "./state-database.js";
import {
  createRemediationHandoff,
  currentRemediationHandoff,
  remediationPromptSection,
  supersedeRemediationHandoff,
} from "./remediation-handoff.js";

const DATA_DIR = missionControlDataDir();
const DATA_FILE = LEGACY_DATA_FILE;

const VALID_STATUSES = new Set(CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"));

const VALID_REVIEW_OUTCOMES = new Set([
  "approved",
  "changes_requested",
  "skipped",
]);

const REVIEW_COMPLETE_OUTCOMES = new Set([
  "approved",
  "skipped",
]);

const VALID_RUN_STATUSES = new Set([
  "queued",
  "running",
  "notified",
  "completed",
  "failed",
  "cancelled",
]);

const DEPENDENCY_COMPLETE_STATUSES = new Set([
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const WORKSPACE_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_ORPHANED_TASK_GRACE_MS = 15 * 60 * 1000;
const DEFAULT_TRANSIENT_RECOVERY_MS = 2 * 60 * 1000;
const MAX_TRANSIENT_RECOVERY_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TRANSIENT_RECOVERIES = 1;
const GITHUB_REMOTE_RECOVERY_DELAYS_MS = [
  60_000,
  2 * 60_000,
  4 * 60_000,
  8 * 60_000,
  15 * 60_000,
];
const VALID_DELIVERY_MODES = new Set(["functional", "prototype", "visual-only"]);
const VALID_DELIVERY_POLICY_PROFILES = new Set(["standard", "prototype-fast-lane"]);
const CAPABILITY_KEYS = ["backend", "frontend", "accessibility", "lead"];
const ARCHITECTURE_TASK_PATTERN = /\b(app|application|platform|product|system|dashboard|portal|website|web app|mobile|native|mockup|redesign)\b/i;

export const READINESS_FIELDS = Object.freeze([
  "userStory", "expectedOutcome", "acceptanceCriteria", "affectedSurfaces",
  "workAreas", "validationPlan", "riskClassification", "privacyNotes",
  "securityNotes", "dependsOnTaskIds", "architectureDecision",
]);

function readinessValuePresent(field, value) {
  if (field === "dependsOnTaskIds") return Array.isArray(value);
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(String(value || "").trim());
}

export function evaluateTaskReadiness(task = {}, state = null) {
  const missing = [];
  const aliases = {
    affectedSurfaces: task.affectedSurfaces || task.workAreas,
    architectureDecision: task.architectureDecision || task.architectureSummary
      || (task.architectureWaiver ? "waived" : "")
      || (task.architectureStatus === "not_required" ? "not_required" : ""),
  };
  for (const field of READINESS_FIELDS) {
    const value = aliases[field] ?? task[field];
    if (!readinessValuePresent(field, value)) missing.push(field);
  }
  const dependencyErrors = state ? dependencyGraphErrors(state, task) : [];
  return {
    ready: missing.length === 0 && dependencyErrors.length === 0,
    missing,
    dependencyErrors,
  };
}

export function dependencyGraphErrors(state = { tasks: [] }, task = {}) {
  const errors = [];
  const tasks = task.id
    ? [...(state.tasks || []).filter((item) => item.id !== task.id), task]
    : state.tasks || [];
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path = []) {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle detected: ${[...path, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    const current = byId.get(id);
    if (!current) {
      errors.push(`Unknown dependency task: ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependencyId of current.dependsOnTaskIds || []) {
      const dependency = byId.get(dependencyId);
      if (dependency && current.projectId !== dependency.projectId) {
        errors.push(`Cross-project dependency is not allowed: ${current.id} -> ${dependency.id}`);
      }
      visit(dependencyId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  visit(task.id, []);
  return [...new Set(errors)];
}

export function completionEvidenceForTask(state, task = {}) {
  const reviews = (state.reviews || []).filter((review) => review.taskId === task.id && !review.invalidatedAt);
  const currentReviews = reviews.filter((review) => reviewMatchesCurrentCandidate(task, review));
  const requiredStages = state.projects
    ? reviewStagesForTask(findProject(state, task.projectId) || {}, task).filter((stage) => stage.required !== false)
    : [];
  const missingReviews = requiredStages.filter((stage) => !currentReviews.some((review) => (
    (review.stageKey === stage.key || review.status === stage.status) && ["approved", "skipped"].includes(review.outcome)
  ))).map((stage) => stage.key || stage.status);
  const project = (state.projects || []).find((item) => item.id === task.projectId) || {};
  const subjectSha = String(task.reviewSubjectSha || task.candidateIdentity?.commitSha || "").trim();
  const exactReceipt = (value) => {
    if (!value || typeof value !== "object" || !subjectSha) return false;
    const boundSha = String(value.subjectSha || value.sourceSha || value.commitSha || "").trim();
    return boundSha === subjectSha && Boolean(String(value.id || value.url || value.recordedAt || "").trim());
  };
  const localWorkflow = projectUsesLocalWorkflow(project);
  const requiresRelease = task.type === "release" || task.completionPolicy?.releaseRequired === true;
  const requiresDeployment = task.type === "deployment" || task.area === "deployment" || task.completionPolicy?.deploymentRequired === true;
  const merge = localWorkflow || exactReceipt(task.mergeEvidence);
  const release = !requiresRelease || exactReceipt(task.releaseEvidence);
  const deployment = !requiresDeployment || exactReceipt(task.deploymentEvidence);
  const verification = exactReceipt(task.verificationEvidence);
  return {
    complete: missingReviews.length === 0 && merge && release && deployment && verification,
    missingReviews,
    missing: [
      ...(merge ? [] : ["merge"]),
      ...(release ? [] : ["release"]),
      ...(deployment ? [] : ["deployment"]),
      ...(verification ? [] : ["verification"]),
    ],
  };
}

export function projectUsesLocalWorkflow(project = {}) {
  return normalizeProjectWorkflowMode(project.workflowMode || "auto") === "local";
}

export function taskHasExactReviewSubject(task = {}) {
  try {
    normalizeGitSha(task.reviewSubjectSha, "review subject SHA");
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_REVIEW_PIPELINE = [
  {
    key: "backend",
    label: "Backend Review",
    role: "backend-reviewer",
    status: "backend_review",
    required: true,
    description: "Review API contracts, persistence, auth, privacy, security, migrations, and deployment risk.",
  },
  {
    key: "frontend",
    label: "Frontend Review",
    role: "frontend-reviewer",
    status: "frontend_review",
    required: true,
    description: "Review UI/UX, responsiveness, accessibility, design-system reuse, content editability, and browser health.",
  },
  {
    key: "accessibility",
    label: "Accessibility Review",
    role: "accessibility-reviewer",
    status: "accessibility_review",
    required: true,
    description: "Expert review of contrast, readable typography, focus-visible states, keyboard behavior, semantics, labels, alt text, ARIA use, and screen-reader basics before lead review.",
  },
  {
    key: "lead",
    label: "Primary Lead Review",
    role: "lead-reviewer",
    status: "lead_review",
    required: true,
    description: "Review product fit, architecture, reviewer findings, PR/task scope, and readiness for the human owner.",
  },
];

const DEFAULT_REVIEW_POLICY = {
  maxBuilderReviewCycles: 2,
  reviewerMayFixSmallIssues: true,
  leadOwnsFinalDecisionAtLimit: true,
  trustLeadApprovals: false,
  qaReviewerRole: "qa-reviewer",
  integrationBranch: "",
};

export {
  DATA_DIR,
  DATA_FILE,
  DATABASE_FILE,
  VALID_STATUSES,
  VALID_REVIEW_OUTCOMES,
  VALID_RUN_STATUSES,
  DEFAULT_REVIEW_PIPELINE,
  DEFAULT_REVIEW_POLICY,
  VALID_DELIVERY_POLICY_PROFILES,
};

export const WORKSPACE_RETENTION_STATUSES = Object.freeze([...WORKSPACE_TERMINAL_STATUSES]);

function workspaceSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 72);
}

export function expectedRunWorkspacePath(workspaceRoot, projectKey, runId, branchName) {
  const root = path.resolve(String(workspaceRoot || ""));
  const project = workspaceSegment(projectKey);
  const run = workspaceSegment(runId);
  const branch = workspaceSegment(branchName);
  if (!root || !project || !run || !branch) return "";
  return path.join(root, project, `${run}-${branch}`);
}

function canonicalPathIdentity(value) {
  const resolved = path.resolve(String(value || ""));
  const missingSegments = [];
  let current = resolved;
  while (true) {
    try {
      return {
        resolved,
        canonical: path.join(realpathSync(current), ...missingSegments),
        exists: missingSegments.length === 0,
        error: "",
      };
    } catch (error) {
      if (error?.code !== "ENOENT") return { resolved, canonical: "", exists: false, error: "path_resolution_failed" };
      const parent = path.dirname(current);
      if (parent === current) return { resolved, canonical: "", exists: false, error: "path_resolution_failed" };
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pathIdentitiesOverlap(left, right) {
  const overlaps = (a, b) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
  return overlaps(left.resolved, right.resolved) || overlaps(left.canonical, right.canonical);
}

export function workspacePathProtectionReason(run = {}, input = {}) {
  const workspaceRoot = String(input.workspaceRoot || "").trim();
  const candidate = String(run.workspacePath || "").trim();
  if (!workspaceRoot || !candidate) return "missing_workspace_path";
  const rootIdentity = canonicalPathIdentity(workspaceRoot);
  const candidateIdentity = canonicalPathIdentity(candidate);
  if (rootIdentity.error) return "unresolvable_workspace_root";
  if (candidateIdentity.error) return "unresolvable_workspace_path";
  const root = rootIdentity.resolved;
  const resolved = candidateIdentity.resolved;
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..")) return "outside_workspace_root";
  for (let current = resolved; current !== root && current.startsWith(`${root}${path.sep}`); current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return "symlinked_workspace_ancestor";
    } catch (error) {
      // A not-yet-created path is verified by the filesystem adapter at deletion time.
      if (error?.code !== "ENOENT") return "unresolvable_workspace_path";
    }
  }
  if (rootIdentity.exists && rootIdentity.canonical !== root) return "symlinked_workspace_root";
  if (candidateIdentity.exists && candidateIdentity.canonical !== resolved) return "symlinked_workspace_ancestor";
  if (relative.split(path.sep).includes("candidates")) return "candidate_artifact_path";
  if (run.workspaceStrategy !== "worktree" && run.workspaceStrategy !== "clone" && run.workspaceStrategy !== "local-clone") {
    return "unexpected_workspace_strategy";
  }
  const project = input.project || {};
  const sourceRepoPaths = [project.repoPath, ...(input.sourceRepoPaths || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  for (const sourceRepoPath of sourceRepoPaths) {
    const sourceIdentity = canonicalPathIdentity(sourceRepoPath);
    if (sourceIdentity.error) return "unresolvable_source_repository_path";
    if (pathIdentitiesOverlap(sourceIdentity, candidateIdentity)) return "source_repository_path";
  }
  const expected = expectedRunWorkspacePath(root, project.key || run.projectKey, run.id, run.branchName || run.branch);
  if (!expected || expected !== resolved) return "workspace_identity_mismatch";
  return "";
}

function cleanupEvidence(run, input, result) {
  const safeError = String(result.error || "")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED]")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return {
    runId: run.id,
    strategy: run.workspaceStrategy || "",
    logicalBytes: Number.isFinite(Number(input.logicalBytes)) && Number(input.logicalBytes) >= 0 ? Number(input.logicalBytes) : 0,
    filesystemReclaimedBytes: Number.isFinite(Number(input.filesystemReclaimedBytes)) && Number(input.filesystemReclaimedBytes) >= 0
      ? Number(input.filesystemReclaimedBytes)
      : null,
    reason: String(input.reason || "retention_sweep").trim().slice(0, 120),
    leaseId: String(input.leaseId || "").trim().slice(0, 160),
    claimedAt: String(input.claimedAt || run.workspaceCleanup?.claimedAt || "").trim(),
    finalizedAt: String(input.now || new Date().toISOString()).trim(),
    error: safeError,
  };
}

function verifiedWorkspaceBytes(run, input = {}) {
  const supplied = input.verifiedWorkspaceBytes;
  const value = supplied instanceof Map
    ? supplied.get(run.id)
    : supplied && typeof supplied === "object" && Object.prototype.hasOwnProperty.call(supplied, run.id)
      ? supplied[run.id]
      : run.workspaceBytesVerified === true ? run.workspaceBytes : undefined;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function activeRunWorkspaceReferences(state) {
  const references = [];
  let ambiguous = false;
  for (const value of (state.runs || [])
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
    .flatMap((run) => [run.workspacePath, run.executionRepoPath])) {
    if (!String(value || "").trim()) continue;
    const identity = canonicalPathIdentity(value);
    if (identity.error) ambiguous = true;
    else references.push(identity);
  }
  return { references, ambiguous };
}

function activeReferenceProtectsPath(activeReferences, workspacePath) {
  if (activeReferences.ambiguous) return true;
  const candidateIdentity = canonicalPathIdentity(workspacePath);
  return candidateIdentity.error || activeReferences.references.some((reference) => (
    pathIdentitiesOverlap(reference, candidateIdentity)
  ));
}

function verifiedRetainedWorkspaceBytesInState(state, input, root, activeReferences) {
  const sourceRepoPaths = (state.projects || []).map((project) => project.repoPath).filter(Boolean);
  return (state.runs || []).reduce((total, run) => {
    if (!WORKSPACE_TERMINAL_STATUSES.has(run.status)) return total;
    if (run.workspaceCleanup?.state === "completed") return total;
    const project = (state.projects || []).find((item) => item.id === run.projectId || item.key === run.projectKey);
    if (activeReferenceProtectsPath(activeReferences, run.workspacePath)) return total;
    if (workspacePathProtectionReason(run, { workspaceRoot: root, project, sourceRepoPaths })) return total;
    const bytes = verifiedWorkspaceBytes(run, input);
    return bytes === null ? total : total + bytes;
  }, 0);
}

function incrementRetentionReason(report, reason, bytes = null) {
  report.excludedByReason[reason] = (report.excludedByReason[reason] || 0) + 1;
  if (bytes === null) {
    report.excludedUnknownSizeCountByReason[reason] = (report.excludedUnknownSizeCountByReason[reason] || 0) + 1;
  } else {
    report.excludedVerifiedBytesByReason[reason] = (report.excludedVerifiedBytesByReason[reason] || 0) + bytes;
  }
}

function retentionSelectionInState(state, input = {}) {
  const policy = normalizeWorkspaceRetention(input.policy || {});
  const report = {
    consideredCount: (state.runs || []).length,
    eligibleCount: 0,
    selectedCount: 0,
    excludedCount: 0,
    excludedByReason: {},
    excludedVerifiedBytesByReason: {},
    excludedUnknownSizeCountByReason: {},
  };
  if (!policy.enabled) {
    report.excludedCount = report.consideredCount;
    if (report.excludedCount) {
      report.excludedByReason.policy_disabled = report.excludedCount;
      report.excludedUnknownSizeCountByReason.policy_disabled = report.excludedCount;
    }
    return { candidates: [], report };
  }
  const nowMs = Number(input.nowMs ?? Date.now());
  const pressure = input.pressure === true;
  const root = String(input.workspaceRoot || "");
  const activeReferences = activeRunWorkspaceReferences(state);
  if (activeReferences.ambiguous) {
    report.excludedCount = report.consideredCount;
    if (report.excludedCount) {
      report.excludedByReason.active_reference_ambiguous = report.excludedCount;
      report.excludedUnknownSizeCountByReason.active_reference_ambiguous = report.excludedCount;
    }
    return { candidates: [], report };
  }
  const sourceRepoPaths = (state.projects || []).map((project) => project.repoPath).filter(Boolean);
  const verifiedRetainedBytes = verifiedRetainedWorkspaceBytesInState(state, input, root, activeReferences);
  const capacityPressure = verifiedRetainedBytes > policy.maxRetainedBytes;
  const candidates = [];
  for (const run of state.runs || []) {
    let exclusion = "";
    if (!WORKSPACE_TERMINAL_STATUSES.has(run.status)) exclusion = "nonterminal_run";
    else if (run.workspaceCleanup?.state === "completed") exclusion = "cleanup_completed";
    const completedMs = Date.parse(run.completedAt || run.updatedAt || "");
    if (!exclusion && !Number.isFinite(completedMs)) exclusion = "missing_terminal_timestamp";
    const project = (state.projects || []).find((item) => item.id === run.projectId || item.key === run.projectKey);
    const protection = exclusion ? "" : workspacePathProtectionReason(run, { workspaceRoot: root, project, sourceRepoPaths });
    if (!exclusion && protection) exclusion = `protected_${protection}`;
    if (!exclusion && activeReferenceProtectsPath(activeReferences, run.workspacePath)) {
      exclusion = "active_workspace_reference";
    }
    if (exclusion) {
      incrementRetentionReason(report, exclusion, verifiedWorkspaceBytes(run, input));
      continue;
    }
    const ageHours = (nowMs - completedMs) / 3_600_000;
    const verifiedBytes = verifiedWorkspaceBytes(run, input);
    const retentionEligible = ageHours >= policy.retainForHours[run.status];
    const pressureAgeEligible = ageHours >= policy.pressureMinAgeHours;
    const pressureEligible = verifiedBytes !== null
      && (pressure || capacityPressure)
      && pressureAgeEligible;
    const pressureDiscoveryEligible = input.includeUnverifiedPressureCandidates === true
      && pressure
      && pressureAgeEligible;
    if (!retentionEligible && !pressureEligible && !pressureDiscoveryEligible) {
      incrementRetentionReason(
        report,
        (pressure || capacityPressure) && pressureAgeEligible && verifiedBytes === null
          ? "unverified_workspace_size"
          : "minimum_age_not_reached",
        verifiedBytes,
      );
      continue;
    }
    candidates.push({
      runId: run.id,
      projectId: run.projectId || "",
      workspacePath: run.workspacePath,
      workspaceStrategy: run.workspaceStrategy,
      status: run.status,
      completedAt: run.completedAt || run.updatedAt,
      ageHours,
      logicalBytes: verifiedBytes ?? 0,
      verified: verifiedBytes !== null,
      retentionEligible,
      pressureEligible,
      discoveryOnly: !retentionEligible && !pressureEligible,
      eligibilityReason: retentionEligible
        ? "status_retention"
        : pressure ? "disk_pressure" : "capacity_pressure",
    });
  }
  candidates.sort((a, b) => (
    a.completedAt.localeCompare(b.completedAt)
    || a.runId.localeCompare(b.runId)
  ));
  report.eligibleCount = candidates.length;
  report.excludedCount = report.consideredCount - report.eligibleCount;
  return { candidates, report, verifiedRetainedBytes, capacityPressure };
}

export function eligibleRunWorkspaceSnapshotsInState(state, input = {}) {
  const selection = retentionSelectionInState(state, input);
  return input.withSelectionReport === true ? selection : selection.candidates;
}

export async function eligibleRunWorkspaceSnapshots(input = {}) {
  return eligibleRunWorkspaceSnapshotsInState(await readStateReadOnly(), input);
}

export function claimRunWorkspaceCandidatesInState(state, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  const policy = normalizeWorkspaceRetention(input.policy || {});
  const requestedLeaseId = String(input.leaseId || "").trim();
  const leaseId = requestedLeaseId || randomUUID();
  if (!policy.enabled) {
    const selection = retentionSelectionInState(state, input);
    return { leaseId, expiresAt: "", candidates: [], selectionReport: selection.report };
  }
  const expiresAt = new Date(nowMs + policy.cleanupLeaseSeconds * 1000).toISOString();
  const selection = retentionSelectionInState(state, input);
  const snapshots = selection.candidates;
  const root = String(input.workspaceRoot || "");
  const activeReferences = activeRunWorkspaceReferences(state);
  const verifiedRetainedBytes = selection.verifiedRetainedBytes
    ?? verifiedRetainedWorkspaceBytesInState(state, input, root, activeReferences);
  const capacityPressure = selection.capacityPressure ?? verifiedRetainedBytes > policy.maxRetainedBytes;
  const maximumClaims = Math.min(
    policy.maxDeletesPerSweep,
    Number.isSafeInteger(Number(input.limit)) && Number(input.limit) > 0
      ? Number(input.limit)
      : policy.maxDeletesPerSweep,
  );
  const available = [];
  const claimExclusions = {};
  const claimExcludedVerifiedBytes = {};
  const claimExcludedUnknownSizes = {};
  const excludeClaim = (reason, item = null) => {
    claimExclusions[reason] = (claimExclusions[reason] || 0) + 1;
    if (item?.verified) {
      claimExcludedVerifiedBytes[reason] = (claimExcludedVerifiedBytes[reason] || 0) + item.logicalBytes;
    } else {
      claimExcludedUnknownSizes[reason] = (claimExcludedUnknownSizes[reason] || 0) + 1;
    }
  };
  for (const item of snapshots) {
    const run = (state.runs || []).find((candidate) => candidate.id === item.runId);
    const expiry = Date.parse(run?.workspaceCleanup?.leaseExpiresAt || "");
    if (!item.verified) excludeClaim("unverified_workspace_size", item);
    else if (run?.workspaceCleanup?.state === "claimed" && Number.isFinite(expiry) && expiry > nowMs) {
      excludeClaim("active_cleanup_lease", item);
    } else available.push(item);
  }
  let selected;
  if (input.pressure === true || !capacityPressure) {
    selected = available;
  } else {
    selected = available.filter((item) => item.retentionEligible);
    let remainingExcess = Math.max(
      0,
      verifiedRetainedBytes
        - policy.maxRetainedBytes
        - selected.reduce((total, item) => total + item.logicalBytes, 0),
    );
    for (const item of available) {
      if (remainingExcess <= 0 || selected.length >= maximumClaims) break;
      if (selected.includes(item) || !item.pressureEligible) continue;
      selected.push(item);
      remainingExcess = Math.max(0, remainingExcess - item.logicalBytes);
    }
  }
  const candidates = [];
  const selectedWithinLimit = selected.slice(0, maximumClaims);
  if (selected.length > selectedWithinLimit.length) {
    claimExclusions.sweep_limit = selected.length - selectedWithinLimit.length;
    claimExcludedVerifiedBytes.sweep_limit = selected.slice(selectedWithinLimit.length)
      .reduce((total, item) => total + item.logicalBytes, 0);
  }
  if (capacityPressure && input.pressure !== true) {
    const selectedIds = new Set(selected.map((item) => item.runId));
    for (const item of available) {
      if (!selectedIds.has(item.runId) && item.pressureEligible && !item.retentionEligible) {
        excludeClaim("capacity_target_satisfied", item);
      }
    }
  }
  for (const snapshot of selectedWithinLimit) {
    const run = (state.runs || []).find((item) => item.id === snapshot.runId);
    if (!run) continue;
    run.workspaceCleanup = { state: "claimed", leaseId, claimedAt: now, leaseExpiresAt: expiresAt };
    candidates.push(structuredClone(run));
  }
  state.meta = state.meta || {};
  state.meta.workspaceRetention = {
    ...(state.meta.workspaceRetention || {}),
    lastSweepAt: now,
    lastSweepLeaseId: leaseId,
    pressure: input.pressure === true,
    pressureIncident: input.pressure === true
      ? { at: now, reason: String(input.pressureReason || "disk_pressure").slice(0, 120) }
      : state.meta.workspaceRetention?.pressureIncident || null,
    candidateCount: candidates.length,
    verifiedRetainedBytes,
    maxRetainedBytes: policy.maxRetainedBytes,
  };
  const selectionReport = {
    ...selection.report,
    selectedCount: candidates.length,
    excludedCount: selection.report.excludedCount
      + Object.values(claimExclusions).reduce((total, count) => total + count, 0),
    excludedByReason: { ...selection.report.excludedByReason, ...claimExclusions },
    excludedVerifiedBytesByReason: {
      ...selection.report.excludedVerifiedBytesByReason,
      ...claimExcludedVerifiedBytes,
    },
    excludedUnknownSizeCountByReason: {
      ...selection.report.excludedUnknownSizeCountByReason,
      ...claimExcludedUnknownSizes,
    },
  };
  return { leaseId, expiresAt, candidates, selectionReport };
}

export async function claimRunWorkspaceCandidates(input = {}) {
  return mutateState(async (state) => claimRunWorkspaceCandidatesInState(state, input), {
    operationName: "workspace_cleanup.claim",
  });
}

export function finalizeRunWorkspaceCleanupInState(state, runId, input = {}) {
  const run = (state.runs || []).find((item) => item.id === runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const cleanup = run.workspaceCleanup || {};
  if (cleanup.state === "completed") return structuredClone(cleanup);
  if (cleanup.leaseId !== String(input.leaseId || "").trim()) return null;
  const leaseExpiresAt = Date.parse(cleanup.leaseExpiresAt || "");
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Number(input.nowMs ?? Date.now())) return null;
  const evidence = cleanupEvidence(run, input, input.success === false ? { error: input.error } : {});
  run.workspaceCleanup = { ...evidence, state: input.success === false ? "released" : "completed" };
  return structuredClone(run.workspaceCleanup);
}

export async function finalizeRunWorkspaceCleanup(runId, input = {}) {
  return mutateState(async (state) => finalizeRunWorkspaceCleanupInState(state, runId, input), {
    operationName: "workspace_cleanup.finalize",
  });
}

export function releaseRunWorkspaceCleanupInState(state, runId, input = {}) {
  const run = (state.runs || []).find((item) => item.id === runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const cleanup = run.workspaceCleanup || {};
  if (cleanup.state === "released") return structuredClone(cleanup);
  if (cleanup.state === "completed") return structuredClone(cleanup);
  if (cleanup.leaseId !== String(input.leaseId || "").trim()) return null;
  const evidence = cleanupEvidence(run, input, { error: input.error });
  run.workspaceCleanup = {
    ...evidence,
    state: "released",
    releasedAt: evidence.finalizedAt,
  };
  return structuredClone(run.workspaceCleanup);
}

export async function releaseRunWorkspaceCleanup(runId, input = {}) {
  return mutateState(async (state) => releaseRunWorkspaceCleanupInState(state, runId, input), {
    operationName: "workspace_cleanup.release",
  });
}

export async function ensureDataFile() {
  await ensureStateDatabase();
}

export async function readState() {
  return readDatabaseState();
}

export async function readStateReadOnly() {
  return readDatabaseStateReadOnly();
}

export async function writeState(state) {
  const now = new Date().toISOString();
  state.meta = state.meta || {};
  state.meta.updatedAt = now;
  state.meta.storageBackend = "sqlite";
  await writeDatabaseState(state);
}

export async function mutateState(mutator, options = {}) {
  // This public state-transform API is retry-safe by contract. Callers that
  // perform any non-repeatable work must opt out or use a fenced operation.
  return mutateDatabaseState(mutator, { idempotent: true, ...options });
}

function boundedRecoveryDiagnostic(value) {
  return String(value || "")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED]")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .trim()
    .slice(0, 2_000);
}

function normalizedGitHubRepository(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (!match) return null;
  return {
    owner: match[1].toLowerCase(),
    repository: match[2].replace(/\.git$/i, "").toLowerCase(),
  };
}

function recoveryProbeMatchesClaim(probe, claim) {
  const claimed = claim?.probe;
  if (!claimed) return false;
  return [
    "sourceRunId",
    "projectId",
    "owner",
    "repository",
    "role",
    "actionType",
    "branchName",
    "prUrl",
    "resumeStatus",
    "probeCount",
    "nextProbeAt",
  ].every((key) => probe[key] === claimed[key]);
}

function recoveryProjectMatchesClaim(state, claim) {
  const current = findProject(state, claim?.probe?.projectId);
  const claimed = claim?.project;
  return Boolean(
    current
    && claimed
    && String(current.repoPath || "").trim() === String(claimed.repoPath || "").trim(),
  );
}

function recoverySuppressionReason(state, task, input = {}) {
  if (state.meta?.operatorPause?.active && !input.ignoreOperatorPause) return "operator_pause";
  if (activeSelfUpdateLease(state, input)) return "self_update_in_progress";
  const project = findProject(state, task?.projectId);
  if (project?.automationCircuit?.state === "open") return "project_circuit_open";
  if (taskAutomationCircuitIsCurrent(task)) return "task_circuit_open";
  return "";
}

function recoveryResumeStatusIsValid(state, probe) {
  if (["start_builder", "unblock_task"].includes(probe.actionType)) {
    return probe.resumeStatus === "queued";
  }
  if (["start_builder_fix", "return_to_builder"].includes(probe.actionType)) {
    return probe.resumeStatus === "needs_changes";
  }
  if (probe.actionType === "qa_integration_blocked") {
    return probe.resumeStatus === "qa_review";
  }
  if (["start_review", "continue_review"].includes(probe.actionType)) {
    const project = findProject(state, probe.projectId);
    return reviewStagesForProject(project).some((stage) => (
      stage.role === probe.role
      && stage.status === probe.resumeStatus
    ));
  }
  return false;
}

function recoveryContextFailure(state, task, probe) {
  if (task.status !== "blocked") return "github_remote_recovery_task_status_changed";
  if (task.automationBlocker?.type !== "configuration") return "github_remote_recovery_blocker_changed";
  if (task.automationBlocker.reason !== "inaccessible_github_remote") {
    return "github_remote_recovery_reason_changed";
  }
  if (!probe || task.automationBlocker.recoveryProbe !== probe) {
    return "github_remote_recovery_probe_changed";
  }
  if (!recoveryResumeStatusIsValid(state, probe)) {
    return "github_remote_recovery_invalid_resume_status";
  }
  if (!probe.sourceRunId) return "github_remote_recovery_source_run_missing";
  if (!probe.projectId || !probe.owner || !probe.repository || !probe.role || !probe.actionType) {
    return "github_remote_recovery_context_missing";
  }
  if (!probe.branchName) return "github_remote_recovery_branch_missing";

  const sourceRun = (state.runs || []).find((run) => run.id === probe.sourceRunId);
  if (!sourceRun) return "github_remote_recovery_source_run_missing";
  if (
    sourceRun.status !== "cancelled"
    || sourceRun.exitCode !== "inaccessible_github_remote"
    || String(sourceRun.attemptKey || "") !== ""
    || sourceRun.taskId !== task.id
    || sourceRun.projectId !== probe.projectId
    || sourceRun.role !== probe.role
    || sourceRun.actionType !== probe.actionType
    || String(sourceRun.branchName || "") !== probe.branchName
    || String(sourceRun.prUrl || "") !== probe.prUrl
    || String(sourceRun.recoveryGitHubOwner || "") !== probe.owner
    || String(sourceRun.recoveryGitHubRepository || "") !== probe.repository
  ) {
    return "github_remote_recovery_source_context_changed";
  }
  const project = findProject(state, probe.projectId);
  if (!project || task.projectId !== probe.projectId) {
    return "github_remote_recovery_project_changed";
  }
  const configuredRepository = normalizedGitHubRepository(project.repoUrl);
  if (
    configuredRepository
    && (
      configuredRepository.owner !== probe.owner
      || configuredRepository.repository !== probe.repository
    )
  ) {
    return "github_remote_recovery_repository_changed";
  }
  if (
    String(task.branchName || "") !== probe.branchName
    || String(task.prUrl || "") !== probe.prUrl
  ) {
    return "github_remote_recovery_target_changed";
  }
  return "";
}

function makeRecoveryNonProbeable(state, task, probe, code, diagnostic, now) {
  const safeCode = String(code || "github_remote_recovery_context_changed");
  const safeDiagnostic = boundedRecoveryDiagnostic(diagnostic || safeCode);
  task.assignedAgentRole = "owner";
  task.retryNotBefore = "";
  task.automationBlocker = {
    ...task.automationBlocker,
    reason: safeCode,
    message: safeDiagnostic,
    remediation: "Repair the recorded GitHub repository, role, branch, or pull request target, then restore the task to its prior workflow state.",
    recoveryProbe: {
      ...probe,
      nextProbeAt: "",
      lastCode: safeCode,
      lastDiagnostic: safeDiagnostic,
      lease: null,
    },
  };
  task.updatedAt = now;
}

export function scheduleGitHubRemoteRecoveryProbeInState(state, run, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  const task = findTask(state, run.taskId);
  if (!task) return null;
  const branchName = String(input.branchName || run.branchName || "").trim();
  const prUrl = String(input.prUrl ?? run.prUrl ?? "").trim();
  const resumeStatus = String(input.resumeStatus || "").trim();
  const owner = String(input.owner || "").trim().toLowerCase();
  const repository = String(input.repository || "").trim().replace(/\.git$/i, "").toLowerCase();
  const diagnostic = boundedRecoveryDiagnostic(input.diagnostic || "The GitHub origin is not accessible.");
  if (!task.branchName && branchName) task.branchName = branchName;
  if (!task.prUrl && prUrl) task.prUrl = prUrl;
  run.branchName = branchName;
  run.prUrl = prUrl;
  run.recoveryGitHubOwner = owner;
  run.recoveryGitHubRepository = repository;

  const recoveryProbe = {
    sourceRunId: run.id,
    projectId: run.projectId,
    owner,
    repository,
    role: String(run.role || "").trim(),
    actionType: String(run.actionType || "").trim(),
    branchName,
    prUrl,
    resumeStatus,
    probeCount: 0,
    nextProbeAt: new Date(nowMs + GITHUB_REMOTE_RECOVERY_DELAYS_MS[0]).toISOString(),
    lastProbeAt: "",
    lastCode: "inaccessible_github_remote",
    lastDiagnostic: diagnostic,
    lease: null,
  };
  task.automationBlocker = {
    type: "configuration",
    reason: "inaccessible_github_remote",
    message: diagnostic,
    remediation: String(input.remediation || "").trim(),
    runId: run.id,
    resumeStatus,
    blockedAt: now,
    recoveryProbe,
  };
  task.updatedAt = now;

  const contextFailure = recoveryContextFailure(state, task, recoveryProbe);
  if (contextFailure) {
    makeRecoveryNonProbeable(state, task, recoveryProbe, contextFailure, diagnostic, now);
  }
  return task.automationBlocker.recoveryProbe;
}

export function claimDueGitHubRemoteRecoveryProbesInState(state, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  const leaseMs = Math.max(5_000, Number(input.leaseMs || 60_000));
  const limit = Math.min(2, Math.max(1, Number(input.limit || 2)));
  const claims = [];
  if (activeSelfUpdateLease(state, { ...input, nowMs })) return claims;

  for (const task of state.tasks || []) {
    if (claims.length >= limit) break;
    if (task.status !== "blocked") continue;
    const probe = task.automationBlocker?.recoveryProbe;
    if (
      task.automationBlocker?.type !== "configuration"
      || task.automationBlocker?.reason !== "inaccessible_github_remote"
      || !probe
    ) continue;
    if (recoverySuppressionReason(state, task, { ...input, nowMs })) continue;

    const dueAt = Date.parse(probe.nextProbeAt || "");
    if (!Number.isFinite(dueAt) || dueAt > nowMs) continue;
    const leaseExpiresAt = Date.parse(probe.lease?.expiresAt || "");
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) continue;

    const contextFailure = recoveryContextFailure(state, task, probe);
    if (contextFailure) {
      makeRecoveryNonProbeable(state, task, probe, contextFailure, contextFailure, now);
      continue;
    }

    const lease = {
      id: String(input.leaseIdFactory?.(task, probe) || randomUUID()),
      claimedAt: now,
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
    };
    probe.lease = lease;
    task.updatedAt = now;
    claims.push({
      taskId: task.id,
      leaseId: lease.id,
      probe: structuredClone(probe),
      sourceRun: structuredClone((state.runs || []).find((run) => run.id === probe.sourceRunId)),
      project: structuredClone(findProject(state, probe.projectId)),
    });
  }
  return claims;
}

export async function claimDueGitHubRemoteRecoveryProbes(input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => claimDueGitHubRemoteRecoveryProbesInState(state, input));
}

export function renewGitHubRemoteRecoveryProbeLeaseInState(state, claim, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const task = findTask(state, claim.taskId);
  const probe = task?.automationBlocker?.recoveryProbe;
  if (!probe || probe.lease?.id !== claim.leaseId) return false;
  if (!recoveryProbeMatchesClaim(probe, claim)) return false;
  if (!recoveryProjectMatchesClaim(state, claim)) return false;
  if (recoverySuppressionReason(state, task, { ...input, nowMs })) return false;
  const leaseExpiresAt = Date.parse(probe.lease.expiresAt || "");
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowMs) return false;
  probe.lease.expiresAt = new Date(nowMs + Math.max(5_000, Number(input.leaseMs || 60_000))).toISOString();
  task.updatedAt = input.now || new Date(nowMs).toISOString();
  return true;
}

export async function renewGitHubRemoteRecoveryProbeLease(claim, input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => renewGitHubRemoteRecoveryProbeLeaseInState(state, claim, input));
}

export function applyGitHubRemoteRecoveryProbeResultInState(state, claim, result, input = {}) {
  const nowMs = Number(input.nowMs ?? Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  const task = findTask(state, claim.taskId);
  const probe = task?.automationBlocker?.recoveryProbe;
  if (!task || !probe || probe.lease?.id !== claim.leaseId) {
    return { applied: false, reason: "probe_lease_mismatch" };
  }
  if (!recoveryProbeMatchesClaim(probe, claim)) {
    return { applied: false, reason: "probe_context_mismatch" };
  }
  if (!recoveryProjectMatchesClaim(state, claim)) {
    return { applied: false, reason: "probe_project_context_mismatch" };
  }
  const suppressionReason = recoverySuppressionReason(state, task, { ...input, nowMs });
  if (suppressionReason) {
    return { applied: false, reason: `probe_suppressed:${suppressionReason}` };
  }
  const leaseExpiresAt = Date.parse(probe.lease.expiresAt || "");
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowMs) {
    return { applied: false, reason: "probe_lease_expired" };
  }
  const contextFailure = recoveryContextFailure(state, task, probe);
  if (contextFailure) {
    makeRecoveryNonProbeable(state, task, probe, contextFailure, contextFailure, now);
    return { applied: true, status: "non_probeable", code: contextFailure };
  }

  const code = String(result?.code || (result?.ok ? "verified" : "github_remote_recovery_unverified"));
  const diagnostic = boundedRecoveryDiagnostic(result?.diagnostic || code);
  const probeCount = Math.max(0, Number(probe.probeCount || 0)) + 1;
  if (result?.ok) {
    const resumeStatus = probe.resumeStatus;
    task.assignedAgentRole = "";
    task.retryNotBefore = "";
    task.lastAutomationFailure = "";
    task.updatedAt = now;
    delete task.automationBlocker;
    applyStoreLifecycleTransition(state, task, resumeStatus, { action: "recover_workflow", now, nowMs });
    state.comments = state.comments || [];
    state.events = state.events || [];
    addAutomationComment(
      state,
      task,
      `Verified GitHub remote recovery for ${probe.owner}/${probe.repository} as ${probe.role}; restored ${resumeStatus} without launching a worker run.`,
      now,
      "StudioOps Runner",
    );
    state.events.push({
      id: nextId(state.events, "event"),
      type: "github_remote_recovery_verified",
      projectId: task.projectId,
      taskId: task.id,
      message: `${task.id} restored to ${resumeStatus} after exact GitHub remote verification`,
      createdAt: now,
    });
    return { applied: true, status: "recovered", resumeStatus };
  }

  if (result?.probeable === false) {
    makeRecoveryNonProbeable(state, task, {
      ...probe,
      probeCount,
      lastProbeAt: now,
    }, code, diagnostic, now);
    return { applied: true, status: "non_probeable", code };
  }

  const delayIndex = Math.min(probeCount, GITHUB_REMOTE_RECOVERY_DELAYS_MS.length - 1);
  const nextProbeAt = new Date(nowMs + GITHUB_REMOTE_RECOVERY_DELAYS_MS[delayIndex]).toISOString();
  task.assignedAgentRole = "owner";
  task.automationBlocker = {
    ...task.automationBlocker,
    message: diagnostic,
    recoveryProbe: {
      ...probe,
      probeCount,
      nextProbeAt,
      lastProbeAt: now,
      lastCode: code,
      lastDiagnostic: diagnostic,
      lease: null,
    },
  };
  task.updatedAt = now;
  return { applied: true, status: "waiting", code, probeCount, nextProbeAt };
}

export async function applyGitHubRemoteRecoveryProbeResult(claim, result, input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => applyGitHubRemoteRecoveryProbeResultInState(state, claim, result, input));
}

function nextId(items, prefix) {
  const max = items
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))];
  if (!value) return [];
  return [...new Set(String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function inferAttachmentType(value) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(String(value || "")) ? "image" : "reference";
}

function normalizeAttachments(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          const trimmed = item.trim();
          return {
            label: trimmed,
            url: trimmed,
            type: inferAttachmentType(trimmed),
            note: "",
          };
        }
        const url = String(item.url || item.path || "").trim();
        const label = String(item.label || url || "Attachment").trim();
        return {
          label,
          url,
          type: String(item.type || inferAttachmentType(url || label)).trim(),
          note: String(item.note || "").trim(),
        };
      })
      .filter((item) => item.label || item.url || item.note);
  }

  return normalizeList(value).map((item) => ({
    label: item,
    url: item,
    type: inferAttachmentType(item),
    note: "",
  }));
}

function renderAttachments(attachments) {
  return (attachments || []).length
    ? attachments
        .map((item) => {
          const label = item.label || item.url || "Attachment";
          const url = item.url && item.url !== label ? `: ${item.url}` : "";
          const note = item.note ? ` - ${item.note}` : "";
          return `- [${item.type || "reference"}] ${label}${url}${note}`;
        })
        .join("\n")
    : "- None recorded.";
}

function standardReference(item) {
  const value = String(item || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value) || /^[a-z]+:\/\//i.test(value)) return value;
  return path.join(process.cwd(), value);
}

export function normalizeReviewPipeline(value) {
  if (!Array.isArray(value)) return [];
  const stages = value
    .map((stage) => ({
      key: String(stage.key || "").trim(),
      label: String(stage.label || stage.key || "").trim(),
      role: String(stage.role || stage.key || "").trim(),
      status: String(stage.status || "").trim(),
      required: stage.required !== false,
      description: String(stage.description || "").trim(),
    }))
    .filter((stage) => stage.key && stage.role);
  if (!stages.length) return [];
  const leadIndex = stages.findIndex(isLeadReviewStage);
  if (leadIndex === -1) {
    stages.push({ ...DEFAULT_REVIEW_PIPELINE.find((stage) => stage.key === "lead") });
  } else {
    stages[leadIndex] = {
      ...stages[leadIndex],
      required: true,
    };
  }
  for (const stage of stages) {
    if (!stage.status || !VALID_STATUSES.has(stage.status)) {
      throw new Error(`Invalid review status for ${stage.key}: ${stage.status || "(missing)"}`);
    }
    if (stage.status === "qa_review") {
      throw new Error(
        `Review stage ${stage.key} cannot use qa_review; that status is reserved for human local QA. Use regression_review for automated regression review.`,
      );
    }
  }
  const duplicateStatus = stages.find((stage, index) => (
    stages.findIndex((candidate) => candidate.status === stage.status) !== index
  ));
  if (duplicateStatus) {
    throw new Error(`Review status must be unique within a pipeline: ${duplicateStatus.status}`);
  }
  return reviewStagesWithDefaultAccessibility(stages);
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

function normalizeDeliveryMode(value, fallback = "functional") {
  const mode = String(value || "").trim().toLowerCase();
  return VALID_DELIVERY_MODES.has(mode) ? mode : fallback;
}

export function normalizeDeliveryPolicy(value = {}) {
  const raw = typeof value === "string" ? value : value?.profile;
  const profile = VALID_DELIVERY_POLICY_PROFILES.has(String(raw || "").trim().toLowerCase())
    ? String(raw).trim().toLowerCase()
    : "standard";
  return {
    profile,
    // These are invariants, not caller-controlled switches.
    automaticMerge: false,
    automaticDeployment: false,
    architectureRequiredForBroadProducts: true,
    primaryLeadRequired: true,
    humanProductionReleaseRequired: true,
  };
}

function normalizedImpactEvidence(value = {}) {
  const files = Array.isArray(value.changedFiles || value.files)
    ? [...new Set((value.changedFiles || value.files).map((item) => String(item || "").trim()).filter(Boolean))].sort()
    : [];
  const explicitSource = Array.isArray(value.impact)
    ? value.impact
    : Array.isArray(value.classifications)
      ? value.classifications
      : [];
  const explicit = explicitSource.map((item) => String(item).trim().toLowerCase());
  const known = new Set(["backend", "frontend", "accessibility", "auth", "privacy", "data", "security", "migration", "infrastructure", "deployment", "design-system", "documentation", "configuration"]);
  const classifications = [...new Set(explicit.filter((item) => known.has(item)))].sort();
  const hasUnknownExplicitClassification = explicit.some((item) => !known.has(item));
  const pathCapabilities = files.map((file) => {
    const normalizedFile = file.replaceAll("\\", "/");
    const capabilities = new Set();
    if (
      /(^|\/)(readme|changelog|contributing|license)(\.[^/]*)?$/i.test(normalizedFile)
      || /(^|\/)docs\//i.test(normalizedFile)
      || /\.mdx?$/i.test(normalizedFile)
    ) {
      capabilities.add("documentation");
      return capabilities;
    }
    if (
      /(^|\/)(config|configuration|settings)\//i.test(normalizedFile)
      || /(^|\/)(studioops|mission-control)\.config\.[^/]+$/i.test(normalizedFile)
      || /(^|\/)(?!package(?:-lock)?\.json$|tsconfig(?:\.[^/]*)?\.json$|vite\.config\.[^/]+$|webpack\.config\.[^/]+$)[^/]+\.(json|ya?ml|toml|ini)$/i.test(normalizedFile)
    ) {
      capabilities.add("configuration");
      return capabilities;
    }
    if (
      /(^|\/)(public|frontend|client|web|ui|components?|pages?|views?|styles?|storybook|stories)(\/|$)/i.test(normalizedFile)
      || /\.(css|scss|sass|less|jsx|tsx|vue|svelte|html)$/i.test(normalizedFile)
      || /(^|\/)(playwright|e2e|browser|accessibility|a11y)([-_.\/]|$)/i.test(normalizedFile)
    ) {
      capabilities.add("frontend");
      capabilities.add("accessibility");
    }
    if (
      /(^|\/)(server|api|scripts?|bin|cli|workers?|jobs?|migrations?|db|database|auth|security|deploy|infra)(\/|\.|$)/i.test(normalizedFile)
      || (/(^|\/)src\//i.test(normalizedFile) && !capabilities.has("frontend"))
      || /(^|\/)tests?\/(?!.*(?:frontend|browser|e2e|playwright|accessibility|a11y|public|ui))[^/]+/i.test(normalizedFile)
    ) {
      capabilities.add("backend");
    }
    if (
      /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\.[^/]*)?\.json|vite\.config\.[^/]+|webpack\.config\.[^/]+)$/i.test(normalizedFile)
      || /(^|\/)\.github\/workflows\//i.test(normalizedFile)
      || /(^|\/)(scripts?|deploy|infra)\/[^/]*(?:release|promotion|candidate|workflow)[^/]*$/i.test(normalizedFile)
    ) {
      capabilities.add("backend");
      capabilities.add("frontend");
      capabilities.add("accessibility");
    }
    return capabilities;
  });
  const unknown = value.unknown === true
    || value.classified === false
    || value.stale === true
    || value.conflicting === true
    || Boolean(value.staleReason || value.conflictReason)
    || hasUnknownExplicitClassification
    || !files.length
    || pathCapabilities.some((capabilities) => capabilities.size === 0);
  const backendRequired = unknown || classifications.some((item) => ["backend", "auth", "privacy", "data", "security", "migration", "infrastructure", "deployment"].includes(item))
    || pathCapabilities.some((capabilities) => capabilities.has("backend"));
  const frontend = classifications.includes("frontend") || classifications.includes("design-system")
    || pathCapabilities.some((capabilities) => capabilities.has("frontend"));
  const accessibility = classifications.includes("accessibility") || frontend;
  return { changedFiles: files, classifications, unknown, backendRequired, frontend, accessibility };
}

export function normalizeCandidateIdentity(value = {}, fallback = {}) {
  const source = { ...fallback, ...value };
  const sha = (key) => String(source[key] || "").trim().toLowerCase();
  return {
    commitSha: sha("commitSha") || sha("subjectSha"),
    treeSha: sha("treeSha"),
    baseSha: sha("baseSha"),
    branch: String(source.branch || source.branchName || "").trim(),
    candidateCycle: Number(source.candidateCycle || source.reviewSubjectCycle || 0),
    impactEvidence: normalizedImpactEvidence(source.impactEvidence || source),
    operationalLocalArtifactRef: String(source.operationalLocalArtifactRef || source.localArtifactRef || "").trim(),
  };
}

export function candidateIdentityForTask(task = {}) {
  const stored = normalizeCandidateIdentity(task.candidateIdentity || {});
  return normalizeCandidateIdentity({
    ...stored,
    commitSha: task.reviewSubjectSha || stored.commitSha,
    branch: task.branchName || stored.branch,
    candidateCycle: currentReviewCandidateCycle(task) || stored.candidateCycle,
    impactEvidence: Object.prototype.hasOwnProperty.call(task, "impactEvidence")
      ? task.impactEvidence
      : stored.impactEvidence,
    operationalLocalArtifactRef: task.operationalLocalArtifactRef || stored.operationalLocalArtifactRef,
  });
}

export function candidateIdentityIsComplete(identity = {}) {
  return Boolean(
    /^[0-9a-f]{40,64}$/i.test(String(identity.commitSha || ""))
      && /^[0-9a-f]{40,64}$/i.test(String(identity.treeSha || ""))
      && /^[0-9a-f]{40,64}$/i.test(String(identity.baseSha || ""))
      && String(identity.branch || "").trim()
      && Number.isSafeInteger(Number(identity.candidateCycle))
      && Number(identity.candidateCycle) > 0
      && Array.isArray(identity.impactEvidence?.changedFiles)
      && identity.impactEvidence.changedFiles.length > 0
  );
}

function candidateMaterialMatches(left = {}, right = {}) {
  return ["treeSha", "baseSha", "branch", "impactEvidence", "operationalLocalArtifactRef"]
    .every((key) => isDeepStrictEqual(left[key], right[key]));
}

function capabilityForReviewStage(stage = {}) {
  const value = [stage.key, stage.role, stage.status, stage.label]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  if (value.includes("lead")) return "lead";
  if (value.includes("accessibility") || value.includes("a11y")) return "accessibility";
  if (value.includes("frontend") || value.includes("front-end") || value.includes("ui-review")) return "frontend";
  if (value.includes("backend") || value.includes("back-end") || value.includes("api-review")) return "backend";
  return "";
}

export function capabilityRoutingForTask(project = {}, task = {}) {
  const policy = normalizeDeliveryPolicy(project.deliveryPolicy);
  const evidence = normalizedImpactEvidence(task.impactEvidence || task);
  const required = new Set(["lead"]);
  if (evidence.backendRequired) required.add("backend");
  if (evidence.unknown || evidence.frontend) required.add("frontend");
  if (evidence.unknown || evidence.accessibility) required.add("accessibility");
  const skipped = CAPABILITY_KEYS.filter((key) => !required.has(key)).map((key) => ({
    stageKey: key, outcome: "skipped", reason: "inapplicable_capability", subjectSha: task.reviewSubjectSha || "", candidateCycle: currentReviewCandidateCycle(task),
  }));
  return { policy, evidence, required: CAPABILITY_KEYS.filter((key) => required.has(key)), skipped };
}

function architectureText(input = {}) {
  return [
    input.title,
    input.description,
    input.userStory || input.story,
    input.expectedOutcome || input.expected,
    input.type,
    input.area,
  ].filter(Boolean).join(" ");
}

export function taskRequiresArchitecture(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "architectureRequired")) {
    return normalizeBoolean(input.architectureRequired, false);
  }
  if (normalizeBoolean(input.architectureApproved, false)) return true;
  if (String(input.type || "").trim().toLowerCase() === "epic") return true;
  return ARCHITECTURE_TASK_PATTERN.test(architectureText(input));
}

function architectureIsComplete(task = {}) {
  return ["completed", "inherited", "not_required"].includes(task.architectureStatus);
}

export function architectureIsCompleteInState(state, task = {}) {
  if (["completed", "not_required"].includes(task.architectureStatus)) return true;
  if (task.architectureStatus !== "inherited") return false;
  const parent = findTask(state, task.architectureParentTaskId);
  if (
    !parent
    || parent.projectId !== task.projectId
    || parent.architectureStatus !== "completed"
    || task.parentTaskId !== parent.id
    || !(parent.architectureDecisionTaskIds || []).includes(task.id)
  ) return false;
  return completedArchitectureGraphIsValid(state, parent);
}

function statusWithArchitectureGate(input, requestedStatus) {
  const status = requestedStatus || "idea";
  if (!["ready", "queued"].includes(status)) return status;
  if (!taskRequiresArchitecture(input)) return status;
  return architectureIsComplete(input) ? status : "architecture_pending";
}

function normalizeReviewPolicy(value = {}) {
  const maxCycles = Number(value.maxBuilderReviewCycles ?? value.maxReviewCycles ?? DEFAULT_REVIEW_POLICY.maxBuilderReviewCycles);
  return {
    maxBuilderReviewCycles: Number.isFinite(maxCycles) ? Math.max(1, Math.floor(maxCycles)) : DEFAULT_REVIEW_POLICY.maxBuilderReviewCycles,
    reviewerMayFixSmallIssues: normalizeBoolean(value.reviewerMayFixSmallIssues, DEFAULT_REVIEW_POLICY.reviewerMayFixSmallIssues),
    leadOwnsFinalDecisionAtLimit: normalizeBoolean(value.leadOwnsFinalDecisionAtLimit, DEFAULT_REVIEW_POLICY.leadOwnsFinalDecisionAtLimit),
    trustLeadApprovals: normalizeBoolean(value.trustLeadApprovals ?? value.trustLeads, DEFAULT_REVIEW_POLICY.trustLeadApprovals),
    qaReviewerRole: String(value.qaReviewerRole || DEFAULT_REVIEW_POLICY.qaReviewerRole).trim(),
    integrationBranch: String(value.integrationBranch || value.reviewBranch || "").trim(),
  };
}

function reviewPolicyInputForProject(input = {}) {
  const reviewPolicy = { ...(input.reviewPolicy || {}) };
  if (
    !Object.prototype.hasOwnProperty.call(reviewPolicy, "trustLeadApprovals")
    && !Object.prototype.hasOwnProperty.call(reviewPolicy, "trustLeads")
    && Object.prototype.hasOwnProperty.call(input, "trustLeadApprovals")
  ) {
    reviewPolicy.trustLeadApprovals = input.trustLeadApprovals;
  }
  if (
    !Object.prototype.hasOwnProperty.call(reviewPolicy, "integrationBranch")
    && !Object.prototype.hasOwnProperty.call(reviewPolicy, "reviewBranch")
    && Object.prototype.hasOwnProperty.call(input, "integrationBranch")
  ) {
    reviewPolicy.integrationBranch = input.integrationBranch;
  }
  return reviewPolicy;
}

export async function addProject(input) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    const key = String(input.key || "").trim();
    if (!key) throw new Error("Project key is required.");
    if (state.projects.some((project) => project.key === key)) {
      throw new Error(`Project key already exists: ${key}`);
    }
    const reviewPolicy = normalizeReviewPolicy(reviewPolicyInputForProject(input));
    const deliveryPolicy = normalizeDeliveryPolicy(input.deliveryPolicy);
    const project = {
      id: nextId(state.projects, "project"),
      key,
      name: String(input.name || key).trim(),
      description: String(input.description || "").trim(),
      repoPath: String(input.repoPath || "").trim(),
      repoUrl: String(input.repoUrl || "").trim(),
      workflowMode: normalizeProjectWorkflowMode(input.workflowMode || "auto"),
      defaultBranch: String(input.defaultBranch || "main").trim(),
      validationCommands: normalizeList(input.validationCommands),
      contextLinks: normalizeList(input.contextLinks),
      standards: withDefaultProjectStandards(normalizeList(input.standards)),
      safetyRules: normalizeList(input.safetyRules),
      reviewPipeline: normalizeReviewPipeline(input.reviewPipeline),
      qaIntegration: input.qaIntegration || {},
      localQaPreview: input.localQaPreview || input.qaIntegration?.localPreview || null,
      promotion: input.promotion || {},
      reviewPolicy,
      wipPolicy: {
        maxActiveTasks: Number(input.wipPolicy?.maxActiveTasks || input.maxActiveTasks || 0),
        weights: input.wipPolicy?.weights || {},
        agePromotionMs: Number(input.wipPolicy?.agePromotionMs || 24 * 60 * 60 * 1000),
      },
      deliveryPolicy,
      trustLeadApprovals: reviewPolicy.trustLeadApprovals,
      integrationBranch: reviewPolicy.integrationBranch,
      createdAt: now,
      updatedAt: now,
    };
    state.projects.push(project);
    state.events.push({
      id: nextId(state.events, "event"),
      type: "project_created",
      projectId: project.id,
      message: `Project created: ${project.name}`,
      createdAt: now,
    });
    return project;
  }, { operationName: "project.add" });
}

export async function updateProject(projectId, patch = {}) {
  return mutateState(async (state) => {
    const project = findProject(state, projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const now = new Date().toISOString();
    const allowed = [
      "name",
      "description",
      "repoPath",
      "repoUrl",
      "defaultBranch",
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        project[key] = String(patch[key] || "").trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "workflowMode")) {
      project.workflowMode = normalizeProjectWorkflowMode(patch.workflowMode || "auto");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "validationCommands")) {
      project.validationCommands = normalizeList(patch.validationCommands);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "contextLinks")) {
      project.contextLinks = normalizeList(patch.contextLinks);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "standards")) {
      project.standards = withDefaultProjectStandards(normalizeList(patch.standards));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "safetyRules")) {
      project.safetyRules = normalizeList(patch.safetyRules);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "reviewPipeline")) {
      project.reviewPipeline = normalizeReviewPipeline(patch.reviewPipeline);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "qaIntegration")) {
      project.qaIntegration = {
        ...(project.qaIntegration || {}),
        ...(patch.qaIntegration || {}),
      };
      project.localQaPreview = project.qaIntegration.localPreview || project.localQaPreview || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "localQaPreview")) {
      project.localQaPreview = patch.localQaPreview || null;
      project.qaIntegration = {
        ...(project.qaIntegration || {}),
        localPreview: project.localQaPreview,
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "promotion")) {
      project.promotion = {
        ...(project.promotion || {}),
        ...(patch.promotion || {}),
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "reviewPolicy")) {
      project.reviewPolicy = normalizeReviewPolicy({
        ...(project.reviewPolicy || {}),
        ...(patch.reviewPolicy || {}),
      });
      project.trustLeadApprovals = project.reviewPolicy.trustLeadApprovals;
      project.integrationBranch = project.reviewPolicy.integrationBranch;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "wipPolicy")) {
      project.wipPolicy = {
        ...(project.wipPolicy || {}),
        ...(patch.wipPolicy || {}),
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "deliveryPolicy")) {
      project.deliveryPolicy = normalizeDeliveryPolicy(patch.deliveryPolicy);
    }
    project.updatedAt = now;
    state.events.push({
      id: nextId(state.events, "event"),
      type: "project_updated",
      projectId: project.id,
      message: `Project updated: ${project.name}`,
      createdAt: now,
    });
    return project;
  }, { operationName: "project.update" });
}

export function adoptDefaultProjectStandardsInState(state, projectId, input = {}) {
  const project = findProject(state, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const previous = normalizeList(project.standards);
  const standards = withDefaultProjectStandards(previous);
  const added = standards.filter((standard) => !previous.includes(standard));
  if (!added.length) return { project, standards, added, changed: false };

  const now = input.now || new Date().toISOString();
  project.standards = standards;
  project.updatedAt = now;
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "project_default_standards_adopted",
    projectId: project.id,
    message: `Required StudioOps standards adopted: ${added.join(", ")}`,
    createdAt: now,
  });
  return { project, standards, added, changed: true };
}

export async function adoptDefaultProjectStandards(projectId, input = {}) {
  return mutateState(async (state) => adoptDefaultProjectStandardsInState(state, projectId, input), {
    operationName: "project.adopt_standards",
  });
}

function governedArchitectureParent(state, project, parentTaskId, architectureParentTaskId) {
  const governedParentId = architectureParentTaskId || parentTaskId;
  if (!parentTaskId || !governedParentId) {
    throw new Error("Architecture-approved child tasks require a parent task.");
  }
  if (parentTaskId !== governedParentId) {
    throw new Error("Architecture parent must match the child task's parent.");
  }
  const parent = findTask(state, governedParentId);
  if (!parent) throw new Error(`Unknown architecture parent task: ${governedParentId}`);
  if (parent.projectId !== project.id) {
    throw new Error(`Architecture parent ${governedParentId} belongs to another project.`);
  }
  if (!parent.architectureRequired && !taskRequiresArchitecture(parent)) {
    throw new Error(`Architecture parent ${governedParentId} does not require systems architecture.`);
  }
  return parent;
}

export async function addTask(input) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    const project = findProject(state, input.project || input.projectId);
    if (!project) throw new Error(`Unknown project: ${input.project || input.projectId}`);
    const title = String(input.title || "").trim();
    if (!title) throw new Error("Task title is required.");
    const parentTaskId = String(input.parentTaskId || input.parent || input.epic || "").trim();
    const dependsOnTaskIds = normalizeList(input.dependsOnTaskIds || input.dependsOn || input.dependencies);
    validateTaskRelationships(state, "", parentTaskId, dependsOnTaskIds);
    const architectureApproved = normalizeBoolean(input.architectureApproved, false);
    const requestedArchitectureParentTaskId = String(input.architectureParentTaskId || "").trim();
    const architectureParentTaskId = architectureApproved
      ? governedArchitectureParent(
        state,
        project,
        parentTaskId,
        requestedArchitectureParentTaskId,
      ).id
      : "";
    if (requestedArchitectureParentTaskId && !architectureApproved) {
      throw new Error("Architecture parent requires architectureApproved so the child remains gated until completion.");
    }
    const architectureRequired = architectureApproved || taskRequiresArchitecture(input);
    const architectureStatus = architectureRequired ? "pending" : "not_required";
    const status = statusWithArchitectureGate(
      { ...input, architectureRequired, architectureStatus },
      input.status || "idea",
    );
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const task = {
      id: nextId(state.tasks, "task"),
      projectId: project.id,
      title,
      description: String(input.description || "").trim(),
      status,
      priority: String(input.priority || "medium").trim(),
      type: String(input.type || "feature").trim(),
      area: String(input.area || "").trim(),
      lane: String(input.lane || "").trim(),
      labels: normalizeList(input.labels || input.label),
      workAreas: normalizeList(input.workAreas || input.workArea || input["work-area"]),
      parentTaskId,
      dependsOnTaskIds,
      userStory: String(input.userStory || input.story || "").trim(),
      expectedOutcome: String(input.expectedOutcome || input.expected || "").trim(),
      affectedSurfaces: normalizeList(input.affectedSurfaces || input.surfaces),
      validationPlan: normalizeList(input.validationPlan || input.validation),
      riskClassification: String(input.riskClassification || input.risk || "").trim(),
      architectureDecision: String(input.architectureDecision || "").trim(),
      architectureWaiver: input.architectureWaiver || "",
      reasoningEffort: String(input.reasoningEffort || "").trim().toLowerCase(),
      tokenBudget: Number(input.tokenBudget || 0),
      costBudget: Number(input.costBudget || 0),
      mergeEvidence: input.mergeEvidence || null,
      releaseEvidence: input.releaseEvidence || null,
      deploymentEvidence: input.deploymentEvidence || null,
      verificationEvidence: input.verificationEvidence || null,
      attachments: normalizeAttachments(input.attachments || input.attachment),
      acceptanceCriteria: normalizeList(input.acceptanceCriteria),
      deliveryMode: normalizeDeliveryMode(input.deliveryMode),
      architectureRequired,
      architectureStatus,
      architectureParentTaskId,
      architectureSummary: "",
      architectureDecisionTaskIds: [],
      architectureCompletedAt: "",
      architectureCompletedBy: "",
      readinessEnforced: true,
      privacyNotes: String(input.privacyNotes || "").trim(),
      securityNotes: String(input.securityNotes || "").trim(),
      branchName: String(input.branchName || "").trim(),
      prUrl: String(input.prUrl || "").trim(),
      assignedAgentRole: String(input.assignedAgentRole || "").trim(),
      assignedThreadId: String(input.assignedThreadId || "").trim(),
      reviewerThreadId: String(input.reviewerThreadId || "").trim(),
      reviewerThreadIds: input.reviewerThreadIds && typeof input.reviewerThreadIds === "object"
        ? { ...input.reviewerThreadIds }
        : {},
      reviewCycle: 0,
      reviewSubjectSha: "",
      reviewSubjectCycle: 0,
      stateVersion: 1,
      impactEvidence: normalizedImpactEvidence(input.impactEvidence || input),
      candidateIdentity: normalizeCandidateIdentity(input.candidateIdentity || {}, {
        branch: input.branchName,
        impactEvidence: input.impactEvidence || input,
      }),
      operationalLocalArtifactRef: String(input.operationalLocalArtifactRef || input.localArtifactRef || "").trim(),
      createdAt: now,
      updatedAt: now,
    };
    if (["ready", "queued"].includes(task.status)) {
      const readiness = evaluateTaskReadiness(task, state);
      if (!readiness.ready) {
        throw new Error(`Task is not ready for dispatch. Missing: ${readiness.missing.join(", ") || readiness.dependencyErrors.join("; ")}.`);
      }
    }
    state.tasks.push(task);
    state.events.push({
      id: nextId(state.events, "event"),
      type: "task_created",
      projectId: project.id,
      taskId: task.id,
      message: `Task created: ${task.title}`,
      createdAt: now,
    });
    return task;
  }, { operationName: "task.add" });
}

function lifecycleInvalidationIds(state, task, decision) {
  if (!decision.invalidates.length) return [];
  const ids = [];
  const invalidatedAt = decision.occurredAt;
  if (decision.invalidates.includes("reviews")) {
    for (const review of state.reviews || []) {
      if (review.taskId !== task.id || review.invalidatedAt) continue;
      review.invalidatedAt = invalidatedAt;
      review.invalidation = {
        action: decision.action,
        reasonCode: decision.override?.reasonCode || decision.action,
        invalidatedAt,
      };
      ids.push(review.id);
    }
  }
  if (decision.invalidates.includes("candidate")) {
    for (const candidate of state.candidates || []) {
      if (candidate.invalidation || !(candidate.manifest?.sources || []).some((source) => source.taskId === task.id)) continue;
      invalidateCandidate(candidate, {
        reason: `Lifecycle ${decision.action} invalidated candidate evidence for task ${task.id}.`,
        expected: candidate.manifestDigest,
        observed: decision.override?.reasonCode || decision.action,
        invalidatedAt,
      });
      ids.push(candidate.id);
      const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
      if (bundle) {
        bundle.status = "invalidated";
        bundle.updatedAt = invalidatedAt;
        ids.push(bundle.id);
      }
    }
  }
  if (decision.invalidates.length) {
    task.evidenceInvalidations = Array.isArray(task.evidenceInvalidations) ? task.evidenceInvalidations : [];
    task.evidenceInvalidations.push({
      action: decision.action,
      reasonCode: decision.override?.reasonCode || decision.action,
      reason: decision.override?.reason || "Lifecycle policy invalidation.",
      risk: decision.override?.risk || "Existing evidence is incompatible with the new lifecycle state.",
      invalidationIds: [...new Set(ids)],
      invalidatedAt,
    });
    task.candidateId = "";
    task.qaBundleId = "";
    task.qaDecision = null;
    task.integrationStatus = "";
    task.promotionStatus = "";
    task.promotionEvidence = null;
  }
  return [...new Set(ids)];
}

function appendLifecycleAuditEvent(state, task, decision, invalidationIds) {
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "lifecycle_transition",
    projectId: task.projectId,
    taskId: task.id,
    action: decision.action,
    fromStatus: decision.from,
    toStatus: decision.to,
    fromVersion: decision.fromVersion,
    toVersion: decision.toVersion,
    actor: {
      id: decision.actor.actorId,
      type: decision.actor.actorType,
      role: decision.actor.role,
    },
    runId: decision.actor.runId,
    leaseId: decision.actor.leaseId,
    evidence: decision.evidence,
    outcome: "applied",
    invalidationIds,
    reasonCode: decision.override?.reasonCode || "",
    reason: decision.override?.reason || "",
    risk: decision.override?.risk || "",
    message: `${task.title}: ${decision.action} moved ${decision.from} to ${decision.to} at stateVersion ${decision.toVersion}`,
    createdAt: decision.occurredAt,
  });
}

export function applyLifecycleTransitionInState(state, command, input = {}) {
  const task = findTask(state, command?.taskId);
  if (!task) throw new Error(`Unknown task: ${command?.taskId || "(missing)"}`);
  const project = findProject(state, task.projectId);
  const completionEvidence = command.action === "finish_task"
    ? completionEvidenceForTask(state, task)
    : null;
  const result = evaluateLifecycleTransition(command, task, {
    runs: state.runs || [],
    candidates: state.candidates || [],
    reviews: state.reviews || [],
    reviewStages: project ? reviewStagesForTask(project, task) : [],
    completionEvidence,
    allowCycleLimitLeadReview: Boolean(
      project
      && reviewPolicyForProject(project).leadOwnsFinalDecisionAtLimit
      && currentReviewCycle(task) >= reviewPolicyForProject(project).maxBuilderReviewCycles
    ),
    now: input.now,
    nowMs: input.nowMs,
  });
  Object.assign(task, result.task);
  const invalidationIds = lifecycleInvalidationIds(state, task, result.decision);
  appendLifecycleAuditEvent(state, task, result.decision, invalidationIds);
  return { task, decision: { ...result.decision, invalidationIds } };
}

function lifecycleEvidenceForTask(state, task, targetStatus, evidence = {}) {
  const candidate = (state.candidates || []).find((item) => item.id === (evidence.candidateId || task.candidateId));
  const candidateSource = candidate?.manifest?.sources?.find((source) => source.taskId === task.id);
  return {
    targetStatus,
    candidateCycle: Number(evidence.candidateCycle || currentReviewCandidateCycle(task) || candidateSource?.candidateCycle || 0),
    subjectSha: String(evidence.subjectSha || task.reviewSubjectSha || candidateSource?.headSha || "").trim().toLowerCase(),
    candidateId: String(evidence.candidateId || task.candidateId || "").trim(),
    manifestDigest: String(evidence.manifestDigest || candidate?.manifestDigest || "").trim(),
    ...evidence,
  };
}

function defaultLifecycleAction(task, targetStatus) {
  if (targetStatus === task.status) return "mutate_evidence";
  if (targetStatus === "architecture_pending") return "require_architecture";
  if (targetStatus === "architecture_ready") return "record_architecture_completion";
  if (targetStatus === "builder_review") return "record_builder_handoff";
  if (["backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review"].includes(targetStatus)) return "route_review";
  if (targetStatus === "needs_changes") return task.status === "builder_review" && !task.reviewSubjectSha
    ? "reject_builder_intake"
    : "request_changes";
  if (targetStatus === "user_review") return "request_owner_review";
  if (targetStatus === "qa_review") return "request_qa_review";
  if (targetStatus === "blocked") return "block_workflow";
  if (targetStatus === "queued") {
    if (task.status === "blocked") return "resume_workflow";
    if (task.status === "in_progress") return "recover_workflow";
    return "queue_task";
  }
  return "owner_override";
}

function actorForLifecycleAction(action) {
  if (action === "record_architecture_completion") return { actorId: "architecture-store-adapter", actorType: "system", role: "architecture-recorder", trusted: true };
  if (action === "recover_workflow") return { actorId: "resilience-store-adapter", actorType: "system", role: "resilience-engine", trusted: true };
  if (action === "owner_override") return { actorId: "local-owner-store-adapter", actorType: "owner", role: "owner", trusted: true };
  return { actorId: "workflow-store-adapter", actorType: "system", role: "workflow-engine", trusted: true };
}

function applyStoreLifecycleTransition(state, task, targetStatus, input = {}) {
  if (targetStatus === task.status && input.force !== true) return null;
  const action = input.action || defaultLifecycleAction(task, targetStatus);
  const evidence = lifecycleEvidenceForTask(state, task, targetStatus, input.evidence);
  if (action === "finish_task" || targetStatus === "done") {
    const completion = completionEvidenceForTask(state, task);
    if (!completion.complete && input.allowIncompleteDone !== true) {
      throw new Error(`Task is not done from objective evidence. Missing: ${[...completion.missing, ...completion.missingReviews].join(", ")}.`);
    }
    evidence.completionEvidence = completion;
  }
  if (action === "owner_override") {
    evidence.reasonCode = evidence.reasonCode || "local_adapter_transition";
    evidence.reason = evidence.reason || `The local compatibility adapter requested ${task.status} to ${targetStatus}.`;
    evidence.risk = evidence.risk || "The caller remains subject to the control-plane authentication migration.";
  }
  return applyLifecycleTransitionInState(state, {
    action,
    taskId: task.id,
    expectedStateVersion: positiveStateVersion(task.stateVersion),
    actorContext: input.actorContext || actorForLifecycleAction(action),
    evidence,
  }, { now: input.now, nowMs: input.nowMs });
}

export async function transitionTask(command, input = {}) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Lifecycle transition command envelope is required.");
  }
  const allowed = ["action", "taskId", "expectedStateVersion", "actorContext", "evidence"];
  const unknown = Object.keys(command).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown lifecycle command fields: ${unknown.join(", ")}`);
  return mutateState(async (state) => applyLifecycleTransitionInState(state, command, input), {
    operationName: `task.transition.${command.action || "unknown"}`,
  });
}

export async function repairLegacyTaskStatus(taskId, status, input = {}) {
  const targetStatus = String(status || "").trim();
  if (!VALID_STATUSES.has(targetStatus)) throw new Error(`Invalid repair status: ${status || "(missing)"}`);
  return mutateState(async (state) => {
    const task = findTask(state, taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const priorStatus = typeof task.status === "string" ? task.status.trim() : "";
    if (task.status === priorStatus && VALID_STATUSES.has(priorStatus)) {
      throw new Error("Legacy repair is only available for a task with an invalid persisted status.");
    }
    task.status = "legacy_untrusted";
    const result = applyLifecycleTransitionInState(state, {
      action: "legacy_repair",
      taskId,
      expectedStateVersion: positiveStateVersion(task.stateVersion),
      actorContext: {
        actorId: String(input.actorId || "state-integrity-migration").trim(),
        actorType: "migration",
        role: "integrity-repair",
        trusted: true,
      },
      evidence: { targetStatus },
    }, input);
    state.events.push({
      id: nextId(state.events, "event"),
      type: "workflow_integrity_repaired",
      projectId: task.projectId,
      taskId: task.id,
      message: `Task workflow status repaired from ${priorStatus || "(missing)"} to ${targetStatus}; historical evidence was preserved.`,
      createdAt: result.decision.occurredAt,
    });
    return result.task;
  }, { repairTaskId: taskId, operationName: "task.repair_legacy_status" });
}

export async function updateTask(taskId, patch) {
  const ownsValidStatus = Object.prototype.hasOwnProperty.call(patch, "status")
    && typeof patch.status === "string"
    && patch.status.trim()
    && VALID_STATUSES.has(patch.status.trim());
  return mutateState(async (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const project = findProject(state, task.projectId);
    if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
    const aggregateBeforePatch = structuredClone(task);
    const candidateIdentityBeforePatch = candidateIdentityForTask(task);
    const previousReviewSubjectSha = String(task.reviewSubjectSha || "");
    const previousNormalizedStatus = typeof task.status === "string" ? task.status.trim() : "";
    const repairingLegacyStatus = ownsValidStatus && !VALID_STATUSES.has(previousNormalizedStatus);
    if (repairingLegacyStatus) {
      throw new Error("Invalid legacy status can only be changed by repairLegacyTaskStatus.");
    }
    let requestedStatus = task.status;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      const normalizedStatus = typeof patch.status === "string" ? patch.status.trim() : "";
      if (!normalizedStatus || !VALID_STATUSES.has(normalizedStatus)) {
        throw new Error(`Invalid status: ${patch.status ?? "(missing)"}`);
      }
      patch = { ...patch, status: normalizedStatus };
      requestedStatus = normalizedStatus;
      if (["ready", "queued"].includes(normalizedStatus) && task.readinessEnforced === true) {
        const readiness = evaluateTaskReadiness({ ...task, ...patch }, state);
        if (!readiness.ready) {
          throw new Error(`Task is not ready for dispatch. Missing: ${readiness.missing.join(", ") || readiness.dependencyErrors.join("; ")}.`);
        }
      }
    }
    const architectureCompletionFields = [
      "architectureStatus",
      "architectureSummary",
      "architectureDecisionTaskIds",
      "architectureCompletedAt",
      "architectureCompletedBy",
    ];
    if (architectureCompletionFields.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
      throw new Error("Architecture completion fields can only be written by completeArchitecture.");
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "architectureParentTaskId")
      && !normalizeBoolean(patch.architectureApproved, false)
    ) {
      throw new Error("Architecture parent requires architectureApproved so the child remains gated until completion.");
    }
    const previousStatus = task.status;
    const allowed = [
      "title",
      "description",
      "priority",
      "type",
      "area",
      "lane",
      "parentTaskId",
      "userStory",
      "expectedOutcome",
      "affectedSurfaces",
      "validationPlan",
      "riskClassification",
      "architectureDecision",
      "architectureWaiver",
      "reasoningEffort",
      "tokenBudget",
      "costBudget",
      "mergeEvidence",
      "releaseEvidence",
      "deploymentEvidence",
      "verificationEvidence",
      "deliveryMode",
      "privacyNotes",
      "securityNotes",
      "branchName",
      "prUrl",
      "assignedAgentRole",
      "assignedThreadId",
      "reviewerThreadId",
      "operationalLocalArtifactRef",
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        task[key] = key === "deliveryMode"
          ? normalizeDeliveryMode(patch[key])
          : ["tokenBudget", "costBudget"].includes(key)
            ? Number(patch[key] || 0)
            : ["affectedSurfaces", "validationPlan"].includes(key)
              ? normalizeList(patch[key])
              : ["mergeEvidence", "releaseEvidence", "deploymentEvidence", "verificationEvidence"].includes(key)
                ? (patch[key] || null)
                : String(patch[key] || "").trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "impactEvidence")) {
      task.impactEvidence = normalizedImpactEvidence(patch.impactEvidence || {});
      task.candidateIdentity = normalizeCandidateIdentity({
        ...(task.candidateIdentity || {}),
        impactEvidence: task.impactEvidence,
      });
    }
    if (Object.prototype.hasOwnProperty.call(patch, "candidateIdentity")) {
      task.candidateIdentity = normalizeCandidateIdentity(patch.candidateIdentity, task.candidateIdentity || {});
      if (
        !Object.prototype.hasOwnProperty.call(patch, "impactEvidence")
        && Object.prototype.hasOwnProperty.call(patch.candidateIdentity || {}, "impactEvidence")
      ) {
        task.impactEvidence = task.candidateIdentity.impactEvidence;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "architectureRequired")) {
      task.architectureRequired = normalizeBoolean(patch.architectureRequired, false);
      if (!task.architectureRequired) {
        task.architectureStatus = "not_required";
        task.architectureParentTaskId = "";
      } else if (!architectureIsCompleteInState(state, task)) {
        task.architectureStatus = "pending";
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "architectureApproved")) {
      if (normalizeBoolean(patch.architectureApproved, false)) {
        const requestedParentId = String(patch.architectureParentTaskId || "").trim();
        task.architectureParentTaskId = governedArchitectureParent(
          state,
          project,
          task.parentTaskId,
          requestedParentId,
        ).id;
        task.architectureRequired = true;
        task.architectureStatus = "pending";
      } else {
        task.architectureParentTaskId = "";
        task.architectureStatus = task.architectureRequired ? "pending" : "not_required";
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "acceptanceCriteria")) {
      task.acceptanceCriteria = normalizeList(patch.acceptanceCriteria);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "labels")) {
      task.labels = normalizeList(patch.labels);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "dependsOnTaskIds")) {
      task.dependsOnTaskIds = normalizeList(patch.dependsOnTaskIds);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "workAreas")) {
      task.workAreas = normalizeList(patch.workAreas);
    }
    validateTaskRelationships(state, task.id, task.parentTaskId, task.dependsOnTaskIds || []);
    if (Object.prototype.hasOwnProperty.call(patch, "attachments")) {
      task.attachments = normalizeAttachments(patch.attachments);
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "status")
      && ["ready", "queued"].includes(requestedStatus)
      && task.architectureRequired
      && !architectureIsCompleteInState(state, task)
    ) {
      requestedStatus = "architecture_pending";
    }
    if (
      normalizeBoolean(patch.architectureApproved, false)
      && ["ready", "queued"].includes(requestedStatus)
    ) {
      requestedStatus = "architecture_pending";
    }
    // A status repair restores an invalid legacy record to the workflow; it must
    // not be treated as a new builder submission, which would discard the
    // review subject and cycle that make existing approvals auditable.
    const patchedSubjectSha = Object.prototype.hasOwnProperty.call(patch, "subjectSha")
      ? normalizeGitSha(patch.subjectSha, "review subject SHA")
      : task.reviewSubjectSha;
    const candidateIdentityAfterPatch = candidateIdentityForTask({
      ...task,
      reviewSubjectSha: patchedSubjectSha,
    });
    const unchangedCandidateTree = Object.prototype.hasOwnProperty.call(patch, "candidateIdentity")
      && Object.prototype.hasOwnProperty.call(patch, "subjectSha")
      && candidateIdentityIsComplete(candidateIdentityBeforePatch)
      && candidateIdentityIsComplete(candidateIdentityAfterPatch)
      && candidateMaterialMatches(candidateIdentityBeforePatch, candidateIdentityAfterPatch);
    const startedBuilderReviewCycle = !repairingLegacyStatus
      && requestedStatus === "builder_review"
      && previousStatus !== "builder_review"
      && !unchangedCandidateTree;
    if (startedBuilderReviewCycle) {
      const candidateCycle = Math.max(
        Number(task.reviewSubjectCycle || 0) + 1,
        Number(task.reviewCycle || 0) + 1,
      );
      applyStoreLifecycleTransition(state, task, requestedStatus, {
        action: "record_builder_handoff",
        evidence: { candidateCycle, subjectSha: patchedSubjectSha },
      });
    }
    if (Object.prototype.hasOwnProperty.call(patch, "subjectSha")) {
      const subjectSha = patchedSubjectSha;
      task.reviewSubjectSha = subjectSha;
      if (!task.reviewSubjectCycle) {
        task.reviewSubjectCycle = Number(task.reviewCycle || 0);
      }
      if (startedBuilderReviewCycle) {
        supersedeRemediationHandoff(task, {
          now: new Date().toISOString(),
          replacementSubjectSha: subjectSha,
          status: "submitted",
          resolution: "Builder submitted a new candidate for the requested remediation.",
        });
      } else if (
        previousReviewSubjectSha
        && previousReviewSubjectSha !== subjectSha
      ) {
        restartReviewsForSubjectChange(
          state,
          task,
          project,
          previousReviewSubjectSha,
          subjectSha,
          new Date().toISOString(),
          { preserveCandidateCycle: unchangedCandidateTree },
        );
      }
    }
    const candidateIdentityMateriallyChanged = !startedBuilderReviewCycle
      && !["in_progress", "needs_changes"].includes(previousStatus)
      && previousReviewSubjectSha
      && previousReviewSubjectSha === task.reviewSubjectSha
      && candidateIdentityIsComplete(candidateIdentityBeforePatch)
      && !candidateMaterialMatches(candidateIdentityBeforePatch, candidateIdentityAfterPatch);
    if (candidateIdentityMateriallyChanged) {
      restartReviewsForSubjectChange(
        state,
        task,
        project,
        previousReviewSubjectSha,
        task.reviewSubjectSha,
        new Date().toISOString(),
        {
          candidateIdentityChanged: true,
          candidateIdentityIncomplete: !candidateIdentityIsComplete(candidateIdentityAfterPatch),
        },
      );
    }
    if ([
      "subjectSha",
      "candidateIdentity",
      "impactEvidence",
      "branchName",
      "operationalLocalArtifactRef",
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
      task.candidateIdentity = candidateIdentityForTask(task);
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "status")
      && requestedStatus !== task.status
      && positiveStateVersion(task.stateVersion) === positiveStateVersion(aggregateBeforePatch.stateVersion)
    ) {
      applyStoreLifecycleTransition(state, task, requestedStatus);
    } else if (
      !startedBuilderReviewCycle
      && lifecycleEvidenceChanged(aggregateBeforePatch, task)
      && positiveStateVersion(task.stateVersion) === positiveStateVersion(aggregateBeforePatch.stateVersion)
    ) {
      const candidateEvidenceMutation = ["subjectSha", "candidateIdentity", "impactEvidence", "branchName", "operationalLocalArtifactRef"]
        .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
      applyStoreLifecycleTransition(state, task, task.status, {
        action: candidateEvidenceMutation ? "mutate_evidence" : "mutate_assignment",
        force: true,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "status")
      && requestedStatus !== "blocked"
      && task.automationBlocker
    ) {
      delete task.automationBlocker;
    }
    const updatedAt = new Date().toISOString();
    supersedeStaleTaskCircuitInState(state, task, { now: updatedAt, author: "StudioOps Workflow" });
    task.updatedAt = updatedAt;
    state.events.push({
      id: nextId(state.events, "event"),
      type: "task_updated",
      projectId: task.projectId,
      taskId: task.id,
      message: `Task updated: ${task.title}`,
      createdAt: task.updatedAt,
    });
    return task;
  }, { operationName: "task.update" });
}

function missingArchitectureChildContractFields(child) {
  const missing = [];
  if (!String(child.description || "").trim()) missing.push("architecture constraints/description");
  if (!String(child.userStory || "").trim()) missing.push("user story");
  if (!String(child.expectedOutcome || "").trim()) missing.push("expected outcome");
  if (!(child.acceptanceCriteria || []).length) missing.push("acceptance criteria");
  if (!String(child.lane || "").trim()) missing.push("work lane");
  if (!(child.workAreas || []).length) missing.push("work areas");
  return missing;
}

function assertArchitectureChildContract(parent, child) {
  if (child.parentTaskId !== parent.id || child.architectureParentTaskId !== parent.id) {
    throw new Error(`Architecture child ${child.id} must be parent-linked to ${parent.id}.`);
  }
  if (!child.architectureRequired || child.architectureStatus !== "pending") {
    throw new Error(
      `Architecture child ${child.id} must be staged with architectureApproved and remain pending until parent completion.`,
    );
  }
  if (!["idea", "architecture_pending"].includes(child.status)) {
    throw new Error(`Architecture child ${child.id} is already beyond the pre-builder architecture gate.`);
  }
  const missing = missingArchitectureChildContractFields(child);
  if (missing.length) {
    throw new Error(`Architecture child ${child.id} is missing required task contract fields: ${missing.join(", ")}.`);
  }
}

function assertArchitectureDependencyGraph(state, parent, childTasks) {
  const childIds = new Set(childTasks.map((child) => child.id));
  const byId = new Map(childTasks.map((child) => [child.id, child]));
  for (const child of childTasks) {
    for (const dependencyId of child.dependsOnTaskIds || []) {
      if (dependencyId === parent.id) {
        throw new Error(`Architecture child ${child.id} cannot depend on its architecture parent.`);
      }
      const dependency = findTask(state, dependencyId);
      if (!dependency) throw new Error(`Unknown dependency task: ${dependencyId}`);
      if (dependency.projectId !== parent.projectId) {
        throw new Error(`Architecture child ${child.id} depends on a task from another project.`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) {
      throw new Error("Architecture child dependency graph contains a cycle.");
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const child = byId.get(taskId);
    for (const dependencyId of child?.dependsOnTaskIds || []) {
      if (childIds.has(dependencyId)) visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const child of childTasks) visit(child.id);
}

function completedArchitectureGraphIsValid(state, parent) {
  const decisionTaskIds = parent.architectureDecisionTaskIds || [];
  if (!decisionTaskIds.length || new Set(decisionTaskIds).size !== decisionTaskIds.length) return false;
  const childTasks = decisionTaskIds.map((id) => findTask(state, id));
  if (childTasks.some((child) => (
    !child
    || child.projectId !== parent.projectId
    || child.parentTaskId !== parent.id
    || child.architectureParentTaskId !== parent.id
    || !child.architectureRequired
    || child.architectureStatus !== "inherited"
    || missingArchitectureChildContractFields(child).length
  ))) return false;

  const governedChildIds = (state.tasks || [])
    .filter((child) => child.architectureParentTaskId === parent.id)
    .map((child) => child.id)
    .sort();
  const recordedChildIds = [...decisionTaskIds].sort();
  if (
    governedChildIds.length !== recordedChildIds.length
    || governedChildIds.some((id, index) => id !== recordedChildIds[index])
  ) return false;

  try {
    assertArchitectureDependencyGraph(state, parent, childTasks);
  } catch {
    return false;
  }
  return true;
}

export function completeArchitectureInState(state, taskId, input = {}) {
  const task = findTask(state, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const summary = String(input.body || input.summary || "").trim();
  if (summary.length < 120) {
    throw new Error("Architecture completion requires a substantive summary of at least 120 characters.");
  }
  const decisionTaskIds = normalizeList(
    input.taskIds || input.decisionTaskIds || input.architectureDecisionTaskIds,
  );
  if (!decisionTaskIds.length) {
    throw new Error("Architecture completion requires at least one dependency-linked implementation child task.");
  }
  const childTasks = decisionTaskIds.map((id) => {
    const child = findTask(state, id);
    if (!child) throw new Error(`Unknown architecture child task: ${id}`);
    if (child.projectId !== task.projectId) {
      throw new Error(`Architecture child ${id} belongs to another project.`);
    }
    if (child.id === task.id) throw new Error("An architecture task cannot be its own implementation child.");
    assertArchitectureChildContract(task, child);
    return child;
  });
  const governedChildIds = state.tasks
    .filter((child) => child.architectureParentTaskId === task.id)
    .map((child) => child.id)
    .sort();
  const recordedChildIds = [...decisionTaskIds].sort();
  if (
    governedChildIds.length !== recordedChildIds.length
    || governedChildIds.some((id, index) => id !== recordedChildIds[index])
  ) {
    throw new Error("Architecture completion must record every staged child task in the governed implementation graph.");
  }
  assertArchitectureDependencyGraph(state, task, childTasks);

  const now = new Date().toISOString();
  const author = String(input.author || "StudioOps Systems Architect").trim();
  task.architectureRequired = true;
  task.architectureStatus = "completed";
  task.architectureSummary = summary;
  task.architectureDecisionTaskIds = decisionTaskIds;
  task.architectureCompletedAt = now;
  task.architectureCompletedBy = author;
  task.assignedAgentRole = "";
  applyStoreLifecycleTransition(state, task, "architecture_ready", {
    action: "record_architecture_completion",
    now,
  });

  for (const child of childTasks) {
    child.architectureStatus = "inherited";
    applyStoreLifecycleTransition(state, child, "ready", {
      action: "release_architecture_children",
      now,
    });
  }

  state.comments = state.comments || [];
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId: task.id,
    author,
    body: `Architecture decision recorded.\n\n${summary}\n\nImplementation tasks: ${decisionTaskIds.join(", ")}`,
    createdAt: now,
  });
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "architecture_completed",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title}: architecture completed with ${decisionTaskIds.length} implementation task(s)`,
    createdAt: now,
  });
  return task;
}

export async function completeArchitecture(taskId, input = {}) {
  return mutateState(async (state) => completeArchitectureInState(state, taskId, input), {
    operationName: "task.complete_architecture",
  });
}

function qaDecisionSubject(candidate, input = {}) {
  assertCandidateEnvelope(candidate);
  const candidateId = String(input.candidateId || "").trim();
  const manifestDigest = String(input.manifestDigest || "").trim();
  const integrationSha = normalizeGitSha(input.integrationSha, "QA integration SHA");
  if (candidateId !== candidate.id) throw new Error("QA decision candidate ID does not match.");
  if (manifestDigest !== candidate.manifestDigest) throw new Error("QA decision manifest digest does not match.");
  if (integrationSha !== candidate.manifest.integration.sha) throw new Error("QA decision integration SHA does not match.");
  if (candidate.invalidation || candidate.status === "invalidated") throw new Error("Invalidated candidate cannot receive a QA decision.");
  if (candidate.status !== "frozen") throw new Error(`Candidate must be frozen for QA. Current status: ${candidate.status}`);
  return { candidateId, manifestDigest, integrationSha };
}

function applyTaskQaOutcome(state, task, project, outcome, input, now) {
  if (!["qa_review", "approved_for_main"].includes(task.status)) {
    throw new Error(`Task must be in qa_review before QA can be marked passed or failed. Current status: ${task.status}`);
  }
  if (outcome === "passed" && task.integrationStatus && task.integrationStatus !== "ready") {
    throw new Error(`Task QA integration is not ready yet: ${task.integrationStatus}`);
  }

  const author = String(input.author || "Owner QA").trim();
  const notes = String(input.notes || input.body || "").trim();
  task.qaDecision = {
    outcome,
    candidateId: input.candidateId,
    manifestDigest: input.manifestDigest,
    integrationSha: input.integrationSha,
    repositoryVerifiedAt: input.repositoryVerifiedAt || "",
    author,
    notes,
    decidedAt: now,
  };

  if (outcome === "passed") {
    setTaskWorkflowState(state, task, {
      status: "approved_for_main",
      assignedAgentRole: "promotion-worker",
      reviewerThreadId: "",
      promotionStatus: "queued",
      promotionTargetBranch: project.defaultBranch || "main",
      promotionUpdatedAt: now,
    }, now, {
      action: "pass_qa",
      actorContext: { actorId: author, actorType: "owner", role: "owner", trusted: true },
      evidence: { candidateId: input.candidateId, manifestDigest: input.manifestDigest },
    });
    addAutomationComment(
      state,
      task,
      `Local QA passed. This task is approved for promotion to ${project.defaultBranch || "main"}.${notes ? `\n\n${notes}` : ""}`,
      now,
      author,
    );
    state.events.push({
      id: nextId(state.events, "event"),
      type: "qa_passed",
      projectId: task.projectId,
      taskId: task.id,
      message: `${task.title} passed local QA and is approved for main promotion.`,
      createdAt: now,
    });
    return task;
  }

  setTaskWorkflowState(state, task, {
    status: "needs_changes",
    assignedAgentRole: "builder",
    reviewerThreadId: "",
    promotionStatus: "",
    promotionUpdatedAt: now,
  }, now, {
    action: "request_changes",
    actorContext: { actorId: author, actorType: "owner", role: "owner", trusted: true },
    evidence: { candidateId: input.candidateId, manifestDigest: input.manifestDigest },
  });
  addAutomationComment(
    state,
    task,
    `Local QA failed. Returning this task to the builder.${notes ? `\n\n${notes}` : ""}`,
    now,
    author,
  );
  state.events.push({
    id: nextId(state.events, "event"),
    type: "qa_failed",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title} failed local QA and was returned for changes.`,
    createdAt: now,
  });
  return task;
}

function recordCandidateQaDecisionInState(state, candidate, input = {}) {
  const subject = qaDecisionSubject(candidate, input);
  const outcome = String(input.outcome || input.decision || "").trim().toLowerCase();
  if (!["passed", "failed"].includes(outcome)) throw new Error("QA decision outcome must be passed or failed.");
  const sourceTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  const selectedTaskIds = normalizeList(input.taskIds || input.tasks).sort();
  if (selectedTaskIds.length && JSON.stringify(selectedTaskIds) !== JSON.stringify(sourceTaskIds)) {
    throw new Error("Candidate QA decisions are atomic and must include every manifest task.");
  }
  const project = findProject(state, candidate.projectId);
  if (!project) throw new Error(`Candidate has missing project: ${candidate.projectId}`);
  const now = new Date().toISOString();
  const tasks = sourceTaskIds.map((taskId) => {
    const task = state.tasks.find((item) => (
      item.id === taskId
      && item.projectId === candidate.projectId
      && item.candidateId === candidate.id
    ));
    if (!task) throw new Error(`Candidate task ${taskId} is missing or linked to another candidate.`);
    return task;
  });
  const applied = tasks.map((task) => applyTaskQaOutcome(state, task, project, outcome, {
    ...input,
    ...subject,
  }, now));
  candidate.status = outcome === "passed" ? "qa_passed" : "qa_failed";
  candidate.qaDecision = {
    outcome,
    ...subject,
    taskIds: sourceTaskIds,
    repositoryVerifiedAt: input.repositoryVerifiedAt || "",
    author: String(input.author || "Owner QA").trim(),
    notes: String(input.notes || input.body || "").trim(),
    decidedAt: now,
  };
  candidate.updatedAt = now;
  const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  if (bundle) {
    bundle.status = outcome;
    bundle.qaDecision = candidate.qaDecision;
    bundle.updatedAt = now;
  }
  state.events.push({
    id: nextId(state.events, "event"),
    type: `candidate_qa_${outcome}`,
    projectId: candidate.projectId,
    message: `${candidate.id}: ${applied.length} task(s) marked ${outcome} at ${subject.integrationSha}.`,
    createdAt: now,
  });
  return { candidate, bundle, decisions: applied.map((task) => ({ task, outcome })) };
}

async function verifyCandidateForQaInState(state, candidate) {
  const project = findProject(state, candidate.projectId);
  if (!project) throw new Error(`Candidate has missing project: ${candidate.projectId}`);
  const verification = await verifyCandidateRepositoryState(project, candidate);
  if (verification.ok) return { ok: true, verification };
  if (verification.status !== "drift") {
    return {
      ok: false,
      error: `Candidate integrity could not be verified: ${verification.reason}`,
    };
  }
  invalidateCandidate(candidate, verification);
  const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
  if (bundle) {
    bundle.status = "invalidated";
    bundle.updatedAt = candidate.updatedAt;
  }
  state.events.push({
      id: nextId(state.events, "event"),
      type: "candidate_invalidated",
      projectId: candidate.projectId,
      message: `${candidate.id}: ${verification.reason}`,
      createdAt: candidate.updatedAt,
    });
  return {
    ok: false,
    error: `Candidate integrity verification failed: ${verification.reason}`,
  };
}

export async function recordQaDecision(taskId, input = {}) {
  const operation = await mutateState(async (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const candidate = (state.candidates || []).find((item) => item.id === task.candidateId);
    if (!candidate) throw new Error(`Task ${taskId} has no immutable candidate.`);
    const verified = await verifyCandidateForQaInState(state, candidate);
    if (!verified.ok) return verified;
    if (candidate.manifest.sources.length !== 1) {
      throw new Error("Use the candidate or QA bundle decision endpoint for a multi-task candidate.");
    }
    return {
      ok: true,
      result: recordCandidateQaDecisionInState(state, candidate, {
        ...input,
        repositoryVerifiedAt: verified.verification.verifiedAt,
      }),
    };
  }, { operationName: "qa.record_task_decision" });
  if (!operation.ok) throw new Error(operation.error);
  return operation.result;
}

export async function recordQaBundleDecision(bundleId, input = {}) {
  const operation = await mutateState(async (state) => {
    const bundle = (state.qaBundles || []).find((item) => item.id === bundleId);
    if (!bundle) throw new Error(`Unknown QA bundle: ${bundleId}`);
    if (!bundle.candidateId) throw new Error(`QA bundle ${bundleId} is legacy and has no immutable candidate.`);
    const candidate = (state.candidates || []).find((item) => item.id === bundle.candidateId);
    if (!candidate || candidate.qaBundleId !== bundle.id) throw new Error(`QA bundle ${bundleId} has an invalid candidate link.`);
    const verified = await verifyCandidateForQaInState(state, candidate);
    if (!verified.ok) return verified;
    const boundInput = {
      ...input,
      candidateId: input.candidateId || candidate.id,
      manifestDigest: input.manifestDigest || candidate.manifestDigest,
      integrationSha: input.integrationSha || candidate.manifest.integration.sha,
    };
    return {
      ok: true,
      result: recordCandidateQaDecisionInState(state, candidate, {
        ...boundInput,
        repositoryVerifiedAt: verified.verification.verifiedAt,
      }),
    };
  }, { operationName: "qa.record_bundle_decision" });
  if (!operation.ok) throw new Error(operation.error);
  return operation.result;
}

export async function addComment(taskId, body, author = "user") {
  return mutateState(async (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const now = new Date().toISOString();
    const comment = {
      id: nextId(state.comments, "comment"),
      taskId,
      author,
      body: String(body || "").trim(),
      createdAt: now,
    };
    if (!comment.body) throw new Error("Comment body is required.");
    state.comments.push(comment);
    state.events.push({
      id: nextId(state.events, "event"),
      type: "comment_created",
      projectId: task.projectId,
      taskId,
      message: `Comment added to ${task.title}`,
      createdAt: now,
    });
    return comment;
  }, { operationName: "task.add_comment" });
}

export function recordReviewInState(state, taskId, input = {}) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const project = findProject(state, task.projectId);
    if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
    const stages = reviewStagesForTask(project, task);
    const stage = findReviewStage(stages, input.stage || input.stageKey || input.role || task.status);
    if (!stage) throw new Error(`Unknown review stage: ${input.stage || input.stageKey || input.role || task.status}`);
    const outcome = String(input.outcome || "").trim();
    if (!VALID_REVIEW_OUTCOMES.has(outcome)) {
      throw new Error(`Invalid review outcome: ${outcome}`);
    }
    if (isLeadReviewStage(stage) && outcome === "skipped") {
      throw new Error("Primary lead review cannot be skipped.");
    }
    const candidateCycle = Number(input.candidateCycle || input.cycle);
    const currentCycle = currentReviewCycle(task);
    const currentCandidateCycle = currentReviewCandidateCycle(task);
    if (!Number.isSafeInteger(candidateCycle) || candidateCycle < 1) {
      throw new Error("Review candidate cycle is required.");
    }
    if (candidateCycle !== currentCandidateCycle) {
      throw new Error(`Review candidate cycle ${candidateCycle} does not match current cycle candidate ${currentCandidateCycle}.`);
    }
    const subjectSha = normalizeGitSha(input.subjectSha || input.sha, "review subject SHA");
    if (task.reviewSubjectSha && task.reviewSubjectSha !== subjectSha) {
      throw new Error(`Review subject SHA does not match the current cycle subject ${task.reviewSubjectSha}.`);
    }
    task.reviewSubjectSha = subjectSha;
    task.reviewSubjectCycle = candidateCycle;
    const stageIndex = stages.indexOf(stage);
    const earliestRequiredStage = earliestIncompleteRequiredReviewStage(state, project, task);
    const earliestRequiredIndex = stages.indexOf(earliestRequiredStage);
    if (
      earliestRequiredStage
      && stageIndex > earliestRequiredIndex
      && !cycleLimitLeadReviewApplies(state, project, task, stage)
    ) {
      throw new Error(
        `${earliestRequiredStage.label || earliestRequiredStage.key} must approve candidate cycle ${candidateCycle} at ${subjectSha} before ${stage.label || stage.key} can continue.`,
      );
    }
    const now = new Date().toISOString();
    const review = {
      id: nextId(state.reviews, "review"),
      taskId,
      projectId: task.projectId,
      cycle: currentReviewCycle(task),
      candidateCycle,
      subjectSha,
      stageKey: stage.key,
      status: stage.status,
      role: stage.role,
      outcome,
      author: String(input.author || stage.role || "reviewer").trim(),
      body: String(input.body || "").trim(),
      createdAt: now,
    };
    state.reviews.push(review);
    state.comments.push({
      id: nextId(state.comments, "comment"),
      taskId,
      author: review.author,
      body: `Review ${stage.label || stage.key}: ${outcome}${review.body ? `\n\n${review.body}` : ""}`,
      createdAt: now,
    });
    if (outcome === "changes_requested") {
      task.remediationHandoff = createRemediationHandoff(
        task,
        (state.reviews || [])
          .filter((item) => item.taskId === task.id)
          .filter((item) => reviewMatchesCurrentCandidate(task, item)),
        now,
      );
      const actions = routeChangesRequestedInState(state, task, project, stage, now, "StudioOps Automation", []);
      state.events.push({
        id: nextId(state.events, "event"),
        type: "review_changes_requested",
        projectId: task.projectId,
        taskId,
        message: `${stage.label || stage.key} requested changes for ${task.title}`,
        createdAt: now,
      });
      return { review, actions };
    }
    const actions = advanceTaskWorkflowInState(state, task, {
      now,
      author: "StudioOps Automation",
      reason: `${stage.key} review ${outcome}`,
    });
    state.events.push({
      id: nextId(state.events, "event"),
      type: "review_recorded",
      projectId: task.projectId,
      taskId,
      message: `${stage.label || stage.key} review recorded for ${task.title}`,
      createdAt: now,
    });
    return { review, actions };
}

export async function recordReview(taskId, input = {}) {
  return mutateState(async (state) => {
    return recordReviewInState(state, taskId, input);
  }, { operationName: "review.record" });
}

export async function automationTick(input = {}) {
  const mutate = input.state
    ? async (mutator) => mutator(input.state)
    : mutateState;
  return mutate(async (state) => {
    const nowMs = Number(input.nowMs || Date.now());
    const now = new Date(nowMs).toISOString();
    if (diskPressureIncidentIsActive(state.meta?.diskPressureIncident) && !input.ignoreDiskPressureIncident) {
      return {
        actions: [],
        paused: true,
        pauseReason: "disk_recovery_in_progress",
        incidentId: state.meta.diskPressureIncident.id,
      };
    }
    if (state.meta?.operatorPause?.active && !input.ignoreOperatorPause) {
      return {
        actions: [],
        paused: true,
        pauseReason: state.meta.operatorPause.reason || "StudioOps automation is paused by the operator.",
      };
    }
    const project = input.project || input.projectId ? findProject(state, input.project || input.projectId) : null;
    if ((input.project || input.projectId) && !project) throw new Error(`Unknown project: ${input.project || input.projectId}`);
    const parsedLimit = Number(input.limit || 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 10;
    const actions = reconcileAutomationStateInState(state, {
      ...input,
      now,
      nowMs,
      project,
    });
    const candidates = state.tasks
      .filter((task) => !project || task.projectId === project.id)
      .filter((task) => !["done", "closed", "deployed", "merged", "qa_review", "approved_for_main", "promotion_blocked", "user_review", "approved"].includes(task.status))
      .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));

    for (const task of candidates) {
      if (actions.length >= limit) break;
      const before = `${task.status}|${task.assignedAgentRole || ""}|${task.reviewCycle || 0}`;
      const taskActions = advanceTaskWorkflowInState(state, task, {
        now,
        author: "StudioOps Automation",
        reason: "automation tick",
      });
      const after = `${task.status}|${task.assignedAgentRole || ""}|${task.reviewCycle || 0}`;
      if (taskActions.length || before !== after) {
        actions.push(...taskActions);
      }
    }

    state.events.push({
      id: nextId(state.events, "event"),
      type: "automation_tick",
      projectId: project?.id || "",
      message: `Automation tick completed with ${actions.length} action(s).`,
      createdAt: now,
    });
    return { actions };
  }, { operationName: "automation.tick" });
}

const ACTIVE_DISK_INCIDENT_STATES = new Set(["reclaiming", "awaiting_health", "degraded"]);

export function diskPressureIncidentIsActive(incident) {
  return Boolean(incident && ACTIVE_DISK_INCIDENT_STATES.has(incident.state));
}

function boundedDiskEvidence(value = {}) {
  const boundedNumber = (input) => Number.isFinite(Number(input)) ? Math.max(0, Number(input)) : 0;
  return {
    path: String(value.path || "").slice(0, 1024),
    availableBytes: boundedNumber(value.availableBytes),
    availablePercent: boundedNumber(value.availablePercent),
    minAvailableBytes: boundedNumber(value.minAvailableBytes),
    minAvailablePercent: boundedNumber(value.minAvailablePercent),
    pressure: value.pressure === true,
  };
}

function boundedCleanupEvidence(value = {}) {
  const reasonCounts = Object.fromEntries(Object.entries(value.selection?.excludedByReason || {})
    .slice(0, 32)
    .map(([reason, count]) => [String(reason).slice(0, 120), Math.max(0, Number(count) || 0)]));
  const reasonBytes = Object.fromEntries(Object.entries(value.selection?.excludedVerifiedBytesByReason || {})
    .slice(0, 32)
    .map(([reason, bytes]) => [String(reason).slice(0, 120), Math.max(0, Number(bytes) || 0)]));
  const unknownSizes = Object.fromEntries(Object.entries(value.selection?.excludedUnknownSizeCountByReason || {})
    .slice(0, 32)
    .map(([reason, count]) => [String(reason).slice(0, 120), Math.max(0, Number(count) || 0)]));
  return {
    attempted: value.attempted === true,
    selectedCount: Math.max(0, Number(value.selectedCount) || 0),
    skippedCount: Math.max(0, Number(value.skippedCount) || 0),
    failureCount: Math.max(0, Number(value.failureCount) || 0),
    logicalDeletedBytes: Math.max(0, Number(value.logicalDeletedBytes) || 0),
    actualAvailableByteDelta: Math.max(0, Number(value.actualAvailableByteDelta) || 0),
    excludedByReason: reasonCounts,
    excludedVerifiedBytesByReason: reasonBytes,
    excludedUnknownSizeCountByReason: unknownSizes,
    remainingShortfall: {
      pressure: value.remainingShortfall?.pressure === true,
      bytes: Math.max(0, Number(value.remainingShortfall?.bytes) || 0),
      percentPoints: Math.max(0, Number(value.remainingShortfall?.percentPoints) || 0),
    },
  };
}

function boundedRecoveryHealth(value = {}) {
  return {
    disksHealthy: value.disksHealthy === true,
    database: {
      ok: value.database?.ok === true,
      checkedAt: String(value.database?.checkedAt || "").slice(0, 64),
      reason: String(value.database?.reason || "").slice(0, 120),
      projectCount: Math.max(0, Number(value.database?.projectCount) || 0),
      taskCount: Math.max(0, Number(value.database?.taskCount) || 0),
      runCount: Math.max(0, Number(value.database?.runCount) || 0),
    },
    workers: {
      ok: value.workers?.ok === true,
      checkedAt: String(value.workers?.checkedAt || "").slice(0, 64),
      workers: (value.workers?.workers || []).slice(0, 32).map((worker) => ({
        worker: String(worker.worker || "").slice(0, 80),
        ok: worker.ok === true,
        reason: String(worker.reason || "").slice(0, 120),
        status: String(worker.status || "").slice(0, 40),
        updatedAt: String(worker.updatedAt || "").slice(0, 64),
      })),
    },
    diskRecovery: {
      recoveredWithoutCleanup: value.diskRecovery?.recoveredWithoutCleanup === true,
      sameVolume: value.diskRecovery?.sameVolume !== false,
    },
  };
}

export function openDiskPressureIncidentInState(state, input = {}) {
  const now = input.now || new Date(Number(input.nowMs || Date.now())).toISOString();
  state.meta = state.meta || {};
  state.events = state.events || [];
  const current = state.meta.diskPressureIncident;
  const observations = Math.min(1_000_000, Math.max(0, Number(current?.observationCount) || 0) + 1);
  const evidence = {
    data: boundedDiskEvidence(input.data),
    workspace: boundedDiskEvidence(input.workspace),
  };
  if (diskPressureIncidentIsActive(current)) {
    state.meta.diskPressureIncident = {
      ...current,
      state: "reclaiming",
      generation: Math.max(1, Number(current.generation) || 1) + 1,
      observationCount: observations,
      lastObservedAt: now,
      lastObservation: evidence,
    };
    return structuredClone(state.meta.diskPressureIncident);
  }
  const incident = {
    id: `disk_incident_${randomUUID()}`,
    state: "reclaiming",
    generation: 1,
    openedAt: now,
    lastObservedAt: now,
    observationCount: 1,
    affectedVolumes: evidence,
    lastObservation: evidence,
    cleanupTotals: {
      logicalDeletedBytes: 0,
      actualAvailableByteDelta: 0,
      selectedCount: 0,
      failureCount: 0,
    },
    restartedWorkers: [],
  };
  state.meta.diskPressureIncident = incident;
  state.events.push({
    id: nextId(state.events, "event"),
    type: "disk_pressure_incident_opened",
    message: "StudioOps opened a durable disk-pressure recovery incident and blocked new automation claims.",
    createdAt: now,
  });
  return structuredClone(incident);
}

export async function openDiskPressureIncident(input = {}) {
  return mutateState(async (state) => openDiskPressureIncidentInState(state, input), {
    operationName: "disk_incident.open",
  });
}

function requireDiskIncidentGeneration(state, input) {
  const incident = state.meta?.diskPressureIncident;
  if (!diskPressureIncidentIsActive(incident)) throw new Error("No active disk-pressure incident exists.");
  if (String(input.incidentId || "") !== incident.id) throw new Error("Disk incident compare-and-set ID mismatch.");
  if (Number(input.expectedGeneration) !== Number(incident.generation)) {
    throw new Error("Disk incident compare-and-set generation mismatch.");
  }
  return incident;
}

export function updateDiskPressureIncidentInState(state, input = {}) {
  const incident = requireDiskIncidentGeneration(state, input);
  const now = input.now || new Date(Number(input.nowMs || Date.now())).toISOString();
  const cleanup = boundedCleanupEvidence(input.cleanup);
  const restartedWorkers = [...new Set([
    ...(incident.restartedWorkers || []),
    ...(input.restartedWorkers || []).map((worker) => String(worker).slice(0, 80)),
  ])].slice(0, 32);
  state.meta.diskPressureIncident = {
    ...incident,
    state: ["reclaiming", "awaiting_health", "degraded"].includes(input.state)
      ? input.state
      : "awaiting_health",
    generation: Number(incident.generation) + 1,
    lastObservedAt: now,
    lastObservation: {
      data: boundedDiskEvidence(input.data),
      workspace: boundedDiskEvidence(input.workspace),
    },
    cleanup,
    cleanupTotals: {
      logicalDeletedBytes: Math.max(0, Number(incident.cleanupTotals?.logicalDeletedBytes) || 0)
        + cleanup.logicalDeletedBytes,
      actualAvailableByteDelta: Math.max(0, Number(incident.cleanupTotals?.actualAvailableByteDelta) || 0)
        + cleanup.actualAvailableByteDelta,
      selectedCount: Math.max(0, Number(incident.cleanupTotals?.selectedCount) || 0) + cleanup.selectedCount,
      failureCount: Math.max(0, Number(incident.cleanupTotals?.failureCount) || 0) + cleanup.failureCount,
    },
    health: boundedRecoveryHealth(input.health),
    restartedWorkers,
    remediation: String(input.remediation || "").slice(0, 1000),
  };
  return structuredClone(state.meta.diskPressureIncident);
}

export async function updateDiskPressureIncident(input = {}) {
  return mutateState(async (state) => updateDiskPressureIncidentInState(state, input), {
    operationName: "disk_incident.update",
  });
}

export function recoverDiskPressureIncidentInState(state, input = {}) {
  const incident = requireDiskIncidentGeneration(state, input);
  const nowMs = Number(input.nowMs || Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  state.events = state.events || [];
  const cleanup = boundedCleanupEvidence(input.cleanup);
  state.meta.diskPressureIncident = {
    ...incident,
    state: "recovered",
    generation: Number(incident.generation) + 1,
    recoveredAt: now,
    durationMs: Math.max(0, nowMs - Date.parse(incident.openedAt || now)),
    finalObservation: {
      data: boundedDiskEvidence(input.data),
      workspace: boundedDiskEvidence(input.workspace),
    },
    cleanup,
    cleanupTotals: {
      logicalDeletedBytes: Math.max(0, Number(incident.cleanupTotals?.logicalDeletedBytes) || 0)
        + cleanup.logicalDeletedBytes,
      actualAvailableByteDelta: Math.max(0, Number(incident.cleanupTotals?.actualAvailableByteDelta) || 0)
        + cleanup.actualAvailableByteDelta,
      selectedCount: Math.max(0, Number(incident.cleanupTotals?.selectedCount) || 0) + cleanup.selectedCount,
      failureCount: Math.max(0, Number(incident.cleanupTotals?.failureCount) || 0) + cleanup.failureCount,
    },
    health: boundedRecoveryHealth(input.health),
  };
  state.events.push({
    id: nextId(state.events, "event"),
    type: "disk_pressure_incident_recovered",
    message: "StudioOps verified disk, database, and managed-worker health and closed the recovery incident.",
    createdAt: now,
  });
  return structuredClone(state.meta.diskPressureIncident);
}

export async function recoverDiskPressureIncident(input = {}) {
  return mutateState(async (state) => recoverDiskPressureIncidentInState(state, input), {
    operationName: "disk_incident.recover",
  });
}

function taskHasActiveRun(state, taskId) {
  return (state.runs || []).some((run) => run.taskId === taskId && ACTIVE_RUN_STATUSES.has(run.status));
}

function transientRecoveryAt(blocker, input = {}) {
  const explicit = Date.parse(blocker.retryAt || "");
  if (Number.isFinite(explicit)) return explicit;
  const blockedAt = Date.parse(blocker.blockedAt || "");
  if (!Number.isFinite(blockedAt)) return 0;
  const baseMs = Math.max(60_000, Number(input.transientRecoveryMs || DEFAULT_TRANSIENT_RECOVERY_MS));
  const cycle = Math.max(0, Number(blocker.recoveryCount || 0));
  return blockedAt + Math.min(MAX_TRANSIENT_RECOVERY_MS, baseMs * (2 ** cycle));
}

function recordRecovery(state, task, body, eventType, now) {
  state.comments = state.comments || [];
  state.events = state.events || [];
  addAutomationComment(state, task, body, now, "StudioOps Resilience");
  state.events.push({
    id: nextId(state.events, "event"),
    type: eventType,
    projectId: task.projectId,
    taskId: task.id,
    message: body,
    createdAt: now,
  });
}

export function workflowSnapshotForTask(task, overrides = {}) {
  return {
    status: overrides.status ?? task.status,
    assignedAgentRole: overrides.assignedAgentRole ?? task.assignedAgentRole ?? "",
    reviewCycle: Number(task.reviewCycle || 0),
    reviewSubjectCycle: Number(task.reviewSubjectCycle || task.reviewCycle || 0),
    reviewSubjectSha: task.reviewSubjectSha || "",
    candidateIdentity: task.candidateIdentity
      ? structuredClone(task.candidateIdentity)
      : null,
    branchName: task.branchName || "",
  };
}

export function taskAutomationCircuitIsCurrent(task = {}) {
  const circuit = task.automationCircuit;
  if (circuit?.state !== "open") return false;
  if (!circuit.snapshot) return true;
  const blockedByCircuit = task.status === "blocked" && task.automationBlocker?.type === "circuit";
  const liveSnapshot = workflowSnapshotForTask(task, blockedByCircuit
    ? {
        status: circuit.snapshot.status ?? task.automationBlocker.resumeStatus ?? task.status,
        assignedAgentRole: circuit.snapshot.assignedAgentRole ?? task.assignedAgentRole ?? "",
      }
    : {});
  const comparableLiveSnapshot = Object.fromEntries(
    Object.keys(circuit.snapshot).map((key) => [key, liveSnapshot[key]]),
  );
  return isDeepStrictEqual(circuit.snapshot, comparableLiveSnapshot);
}

export function supersedeStaleTaskCircuitInState(state, task, input = {}) {
  if (!task?.automationCircuit || taskAutomationCircuitIsCurrent(task)) return false;
  if (task.automationCircuit.state !== "open") return false;
  const now = input.now || new Date().toISOString();
  task.automationCircuit = {
    ...task.automationCircuit,
    state: "superseded",
    closedAt: now,
    closedBy: String(input.author || "StudioOps Resilience").trim(),
    closeReason: "Objective workflow state advanced beyond the blocked circuit snapshot.",
    supersededBy: {
      status: task.status,
      reviewSubjectSha: task.reviewSubjectSha || "",
      candidateId: task.candidateId || "",
    },
  };
  if (task.automationBlocker?.type === "circuit") delete task.automationBlocker;
  task.retryNotBefore = "";
  task.updatedAt = now;
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "automation_circuit_superseded",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.id} advanced to ${task.status}; its obsolete automation circuit remains as superseded audit evidence.`,
    createdAt: now,
  });
  return true;
}

export function reconcileAutomationStateInState(state, input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const now = input.now || new Date(nowMs).toISOString();
  const orphanGraceMs = Math.max(60_000, Number(input.orphanGraceMs || DEFAULT_ORPHANED_TASK_GRACE_MS));
  const actions = [];

  for (const task of state.tasks || []) {
    if (input.project && task.projectId !== input.project.id) continue;

    if (supersedeStaleTaskCircuitInState(state, task, { now })) {
      actions.push(`${task.id}: superseded stale automation circuit after workflow recovery`);
    }

    const blocker = task.automationBlocker;
    if (
      task.status === "blocked"
      && blocker
      && ["execution", "transient"].includes(blocker.type)
      && transientRecoveryAt(blocker, input) <= nowMs
    ) {
      const maxRecoveries = Math.max(
        0,
        Number(input.maxTransientRecoveries ?? DEFAULT_MAX_TRANSIENT_RECOVERIES),
      );
      const completedRecoveries = Math.max(
        Number(blocker.recoveryCount || 0),
        Number(task.lastAutomationRecoveryCount || 0),
      );
      if (completedRecoveries >= maxRecoveries) {
        const sourceRun = (state.runs || []).find((run) => run.id === blocker.runId);
        const snapshot = workflowSnapshotForTask(task, {
          status: VALID_STATUSES.has(blocker.resumeStatus) ? blocker.resumeStatus : "queued",
          assignedAgentRole: sourceRun?.role || "",
        });
        task.assignedAgentRole = "owner";
        task.retryNotBefore = "";
        task.automationCircuit = {
          state: "open",
          scope: "task",
          reasonCode: blocker.reason || task.lastAutomationFailure || "automation_attempts_exhausted",
          normalizedReason: "Automatic recovery attempts were exhausted.",
          failureFingerprint: `${task.id}:${blocker.runId || task.lastAutomationFailureRunId || "unknown"}`,
          attemptsConsumed: Number(blocker.attempts || 0),
          maxAttempts: Number(blocker.attempts || 0),
          recoveryCount: completedRecoveries,
          snapshot,
          openedAt: now,
          nextCheapProbe: "Inspect the preserved run output and verify the underlying failure without launching a model.",
          resumeAction: `studioops circuit-reset --task ${task.id} --expected-opened-at ${now} --reason verified`,
          remediation: "Repair or verify the underlying blocker, then explicitly reset this task circuit.",
        };
        task.automationBlocker = {
          ...blocker,
          type: "circuit",
          retryAt: "",
          recoveryCount: completedRecoveries,
        };
        task.updatedAt = now;
        recordRecovery(
          state,
          task,
          `Opened the task automation circuit after ${completedRecoveries} recovery cycle(s). No additional model run will start until the circuit is explicitly reset.`,
          "automation_circuit_opened",
          now,
        );
        actions.push(`${task.id}: opened automation circuit after bounded recovery`);
        continue;
      }
      const resumeStatus = VALID_STATUSES.has(blocker.resumeStatus) ? blocker.resumeStatus : "queued";
      const recoveryCount = completedRecoveries + 1;
      task.assignedAgentRole = "";
      task.assignedThreadId = "";
      task.reviewerThreadId = "";
      task.retryNotBefore = "";
      task.lastAutomationRecoveryCount = recoveryCount;
      task.automationAttemptEpoch = Number(task.automationAttemptEpoch || 0) + 1;
      task.updatedAt = now;
      delete task.automationBlocker;
      applyStoreLifecycleTransition(state, task, resumeStatus, { action: "recover_workflow", now, nowMs });
      recordRecovery(
        state,
        task,
        `Recovered transient automation failure and returned the task to ${resumeStatus}. Recovery cycle ${recoveryCount}.`,
        "transient_failure_recovered",
        now,
      );
      actions.push(`${task.id}: recovered transient automation failure`);
    }

    const isTrackingContainer = task.type === "epic"
      || (state.tasks || []).some((candidate) => candidate.parentTaskId === task.id);
    if (task.status !== "in_progress" || isTrackingContainer || taskHasActiveRun(state, task.id)) continue;
    const updatedAt = Date.parse(task.updatedAt || task.createdAt || "");
    if (Number.isFinite(updatedAt) && nowMs - updatedAt < orphanGraceMs) continue;

    task.assignedAgentRole = "";
    task.assignedThreadId = "";
    task.reviewerThreadId = "";
    task.retryNotBefore = "";
    task.updatedAt = now;
    applyStoreLifecycleTransition(state, task, "queued", { action: "recover_workflow", now, nowMs });
    recordRecovery(
      state,
      task,
      "Recovered an orphaned in-progress task because no queued or running durable run exists.",
      "orphaned_task_recovered",
      now,
    );
    actions.push(`${task.id}: recovered orphaned in-progress task`);
  }

  return actions;
}

export function setOperatorPauseInState(state, input = {}) {
  const now = input.now || new Date().toISOString();
  state.meta = state.meta || {};
  state.events = state.events || [];
  state.meta.operatorPause = {
    active: true,
    reason: String(input.reason || "Paused by the StudioOps operator.").trim(),
    pausedAt: now,
    pausedBy: String(input.author || "StudioOps Owner").trim(),
    actionRequired: "Run `studioops automation-resume --reason verified` when it is safe to allow new builder and reviewer runs.",
  };
  state.events.push({
    id: nextId(state.events, "event"),
    type: "automation_paused",
    message: state.meta.operatorPause.reason,
    createdAt: now,
  });
  return state.meta.operatorPause;
}

export async function setOperatorPause(input = {}) {
  return mutateState(async (state) => setOperatorPauseInState(state, input), {
    operationName: "automation.pause",
  });
}

export function resumeOperatorAutomationInState(state, input = {}) {
  const now = input.now || new Date().toISOString();
  state.meta = state.meta || {};
  state.events = state.events || [];
  const previous = state.meta.operatorPause || {};
  state.meta.operatorPause = {
    ...previous,
    active: false,
    resumedAt: now,
    resumedBy: String(input.author || "StudioOps Owner").trim(),
    resumeReason: String(input.reason || "Operator verified automation may resume.").trim(),
  };
  state.events.push({
    id: nextId(state.events, "event"),
    type: "automation_resumed",
    message: state.meta.operatorPause.resumeReason,
    createdAt: now,
  });
  return state.meta.operatorPause;
}

export async function resumeOperatorAutomation(input = {}) {
  return mutateState(async (state) => resumeOperatorAutomationInState(state, input), {
    operationName: "automation.resume",
  });
}

export function resetAutomationCircuitInState(state, input = {}) {
  const now = input.now || new Date().toISOString();
  const task = input.task ? findTask(state, input.task) : null;
  const project = input.project ? findProject(state, input.project) : null;
  if (!task && !project) throw new Error("Circuit reset requires --task or --project.");
  const target = task || project;
  if (target.automationCircuit?.state !== "open") {
    throw new Error(`${task ? task.id : project.id} does not have an open automation circuit.`);
  }
  const previousCircuit = { ...target.automationCircuit };
  const expectedOpenedAt = String(input.expectedOpenedAt || "").trim();
  if (task && expectedOpenedAt && expectedOpenedAt !== String(previousCircuit.openedAt || "")) {
    throw new Error("Automation circuit reset compare-and-set failed: circuit generation drifted.");
  }
  const expected = input.expectedSnapshot || input.snapshot;
  const actual = target.automationCircuit.snapshot;
  if (expected && (!actual || !isDeepStrictEqual(expected, actual))) {
    throw new Error("Automation circuit reset compare-and-set failed: workflow snapshot drifted.");
  }
  if (task && actual) {
    const live = workflowSnapshotForTask(task);
    const snapshotBranch = Object.prototype.hasOwnProperty.call(actual, "branchName")
      ? actual.branchName
      : actual.branch;
    const immutableSnapshot = {
      reviewCycle: actual.reviewCycle,
      reviewSubjectCycle: actual.reviewSubjectCycle,
      reviewSubjectSha: actual.reviewSubjectSha,
      candidateIdentity: actual.candidateIdentity,
      branchName: snapshotBranch || "",
    };
    const immutableLive = {
      reviewCycle: live.reviewCycle,
      reviewSubjectCycle: live.reviewSubjectCycle,
      reviewSubjectSha: live.reviewSubjectSha,
      candidateIdentity: live.candidateIdentity,
      branchName: live.branchName,
    };
    if (!isDeepStrictEqual(immutableSnapshot, immutableLive)) {
      throw new Error("Automation circuit reset compare-and-set failed: live candidate identity drifted.");
    }
  }
  target.automationAttemptEpoch = Number(target.automationAttemptEpoch || 0) + 1;
  if (project) {
    for (const projectTask of state.tasks || []) {
      if (projectTask.projectId !== project.id) continue;
      projectTask.automationAttemptEpoch = Number(projectTask.automationAttemptEpoch || 0) + 1;
    }
  }
  target.automationCircuit = {
    ...previousCircuit,
    state: "closed",
    closedAt: now,
    closedBy: String(input.author || "StudioOps Owner").trim(),
    closeReason: String(input.reason || "Underlying blocker verified.").trim(),
  };
  target.updatedAt = now;
  if (task) {
    const resumeStatus = VALID_STATUSES.has(actual?.status)
      ? actual.status
      : VALID_STATUSES.has(task.automationBlocker?.resumeStatus)
        ? task.automationBlocker.resumeStatus
        : "queued";
    task.assignedAgentRole = actual?.assignedAgentRole || "";
    task.retryNotBefore = "";
    delete task.automationBlocker;
    applyStoreLifecycleTransition(state, task, resumeStatus, {
      action: task.status === "blocked" ? "resume_workflow" : "recover_workflow",
      now,
    });
    state.comments = state.comments || [];
    addAutomationComment(
      state,
      task,
      `Automation circuit reset after owner verification. New execution epoch ${task.automationAttemptEpoch}. Reason: ${target.automationCircuit.closeReason}`,
      now,
      target.automationCircuit.closedBy,
    );
  }
  state.events = state.events || [];
  state.events.push({
    id: nextId(state.events, "event"),
    type: "automation_circuit_reset",
    projectId: task?.projectId || project?.id || "",
    taskId: task?.id || "",
    message: `${task?.id || project?.id} automation circuit reset: ${target.automationCircuit.closeReason}`,
    createdAt: now,
  });
  return target;
}

export async function resetAutomationCircuit(input = {}) {
  if (input.task && !input.expectedSnapshot && !String(input.expectedOpenedAt || "").trim()) {
    throw new Error("Task circuit reset requires --expected-opened-at or an expected snapshot.");
  }
  return mutateState(async (state) => resetAutomationCircuitInState(state, input), {
    operationName: "automation.reset_circuit",
  });
}

export async function updateRun(runId, patch = {}) {
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (patch.status && !VALID_RUN_STATUSES.has(patch.status)) {
      throw new Error(`Invalid run status: ${patch.status}`);
    }
    if (patch.status && ACTIVE_RUN_STATUSES.has(patch.status) && WORKSPACE_TERMINAL_STATUSES.has(run.status)) {
      throw new Error("A terminal run cannot transition back to active; retries must create a new run.");
    }
    const allowed = [
      "status",
      "threadId",
      "notes",
      "provider",
      "outputPath",
      "lastMessagePath",
      "startedAt",
      "completedAt",
      "exitCode",
      "runnerPid",
      "externalNotifiedAt",
      "failureNotifiedAt",
      "notificationStatus",
      "notificationChannel",
      "notificationError",
      "notificationFailedAt",
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        run[key] = String(patch[key] || "").trim();
      }
    }
    run.updatedAt = new Date().toISOString();
    state.events = state.events || [];
    state.events.push({
      id: nextId(state.events, "event"),
      type: "run_updated",
      projectId: run.projectId || "",
      taskId: run.taskId || "",
      message: `${run.id} updated to ${run.status}`,
      createdAt: run.updatedAt,
    });
    return run;
  }, { operationName: "run.update" });
}

export function findProject(state, keyOrId) {
  if (!keyOrId) return null;
  return state.projects.find((project) => project.id === keyOrId || project.key === keyOrId) || null;
}

export function findTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

function validateTaskRelationships(state, taskId, parentTaskId, dependsOnTaskIds) {
  if (parentTaskId) {
    if (parentTaskId === taskId) throw new Error("A task cannot be its own parent.");
    if (!findTask(state, parentTaskId)) throw new Error(`Unknown parent task: ${parentTaskId}`);
    const seen = new Set([taskId]);
    let currentParentId = parentTaskId;
    while (currentParentId) {
      if (seen.has(currentParentId)) throw new Error("Task parent relationship would create a cycle.");
      seen.add(currentParentId);
      currentParentId = findTask(state, currentParentId)?.parentTaskId || "";
    }
  }
  for (const dependencyId of dependsOnTaskIds || []) {
    if (dependencyId === taskId) throw new Error("A task cannot depend on itself.");
    const dependency = findTask(state, dependencyId);
    if (!dependency) throw new Error(`Unknown dependency task: ${dependencyId}`);
    const task = taskId ? findTask(state, taskId) : null;
    if (task && task.projectId !== dependency.projectId) {
      throw new Error(`Cross-project dependency is not allowed: ${taskId} -> ${dependencyId}`);
    }
  }
  if (taskId) {
    const errors = dependencyGraphErrors(state, {
      ...findTask(state, taskId),
      dependsOnTaskIds,
    });
    if (errors.length) throw new Error(errors[0]);
  }
}

function stageSearchText(stage) {
  return [
    stage?.key,
    stage?.status,
    stage?.role,
    stage?.label,
  ].map((item) => String(item || "").toLowerCase().replaceAll("_", "-")).join(" ");
}

function isAccessibilityReviewStage(stage) {
  const text = stageSearchText(stage);
  return text.includes("accessibility") || text.includes("a11y");
}

function isFrontendReviewStage(stage) {
  return stageSearchText(stage).includes("frontend");
}

function reviewStagesWithDefaultAccessibility(stages) {
  if (!Array.isArray(stages) || !stages.length) return DEFAULT_REVIEW_PIPELINE;
  if (stages.some(isAccessibilityReviewStage) || !stages.some(isFrontendReviewStage)) return stages;
  const leadIndex = stages.findIndex(isLeadReviewStage);
  if (leadIndex === -1) return stages;
  const accessibilityStage = DEFAULT_REVIEW_PIPELINE.find((stage) => stage.key === "accessibility");
  return [
    ...stages.slice(0, leadIndex),
    { ...accessibilityStage },
    ...stages.slice(leadIndex),
  ];
}

export function reviewStagesForProject(project) {
  return reviewStagesWithDefaultAccessibility(project?.reviewPipeline || []);
}

export function reviewStagesForTask(project, task) {
  const routing = capabilityRoutingForTask(project, task);
  if (routing.policy.profile !== "prototype-fast-lane") return reviewStagesForProject(project);
  const allowed = new Set(routing.required);
  return reviewStagesForProject(project).filter((stage) => {
    const capability = capabilityForReviewStage(stage);
    return !capability || allowed.has(capability);
  });
}

export function reviewPolicyForProject(project) {
  return normalizeReviewPolicy(project?.reviewPolicy || {});
}

function findReviewStage(stages, value) {
  const normalized = String(value || "").toLowerCase().replaceAll("_", "-");
  return stages.find((stage) => {
    const keys = [
      stage.key,
      stage.status,
      stage.role,
      stage.label,
    ].map((item) => String(item || "").toLowerCase().replaceAll("_", "-"));
    return keys.includes(normalized) || keys.some((item) => item && normalized.includes(item));
  }) || null;
}

function currentReviewCycle(task) {
  return Number(task.reviewCycle || 0);
}

export function currentReviewCandidateCycle(task) {
  return Number(task.reviewSubjectCycle || task.reviewCycle || 0);
}

export function reviewMatchesCurrentCandidate(task, review) {
  if (review?.invalidatedAt || review?.invalidation) return false;
  const invalidatedIds = new Set((task.evidenceInvalidations || []).flatMap((entry) => entry.invalidationIds || []));
  if (invalidatedIds.has(review?.id)) return false;
  const reviewCycle = currentReviewCycle(task);
  if (Number(review?.cycle || 0) !== reviewCycle) return false;
  if (!task.reviewSubjectSha) {
    return !review?.candidateCycle || Number(review.candidateCycle) === currentReviewCandidateCycle(task);
  }
  return (
    currentReviewCandidateCycle(task) > 0
    && review?.subjectSha === task.reviewSubjectSha
    && Number(review?.candidateCycle || 0) === currentReviewCandidateCycle(task)
  );
}

export function latestCurrentReviewForStage(state, task, stage) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => reviewMatchesCurrentCandidate(task, review))
    .filter((review) => (
      review.stageKey
        ? review.stageKey === stage.key
        : Boolean(review.status) && review.status === stage.status
    ))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

export function earliestIncompleteRequiredReviewStage(state, project, task) {
  return reviewStagesForTask(project, task)
    .filter((stage) => stage.required !== false)
    .find((stage) => {
      const review = latestCurrentReviewForStage(state, task, stage);
      return !review || !REVIEW_COMPLETE_OUTCOMES.has(review.outcome);
    }) || null;
}

export function cycleLimitLeadReviewApplies(state, project, task, targetStage) {
  const policy = reviewPolicyForProject(project);
  const stages = reviewStagesForTask(project, task);
  const leadStage = stages.find(isLeadReviewStage) || stages[stages.length - 1] || null;
  if (
    !policy.leadOwnsFinalDecisionAtLimit
    || !leadStage
    || !targetStage
    || targetStage.key !== leadStage.key
    || currentReviewCycle(task) < policy.maxBuilderReviewCycles
  ) {
    return false;
  }
  return stages
    .filter((stage) => stage.key !== leadStage.key)
    .some((stage) => latestCurrentReviewForStage(state, task, stage)?.outcome === "changes_requested");
}

export function candidateReviewEvidenceForTask(state, task) {
  const project = findProject(state, task.projectId);
  if (!project) return { ok: false, error: `Task has missing project: ${task.projectId}` };
  const candidateCycle = currentReviewCandidateCycle(task);
  if (!currentReviewCycle(task) || !candidateCycle || !task.reviewSubjectSha) {
    return { ok: false, error: "Task has no exact review subject for its current candidate cycle." };
  }
  const requiredStages = reviewStagesForTask(project, task).filter((stage) => stage.required !== false);
  const reviews = [];
  for (const stage of requiredStages) {
    const review = latestCurrentReviewForStage(state, task, stage);
    if (!review || !REVIEW_COMPLETE_OUTCOMES.has(review.outcome)) {
      return { ok: false, error: `Required ${stage.label || stage.key} is not complete for the current subject SHA.` };
    }
    if (isLeadReviewStage(stage) && review.outcome !== "approved") {
      return { ok: false, error: "Primary lead review must be approved for the current subject SHA." };
    }
    if (
      review.subjectSha !== task.reviewSubjectSha
      || Number(review.candidateCycle) !== candidateCycle
    ) {
      return { ok: false, error: `Required ${stage.label || stage.key} is bound to stale candidate evidence.` };
    }
    reviews.push({
      id: review.id,
      stageKey: review.stageKey,
      role: review.role,
      outcome: review.outcome,
      subjectSha: review.subjectSha,
      candidateCycle: review.candidateCycle,
      reviewedAt: review.createdAt,
    });
  }
  return {
    ok: true,
    subjectSha: task.reviewSubjectSha,
    candidateCycle,
    reviews,
  };
}

function isLeadReviewStage(stage) {
  const key = String(stage?.key || "").toLowerCase();
  const role = String(stage?.role || "").toLowerCase();
  return key === "lead" || role.includes("lead");
}

function leadReviewStageForProject(project, task) {
  const stages = reviewStagesForTask(project, task);
  return stages.find(isLeadReviewStage) || stages[stages.length - 1] || null;
}

function reviewCycleAtLimit(project, task) {
  return currentReviewCycle(task) >= reviewPolicyForProject(project).maxBuilderReviewCycles;
}

function changeRequestedReviewsForCycle(state, task) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => reviewMatchesCurrentCandidate(task, review))
    .filter((review) => review.outcome === "changes_requested");
}

function leadReviewCompleteForCycle(state, task, project) {
  const leadStage = leadReviewStageForProject(project, task);
  if (!leadStage) return false;
  const latestReview = latestCurrentReviewForStage(state, task, leadStage);
  return latestReview?.outcome === "approved";
}

function shouldEscalateChangesToLead(project, task, stage) {
  const policy = reviewPolicyForProject(project);
  return policy.leadOwnsFinalDecisionAtLimit
    && reviewCycleAtLimit(project, task)
    && !isLeadReviewStage(stage)
    && leadReviewStageForProject(project, task);
}

function dependencyTasks(state, task) {
  return (task.dependsOnTaskIds || [])
    .map((id) => findTask(state, id))
    .filter(Boolean);
}

function incompleteDependencies(state, task) {
  return dependencyTasks(state, task).filter((dependency) => !DEPENDENCY_COMPLETE_STATUSES.has(dependency.status));
}

function addAutomationComment(state, task, body, now, author = "StudioOps Automation") {
  const exists = (state.comments || []).some((comment) => (
    comment.taskId === task.id
    && comment.author === author
    && comment.body === body
  ));
  if (exists) return false;
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId: task.id,
    author,
    body,
    createdAt: now,
  });
  return true;
}

function setTaskWorkflowState(state, task, patch, now, options = {}) {
  const aggregateBeforePatch = structuredClone(task);
  const previousStatus = task.status;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "status") continue;
    task[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status") && patch.status !== previousStatus) {
    applyStoreLifecycleTransition(state, task, patch.status, {
      ...options,
      now,
      evidence: { ...(options.evidence || {}), targetStatus: patch.status },
    });
  } else if (lifecycleEvidenceChanged(aggregateBeforePatch, task)) {
    applyStoreLifecycleTransition(state, task, task.status, {
      action: options.action || "mutate_assignment",
      now,
      force: true,
      evidence: options.evidence,
    });
  }
  task.updatedAt = now;
  state.events.push({
    id: nextId(state.events, "event"),
    type: "workflow_state_changed",
    projectId: task.projectId,
    taskId: task.id,
    message: `Task moved to ${task.status}: ${task.title}`,
    createdAt: now,
  });
}

function restartReviewsForSubjectChange(state, task, project, previousSha, subjectSha, now, options = {}) {
  const candidateIdentityChanged = options.candidateIdentityChanged === true;
  const candidateIdentityIncomplete = options.candidateIdentityIncomplete === true;
  if (!options.preserveCandidateCycle) {
    task.reviewSubjectCycle = Math.max(
      currentReviewCandidateCycle(task),
      currentReviewCycle(task),
    ) + 1;
  }
  supersedeRemediationHandoff(task, {
    now,
    replacementSubjectSha: subjectSha,
    resolution: options.candidateIdentityChanged
      ? "Candidate identity changed after review."
      : "Review subject SHA changed after remediation.",
  });
  for (const candidate of state.candidates || []) {
    if (
      candidate.invalidation
      || !(candidate.manifest?.sources || []).some((source) => source.taskId === task.id)
    ) {
      continue;
    }
    invalidateCandidate(candidate, {
      reason: candidateIdentityChanged
        ? `Task ${task.id} candidate identity changed after candidate assembly.`
        : `Task ${task.id} review subject changed after candidate assembly.`,
      expected: previousSha,
      observed: subjectSha,
      invalidatedAt: now,
    });
    const bundle = (state.qaBundles || []).find((item) => item.id === candidate.qaBundleId);
    if (bundle) {
      bundle.status = "invalidated";
      bundle.updatedAt = now;
    }
  }
  task.candidateId = "";
  task.qaBundleId = "";
  task.integrationStatus = "";
  task.qaDecision = null;
  task.promotionStatus = "";
  const firstRequiredStage = reviewStagesForTask(project, task)
    .find((stage) => stage.required !== false);
  if (candidateIdentityIncomplete) {
    setTaskWorkflowState(state, task, {
      status: "needs_changes",
      assignedAgentRole: "builder",
      reviewerThreadId: "",
    }, now);
  } else if (firstRequiredStage) {
    setTaskWorkflowState(state, task, {
      status: firstRequiredStage.status,
      assignedAgentRole: firstRequiredStage.role,
      reviewerThreadId: "",
    }, now, { action: "restart_review" });
  }
  for (const run of state.runs || []) {
    if (
      run.taskId === task.id
      && run.group === "reviewer"
      && run.status === "queued"
    ) {
      run.status = "cancelled";
      run.notes = candidateIdentityChanged
        ? "Cancelled before start because the candidate identity changed."
        : `Cancelled before start because the review subject changed from ${previousSha} to ${subjectSha}.`;
      run.updatedAt = now;
    }
  }
  addAutomationComment(
    state,
    task,
    candidateIdentityChanged
      ? `Candidate identity changed while the subject SHA remained ${subjectSha}. Prior candidate-cycle approvals and capability skips are stale, so StudioOps ${candidateIdentityIncomplete ? "returned the task to the builder because the candidate identity is incomplete" : `restarted at ${firstRequiredStage?.label || firstRequiredStage?.key || "the first required review lane"}`} with candidate cycle ${task.reviewSubjectCycle}. The builder review cycle remains ${currentReviewCycle(task)}.`
      : `Review subject changed from ${previousSha} to ${subjectSha}. Prior candidate-cycle approvals are stale, so StudioOps restarted at ${firstRequiredStage?.label || firstRequiredStage?.key || "the first required review lane"} with candidate cycle ${task.reviewSubjectCycle}. The builder review cycle remains ${currentReviewCycle(task)}.${options.preserveCandidateCycle ? " The verified tree, base, branch, and impact evidence are unchanged, so this metadata-only repair did not consume a candidate cycle." : ""}`,
    now,
  );
  state.events.push({
    id: nextId(state.events, "event"),
    type: candidateIdentityChanged ? "candidate_identity_changed" : "review_subject_changed",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title}: ${candidateIdentityChanged ? "candidate identity" : "review subject"} changed and required reviews restarted`,
    createdAt: now,
  });
}

function moveTaskToOwnerReview(state, task, now, author, body, actions, actionLabel = "ready for owner review", transitionOptions = {}) {
  if (task.status !== "user_review" || task.assignedAgentRole !== "owner") {
    setTaskWorkflowState(state, task, {
      status: "user_review",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
    }, now, transitionOptions);
  }
  addAutomationComment(state, task, body, now, author);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "owner_review_requested",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title} is ready for human owner review.`,
    createdAt: now,
  });
  actions.push(`${task.id}: ${actionLabel}`);
  return actions;
}

function moveTaskToQaReview(state, task, project, now, author, body, actions, actionLabel = "ready for QA review") {
  const integrationBranch = integrationBranchName(project);
  const integrationBranchUrl = branchWebUrl(project, integrationBranch);
  if (task.status !== "qa_review" || task.assignedAgentRole !== "owner") {
    setTaskWorkflowState(state, task, {
      status: "qa_review",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
      integrationStatus: task.integrationStatus || "pending",
      integrationBranch,
      integrationBranchUrl,
    }, now);
  }
  addAutomationComment(
    state,
    task,
    `${body} Lead-approved work is eligible for immutable candidate assembly and local QA. ${integrationBranch} remains a policy namespace; each QA candidate receives a unique branch.${integrationBranchUrl ? `\n\nQA branch namespace: ${integrationBranchUrl}` : ""}`,
    now,
    author,
  );
  state.events.push({
    id: nextId(state.events, "event"),
    type: "qa_review_requested",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title} is ready for QA integration.`,
    createdAt: now,
  });
  actions.push(`${task.id}: ${actionLabel}`);
  return actions;
}

function moveTaskAfterReviewsComplete(state, task, project, now, author, body, actions) {
  if (projectUsesTrustLeadQa(project)) {
    return moveTaskToQaReview(state, task, project, now, author, body, actions, "ready for QA integration");
  }

  if (trustLeadApprovalsEnabled(project)) {
    const reason = integrationBranchSafetyError(project);
    if (reason) {
      addAutomationComment(
        state,
        task,
        `Trust Leads QA integration is enabled, but this project is not eligible for QA branch routing: ${reason} Routing to human owner review without touching an integration branch.`,
        now,
        author,
      );
    }
  }

  return moveTaskToOwnerReview(state, task, now, author, body, actions);
}

function routeChangesRequestedInState(state, task, project, stage, now, author, actions) {
  const policy = reviewPolicyForProject(project);
  const stageLabel = stage.label || stage.key;

  if (policy.leadOwnsFinalDecisionAtLimit && reviewCycleAtLimit(project, task)) {
    const leadStage = leadReviewStageForProject(project, task);
    if (leadStage && !isLeadReviewStage(stage)) {
      setTaskWorkflowState(state, task, {
        status: leadStage.status,
        assignedAgentRole: leadStage.role,
        reviewerThreadId: "",
      }, now, {
        action: "route_review",
        evidence: { gateOverride: "cycle_limit_lead_decision" },
      });
      addAutomationComment(
        state,
        task,
        `${stageLabel} requested changes on review cycle ${currentReviewCycle(task)}, which reached the configured ${policy.maxBuilderReviewCycles}-cycle builder review limit. Routing to ${leadStage.label || leadStage.key} for final decision instead of sending this back into another builder loop.`,
        now,
        author,
      );
      actions.push(`${task.id}: review cycle limit reached, routed to ${leadStage.role}`);
      return actions;
    }

    if (isLeadReviewStage(stage)) {
      return moveTaskToOwnerReview(
        state,
        task,
        now,
        author,
        `${stageLabel} requested changes after the configured ${policy.maxBuilderReviewCycles}-cycle builder review limit. Human owner review is required for the final call; this was not auto-approved.`,
        actions,
        "lead requested human owner decision after review limit",
        { action: "escalate_cycle_limit_owner_review" },
      );
    }
  }

  setTaskWorkflowState(state, task, {
    status: "needs_changes",
    assignedAgentRole: "builder",
    reviewerThreadId: "",
  }, now);
  actions.push(`${task.id}: returned to builder after ${stage.key} review`);
  return actions;
}

function advanceTaskWorkflowInState(state, task, options = {}) {
  const now = options.now || new Date().toISOString();
  const author = options.author || "StudioOps Automation";
  const actions = [];
  const project = findProject(state, task.projectId);
  if (!project) return actions;

  const hasChildren = (state.tasks || []).some((candidate) => candidate.parentTaskId === task.id);
  if (task.type === "epic" || hasChildren) return actions;

  const missingDependencies = incompleteDependencies(state, task);
  if (missingDependencies.length) {
    if (["ready", "queued", "in_progress"].includes(task.status)) {
      setTaskWorkflowState(state, task, {
        status: "blocked",
        assignedAgentRole: "",
        reviewerThreadId: "",
      }, now);
      const body = `Blocked by unfinished dependencies: ${missingDependencies.map((item) => `${item.id} (${item.status})`).join(", ")}. Automation will re-check this task on later ticks.`;
      addAutomationComment(state, task, body, now, author);
      actions.push(`${task.id}: blocked by dependencies`);
    }
    return actions;
  }

  if (task.status === "blocked") {
    if (task.automationBlocker) {
      return actions;
    }
    const body = "Dependencies are now complete. Automation returned this task to the builder queue.";
    addAutomationComment(state, task, body, now, author);
    setTaskWorkflowState(state, task, {
      status: "queued",
      assignedAgentRole: "",
      reviewerThreadId: "",
    }, now);
    actions.push(`${task.id}: unblocked`);
  }

  if (["ready", "queued"].includes(task.status)) {
    return actions;
  }

  if (task.status === "needs_changes") {
    if (!task.assignedAgentRole) {
      setTaskWorkflowState(state, task, {
        assignedAgentRole: "builder",
        reviewerThreadId: "",
      }, now);
      actions.push(`${task.id}: reassigned to builder for changes`);
    }
    return actions;
  }

  const stages = reviewStagesForTask(project, task);
  if (task.status === "builder_review") {
    if (!task.reviewCycle) task.reviewCycle = 1;
    const projectWorkflowMode = String(project.workflowMode || "").toLowerCase();
    const localWorkflow = projectUsesLocalWorkflow(project);
    const candidateIdentity = candidateIdentityForTask(task);
    const missingCandidateIdentity = !candidateIdentityIsComplete(candidateIdentity);
    const requiresVerifiedCandidateIdentity = normalizeDeliveryPolicy(project.deliveryPolicy).profile === "prototype-fast-lane";
    const exactSubjectMissing = (localWorkflow || projectWorkflowMode === "github")
      && !taskHasExactReviewSubject(task);
    const missingIntake = !task.branchName
      || (localWorkflow ? !taskHasExactReviewSubject(task) : !task.prUrl)
      || exactSubjectMissing
      || (requiresVerifiedCandidateIdentity && missingCandidateIdentity);
    if (missingIntake) {
      setTaskWorkflowState(state, task, {
        status: "needs_changes",
        assignedAgentRole: "builder",
        reviewerThreadId: "",
      }, now, { action: "reject_builder_intake" });
      const intakeMessage = exactSubjectMissing
        ? "Builder review failed intake: task needs a feature branch and exact full subject SHA before reviewers can start."
        : requiresVerifiedCandidateIdentity
          ? "Builder review failed intake: the prototype fast lane needs a feature branch and verified candidate identity (commit, tree, base, branch, cycle, and current impact evidence) before reviewers can start."
          : "Builder review failed intake: task needs a feature branch and PR URL before reviewers can start.";
      addAutomationComment(state, task, intakeMessage, now, author);
      actions.push(`${task.id}: incomplete review intake, returned to builder`);
      return actions;
    }
    return routeToNextReviewStage(state, task, stages, now, author, actions);
  }

  const currentStage = findReviewStage(stages, task.status);
  if (currentStage) {
    const latestReview = latestCurrentReviewForStage(state, task, currentStage);
    if (!latestReview) {
      if (task.assignedAgentRole !== currentStage.role) {
        setTaskWorkflowState(state, task, {
          assignedAgentRole: currentStage.role,
          reviewerThreadId: "",
        }, now);
        actions.push(`${task.id}: assigned to ${currentStage.role}`);
      }
      return actions;
    }
    if (latestReview.outcome === "changes_requested") {
      return routeChangesRequestedInState(state, task, project, currentStage, now, author, actions);
    }
    return routeToNextReviewStage(state, task, stages, now, author, actions);
  }

  return actions;
}

function routeToNextReviewStage(state, task, stages, now, author, actions) {
  const project = findProject(state, task.projectId);
  const routing = capabilityRoutingForTask(project || {}, task);
  state.reviews = state.reviews || [];
  const skippedCapabilities = new Set(routing.skipped.map((skipped) => skipped.stageKey));
  const skippedStages = reviewStagesForProject(project)
    .filter((stage) => skippedCapabilities.has(capabilityForReviewStage(stage)));
  for (const skipped of skippedStages) {
    if (!task.reviewSubjectSha || !currentReviewCandidateCycle(task)) continue;
    const alreadyRecorded = (state.reviews || []).some((review) => (
      review.taskId === task.id
      && review.stageKey === skipped.key
      && review.subjectSha === task.reviewSubjectSha
      && Number(review.candidateCycle) === currentReviewCandidateCycle(task)
    ));
    if (alreadyRecorded) continue;
    state.reviews.push({
      id: nextId(state.reviews, "review"), taskId: task.id, projectId: task.projectId,
      cycle: currentReviewCycle(task), candidateCycle: currentReviewCandidateCycle(task),
      subjectSha: task.reviewSubjectSha, stageKey: skipped.key, status: skipped.status,
      role: skipped.role, outcome: "skipped", author: "StudioOps Routing",
      body: "Capability is inapplicable under the prototype-fast-lane policy.", createdAt: now,
    });
  }
  if (
    project
    && reviewCycleAtLimit(project, task)
    && changeRequestedReviewsForCycle(state, task).length
    && leadReviewCompleteForCycle(state, task, project)
  ) {
    return moveTaskAfterReviewsComplete(
      state,
      task,
      project,
      now,
      author,
      "Lead review finalized this task after the configured review-cycle limit. Residual risk should be captured in review comments.",
      actions,
    );
  }

  for (const stage of stages) {
    const latestReview = latestCurrentReviewForStage(state, task, stage);
    if (latestReview?.outcome === "changes_requested" && project && shouldEscalateChangesToLead(project, task, stage)) {
      return routeChangesRequestedInState(state, task, project, stage, now, author, actions);
    }
    if (!latestReview || latestReview.outcome === "changes_requested") {
      if (task.status !== stage.status || task.assignedAgentRole !== stage.role) {
        setTaskWorkflowState(state, task, {
          status: stage.status,
          assignedAgentRole: stage.role,
          reviewerThreadId: "",
        }, now);
        addAutomationComment(state, task, `Routed to ${stage.label || stage.key}. Reviewer should record approved, skipped, or changes_requested for this review cycle.`, now, author);
        actions.push(`${task.id}: routed to ${stage.role}`);
      }
      return actions;
    }
  }

  if (task.status !== "user_review") {
    moveTaskAfterReviewsComplete(
      state,
      task,
      project,
      now,
      author,
      "All required review stages for this cycle are complete.",
      actions,
    );
  }
  return actions;
}

export function taskWithProject(state, task) {
  return {
    ...task,
    project: state.projects.find((project) => project.id === task.projectId) || null,
    parent: state.tasks.find((item) => item.id === task.parentTaskId) || null,
    children: state.tasks.filter((item) => item.parentTaskId === task.id),
    dependencies: state.tasks.filter((item) => (task.dependsOnTaskIds || []).includes(item.id)),
    comments: state.comments.filter((comment) => comment.taskId === task.id),
    runs: (state.runs || []).filter((run) => run.taskId === task.id),
    reviews: state.reviews.filter((review) => review.taskId === task.id),
    currentRemediationHandoff: currentRemediationHandoff(task),
  };
}

export function functionalDeliveryContract(task = {}) {
  const mode = normalizeDeliveryMode(task.deliveryMode);
  if (mode === "visual-only") {
    return [
      "Delivery mode: visual-only (explicitly scoped)",
      "- Match the supplied visual direction and responsive intent.",
      "- Do not imply that inert controls, fixture data, or placeholder routes are functional.",
      "- Disable or visibly label non-functional interactions, and record the functional follow-up tasks.",
    ].join("\n");
  }
  const prototypeNote = mode === "prototype"
    ? "- A prototype may use local/dev-only adapters, but its limitations must be explicit and production paths must not silently use fixtures."
    : "- Production-shaped behavior is the default; fixtures are allowed only as explicit seeds or development adapters, not as the completed runtime data source.";
  return [
    `Delivery mode: ${mode}`,
    "- A mockup is evidence of presentation and interaction intent; it is not authorization to deliver a static replica.",
    "- Inventory every visible control, route, data region, and state. Primary controls must execute real behavior or be explicitly disabled and labeled as unavailable.",
    "- Define the client/server boundary, source of truth, persistence lifecycle, authorization boundary, and loading/empty/error/retry states for every data-bearing surface.",
    "- Durable user outcomes must survive refresh and process restart. Use migrations, indexes, bounded queries, pagination/limits, and cache or queue infrastructure only when the workload justifies them.",
    "- Keep payloads and rendering work bounded. Record performance budgets or query/response evidence for the core path.",
    "- Run the product locally as a coherent vertical slice and add executable validation that proves the core behavior, not only that components render.",
    prototypeNote,
  ].join("\n");
}

export function modularArchitectureAndValidationContract() {
  return [
    "- Assign every changed source path, route, table, migration, job, event, workflow, deploy surface, and test to one bounded component or an explicitly shared classification.",
    "- For each affected component, identify its owner, public contracts and adapters, owned data, allowed dependency direction, rollback/compatibility boundary, and owned unit, contract, persistence, adapter/browser, and composition test layers.",
    "- Keep business policy in one authoritative component. Reject duplicated policy, god modules, cross-component internal imports or raw data access, dependency cycles, and unowned release-sensitive surfaces.",
    "- Prefer a modular monolith. Microservices, extra databases, brokers, queues, and caches require measured isolation, scale, durability, consistency, or reliability evidence.",
    "- Select validation deterministically from the base/head diff plus an executable ownership and dependency manifest; path-ignore rules alone are not an impact model.",
    "- Fail closed to full regression for shared-kernel, public-contract, identity, authorization, consent, safety, entitlement, schema/migration, event-version, composition-root, dependency/workflow/deployment, multi-component, ambiguous, or unclassified changes.",
    "- Use one stable required aggregate check for selected jobs. A selected failure or cancellation fails it; intentionally unselected components remain neutral and visible.",
    "- Do not emit equivalent push and pull-request validation runs for the same feature head. Protected integration commits retain one complete exact-SHA regression attestation.",
    "- Exact-SHA evidence must bind the source SHA, ownership/dependency manifest digest, selected components, commands, outcomes, durations, retries/skips, environment contract, and artifact digests.",
    "- Promotion and release may reuse successful evidence only when every binding still matches, followed by a concise cross-system smoke. Missing, stale, cross-SHA, malformed, unsuccessful, or environment-mismatched evidence requires full regression and blocks release until valid.",
    "- Impact scoping is additive to project-specific security, privacy, safety, rollback, and release gates; it never waives or narrows them.",
  ].join("\n");
}

function systemsArchitectPrompt(task, project, context) {
  const completionCommand = `node <STUDIOOPS_CLI_PATH> architecture-complete ${task.id} --body "..." --task-ids "task_..."`;
  return `You are the systems architect for StudioOps task ${task.id}.

Model requirement: gpt-5.6-sol
Reasoning requirement: xhigh

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Task type: ${task.type || "feature"}
Parent epic/task: ${context.parent ? `${context.parent.id}: ${context.parent.title}` : "(none)"}

Task:
${task.title}

Description:
${task.description || "(none)"}

User story:
${task.userStory || "(not recorded)"}

Expected outcome:
${task.expectedOutcome || "(not recorded)"}

Supplied assets and context:
${context.attachments}

Acceptance criteria:
${context.criteria}

Project context:
${context.projectContext}

Project standards:
${context.standards}

Project safety rules:
${context.safety}

Modular architecture and impact-scoped validation contract:
${modularArchitectureAndValidationContract()}

Architecture mandate:
- Inspect the actual repository and every supplied mockup, screenshot, logo, and reference before proposing work. Inventory canonical assets and name the exact asset builders must use; never redraw or substitute a supplied logo without an explicit product decision.
- Decompose the experience into functional slices: navigation, screens/components, user interactions, state transitions, data-bearing regions, background work, administration, and failure/recovery paths.
- Define the smallest modern architecture that meets the evidence. Do not add Redis, queues, fanout, services, or caches by fashion; add each only for a stated latency, throughput, consistency, isolation, durability, or operational requirement.
- Define server/runtime boundaries, data ownership, durable persistence, schema and migrations, indexes, query shapes, pagination/limits, API contracts, event/job contracts, cache policy, invalidation, and idempotency where relevant.
- Define authentication, authorization, privacy/consent, secrets, abuse controls, retention, backups/recovery, observability, and audit behavior.
- Define performance budgets: critical payload sizes, query counts, rendering/loading strategy, concurrency assumptions, and what will be measured.
- Define loading, empty, error, offline/retry, and degraded states—not only the happy-path mockup.
- Define the local development and QA path, including seed data, services, health checks, and end-to-end smoke coverage.
- Define bounded component ownership, public contracts, data ownership, dependency direction, rollback boundaries, owned test layers, and the deterministic ownership/dependency manifest that carries those decisions into every child task.
- Define component-only, full-integration, pre-deploy evidence/smoke, total-release-time, and duplicate-workflow-count baselines and target budgets.
- Design one authoritative pull-request validation path and one stable aggregate check. Ambiguous or shared impact must fail closed to full regression, and protected integration evidence must be reusable only at the exact immutable SHA.
- Capture material decisions and rejected alternatives with concise reasons.
- Break broad work into dependency-linked StudioOps child tasks. Each child must include the architectural constraints it consumes, observable acceptance criteria, validation commands/expectations, correct attachments, a narrow lane/work area, \`--parent ${task.id}\`, and \`--architecture-approved\`.
- Preserve a single coherent architecture across those child tasks. Builders must not independently reinvent infrastructure or data contracts.

Required durable handoff:
1. Create or update the implementation child tasks through the StudioOps CLI.
2. Record a substantive architecture summary and the implementation task IDs with:
   \`${completionCommand}\`
3. At least one governed child task is mandatory for every architecture completion. The child stays non-buildable until this command atomically validates and approves the complete graph.
4. Do not edit product code, open a PR, merge, or deploy. Your deliverable is the durable architecture and executable task graph.

${functionalDeliveryContract(task)}
`;
}

export function generatePrompt(state, taskId, role = "builder") {
  const task = findTask(state, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const project = findProject(state, task.projectId);
  if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
  const criteria = (task.acceptanceCriteria || []).map((item) => `- ${item}`).join("\n") || "- No acceptance criteria recorded yet.";
  const parent = task.parentTaskId ? findTask(state, task.parentTaskId) : null;
  const dependencies = (task.dependsOnTaskIds || [])
    .map((id) => findTask(state, id))
    .filter(Boolean)
    .map((item) => `- ${item.id}: ${item.title}`)
    .join("\n") || "- None recorded.";
  const attachments = renderAttachments(task.attachments);
  const validation = (project.validationCommands || []).map((item) => `- \`${item}\``).join("\n") || "- No validation command recorded.";
  const safety = (project.safetyRules || []).map((item) => `- ${item}`).join("\n") || "- No project-specific safety rules recorded.";
  const context = (project.contextLinks || []).map((item) => `- ${item}`).join("\n") || "- README.md";
  const standards = (project.standards || []).map((item) => `- ${standardReference(item)}`).join("\n") || "- No project-specific standards recorded.";
  const reviewStages = reviewStagesForProject(project);
  const reviewPolicy = reviewPolicyForProject(project);
  const reviewPipeline = reviewStages.length
    ? reviewStages
        .map((stage) => `- ${stage.label || stage.key} (${stage.role})${stage.required ? "" : " optional"}: ${stage.description || stage.status || "No description recorded."}`)
        .join("\n")
    : "- Builder review -> domain review when relevant -> accessibility review for UI work -> lead review -> user review.";
  const reviewPolicyText = [
    `- Maximum routine builder review cycles: ${reviewPolicy.maxBuilderReviewCycles}`,
    `- Reviewers may fix small deterministic issues directly: ${reviewPolicy.reviewerMayFixSmallIssues ? "yes" : "no"}`,
    `- Lead owns final decision at the cycle limit: ${reviewPolicy.leadOwnsFinalDecisionAtLimit ? "yes" : "no"}`,
    `- Trust lead approvals after review completion: ${reviewPolicy.trustLeadApprovals ? "yes, route to QA review instead of per-task owner review" : "no, route to owner review"}`,
    `- Lead-approved integration branch: ${reviewPolicy.integrationBranch || "(not configured)"}`,
  ].join("\n");
  const remediationHandoff = remediationPromptSection(task);

  if (role === "systems-architect" || role === "architect") {
    return systemsArchitectPrompt(task, project, {
      parent,
      attachments,
      criteria,
      projectContext: context,
      standards,
      safety,
    });
  }

  const normalizedRole = String(role || "").toLowerCase().replaceAll("_", "-");
  if (normalizedRole === "release" || normalizedRole.includes("release-manager") || normalizedRole.includes("promotion")) {
    return `You are the release manager for StudioOps task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Protected integration branch: ${reviewPolicy.integrationBranch || "(not configured)"}
Release subject SHA: ${task.reviewSubjectSha || "(not recorded)"}
Feature branch: ${task.branchName || "(not recorded)"}
PR: ${task.prUrl || "(not recorded)"}

Task:
${task.title}

Acceptance criteria:
${criteria}

Project safety rules:
${safety}

Project standards:
${standards}

Configured validation commands:
${validation}

Modular architecture and impact-scoped validation contract:
${modularArchitectureAndValidationContract()}

Release instructions:
- Verify the release or tag SHA is reachable from the protected integration branch and exactly matches the successful QA attestation subject.
- Reuse the complete regression attestation only when its exact SHA, ownership/dependency manifest digest, selected-component set, environment contract, commands, and artifact digests still match.
- When the attestation remains valid, run only concise provenance, health, authorization/wiring, and cross-system smoke checks; do not repeat an unchanged full suite.
- Missing, stale, malformed, cross-SHA, failed, or environment-mismatched evidence blocks promotion or release and requires a new complete regression.
- Preserve every project-specific approval, backup, rollback, security, privacy, safety, and non-destructive deployment gate. Evidence reuse never authorizes production deployment by itself.
- Do not merge, tag, deploy, or waive a gate without the explicit human authorization required by the project workflow.
`;
  }

  if (role !== "builder") {
    const reviewerStage = reviewStages.find((stage) => stage.role === role) || null;
    const reviewerProfile = reviewerProfileForRole(role, reviewerStage);
    return `You are the ${reviewerProfile.label} for StudioOps task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Feature branch: ${task.branchName || "(not recorded)"}
PR: ${task.prUrl || "(not recorded)"}
Review subject SHA: ${task.reviewSubjectSha || "(not recorded)"}
Task type: ${task.type || "task"}
Work lane: ${task.lane || task.area || "(inferred by StudioOps)"}
Work areas:
${(task.workAreas || []).map((item) => `- ${item}`).join("\n") || "- Not explicitly scoped."}
Review cycle: ${currentReviewCycle(task)}
Candidate cycle: ${currentReviewCandidateCycle(task)}
Parent epic/task: ${parent ? `${parent.id}: ${parent.title}` : "(none)"}

Task:
${task.title}

Description:
${task.description || "(none)"}

User story:
${task.userStory || "(not recorded)"}

Expected outcome:
${task.expectedOutcome || "(not recorded)"}

Visual/context attachments:
${attachments}

Dependencies:
${dependencies}

Acceptance criteria:
${criteria}

Project safety rules:
${safety}

Project standards:
${standards}

Review pipeline:
${reviewPipeline}

Review loop policy:
${reviewPolicyText}

Current reviewer remediation handoff:
${remediationHandoff}

Functional delivery contract:
${functionalDeliveryContract(task)}

Modular architecture and impact-scoped validation contract:
${modularArchitectureAndValidationContract()}

Review instructions:
- Review as a senior engineer in the ${reviewerProfile.domain} lane.
- Use \`show-task ${task.id}\` (or \`--json\`) only for read-only task inspection. Use \`status ${task.id} --status <canonical-status>\` only for an intentional status mutation; never omit \`--status\`.
- Lead with concrete findings ordered by severity.
- Focus especially on:
${reviewerProfile.focus.map((item) => `  - ${item}`).join("\n")}
- Still check scope, behavior, tests, security, privacy, and maintainability.
- Check the listed project standards and fail the task for material violations.
- Reject god modules, duplicated policy, cross-component internal imports or raw data access, dependency cycles, unowned release surfaces, ambiguous impact classified as narrow, and unjustified microservice or database proliferation.
- Verify the builder's exact-SHA evidence identifies changed and transitively affected components, the deterministic classifier input/output, selected commands, outcomes, timings, and any full-regression escalation.
- For data/backend changes, check query shape, indexes, pagination, migrations, and privacy boundaries.
- For frontend/UI changes, check responsive behavior, accessibility, visual hierarchy, component reuse, content editability, and browser console/runtime errors.
- For accessibility review, check color contrast, readable typography, focus-visible states, keyboard tab order, semantic headings, link and button names, alt text, title text, form labels, ARIA use, and screen-reader basics across mobile, tablet, and desktop.
- For consent-sensitive features, check opt-in, revocation, transparency, retention, and data minimization.
- For deployment/release workflow changes, fail unsafe patterns where PR merges or integration branch pushes deploy production by default, release/tag deploys do not verify the commit is reachable from the protected integration branch, manual dispatch can mutate production without a dry-run/preview default and explicit emergency approval path, or production sync can broadly delete runtime state.
- Confirm whether the acceptance criteria are met.
- Confirm the task has branch/PR context and builder notes when implementation work was done.
- Confirm whether this PR has one primary task or intentionally covers multiple tasks. If it covers multiple tasks, verify each linked task has clear complete/partial scope notes.
- If you find small deterministic issues and the project policy allows reviewer fixes, fix them directly on the PR branch, run relevant validation, comment with exactly what changed, then continue the review.
- If a reviewer fix changes the source SHA, update the task's review subject to the new full SHA. StudioOps will preserve the builder review cycle, advance the candidate cycle, invalidate prior-candidate approvals, and restart at the earliest required review lane. Do not record a later-lane approval until automation routes the new candidate back to that lane.
- Use \`changes_requested\` only for material, risky, ambiguous, security/privacy-sensitive, or product-shaping problems that should not be quietly fixed inside review.
- Do not create an endless builder-review loop. If this is review cycle ${reviewPolicy.maxBuilderReviewCycles} or later, routine bounce-backs are exhausted.
- At or beyond the review-cycle limit, non-lead reviewers should record \`changes_requested\` only for material unresolved issues; StudioOps will route the task to lead review for the final decision.
- At or beyond the review-cycle limit, the lead reviewer should make the final call: fix and approve, approve with residual risk documented, or hand the task to the human owner if it is unsafe or genuinely blocked. Do not send it back for another routine builder pass.
- Record the result with \`studioops review ${task.id} --stage ${reviewerProfile.stageHint} --subject-sha ${task.reviewSubjectSha || "<full-head-sha>"} --candidate-cycle ${currentReviewCandidateCycle(task) || "<candidate-cycle>"} --outcome approved|skipped|changes_requested --body "..."\`
- Use \`changes_requested\` for material issues and include concrete findings.
- Use \`skipped\` only when this review lane truly has no relevant surface.
- Use \`approved\` when this lane is complete, with validation reviewed and residual risk summarized.
`;
  }

  return `You are the builder for StudioOps task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Default branch: ${project.defaultBranch || "main"}
Suggested branch: ${task.branchName || `codex/${project.key}-${task.id}-${slugify(task.title)}`}
Task type: ${task.type || "task"}
Work lane: ${task.lane || task.area || "(inferred by StudioOps)"}
Work areas:
${(task.workAreas || []).map((item) => `- ${item}`).join("\n") || "- Not explicitly scoped."}
Review cycle: ${currentReviewCycle(task)}
Parent epic/task: ${parent ? `${parent.id}: ${parent.title}` : "(none)"}

Before editing:
- Read project context:
${context}
- Read project standards:
${standards}
- Follow project safety rules:
${safety}

Review loop policy:
${reviewPolicyText}

Current reviewer remediation handoff:
${remediationHandoff}

Task:
${task.title}

Description:
${task.description || "(none)"}

User story:
${task.userStory || "(not recorded)"}

Expected outcome:
${task.expectedOutcome || "(not recorded)"}

Visual/context attachments:
${attachments}

Dependencies:
${dependencies}

Acceptance criteria:
${criteria}

Validation commands:
${validation}

Functional delivery contract:
${functionalDeliveryContract(task)}

Modular architecture and impact-scoped validation contract:
${modularArchitectureAndValidationContract()}

Builder instructions:
- Use 'show-task ${task.id}' (or '--json') for read-only task inspection. Use 'status ${task.id} --status builder_review --subject-sha <full-head-sha>' for the builder handoff so the exact SHA is persisted atomically; use 'status ${task.id} --status <canonical-status>' for other intentional status mutations; never omit '--status'.
- Create or switch to the feature branch.
- For UI or bug tasks, inspect referenced images, screenshots, and mockups before editing.
- For UI tasks, implement and verify mobile, tablet, and desktop behavior unless the task explicitly scopes one breakpoint only.
- For repeated UI, prefer shared components/templates and Sass tokens/mixins/classes over page-specific copies.
- For data/backend tasks, consider query shape, indexes, pagination, migrations, and realistic data volume.
- For location, auth, social, notification, behavioral analytics, personalization, AI training, or persuasion/coaching features, define the consent path, opt-out/revocation behavior, data minimization, and privacy notes before implementation.
- For deployment/release tasks, keep PR and protected integration branch workflows to validation, artifacts, previews, or staging by default; require production deployment to run only from explicit releases/tags with safety checks; verify the release/tag commit is reachable from the protected integration branch; make \`workflow_dispatch\` dry-run/preview unless explicitly approved for an emergency production path; and avoid broad delete/sync cleanup against production.
- Record the owning component, public contracts, owned data, dependency direction, rollback boundary, owned test layers, changed and transitively affected components, classifier decision, selected commands, exact SHA, outcomes, timings, and full-regression reason when escalation applies.
- Keep changes scoped to this task.
- Keep changes inside the task's lane and work areas. If you need to touch files outside that scope, add a StudioOps comment and either create a dependent task or explain why the scope must expand.
- Do not commit secrets, private customer data, or unrelated refactors.
- Run validation before reporting ready.
- Commit and push only if the user/project workflow asks for that.
- Link the feature branch and pull request on the task when available.
- Add a task comment with changed files, validation results, known gaps, PR link, and next review step.
- Move the task to \`builder_review\` only after the branch, exact full head SHA, validation notes, and builder comment are present. Use \`status ${task.id} --status builder_review --subject-sha <full-head-sha>\` so the SHA is persisted atomically with the transition. GitHub workflows also require the PR URL; local workflows must leave the PR URL empty.
`;
}

function reviewerProfileForRole(role, stage = null) {
  const normalized = String(role || "reviewer").toLowerCase().replaceAll("_", "-");
  const stageHint = String(stage?.key || "").trim();
  if (normalized.includes("backend")) {
    return {
      label: "backend reviewer",
      domain: "backend/data/security",
      stageHint: stageHint || "backend",
      focus: [
        "API contracts and error handling",
        "data model ownership, migrations, indexes, pagination, and query shape",
        "auth/session handling, PII protection, secrets, consent, and auditability",
        "background jobs, queues, deployment impact, and operational risk",
      ],
    };
  }
  if (normalized.includes("frontend")) {
    return {
      label: "frontend reviewer",
      domain: "frontend/product UI",
      stageHint: stageHint || "frontend",
      focus: [
        "mockup fidelity, visual hierarchy, spacing, typography, and interaction quality",
        "mobile, tablet, desktop, direct URL refresh, and no horizontal overflow",
        "component reuse, Sass/design-system consistency, content editability, and no one-off UI copies",
        "accessibility, semantic HTML, loading/empty/error states, and browser console health",
      ],
    };
  }
  if (normalized.includes("accessibility") || normalized.includes("a11y")) {
    return {
      label: "accessibility expert reviewer",
      domain: "accessibility/a11y product UI",
      stageHint: stageHint || "accessibility",
      focus: [
        "WCAG-oriented color contrast, readable typography, non-color-only states, and zoom-safe text",
        "visible focus states, keyboard reachability, logical tab order, skip/escape behavior, and no keyboard traps",
        "semantic headings, landmarks, link names, button names, form labels, title text, and accessible error text",
        "informative alt text, decorative image handling, restrained ARIA use, and screen-reader basics",
        "mobile, tablet, and desktop accessibility coverage, including responsive navigation and dialogs",
      ],
    };
  }
  if (
    normalized.includes("regression")
    || normalized === "qa-reviewer"
    || stage?.status === "regression_review"
  ) {
    return {
      label: stage?.label ? `${stage.label} reviewer` : "regression QA reviewer",
      domain: "release regression/QA",
      stageHint: stageHint || "regression",
      focus: [
        "the exact candidate commit and every mandatory journey in the project regression standard",
        "missing, skipped, stale, fixture-only, or otherwise non-production-shaped regression evidence",
        "repeatability, test isolation, realistic state transitions, and clear failure diagnostics",
        "release and rollback risk without merging or deploying production",
      ],
    };
  }
  return {
    label: "primary team lead reviewer",
    domain: "product/architecture/release",
    stageHint: stageHint || "lead",
    focus: [
      "acceptance criteria, product intent, scope control, and user-facing risk",
      "whether backend, frontend, and accessibility reviews are complete or explicitly waived",
      "cross-cutting architecture, security/privacy posture, deployment safety, and rollback path",
      "whether the PR should move to QA/user review, needs changes, or be split into smaller PRs",
    ],
  };
}

function slugify(value) {
  return String(value || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}
