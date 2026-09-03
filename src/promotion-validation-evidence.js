import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { missionControlDataDir } from "./runtime-paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const HEAD_TAIL_MARKER = "\n...[truncated]...\n";
const DEFAULT_ENVIRONMENT_POLICY_VERSION = "promotion-project-environment-v1";
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
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi;
const BEARER_PATTERN = /\bbearer\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b((?:(?:[a-z][a-z0-9_]*(?:token|secret|password|passwd|private_key|api_key|access_key)[a-z0-9_]*)|(?:api[-_ ]?key|access[-_ ]?token|authorization|client[-_ ]?secret|credential|password|passwd|private[-_ ]?key|secret|token))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

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
    .replace(URL_USERINFO_PATTERN, "$1[REDACTED]@")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
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
  const payload = {
    schemaVersion: 1,
    commands: commands.map((command) => String(
      command && typeof command === "object" && "command" in command
        ? command.command
        : command,
    )),
    timeoutMs,
    environmentPolicyVersion,
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

async function verifiedEvidence(pathname, expectedBytes, expectedDigest) {
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("promotion validation evidence path is not a regular file.");
  }
  if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("promotion validation evidence file is not mode 0600.");
  }
  const stored = await readFile(pathname);
  if (!stored.equals(expectedBytes)) {
    throw new Error("promotion validation evidence bytes changed during persistence.");
  }
  if (sha256(stored) !== expectedDigest) {
    throw new Error("promotion validation evidence digest verification failed.");
  }
  return stored.length;
}

async function assertEvidenceDestinationIsNew(pathname) {
  try {
    await lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("promotion validation evidence destination already exists.");
}

export async function persistPromotionValidationEvidence(input = {}) {
  const root = path.resolve(
    String(input.root || path.join(missionControlDataDir(), "private-evidence", "promotion-validation")),
  );
  const candidateId = requiredBoundedString(input.candidateId, "candidate ID", 200);
  const manifestDigest = requiredDigest(input.manifestDigest, "candidate manifest digest");
  const integrationSha = requiredGitSha(input.integrationSha);
  const attempt = positiveAttempt(input.attempt);
  const policyDigest = requiredDigest(input.policyDigest, "promotion validation policy digest");
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
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertEvidenceDestinationIsNew(finalPath);
    await rename(temporaryPath, finalPath);
    renamed = true;
    await chmod(finalPath, PRIVATE_FILE_MODE);
    const storedBytes = await verifiedEvidence(finalPath, bytes, digest);
    return {
      path: finalPath,
      digest,
      bytes: storedBytes,
      createdAt,
      candidateId,
      manifestDigest,
      integrationSha,
      attempt,
      policyDigest,
      commandCount: commands.length,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
