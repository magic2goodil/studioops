const HANDOFF_SCHEMA_VERSION = 1;
const MAX_FINDINGS = 12;
const MAX_FINDING_CHARACTERS = 16_000;
const MAX_PROMPT_CHARACTERS = 8_000;
const MAX_PROMPT_FINDING_CHARACTERS = 1_600;
const MAX_HISTORY = 6;

const SEVERITY_ORDER = new Map([
  ["critical", 0],
  ["high", 1],
  ["medium", 2],
  ["low", 3],
]);

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(/(?<![\d.])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g, "[REDACTED PHONE]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[REDACTED]")
    .trim();
}

function inferredSeverity(review) {
  const declared = String(review.severity || "").trim().toLowerCase();
  if (SEVERITY_ORDER.has(declared)) return declared;
  const body = String(review.body || "").toLowerCase();
  if (/\b(critical|p0|sev[- ]?0|remote code execution|data loss|credential leak)\b/.test(body)) return "critical";
  if (/\b(high|p1|sev[- ]?1|security|privacy|authorization bypass|blocks? release)\b/.test(body)) return "high";
  if (/\b(low|p3|sev[- ]?3|nit|minor|cosmetic)\b/.test(body)) return "low";
  return "medium";
}

function normalizedFindingKey(body) {
  return body
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function findingSource(review) {
  return {
    reviewId: String(review.id || ""),
    stageKey: String(review.stageKey || review.status || "review"),
    role: String(review.role || "reviewer"),
    author: redactSensitiveText(review.author || review.role || "reviewer").slice(0, 160),
    createdAt: String(review.createdAt || ""),
  };
}

function labeledLine(body, labels) {
  const expression = new RegExp(`^(?:${labels.join("|")})\\s*:\\s*(.+)$`, "im");
  return redactSensitiveText(body.match(expression)?.[1] || "").slice(0, 1_000);
}

function evidenceReferences(body) {
  const safe = redactSensitiveText(body);
  const urls = safe.match(/https?:\/\/[^\s<>()]+/g) || [];
  const paths = safe.match(/(?:^|\s)(?:[a-z0-9_.-]+\/)+(?:[a-z0-9_.-]+)(?::\d+(?::\d+)?)?/gim) || [];
  return [...new Set([...urls, ...paths.map((item) => item.trim())])].slice(0, 12);
}

function compareFindings(left, right) {
  const severity = (SEVERITY_ORDER.get(left.severity) ?? 2) - (SEVERITY_ORDER.get(right.severity) ?? 2);
  if (severity) return severity;
  return String(left.sources[0]?.createdAt || "").localeCompare(String(right.sources[0]?.createdAt || ""));
}

export function createRemediationHandoff(task, reviews, now = new Date().toISOString()) {
  const deduplicated = new Map();
  for (const review of reviews || []) {
    if (review.outcome !== "changes_requested") continue;
    const sanitizedBody = redactSensitiveText(review.body || "Reviewer requested changes without detailed notes.");
    const body = sanitizedBody.slice(0, MAX_FINDING_CHARACTERS);
    const key = normalizedFindingKey(body) || `review:${review.id || deduplicated.size}`;
    const source = findingSource(review);
    const existing = deduplicated.get(key);
    if (existing) {
      if (!existing.sources.some((item) => item.reviewId === source.reviewId)) existing.sources.push(source);
      const severity = inferredSeverity(review);
      if ((SEVERITY_ORDER.get(severity) ?? 2) < (SEVERITY_ORDER.get(existing.severity) ?? 2)) {
        existing.severity = severity;
      }
      continue;
    }
    deduplicated.set(key, {
      id: `finding_${String(review.id || deduplicated.size + 1)}`,
      severity: inferredSeverity(review),
      body,
      bodyTruncated: sanitizedBody.length > body.length,
      reproduction: labeledLine(sanitizedBody, ["repro", "reproduction", "steps to reproduce"]),
      evidenceReferences: evidenceReferences(sanitizedBody),
      patchBoundary: labeledLine(sanitizedBody, ["patch boundary", "approved patch boundary", "scope boundary"]),
      sources: [source],
    });
  }

  const allFindings = [...deduplicated.values()].sort(compareFindings);
  const findings = allFindings.slice(0, MAX_FINDINGS);
  const candidateCycle = Number(task.reviewSubjectCycle || task.reviewCycle || 0);
  const subjectSha = String(task.reviewSubjectSha || "");
  const existing = currentRemediationHandoff(task);
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId: String(task.id || ""),
    candidateCycle,
    subjectSha,
    status: "open",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    findings,
    omittedFindingCount: Math.max(0, allFindings.length - findings.length),
    artifactRef: `/api/tasks/${encodeURIComponent(task.id || "")}/remediation-handoff?candidateCycle=${candidateCycle}&subjectSha=${encodeURIComponent(subjectSha)}`,
  };
}

export function currentRemediationHandoff(task) {
  const handoff = task?.remediationHandoff;
  if (!handoff || handoff.status !== "open") return null;
  if (String(handoff.taskId || "") !== String(task.id || "")) return null;
  if (Number(handoff.candidateCycle || 0) !== Number(task.reviewSubjectCycle || task.reviewCycle || 0)) return null;
  if (String(handoff.subjectSha || "") !== String(task.reviewSubjectSha || "")) return null;
  return handoff;
}

export function supersedeRemediationHandoff(task, input = {}) {
  const handoff = task?.remediationHandoff;
  if (!handoff || handoff.status !== "open") return null;
  const archived = {
    ...handoff,
    status: String(input.status || "superseded"),
    resolution: redactSensitiveText(input.resolution || "Candidate identity changed.").slice(0, 500),
    resolvedAt: String(input.now || new Date().toISOString()),
    replacementSubjectSha: String(input.replacementSubjectSha || ""),
  };
  task.remediationHistory = [...(task.remediationHistory || []), archived].slice(-MAX_HISTORY);
  task.remediationHandoff = null;
  return archived;
}

export function remediationPromptSection(task) {
  const handoff = currentRemediationHandoff(task);
  if (!handoff) return "- No current reviewer remediation handoff.";

  const lines = [
    `- Task: ${handoff.taskId}`,
    `- Candidate cycle: ${handoff.candidateCycle}`,
    `- Rejected subject SHA: ${handoff.subjectSha}`,
    `- Status: ${handoff.status}`,
    "- Findings, in required remediation order:",
  ];
  let included = 0;
  for (const finding of handoff.findings || []) {
    const sources = (finding.sources || [])
      .map((source) => `${source.stageKey}/${source.role} (${source.reviewId})`)
      .join(", ");
    const promptBody = String(finding.body || "").slice(0, MAX_PROMPT_FINDING_CHARACTERS);
    const truncated = finding.bodyTruncated || promptBody.length < String(finding.body || "").length;
    const structured = [
      finding.reproduction ? `     Reproduction: ${finding.reproduction}` : "",
      finding.patchBoundary ? `     Approved patch boundary: ${finding.patchBoundary}` : "",
      finding.evidenceReferences?.length ? `     Evidence: ${finding.evidenceReferences.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    const entry = `  ${included + 1}. [${String(finding.severity || "medium").toUpperCase()}] ${promptBody}${truncated ? " [truncated; see local artifact]" : ""}\n     Sources: ${sources}${structured ? `\n${structured}` : ""}`;
    if ([...lines, entry].join("\n").length > MAX_PROMPT_CHARACTERS) break;
    lines.push(entry);
    included += 1;
  }
  const omitted = Math.max(0, Number(handoff.omittedFindingCount || 0) + (handoff.findings || []).length - included);
  if (omitted) lines.push(`- ${omitted} additional finding(s) are available in the local artifact.`);
  lines.push(`- Local artifact: ${handoff.artifactRef}`);
  lines.push("- Resolve these findings against the current branch, record validation evidence, and do not repeat unrelated review discovery.");
  return lines.join("\n");
}

export const REMEDIATION_HANDOFF_LIMITS = Object.freeze({
  maxFindings: MAX_FINDINGS,
  maxFindingCharacters: MAX_FINDING_CHARACTERS,
  maxPromptCharacters: MAX_PROMPT_CHARACTERS,
  maxPromptFindingCharacters: MAX_PROMPT_FINDING_CHARACTERS,
  maxHistory: MAX_HISTORY,
});
