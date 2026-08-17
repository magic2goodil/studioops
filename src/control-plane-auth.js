import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  missionControlAuthDir,
  missionControlOperatorLogPath,
} from "./runtime-paths.js";

const scrypt = promisify(scryptCallback);
const OWNER_FILE = "owner.json";
const BOOTSTRAP_FILE = "bootstrap.json";
const SERVICE_CAPABILITY_FILE = "service-capabilities.json";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_REAUTH_TTL_MS = 2 * 60 * 1000;
const DEFAULT_BOOTSTRAP_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const PASSWORD_MIN_LENGTH = 12;

export class ControlPlaneAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ControlPlaneAuthError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function authError(status, code, message) {
  return new ControlPlaneAuthError(status, code, message);
}

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function opaqueSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function digestSecret(secret) {
  return createHash("sha256").update(String(secret || ""), "utf8").digest("base64url");
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value ?? null;
}

function bindingDigest(binding = {}) {
  return digestSecret(JSON.stringify(canonicalize({
    action: String(binding.action || "").trim(),
    aggregateId: String(binding.aggregateId || "").trim(),
    aggregateVersion: Number(binding.aggregateVersion),
    candidateIdentity: binding.candidateIdentity ?? null,
  })));
}

function validateBinding(binding = {}) {
  const action = String(binding.action || "").trim();
  const aggregateId = String(binding.aggregateId || "").trim();
  const aggregateVersion = Number(binding.aggregateVersion);
  if (!action || !aggregateId || !Number.isSafeInteger(aggregateVersion) || aggregateVersion < 0) {
    throw authError(400, "invalid_reauthentication_binding", "Action, aggregate ID, and aggregate version are required.");
  }
  return {
    action,
    aggregateId,
    aggregateVersion,
    candidateIdentity: binding.candidateIdentity ?? null,
  };
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN_LENGTH || value.length > 1024) {
    throw authError(400, "invalid_password", `Owner password must be ${PASSWORD_MIN_LENGTH}-1024 characters.`);
  }
  return value;
}

async function passwordRecord(password, options = {}) {
  const salt = randomBytes(16);
  const N = Number(options.scryptCost || 32768);
  const r = 8;
  const p = 1;
  const keyLength = 32;
  const hash = await scrypt(password, salt, keyLength, { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) });
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: Buffer.from(hash).toString("base64"),
    N,
    r,
    p,
    keyLength,
  };
}

async function passwordMatches(password, record) {
  if (!record || record.algorithm !== "scrypt") return false;
  const expected = Buffer.from(String(record.hash || ""), "base64");
  if (!expected.length) return false;
  const actual = await scrypt(String(password || ""), Buffer.from(String(record.salt || ""), "base64"), expected.length, {
    N: Number(record.N),
    r: Number(record.r),
    p: Number(record.p),
    maxmem: Math.max(64 * 1024 * 1024, 256 * Number(record.N) * Number(record.r)),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${opaqueSecret(6)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function requirePrivateFile(filePath) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
    throw new Error(`Control-plane credential file must be a regular owner-only file: ${path.basename(filePath)}`);
  }
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    const key = part.slice(0, separator).trim();
    try {
      return [key, decodeURIComponent(part.slice(separator + 1).trim())];
    } catch {
      return [key, ""];
    }
  }).filter(([key]) => key));
}

function boundedMapSet(map, key, value, maximum) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function publicOwner(owner) {
  return {
    id: owner.ownerId,
    displayName: owner.displayName,
    role: "owner",
    credentialVersion: owner.credentialVersion,
  };
}

function newRecoveryCodes(count = 8) {
  const values = Array.from({ length: count }, () => opaqueSecret(12));
  return {
    values,
    records: values.map((value) => ({ digest: digestSecret(value), usedAt: "" })),
  };
}

export async function loadServiceCapabilities(authDir = missionControlAuthDir()) {
  const filePath = path.join(authDir, SERVICE_CAPABILITY_FILE);
  let entries;
  try {
    await requirePrivateFile(filePath);
    entries = await readJson(filePath, []);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!Array.isArray(entries)) throw new Error("Service capability file must contain a JSON array.");
  if (!entries.length) return [];
  return entries.map((entry) => {
    const token = String(entry.token || "");
    if (token.length < 32) throw new Error("Every service capability token must contain at least 32 characters.");
    return {
      token,
      capabilities: [...new Set((entry.capabilities || []).map(String))],
      actor: {
        id: String(entry.actor?.id || entry.id || "local-service"),
        type: String(entry.actor?.type || "system"),
        role: String(entry.actor?.role || "workflow-engine"),
        displayName: String(entry.actor?.displayName || entry.actor?.id || entry.id || "Local service"),
        runId: String(entry.actor?.runId || ""),
        leaseId: String(entry.actor?.leaseId || ""),
      },
    };
  });
}

export function createControlPlaneAuth(options = {}) {
  const authDir = path.resolve(options.authDir || missionControlAuthDir());
  const operatorLogPath = path.resolve(options.operatorLogPath || missionControlOperatorLogPath());
  const ownerPath = path.join(authDir, OWNER_FILE);
  const bootstrapPath = path.join(authDir, BOOTSTRAP_FILE);
  const clock = options.clock || (() => Date.now());
  const sessions = new Map();
  const grants = new Map();
  const failures = new Map();
  const serviceCapabilities = (options.serviceCapabilities || []).map((entry) => ({
    digest: digestSecret(entry.token),
    capabilities: new Set(entry.capabilities || []),
    actor: {
      id: String(entry.actor?.id || entry.id || "local-service"),
      type: String(entry.actor?.type || "system"),
      role: String(entry.actor?.role || "workflow-engine"),
      displayName: String(entry.actor?.displayName || entry.actor?.id || entry.id || "Local service"),
      runId: String(entry.actor?.runId || ""),
      leaseId: String(entry.actor?.leaseId || ""),
    },
  }));
  const sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
  const sessionIdleMs = Number(options.sessionIdleMs || DEFAULT_SESSION_IDLE_MS);
  const maxSessions = Number(options.maxSessions || DEFAULT_MAX_SESSIONS);
  const reauthTtlMs = Number(options.reauthTtlMs || DEFAULT_REAUTH_TTL_MS);
  const bootstrapTtlMs = Number(options.bootstrapTtlMs || DEFAULT_BOOTSTRAP_TTL_MS);
  const throttleWindowMs = Number(options.throttleWindowMs || 5 * 60 * 1000);
  const throttleLimit = Number(options.throttleLimit || 5);
  let owner = null;
  let mutation = Promise.resolve();

  function serial(operation) {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => {});
    return result;
  }

  async function writeOwner(nextOwner) {
    await atomicWriteJson(ownerPath, nextOwner);
    owner = nextOwner;
  }

  async function issueBootstrap() {
    const nowMs = clock();
    const existing = await readJson(bootstrapPath, null);
    if (existing && Date.parse(existing.expiresAt) > nowMs && existing.digest) return false;
    const secret = opaqueSecret(32);
    const record = {
      version: 1,
      digest: digestSecret(secret),
      createdAt: nowIso(nowMs),
      expiresAt: nowIso(nowMs + bootstrapTtlMs),
    };
    await ensurePrivateDirectory(path.dirname(operatorLogPath));
    try {
      await requirePrivateFile(operatorLogPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await appendFile(
      operatorLogPath,
      `[${nowIso(nowMs)}] StudioOps first-run owner bootstrap secret (single use): ${secret}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(operatorLogPath, 0o600);
    await atomicWriteJson(bootstrapPath, record);
    return true;
  }

  function purgeExpired() {
    const nowMs = clock();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= nowMs || session.idleExpiresAt <= nowMs) sessions.delete(id);
    }
    for (const [id, grant] of grants) if (grant.expiresAt <= nowMs) grants.delete(id);
    for (const [key, record] of failures) if (record.windowStartedAt + throttleWindowMs <= nowMs) failures.delete(key);
  }

  function issueSession(secure = false) {
    purgeExpired();
    const nowMs = clock();
    const id = opaqueSecret(32);
    const csrfToken = opaqueSecret(32);
    boundedMapSet(sessions, id, {
      id,
      csrfDigest: digestSecret(csrfToken),
      createdAt: nowMs,
      expiresAt: nowMs + sessionTtlMs,
      idleExpiresAt: nowMs + Math.min(sessionIdleMs, sessionTtlMs),
      credentialVersion: owner.credentialVersion,
    }, maxSessions);
    return {
      csrfToken,
      cookie: `studioops_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(sessionTtlMs / 1000))}${secure ? "; Secure" : ""}`,
      expiresAt: nowIso(nowMs + sessionTtlMs),
    };
  }

  function clearCookie(secure = false) {
    return `studioops_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  function throttleKey(input = {}) {
    return digestSecret(`${String(input.remoteAddress || "local").slice(0, 160)}:${String(input.kind || "login")}`);
  }

  function assertNotThrottled(key) {
    purgeExpired();
    const current = failures.get(key);
    if (current && current.count >= throttleLimit) {
      throw authError(429, "authentication_throttled", "Too many authentication attempts. Try again later.");
    }
  }

  function recordFailure(key) {
    const nowMs = clock();
    const current = failures.get(key);
    boundedMapSet(failures, key, current && current.windowStartedAt + throttleWindowMs > nowMs
      ? { ...current, count: current.count + 1 }
      : { count: 1, windowStartedAt: nowMs }, 256);
  }

  function clearFailures(key) {
    failures.delete(key);
  }

  async function authenticatePassword(password, input = {}) {
    const key = throttleKey(input);
    assertNotThrottled(key);
    const valid = Boolean(owner) && await passwordMatches(String(password || ""), owner.password);
    if (!valid) {
      recordFailure(key);
      throw authError(401, "invalid_credentials", "Owner credentials are invalid.");
    }
    clearFailures(key);
    return true;
  }

  return {
    authDir,
    operatorLogPath,
    get enrolled() {
      return Boolean(owner);
    },
    async initialize() {
      await ensurePrivateDirectory(authDir);
      try {
        await requirePrivateFile(ownerPath);
        owner = await readJson(ownerPath, null);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        owner = null;
      }
      if (owner) {
        try { await unlink(bootstrapPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
        return { enrolled: true, bootstrapCreated: false, operatorLogPath };
      }
      return { enrolled: false, bootstrapCreated: await issueBootstrap(), operatorLogPath };
    },
    async enroll(input = {}) {
      return serial(async () => {
        if (owner) throw authError(409, "owner_already_enrolled", "The local owner is already enrolled.");
        const key = throttleKey({ ...input, kind: "enrollment" });
        assertNotThrottled(key);
        const bootstrap = await readJson(bootstrapPath, null);
        if (!bootstrap || Date.parse(bootstrap.expiresAt) <= clock()) {
          await issueBootstrap();
          throw authError(401, "bootstrap_expired", "The bootstrap secret is invalid or expired. Read the local operator log for the replacement.");
        }
        if (!safeEqualText(digestSecret(input.bootstrapSecret), bootstrap.digest)) {
          recordFailure(key);
          throw authError(401, "invalid_bootstrap_secret", "The bootstrap secret is invalid or expired.");
        }
        const password = validatePassword(input.password);
        const recovery = newRecoveryCodes();
        const nowMs = clock();
        const nextOwner = {
          version: 1,
          ownerId: `owner_${opaqueSecret(12)}`,
          displayName: String(input.displayName || "Local Owner").trim().slice(0, 120) || "Local Owner",
          credentialVersion: 1,
          password: await passwordRecord(password, options),
          recoveryCodes: recovery.records,
          createdAt: nowIso(nowMs),
          updatedAt: nowIso(nowMs),
        };
        await writeOwner(nextOwner);
        await unlink(bootstrapPath);
        clearFailures(key);
        const session = issueSession(input.secure === true);
        return { owner: publicOwner(owner), recoveryCodes: recovery.values, ...session };
      });
    },
    async login(input = {}) {
      await authenticatePassword(input.password, { ...input, kind: "login" });
      return { owner: publicOwner(owner), ...issueSession(input.secure === true) };
    },
    authenticateRequest(headers = {}) {
      purgeExpired();
      const authorization = String(headers.authorization || "");
      if (authorization.startsWith("Bearer ")) {
        const digest = digestSecret(authorization.slice(7).trim());
        const service = serviceCapabilities.find((entry) => safeEqualText(entry.digest, digest));
        if (!service) throw authError(401, "invalid_service_capability", "Service capability is invalid.");
        return {
          kind: "service",
          capabilities: service.capabilities,
          actor: { ...service.actor },
        };
      }
      const sessionId = parseCookies(headers.cookie).studioops_session;
      const session = sessions.get(sessionId);
      if (!session || !owner || session.credentialVersion !== owner.credentialVersion) {
        if (sessionId) sessions.delete(sessionId);
        throw authError(401, "authentication_required", "An authenticated owner session or service capability is required.");
      }
      const nowMs = clock();
      session.idleExpiresAt = Math.min(session.expiresAt, nowMs + sessionIdleMs);
      return {
        kind: "session",
        sessionId,
        session,
        capabilities: new Set(["*"]),
        actor: { id: owner.ownerId, type: "owner", role: "owner", displayName: owner.displayName },
      };
    },
    authorize(context, capability) {
      if (!capability || context.capabilities.has("*") || context.capabilities.has(capability)) return;
      throw authError(403, "capability_denied", "The authenticated actor does not have the required capability.");
    },
    verifyCsrf(context, token) {
      if (context.kind !== "session") return;
      if (!token || !safeEqualText(digestSecret(token), context.session.csrfDigest)) {
        throw authError(403, "csrf_rejected", "The CSRF token is missing or invalid.");
      }
    },
    logout(context, secure = false) {
      if (context?.sessionId) sessions.delete(context.sessionId);
      return { cookie: clearCookie(secure) };
    },
    async rotatePassword(context, input = {}) {
      if (context.kind !== "session") throw authError(403, "owner_session_required", "Credential rotation requires an owner session.");
      return serial(async () => {
        await authenticatePassword(input.currentPassword, { ...input, kind: "rotation" });
        const password = validatePassword(input.newPassword);
        const recovery = newRecoveryCodes();
        await writeOwner({
          ...owner,
          credentialVersion: Number(owner.credentialVersion || 1) + 1,
          password: await passwordRecord(password, options),
          recoveryCodes: recovery.records,
          updatedAt: nowIso(clock()),
        });
        sessions.clear();
        grants.clear();
        return { owner: publicOwner(owner), recoveryCodes: recovery.values, ...issueSession(input.secure === true) };
      });
    },
    async recover(input = {}) {
      return serial(async () => {
        const key = throttleKey({ ...input, kind: "recovery" });
        assertNotThrottled(key);
        if (!owner) throw authError(401, "recovery_rejected", "Recovery credentials are invalid.");
        const digest = digestSecret(input.recoveryCode);
        const codeIndex = (owner.recoveryCodes || []).findIndex((entry) => !entry.usedAt && safeEqualText(entry.digest, digest));
        if (codeIndex < 0) {
          recordFailure(key);
          throw authError(401, "recovery_rejected", "Recovery credentials are invalid.");
        }
        const password = validatePassword(input.newPassword);
        const recoveryCodes = (owner.recoveryCodes || []).map((entry, index) => index === codeIndex
          ? { ...entry, usedAt: nowIso(clock()) }
          : entry);
        await writeOwner({
          ...owner,
          credentialVersion: Number(owner.credentialVersion || 1) + 1,
          password: await passwordRecord(password, options),
          recoveryCodes,
          updatedAt: nowIso(clock()),
        });
        clearFailures(key);
        sessions.clear();
        grants.clear();
        return { owner: publicOwner(owner), ...issueSession(input.secure === true) };
      });
    },
    async createReauthenticationGrant(context, input = {}) {
      if (context.kind !== "session") throw authError(403, "owner_session_required", "Reauthentication requires an owner session.");
      await authenticatePassword(input.password, { ...input, kind: "reauthentication" });
      const binding = validateBinding(input);
      const nowMs = clock();
      const token = opaqueSecret(32);
      boundedMapSet(grants, digestSecret(token), {
        bindingDigest: bindingDigest(binding),
        ownerId: context.actor.id,
        credentialVersion: owner.credentialVersion,
        expiresAt: nowMs + reauthTtlMs,
      }, 64);
      return { grant: token, expiresAt: nowIso(nowMs + reauthTtlMs), binding };
    },
    consumeReauthenticationGrant(context, token, input = {}) {
      if (context.kind !== "session") throw authError(403, "owner_session_required", "This decision requires an owner session.");
      if (!token) throw authError(428, "reauthentication_required", "A recent reauthentication grant is required.");
      purgeExpired();
      const key = digestSecret(token);
      const grant = grants.get(key);
      grants.delete(key);
      const binding = validateBinding(input);
      if (
        !grant
        || grant.ownerId !== context.actor.id
        || grant.credentialVersion !== owner.credentialVersion
        || !safeEqualText(grant.bindingDigest, bindingDigest(binding))
      ) {
        throw authError(428, "reauthentication_required", "The reauthentication grant is invalid, expired, used, or bound to another decision.");
      }
      return true;
    },
    sessionCount() {
      purgeExpired();
      return sessions.size;
    },
  };
}
