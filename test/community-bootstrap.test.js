import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { nodeSupported } from "../plugins/studioops/scripts/community.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(".");
const bootstrapPath = path.join(repoRoot, "plugins", "studioops", "scripts", "community.mjs");

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function git(args, cwd) {
  return run("git", args, { cwd, timeout: 20_000, maxBuffer: 1024 * 1024 });
}

test("Community bootstrap installs a clean local board and registers the active project", { timeout: 180_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-community-bootstrap-"));
  const communityHome = path.join(tempRoot, "community");
  const projectRoot = path.join(tempRoot, "sample-app");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "sample-app",
    scripts: { test: "node --test" },
  }, null, 2));
  await writeFile(path.join(projectRoot, "README.md"), "# Sample App\n");
  await git(["init"], projectRoot);
  await git(["config", "user.email", "studioops-test@example.com"], projectRoot);
  await git(["config", "user.name", "StudioOps Test"], projectRoot);
  await git(["add", "."], projectRoot);
  await git(["commit", "-m", "Initial fixture"], projectRoot);

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await run(process.execPath, [bootstrapPath, "stop", "--home", communityHome])
      .catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  const result = await run(process.execPath, [
    bootstrapPath,
    "bootstrap",
    "--home", communityHome,
    "--project", projectRoot,
    "--repository", pathToFileURL(repoRoot).href,
    "--branch", branch,
    "--url", url,
  ], {
    cwd: projectRoot,
    timeout: 170_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.action, "installed");
  assert.equal(report.boundaries.bootstrapBindsToLocalhostOnly, true);
  assert.equal(report.boundaries.bootstrapEnablesGithubWrites, false);
  assert.equal(report.boundaries.bootstrapEnablesBackgroundAutomation, false);
  assert.equal(report.boundaries.bootstrapConnectsToCloud, false);

  const response = await fetch(`${url}/api/state`);
  assert.equal(response.ok, true);
  const state = await response.json();
  assert.equal(state.configLoaded, true, JSON.stringify({ state, report }, null, 2));
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].key, "sample-app");
  assert.equal(state.projects[0].repoPath, await realpath(projectRoot));
  assert.deepEqual(state.projects[0].validationCommands, ["npm test"]);
  assert.equal(state.tasks.length, 0);

  const config = await readFile(path.join(communityHome, "workspace", "studioops.config.md"), "utf8");
  assert.match(config, /"displayName": "Local Owner"/);
  assert.doesNotMatch(config, /StudioOps Test/);
});

test("Community bootstrap enforces the supported Node floor", () => {
  assert.equal(nodeSupported("22.5.0"), true);
  assert.equal(nodeSupported("22.4.99"), false);
  assert.equal(nodeSupported("21.99.0"), false);
  assert.equal(nodeSupported("23.0.0"), true);
});
