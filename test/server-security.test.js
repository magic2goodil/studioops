import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneAuth } from "../src/control-plane-auth.js";
import {
  buildControlPlaneConfig,
  createRouteRegistry,
  createStudioOpsServer,
  validateControlPlaneStartup,
} from "../src/server.js";

async function requestRaw(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: options.method || "GET",
      path: options.path || "/api/health",
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

async function serverFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-server-security-"));
  const auth = createControlPlaneAuth({
    authDir: path.join(root, "auth"),
    operatorLogPath: path.join(root, "operator.log"),
    scryptCost: 1024,
    serviceCapabilities: options.serviceCapabilities || [],
  });
  const initialized = await auth.initialize();
  const bootstrapSecret = (await readFile(initialized.operatorLogPath, "utf8")).match(/single use\): ([A-Za-z0-9_-]+)/)?.[1];
  const enrolled = await auth.enroll({ bootstrapSecret, password: "correct horse battery staple", displayName: "Authenticated Owner" });
  const state = options.state || {
    meta: {}, projects: [{ id: "project_1", key: "demo" }],
    tasks: [{ id: "task_1", projectId: "project_1", status: "user_review", stateVersion: 7, reviewSubjectSha: "a".repeat(40) }],
    qaBundles: [], candidates: [], reviews: [], comments: [], events: [],
  };
  const calls = [];
  const dependencies = {
    readState: async () => state,
    loadConfig: async () => null,
    updateTask: async (id, body) => { calls.push({ name: "updateTask", id, body }); return { id, ...body }; },
    addComment: async (id, body, author) => { calls.push({ name: "addComment", id, body, author }); return { id: "comment_1", taskId: id, body, author }; },
    transitionTask: async (command) => { calls.push({ name: "transitionTask", command }); return { task: { id: command.taskId }, decision: { action: command.action } }; },
    recordReview: async (id, body) => { calls.push({ name: "recordReview", id, body }); return { review: body, actions: [] }; },
    ...(options.dependencies || {}),
  };
  const attachmentRoot = path.join(root, "attachments");
  await mkdir(attachmentRoot, { recursive: true });
  const config = Object.freeze({
    ...buildControlPlaneConfig({ STUDIOOPS_HOST: "127.0.0.1", STUDIOOPS_PORT: "0" }),
    attachmentRoots: Object.freeze([attachmentRoot]),
  });
  const instance = await createStudioOpsServer({ config, auth, initializeAuth: false, dependencies });
  await new Promise((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
  const port = instance.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    root, auth, enrolled, state, calls, attachmentRoot, instance, port, origin,
    ownerHeaders(extra = {}) {
      return { cookie: enrolled.cookie.split(";", 1)[0], "x-studioops-csrf-token": enrolled.csrfToken, origin, "sec-fetch-site": "same-origin", ...extra };
    },
    async cleanup() {
      await new Promise((resolve) => instance.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Host is rejected before routing and every response carries defensive headers", async () => {
  const item = await serverFixture();
  try {
    const health = await requestRaw(item.port, { headers: { Host: `127.0.0.1:${item.port}` } });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { status: "ok" });
    assert.match(health.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(health.headers["x-frame-options"], "DENY");
    assert.equal(health.headers["x-content-type-options"], "nosniff");
    assert.equal(health.headers["referrer-policy"], "no-referrer");
    assert.equal(health.headers["cache-control"], "no-store");

    const rejected = await requestRaw(item.port, { headers: { Host: "attacker.example" } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers["x-frame-options"], "DENY");
    assert.doesNotMatch(rejected.text, /Users\//);
  } finally {
    await item.cleanup();
  }
});

test("the centralized route registry declares method, auth, capability, body limit, and CSRF policy", async () => {
  const item = await serverFixture();
  try {
    const routes = createRouteRegistry({ auth: item.auth, config: item.instance.config, dependencies: { readState: async () => item.state } });
    assert.ok(routes.length > 20);
    for (const registered of routes) {
      assert.ok(registered.method, registered.id);
      assert.ok(registered.auth, registered.id);
      assert.equal(typeof registered.capability, "string", registered.id);
      assert.equal(typeof registered.bodyLimit, "number", registered.id);
      assert.ok(["none", "required"].includes(registered.csrf), registered.id);
    }
  } finally {
    await item.cleanup();
  }
});

test("all non-health API reads require authentication and cross-site requests fail", async () => {
  const item = await serverFixture();
  try {
    const anonymous = await requestRaw(item.port, { path: "/api/state", headers: { Host: `127.0.0.1:${item.port}` } });
    assert.equal(anonymous.status, 401);
    const crossSite = await requestRaw(item.port, {
      path: "/api/state",
      headers: { Host: `127.0.0.1:${item.port}`, cookie: item.enrolled.cookie.split(";", 1)[0], Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    const authenticated = await requestRaw(item.port, { path: "/api/state", headers: { Host: `127.0.0.1:${item.port}`, cookie: item.enrolled.cookie.split(";", 1)[0] } });
    assert.equal(authenticated.status, 200);
  } finally {
    await item.cleanup();
  }
});

test("logout revokes the session and login restores authenticated reads", async () => {
  const item = await serverFixture();
  try {
    const logout = await requestRaw(item.port, {
      method: "POST", path: "/api/auth/logout",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: "{}",
    });
    assert.equal(logout.status, 200);
    const revoked = await requestRaw(item.port, { path: "/api/state", headers: { Host: `127.0.0.1:${item.port}`, cookie: item.enrolled.cookie.split(";", 1)[0] } });
    assert.equal(revoked.status, 401);

    const login = await requestRaw(item.port, {
      method: "POST", path: "/api/auth/login",
      headers: { Host: `127.0.0.1:${item.port}`, Origin: item.origin, "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    const authenticated = await requestRaw(item.port, { path: "/api/state", headers: { Host: `127.0.0.1:${item.port}`, cookie } });
    assert.equal(authenticated.status, 200);
  } finally {
    await item.cleanup();
  }
});

test("mutations enforce method, Origin, CSRF, JSON media type, and route body limits before parsing", async () => {
  const item = await serverFixture();
  try {
    const wrongMethod = await requestRaw(item.port, { method: "POST", path: "/api/state", headers: { Host: `127.0.0.1:${item.port}`, Origin: item.origin, "Sec-Fetch-Site": "same-origin" } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, "GET");

    const missingOrigin = await requestRaw(item.port, { method: "POST", path: "/api/tasks/task_1/comments", headers: { Host: `127.0.0.1:${item.port}`, cookie: item.enrolled.cookie.split(";", 1)[0], "x-studioops-csrf-token": item.enrolled.csrfToken, "content-type": "application/json" }, body: "{}" });
    assert.equal(missingOrigin.status, 403);
    const missingCsrf = await requestRaw(item.port, { method: "POST", path: "/api/tasks/task_1/comments", headers: { Host: `127.0.0.1:${item.port}`, cookie: item.enrolled.cookie.split(";", 1)[0], Origin: item.origin, "Sec-Fetch-Site": "same-origin", "content-type": "application/json" }, body: "{}" });
    assert.equal(missingCsrf.status, 403);
    const wrongMedia = await requestRaw(item.port, { method: "POST", path: "/api/tasks/task_1/comments", headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "text/plain" }), body: "{}" });
    assert.equal(wrongMedia.status, 415);
    const oversized = await requestRaw(item.port, { method: "POST", path: "/api/tasks/task_1/comments", headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }), body: JSON.stringify({ body: "x".repeat(70 * 1024) }) });
    assert.equal(oversized.status, 413);
  } finally {
    await item.cleanup();
  }
});

test("task metadata cannot mutate lifecycle or identity and comment authorship is derived", async () => {
  const item = await serverFixture();
  try {
    const rejected = await requestRaw(item.port, {
      method: "PATCH", path: "/api/tasks/task_1",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: JSON.stringify({ status: "done", assignedAgentRole: "owner" }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(item.calls.length, 0);

    const valid = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/comments",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: JSON.stringify({ body: "Evidence recorded." }),
    });
    assert.equal(valid.status, 201);
    assert.equal(item.calls[0].author, "Authenticated Owner");
    const forged = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/comments",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: JSON.stringify({ body: "Forged", author: "Lead Reviewer" }),
    });
    assert.equal(forged.status, 400);
  } finally {
    await item.cleanup();
  }
});

test("explicit lifecycle actions derive the actor and high-risk owner decisions consume exact grants", async () => {
  const item = await serverFixture();
  try {
    const evidence = { targetStatus: "approved", candidateCycle: 1, subjectSha: "a".repeat(40) };
    const withoutGrant = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/actions/approve_owner_review",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: JSON.stringify({ expectedStateVersion: 7, evidence }),
    });
    assert.equal(withoutGrant.status, 428);

    const stale = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/actions/approve_owner_review",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json" }),
      body: JSON.stringify({ expectedStateVersion: 6, evidence }),
    });
    assert.equal(stale.status, 409);

    const binding = { action: "lifecycle:approve_owner_review", aggregateId: "task_1", aggregateVersion: 7, candidateIdentity: evidence.subjectSha };
    const grant = await item.auth.createReauthenticationGrant(
      item.auth.authenticateRequest({ cookie: item.enrolled.cookie.split(";", 1)[0] }),
      { ...binding, password: "correct horse battery staple" },
    );
    const accepted = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/actions/approve_owner_review",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json", "x-studioops-reauth-grant": grant.grant }),
      body: JSON.stringify({ expectedStateVersion: 7, evidence }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(item.calls[0].command.actorContext, { actorId: item.enrolled.owner.id, actorType: "owner", role: "owner", trusted: true, runId: "", leaseId: "" });
    assert.equal(item.calls[0].command.action, "approve_owner_review");

    const reused = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/actions/approve_owner_review",
      headers: item.ownerHeaders({ Host: `127.0.0.1:${item.port}`, "content-type": "application/json", "x-studioops-reauth-grant": grant.grant }),
      body: JSON.stringify({ expectedStateVersion: 7, evidence }),
    });
    assert.equal(reused.status, 428);
  } finally {
    await item.cleanup();
  }
});

test("service review capabilities bypass session CSRF but bind reviewer identity and stage", async () => {
  const token = "review-service-token-with-at-least-thirty-two-characters";
  const item = await serverFixture({
    serviceCapabilities: [{ token, capabilities: ["reviews:write"], actor: { id: "backend-bot", displayName: "Backend Reviewer Bot", type: "worker", role: "backend-reviewer" } }],
  });
  try {
    const response = await requestRaw(item.port, {
      method: "POST", path: "/api/tasks/task_1/reviews",
      headers: { Host: `127.0.0.1:${item.port}`, Origin: item.origin, "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "approved", candidateCycle: 1, subjectSha: "a".repeat(40) }),
    });
    assert.equal(response.status, 201);
    assert.equal(item.calls[0].body.stage, "backend-reviewer");
    assert.equal(item.calls[0].body.author, "Backend Reviewer Bot");
  } finally {
    await item.cleanup();
  }
});

test("local attachments are confined to registered roots", async () => {
  const item = await serverFixture();
  try {
    const inside = path.join(item.attachmentRoot, "preview.png");
    const outside = path.join(item.root, "private.png");
    await writeFile(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const cookie = item.enrolled.cookie.split(";", 1)[0];
    const allowed = await requestRaw(item.port, { path: `/api/attachments/local-image?path=${encodeURIComponent(inside)}`, headers: { Host: `127.0.0.1:${item.port}`, cookie } });
    assert.equal(allowed.status, 200);
    const rejected = await requestRaw(item.port, { path: `/api/attachments/local-image?path=${encodeURIComponent(outside)}`, headers: { Host: `127.0.0.1:${item.port}`, cookie } });
    assert.equal(rejected.status, 403);
    assert.doesNotMatch(rejected.text, new RegExp(item.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await item.cleanup();
  }
});

test("non-loopback and LAN startup configuration fail closed", () => {
  const exposedLoopbackMode = buildControlPlaneConfig({ STUDIOOPS_HOST: "0.0.0.0", STUDIOOPS_PORT: "4317" });
  assert.throws(() => validateControlPlaneStartup(exposedLoopbackMode, true), /requires STUDIOOPS_CONTROL_PLANE_MODE=lan/);
  const missingTls = buildControlPlaneConfig({ STUDIOOPS_CONTROL_PLANE_MODE: "lan", STUDIOOPS_HOST: "0.0.0.0", STUDIOOPS_ALLOWED_HOSTS: "studioops.local:4317", STUDIOOPS_ALLOWED_ORIGINS: "https://studioops.local:4317" });
  assert.throws(() => validateControlPlaneStartup(missingTls, true), /requires explicit TLS/);
  const notEnrolled = Object.freeze({ ...missingTls, tlsKeyPath: "/private/key", tlsCertPath: "/private/cert" });
  assert.throws(() => validateControlPlaneStartup(notEnrolled, false), /requires an enrolled local owner/);
});
