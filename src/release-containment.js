import { normalizeGitSha } from "./candidate-manifest.js";

export const RELEASE_CONTAINMENT_OUTCOMES = Object.freeze({
  EXACT: "exact",
  STALE: "stale",
  CONTAINED: "contained",
  NOT_CONTAINED: "not_contained",
  UNAVAILABLE: "unavailable",
});

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PR_URL_PATTERN = /^https:\/\/github\.com\/.+\/pull\/[1-9]\d*$/i;

function positiveCycle(value, label) {
  const cycle = Number(value);
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error(`${label} must be a positive integer.`);
  return cycle;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isoTimestamp(value, label) {
  const parsed = new Date(requiredString(value, label));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed.toISOString();
}

function normalizedSubject(value, label) {
  return {
    taskId: requiredString(value?.taskId, `${label} task ID`),
    sourceSha: normalizeGitSha(value?.sourceSha ?? value?.headSha, `${label} source SHA`),
    candidateCycle: positiveCycle(value?.candidateCycle, `${label} candidate cycle`),
  };
}

function unavailable(reason, details = {}) {
  return {
    outcome: RELEASE_CONTAINMENT_OUTCOMES.UNAVAILABLE,
    reason,
    ...details,
  };
}

export function compareCandidateSubject(recorded, current) {
  let prior;
  let reviewed;
  try {
    prior = normalizedSubject(recorded, "recorded candidate");
    reviewed = normalizedSubject(current, "current reviewed candidate");
  } catch (error) {
    return unavailable(error.message);
  }
  const mismatches = [
    prior.taskId !== reviewed.taskId ? "task_id" : "",
    prior.sourceSha !== reviewed.sourceSha ? "source_sha" : "",
    prior.candidateCycle !== reviewed.candidateCycle ? "candidate_cycle" : "",
  ].filter(Boolean);
  return {
    outcome: mismatches.length
      ? RELEASE_CONTAINMENT_OUTCOMES.STALE
      : RELEASE_CONTAINMENT_OUTCOMES.EXACT,
    recorded: prior,
    current: reviewed,
    mismatches,
  };
}

function normalizeReachability(observation, expectedSha, label) {
  if (!observation || typeof observation.reachable !== "boolean") {
    throw new Error(`${label} reachability is unavailable.`);
  }
  const observedSha = normalizeGitSha(observation.sha, `${label} observed SHA`);
  if (observedSha !== expectedSha) throw new Error(`${label} reachability is bound to the wrong SHA.`);
  return { sha: observedSha, reachable: observation.reachable };
}

function exactCommitEvidence(candidate, reachability, destination) {
  const integrationSha = normalizeGitSha(candidate?.manifest?.integration?.sha, "candidate integration SHA");
  const sources = Array.isArray(candidate?.manifest?.sources) ? candidate.manifest.sources : [];
  if (!sources.length) throw new Error("Candidate source evidence is unavailable.");
  const currentIntegration = normalizeReachability(
    reachability?.integration,
    integrationSha,
    "candidate integration",
  );
  const observations = Array.isArray(reachability?.sources) ? reachability.sources : [];
  const currentSources = sources.map((source) => {
    const subject = normalizedSubject({
      taskId: source.taskId,
      sourceSha: source.headSha,
      candidateCycle: source.candidateCycle,
    }, "candidate source");
    const observation = observations.find((item) => String(item?.taskId || "").trim() === subject.taskId);
    return {
      ...subject,
      ...normalizeReachability(observation, subject.sourceSha, `candidate source ${subject.taskId}`),
    };
  });
  if (observations.length !== currentSources.length) {
    throw new Error("Candidate source reachability does not exactly match the manifest sources.");
  }
  return {
    destination,
    integration: currentIntegration,
    sources: currentSources,
  };
}

export function evaluateExactTargetContainment({ candidate, observedTargetSha, reachability } = {}) {
  let evidence;
  let targetSha;
  try {
    targetSha = normalizeGitSha(observedTargetSha, "observed protected-target SHA");
    evidence = exactCommitEvidence(candidate, reachability, targetSha);
  } catch (error) {
    return unavailable(error.message);
  }
  const contained = evidence.integration.reachable
    && evidence.sources.every((source) => source.reachable);
  return {
    outcome: contained
      ? RELEASE_CONTAINMENT_OUTCOMES.CONTAINED
      : RELEASE_CONTAINMENT_OUTCOMES.NOT_CONTAINED,
    reason: contained
      ? "The exact integration SHA and every exact source SHA are reachable from the protected target."
      : "The protected target does not contain the exact integration SHA and every exact source SHA.",
    observedTargetSha: targetSha,
    evidence,
  };
}

export function evaluateTrustedCandidateContainment({
  candidate,
  replacement,
  targetBranch,
  observedTargetSha,
  reachability,
} = {}) {
  let replacementEvidence;
  let candidateEvidence;
  let targetSha;
  try {
    requiredString(candidate?.id, "candidate ID");
    const replacementId = requiredString(replacement?.id, "replacement candidate ID");
    if (replacementId === candidate.id) throw new Error("Replacement candidate must differ from the contained candidate.");
    if (replacement?.status !== "merged") throw new Error("Replacement candidate is not durably merged.");
    const manifestDigest = String(replacement?.manifestDigest || "").trim().toLowerCase();
    if (!DIGEST_PATTERN.test(manifestDigest)) throw new Error("Replacement manifest digest is unavailable.");
    const branch = requiredString(replacement?.manifest?.base?.branch, "replacement target branch");
    if (branch !== requiredString(targetBranch, "protected target branch")) {
      throw new Error("Replacement candidate targets a different protected branch.");
    }
    const integrationSha = normalizeGitSha(
      replacement?.manifest?.integration?.sha,
      "replacement integration SHA",
    );
    const sourceTaskIds = (Array.isArray(replacement?.manifest?.sources)
      ? replacement.manifest.sources
      : []).map((source) => requiredString(source?.taskId, "replacement source task ID")).sort();
    if (!sourceTaskIds.length) throw new Error("Replacement candidate source evidence is unavailable.");
    const qaDecision = replacement?.qaDecision;
    const decidedTaskIds = (Array.isArray(qaDecision?.taskIds) ? qaDecision.taskIds : [])
      .map((taskId) => requiredString(taskId, "replacement QA task ID"))
      .sort();
    if (
      qaDecision?.outcome !== "passed"
      || qaDecision?.candidateId !== replacementId
      || qaDecision?.manifestDigest !== manifestDigest
      || qaDecision?.integrationSha !== integrationSha
      || JSON.stringify(decidedTaskIds) !== JSON.stringify(sourceTaskIds)
      || !String(qaDecision?.author || "").trim()
    ) {
      throw new Error("Replacement candidate lacks a trusted exact QA decision.");
    }
    isoTimestamp(qaDecision.repositoryVerifiedAt, "replacement repository verification timestamp");
    isoTimestamp(qaDecision.decidedAt, "replacement QA decision timestamp");
    const promotion = replacement?.promotion;
    const prUrl = requiredString(promotion?.prUrl, "replacement promotion PR URL");
    if (!PR_URL_PATTERN.test(prUrl)) throw new Error("Replacement promotion PR URL is not immutable audit evidence.");
    if (normalizeGitSha(promotion?.commitSha, "replacement promoted SHA") !== integrationSha) {
      throw new Error("Replacement promotion SHA does not match its integration SHA.");
    }
    if (String(promotion?.manifestDigest || "").trim().toLowerCase() !== manifestDigest) {
      throw new Error("Replacement promotion manifest digest does not match.");
    }
    const mergeCommit = normalizeGitSha(
      replacement?.promotionMerge?.mergeCommit,
      "replacement merge commit",
    );
    const mergedAt = isoTimestamp(replacement?.promotionMerge?.mergedAt, "replacement merged timestamp");
    isoTimestamp(replacement?.promotionMerge?.reconciledAt, "replacement reconciled timestamp");
    targetSha = normalizeGitSha(observedTargetSha, "observed protected-target SHA");
    candidateEvidence = exactCommitEvidence(candidate, {
      integration: reachability?.candidateIntegration,
      sources: reachability?.candidateSources,
    }, integrationSha);
    const replacementIntegration = normalizeReachability(
      reachability?.replacementIntegration,
      integrationSha,
      "replacement integration",
    );
    const replacementMerge = normalizeReachability(
      reachability?.replacementMerge,
      mergeCommit,
      "replacement merge",
    );
    replacementEvidence = {
      candidateId: replacementId,
      manifestDigest,
      prUrl,
      integrationSha,
      mergeCommit,
      mergedAt,
      integrationReachableFromTarget: replacementIntegration.reachable,
      mergeReachableFromTarget: replacementMerge.reachable,
    };
  } catch (error) {
    return unavailable(error.message, {
      replacementCandidateId: String(replacement?.id || "").trim(),
    });
  }
  const contained = candidateEvidence.integration.reachable
    && candidateEvidence.sources.every((source) => source.reachable)
    && replacementEvidence.integrationReachableFromTarget
    && replacementEvidence.mergeReachableFromTarget;
  return {
    outcome: contained
      ? RELEASE_CONTAINMENT_OUTCOMES.CONTAINED
      : RELEASE_CONTAINMENT_OUTCOMES.NOT_CONTAINED,
    reason: contained
      ? "A trusted merged candidate contains the exact candidate and is reachable from the protected target."
      : "The trusted merged candidate does not contain every exact candidate commit on the protected target.",
    observedTargetSha: targetSha,
    candidateEvidence,
    replacementEvidence,
  };
}
