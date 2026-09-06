import { withDefaultProjectStandards } from "./config.js";
import { RELEASE_QA_POLICY_VERSION, normalizeReleaseQaPolicy } from "./release-qualification.js";
import { hostedRcDigest } from "./hosted-rc-evidence.js";

const ACTIONS = Object.freeze({
  setup_missing: "Provision an authorized isolated hosted RC and record its signed project policy. Adoption creates no environment.",
  policy_invalid: "Repair the current signed project policy through the hosted RC policy authority.",
  applicability_review_required: "Record and verify explicit project applicability through the hosted RC policy authority.",
  evidence_required: "Collect current hosted identity, snapshot, migration, isolation and device evidence for the exact candidate.",
});

/** Inventory only: a stored policy is not a live environment or release authority.
 * Policy normalization and digest semantics belong to the shared qa-release API. */
function hostedSetup(project) {
  const record = project.hostedRc;
  const saved = record?.policies?.at(-1);
  if (!saved && !record?.activePolicyDigest) return { status: "setup_missing", policyDigest: "" };
  try {
    const policy = normalizeReleaseQaPolicy(saved?.policy);
    const policyDigest = hostedRcDigest(policy);
    if (policy.projectId !== project.id || policyDigest !== record.activePolicyDigest
      || policyDigest !== saved.digest) throw new Error("policy_mismatch");
    if (["unknown", "non_deployable"].includes(policy.applicability)) {
      return { status: "applicability_review_required", policyDigest };
    }
    const configured = policy.allowedOrigins.length > 0
      && (policy.applicability !== "native" || policy.allowedDistributionIds.length > 0);
    return { status: configured ? "evidence_required" : "setup_missing", policyDigest };
  } catch { return { status: "policy_invalid", policyDigest: "" }; }
}

/** Stable ID cursor and <=50 summaries. No candidate scan, IO, writes or provisioning. */
export function planHostedRcAdoption(projects, input = {}) {
  const limit = input.limit ?? 50;
  const after = input.after ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof after !== "string"
    || after.length > 160 || (after && !/^[a-zA-Z0-9_.-]+$/.test(after))) {
    throw new Error("Adoption plan requires limit 1..50 and a valid project ID cursor.");
  }
  const selected = projects.filter((project) => (!input.project || [project.id, project.key].includes(input.project))
    && project.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const items = selected.slice(0, limit).map((project) => {
    const previous = new Set((Array.isArray(project.standards) ? project.standards : String(project.standards || "").split(/\n|,/))
      .map((item) => String(item).trim()).filter(Boolean));
    const added = withDefaultProjectStandards([...previous]).filter((item) => !previous.has(item));
    const setup = hostedSetup(project);
    return { projectId: project.id, projectKey: project.key, added, changed: added.length > 0,
      requiredPolicyVersion: RELEASE_QA_POLICY_VERSION, ...setup, actionRequired: ACTIONS[setup.status] };
  });
  return { schemaVersion: 1, readOnly: true, releaseAuthority: "not_evaluated", items,
    nextAfter: selected.length > limit ? items.at(-1).projectId : null };
}

export function formatHostedRcAdoptionPlan(plan) {
  return ["Hosted RC adoption inventory (no environment or release authority created)",
    ...plan.items.flatMap((item) => [
      `${item.projectId} (${item.projectKey}): ${item.changed ? `add ${item.added.join(", ")}` : "standards current"}; ${item.status}`,
      `  ${item.actionRequired}`,
    ]), ...(plan.nextAfter ? [`Next page: --after ${plan.nextAfter}`] : [])].join("\n");
}
