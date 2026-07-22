import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const clientPath = path.resolve("plugins/studioops/scripts/studioops.mjs");

test("plugin intake reads task text from a file without shell interpretation", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "studioops-plugin-client-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  let submittedTask = null;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/state") {
      response.end(JSON.stringify({
        projects: [{ id: "project_1", key: "shell-safe", name: "Shell Safe" }],
        tasks: [],
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/tasks") {
      let body = "";
      for await (const chunk of request) body += chunk;
      submittedTask = JSON.parse(body);
      response.end(JSON.stringify({ task: { id: "task_1", ...submittedTask } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const payloadPath = path.join(tempDir, "intake.json");
  const acceptanceCriterion = "Run `npm test` and preserve the literal $(do-not-run) text";
  await writeFile(payloadPath, JSON.stringify({
    project: { key: "shell-safe", name: "Shell Safe" },
    task: {
      title: "Keep task text literal",
      status: "ready",
      acceptanceCriteria: [acceptanceCriterion],
    },
  }));

  const address = server.address();
  const { stdout } = await run(process.execPath, [
    clientPath,
    "intake",
    "--file",
    payloadPath,
    "--url",
    `http://127.0.0.1:${address.port}`,
  ]);

  assert.equal(submittedTask.project, "project_1");
  assert.deepEqual(submittedTask.acceptanceCriteria, [acceptanceCriterion]);
  assert.equal(JSON.parse(stdout).task.id, "task_1");
});
