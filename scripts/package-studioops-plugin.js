#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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
const maxBytes = 100 * 1024 * 1024;
// Review each new distributable file explicitly. Never recursively copy a
// developer's plugin directory: it may also contain local notes or run output.
const pluginFiles = [
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
const copiedEntries = [
  ...pluginFiles.map((file) => ({ source: `plugins/studioops/${file}`, destination: file })),
  ...["LICENSE", "PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md"]
    .map((file) => ({ source: file, destination: file })),
  { source: "docs/PLUGIN.md", destination: "README.md" },
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

async function requireRegularSourceFile(root, relative) {
  let current = root;
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Plugin package source root must be a real directory.");
  }
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Plugin package source cannot contain a symbolic link: ${relative}`);
    const valid = index === parts.length - 1 ? info.isFile() : info.isDirectory();
    if (!valid) throw new Error(`Plugin package source must be a regular file: ${relative}`);
  }
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

export async function buildPackage(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || repoRoot);
  const outputRoot = path.resolve(options.outputRoot || path.join(repositoryRoot, "artifacts", "plugin-submission"));
  const temporaryRoot = path.resolve(options.temporaryRoot
    || path.join(os.homedir(), ".codex", "workspaces", "studioops-plugin-packaging"));
  for (const entry of copiedEntries) {
    if (forbiddenPatterns.some((pattern) => pattern.test(entry.source) || pattern.test(entry.destination))) {
      throw new Error(`Forbidden package entry: ${entry.destination}`);
    }
    await requireRegularSourceFile(repositoryRoot, entry.source);
  }
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "plugins/studioops/.codex-plugin/plugin.json"), "utf8"));
  validateManifest(manifest);

  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const tempRoot = await mkdtemp(path.join(temporaryRoot, "package-"));
  const packageRoot = path.join(tempRoot, "studioops");
  await mkdir(packageRoot, { recursive: true });

  try {
    for (const entry of copiedEntries) {
      const destination = path.join(packageRoot, entry.destination);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(repositoryRoot, entry.source), destination);
    }

    const files = (await listFiles(packageRoot)).sort();
    const expectedFiles = copiedEntries.map((entry) => entry.destination).sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw new Error("Plugin package contents do not match the reviewed file allowlist.");
    }
    if (!files.includes(".codex-plugin/plugin.json")) throw new Error("Package is missing plugin.json.");
    if (!files.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file))) {
      throw new Error("Package does not contain a skill.");
    }
    for (const file of files) {
      if (forbiddenPatterns.some((pattern) => pattern.test(file))) {
        throw new Error(`Forbidden package entry: ${file}`);
      }
    }

    const outputPath = path.join(outputRoot, `studioops-${manifest.version}.zip`);
    const stagedArchive = path.join(tempRoot, "plugin.zip");
    await execFileAsync("zip", ["-q", stagedArchive, ...files.map((file) => `studioops/${file}`)], { cwd: tempRoot });

    const archive = await stat(stagedArchive);
    if (archive.size > maxBytes) throw new Error(`Plugin ZIP exceeds 100 MB: ${archive.size} bytes.`);
    const { stdout } = await execFileAsync("unzip", ["-Z1", stagedArchive]);
    const archivedFiles = stdout.trim().split("\n").filter(Boolean).sort();
    if (JSON.stringify(archivedFiles) !== JSON.stringify(expectedFiles.map((file) => `studioops/${file}`))) {
      throw new Error("Plugin ZIP contents do not match the reviewed file allowlist.");
    }
    if (archivedFiles.some((file) => forbiddenPatterns.some((pattern) => pattern.test(file)))) {
      throw new Error("ZIP contains forbidden runtime or credential data.");
    }

    await mkdir(outputRoot, { recursive: true });
    const publishRoot = await mkdtemp(path.join(outputRoot, ".package-"));
    try {
      const verifiedArchive = path.join(publishRoot, "plugin.zip");
      await copyFile(stagedArchive, verifiedArchive);
      // Rename only the fully verified ZIP. This also replaces an old output
      // symlink rather than following it and overwriting its destination.
      await rename(verifiedArchive, outputPath);
    } finally {
      await rm(publishRoot, { recursive: true, force: true });
    }
    return {
      ok: true,
      outputPath,
      bytes: archive.size,
      files: files.length,
      skills: files.filter((file) => file.endsWith("/SKILL.md")).length,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildPackage(), null, 2));
}
