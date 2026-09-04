import { qaDecisionCoordinatesForState } from "./store.js";

const QA_DECISION_TASK_STATUSES = new Set([
  "qa_review",
  "approved_for_main",
  "promotion_blocked",
  "user_review",
]);

function exactCandidateCoordinates(candidate, ownerQaPacketDigest) {
  if (!candidate || !ownerQaPacketDigest) return null;
  const integrationSha = String(candidate.manifest?.integration?.sha || "");
  if (!candidate.id || !candidate.manifestDigest || !integrationSha) return null;
  return {
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha,
    ownerQaPacketDigest,
  };
}

/**
 * Produce fail-closed owner-QA coordinates from the same canonical packet
 * authority used by decision recording. Rows without current authority remain
 * visible but are explicitly non-actionable and carry no stale coordinates.
 */
export function buildQaReviewList(state, options = {}) {
  const projectId = String(options.projectId || "");
  const authoritativeDigests = qaDecisionCoordinatesForState(state);
  const candidatesById = new Map((state.candidates || []).map((candidate) => [candidate.id, candidate]));
  const bundlesById = new Map((state.qaBundles || []).map((bundle) => [bundle.id, bundle]));
  // Owner QA remains revocable after approval and until the exact release
  // candidate is merged. Keep those lifecycle rows discoverable; canonical
  // packet validation below remains the sole authority for actionability.
  const reviewTasks = (state.tasks || [])
    .filter((task) => QA_DECISION_TASK_STATUSES.has(task.status))
    .filter((task) => !projectId || task.projectId === projectId);

  const tasks = reviewTasks.map((task) => {
    const candidate = candidatesById.get(task.candidateId);
    const bundle = bundlesById.get(task.qaBundleId);
    const taskDigest = authoritativeDigests.tasks[task.id] || "";
    const bundleDigest = authoritativeDigests.bundles[task.qaBundleId] || "";
    const ownerQaPacketDigest = taskDigest || bundleDigest;
    const coordinates = exactCandidateCoordinates(candidate, ownerQaPacketDigest);
    const bundleMatches = Boolean(
      bundle
      && candidate
      && bundle.candidateId === candidate.id
      && candidate.qaBundleId === bundle.id,
    );
    const actionable = Boolean(coordinates && bundleMatches);
    return {
      task,
      actionable,
      qaBundleId: actionable ? bundle.id : "",
      candidateId: actionable ? coordinates.candidateId : "",
      manifestDigest: actionable ? coordinates.manifestDigest : "",
      integrationSha: actionable ? coordinates.integrationSha : "",
      ownerQaPacketDigest: actionable ? coordinates.ownerQaPacketDigest : "",
      decisionSelector: actionable ? {
        kind: taskDigest ? "task" : "bundle",
        id: taskDigest ? task.id : bundle.id,
      } : null,
    };
  });

  const relevantBundleIds = new Set(reviewTasks.map((task) => task.qaBundleId).filter(Boolean));
  const bundles = (state.qaBundles || [])
    .filter((bundle) => relevantBundleIds.has(bundle.id))
    .filter((bundle) => !projectId || bundle.projectId === projectId)
    .map((bundle) => {
      const candidate = candidatesById.get(bundle.candidateId);
      const ownerQaPacketDigest = authoritativeDigests.bundles[bundle.id] || "";
      const coordinates = exactCandidateCoordinates(candidate, ownerQaPacketDigest);
      if (!coordinates || candidate.qaBundleId !== bundle.id) return null;
      return {
        bundle,
        actionable: true,
        candidateId: coordinates.candidateId,
        manifestDigest: coordinates.manifestDigest,
        integrationSha: coordinates.integrationSha,
        ownerQaPacketDigest: coordinates.ownerQaPacketDigest,
        decisionSelector: { kind: "bundle", id: bundle.id },
      };
    })
    .filter(Boolean);

  return { tasks, bundles };
}
