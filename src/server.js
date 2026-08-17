import http from "node:http";
import https from "node:https";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addComment,
  addProject,
  addTask,
  automationTick,
  generatePrompt,
  readState,
  recordQaBundleDecision,
  recordQaDecision,
  recordReview,
  resetAutomationCircuit,
  resumeOperatorAutomation,
  setOperatorPause,
  taskWithProject,
  transitionTask,
  updateProject,
  updateTask,
} from "./store.js";
import { loadConfig } from "./config.js";
import { buildOwnerInbox } from "./owner-inbox.js";
import { localProductAccess, productCatalog } from "./product-tiers.js";
import { currentRemediationHandoff } from "./remediation-handoff.js";
import {
  ControlPlaneAuthError,
  createControlPlaneAuth,
  loadServiceCapabilities,
} from "./control-plane-auth.js";
import {
  missionControlAttachmentRoots,
  missionControlAuthDir,
  missionControlOperatorLogPath,
} from "./runtime-paths.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DEFAULT_BODY_LIMIT = 64 * 1024;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const OWNER_REAUTH_ACTIONS = new Set([
  "approve_owner_review",
  "close_task",
  "finish_task",
  "owner_override",
  "pass_qa",
  "record_deployment",
  "record_merge",
  "resume_promotion",
]);
const TASK_METADATA_FIELDS = new Set([
  "title", "description", "priority", "type", "area", "lane", "parentTaskId",
  "userStory", "expectedOutcome", "affectedSurfaces", "validationPlan", "riskClassification",
  "architectureDecision", "architectureWaiver", "reasoningEffort", "tokenBudget", "costBudget", "deliveryMode",
  "privacyNotes", "securityNotes", "branchName", "prUrl", "operationalLocalArtifactRef",
  "acceptanceCriteria", "labels", "dependsOnTaskIds", "workAreas", "attachments",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const IMAGE_MIME_TYPES = new Map(Object.entries(MIME_TYPES).filter(([, value]) => value.startsWith("image/")));

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.expose = true;
  }
}

function httpError(status, code, message, headers) {
  return new HttpError(status, code, message, headers);
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function loopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function authority(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\s/@]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    return { host: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

export function buildControlPlaneConfig(env = process.env) {
  const host = String(env.STUDIOOPS_HOST || env.MISSION_CONTROL_HOST || env.HOST || "127.0.0.1").trim();
  const port = Number(env.STUDIOOPS_PORT || env.MISSION_CONTROL_PORT || env.PORT || 4317);
  if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("Control-plane host and port configuration is invalid.");
  }
  const mode = String(env.STUDIOOPS_CONTROL_PLANE_MODE || "loopback").trim().toLowerCase();
  if (!["loopback", "lan"].includes(mode)) throw new Error("STUDIOOPS_CONTROL_PLANE_MODE must be loopback or lan.");
  const scheme = mode === "lan" ? "https" : "http";
  const allowedHosts = splitList(env.STUDIOOPS_ALLOWED_HOSTS).map((item) => authority(item)?.host).filter(Boolean);
  const allowedOrigins = splitList(env.STUDIOOPS_ALLOWED_ORIGINS).map((item) => {
    try {
      const parsed = new URL(item);
      return parsed.protocol === "https:" ? parsed.origin : "";
    } catch { return ""; }
  }).filter(Boolean);
  return Object.freeze({
    mode,
    host,
    port,
    scheme,
    tlsKeyPath: String(env.STUDIOOPS_TLS_KEY || "").trim(),
    tlsCertPath: String(env.STUDIOOPS_TLS_CERT || "").trim(),
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
    attachmentRoots: Object.freeze(missionControlAttachmentRoots()),
  });
}

export function validateControlPlaneStartup(config, enrolled) {
  const binding = authority(config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host);
  const loopback = binding ? loopbackHostname(binding.hostname) : loopbackHostname(config.host);
  if (config.mode === "loopback" && !loopback) {
    throw new Error("Non-loopback binding requires STUDIOOPS_CONTROL_PLANE_MODE=lan.");
  }
  if (config.mode === "lan") {
    if (!config.tlsKeyPath || !config.tlsCertPath) throw new Error("Secured LAN mode requires explicit TLS key and certificate paths.");
    if (!config.allowedHosts.length || !config.allowedOrigins.length) throw new Error("Secured LAN mode requires explicit allowed hosts and origins.");
    if (!enrolled) throw new Error("Secured LAN mode requires an enrolled local owner. Enroll in loopback mode first.");
  }
}

function applySecurityHeaders(res, config) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (config.mode === "lan") res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(body);
}

function errorResponse(res, error) {
  const exposed = error instanceof HttpError || error instanceof ControlPlaneAuthError || error.expose === true;
  const conflict = error.code === "STALE_STATE_VERSION" || /\b(conflict|drift|mismatch|must|cannot|does not|has no|not ready|blocked|refus|current status|already enrolled)\b/i.test(String(error.message || ""));
  const invalid = /\b(invalid|required|unknown|not found|missing|cannot be supplied|must contain|must include)\b/i.test(String(error.message || ""));
  const status = exposed && Number.isInteger(error.status) ? error.status : conflict ? 409 : invalid ? 400 : 500;
  const code = exposed ? String(error.code || "request_rejected") : conflict ? "state_conflict" : invalid ? "invalid_request" : "internal_error";
  const message = exposed ? error.message : conflict ? "The request conflicts with current aggregate state." : invalid ? "The request is invalid." : "The request could not be completed.";
  sendJson(res, status, { error: message, code }, exposed ? error.headers : {});
}

function validateHostHeader(req, config) {
  const parsed = authority(req.headers.host);
  if (!parsed) throw httpError(400, "invalid_host", "The request Host header is invalid.");
  if (config.mode === "lan") {
    if (!config.allowedHosts.includes(parsed.host)) throw httpError(403, "host_rejected", "The request Host is not allowed.");
    return parsed.host;
  }
  if (!loopbackHostname(parsed.hostname)) throw httpError(403, "host_rejected", "The request Host is not allowed.");
  if (config.port && parsed.port !== String(config.port)) throw httpError(403, "host_rejected", "The request Host is not allowed.");
  return parsed.host;
}

function validateBrowserBoundary(req, config, validatedHost, mutation) {
  const origin = String(req.headers.origin || "").trim();
  const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw httpError(403, "cross_site_request_rejected", "Cross-site requests are not allowed.");
  }
  if (!origin) {
    if (mutation) throw httpError(403, "origin_required", "Mutation requests require an exact allowed Origin.");
    return;
  }
  let normalized;
  try { normalized = new URL(origin).origin; } catch { throw httpError(403, "origin_rejected", "The request Origin is not allowed."); }
  const expected = `${config.scheme}://${validatedHost}`;
  const allowed = config.mode === "lan" ? config.allowedOrigins.includes(normalized) : normalized === expected;
  if (!allowed) throw httpError(403, "origin_rejected", "The request Origin is not allowed.");
}

async function readJsonBody(req, limit) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw httpError(415, "json_required", "Content-Type must be application/json.");
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw httpError(413, "body_too_large", "The request body is too large.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw httpError(413, "body_too_large", "The request body is too large.");
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw httpError(400, "invalid_json", "The request body must be a valid JSON object.");
  }
}

function rejectFields(body, fields, message) {
  const rejected = fields.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (rejected.length) throw httpError(400, "caller_identity_rejected", message);
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, "invalid_path_encoding", "The request path encoding is invalid.");
  }
}

function metadataPatch(body) {
  const fields = Object.keys(body);
  const forbidden = fields.filter((field) => !TASK_METADATA_FIELDS.has(field));
  if (forbidden.length) {
    throw httpError(400, "metadata_field_rejected", "Task metadata PATCH cannot change lifecycle, aggregate version, assignment, identity, review, QA, or promotion fields.");
  }
  return body;
}

function assertExpectedVersion(actual, expected) {
  const value = Number(expected);
  if (!Number.isSafeInteger(value) || value < 1) throw httpError(428, "state_version_required", "The current aggregate stateVersion is required.");
  if (Number(actual) !== value) throw httpError(409, "state_version_conflict", "The aggregate changed. Refresh and retry.");
  return value;
}

function assertExpectedOperationalVersion(actual, expected) {
  const value = Number(expected);
  if (!Number.isSafeInteger(value) || value < 0) throw httpError(428, "state_version_required", "The current aggregate stateVersion is required.");
  if (Number(actual) !== value) throw httpError(409, "state_version_conflict", "The aggregate changed. Refresh and retry.");
  return value;
}

function actorContext(context) {
  return {
    actorId: context.actor.id,
    actorType: context.actor.type,
    role: context.actor.role,
    trusted: true,
    runId: context.actor.runId || "",
    leaseId: context.actor.leaseId || "",
  };
}

function route(id, method, pattern, options, handler) {
  return Object.freeze({
    id,
    method,
    pattern,
    auth: options.auth || "authenticated",
    capability: options.capability || "",
    bodyLimit: options.bodyLimit || (MUTATION_METHODS.has(method) ? DEFAULT_BODY_LIMIT : 0),
    csrf: options.csrf || (MUTATION_METHODS.has(method) && options.auth !== "public" ? "required" : "none"),
    reauth: options.reauth || null,
    names: Object.freeze([...(options.names || [])]),
    handler,
  });
}

function paramsFor(match, names = []) {
  return Object.fromEntries(names.map((name, index) => [name, decodePathValue(match[index + 1])]));
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function serveLocalImage(res, url, roots) {
  const rawPath = url.searchParams.get("path");
  if (!rawPath) throw httpError(400, "attachment_path_required", "An attachment path is required.");
  let localPath;
  try { localPath = rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath; } catch { throw httpError(400, "invalid_attachment_path", "The attachment path is invalid."); }
  if (!path.isAbsolute(localPath)) throw httpError(400, "invalid_attachment_path", "The attachment path is invalid.");
  let filePath;
  try { filePath = await realpath(path.resolve(localPath)); } catch { throw httpError(404, "attachment_not_found", "The image attachment was not found."); }
  const registeredRoots = [];
  for (const root of roots) {
    try { registeredRoots.push(await realpath(root)); } catch { /* An absent registered root contains no files. */ }
  }
  if (!registeredRoots.some((root) => pathWithin(root, filePath))) throw httpError(403, "attachment_root_rejected", "The attachment is outside the registered local roots.");
  const extension = path.extname(filePath).toLowerCase();
  const contentType = IMAGE_MIME_TYPES.get(extension);
  if (!contentType) throw httpError(415, "image_required", "Only image attachments can be previewed.");
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw httpError(404, "attachment_not_found", "The image attachment was not found.");
  if (fileStat.size > 20 * 1024 * 1024) throw httpError(413, "attachment_too_large", "The image attachment is too large to preview.");
  sendText(res, 200, await readFile(filePath), contentType);
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodePathValue(url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!pathWithin(PUBLIC_DIR, filePath)) throw httpError(403, "static_path_rejected", "Forbidden.");
  try {
    sendText(res, 200, await readFile(filePath), MIME_TYPES[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    if (req.method === "GET" && !path.extname(requested)) {
      sendText(res, 200, await readFile(path.join(PUBLIC_DIR, "index.html")), MIME_TYPES[".html"]);
      return;
    }
    throw httpError(404, "not_found", "Not found.");
  }
}

const defaultDependencies = {
  addComment, addProject, addTask, automationTick, generatePrompt, readState,
  recordQaBundleDecision, recordQaDecision, recordReview, resetAutomationCircuit,
  resumeOperatorAutomation, setOperatorPause, taskWithProject, transitionTask,
  updateProject, updateTask, loadConfig,
};

export function createRouteRegistry(input = {}) {
  const deps = { ...defaultDependencies, ...(input.dependencies || {}) };
  const auth = input.auth;
  const config = input.config;
  const routes = [
    route("health", "GET", /^\/api\/health$/, { auth: "public" }, async ({ res }) => {
      sendJson(res, 200, { status: "ok" });
    }),
    route("auth.enroll", "POST", /^\/api\/auth\/enroll$/, { auth: "public", bodyLimit: 8 * 1024 }, async ({ res, body, req }) => {
      const result = await auth.enroll({ ...body, secure: config.mode === "lan", remoteAddress: req.socket.remoteAddress });
      sendJson(res, 201, { owner: result.owner, csrfToken: result.csrfToken, expiresAt: result.expiresAt, recoveryCodes: result.recoveryCodes }, { "Set-Cookie": result.cookie });
    }),
    route("auth.login", "POST", /^\/api\/auth\/login$/, { auth: "public", bodyLimit: 8 * 1024 }, async ({ res, body, req }) => {
      const result = await auth.login({ ...body, secure: config.mode === "lan", remoteAddress: req.socket.remoteAddress });
      sendJson(res, 200, { owner: result.owner, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, { "Set-Cookie": result.cookie });
    }),
    route("auth.recover", "POST", /^\/api\/auth\/recover$/, { auth: "public", bodyLimit: 8 * 1024 }, async ({ res, body, req }) => {
      const result = await auth.recover({ ...body, secure: config.mode === "lan", remoteAddress: req.socket.remoteAddress });
      sendJson(res, 200, { owner: result.owner, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, { "Set-Cookie": result.cookie });
    }),
    route("auth.me", "GET", /^\/api\/auth\/me$/, { capability: "session:read" }, async ({ res, authContext }) => {
      sendJson(res, 200, { actor: authContext.actor, kind: authContext.kind });
    }),
    route("auth.logout", "POST", /^\/api\/auth\/logout$/, { capability: "session:write", bodyLimit: 1024 }, async ({ res, authContext }) => {
      const result = auth.logout(authContext, config.mode === "lan");
      sendJson(res, 200, { loggedOut: true }, { "Set-Cookie": result.cookie });
    }),
    route("auth.rotate", "POST", /^\/api\/auth\/rotate$/, { auth: "owner", capability: "credentials:rotate", bodyLimit: 8 * 1024 }, async ({ res, authContext, body, req }) => {
      const result = await auth.rotatePassword(authContext, { ...body, secure: config.mode === "lan", remoteAddress: req.socket.remoteAddress });
      sendJson(res, 200, { owner: result.owner, csrfToken: result.csrfToken, expiresAt: result.expiresAt, recoveryCodes: result.recoveryCodes }, { "Set-Cookie": result.cookie });
    }),
    route("auth.reauthenticate", "POST", /^\/api\/auth\/reauth$/, { auth: "owner", capability: "decision:reauthenticate", bodyLimit: 16 * 1024 }, async ({ res, authContext, body, req }) => {
      const result = await auth.createReauthenticationGrant(authContext, { ...body, remoteAddress: req.socket.remoteAddress });
      sendJson(res, 201, result);
    }),
    route("state.read", "GET", /^\/api\/state$/, { capability: "state:read" }, async ({ res }) => {
      const state = await deps.readState();
      const loadedConfig = await deps.loadConfig();
      sendJson(res, 200, {
        meta: state.meta || {}, projects: state.projects || [], tasks: state.tasks || [], qaBundles: state.qaBundles || [],
        ownerInbox: buildOwnerInbox(state), configLoaded: Boolean(loadedConfig), productAccess: localProductAccess(),
      });
    }),
    route("inbox.read", "GET", /^\/api\/inbox$/, { capability: "inbox:read" }, async ({ res }) => sendJson(res, 200, buildOwnerInbox(await deps.readState()))),
    route("product.read", "GET", /^\/api\/product$/, { capability: "product:read" }, async ({ res }) => sendJson(res, 200, { access: localProductAccess(), tiers: productCatalog() })),
    route("config.read", "GET", /^\/api\/config$/, { capability: "config:read" }, async ({ res }) => {
      const loadedConfig = await deps.loadConfig();
      sendJson(res, 200, { configLoaded: Boolean(loadedConfig), config: loadedConfig });
    }),
    route("projects.create", "POST", /^\/api\/projects$/, { capability: "projects:write", bodyLimit: 128 * 1024 }, async ({ res, body }) => sendJson(res, 201, { project: await deps.addProject(body) })),
    route("projects.update", "PATCH", /^\/api\/projects\/([^/]+)$/, { capability: "projects:write", bodyLimit: 128 * 1024, names: ["projectId"] }, async ({ res, body, params }) => sendJson(res, 200, { project: await deps.updateProject(params.projectId, body) })),
    route("tasks.create", "POST", /^\/api\/tasks$/, { capability: "tasks:write", bodyLimit: 256 * 1024 }, async ({ res, body }) => sendJson(res, 201, { task: await deps.addTask(body) })),
    route("tasks.metadata", "PATCH", /^\/api\/tasks\/([^/]+)$/, { capability: "tasks:write", bodyLimit: 256 * 1024, names: ["taskId"] }, async ({ res, body, params }) => sendJson(res, 200, { task: await deps.updateTask(params.taskId, metadataPatch(body)) })),
    route("tasks.transition", "POST", /^\/api\/tasks\/([^/]+)\/actions\/([a-z0-9_-]+)$/, {
      capability: "tasks:transition", bodyLimit: 128 * 1024, names: ["taskId", "action"],
      reauth: async ({ authContext, body, params }) => {
        if (authContext.kind !== "session" || !OWNER_REAUTH_ACTIONS.has(params.action)) return null;
        const state = await deps.readState();
        const task = (state.tasks || []).find((item) => item.id === params.taskId);
        if (!task) throw httpError(400, "unknown_task", "The task does not exist.");
        const version = assertExpectedVersion(task.stateVersion, body.expectedStateVersion);
        return { action: `lifecycle:${params.action}`, aggregateId: task.id, aggregateVersion: version, candidateIdentity: body.evidence?.candidateIdentity || body.evidence?.candidateId || body.evidence?.subjectSha || null };
      },
    }, async ({ res, body, params, authContext }) => {
      rejectFields(body, ["actorContext", "author", "status"], "Lifecycle actor identity and status cannot be supplied by the caller.");
      const result = await deps.transitionTask({
        action: params.action,
        taskId: params.taskId,
        expectedStateVersion: body.expectedStateVersion,
        actorContext: actorContext(authContext),
        evidence: body.evidence || {},
      });
      sendJson(res, 200, result);
    }),
    route("tasks.comments", "POST", /^\/api\/tasks\/([^/]+)\/comments$/, { capability: "comments:write", bodyLimit: 64 * 1024, names: ["taskId"] }, async ({ res, body, params, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext"], "Comment authorship is derived from the authenticated actor.");
      sendJson(res, 201, { comment: await deps.addComment(params.taskId, body.body, authContext.actor.displayName) });
    }),
    route("tasks.reviews", "POST", /^\/api\/tasks\/([^/]+)\/reviews$/, { auth: "service", capability: "reviews:write", bodyLimit: 128 * 1024, names: ["taskId"] }, async ({ res, body, params, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext", "stage", "stageKey", "role"], "Review identity and stage are derived from the authenticated reviewer capability.");
      sendJson(res, 201, await deps.recordReview(params.taskId, { ...body, stage: authContext.actor.role, author: authContext.actor.displayName }));
    }),
    route("tasks.qa-decision", "POST", /^\/api\/tasks\/([^/]+)\/qa-decision$/, {
      auth: "owner", capability: "qa:decide", bodyLimit: 128 * 1024, names: ["taskId"],
      reauth: async ({ body, params }) => {
        const state = await deps.readState();
        const task = (state.tasks || []).find((item) => item.id === params.taskId);
        if (!task) throw httpError(400, "unknown_task", "The task does not exist.");
        const version = assertExpectedVersion(task.stateVersion, body.expectedStateVersion);
        return { action: `qa:${String(body.outcome || body.decision || "").toLowerCase()}`, aggregateId: task.id, aggregateVersion: version, candidateIdentity: { candidateId: body.candidateId, manifestDigest: body.manifestDigest, integrationSha: body.integrationSha } };
      },
    }, async ({ res, body, params, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext"], "QA authorship is derived from the authenticated owner.");
      sendJson(res, 201, await deps.recordQaDecision(params.taskId, { ...body, author: authContext.actor.displayName }));
    }),
    route("qa.bundle-decision", "POST", /^\/api\/qa\/bundles\/([^/]+)\/decision$/, {
      auth: "owner", capability: "qa:decide", bodyLimit: 128 * 1024, names: ["bundleId"],
      reauth: async ({ body, params }) => {
        const state = await deps.readState();
        const bundle = (state.qaBundles || []).find((item) => item.id === params.bundleId);
        const candidate = bundle && (state.candidates || []).find((item) => item.id === bundle.candidateId);
        if (!bundle || !candidate) throw httpError(400, "unknown_qa_bundle", "The QA bundle does not exist.");
        const sourceIds = new Set((candidate.manifest?.sources || []).map((source) => source.taskId));
        const version = Math.max(1, ...(state.tasks || []).filter((task) => sourceIds.has(task.id)).map((task) => Number(task.stateVersion || 1)));
        assertExpectedVersion(version, body.expectedStateVersion);
        return { action: `qa-bundle:${String(body.outcome || body.decision || "").toLowerCase()}`, aggregateId: params.bundleId, aggregateVersion: version, candidateIdentity: { candidateId: body.candidateId, manifestDigest: body.manifestDigest, integrationSha: body.integrationSha } };
      },
    }, async ({ res, body, params, authContext }) => {
      if (!Number.isSafeInteger(Number(body.expectedStateVersion)) || Number(body.expectedStateVersion) < 1) throw httpError(428, "state_version_required", "The current aggregate stateVersion is required.");
      rejectFields(body, ["author", "actor", "actorContext"], "QA authorship is derived from the authenticated owner.");
      sendJson(res, 201, await deps.recordQaBundleDecision(params.bundleId, { ...body, author: authContext.actor.displayName }));
    }),
    route("automation.tick", "POST", /^\/api\/automation\/tick$/, { capability: "automation:tick", bodyLimit: 16 * 1024 }, async ({ res, body }) => sendJson(res, 200, await deps.automationTick(body))),
    route("automation.pause", "POST", /^\/api\/automation\/pause$/, { auth: "owner", capability: "automation:pause", bodyLimit: 16 * 1024 }, async ({ res, body, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext"], "Automation authorship is derived from the authenticated owner.");
      sendJson(res, 200, { operatorPause: await deps.setOperatorPause({ ...body, author: authContext.actor.displayName }) });
    }),
    route("automation.resume", "POST", /^\/api\/automation\/resume$/, {
      auth: "owner", capability: "automation:resume", bodyLimit: 16 * 1024,
      reauth: async ({ body }) => {
        const state = await deps.readState();
        const pause = state.meta?.operatorPause;
        if (!pause?.active || !pause.pausedAt) throw httpError(409, "automation_not_paused", "Automation is not currently paused.");
        const version = Date.parse(pause.pausedAt);
        assertExpectedOperationalVersion(version, body.expectedStateVersion);
        return { action: "automation:resume", aggregateId: "operator-pause", aggregateVersion: version, candidateIdentity: { pausedAt: pause.pausedAt, active: true } };
      },
    }, async ({ res, body, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext"], "Automation authorship is derived from the authenticated owner.");
      sendJson(res, 200, { operatorPause: await deps.resumeOperatorAutomation({ ...body, author: authContext.actor.displayName }) });
    }),
    route("automation.circuit-reset", "POST", /^\/api\/automation\/circuit-reset$/, {
      auth: "owner", capability: "automation:reset", bodyLimit: 64 * 1024,
      reauth: async ({ body }) => {
        const state = await deps.readState();
        const target = body.task
          ? (state.tasks || []).find((item) => item.id === body.task)
          : (state.projects || []).find((item) => item.id === body.project || item.key === body.project);
        if (!target) throw httpError(400, "unknown_circuit_target", "The circuit target does not exist.");
        const version = body.task ? Number(target.stateVersion) : Number(target.automationAttemptEpoch || 0);
        assertExpectedOperationalVersion(version, body.expectedStateVersion);
        return { action: "automation:circuit-reset", aggregateId: target.id, aggregateVersion: version, candidateIdentity: body.expectedSnapshot || { openedAt: body.expectedOpenedAt || "" } };
      },
    }, async ({ res, body, authContext }) => {
      rejectFields(body, ["author", "actor", "actorContext"], "Automation authorship is derived from the authenticated owner.");
      sendJson(res, 200, { target: await deps.resetAutomationCircuit({ ...body, author: authContext.actor.displayName }) });
    }),
    route("qa.review-list", "GET", /^\/api\/qa\/review-list$/, { capability: "qa:read" }, async ({ res, url }) => {
      const state = await deps.readState();
      const projectFilter = url.searchParams.get("project") || "";
      const project = projectFilter ? state.projects.find((item) => item.id === projectFilter || item.key === projectFilter) : null;
      if (projectFilter && !project) throw httpError(400, "unknown_project", "The project does not exist.");
      const tasks = state.tasks.filter((task) => task.status === "qa_review").filter((task) => !project || task.projectId === project.id).map((task) => deps.taskWithProject(state, task));
      sendJson(res, 200, { generatedAt: new Date().toISOString(), project, tasks });
    }),
    route("tasks.prompt", "GET", /^\/api\/tasks\/([^/]+)\/prompt$/, { capability: "prompts:read", names: ["taskId"] }, async ({ res, url, params }) => {
      const state = await deps.readState();
      sendJson(res, 200, { prompt: deps.generatePrompt(state, params.taskId, url.searchParams.get("role") || "builder") });
    }),
    route("tasks.detail", "GET", /^\/api\/tasks\/([^/]+)\/detail$/, { capability: "tasks:read", names: ["taskId"] }, async ({ res, params }) => {
      const state = await deps.readState();
      const task = state.tasks.find((item) => item.id === params.taskId);
      if (!task) throw httpError(404, "task_not_found", "Task not found.");
      const roles = ["systems-architect", "builder", "backend-reviewer", "frontend-reviewer", "accessibility-reviewer", "lead-reviewer"];
      sendJson(res, 200, { task: deps.taskWithProject(state, task), prompts: Object.fromEntries(roles.map((roleName) => [roleName, deps.generatePrompt(state, task.id, roleName)])) });
    }),
    route("tasks.remediation", "GET", /^\/api\/tasks\/([^/]+)\/remediation-handoff$/, { capability: "tasks:read", names: ["taskId"] }, async ({ res, url, params }) => {
      const state = await deps.readState();
      const task = state.tasks.find((item) => item.id === params.taskId);
      const handoff = task ? currentRemediationHandoff(task) : null;
      if (!task || !handoff || Number(url.searchParams.get("candidateCycle") || 0) !== Number(handoff.candidateCycle) || String(url.searchParams.get("subjectSha") || "") !== String(handoff.subjectSha)) {
        throw httpError(404, "remediation_not_found", "Current remediation handoff not found for that exact candidate.");
      }
      sendJson(res, 200, { handoff });
    }),
    route("attachments.local-image", "GET", /^\/api\/attachments\/local-image$/, { capability: "attachments:read" }, async ({ res, url }) => serveLocalImage(res, url, config.attachmentRoots)),
  ];
  return Object.freeze(routes);
}

function matchedRoute(routes, pathname, method) {
  const pathMatches = [];
  for (const candidate of routes) {
    const match = pathname.match(candidate.pattern);
    if (!match) continue;
    pathMatches.push(candidate);
    if (candidate.method === method) return { route: candidate, match };
  }
  if (pathMatches.length) throw httpError(405, "method_not_allowed", "The method is not allowed for this route.", { Allow: [...new Set(pathMatches.map((item) => item.method))].join(", ") });
  throw httpError(404, "api_route_not_found", "API route not found.");
}

function assertAuthClass(routeValue, context) {
  if (routeValue.auth === "owner" && context.kind !== "session") throw httpError(403, "owner_session_required", "This route requires an authenticated owner session.");
  if (routeValue.auth === "service" && context.kind !== "service") throw httpError(403, "service_capability_required", "This route requires a service capability.");
}

export async function createStudioOpsServer(options = {}) {
  const config = options.config || buildControlPlaneConfig(options.env || process.env);
  const auth = options.auth || createControlPlaneAuth({
    authDir: options.authDir || missionControlAuthDir(),
    operatorLogPath: options.operatorLogPath || missionControlOperatorLogPath(),
    serviceCapabilities: options.serviceCapabilities || await loadServiceCapabilities(options.authDir || missionControlAuthDir()),
  });
  const initialization = options.initializeAuth === false ? { enrolled: auth.enrolled, bootstrapCreated: false, operatorLogPath: auth.operatorLogPath } : await auth.initialize();
  validateControlPlaneStartup(config, auth.enrolled);
  const routes = createRouteRegistry({ dependencies: options.dependencies, auth, config });

  const requestHandler = async (req, res) => {
    applySecurityHeaders(res, config);
    try {
      const validatedHost = validateHostHeader(req, config);
      const url = new URL(req.url, `${config.scheme}://${validatedHost}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") throw httpError(405, "method_not_allowed", "Static resources only support GET.", { Allow: "GET" });
        validateBrowserBoundary(req, config, validatedHost, false);
        await serveStatic(req, res, url);
        return;
      }
      const matched = matchedRoute(routes, url.pathname, req.method);
      const routeValue = matched.route;
      const mutation = MUTATION_METHODS.has(req.method);
      validateBrowserBoundary(req, config, validatedHost, mutation);
      let authContext = null;
      if (routeValue.auth !== "public") {
        authContext = auth.authenticateRequest(req.headers);
        assertAuthClass(routeValue, authContext);
        auth.authorize(authContext, routeValue.capability);
        if (routeValue.csrf === "required") auth.verifyCsrf(authContext, req.headers["x-studioops-csrf-token"]);
      }
      const body = mutation ? await readJsonBody(req, routeValue.bodyLimit) : null;
      const params = paramsFor(matched.match, routeValue.names);
      if (routeValue.reauth) {
        const binding = await routeValue.reauth({ req, url, body, params, authContext });
        if (binding) auth.consumeReauthenticationGrant(authContext, req.headers["x-studioops-reauth-grant"], binding);
      }
      await routeValue.handler({ req, res, url, body, params, authContext, config });
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else res.destroy();
    }
  };

  let server;
  if (config.mode === "lan") {
    server = https.createServer({ key: await readFile(config.tlsKeyPath), cert: await readFile(config.tlsCertPath) }, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }
  return { server, auth, config, routes, initialization };
}

export async function startServer(options = {}) {
  const instance = await createStudioOpsServer(options);
  await new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(instance.config.port, instance.config.host, resolve);
  });
  const address = instance.server.address();
  const port = typeof address === "object" && address ? address.port : instance.config.port;
  console.log(`StudioOps running at ${instance.config.scheme}://${instance.config.host}:${port}`);
  if (!instance.auth.enrolled) console.log(`Owner enrollment is required. Read the owner-only operator log at ${instance.initialization.operatorLogPath}.`);
  return instance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(`StudioOps failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
