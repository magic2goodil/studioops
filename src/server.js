import http from "node:http";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addComment,
  addProject,
  addTask,
  automationTick,
  generatePrompt,
  qaDecisionCoordinatesForState,
  readState,
  recordQaBundleDecision,
  recordQaDecision,
  recordReview,
  resetAutomationCircuit,
  resumeOperatorAutomation,
  setOperatorPause,
  taskWithProject,
  updateProject,
  updateTask,
} from "./store.js";
import { loadConfig } from "./config.js";
import { buildOwnerInbox } from "./owner-inbox.js";
import { localProductAccess, productCatalog } from "./product-tiers.js";
import {
  databaseContentionHealth,
  databaseStorageHealth,
  readFailureIncidentPage,
  readFailureIncidentTotals,
} from "./state-database.js";
import { currentRemediationHandoff } from "./remediation-handoff.js";
import { buildQaReviewList } from "./qa-review-list.js";
import {
  buildProgressReport,
  decodeProgressCursor,
  normalizeProgressWindow,
  resolveProgressProject,
} from "./progress-report.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

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

const IMAGE_MIME_TYPES = new Map(
  Object.entries(MIME_TYPES).filter(([, value]) => value.startsWith("image/")),
);

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JSON_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_SOCKET_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large.");
  }
  return body ? JSON.parse(body) : {};
}

function localListenHost(value) {
  const host = String(value || "");
  if (!LOOPBACK_LISTEN_HOSTS.has(host)) {
    const error = new Error("StudioOps requires a canonical loopback listen host (127.0.0.1, localhost, or ::1).");
    error.code = "STUDIOOPS_LOOPBACK_HOST_REQUIRED";
    throw error;
  }
  return host;
}

function exactRequestOrigin(req) {
  const rawHost = req.headers.host;
  if (typeof rawHost !== "string" || !rawHost.trim()) return "";
  const protocol = req.socket?.encrypted === true ? "https:" : "http:";
  try {
    const expected = new URL(`${protocol}//${rawHost}`);
    const effectivePort = Number(expected.port || (protocol === "https:" ? 443 : 80));
    const localPort = Number(req.socket?.localPort);
    if (
      expected.username
      || expected.password
      || expected.pathname !== "/"
      || expected.search
      || expected.hash
      || !LOOPBACK_HOSTNAMES.has(expected.hostname.toLowerCase())
      || !LOOPBACK_SOCKET_ADDRESSES.has(String(req.socket?.localAddress || "").toLowerCase())
      || !LOOPBACK_SOCKET_ADDRESSES.has(String(req.socket?.remoteAddress || "").toLowerCase())
      || !Number.isSafeInteger(localPort)
      || effectivePort !== localPort
    ) {
      return "";
    }
    return expected.origin;
  } catch {
    return "";
  }
}

function exactPresentedOrigin(req) {
  const rawOrigin = req.headers.origin;
  if (typeof rawOrigin !== "string" || !rawOrigin.trim() || rawOrigin.trim() === "null") return "";
  try {
    const parsed = new URL(rawOrigin);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== rawOrigin
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function hasApplicationJsonContentType(req) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function allowApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/")) return true;
  const requestOrigin = exactRequestOrigin(req);
  if (!requestOrigin) {
    sendJson(res, 403, { error: "API requests require a trusted local Host." });
    return false;
  }

  if (!MUTATION_METHODS.has(req.method || "")) return true;

  if (Object.prototype.hasOwnProperty.call(req.headers, "origin")) {
    const presentedOrigin = exactPresentedOrigin(req);
    if (!presentedOrigin || presentedOrigin !== requestOrigin) {
      sendJson(res, 403, { error: "Cross-origin API mutation requests are forbidden." });
      return false;
    }
  }

  if (JSON_MUTATION_METHODS.has(req.method || "") && !hasApplicationJsonContentType(req)) {
    sendJson(res, 415, { error: "API mutation requests require Content-Type application/json." });
    return false;
  }
  return true;
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    if (req.method === "GET" && !path.extname(requested)) {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      const indexHtml = await readFile(indexPath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[".html"],
        "Cache-Control": "no-store",
      });
      res.end(indexHtml);
      return;
    }
    sendText(res, 404, "Not found");
  }
}

async function serveLocalImage(res, url) {
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    sendJson(res, 400, { error: "Image path is required." });
    return;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST) && process.env.ALLOW_LOCAL_ATTACHMENTS !== "true") {
    sendJson(res, 403, { error: "Local image serving is disabled unless the server is bound to localhost." });
    return;
  }
  const localPath = rawPath.startsWith("file://") ? new URL(rawPath).pathname : rawPath;
  if (!path.isAbsolute(localPath)) {
    sendJson(res, 400, { error: "Only absolute local image paths can be previewed." });
    return;
  }
  const filePath = path.resolve(localPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = IMAGE_MIME_TYPES.get(ext);
  if (!contentType) {
    sendJson(res, 415, { error: "Only image attachments can be previewed." });
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Image attachment was not found." });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(res, 404, { error: "Attachment is not a file." });
    return;
  }
  if (fileStat.size > 20 * 1024 * 1024) {
    sendJson(res, 413, { error: "Image attachment is too large to preview." });
    return;
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const storageHealth = await databaseStorageHealth();
    sendJson(res, 200, {
      status: "ok",
      ...storageHealth,
      databaseContention: await databaseContentionHealth(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    const state = await readState();
    const config = await loadConfig();
    sendJson(res, 200, {
      meta: state.meta || {},
      projects: state.projects || [],
      tasks: state.tasks || [],
      qaBundles: state.qaBundles || [],
      qaDecisionCoordinates: qaDecisionCoordinatesForState(state),
      ownerInbox: buildOwnerInbox(state),
      configLoaded: !!config,
      productAccess: localProductAccess(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inbox") {
    sendJson(res, 200, buildOwnerInbox(await readState()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/automation/progress") {
    try {
      const state = await readState();
      const window = normalizeProgressWindow(url.searchParams.get("window"));
      const project = resolveProgressProject(state, url.searchParams.get("project"));
      const taskIds = project ? [] : (state.tasks || []).map((task) => task.id);
      const cursor = decodeProgressCursor(url.searchParams.get("cursor"));
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        const error = new Error("Progress incident limit must be an integer from 1 through 100.");
        error.code = "PROGRESS_LIMIT_INVALID";
        error.status = 400;
        throw error;
      }
      const nowMs = Date.now();
      const updatedAfter = new Date(nowMs - ({ "1h": 1, "24h": 24, "7d": 168 }[window] * 3_600_000)).toISOString();
      const scope = project ? { projectId: project.id } : { taskIds };
      const [page, incidentTotals] = await Promise.all([
        readFailureIncidentPage({ ...scope, cursor, limit: requestedLimit }),
        readFailureIncidentTotals({ ...scope, updatedAfter }),
      ]);
      sendJson(res, 200, buildProgressReport(state, { ...page, incidentTotals }, { window, project, nowMs }));
      return;
    } catch (error) {
      if (String(error.code || "").startsWith("PROGRESS_")) throw error;
      const publicError = new Error("Progress diagnostics are temporarily unavailable.");
      publicError.code = "PROGRESS_READ_UNAVAILABLE";
      publicError.status = 503;
      throw publicError;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/product") {
    sendJson(res, 200, { access: localProductAccess(), tiers: productCatalog() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const config = await loadConfig();
    sendJson(res, 200, { configLoaded: !!config, config });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    sendJson(res, 201, { project: await addProject(await readJsonBody(req)) });
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "PATCH") {
    sendJson(res, 200, { project: await updateProject(projectMatch[1], await readJsonBody(req)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    sendJson(res, 201, { task: await addTask(await readJsonBody(req)) });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === "PATCH") {
    sendJson(res, 200, { task: await updateTask(taskMatch[1], await readJsonBody(req)) });
    return;
  }

  const commentMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (commentMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 201, { comment: await addComment(commentMatch[1], body.body, body.author) });
    return;
  }

  const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reviews$/);
  if (reviewMatch && req.method === "POST") {
    sendJson(res, 201, await recordReview(reviewMatch[1], await readJsonBody(req)));
    return;
  }

  const qaDecisionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/qa-decision$/);
  if (qaDecisionMatch && req.method === "POST") {
    sendJson(res, 201, await recordQaDecision(qaDecisionMatch[1], await readJsonBody(req)));
    return;
  }

  const qaBundleDecisionMatch = url.pathname.match(/^\/api\/qa\/bundles\/([^/]+)\/decision$/);
  if (qaBundleDecisionMatch && req.method === "POST") {
    sendJson(res, 201, await recordQaBundleDecision(qaBundleDecisionMatch[1], await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/automation/tick") {
    sendJson(res, 200, await automationTick(await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/automation/pause") {
    sendJson(res, 200, { operatorPause: await setOperatorPause(await readJsonBody(req)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/automation/resume") {
    sendJson(res, 200, { operatorPause: await resumeOperatorAutomation(await readJsonBody(req)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/automation/circuit-reset") {
    sendJson(res, 200, { target: await resetAutomationCircuit(await readJsonBody(req)) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/qa/review-list") {
    const state = await readState();
    const projectFilter = url.searchParams.get("project") || "";
    const project = projectFilter
      ? state.projects.find((item) => item.id === projectFilter || item.key === projectFilter)
      : null;
    if (projectFilter && !project) {
      sendJson(res, 404, { error: "Project not found." });
      return;
    }
    const reviewList = buildQaReviewList(state, { projectId: project?.id || "" });
    const tasks = reviewList.tasks.map(({ task, ...authority }) => ({
      ...taskWithProject(state, task),
      ...authority,
    }));
    const bundles = reviewList.bundles.map(({ bundle, ...authority }) => ({
      ...bundle,
      ...authority,
    }));
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      project: project || null,
      tasks,
      bundles,
    });
    return;
  }

  const promptMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/prompt$/);
  if (promptMatch && req.method === "GET") {
    const state = await readState();
    const prompt = generatePrompt(state, promptMatch[1], url.searchParams.get("role") || "builder");
    sendJson(res, 200, { prompt });
    return;
  }

  const detailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/detail$/);
  if (detailMatch && req.method === "GET") {
    const state = await readState();
    const task = state.tasks.find((item) => item.id === detailMatch[1]);
    if (!task) {
      sendJson(res, 404, { error: "Task not found." });
      return;
    }
    const roles = ["systems-architect", "builder", "backend-reviewer", "frontend-reviewer", "accessibility-reviewer", "lead-reviewer"];
    sendJson(res, 200, {
      task: taskWithProject(state, task),
      prompts: Object.fromEntries(roles.map((role) => [role, generatePrompt(state, task.id, role)])),
    });
    return;
  }

  const remediationMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/remediation-handoff$/);
  if (remediationMatch && req.method === "GET") {
    const state = await readState();
    const task = state.tasks.find((item) => item.id === remediationMatch[1]);
    const handoff = task ? currentRemediationHandoff(task) : null;
    if (!task) {
      sendJson(res, 404, { error: "Task not found." });
      return;
    }
    if (
      !handoff
      || Number(url.searchParams.get("candidateCycle") || 0) !== Number(handoff.candidateCycle)
      || String(url.searchParams.get("subjectSha") || "") !== String(handoff.subjectSha)
    ) {
      sendJson(res, 404, { error: "Current remediation handoff not found for that exact candidate." });
      return;
    }
    sendJson(res, 200, { handoff });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/attachments/local-image") {
    await serveLocalImage(res, url);
    return;
  }

  sendJson(res, 404, { error: "API route not found." });
}

export function createStudioOpsServer(options = {}) {
  const host = localListenHost(options.host || HOST);
  const port = Number(options.port ?? PORT);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      if (!allowApiRequest(req, res, url)) return;
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      sendJson(res, Number(error.status || 500), { error: error.message, code: error.code || "STUDIOOPS_REQUEST_FAILED" });
    }
  });
}

export function startStudioOpsServer(options = {}) {
  const host = localListenHost(options.host || HOST);
  const port = Number(options.port ?? PORT);
  const server = createStudioOpsServer({ host, port });
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === "object" ? address.port : port;
    console.log(`StudioOps running at http://${host}:${listeningPort}`);
  });
  return server;
}

export function isStudioOpsServerEntryPoint(entryPath, moduleUrl = import.meta.url) {
  if (!entryPath) return false;
  const resolvedEntry = path.resolve(entryPath);
  const resolvedModule = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolvedEntry) === realpathSync(resolvedModule);
  } catch {
    return resolvedEntry === resolvedModule;
  }
}

if (isStudioOpsServerEntryPoint(process.argv[1])) {
  startStudioOpsServer();
}
