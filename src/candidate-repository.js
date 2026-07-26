import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertCandidateEnvelope, normalizeGitSha } from "./candidate-manifest.js";

const execFileAsync = promisify(execFile);

function requiredRepositoryPath(project) {
  const repoPath = String(project?.repoPath || "").trim();
  if (!path.isAbsolute(repoPath)) throw new Error("Candidate verification requires an absolute project repoPath.");
  return repoPath;
}

function expectedRefs(candidate) {
  const manifest = candidate.manifest;
  return [
    {
      kind: "base",
      label: manifest.base.branch,
      ref: `refs/heads/${manifest.base.branch}`,
      expectedSha: manifest.base.sha,
    },
    {
      kind: "integration",
      label: manifest.integration.branch,
      ref: `refs/heads/${manifest.integration.branch}`,
      expectedSha: manifest.integration.sha,
    },
    ...manifest.sources.map((source) => ({
      kind: "source",
      label: source.taskId,
      ref: source.sourceRef,
      expectedSha: source.headSha,
    })),
  ];
}

export async function verifyCandidateRepositoryState(project, candidate, input = {}) {
  assertCandidateEnvelope(candidate);
  const repoPath = requiredRepositoryPath(project);
  const refs = expectedRefs(candidate);
  const uniqueRefs = [...new Set(refs.map((item) => item.ref))];
  let stdout = "";
  try {
    const result = await execFileAsync(
      input.gitBin || "git",
      ["ls-remote", "--refs", "origin", ...uniqueRefs],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          ...(input.env || {}),
        },
        timeout: Number(input.timeoutMs || 60_000),
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    stdout = result.stdout || "";
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Candidate refs could not be verified: ${String(error.stderr || error.message || "git ls-remote failed").trim()}`,
      expected: "",
      observed: "",
      observations: [],
    };
  }
  const observedByRef = new Map();
  for (const line of stdout.split("\n")) {
    const [rawSha, ref] = line.trim().split(/\s+/);
    if (!rawSha || !ref) continue;
    observedByRef.set(ref, normalizeGitSha(rawSha, `observed SHA for ${ref}`));
  }
  const observations = refs.map((item) => ({
    ...item,
    observedSha: observedByRef.get(item.ref) || "",
  }));
  const drift = observations.find((item) => item.observedSha !== item.expectedSha);
  if (drift) {
    return {
      ok: false,
      status: "drift",
      reason: `Candidate ${drift.kind} ref drift for ${drift.label}.`,
      expected: drift.expectedSha,
      observed: drift.observedSha || "missing",
      observations,
    };
  }
  return {
    ok: true,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    observations,
  };
}
