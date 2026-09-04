import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { missionControlDataDir } from "./runtime-paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const HEAD_TAIL_MARKER = "\n...[truncated]...\n";
const DEFAULT_ENVIRONMENT_POLICY_VERSION = "promotion-project-environment-v1";
const MAX_EVIDENCE_PATH_CHARS = 4_096;
const MAX_VERIFIABLE_EVIDENCE_BYTES = 512 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const PROJECT_REPOSITORY_CREDENTIAL_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_TERMINAL_PROMPT",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

const URL_USERINFO_PATTERN = /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,512}\b/gi;
const JSON_CREDENTIAL_PATTERN = /("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credential|password|passwd|secret|token|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|npm[_-]?token|openai[_-]?api[_-]?key)"[ \t\r\n]*:[ \t\r\n]*)"(?:\\(?:["\\/bfnrt]|u[a-f0-9]{4})|[^"\\\r\n]){0,16384}"/gi;
const COMMON_RAW_TOKEN_PATTERN = /\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{16,512}|(?:AKIA|ASIA)[A-Z0-9]{16}|npm_[a-z0-9]{20,256}|glpat-[a-z0-9_-]{16,256}|xox[baprs]-[a-z0-9-]{10,512}|AIza[a-z0-9_-]{20,128}|(?:sk|rk)_(?:live|test)_[a-z0-9]{16,256})\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}\b/g;
const PRIVATE_KEY_PEM_PATTERN = /-----BEGIN ((?:[A-Z0-9]+[ \t]+){0,4}PRIVATE KEY)-----[\s\S]{0,524288}?-----END \1-----/g;
const BEARER_PATTERN = /\bbearer\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b((?:(?:[a-z][a-z0-9_]*(?:token|secret|password|passwd|private_key|api_key|access_key)[a-z0-9_]*)|(?:api[-_ ]?key|access[-_ ]?token|authorization|client[-_ ]?secret|credential|password|passwd|private[-_ ]?key|secret|token))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const HTTP_CREDENTIAL_HEADER_PATTERN = /(^|[\r\n])([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*/gi;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requiredBoundedString(value, label, maximum = 500) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return normalized;
}

function requiredDigest(value, label) {
  const normalized = requiredBoundedString(value, label, 80).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function requiredGitSha(value) {
  const normalized = requiredBoundedString(value, "integration SHA", 64).toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error("integration SHA must be a full Git object ID.");
  return normalized;
}

function positiveAttempt(value) {
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("promotion validation attempt must be a positive integer.");
  }
  return attempt;
}

function normalizedCreatedAt(value) {
  const parsed = new Date(value || Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error("promotion validation createdAt must be a valid timestamp.");
  return parsed.toISOString();
}

function safePathSegment(value, label) {
  const segment = requiredBoundedString(value, label, 200)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  if (!segment) throw new Error(`${label} cannot form a safe evidence filename.`);
  return segment;
}

export function redactPromotionValidationText(value) {
  return String(value ?? "")
    .replace(PRIVATE_KEY_PEM_PATTERN, "[REDACTED]")
    .replace(HTTP_CREDENTIAL_HEADER_PATTERN, "$1$2[REDACTED]")
    .replace(JSON_CREDENTIAL_PATTERN, '$1"[REDACTED]"')
    .replace(URL_USERINFO_PATTERN, "$1[REDACTED]@")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(COMMON_RAW_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "$1[REDACTED]");
}

function credentialEnvironmentKey(key) {
  const upper = String(key || "").toUpperCase();
  return PROJECT_REPOSITORY_CREDENTIAL_KEYS.has(upper)
    || upper.startsWith("MISSION_CONTROL_GITHUB_")
    || upper === "MISSION_CONTROL_GIT_USERNAME"
    || upper.startsWith("STUDIOOPS_GITHUB_")
    || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)
    || /^GH_(?:ENTERPRISE_)?TOKEN$/.test(upper)
    || /^GITHUB_(?:APP|AUTH|INSTALLATION|PRIVATE_KEY|TOKEN)/.test(upper);
}

export function scrubProjectRepositoryCredentials(env = {}) {
  const scrubbed = { ...(env && typeof env === "object" ? env : {}) };
  for (const key of Object.keys(scrubbed)) {
    if (credentialEnvironmentKey(key)) delete scrubbed[key];
  }
  return scrubbed;
}

export function boundedHeadTail(value, limit) {
  const text = String(value ?? "");
  const maximum = Math.floor(Number(limit));
  if (!Number.isFinite(maximum) || maximum <= 0) return "";
  if (text.length <= maximum) return text;
  if (maximum <= HEAD_TAIL_MARKER.length) {
    const headLength = Math.ceil(maximum / 2);
    return `${text.slice(0, headLength)}${text.slice(-(maximum - headLength))}`;
  }
  const available = maximum - HEAD_TAIL_MARKER.length;
  const headLength = Math.ceil(available / 2);
  return `${text.slice(0, headLength)}${HEAD_TAIL_MARKER}${text.slice(-(available - headLength))}`;
}

export function promotionValidationPolicyDigest(input = {}) {
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const timeoutMs = Number(input.timeoutMs || 0);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("promotion validation timeoutMs must be a non-negative integer.");
  }
  const environmentPolicyVersion = requiredBoundedString(
    input.environmentPolicyVersion || DEFAULT_ENVIRONMENT_POLICY_VERSION,
    "promotion validation environment policy version",
    160,
  );
  const projectPolicyDigest = input.projectPolicyDigest
    ? requiredDigest(input.projectPolicyDigest, "promotion project policy digest")
    : "";
  const sandboxPolicyId = input.sandboxPolicyId
    ? requiredBoundedString(input.sandboxPolicyId, "promotion validation sandbox policy", 160)
    : "";
  const validationStrategy = input.validationStrategy
    ? requiredBoundedString(input.validationStrategy, "promotion validation strategy", 160)
    : "";
  const networkPolicy = input.networkPolicy
    ? requiredBoundedString(input.networkPolicy, "promotion validation network policy", 80)
    : "";
  const payload = {
    schemaVersion: 1,
    commands: commands.map((command) => String(
      command && typeof command === "object" && "command" in command
        ? command.command
        : command,
    )),
    timeoutMs,
    environmentPolicyVersion,
    projectPolicyDigest,
    sandboxPolicyId,
    validationStrategy,
    networkPolicy,
  };
  return sha256(JSON.stringify(payload));
}

function transcriptBytes(input) {
  const payload = {
    schemaVersion: 1,
    kind: "promotion_validation",
    candidateId: input.candidateId,
    manifestDigest: input.manifestDigest,
    integrationSha: input.integrationSha,
    attempt: input.attempt,
    policyDigest: input.policyDigest,
    createdAt: input.createdAt,
    commands: input.commands.map((entry, index) => ({
      index: index + 1,
      command: redactPromotionValidationText(entry?.command),
      ok: entry?.ok === true,
      output: redactPromotionValidationText(entry?.output),
    })),
  };
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function ensurePrivateRoot(root) {
  if (root === path.parse(root).root) {
    throw new Error("promotion validation evidence root cannot be a filesystem root.");
  }
  await mkdir(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("promotion validation evidence root must be a real directory.");
  }
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  const after = await lstat(root);
  if ((after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("promotion validation evidence root is not mode 0700.");
  }
}

async function assertPrivateRoot(root) {
  if (root === path.parse(root).root) {
    throw new Error("promotion validation evidence root cannot be a filesystem root.");
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("promotion validation evidence root must be a real directory.");
  }
  if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("promotion validation evidence root is not mode 0700.");
  }
}

function expectedEvidenceBytes(value) {
  const bytes = Number(value);
  if (
    !Number.isSafeInteger(bytes)
    || bytes < 1
    || bytes > MAX_VERIFIABLE_EVIDENCE_BYTES
  ) {
    throw new Error("promotion validation evidence byte count is invalid or exceeds the verification limit.");
  }
  return bytes;
}

function defaultEvidenceRoot() {
  return path.join(missionControlDataDir(), "private-evidence", "promotion-validation");
}

function resolvedEvidenceRoot(value) {
  return path.resolve(String(value || defaultEvidenceRoot()));
}

function evidenceCoordinates(input = {}) {
  return {
    candidateId: requiredBoundedString(input.candidateId, "candidate ID", 200),
    manifestDigest: requiredDigest(input.manifestDigest, "candidate manifest digest"),
    integrationSha: requiredGitSha(input.integrationSha),
    attempt: positiveAttempt(input.attempt),
    policyDigest: requiredDigest(input.policyDigest, "promotion validation policy digest"),
  };
}

async function syncDirectory(root) {
  const handle = await open(root, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyPromotionValidationEvidence(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("promotion validation evidence metadata must be an object.");
  }
  const root = resolvedEvidenceRoot(options.root);
  await assertPrivateRoot(root);
  const pathname = path.resolve(requiredBoundedString(
    input.path,
    "promotion validation evidence path",
    MAX_EVIDENCE_PATH_CHARS,
  ));
  if (path.dirname(pathname) !== root) {
    throw new Error("promotion validation evidence path must be a direct child of its private root.");
  }
  const expectedDigest = requiredDigest(input.digest, "promotion validation evidence digest");
  const bytes = expectedEvidenceBytes(input.bytes);
  const coordinates = evidenceCoordinates(input);

  const pathInfo = await lstat(pathname);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error("promotion validation evidence path is not a regular file.");
  }

  let handle;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("promotion validation evidence path is not a regular file.");
    if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("promotion validation evidence file is not mode 0600.");
    }
    if (info.size !== bytes) {
      throw new Error("promotion validation evidence byte count does not match persisted metadata.");
    }
    const stored = await handle.readFile();
    if (stored.length !== bytes || sha256(stored) !== expectedDigest) {
      throw new Error("promotion validation evidence digest verification failed.");
    }
    let transcript;
    try {
      transcript = JSON.parse(stored.toString("utf8"));
    } catch {
      throw new Error("promotion validation evidence transcript is not valid JSON.");
    }
    if (
      transcript?.schemaVersion !== 1
      || transcript?.kind !== "promotion_validation"
      || transcript?.candidateId !== coordinates.candidateId
      || transcript?.manifestDigest !== coordinates.manifestDigest
      || transcript?.integrationSha !== coordinates.integrationSha
      || transcript?.attempt !== coordinates.attempt
      || transcript?.policyDigest !== coordinates.policyDigest
    ) {
      throw new Error("promotion validation evidence transcript identity does not match persisted metadata.");
    }
  } finally {
    if (handle) await handle.close();
  }

  return {
    verified: true,
    path: pathname,
    digest: expectedDigest,
    bytes,
    ...coordinates,
  };
}

export async function persistPromotionValidationEvidence(input = {}) {
  const root = resolvedEvidenceRoot(input.root);
  const {
    candidateId,
    manifestDigest,
    integrationSha,
    attempt,
    policyDigest,
  } = evidenceCoordinates(input);
  const createdAt = normalizedCreatedAt(input.createdAt);
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const identifier = safePathSegment(
    (input.idFactory || randomUUID)(),
    "promotion validation evidence ID",
  );
  const candidateSegment = safePathSegment(candidateId, "candidate ID");
  const filename = `${candidateSegment}-attempt-${attempt}-${identifier}.json`;
  const finalPath = path.join(root, filename);
  const temporaryPath = path.join(root, `.${filename}.${randomUUID()}.tmp`);
  const bytes = transcriptBytes({
    candidateId,
    manifestDigest,
    integrationSha,
    attempt,
    policyDigest,
    createdAt,
    commands,
  });
  const digest = sha256(bytes);

  await ensurePrivateRoot(root);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    temporaryExists = true;
    await handle.writeFile(bytes);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        const collision = new Error("promotion validation evidence destination already exists.");
        collision.code = "EEXIST";
        throw collision;
      }
      throw error;
    }
    await syncDirectory(root);
    await unlink(temporaryPath);
    temporaryExists = false;
    await syncDirectory(root);
    const metadata = {
      path: finalPath,
      digest,
      bytes: bytes.length,
      createdAt,
      candidateId,
      manifestDigest,
      integrationSha,
      attempt,
      policyDigest,
      commandCount: commands.length,
    };
    await verifyPromotionValidationEvidence(metadata, { root });
    return metadata;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
