import { loadOrBuildRepositoryContextIndex } from "./repository-context-index.js";
import { retrieveTaskContext } from "./task-context-retrieval.js";
import { formatRepositoryContextPacket } from "./repository-context-packet.js";
import { projectRepositoryIdentity } from "./component-impact-map.js";

const FALLBACK = "ADVISORY REPOSITORY CONTEXT\nStructural retrieval is unavailable. Use the existing component map and bounded source discovery. Edit scope, required validation, and release authority remain unchanged.";

export function repositoryContextEvidence(value = {}) {
  const evidence = {};
  if (["available", "partial", "no_matches", "unavailable", "disabled"].includes(value.status)) evidence.status = value.status;
  if (["snapshot_binding_missing", "packet_unavailable", "index_or_binding_unavailable"].includes(value.reason)) evidence.reason = value.reason;
  if (/^[a-f0-9]{40}$/.test(value.commitSha || "")) evidence.commitSha = value.commitSha;
  if (/^sha256:[a-f0-9]{64}$/.test(value.indexDigest || "")) evidence.indexDigest = value.indexDigest;
  for (const field of ["bytes", "resultCount"]) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= 1000000) evidence[field] = value[field];
  }
  for (const field of ["cacheHit", "partial"]) if (typeof value[field] === "boolean") evidence[field] = value[field];
  return evidence;
}

function unavailable(run, reason) {
  return {
    ...run,
    repositoryContext: { status: "unavailable", reason, resultCount: 0, bytes: Buffer.byteLength(FALLBACK) },
    repositoryContextPacket: FALLBACK,
  };
}

/** Add read-only metadata after the runner has established immutable edit authority. */
export async function withRepositoryContext(run, options = {}) {
  if (options.enabled === false || process.env.STUDIOOPS_CONTEXT_RETRIEVAL === "0") {
    return { ...run, repositoryContext: { status: "disabled", resultCount: 0, bytes: 0 }, repositoryContextPacket: "" };
  }
  const plan = run.impactPlan;
  const commitSha = run.executionCommitSha || run.reviewSubjectSha || plan?.sourceCommit || run.preflightBaseCommit || "";
  if (!plan?.manifest?.digest || !/^[a-f0-9]{40}$/.test(commitSha)) return unavailable(run, "snapshot_binding_missing");
  const expected = {
    project: { key: run.project?.key || run.project?.id || "", repository: projectRepositoryIdentity(run.project) },
    commitSha,
    mapDigest: plan.manifest.digest,
  };
  try {
    const index = await (options.loadIndex || loadOrBuildRepositoryContextIndex)({
      project: run.project,
      repoRoot: run.executionRepoPath || run.project?.repoPath,
      commitSha,
      ...(options.cacheRoot ? { cacheRoot: options.cacheRoot } : {}),
    });
    const packet = retrieveTaskContext({ index, task: run.task || {}, impactPlan: plan });
    const formatted = formatRepositoryContextPacket(packet, expected);
    if (!formatted) return unavailable(run, "packet_unavailable");
    return {
      ...run,
      repositoryContext: {
        status: packet.status,
        commitSha,
        indexDigest: index.digest,
        cacheHit: Boolean(index.cacheHit),
        resultCount: packet.results.length,
        bytes: Buffer.byteLength(formatted),
        partial: Boolean(index.coverage?.partial),
      },
      repositoryContextPacket: formatted,
    };
  } catch {
    // Index/parser/cache errors are advisory failures, never worker failures.
    // Raw errors can contain repository content or host paths; keep them out of prompts.
    return unavailable(run, "index_or_binding_unavailable");
  }
}
