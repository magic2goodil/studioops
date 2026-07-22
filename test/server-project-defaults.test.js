import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeConfig } from "../src/config.js";

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Wait for the child server to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("project creation through the API inherits configured Community standards", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-server-defaults-"));
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  await writeConfig({
    defaults: {
      standards: ["standards/engineering.md"],
      safetyRules: ["Do not deploy production without explicit approval."],
      validationCommands: ["npm test"],
      reviewPolicy: {
        maxBuilderReviewCycles: 2,
        reviewerMayFixSmallIssues: true,
        leadOwnsFinalDecisionAtLimit: true,
      },
      reviewPipeline: [{
        key: "lead",
        label: "Lead Review",
        role: "lead-reviewer",
        status: "lead_review",
        required: true,
        description: "Confirm engineering readiness.",
      }],
    },
    projects: [],
  }, tempRoot);

  const child = spawn(process.execPath, [path.resolve("src/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      STUDIOOPS_ROOT: tempRoot,
      STUDIOOPS_CONFIG_ROOT: tempRoot,
      STUDIOOPS_DATA_DIR: path.join(tempRoot, "data"),
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    await rm(tempRoot, { recursive: true, force: true });
  });
  await waitFor(`${url}/api/health`);

  const response = await fetch(`${url}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "fresh-api-project",
      name: "Fresh API Project",
      repoPath: "/tmp/fresh-api-project",
    }),
  });
  assert.equal(response.status, 201);
  const { project } = await response.json();
  assert.deepEqual(project.standards, ["standards/engineering.md"]);
  assert.deepEqual(project.safetyRules, ["Do not deploy production without explicit approval."]);
  assert.deepEqual(project.validationCommands, ["npm test"]);
  assert.equal(project.reviewPipeline[0].role, "lead-reviewer");
  assert.equal(project.reviewPolicy.maxBuilderReviewCycles, 2);
});
