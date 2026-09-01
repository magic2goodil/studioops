import {
  candidateReviewEvidenceForTask,
  findProject,
  findTask,
  taskAutomationCircuitIsCurrent,
} from "./store.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "./candidate-manifest.js";
import { projectUsesTrustLeadQa } from "./integration-policy.js";
import { assertCandidateEnvelope } from "./candidate-manifest.js";

const OWNER_ACTIONS = new Set(["notify_owner", "notify_qa_review", "qa_bundle_ready"]);
const QA_BUNDLE_STATUSES = new Set(["ready", "partially_reviewed", "release_candidate_ready"]);
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GROUP_ORDER = ["decisions", "operations", "legacy"];
const OWNER_URL_FIELDS = new Set(["href", "taskUrl", "prUrl", "previewUrl"]);
const CREDENTIAL_PATTERN = /\b(?:Bearer\s+[A-Za-z0-9._~-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const LOCAL_PATH_PATTERN = /(^|[\s("'=])\/(?:Users|home|private|var\/folders|tmp|Volumes|opt|etc)\/[^\s"'<>)]*/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g;

const OWNER_QA_ACTIONS = Object.freeze(["pass", "fail", "request_changes", "defer", "open_candidate"]);

function packetDigest(packet) {
  return `sha256:${createHash("sha256").update(canonicalJson(packet)).digest("hex")}`;
}

function criterionSteps(task) {
  return (task.acceptanceCriteria || []).map((criterion, index) => {
    const value = typeof criterion === "string" ? { text: criterion } : criterion || {};
    return {
      order: index + 1,
      criterion: String(value.text || value.criterion || value.description || criterion || "").trim(),
      steps: Array.isArray(value.steps) && value.steps.length ? value.steps.map(String) : ["Open the candidate preview and exercise the criterion.", "Record observed evidence for this criterion."],
      expected: String(value.expected || value.expectedResult || "The criterion is satisfied without console errors.").trim(),
    };
  }).filter((item) => item.criterion);
}

/**
 * The single authoritative gate for owner QA. It deliberately fails closed on
 * missing manifest, membership, checks, or preview identity evidence.
 */
export function candidateCompletenessGate(candidate, state = {}, bundle = null) {
  const reasons = [];
  let manifest;
  try {
    assertCandidateEnvelope(candidate);
    manifest = candidate.manifest;
  } catch (error) {
    reasons.push(`invalid_manifest:${error.message}`);
  }
  if (!manifest) return { ready: false, reasons };
  if (candidate.status !== "frozen" && candidate.status !== "qa_passed" && candidate.status !== "release_candidate_ready") reasons.push("candidate_not_frozen");
  if (!candidate.manifestDigest) reasons.push("manifest_digest_missing");
  if (!manifest.sources?.length) reasons.push("candidate_membership_empty");
  const tasks = (manifest.sources || []).map((source) => findTask(state, source.taskId));
  if (tasks.some((task) => !task)) reasons.push("candidate_membership_incomplete");
  if (tasks.some((task) => task && task.projectId !== candidate.projectId)) reasons.push("candidate_cross_project_membership");
  if ((manifest.checks || []).some((check) => check.outcome !== "passed" || check.subjectSha !== manifest.integration.sha)) reasons.push("required_gate_failed");
  if (manifest.preview?.status !== "healthy" || manifest.preview?.commitSha !== manifest.integration.sha || manifest.preview?.attestation?.observedSha !== manifest.integration.sha) reasons.push("preview_not_verified_at_candidate_sha");
  if (bundle && (bundle.candidateId !== candidate.id || bundle.manifestDigest !== candidate.manifestDigest)) reasons.push("bundle_manifest_mismatch");
  return { ready: reasons.length === 0, reasons, taskIds: (manifest.sources || []).map((source) => source.taskId).sort() };
}

/** Create the immutable, owner-facing QA contract for a candidate. */
export function buildOwnerQaPacket(state, candidate, input = {}) {
  const gate = candidateCompletenessGate(candidate, state, input.bundle || null);
  if (!gate.ready) throw new Error(`Candidate is not QA-ready: ${gate.reasons.join(", ")}`);
  const project = findProject(state, candidate.projectId) || {};
  const tasks = candidate.manifest.sources.map((source) => findTask(state, source.taskId));
  const base = {
    schemaVersion: "studioops.owner-qa-packet.v1",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    projectId: candidate.projectId,
    projectKey: project.key || "",
    projectName: project.name || project.key || "",
    taskUrlBase: input.baseUrl ? String(input.baseUrl).replace(/\/+$/, "") : "",
    candidateUrl: input.candidateUrl || "",
    previewUrl: candidate.manifest.preview.url,
    integration: { branch: candidate.manifest.integration.branch, sha: candidate.manifest.integration.sha },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      expectedOutcome: task.expectedOutcome || task.title,
      taskUrl: taskUrl(input.baseUrl, task.id),
      prUrl: task.prUrl || "",
      affectedSurfaces: Array.isArray(task.affectedSurfaces) ? task.affectedSurfaces : (task.workAreas || []),
      orderedTests: criterionSteps(task),
      accountsOrFixtures: task.accountsOrFixtures || task.fixtures || [],
      resetSteps: task.resetSteps || ["Reset the preview data or fixture state before the next criterion."],
      evidence: task.evidence || task.verificationEvidence || [],
      knownRisks: task.knownRisks || task.risks || [],
      migrations: task.migrations || [],
      featureFlags: task.featureFlags || [],
      rollback: task.rollback || "Revert the candidate commit and disable its feature flag, if applicable.",
    })),
    actions: OWNER_QA_ACTIONS.map((action) => ({ action, candidateId: candidate.id, manifestDigest: candidate.manifestDigest })),
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
  return Object.freeze({ ...base, packetDigest: packetDigest(base) });
}

const GROUP_DEFINITIONS = {
  decisions: {
    label: "Owner decisions",
    description: "Validated QA, release approvals, and explicit exceptions that require a human decision now.",
  },
  operations: {
    label: "Operations",
    description: "Automation recovery and engineering exceptions. These do not require product or code approval.",
  },
  legacy: {
    label: "Legacy records",
    description: "Historical handoffs without current QA or immutable review evidence. They remain visible but are not action-ready.",
  },
};

function latestRunForTask(state, taskId) {
  return [...(state.runs || [])]
    .filter((run) => run.taskId === taskId && OWNER_ACTIONS.has(run.actionType))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
}

function projectPreviewUrl(project) {
  return safeExternalOwnerUrl(
    project?.localQaPreview?.previewUrl
    || project?.qaIntegration?.localPreview?.previewUrl
    || "",
  );
}

function taskUrl(baseUrl, taskId) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
}

function notificationSummary(run) {
  if (!run) {
    return {
      status: "pending",
      channel: "",
      attemptedAt: "",
      error: "",
    };
  }
  return {
    status: run.notificationStatus || (run.externalNotifiedAt ? "sent" : "pending"),
    channel: run.notificationChannel || "",
    attemptedAt: run.externalNotifiedAt || run.notificationFailedAt || "",
    error: run.notificationError || "",
  };
}

function checklistForTask(task) {
  const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [];
  return criteria.map((text) => ({
    taskId: task.id,
    taskTitle: task.title,
    text: String(text),
  }));
}

function recoveryChecklist(circuit = {}) {
  return [
    circuit.nextCheapProbe
      || "Inspect the preserved failure evidence and verify the underlying blocker without launching another model.",
    circuit.remediation
      || "Repair the blocker, then explicitly reset the circuit with a recorded verification reason.",
  ].map((text) => ({ taskId: "", taskTitle: "", text }));
}

function currentReviewEvidence(state, task) {
  const cycle = Number(task?.reviewCycle || 0);
  return task?.assignedAgentRole === "owner"
    && cycle > 0
    && Number(task.reviewSubjectCycle || 0) === cycle
    && FULL_GIT_SHA.test(String(task.reviewSubjectSha || ""))
    && !task.legacyQaDecisionUntrusted
    && !task.legacyStatus
    && candidateReviewEvidenceForTask(state, task).ok;
}

function passedQaDecision(candidate, bundle, sourceTaskIds) {
  const decision = candidate?.qaDecision;
  if (
    !decision
    || decision.outcome !== "passed"
    || decision.candidateId !== candidate.id
    || decision.manifestDigest !== candidate.manifestDigest
    || decision.integrationSha !== candidate.manifest.integration.sha
    || !Array.isArray(decision.taskIds)
    || JSON.stringify([...decision.taskIds].sort()) !== JSON.stringify(sourceTaskIds)
    || !String(decision.author || "").trim()
    || !Number.isFinite(Date.parse(decision.decidedAt || ""))
    || !Number.isFinite(Date.parse(decision.repositoryVerifiedAt || ""))
  ) return false;
  const bundleDecision = bundle?.qaDecision;
  if (!bundleDecision) return true;
  return bundleDecision.outcome === decision.outcome
    && bundleDecision.candidateId === decision.candidateId
    && bundleDecision.manifestDigest === decision.manifestDigest
    && bundleDecision.integrationSha === decision.integrationSha
    && Array.isArray(bundleDecision.taskIds)
    && JSON.stringify([...bundleDecision.taskIds].sort()) === JSON.stringify(sourceTaskIds)
    && bundleDecision.author === decision.author
    && bundleDecision.decidedAt === decision.decidedAt
    && bundleDecision.repositoryVerifiedAt === decision.repositoryVerifiedAt;
}

function redactOwnerText(value) {
  return String(value ?? "")
    .replace(/file:\/\/\/[^\s"'<>)]*/gi, "[local path]")
    .replace(LOCAL_PATH_PATTERN, (_, prefix) => `${prefix}[local path]`)
    .replace(WINDOWS_PATH_PATTERN, "[local path]")
    .replace(CREDENTIAL_PATTERN, "[redacted credential]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_, label) => `${label}=[redacted credential]`);
}

function safeOwnerUrl(value, key = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) {
    return ["href", "taskUrl"].includes(key) && /^\/tasks\/[^/?#]+$/.test(raw) ? raw : "";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|password|api[_-]?key/i.test(key)) return "";
  }
  return redactOwnerText(raw);
}

function safeExternalOwnerUrl(value) {
  const safe = safeOwnerUrl(value);
  return /^https?:\/\//i.test(safe) ? safe : "";
}

function sanitizeOwnerValue(value, key = "") {
  if (typeof value === "string") {
    return OWNER_URL_FIELDS.has(key) ? safeOwnerUrl(value, key) : redactOwnerText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeOwnerValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeOwnerValue(entryValue, entryKey),
    ]),
  );
}

function candidateForBundle(state, bundle) {
  if (!bundle?.candidateId) return null;
  const candidate = (state.candidates || []).find((item) => item.id === bundle.candidateId);
  if (!candidate) return null;
  try {
    assertCandidateEnvelope(candidate);
  } catch {
    return null;
  }
  const releaseReady = bundle.status === "release_candidate_ready";
  const expectedCandidateStatus = releaseReady ? "release_candidate_ready" : "frozen";
  const expectedTaskStatus = bundle.status === "release_candidate_ready" ? "user_review" : "qa_review";
  const sourceTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  const bundleTaskIds = (bundle.tasks || []).map((task) => task.id || task.taskId || task).sort();
  const tasks = bundleTaskRecords(state, bundle);
  if (
    candidate.integrityError
    || candidate.invalidation
    || candidate.status !== expectedCandidateStatus
    || candidate.projectId !== bundle.projectId
    || candidate.qaBundleId !== bundle.id
    || !bundle.manifestDigest
    || candidate.manifestDigest !== bundle.manifestDigest
    || candidate.manifest.integration.branch !== bundle.integrationBranch
    || candidate.manifest.integration.sha !== bundle.integrationCommit
    || candidate.manifest.preview.url !== bundle.previewUrl
    || sourceTaskIds.length === 0
    || JSON.stringify(sourceTaskIds) !== JSON.stringify(bundleTaskIds)
    || tasks.length !== sourceTaskIds.length
    || tasks.some((task) => (
      task.status !== expectedTaskStatus
      || task.assignedAgentRole !== "owner"
      || task.projectId !== bundle.projectId
      || task.qaBundleId !== bundle.id
      || task.candidateId !== candidate.id
    ))
  ) return null;
  if (releaseReady) {
    const promotion = candidate.promotion;
    const promotedTaskIds = [...(bundle.promotedTaskIds || [])].sort();
    if (
      !passedQaDecision(candidate, bundle, sourceTaskIds)
      || !promotion
      || !safeExternalOwnerUrl(bundle.promotionPrUrl)
      || promotion.prUrl !== bundle.promotionPrUrl
      || promotion.branch !== bundle.promotionBranch
      || promotion.commitSha !== bundle.promotionCommit
      || promotion.manifestDigest !== candidate.manifestDigest
      || JSON.stringify(promotedTaskIds) !== JSON.stringify(sourceTaskIds)
    ) return null;
  }
  return candidate;
}

function bundleHasCurrentEvidence(state, bundle) {
  return Boolean(candidateForBundle(state, bundle));
}

function isSyntheticDiagnostic(project, record = {}) {
  if (
    project?.synthetic === true
    || project?.diagnostic === true
    || project?.fixtureOnly === true
    || record?.synthetic === true
    || record?.diagnostic === true
    || record?.fixtureOnly === true
  ) return true;
  const identity = [project?.key, project?.name, record?.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(fixture|synthetic|diagnostic)\b/.test(identity);
}

function taskRecord(state, task, input = {}) {
  const project = findProject(state, task.projectId);
  return {
    project,
    record: {
      projectId: project?.id || task.projectId,
      projectKey: project?.key || task.projectId,
      projectName: project?.name || task.projectId,
      taskId: task.id,
      title: task.title,
      taskUrl: taskUrl(input.baseUrl, task.id),
      prUrl: task.prUrl || "",
      branchName: task.branchName || "",
      integrationBranch: task.integrationBranch || project?.reviewPolicy?.integrationBranch || project?.integrationBranch || "",
      updatedAt: task.updatedAt || task.createdAt || "",
    },
  };
}

function operationTaskItem(state, task, input = {}) {
  const { project, record } = taskRecord(state, task, input);
  const circuit = task.automationCircuit || {};
  const reason = circuit.normalizedReason
    || task.automationBlocker?.reason
    || task.lastAutomationFailure
    || "Automation is blocked.";
  const diagnostic = isSyntheticDiagnostic(project, task);
  return {
    id: `task:${task.id}`,
    group: "operations",
    classification: diagnostic ? "non_production_diagnostic" : "automation_recovery",
    kind: "automation_blocked",
    severity: diagnostic ? "diagnostic" : "critical",
    ...record,
    status: "automation_blocked",
    previewUrl: "",
    nextAction: diagnostic
      ? "Inspect this synthetic failure only when validating StudioOps diagnostics; it is not production work."
      : circuit.resumeAction || "Inspect the blocker and reset the circuit after remediation.",
    primaryAction: {
      type: "task",
      label: diagnostic ? "Open diagnostic record" : "Open recovery task",
      href: record.taskUrl,
      taskId: task.id,
    },
    blocker: {
      reason,
      attempts: Number(circuit.attemptsConsumed || task.automationBlocker?.attempts || 0),
      maxAttempts: Number(circuit.maxAttempts || 0),
    },
    checklistLabel: "Recovery checklist",
    checklist: recoveryChecklist(circuit),
    notification: notificationSummary(latestRunForTask(state, task.id)),
    diagnostic,
    diagnosticLabel: diagnostic ? "Non-production diagnostic" : "",
  };
}

function projectOperationItem(project) {
  const circuit = project.automationCircuit || {};
  const target = project.key || project.id;
  const nextAction = circuit.resumeAction
    || `studioops circuit-reset --project ${target} --reason verified`;
  const diagnostic = isSyntheticDiagnostic(project, circuit);
  return {
    id: `project:${project.id}:automation-circuit`,
    group: "operations",
    classification: diagnostic ? "non_production_diagnostic" : "automation_recovery",
    kind: "project_automation_blocked",
    severity: diagnostic ? "diagnostic" : "critical",
    projectId: project.id,
    projectKey: project.key || project.id,
    projectName: project.name || project.key || project.id,
    title: `${project.name || project.key || project.id} automation circuit is open`,
    status: "automation_blocked",
    taskUrl: "",
    prUrl: "",
    branchName: "",
    integrationBranch: project.reviewPolicy?.integrationBranch || project.integrationBranch || "",
    previewUrl: "",
    nextAction: diagnostic
      ? "Inspect this synthetic circuit only when validating StudioOps diagnostics; it is not production work."
      : nextAction,
    primaryAction: {
      type: "command",
      label: diagnostic ? "Copy diagnostic command" : "Copy recovery command",
      value: nextAction,
    },
    blocker: {
      reason: circuit.normalizedReason || circuit.reasonCode || "Project automation is blocked.",
      attempts: Number(circuit.attemptsConsumed || 0),
      maxAttempts: Number(circuit.maxAttempts || 0),
    },
    checklistLabel: "Recovery checklist",
    checklist: recoveryChecklist(circuit),
    notification: {
      status: "not_applicable",
      channel: "",
      attemptedAt: "",
      error: "",
    },
    diagnostic,
    diagnosticLabel: diagnostic ? "Non-production diagnostic" : "",
    updatedAt: circuit.openedAt || project.updatedAt || project.createdAt || "",
  };
}

function currentTaskDecisionItem(state, task, input = {}) {
  const { project, record } = taskRecord(state, task, input);
  const previewUrl = projectPreviewUrl(project);
  const qaReady = task.status === "qa_review";
  return {
    id: `task:${task.id}`,
    group: "decisions",
    classification: qaReady ? "qa_decision" : "owner_exception",
    kind: qaReady ? "qa_review" : "owner_review",
    severity: "action",
    ...record,
    status: task.status,
    previewUrl: qaReady ? previewUrl : "",
    nextAction: qaReady
      ? "Test the current local QA preview against this task and record a pass or failure."
      : "Review the exact reviewed subject and record the required owner decision.",
    primaryAction: qaReady ? {
      type: "preview",
      label: "Open local QA preview",
      href: previewUrl,
    } : {
      type: "task",
      label: "Open owner decision",
      href: record.taskUrl,
      taskId: task.id,
    },
    blocker: null,
    checklistLabel: qaReady ? "QA checklist" : "Decision checklist",
    checklist: checklistForTask(task),
    notification: notificationSummary(latestRunForTask(state, task.id)),
    diagnostic: false,
    diagnosticLabel: "",
  };
}

function legacyTaskItem(state, task, input = {}, reason = "") {
  const { project, record } = taskRecord(state, task, input);
  const diagnostic = isSyntheticDiagnostic(project, task);
  return {
    id: `task:${task.id}`,
    group: "legacy",
    classification: "legacy_record",
    kind: task.status === "qa_review" ? "legacy_qa_review" : "legacy_owner_review",
    severity: "legacy",
    ...record,
    status: task.legacyStatus || task.status,
    previewUrl: "",
    nextAction: reason
      || "Open this historical record for context. It is not QA-ready and does not count as an owner decision.",
    primaryAction: {
      type: "task",
      label: "Open historical task",
      href: record.taskUrl,
      taskId: task.id,
    },
    blocker: null,
    checklistLabel: "Historical acceptance criteria",
    checklist: checklistForTask(task),
    notification: notificationSummary(latestRunForTask(state, task.id)),
    diagnostic,
    diagnosticLabel: diagnostic ? "Non-production diagnostic" : "",
  };
}

function bundleTaskRecords(state, bundle) {
  return (bundle.tasks || [])
    .map((item) => findTask(state, item.id || item.taskId || item))
    .filter(Boolean);
}

function bundleRecord(state, bundle, input = {}) {
  const project = findProject(state, bundle.projectId);
  const tasks = bundleTaskRecords(state, bundle);
  return {
    project,
    record: {
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        taskUrl: taskUrl(input.baseUrl, task.id),
        prUrl: task.prUrl || "",
      })),
      projectId: project?.id || bundle.projectId,
      projectKey: project?.key || bundle.projectId,
      projectName: project?.name || bundle.projectId,
      bundleId: bundle.id,
      taskId: tasks.length === 1 ? tasks[0].id : "",
      taskUrl: tasks.length === 1 ? taskUrl(input.baseUrl, tasks[0].id) : "",
      integrationBranch: bundle.integrationBranch || "",
      updatedAt: bundle.updatedAt || bundle.createdAt || "",
    },
  };
}

function currentBundleDecisionItem(state, bundle, input = {}) {
  const { project, record } = bundleRecord(state, bundle, input);
  const tasks = bundleTaskRecords(state, bundle);
  const releaseReady = bundle.status === "release_candidate_ready";
  const previewUrl = bundle.previewUrl || projectPreviewUrl(project);
  const prUrl = bundle.promotionPrUrl || "";
  return {
    id: `bundle:${bundle.id}`,
    group: "decisions",
    classification: releaseReady ? "release_approval" : "qa_decision",
    kind: releaseReady ? "release_candidate" : "qa_bundle",
    severity: "action",
    ...record,
    title: releaseReady
      ? `${project?.name || record.projectName}: release candidate ready`
      : `${project?.name || record.projectName}: local QA ready`,
    summary: tasks
      .slice(0, 3)
      .map((task) => task.expectedOutcome || task.title)
      .join("; "),
    status: bundle.status,
    prUrl,
    previewUrl: releaseReady ? "" : previewUrl,
    nextAction: releaseReady
      ? "Review the exact release-candidate pull request and record the explicit release decision."
      : "Test the current local QA preview and listed tasks as one immutable candidate.",
    primaryAction: releaseReady ? {
      type: "pr",
      label: "Review release candidate",
      href: prUrl,
    } : {
      type: "preview",
      label: "Open local QA preview",
      href: previewUrl,
    },
    blocker: null,
    checklistLabel: releaseReady ? "Release checklist" : "QA checklist",
    checklist: tasks.flatMap(checklistForTask),
    notification: {
      status: bundle.notificationStatus || (bundle.notifiedAt || bundle.promotionNotifiedAt ? "sent" : "pending"),
      channel: bundle.notificationChannel || "",
      attemptedAt: bundle.notifiedAt || bundle.promotionNotifiedAt || bundle.notificationFailedAt || "",
      error: bundle.notificationError || "",
    },
    diagnostic: false,
    diagnosticLabel: "",
  };
}

function bundleOperationItem(state, bundle, input = {}, evidenceInvalid = false) {
  const { record } = bundleRecord(state, bundle, input);
  const releaseReady = bundle.status === "release_candidate_ready";
  const reason = evidenceInvalid
    ? "The QA bundle's immutable candidate evidence is missing, invalid, or no longer current."
    : releaseReady
      ? "The release-candidate record is missing its pull-request handoff."
      : "The immutable QA candidate does not have an available local preview.";
  const task = record.tasks[0];
  return {
    id: `bundle:${bundle.id}:operations`,
    group: "operations",
    classification: "handoff_recovery",
    kind: releaseReady ? "release_handoff_blocked" : "qa_preview_blocked",
    severity: "critical",
    ...record,
    title: evidenceInvalid
      ? "QA handoff evidence needs recovery"
      : releaseReady ? "Release handoff needs recovery" : "QA preview needs recovery",
    status: evidenceInvalid
      ? "candidate_evidence_invalid"
      : releaseReady ? "release_handoff_blocked" : "preview_unavailable",
    prUrl: "",
    previewUrl: "",
    nextAction: `${reason} Repair the handoff before asking the owner for a decision.`,
    primaryAction: task ? {
      type: "task",
      label: "Open recovery task",
      href: taskUrl(input.baseUrl, task.id),
      taskId: task.id,
    } : {
      type: "command",
      label: "Copy bundle identifier",
      value: bundle.id,
    },
    blocker: {
      reason,
      attempts: 0,
      maxAttempts: 0,
    },
    checklistLabel: "Recovery checklist",
    checklist: recoveryChecklist({
      nextCheapProbe: evidenceInvalid
        ? "Verify the candidate manifest, bundle link, exact integration SHA, and task membership."
        : releaseReady
        ? "Verify the recorded promotion result and recover the release-candidate PR URL."
        : "Verify the local preview service and its health check for this immutable candidate.",
      remediation: "Repair the handoff evidence, then rerun the applicable QA or promotion workflow.",
    }),
    notification: {
      status: bundle.notificationStatus || "pending",
      channel: bundle.notificationChannel || "",
      attemptedAt: bundle.notificationFailedAt || "",
      error: bundle.notificationError || "",
    },
    diagnostic: false,
    diagnosticLabel: "",
  };
}

function legacyBundleItem(state, bundle, input = {}) {
  const { project, record } = bundleRecord(state, bundle, input);
  const tasks = bundleTaskRecords(state, bundle);
  const diagnostic = isSyntheticDiagnostic(project, bundle);
  return {
    id: `bundle:${bundle.id}:legacy`,
    group: "legacy",
    classification: "legacy_record",
    kind: "legacy_qa_bundle",
    severity: diagnostic ? "diagnostic" : "legacy",
    ...record,
    title: record.tasks.length
      ? `${record.tasks.length} historical QA record${record.tasks.length === 1 ? "" : "s"}`
      : "Historical QA bundle",
    status: bundle.legacyStatus || bundle.status || "legacy_untrusted",
    prUrl: bundle.promotionPrUrl || "",
    previewUrl: "",
    nextAction: "Open the historical task records for context. This bundle is not bound to current immutable QA evidence.",
    primaryAction: record.tasks[0] ? {
      type: "task",
      label: "Open historical task",
      href: taskUrl(input.baseUrl, record.tasks[0].id),
      taskId: record.tasks[0].id,
    } : {
      type: "command",
      label: "Copy bundle identifier",
      value: bundle.id,
    },
    blocker: null,
    checklistLabel: "Historical acceptance criteria",
    checklist: tasks.flatMap(checklistForTask),
    notification: {
      status: bundle.notificationStatus || "not_applicable",
      channel: bundle.notificationChannel || "",
      attemptedAt: bundle.notifiedAt || bundle.notificationFailedAt || "",
      error: bundle.notificationError || "",
    },
    diagnostic,
    diagnosticLabel: diagnostic ? "Non-production diagnostic" : "",
  };
}

function itemTimestamp(item) {
  const value = Date.parse(item.updatedAt || "");
  return Number.isFinite(value) ? value : null;
}

function addTiming(item, generatedAtMs, staleAfterMs) {
  const updatedAtMs = itemTimestamp(item);
  const ageMs = updatedAtMs === null ? null : Math.max(0, generatedAtMs - updatedAtMs);
  return {
    ...item,
    ageMs,
    stale: ageMs !== null && ageMs >= staleAfterMs,
  };
}

function sortItems(items) {
  return items.sort((a, b) => {
    if (a.diagnostic !== b.diagnostic) return a.diagnostic ? 1 : -1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function groupSummary(id, items) {
  const timestamps = items.map(itemTimestamp).filter((value) => value !== null);
  const oldestAt = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : "";
  return {
    id,
    ...GROUP_DEFINITIONS[id],
    count: items.length,
    oldestAt,
    items,
  };
}

export function buildOwnerInbox(state, input = {}) {
  const generatedAtDate = input.now ? new Date(input.now) : new Date();
  const generatedAtMs = Number.isFinite(generatedAtDate.getTime()) ? generatedAtDate.getTime() : Date.now();
  const generatedAt = new Date(generatedAtMs).toISOString();
  const staleAfterMs = Number.isFinite(Number(input.staleAfterMs))
    ? Math.max(0, Number(input.staleAfterMs))
    : STALE_AFTER_MS;
  const groupedItems = {
    decisions: [],
    operations: [],
    legacy: [],
  };
  const representedTaskIds = new Set();

  for (const bundle of state.qaBundles || []) {
    const tasks = bundleTaskRecords(state, bundle);
    const activeBundle = QA_BUNDLE_STATUSES.has(bundle.status);
    const currentEvidence = activeBundle && bundleHasCurrentEvidence(state, bundle);
    if (currentEvidence) {
      const previewUrl = bundle.previewUrl || projectPreviewUrl(findProject(state, bundle.projectId));
      const hasRequiredHandoff = bundle.status === "release_candidate_ready"
        ? Boolean(safeExternalOwnerUrl(bundle.promotionPrUrl) && tasks.length)
        : Boolean(safeExternalOwnerUrl(previewUrl) && tasks.length);
      groupedItems[hasRequiredHandoff ? "decisions" : "operations"].push(
        hasRequiredHandoff
          ? currentBundleDecisionItem(state, bundle, input)
          : bundleOperationItem(state, bundle, input),
      );
      tasks.forEach((task) => representedTaskIds.add(task.id));
      continue;
    }
    if (activeBundle && bundle.candidateId) {
      groupedItems.operations.push(bundleOperationItem(state, bundle, input, true));
      tasks.forEach((task) => representedTaskIds.add(task.id));
      continue;
    }
    if (bundle.status === "legacy_untrusted" || activeBundle) {
      groupedItems.legacy.push(legacyBundleItem(state, bundle, input));
      tasks.forEach((task) => representedTaskIds.add(task.id));
    }
  }

  for (const project of state.projects || []) {
    if (project.automationCircuit?.state === "open") {
      groupedItems.operations.push(projectOperationItem(project));
    }
  }

  for (const task of state.tasks || []) {
    const project = findProject(state, task.projectId);
    const circuitBlocker = task.automationBlocker?.type === "circuit";
    const blocked = circuitBlocker
      ? taskAutomationCircuitIsCurrent(task)
      : task.status === "blocked" && Boolean(task.automationBlocker);
    if (blocked) {
      groupedItems.operations.push(operationTaskItem(state, task, input));
      continue;
    }
    if (representedTaskIds.has(task.id)) continue;

    if (task.status === "user_review") {
      const hasCurrentReviewEvidence = currentReviewEvidence(state, task);
      groupedItems[hasCurrentReviewEvidence ? "decisions" : "legacy"].push(
        hasCurrentReviewEvidence
          ? currentTaskDecisionItem(state, task, input)
          : legacyTaskItem(state, task, input),
      );
      continue;
    }

    if (task.status === "qa_review") {
      const previewUrl = projectPreviewUrl(project);
      const qaValidationReady = task.integrationStatus === "ready"
        || (!projectUsesTrustLeadQa(project) && Boolean(previewUrl));
      const currentStandaloneQa = currentReviewEvidence(state, task)
        && qaValidationReady
        && Boolean(previewUrl)
        && !task.qaBundleId;
      groupedItems[currentStandaloneQa ? "decisions" : "legacy"].push(
        currentStandaloneQa
          ? currentTaskDecisionItem(state, task, input)
          : legacyTaskItem(
            state,
            task,
            input,
            "This QA record is missing current immutable handoff evidence. It remains available but is not counted as an owner decision.",
          ),
      );
    }
  }

  const groups = GROUP_ORDER.map((id) => {
    const timedItems = groupedItems[id].map((item) => addTiming(item, generatedAtMs, staleAfterMs));
    return sanitizeOwnerValue(groupSummary(id, sortItems(timedItems)));
  });
  const counts = Object.fromEntries(groups.map((group) => [group.id, group.count]));
  const allItems = groups.flatMap((group) => group.items);

  const operatorPause = state.meta?.operatorPause?.active ? sanitizeOwnerValue({
    ...state.meta.operatorPause,
    active: true,
  }) : null;

  return {
    generatedAt,
    count: counts.decisions,
    totalCount: allItems.length,
    counts,
    groups,
    items: allItems,
    operatorPause,
  };
}
