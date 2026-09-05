import { buildOwnerInbox } from "./owner-inbox.js";
import { qaDecisionCoordinatesForState } from "./store.js";

// Presentation only. Mutations and QA decisions must validate current database
// authority; a board summary is never an authorization receipt.
const TASK_FIELDS = [
  "id", "projectId", "title", "status", "priority", "type", "area", "lane",
  "parentTaskId", "dependsOnTaskIds", "assignedAgentRole", "reviewCycle",
  "branchName", "prUrl", "integrationBranch", "integrationBranchUrl",
  "integrationStatus", "promotionStatus", "candidateId", "candidateManifestDigest",
  "integrationCommit", "updatedAt", "createdAt",
];
const PROJECT_FIELDS = [
  "id", "key", "name", "repoPath", "repoUrl", "defaultBranch", "integrationBranch",
  "trustLeadApprovals",
];
const BUNDLE_FIELDS = [
  "id", "projectId", "status", "candidateId", "manifestDigest", "integrationBranch",
  "integrationCommit", "previewUrl", "previewCheckoutPath", "promotionPrUrl",
];
const ACTIVE_BUNDLES = new Set(["ready", "partially_reviewed", "passed", "release_candidate_ready"]);
const cachedViews = new WeakMap();

function select(value, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export function buildBoardState(state) {
  const inbox = buildOwnerInbox(state);
  return {
    schemaVersion: "studioops.board.v1",
    meta: select(state.meta || {}, ["updatedAt", "storageBackend"]),
    projects: (state.projects || []).map((project) => ({
      ...select(project, PROJECT_FIELDS),
      reviewPolicy: select(project.reviewPolicy || {}, ["trustLeadApprovals", "trustLeads", "integrationBranch", "reviewBranch"]),
    })),
    tasks: (state.tasks || []).map((task) => {
      const description = String(task.description || "");
      return {
        ...select(task, TASK_FIELDS),
        description: description.length > 320 ? `${description.slice(0, 317)}…` : description,
        descriptionTruncated: description.length > 320,
        attachmentCount: Array.isArray(task.attachments) ? task.attachments.length : 0,
      };
    }),
    qaBundles: (state.qaBundles || []).filter((bundle) => ACTIVE_BUNDLES.has(bundle.status)).map((bundle) => ({
      ...select(bundle, BUNDLE_FIELDS),
      tasks: (bundle.tasks || []).map((task) => select(task, ["id", "title"])),
    })),
    qaDecisionCoordinates: qaDecisionCoordinatesForState(state),
    // The legacy inbox duplicates every record in groups and items. The board
    // already renders groups; retain its fallback key without duplicating data.
    ownerInbox: { ...inbox, items: [] },
  };
}

export function boardStateForSnapshot(state) {
  if (!Object.isFrozen(state)) return buildBoardState(state);
  let entry = cachedViews.get(state);
  // Time-based stale labels must advance even when no state write occurs.
  if (!entry || Date.now() >= entry.expiresAt) {
    entry = { view: buildBoardState(state), expiresAt: Date.now() + 5_000 };
    cachedViews.set(state, entry);
  }
  return entry.view;
}
