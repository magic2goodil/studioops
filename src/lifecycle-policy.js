import { isDeepStrictEqual } from "node:util";
import { assertTerminalMergedPromotionClaimForTask } from "./promotion-attempt-claim.js";

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;

export const CANONICAL_LIFECYCLE_STATUSES = Object.freeze([
  "idea", "architecture_pending", "architecture_in_progress", "architecture_ready",
  "ready", "queued", "in_progress", "blocked", "builder_review", "backend_review",
  "frontend_review", "accessibility_review", "regression_review", "lead_review", "qa_review",
  "approved_for_main", "promotion_blocked", "needs_changes", "user_review", "approved",
  "merged", "deployed", "done", "closed", "legacy_untrusted",
]);

const REVIEW_STATUSES = [
  "backend_review", "frontend_review", "accessibility_review", "regression_review", "lead_review",
];
const REVIEW_COMPLETE_OUTCOMES = new Set(["approved", "skipped"]);

function rule(from, to, options = {}) {
  const edges = options.edges || from.flatMap((source) => to.map((target) => [source, target]));
  const actorTypes = options.actorTypes || ["system"];
  const roles = options.roles || [];
  const actors = options.actors || (actorTypes.length === roles.length
    ? actorTypes.map((actorType, index) => [actorType, roles[index]])
    : actorTypes.flatMap((actorType) => roles.map((role) => [actorType, role])));
  return Object.freeze({
    from: Object.freeze([...from]),
    to: Object.freeze([...to]),
    edges: Object.freeze(edges.map((edge) => Object.freeze([...edge]))),
    actorTypes: Object.freeze([...actorTypes]),
    roles: Object.freeze([...roles]),
    actors: Object.freeze(actors.map((actor) => Object.freeze([...actor]))),
    assignment: options.assignment || "none",
    activeRun: options.activeRun === true,
    workflowLease: options.workflowLease === true,
    candidateCycle: options.candidateCycle === true,
    subjectBinding: options.subjectBinding || "none",
    invalidates: Object.freeze([...(options.invalidates || [])]),
  });
}

const reviewRoutingSources = ["builder_review", ...REVIEW_STATUSES];
const forwardReviewEdges = ["builder_review", ...REVIEW_STATUSES]
  .flatMap((source, sourceIndex, statuses) => statuses.slice(sourceIndex + 1).map((target) => [source, target]));
const mutablePromotionOutcomeSources = ["approved_for_main", "promotion_blocked", "user_review"];
const mutablePromotionOutcomeTargets = ["approved_for_main", "promotion_blocked", "user_review", "needs_changes"];
const terminalPromotionOutcomeStatuses = ["merged", "deployed", "done"];

// This is the sole transition graph. Adapters choose an action; they never
// decide whether an edge, actor, assignment, lease, or evidence binding is valid.
export const LIFECYCLE_ACTION_MATRIX = Object.freeze({
  submit_definition: rule(["idea"], ["ready", "architecture_pending"], { actorTypes: ["owner"], roles: ["owner"] }),
  start_architecture: rule(["architecture_pending"], ["architecture_in_progress"], { actorTypes: ["worker"], roles: ["systems-architect"], assignment: "required", activeRun: true, workflowLease: true }),
  complete_architecture: rule(["architecture_in_progress"], ["architecture_ready"], { actorTypes: ["worker"], roles: ["systems-architect"], assignment: "required", activeRun: true, workflowLease: true }),
  release_architecture_children: rule(["idea", "architecture_pending"], ["ready"], { actorTypes: ["system"], roles: ["workflow-engine"] }),
  queue_task: rule(["ready", "blocked", "needs_changes"], ["queued"], { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"] }),
  start_builder: rule(["queued", "needs_changes"], ["in_progress"], { actorTypes: ["worker"], roles: ["builder"], assignment: "required", activeRun: true, workflowLease: true }),
  submit_builder_review: rule(["in_progress", "needs_changes"], ["builder_review"], { actorTypes: ["worker"], roles: ["builder"], assignment: "required", activeRun: true, workflowLease: true, candidateCycle: true, subjectBinding: "sha", invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  record_builder_handoff: rule(["in_progress", "needs_changes"], ["builder_review"], { actorTypes: ["system"], roles: ["workflow-engine"], candidateCycle: true, subjectBinding: "sha", invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  route_review: rule(reviewRoutingSources, REVIEW_STATUSES, { actorTypes: ["system"], roles: ["workflow-engine"], candidateCycle: true, subjectBinding: "sha", edges: forwardReviewEdges }),
  restart_review: rule([...REVIEW_STATUSES, "needs_changes"], REVIEW_STATUSES, { actorTypes: ["system"], roles: ["workflow-engine"], candidateCycle: true, subjectBinding: "sha", invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  record_review_approval: rule(REVIEW_STATUSES, REVIEW_STATUSES, { actorTypes: ["worker"], roles: ["assigned-reviewer"], assignment: "required", activeRun: true, workflowLease: true, candidateCycle: true, subjectBinding: "sha", edges: REVIEW_STATUSES.map((status) => [status, status]) }),
  record_review_evidence: rule(REVIEW_STATUSES, REVIEW_STATUSES, { actorTypes: ["system"], roles: ["review-recorder"], candidateCycle: true, subjectBinding: "sha", edges: REVIEW_STATUSES.map((status) => [status, status]) }),
  request_changes: rule([...reviewRoutingSources, "qa_review", "promotion_blocked", "user_review"], ["needs_changes"], { actorTypes: ["worker", "owner", "system"], roles: ["assigned-reviewer", "owner", "workflow-engine"], candidateCycle: true, subjectBinding: "candidate_or_sha", invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  reject_builder_intake: rule(["builder_review"], ["needs_changes"], { actorTypes: ["system"], roles: ["workflow-engine"], invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  request_owner_review: rule(REVIEW_STATUSES, ["user_review"], { actorTypes: ["system"], roles: ["workflow-engine"], candidateCycle: true, subjectBinding: "sha" }),
  escalate_cycle_limit_owner_review: rule(["lead_review"], ["user_review"], { actorTypes: ["system"], roles: ["workflow-engine"], candidateCycle: true, subjectBinding: "sha" }),
  request_qa_review: rule(REVIEW_STATUSES.concat("user_review"), ["qa_review"], { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"], candidateCycle: true, subjectBinding: "sha" }),
  approve_owner_review: rule(["user_review"], ["approved"], { actorTypes: ["owner"], roles: ["owner"], candidateCycle: true, subjectBinding: "sha" }),
  pass_qa: rule(["qa_review"], ["approved_for_main"], { actorTypes: ["owner"], roles: ["owner"], candidateCycle: true, subjectBinding: "candidate" }),
  fail_qa: rule(["qa_review"], ["needs_changes"], { actorTypes: ["owner"], roles: ["owner"], candidateCycle: true, subjectBinding: "candidate" }),
  revoke_qa: rule(["approved_for_main", "promotion_blocked", "user_review"], ["needs_changes"], {
    actorTypes: ["owner"],
    roles: ["owner"],
    candidateCycle: true,
    subjectBinding: "candidate",
    invalidates: ["reviews", "qa", "candidate", "promotion"],
  }),
  block_promotion: rule(["approved_for_main", "user_review"], ["promotion_blocked"], { actorTypes: ["system"], roles: ["promotion-worker"], activeRun: true, workflowLease: true, candidateCycle: true, subjectBinding: "candidate" }),
  resume_promotion: rule(["promotion_blocked"], ["approved_for_main"], { actorTypes: ["owner", "system"], roles: ["owner", "promotion-worker"], candidateCycle: true, subjectBinding: "candidate" }),
  record_promotion_outcome: rule(
    [...mutablePromotionOutcomeSources, ...terminalPromotionOutcomeStatuses],
    [...mutablePromotionOutcomeTargets, ...terminalPromotionOutcomeStatuses],
    {
      actorTypes: ["system"],
      roles: ["promotion-worker"],
      candidateCycle: true,
      subjectBinding: "candidate_or_sha",
      edges: [
        ...mutablePromotionOutcomeSources.flatMap((source) => mutablePromotionOutcomeTargets.map((target) => [source, target])),
        ...terminalPromotionOutcomeStatuses.map((status) => [status, status]),
      ],
    },
  ),
  record_promotion_validation_evidence: rule(
    ["approved_for_main", "promotion_blocked"],
    ["approved_for_main", "promotion_blocked"],
    {
      actorTypes: ["system"],
      roles: ["promotion-worker"],
      candidateCycle: true,
      subjectBinding: "candidate",
      edges: [["approved_for_main", "approved_for_main"], ["promotion_blocked", "promotion_blocked"]],
    },
  ),
  open_promotion_circuit: rule(
    ["approved_for_main", "promotion_blocked", "user_review"],
    ["blocked"],
    { actorTypes: ["system"], roles: ["promotion-worker"], candidateCycle: true, subjectBinding: "candidate" },
  ),
  // A release PR can be closed and later reopened by its owner. Reconciliation
  // records the close as promotion_blocked, so the same exact candidate must
  // still be able to advance when that exact PR is subsequently merged.
  record_merge: rule(
    ["approved_for_main", "promotion_blocked", "approved", "user_review", "merged", "deployed", "done"],
    ["merged", "deployed", "done"],
    {
      actorTypes: ["owner", "worker"],
      roles: ["owner", "promotion-worker"],
      candidateCycle: true,
      subjectBinding: "candidate_or_sha",
      edges: [
        ["approved_for_main", "merged"],
        ["promotion_blocked", "merged"],
        ["approved", "merged"],
        ["user_review", "merged"],
        ["merged", "merged"],
        ["deployed", "deployed"],
        ["done", "done"],
      ],
    },
  ),
  record_deployment: rule(["merged"], ["deployed"], { actorTypes: ["owner", "worker"], roles: ["owner", "release-manager"], candidateCycle: true, subjectBinding: "candidate_or_sha" }),
  finish_task: rule(["merged", "deployed"], ["done"], { actorTypes: ["owner", "system"], roles: ["owner", "workflow-engine"], candidateCycle: true, subjectBinding: "candidate_or_sha" }),
  close_task: rule(CANONICAL_LIFECYCLE_STATUSES.filter((status) => !["closed", "legacy_untrusted"].includes(status)), ["closed"], { actorTypes: ["owner"], roles: ["owner"] }),
  block_workflow: rule(CANONICAL_LIFECYCLE_STATUSES.filter((status) => !["blocked", "closed", "done", "legacy_untrusted"].includes(status)), ["blocked"], { actorTypes: ["system"], roles: ["workflow-engine"] }),
  resume_workflow: rule(["blocked"], CANONICAL_LIFECYCLE_STATUSES.filter((status) => !["idea", "blocked", "legacy_untrusted"].includes(status)), { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"] }),
  recover_workflow: rule(["blocked", "in_progress"], CANONICAL_LIFECYCLE_STATUSES.filter((status) => !["idea", "blocked", "legacy_untrusted"].includes(status)), { actorTypes: ["system"], roles: ["resilience-engine"] }),
  require_architecture: rule(["idea", "ready", "queued"], ["architecture_pending"], { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"] }),
  record_architecture_completion: rule(["architecture_pending", "architecture_in_progress"], ["architecture_ready"], { actorTypes: ["system"], roles: ["architecture-recorder"] }),
  mutate_assignment: rule(CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"], edges: CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted").map((status) => [status, status]) }),
  mutate_evidence: rule(CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), { actorTypes: ["system", "owner"], roles: ["workflow-engine", "owner"], edges: CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted").map((status) => [status, status]), invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  owner_override: rule(CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), { actorTypes: ["owner"], roles: ["owner"], invalidates: ["reviews", "qa", "candidate", "promotion"] }),
  legacy_repair: rule(["legacy_untrusted"], CANONICAL_LIFECYCLE_STATUSES.filter((status) => status !== "legacy_untrusted"), { actorTypes: ["migration"], roles: ["integrity-repair"] }),
});

export const LIFECYCLE_EVIDENCE_FIELDS = Object.freeze([
  "assignedAgentRole", "assignedThreadId", "reviewerThreadId", "workflowLease",
  "reviewCycle", "reviewSubjectSha", "reviewSubjectCycle", "impactEvidence", "candidateIdentity", "candidateId",
  "qaBundleId", "qaDecision", "integrationStatus", "promotionStatus", "promotionEvidence",
  "evidenceInvalidations", "architectureStatus", "architectureSummary", "architectureDecisionTaskIds",
  "architectureCompletedAt", "architectureCompletedBy",
]);

export function positiveStateVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function requiredString(value, label, min = 1, max = 240) {
  const normalized = String(value || "").trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label} must be between ${min} and ${max} characters.`);
  }
  return normalized;
}

function redactAuditText(value) {
  return String(value || "")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED]")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function normalizeActor(actorContext = {}) {
  const actorId = requiredString(actorContext.actorId, "Trusted actor ID", 1, 160);
  const actorType = String(actorContext.actorType || "").trim();
  const role = String(actorContext.role || "").trim();
  if (actorContext.trusted !== true) throw new Error("Lifecycle actor identity is not trusted.");
  if (!actorType || !role) throw new Error("Lifecycle actor type and role are required.");
  return {
    actorId,
    actorType,
    role,
    runId: String(actorContext.runId || "").trim(),
    leaseId: String(actorContext.leaseId || "").trim(),
  };
}

function activeRunFor(context, taskId, actor) {
  return (context.runs || []).find((run) => (
    run.id === actor.runId
    && run.taskId === taskId
    && ["queued", "running"].includes(run.status)
    && (!run.role || run.role === actor.role)
  ));
}

function reviewIsCurrent(review, aggregate) {
  if (!review || review.invalidatedAt || review.invalidation) return false;
  return review.taskId === aggregate.id
    && Number(review.candidateCycle || 0) === Number(aggregate.reviewSubjectCycle || aggregate.reviewCycle || 0)
    && String(review.subjectSha || "").toLowerCase() === String(aggregate.reviewSubjectSha || "").toLowerCase();
}

function assertReviewGates(action, aggregate, evidence = {}, context = {}) {
  if (!["route_review", "record_review_evidence", "request_owner_review", "request_qa_review", "escalate_cycle_limit_owner_review"].includes(action)) return;
  const stages = Array.isArray(context.reviewStages) ? context.reviewStages : [];
  if (!stages.length) throw new Error(`Lifecycle action ${action} requires the project's explicit review-stage contract.`);
  const targetStatus = String(evidence.targetStatus || "").trim();
  const targetIndex = stages.findIndex((stage) => stage.status === targetStatus);
  const reviewStageIndex = action === "record_review_evidence"
    ? stages.findIndex((stage) => stage.status === aggregate.status)
    : targetIndex;
  if (["route_review", "record_review_evidence"].includes(action) && reviewStageIndex < 0) {
    throw new Error(`Lifecycle action ${action} targets a status outside the project's review-stage contract.`);
  }
  const required = stages
    .map((stage, index) => ({ ...stage, index }))
    .filter((stage) => stage.required !== false)
    .filter((stage) => (
      action === "route_review" || action === "record_review_evidence"
        ? stage.index < reviewStageIndex
        : true
    ));
  const currentReviews = (context.reviews || []).filter((review) => reviewIsCurrent(review, aggregate));
  if (action === "escalate_cycle_limit_owner_review") {
    const currentLeadChange = currentReviews.some((review) => (
      review.outcome === "changes_requested"
      && (review.stageKey === "lead" || review.status === "lead_review" || review.role === "lead-reviewer")
    ));
    if (!context.allowCycleLimitLeadReview || !currentLeadChange) {
      throw new Error("Cycle-limit owner escalation requires a current lead changes-requested decision.");
    }
    return;
  }
  const missing = required.find((stage) => !currentReviews.some((review) => (
    (review.stageKey === stage.key || (!review.stageKey && review.status === stage.status))
    && REVIEW_COMPLETE_OUTCOMES.has(review.outcome)
  )));
  if (!missing) return;
  const cycleLimitOverride = action === "route_review"
    && evidence.gateOverride === "cycle_limit_lead_decision"
    && stages[reviewStageIndex]?.role === "lead-reviewer"
    && context.allowCycleLimitLeadReview === true
    && currentReviews.some((review) => review.outcome === "changes_requested");
  if (!cycleLimitOverride) {
    throw new Error(`${missing.label || missing.key || missing.status} must be complete for the exact current candidate before ${action}.`);
  }
}

function assertCompletionEvidence(action, context = {}) {
  if (action !== "finish_task") return;
  const completion = context.completionEvidence;
  if (!completion || completion.complete !== true) {
    const missing = [
      ...(completion?.missing || []),
      ...(completion?.missingReviews || []),
    ];
    throw new Error(`Lifecycle action finish_task requires complete immutable evidence${missing.length ? `: ${missing.join(", ")}` : "."}`);
  }
}

function assertPromotionWorkerMergeAuthority(action, actor, aggregate, evidence = {}, context = {}) {
  if (action !== "record_merge" || actor.actorType !== "worker" || actor.role !== "promotion-worker") return;
  const candidateId = String(evidence.candidateId || aggregate.candidateId || "").trim();
  const candidate = (context.candidates || []).find((item) => item.id === candidateId);
  const claim = context.promotionAttemptClaims?.[candidateId];
  const expectedClaimId = String(evidence.promotionClaimId || "").trim();
  const expectedFence = Number(evidence.promotionClaimFence);
  const expectedOutcome = String(evidence.promotionClaimOutcome || "").trim();
  let terminalAuthority;
  try {
    terminalAuthority = assertTerminalMergedPromotionClaimForTask(claim, aggregate, candidate, {
      candidates: context.candidates || [],
    });
  } catch {
    terminalAuthority = null;
  }
  if (
    !candidate
    || !claim
    || !terminalAuthority
    || claim.status !== "terminal"
    || claim.outcome !== "merged"
    || expectedOutcome !== "merged"
    || !expectedClaimId
    || claim.claimId !== expectedClaimId
    || !Number.isSafeInteger(expectedFence)
    || expectedFence < 1
    || Number(claim.fence) !== expectedFence
    || claim.candidateId !== candidate.id
  ) {
    throw new Error("Promotion-worker merge recording requires the exact terminal merged promotion claim and fence.");
  }
  const terminal = terminalAuthority.terminalResult;
  const prUrl = String(evidence.prUrl || "").trim();
  const mergeCommit = String(evidence.mergeCommit || "").trim().toLowerCase();
  const mergedAtMs = Date.parse(evidence.mergedAt || "");
  const mergedAt = Number.isFinite(mergedAtMs) ? new Date(mergedAtMs).toISOString() : "";
  const replacement = terminalAuthority.replacement;
  const promotion = replacement?.promotion || candidate.promotion;
  const promotionMerge = replacement?.promotionMerge || null;
  if (
    !terminal
    || terminal.candidateId !== candidate.id
    || terminal.manifestDigest !== candidate.manifestDigest
    || terminal.prUrl !== prUrl
    || terminal.mergeCommit !== mergeCommit
    || terminal.mergedAt !== mergedAt
    || !SHA_PATTERN.test(mergeCommit)
    || !mergedAt
    || promotion?.prUrl !== prUrl
    || (promotionMerge && (
      promotionMerge.mergeCommit !== mergeCommit
      || new Date(promotionMerge.mergedAt).toISOString() !== mergedAt
    ))
  ) {
    throw new Error("Promotion-worker merge evidence does not match the terminal claim and exact candidate promotion PR.");
  }
}

function assertBoundEvidence(action, ruleValue, aggregate, evidence = {}, context = {}) {
  const candidate = (context.candidates || []).find((item) => item.id === (evidence.candidateId || aggregate.candidateId));
  const candidateSource = candidate?.manifest?.sources?.find((source) => source.taskId === aggregate.id);
  if (ruleValue.candidateCycle) {
    const current = Number(
      aggregate.reviewSubjectCycle
      || aggregate.reviewCycle
      || aggregate.candidateIdentity?.candidateCycle
      || candidateSource?.candidateCycle
      || 0
    );
    const expected = ["submit_builder_review", "record_builder_handoff"].includes(action)
      ? Math.max(Number(aggregate.reviewSubjectCycle || 0) + 1, Number(aggregate.reviewCycle || 0) + 1)
      : current;
    if (!Number.isSafeInteger(Number(evidence.candidateCycle)) || Number(evidence.candidateCycle) !== expected || expected < 1) {
      throw new Error(`Candidate cycle ${evidence.candidateCycle ?? "(missing)"} does not match current cycle ${expected}.`);
    }
  }
  const exactSha = String(evidence.subjectSha || "").trim().toLowerCase();
  const aggregateSha = String(aggregate.reviewSubjectSha || aggregate.candidateIdentity?.commitSha || candidateSource?.headSha || "").trim().toLowerCase();
  const candidateMatches = Boolean(
    candidate
    && !candidate.invalidation
    && candidate.status !== "invalidated"
    && String(evidence.candidateId || "") === candidate.id
    && String(evidence.manifestDigest || "") === String(candidate.manifestDigest || "")
    && candidate.manifest?.sources?.some((source) => (
      source.taskId === aggregate.id
      && Number(source.candidateCycle) === Number(evidence.candidateCycle)
      && (!exactSha || source.headSha === exactSha)
    )),
  );
  if (["sha", "candidate_or_sha"].includes(ruleValue.subjectBinding)) {
    const shaMatches = SHA_PATTERN.test(exactSha)
      && (["submit_builder_review", "record_builder_handoff"].includes(action) || exactSha === aggregateSha);
    if (!shaMatches && !(ruleValue.subjectBinding === "candidate_or_sha" && candidateMatches)) {
      throw new Error("Lifecycle evidence is not bound to the exact current subject SHA.");
    }
  }
  if (ruleValue.subjectBinding === "candidate" && !candidateMatches) {
    throw new Error("Lifecycle evidence is not bound to the immutable current candidate.");
  }
}

function validateOwnerOverride(evidence = {}) {
  const reasonCode = String(evidence.reasonCode || "").trim();
  if (!REASON_CODE_PATTERN.test(reasonCode)) {
    throw new Error("Owner override reasonCode must be 3-64 lowercase letters, digits, underscores, or hyphens.");
  }
  return {
    reasonCode,
    reason: redactAuditText(requiredString(evidence.reason, "Owner override reason", 20, 1000)),
    risk: redactAuditText(requiredString(evidence.risk, "Owner override recorded risk", 10, 1000)),
  };
}

export function lifecycleEvidenceChanged(previous = {}, next = {}) {
  return LIFECYCLE_EVIDENCE_FIELDS.some((field) => !isDeepStrictEqual(previous[field], next[field]));
}

export function evaluateLifecycleTransition(command = {}, aggregate = {}, context = {}) {
  const action = String(command.action || "").trim();
  const taskId = String(command.taskId || "").trim();
  const ruleValue = LIFECYCLE_ACTION_MATRIX[action];
  if (!ruleValue) throw new Error(`Unknown lifecycle action: ${action || "(missing)"}`);
  if (!taskId || taskId !== aggregate.id) throw new Error("Lifecycle command taskId does not match the aggregate.");
  const expectedStateVersion = Number(command.expectedStateVersion);
  const currentStateVersion = positiveStateVersion(aggregate.stateVersion);
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 1) {
    throw new Error("Lifecycle command expectedStateVersion must be a positive integer.");
  }
  if (expectedStateVersion !== currentStateVersion) {
    const error = new Error(`Stale lifecycle command: expected stateVersion ${expectedStateVersion}, current version is ${currentStateVersion}.`);
    error.code = "STALE_STATE_VERSION";
    throw error;
  }
  const actor = normalizeActor(command.actorContext);
  const assignedRole = String(aggregate.assignedAgentRole || "").trim();
  const actorAllowed = ruleValue.actors.some(([actorType, role]) => (
    actorType === actor.actorType
    && (role === actor.role || (role === "assigned-reviewer" && actor.role === assignedRole))
  ));
  if (!actorAllowed) throw new Error(`Actor type ${actor.actorType} and role ${actor.role} cannot perform ${action}.`);
  if (ruleValue.assignment === "required" && actor.role !== assignedRole) {
    throw new Error(`Lifecycle actor ${actor.role} is not assigned to task ${taskId}.`);
  }
  const targetStatus = String(command.evidence?.targetStatus || ruleValue.to[0] || "").trim();
  const edgeAllowed = ruleValue.edges.some(([source, target]) => source === aggregate.status && target === targetStatus);
  if (!edgeAllowed) {
    throw new Error(`Lifecycle action ${action} prohibits ${aggregate.status || "(missing)"} -> ${targetStatus || "(missing)"}.`);
  }
  const activeRun = ruleValue.activeRun ? activeRunFor(context, taskId, actor) : null;
  if (ruleValue.activeRun && !activeRun) throw new Error(`Lifecycle action ${action} requires the actor's active task run.`);
  if (ruleValue.workflowLease) {
    const lease = activeRun?.workflowLease || aggregate.workflowLease;
    if (!actor.leaseId || actor.leaseId !== String(lease?.id || "")) throw new Error(`Lifecycle action ${action} requires the current workflow lease.`);
    if (!Number.isFinite(Date.parse(lease?.expiresAt || "")) || Date.parse(lease.expiresAt) <= Number(context.nowMs ?? Date.now())) {
      throw new Error(`Lifecycle action ${action} requires an unexpired workflow lease.`);
    }
  }
  assertBoundEvidence(action, ruleValue, aggregate, command.evidence || {}, context);
  assertPromotionWorkerMergeAuthority(action, actor, aggregate, command.evidence || {}, context);
  assertReviewGates(action, aggregate, command.evidence || {}, context);
  assertCompletionEvidence(action, context);
  const override = action === "owner_override" ? validateOwnerOverride(command.evidence) : null;
  const now = context.now || new Date(Number(context.nowMs ?? Date.now())).toISOString();
  const nextTask = {
      ...aggregate,
      status: targetStatus,
      stateVersion: currentStateVersion + 1,
      updatedAt: now,
  };
  if (["submit_builder_review", "record_builder_handoff"].includes(action)) {
    nextTask.reviewCycle = Number(command.evidence.candidateCycle);
    nextTask.reviewSubjectCycle = Number(command.evidence.candidateCycle);
    nextTask.reviewSubjectSha = String(command.evidence.subjectSha).trim().toLowerCase();
    nextTask.candidateIdentity = {
      ...(aggregate.candidateIdentity || {}),
      commitSha: nextTask.reviewSubjectSha,
      candidateCycle: nextTask.reviewSubjectCycle,
    };
  }
  return {
    task: nextTask,
    decision: {
      action,
      from: aggregate.status,
      to: targetStatus,
      fromVersion: currentStateVersion,
      toVersion: currentStateVersion + 1,
      actor,
      evidence: {
        candidateCycle: Number(command.evidence?.candidateCycle || 0),
        subjectSha: String(command.evidence?.subjectSha || "").trim().toLowerCase(),
        candidateId: String(command.evidence?.candidateId || "").trim(),
        manifestDigest: String(command.evidence?.manifestDigest || "").trim(),
        promotionOutcome: String(command.evidence?.promotionOutcome || "").trim(),
        promotionClaimId: String(command.evidence?.promotionClaimId || "").trim(),
        promotionClaimFence: Number(command.evidence?.promotionClaimFence || 0),
        promotionClaimOutcome: String(command.evidence?.promotionClaimOutcome || "").trim(),
        prUrl: String(command.evidence?.prUrl || "").trim(),
        mergeCommit: String(command.evidence?.mergeCommit || "").trim().toLowerCase(),
        mergedAt: String(command.evidence?.mergedAt || "").trim(),
        validationEvidenceDigest: String(command.evidence?.validationEvidenceDigest || "").trim(),
        promotionCircuitReason: String(command.evidence?.promotionCircuitReason || "").trim(),
        ...(action === "finish_task" ? { completionEvidence: context.completionEvidence } : {}),
      },
      invalidates: ruleValue.invalidates,
      override,
      occurredAt: now,
    },
  };
}

export const applyLifecycleTransition = evaluateLifecycleTransition;
