import { loadProjectComponentImpactMapAtCommit } from "./component-impact-map.js";
import { resolveProjectImpactPlan, selectImpactValidationCommands } from "./impact-planner.js";

// Called only after QA computes both immutable Git identities and the complete
// tree diff. A candidate cannot authorize its own smaller validation policy.
export function selectQaImpactValidation({ project, repoRoot, baseSha, commitSha, changedFiles, aggregateCommands }) {
  const fallback = (reason) => ({ commands: [...aggregateCommands], mode: "aggregate", reason });
  if (![baseSha, commitSha].every((sha) => /^[a-f0-9]{40}$/.test(String(sha || "")))) return fallback("candidate_binding_unverified");
  try {
    const base = loadProjectComponentImpactMapAtCommit(project, baseSha, { repoRoot });
    const candidate = loadProjectComponentImpactMapAtCommit(project, commitSha, { repoRoot });
    if (!base.manifest || !candidate.manifest || base.status !== "mapped" || candidate.status !== "mapped") return fallback("map_missing_or_drifted");
    if (base.digest !== candidate.digest) return fallback("map_policy_changed");
    const plan = resolveProjectImpactPlan({
      project, loadedMap: base, changedFiles,
      task: { workAreas: changedFiles, candidateIdentity: { baseSha, commitSha, impactEvidence: { changedFiles } } },
    });
    const selection = selectImpactValidationCommands({
      plan, aggregateCommands, expectedCommitSha: commitSha,
      approvedTargetedCommands: Object.values(base.manifest.components).flatMap((component) => component.tests.map((entry) => entry.command)),
    });
    return { ...selection, baseSha, commitSha, mapDigest: base.digest, changedFilesDigest: plan.candidateBinding?.changedFilesDigest || "" };
  } catch {
    // Invalid maps never skip validation or put candidate-supplied errors in UI.
    return fallback("map_validation_failed");
  }
}
