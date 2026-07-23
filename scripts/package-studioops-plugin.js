#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.join(repoRoot, "plugins", "studioops");
const outputRoot = path.join(repoRoot, "artifacts", "plugin-submission");
const maxBytes = 100 * 1024 * 1024;
const copiedEntries = [
  ".codex-plugin",
  "skills",
  "scripts",
  "assets/studioops-composer-icon.png",
  "assets/studioops-icon.png",
  "assets/studioops-logo.png",
];
const forbiddenPatterns = [
  /(^|\/)\.env($|\.)/i,
  /studioops\.config\.md$/i,
  /mission-control\.config\.md$/i,
  /\.(sqlite|sqlite3|db)(-|$|\.)/i,
  /(^|\/)(credentials|logs|run-outputs|workspaces|backups)(\/|$)/i,
  /\.(pem|key|p12)$/i,
];

async function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin package cannot contain a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function validateManifest(manifest) {
  const ui = manifest.interface || {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(manifest.name || "")) {
    throw new Error("Plugin name does not satisfy the public-listing format.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version || "")) {
    throw new Error("Plugin version must be semantic.");
  }
  if (!ui.displayName || ui.displayName.length > 30) throw new Error("Display name must be 1-30 characters.");
  if (!ui.shortDescription || ui.shortDescription.length > 30) {
    throw new Error("Short description must be 1-30 characters.");
  }
  if (!ui.longDescription || ui.longDescription.length > 4000) {
    throw new Error("Long description must be 1-4000 characters.");
  }
  if (!ui.developerName || ui.developerName.length > 80) {
    throw new Error("Developer name must be 1-80 characters.");
  }
  if (!Array.isArray(ui.defaultPrompt) || ui.defaultPrompt.length < 1 || ui.defaultPrompt.length > 3) {
    throw new Error("Plugin must define 1-3 starter prompts.");
  }
  for (const prompt of ui.defaultPrompt) {
    if (!prompt || prompt.length > 128 || prompt.includes("\n") || prompt.includes("@")) {
      throw new Error(`Invalid starter prompt: ${prompt}`);
    }
  }
  for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    const value = ui[key];
    if (!value || !value.startsWith("https://") || value.length > 1024) {
      throw new Error(`${key} must be a public HTTPS URL.`);
    }
  }
  for (const unsupported of ["apps", "mcpServers", "hooks"]) {
    if (manifest[unsupported]) throw new Error(`Skills-only package cannot declare ${unsupported}.`);
  }
  if (ui.screenshots) throw new Error("Skills-only upload manifest should not declare interface screenshots.");
}

async function buildPackage() {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, ".codex-plugin", "plugin.json"), "utf8"));
  validateManifest(manifest);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "studioops-plugin-package-"));
  const packageRoot = path.join(tempRoot, "studioops");
  await mkdir(packageRoot, { recursive: true });

  try {
    for (const relative of copiedEntries) {
      await cp(path.join(sourceRoot, relative), path.join(packageRoot, relative), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }

    const files = await listFiles(packageRoot);
    if (!files.includes(".codex-plugin/plugin.json")) throw new Error("Package is missing plugin.json.");
    if (!files.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file))) {
      throw new Error("Package does not contain a skill.");
    }
    for (const file of files) {
      if (forbiddenPatterns.some((pattern) => pattern.test(file))) {
        throw new Error(`Forbidden package entry: ${file}`);
      }
    }

    await mkdir(outputRoot, { recursive: true });
    const outputPath = path.join(outputRoot, `studioops-${manifest.version}.zip`);
    await rm(outputPath, { force: true });
    await execFileAsync("zip", ["-q", "-r", outputPath, "studioops"], { cwd: tempRoot });

    const archive = await stat(outputPath);
    if (archive.size > maxBytes) throw new Error(`Plugin ZIP exceeds 100 MB: ${archive.size} bytes.`);
    const { stdout } = await execFileAsync("unzip", ["-Z1", outputPath]);
    const archivedFiles = stdout.trim().split("\n").filter(Boolean);
    if (archivedFiles.some((file) => !file.startsWith("studioops/"))) {
      throw new Error("ZIP must contain exactly one studioops plugin root.");
    }
    if (archivedFiles.some((file) => forbiddenPatterns.some((pattern) => pattern.test(file)))) {
      throw new Error("ZIP contains forbidden runtime or credential data.");
    }

    console.log(JSON.stringify({
      ok: true,
      outputPath,
      bytes: archive.size,
      files: files.length,
      skills: files.filter((file) => file.endsWith("/SKILL.md")).length,
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await buildPackage();
