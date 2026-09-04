import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const serverTestEnvironment = await createHermeticTestEnvironment();
Object.assign(process.env, serverTestEnvironment.env);
test.after(async () => serverTestEnvironment.cleanup());

const { createStudioOpsServer, isStudioOpsServerEntryPoint, startStudioOpsServer } = await import(`../src/server.js?request-security=${Date.now()}`);

test("server entrypoint recognizes the immutable runtime through its current symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-server-entrypoint-"));
  try {
    const serverUrl = new URL("../src/server.js", import.meta.url);
    const linkPath = path.join(root, "server.js");
    await symlink(fileURLToPath(serverUrl), linkPath);
    assert.equal(isStudioOpsServerEntryPoint(linkPath, serverUrl), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

async function responseBody(response) {
  const body = await response.json();
  return { response, body };
}

async function directHttpRequest(target, options = {}) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
    }, (response) => {
      let rawBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { rawBody += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: rawBody ? JSON.parse(rawBody) : {} });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(options.body || "");
  });
}

test("local API mutations reject browser cross-origin requests and require JSON", async (t) => {
  await t.test("non-loopback listen configurations fail before opening a server", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "LOCALHOST"]) {
      assert.throws(
        () => createStudioOpsServer({ host, port: 0 }),
        (error) => error?.code === "STUDIOOPS_LOOPBACK_HOST_REQUIRED",
      );
      assert.throws(
        () => startStudioOpsServer({ host, port: 0 }),
        (error) => error?.code === "STUDIOOPS_LOOPBACK_HOST_REQUIRED",
      );
    }
  });

  const server = createStudioOpsServer({ host: "127.0.0.1", port: 0 });
  const origin = await listen(server);
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  await t.test("cross-origin text/plain QA decisions fail before route handling", async () => {
    const { response, body } = await responseBody(await fetch(`${origin}/api/tasks/task_missing/qa-decision`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ outcome: "passed" }),
    }));
    assert.equal(response.status, 403);
    assert.match(body.error, /cross-origin/i);
  });

  await t.test("opaque and wrong-scheme origins fail closed", async () => {
    for (const presentedOrigin of ["null", origin.replace("http:", "https:")]) {
      const { response, body } = await responseBody(await fetch(`${origin}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: presentedOrigin,
        },
        body: JSON.stringify({ key: `blocked-${presentedOrigin.length}`, name: "Blocked" }),
      }));
      assert.equal(response.status, 403);
      assert.match(body.error, /cross-origin/i);
    }
  });

  await t.test("matching foreign Host and Origin cannot establish mutation authority", async () => {
    const attackerOrigin = `http://attacker.example:${new URL(origin).port}`;
    const { status, body } = await directHttpRequest(`${origin}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: new URL(attackerOrigin).host,
        Origin: attackerOrigin,
      },
      body: JSON.stringify({ key: "dns-rebind", name: "DNS Rebind" }),
    });
    assert.equal(status, 403);
    assert.match(body.error, /trusted local Host/i);
  });

  await t.test("foreign Host cannot read local API state through DNS rebinding", async () => {
    const { status, body } = await directHttpRequest(`${origin}/api/state`, {
      headers: { Host: `attacker.example:${new URL(origin).port}` },
    });
    assert.equal(status, 403);
    assert.match(body.error, /trusted local Host/i);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "projects"), false);
  });

  await t.test("foreign Host cannot read a local image through DNS rebinding", async () => {
    const { status, body } = await directHttpRequest(
      `${origin}/api/attachments/local-image?path=${encodeURIComponent("/tmp/private.png")}`,
      { headers: { Host: `attacker.example:${new URL(origin).port}` } },
    );
    assert.equal(status, 403);
    assert.match(body.error, /trusted local Host/i);
  });

  await t.test("same-origin application/json mutations are accepted", async () => {
    const { response, body } = await responseBody(await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Origin: origin,
      },
      body: JSON.stringify({ key: "same-origin", name: "Same Origin" }),
    }));
    assert.equal(response.status, 201);
    assert.equal(body.project.key, "same-origin");
  });

  await t.test("trusted no-Origin JSON clients remain compatible", async () => {
    const { response, body } = await responseBody(await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "local-cli", name: "Local CLI" }),
    }));
    assert.equal(response.status, 201);
    assert.equal(body.project.key, "local-cli");
  });

  await t.test("same-origin non-JSON mutations are rejected", async () => {
    const { response, body } = await responseBody(await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: origin,
      },
      body: JSON.stringify({ key: "wrong-media-type", name: "Wrong Media Type" }),
    }));
    assert.equal(response.status, 415);
    assert.match(body.error, /application\/json/i);
  });

  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.deepEqual(
    state.projects.filter((project) => ["same-origin", "local-cli"].includes(project.key)).map((project) => project.key).sort(),
    ["local-cli", "same-origin"],
  );
  assert.equal(
    state.projects.some((project) => (
      project.key.startsWith("blocked-")
      || project.key === "dns-rebind"
      || project.key === "wrong-media-type"
    )),
    false,
  );
});
