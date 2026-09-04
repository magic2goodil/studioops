import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./github-app-auth.js";

export const MAX_VALIDATION_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MAX_VALIDATION_PASS_SUMMARY_CHARS = 4 * 1024;
export const MAX_VALIDATION_FAILURE_EXCERPT_CHARS = 8 * 1024;

const SECRET_ENV_PATTERN = /(?:token|secret|password|private[_-]?key|api[_-]?key|authorization|credential)/i;

function genericRedaction(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED TOKEN]");
}

function knownSecrets(env = process.env) {
  return [...new Set(Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_PATTERN.test(key) && String(value || "").length >= 8)
    .map(([, value]) => String(value)))]
    .sort((left, right) => right.length - left.length);
}

export function redactValidationOutput(value, env = process.env) {
  return genericRedaction(redactSecrets(value, knownSecrets(env)));
}

export function boundedValidationTranscript(value, outcome) {
  const text = String(value || "");
  const limit = outcome === "passed"
    ? MAX_VALIDATION_PASS_SUMMARY_CHARS
    : MAX_VALIDATION_FAILURE_EXCERPT_CHARS;
  if (text.length <= limit) return text;
  const marker = `\n… StudioOps omitted ${text.length - limit} validation-output characters; see the local evidence artifact …\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.floor(available * 0.25);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function safeArtifactPath(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error("Validation artifact path escaped its runner-managed evidence root.");
  }
  return absoluteCandidate;
}

function evidenceLine(value) {
  return String(value ?? "").replace(/[\r\n=]/g, "_");
}

export async function executeValidationCommand(input = {}) {
  const command = String(input.command || "").trim();
  if (!command) throw new Error("Validation command is required.");
  const artifactRoot = path.resolve(String(input.artifactRoot || ""));
  const artifactPath = safeArtifactPath(artifactRoot, input.artifactPath);
  const evidencePath = safeArtifactPath(artifactRoot, input.evidencePath);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

  const startedAt = Date.now();
  const hash = createHash("sha256");
  let artifactBytes = 0;
  let artifactTruncated = false;
  let transcript = "";
  let redactionCarry = "";
  const redactionCarryLimit = Math.max(8_192, ...knownSecrets(input.env || process.env).map((secret) => secret.length));
  const transcriptLimit = MAX_VALIDATION_FAILURE_EXCERPT_CHARS * 4;
  await writeFile(artifactPath, "", { mode: 0o600 });

  const appendRedacted = async (chunk, flush = false) => {
    const combined = `${redactionCarry}${String(chunk || "")}`;
    const carryChars = flush ? 0 : Math.min(redactionCarryLimit, combined.length);
    const body = carryChars ? combined.slice(0, -carryChars) : combined;
    redactionCarry = carryChars ? combined.slice(-carryChars) : "";
    if (!body) return;
    const redacted = redactValidationOutput(body, input.env || process.env);
    const bytes = Buffer.from(redacted);
    const remaining = Math.max(0, MAX_VALIDATION_ARTIFACT_BYTES - artifactBytes);
    const accepted = bytes.subarray(0, remaining);
    if (accepted.length) {
      await appendFile(artifactPath, accepted);
      hash.update(accepted);
      artifactBytes += accepted.length;
    }
    if (accepted.length < bytes.length) artifactTruncated = true;
    transcript = `${transcript}${redacted}`.slice(-transcriptLimit);
  };

  const child = spawn("/bin/sh", ["-lc", command], {
    cwd: input.cwd || process.cwd(),
    env: input.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captureChain = Promise.resolve();
  const capture = (chunk) => {
    captureChain = captureChain.then(() => appendRedacted(chunk));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: Number(code ?? 1), signal: signal || "" }));
  });
  await captureChain;
  await appendRedacted("", true);
  await chmod(artifactPath, 0o600);

  const outcome = status.code === 0 ? "passed" : "failed";
  const durationMs = Math.max(0, Date.now() - startedAt);
  const metadata = {
    label: String(input.label || "validation"),
    commandDigest: String(input.commandDigest || ""),
    outcome,
    exitCode: status.code,
    signal: status.signal,
    durationMs,
    artifactPath,
    artifactDigest: `sha256:${hash.digest("hex")}`,
    artifactBytes,
    artifactTruncated,
    environmentContractDigest: String(input.environmentContractDigest || ""),
    sourceSha: String(input.sourceSha || ""),
    treeSha: String(input.treeSha || ""),
    baseSha: String(input.baseSha || ""),
    manifestDigest: String(input.manifestDigest || ""),
    selectedComponentsDigest: String(input.selectedComponentsDigest || ""),
    candidateCycle: Math.max(0, Number(input.candidateCycle || 0)),
  };
  const prefix = `command_${Math.max(1, Number(input.commandIndex || 1))}`;
  await appendFile(evidencePath, [
    `${prefix}_label=${evidenceLine(metadata.label)}`,
    `${prefix}_digest=${evidenceLine(metadata.commandDigest)}`,
    `${prefix}_outcome=${outcome}`,
    `${prefix}_exit_code=${metadata.exitCode}`,
    `${prefix}_duration_ms=${durationMs}`,
    `${prefix}_artifact_path=${evidenceLine(artifactPath)}`,
    `${prefix}_artifact_digest=${metadata.artifactDigest}`,
    `${prefix}_artifact_bytes=${artifactBytes}`,
    `${prefix}_artifact_truncated=${artifactTruncated}`,
    `${prefix}_environment_contract_digest=${evidenceLine(metadata.environmentContractDigest)}`,
    `${prefix}_source_sha=${evidenceLine(metadata.sourceSha)}`,
    `${prefix}_tree_sha=${evidenceLine(metadata.treeSha)}`,
    `${prefix}_base_sha=${evidenceLine(metadata.baseSha)}`,
    `${prefix}_manifest_digest=${evidenceLine(metadata.manifestDigest)}`,
    `${prefix}_selected_components_digest=${evidenceLine(metadata.selectedComponentsDigest)}`,
    `${prefix}_candidate_cycle=${metadata.candidateCycle}`,
    "",
  ].join("\n"), { mode: 0o600 });
  await chmod(evidencePath, 0o600);
  return { ...metadata, transcript: boundedValidationTranscript(transcript, outcome) };
}

async function main() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Validation descriptor is required.");
  const descriptor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const result = await executeValidationCommand({ ...descriptor, env: process.env });
  const stream = result.outcome === "passed" ? process.stdout : process.stderr;
  if (result.transcript) stream.write(result.transcript.endsWith("\n") ? result.transcript : `${result.transcript}\n`);
  stream.write(`StudioOps validation ${result.outcome}; artifact ${result.artifactDigest} (${result.artifactBytes} bytes${result.artifactTruncated ? ", capped" : ""}).\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`StudioOps validation evidence helper failed: ${redactValidationOutput(error.message)}\n`);
    process.exitCode = 1;
  });
}
