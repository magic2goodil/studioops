import http from "node:http";
import { readFile, stat } from "node:fs/promises";
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
  updateProject,
  updateTask,
} from "./store.js";
import { loadConfig } from "./config.js";
import { buildOwnerInbox } from "./owner-inbox.js";
import { localProductAccess, productCatalog } from "./product-tiers.js";
import {
  databaseReadinessHealth,
  listOperationalIncidents,
  operationalMetrics,
  updateOperationalIncident,
} from "./state-database.js";
import { currentRemediationHandoff } from "./remediation-handoff.js";
import { managedWorkerHealth } from "./watchdog.js";
import { readDiskAvailability, readWorkerHeartbeats } from "./worker-heartbeat.js";
import {
  defaultStudioOpsWorkspaceRoot,
  missionControlDataDir,
} from "./runtime-paths.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
export const READINESS_LATENCY_SLO_MS = 250;

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

function healthDeadline(promise, milliseconds, component) {
  let timeout;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timeout)),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ ok: false, reason: `${component}_slo_timeout` }), milliseconds);
      timeout.unref?.();
    }),
  ]).catch((error) => ({
    ok: false,
    reason: String(error?.code || error?.message || `${component}_failed`).slice(0, 160),
  }));
}

function requiredWorkerNames(input = {}) {
  const configured = input.requiredWorkers ?? process.env.STUDIOOPS_REQUIRED_WORKERS;
  if (Array.isArray(configured)) return configured;
  if (configured === "none" || configured === "") return [];
  if (configured) return String(configured).split(",").map((item) => item.trim()).filter(Boolean);
  return ["dispatcher", "runner", "supervisor", "notifier"];
}

export function livenessReport(input = {}) {
  return {
    status: "ok",
    live: true,
    processId: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    generatedAt: input.now || new Date().toISOString(),
  };
}

export async function readinessReport(input = {}) {
  const startedAt = Date.now();
  const latencySloMs = Math.max(25, Number(input.latencySloMs || READINESS_LATENCY_SLO_MS));
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const databaseProvider = input.databaseReadinessHealth || databaseReadinessHealth;
  const heartbeatProvider = input.readWorkerHeartbeats || readWorkerHeartbeats;
  const diskProvider = input.readDiskAvailability || readDiskAvailability;
  const configProvider = input.loadConfig || loadConfig;
  const workers = requiredWorkerNames(input);
  const [persistence, heartbeats, disks, dependency] = await Promise.all([
    healthDeadline(databaseProvider({
      nowMs,
      databaseLatencySloMs: Math.min(100, latencySloMs),
      maxQueueAgeMs: input.maxQueueAgeMs || Number(process.env.STUDIOOPS_READINESS_MAX_QUEUE_AGE_MS) || undefined,
    }), latencySloMs, "database"),
    healthDeadline(heartbeatProvider(input), latencySloMs, "workers"),
    healthDeadline(Promise.all([
      diskProvider({ ...input, path: input.dataDir || missionControlDataDir() }),
      diskProvider({ ...input, path: input.workspaceRoot || defaultStudioOpsWorkspaceRoot("run") }),
    ]), latencySloMs, "disk"),
    healthDeadline(configProvider(), latencySloMs, "dependency"),
  ]);
  const workerHealth = Array.isArray(heartbeats)
    ? managedWorkerHealth(heartbeats, { ...input, nowMs, workers })
    : { ok: false, checkedAt: new Date(nowMs).toISOString(), reason: heartbeats.reason || "heartbeat_read_failed", workers: [] };
  const diskList = Array.isArray(disks) ? disks : [];
  const diskHealth = {
    ok: diskList.length === 2 && diskList.every((disk) => disk?.pressure !== true),
    data: diskList[0] || { pressure: true, reason: disks?.reason || "disk_read_failed" },
    workspaces: diskList[1] || { pressure: true, reason: disks?.reason || "disk_read_failed" },
  };
  const dependencyHealth = dependency?.ok === false
    ? dependency
    : { ok: true, configLoaded: Boolean(dependency) };
  const latencyMs = Date.now() - startedAt;
  const latency = { ok: latencyMs <= latencySloMs, observedMs: latencyMs, sloMs: latencySloMs };
  const report = {
    ready: Boolean(
      persistence?.database?.ok
      && persistence?.queue?.ok
      && persistence?.leases?.ok
      && workerHealth.ok
      && diskHealth.ok
      && dependencyHealth.ok
      && latency.ok
    ),
    generatedAt: new Date(nowMs).toISOString(),
    latency,
    database: persistence?.database || { ok: false, reason: persistence?.reason || "database_health_missing" },
    queue: persistence?.queue || { ok: false, reason: "queue_health_missing" },
    leases: persistence?.leases || { ok: false, reason: "lease_health_missing" },
    workers: workerHealth,
    dependencies: {
      config: dependencyHealth,
      disk: diskHealth,
    },
  };
  report.status = report.ready ? "ready" : "not_ready";
  return report;
}

export async function metricsReport(input = {}) {
  const [databaseMetrics, readiness] = await Promise.all([
    (input.operationalMetrics || operationalMetrics)(input),
    readinessReport(input),
  ]);
  return {
    ...databaseMetrics,
    workers: readiness.workers,
    diskPressure: readiness.dependencies.disk,
    readiness: {
      ready: readiness.ready,
      latency: readiness.latency,
    },
  };
}

export async function handleApi(req, res, url, services = {}) {
  if (req.method === "GET" && url.pathname === "/api/live") {
    sendJson(res, 200, (services.livenessReport || livenessReport)());
    return;
  }
  if (req.method === "GET" && ["/api/health", "/api/ready"].includes(url.pathname)) {
    const health = await (services.readinessReport || readinessReport)(services);
    sendJson(res, health.ready ? 200 : 503, health);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    sendJson(res, 200, await (services.metricsReport || metricsReport)(services));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/incidents") {
    sendJson(res, 200, {
      incidents: await (services.listOperationalIncidents || listOperationalIncidents)({
        status: url.searchParams.get("status") || "",
        limit: url.searchParams.get("limit") || undefined,
      }),
    });
    return;
  }
  const incidentActionMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/(acknowledge|assign|resolve)$/);
  if (incidentActionMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const action = incidentActionMatch[2];
    const patch = action === "acknowledge"
      ? { ...body, acknowledge: true }
      : action === "assign"
        ? { ...body, owner: body.owner ?? "" }
        : { ...body, resolve: true };
    sendJson(res, 200, {
      incident: await (services.updateOperationalIncident || updateOperationalIncident)(incidentActionMatch[1], patch),
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
    const tasks = state.tasks
      .filter((task) => task.status === "qa_review")
      .filter((task) => !project || task.projectId === project.id)
      .map((task) => taskWithProject(state, task));
    sendJson(res, 200, { generatedAt: new Date().toISOString(), project: project || null, tasks });
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

export function createStudioOpsServer(input = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, input.services || {});
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const server = createStudioOpsServer();
  server.listen(PORT, HOST, () => {
    console.log(`StudioOps running at http://${HOST}:${PORT}`);
  });
}
