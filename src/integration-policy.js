import path from "node:path";
import os from "node:os";

const FORBIDDEN_INTEGRATION_BRANCHES = new Set([
  "main",
  "master",
  "production",
]);

export const SELF_PROMOTION_POLICY_VERSION = 1;
export const OWNER_REQUEST_PROVENANCE_VERSION = 1;
export const STUDIOOPS_PRODUCT_ID = "studioops";
export const STUDIOOPS_REPOSITORY_ID = "magic2goodil/studioops";
export const STUDIOOPS_SELF_PROMOTION_CAPABILITIES = Object.freeze([
  "studioops.source_change",
  "studioops.main_fast_forward",
  "studioops.local_runtime_restart",
]);
export const SELF_PROMOTION_PROHIBITED_CAPABILITIES = Object.freeze([
  "managed_project.production_release",
  "local_state.destructive_delete",
  "secrets.rotate",
  "cloud.billing",
  "external_notifications.send",
  "customer_communication.send",
]);

const ALLOWED_SELF_PROMOTION_CAPABILITIES = new Set(STUDIOOPS_SELF_PROMOTION_CAPABILITIES);
const PROHIBITED_SELF_PROMOTION_CAPABILITIES = new Set(SELF_PROMOTION_PROHIBITED_CAPABILITIES);
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const SENSITIVE_ID_PATTERN = /(?:^gh[pousr]_|^github_pat_|^sk-|^xox[baprs]-|token|secret|password|private[-_]?key)/i;

function booleanFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function hasOwnValue(item, key) {
  return Object.prototype.hasOwnProperty.call(item || {}, key);
}

function normalizedStringList(value) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  return [...new Set(items.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

function expandHome(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function normalizedAbsolutePath(value) {
  const expanded = expandHome(value);
  return expanded && path.isAbsolute(expanded) ? path.resolve(expanded) : "";
}

export function canonicalRepositoryId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase();
  const short = raw.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return short ? `${short[1]}/${short[2].replace(/\.git$/i, "")}`.toLowerCase() : "";
}

export function normalizeSelfPromotionPolicy(value = {}) {
  const version = Number(value.version ?? SELF_PROMOTION_POLICY_VERSION);
  return {
    version: Number.isInteger(version) ? version : 0,
    enabled: booleanFlag(value.enabled),
    productId: String(value.productId || STUDIOOPS_PRODUCT_ID).trim().toLowerCase(),
    repositoryId: canonicalRepositoryId(value.repositoryId || STUDIOOPS_REPOSITORY_ID),
    sourceRoot: normalizedAbsolutePath(value.sourceRoot || value.repoPath),
    targetBranch: String(value.targetBranch || "main").trim(),
    allowedCapabilities: [...STUDIOOPS_SELF_PROMOTION_CAPABILITIES],
    prohibitedCapabilities: [...SELF_PROMOTION_PROHIBITED_CAPABILITIES],
  };
}

export function normalizeOwnerRequestProvenance(value = {}) {
  const version = Number(value.version ?? OWNER_REQUEST_PROVENANCE_VERSION);
  return {
    version: Number.isInteger(version) ? version : 0,
    kind: String(value.kind || value.type || "").trim(),
    ownerActorId: String(value.ownerActorId || value.actorId || "").trim(),
    requestId: String(value.requestId || value.ownerRequestId || "").trim(),
    projectId: String(value.projectId || "").trim(),
    capabilities: normalizedStringList(value.capabilities || value.capabilityScope || value.scope),
    inheritedFromTaskId: String(value.inheritedFromTaskId || "").trim(),
    inheritanceKind: String(value.inheritanceKind || "").trim(),
    inheritedAt: String(value.inheritedAt || "").trim(),
  };
}

export function opaqueOwnerRequestIdIsValid(value) {
  const id = String(value || "").trim();
  return OPAQUE_ID_PATTERN.test(id) && !SENSITIVE_ID_PATTERN.test(id);
}

export function evaluateSelfPromotionProjectPolicy(project = {}) {
  const policy = normalizeSelfPromotionPolicy(project.reviewPolicy?.selfPromotion);
  const denied = (reason) => ({ eligible: false, reason, policy });
  if (!policy.enabled) return denied("policy_disabled");
  if (policy.version !== SELF_PROMOTION_POLICY_VERSION) return denied("policy_version_unsupported");
  if (policy.productId !== STUDIOOPS_PRODUCT_ID) return denied("policy_product_identity_mismatch");
  if (policy.repositoryId !== STUDIOOPS_REPOSITORY_ID) return denied("policy_repository_identity_mismatch");
  if (canonicalRepositoryId(project.repoUrl) !== STUDIOOPS_REPOSITORY_ID) {
    return denied("project_repository_identity_mismatch");
  }
  if (!policy.sourceRoot) return denied("policy_source_root_missing");
  const projectSourceRoot = normalizedAbsolutePath(project.repoPath);
  if (!projectSourceRoot) return denied("project_source_root_missing");
  if (projectSourceRoot !== policy.sourceRoot) return denied("project_source_root_mismatch");
  if (String(policy.targetBranch || "").trim() !== "main") {
    return denied("policy_target_branch_mismatch");
  }
  if (String(project.defaultBranch || "").trim() !== "main") {
    return denied("project_default_branch_mismatch");
  }
  return { eligible: true, reason: "eligible", policy };
}

function provenanceIdentityMatches(left, right) {
  return (
    left.ownerActorId === right.ownerActorId
    && left.requestId === right.requestId
    && left.projectId === right.projectId
    && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
}

export function evaluateSelfPromotionEligibility(project = {}, task = {}, context = {}) {
  const projectEvaluation = evaluateSelfPromotionProjectPolicy(project);
  const provenance = normalizeOwnerRequestProvenance(task.requestProvenance);
  const denied = (reason) => ({
    eligible: false,
    reason,
    policy: projectEvaluation.policy,
    provenance,
  });
  if (!projectEvaluation.eligible) return denied(projectEvaluation.reason);
  if (!task.requestProvenance || typeof task.requestProvenance !== "object") {
    return denied("request_provenance_missing");
  }
  if (
    !provenance.kind
    && !provenance.ownerActorId
    && !provenance.requestId
    && !provenance.projectId
    && !provenance.capabilities.length
  ) {
    return denied("request_provenance_missing");
  }
  if (provenance.version !== OWNER_REQUEST_PROVENANCE_VERSION) {
    return denied("request_provenance_version_unsupported");
  }
  if (!["explicit_owner_request", "governed_architecture_inheritance"].includes(provenance.kind)) {
    return denied("request_provenance_kind_invalid");
  }
  if (!opaqueOwnerRequestIdIsValid(provenance.ownerActorId)) return denied("request_owner_actor_invalid");
  if (!opaqueOwnerRequestIdIsValid(provenance.requestId)) return denied("request_id_invalid");
  if (!provenance.projectId || provenance.projectId !== String(project.id || "")) {
    return denied("request_project_mismatch");
  }
  if (!provenance.capabilities.length) return denied("request_scope_missing");
  const prohibited = provenance.capabilities.find((item) => PROHIBITED_SELF_PROMOTION_CAPABILITIES.has(item));
  if (prohibited) return denied("request_scope_prohibited");
  const unknown = provenance.capabilities.find((item) => !ALLOWED_SELF_PROMOTION_CAPABILITIES.has(item));
  if (unknown) return denied("request_scope_unknown");

  if (provenance.kind === "governed_architecture_inheritance") {
    const parent = context.parentTask;
    if (
      !parent
      || parent.id !== provenance.inheritedFromTaskId
      || parent.projectId !== task.projectId
      || task.parentTaskId !== parent.id
      || task.architectureParentTaskId !== parent.id
      || task.architectureStatus !== "inherited"
      || parent.architectureStatus !== "completed"
      || !(parent.architectureDecisionTaskIds || []).includes(task.id)
      || provenance.inheritanceKind !== "governed_architecture_handoff"
    ) {
      return denied("request_inheritance_invalid");
    }
    const parentProvenance = normalizeOwnerRequestProvenance(parent.requestProvenance);
    if (
      parentProvenance.kind !== "explicit_owner_request"
      || !provenanceIdentityMatches(provenance, parentProvenance)
      || !evaluateSelfPromotionEligibility(project, parent).eligible
    ) {
      return denied("request_inheritance_parent_ineligible");
    }
  }

  return {
    eligible: true,
    reason: "eligible",
    policy: projectEvaluation.policy,
    provenance,
  };
}

export function inheritedOwnerRequestProvenance(parentTask, childTask, inheritedAt) {
  const parent = normalizeOwnerRequestProvenance(parentTask?.requestProvenance);
  if (parent.kind !== "explicit_owner_request") return null;
  return {
    ...parent,
    kind: "governed_architecture_inheritance",
    projectId: String(childTask?.projectId || ""),
    inheritedFromTaskId: String(parentTask?.id || ""),
    inheritanceKind: "governed_architecture_handoff",
    inheritedAt: String(inheritedAt || ""),
  };
}

export function integrationBranchName(project = {}) {
  const policy = project.reviewPolicy || {};
  const policyBranch = String(policy.integrationBranch || policy.reviewBranch || "").trim();
  if (policyBranch) return policyBranch;
  return String(project.integrationBranch || project.qaIntegrationBranch || "").trim();
}

export function trustLeadApprovalsEnabled(project = {}) {
  const policy = project.reviewPolicy || {};
  if (hasOwnValue(policy, "trustLeadApprovals")) return booleanFlag(policy.trustLeadApprovals);
  if (hasOwnValue(policy, "trustLeads")) return booleanFlag(policy.trustLeads);
  return booleanFlag(project.trustLeadApprovals);
}

export function integrationBranchSafetyError(project = {}, branchName = integrationBranchName(project)) {
  const branch = String(branchName || "").trim();
  if (!branch) return "Integration branch is not configured.";

  const normalized = branch.toLowerCase();
  if (FORBIDDEN_INTEGRATION_BRANCHES.has(normalized)) {
    return `Integration branch ${branch} is protected; use a non-production QA branch instead.`;
  }

  const defaultBranch = String(project.defaultBranch || "").trim().toLowerCase();
  if (defaultBranch && normalized === defaultBranch) {
    return `Integration branch ${branch} matches the project default branch.`;
  }

  return "";
}

export function projectUsesTrustLeadQa(project = {}) {
  return trustLeadApprovalsEnabled(project) && !integrationBranchSafetyError(project);
}

export function repoWebUrl(project = {}) {
  const raw = String(project.repoUrl || "").trim();
  if (!raw) return "";
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;
  return raw.startsWith("https://github.com/") ? raw.replace(/\.git$/, "") : "";
}

export function branchWebUrl(project = {}, branchName = integrationBranchName(project)) {
  const webUrl = repoWebUrl(project);
  const branch = String(branchName || "").trim();
  if (!webUrl || !branch) return "";
  return `${webUrl}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}
