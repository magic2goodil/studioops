import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPackage } from "../scripts/package-studioops-plugin.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginPayload = [
  ".codex-plugin/plugin.json",
  "skills/setup-studioops/SKILL.md",
  "skills/run-studioops/SKILL.md",
  "skills/run-studioops/agents/openai.yaml",
  "skills/run-studioops/references/payloads.md",
  "scripts/studioops.mjs",
  "assets/studioops-composer-icon.png",
  "assets/studioops-icon.png",
  "assets/studioops-logo.png",
];
const notices = ["LICENSE", "PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md"];

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function packageFixture(t) {
  const root = await temporaryDirectory(t);
  const source = path.join(root, "source");
  for (const relative of [...pluginPayload.map((file) => `plugins/studioops/${file}`), ...notices, "docs/PLUGIN.md"]) {
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await copyFile(path.join(repositoryRoot, relative), path.join(source, relative));
  }
  return {
    root,
    source,
    options: { repositoryRoot: source, outputRoot: path.join(root, "output"), temporaryRoot: path.join(root, "temp") },
  };
}

test("plugin archive preserves its license and notices without collecting local or unreviewed files", async (t) => {
  const fixture = await packageFixture(t);
  const excluded = [
    "plugins/studioops/skills/run-studioops/.env",
    "plugins/studioops/skills/run-studioops/references/private-notes.md",
    "plugins/studioops/scripts/credentials.json",
    "plugins/studioops/scripts/local-run.js",
    "plugins/studioops/assets/private-photo.png",
    "plugins/studioops/data/mission-control.sqlite3",
    "docs/private-proposal.md",
  ];
  for (const relative of excluded) await write(fixture.source, relative, "PRIVATE_DISTRIBUTION_SENTINEL");
  const result = await buildPackage(fixture.options);
  const { stdout: listing } = await execFileAsync("unzip", ["-Z1", result.outputPath]);
  assert.deepEqual(listing.trim().split("\n").sort(), [...pluginPayload, ...notices, "README.md"]
    .map((file) => `studioops/${file}`).sort());
  const { stdout: contents } = await execFileAsync("unzip", ["-p", result.outputPath]);
  assert.doesNotMatch(contents, /PRIVATE_DISTRIBUTION_SENTINEL/);
  const { stdout: license } = await execFileAsync("unzip", ["-p", result.outputPath, "studioops/LICENSE"]);
  assert.equal(license, await readFile(path.join(repositoryRoot, "LICENSE"), "utf8"));
  assert.match(license, /permission notice shall be included/);
  assert.equal(result.files, 15);
  assert.equal(result.skills, 2);
});

test("plugin archive rejects an allowlisted file symlink and preserves the previous verified archive", async (t) => {
  const fixture = await packageFixture(t);
  const prior = await buildPackage(fixture.options);
  const priorBytes = await readFile(prior.outputPath);
  await write(fixture.root, "private-key.pem", "PRIVATE_KEY_SENTINEL");
  await rm(path.join(fixture.source, "LICENSE"));
  await symlink(path.join(fixture.root, "private-key.pem"), path.join(fixture.source, "LICENSE"));
  await assert.rejects(buildPackage(fixture.options), /symbolic link/);
  assert.deepEqual(await readFile(prior.outputPath), priorBytes);
});

test("plugin archive rejects symlinked parent directories before reading their contents", async (t) => {
  const fixture = await packageFixture(t);
  const scripts = path.join(fixture.source, "plugins/studioops/scripts");
  await rm(scripts, { recursive: true });
  await write(fixture.root, "private-scripts/studioops.mjs", "PRIVATE_SCRIPT_SENTINEL");
  await symlink(path.join(fixture.root, "private-scripts"), scripts, "dir");
  await assert.rejects(buildPackage(fixture.options), /symbolic link/);
  await assert.rejects(readdir(fixture.options.outputRoot), { code: "ENOENT" });
});

test("publishing a verified plugin archive never writes through an existing output symlink", async (t) => {
  const fixture = await packageFixture(t);
  const prior = await buildPackage(fixture.options);
  const unrelated = path.join(fixture.root, "unrelated-private-file");
  await writeFile(unrelated, "PRIVATE_OUTPUT_SENTINEL");
  await rm(prior.outputPath);
  await symlink(unrelated, prior.outputPath);
  const result = await buildPackage(fixture.options);
  assert.equal(await readFile(unrelated, "utf8"), "PRIVATE_OUTPUT_SENTINEL");
  const { stdout } = await execFileAsync("unzip", ["-Z1", result.outputPath]);
  assert.match(stdout, /studioops\/LICENSE/);
});

test("plugin archive cannot silently omit its required license", async (t) => {
  const fixture = await packageFixture(t);
  await rm(path.join(fixture.source, "LICENSE"));
  await assert.rejects(buildPackage(fixture.options), { code: "ENOENT" });
  await assert.rejects(readdir(fixture.options.outputRoot), { code: "ENOENT" });
});

test("npm distribution keeps runtime entrypoints and local imports while excluding development and operational material", async (t) => {
  const root = await temporaryDirectory(t);
  const { stdout } = await execFileAsync("npm", [
    "pack", "--dry-run", "--json", "--ignore-scripts", "--offline", "--cache", path.join(root, "npm-cache"),
  ], { cwd: repositoryRoot, maxBuffer: 2 * 1024 * 1024 });
  const packed = new Set(JSON.parse(stdout)[0].files.map((file) => file.path));
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  for (const file of Object.values(manifest.bin)) assert.ok(packed.has(file.replace(/^\.\//, "")), `Missing bin: ${file}`);
  for (const file of [
    "src/server.js", "public/index.html", "public/app.js", "public/styles.css", "studioops.config.example.md",
    "standards/engineering.md", "standards/modular-architecture-and-scoped-validation.md",
    "scripts/install-launchagents.js", "scripts/setup-github-apps.js", "scripts/package-studioops-plugin.js",
    "deploy/local/com.codex.mission-control.web.plist.example", "docs/HANDOFF.md", "docs/PLUGIN.md",
    "docs/architecture/components.json", "data/mission-control.example.json", "LICENSE", "PRIVACY.md",
    "docs/workflow-uml/README.md", "docs/workflow-uml/studioops-activity.puml", "docs/workflow-uml/studioops-activity.svg",
    "docs/workflow-uml/studioops-activity.png", "docs/workflow-uml/studioops-components.puml",
    "docs/workflow-uml/studioops-components.svg", "docs/workflow-uml/studioops-components.png",
    ...["screenshot-flow-overview", "screenshot-review-gate", "screenshot-standards-contract"]
      .flatMap((name) => ["png", "svg"].map((extension) => `plugins/studioops/assets/${name}.${extension}`)),
    ...pluginPayload.map((file) => `plugins/studioops/${file}`),
  ]) assert.ok(packed.has(file), `Missing runtime/setup/package dependency: ${file}`);
  for (const file of packed) {
    assert.doesNotMatch(file, /^(?:test|artifacts|node_modules|docs\/(?:design|plugin-submission))\//);
    assert.doesNotMatch(file, /(?:repository-context-evaluation|\.(?:sqlite3?|db|pem|key)$|(?:^|\/)\.env(?:$|\.))/);
    if (!file.startsWith("src/") || !file.endsWith(".js")) continue;
    const content = await readFile(path.join(repositoryRoot, file), "utf8");
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(packed.has(relative), `Missing local import ${relative} required by ${file}`);
    }
  }
  // An allowlist must still exclude unexpected private files even if they are
  // not covered by a developer's .gitignore.
  const fixtureRoot = path.join(root, "fixture");
  await write(fixtureRoot, "package.json", JSON.stringify(manifest));
  await write(fixtureRoot, "src/server.js", "export {};\n");
  for (const relative of [
    "data/mission-control.sqlite3", "data/backup.json", "src/.env", "plugins/studioops/scripts/credentials.json",
    "test/fixture.json", "docs/private/proposal.md", "docs/private-proposal.md",
    "standards/private-customer-policy.md", "src/debug-private.js", "public/private-customer-view.html",
    "docs/workflow-uml/private-diagram.svg",
  ]) {
    await write(fixtureRoot, relative, "PRIVATE_NPM_SENTINEL");
  }
  const fixtureResult = await execFileAsync("npm", [
    "pack", "--dry-run", "--json", "--ignore-scripts", "--offline", "--cache", path.join(root, "npm-cache"),
  ], { cwd: fixtureRoot });
  assert.deepEqual(JSON.parse(fixtureResult.stdout)[0].files.map((file) => file.path).sort(), ["package.json", "src/server.js"]);
});

test("GitHub App setup requires an explicit valid owner before starting or writing credentials", async (t) => {
  const root = await temporaryDirectory(t);
  const script = path.join(repositoryRoot, "scripts/setup-github-apps.js");
  const credentials = path.join(root, "credentials");
  for (const args of [["single"], ["roles", "--owner"], ["single", "--owner", "../invalid-owner"]]) {
    await assert.rejects(execFileAsync(process.execPath, [script, ...args], {
      env: { ...process.env, STUDIOOPS_GITHUB_APPS_DIR: credentials }, timeout: 5_000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Supply --owner with your GitHub username or organization name/);
      assert.doesNotMatch(error.stdout, /setup is running/);
      return true;
    });
  }
  await assert.rejects(readdir(credentials), { code: "ENOENT" });
  const help = await execFileAsync(process.execPath, [script, "--help"]);
  assert.match(help.stdout, /--owner YOUR_GITHUB_USER/);
  assert.match(help.stdout, /--owner NAME\s+Required/);
});

test("GitHub App setup uses the explicit organization in its local registration form", async (t) => {
  const root = await temporaryDirectory(t);
  const reserved = net.createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const child = spawn(process.execPath, [path.join(repositoryRoot, "scripts/setup-github-apps.js"),
    "roles", "--owner", "example-org", "--org", "--port", String(port)], {
    env: { ...process.env, STUDIOOPS_GITHUB_APPS_DIR: path.join(root, "credentials") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Setup server did not start")), 5_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("setup is running:")) { clearTimeout(timeout); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Setup exited early: ${code}`)); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /organization\/example-org/);
  assert.match(html, /https:\/\/github.com\/organizations\/example-org\/settings\/apps\/new/);
  assert.deepEqual(await readdir(path.join(root, "credentials")), []);
});
