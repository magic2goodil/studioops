#!/usr/bin/env node

import path from "node:path";
import { classifyGitImpact, loadOwnershipManifest, validateRepositoryDependencies } from "../src/impact-manifest.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

const repoPath = path.resolve(argument("--repo") || process.cwd());
const baseSha = argument("--base");
const headSha = argument("--head") || "HEAD";
if (!baseSha) throw new Error("Usage: classify-impact.js --base <sha-or-ref> [--head <sha-or-ref>] [--repo <path>]");

const classification = await classifyGitImpact(repoPath, baseSha, headSha, {
  expectedManifestDigest: argument("--expected-manifest-digest"),
  requireExpectedManifestDigest: process.argv.includes("--require-manifest-binding"),
});

if (process.argv.includes("--check-dependencies") && !classification.manifestError) {
  const { manifest } = await loadOwnershipManifest(repoPath);
  const dependencyResult = await validateRepositoryDependencies(repoPath, manifest);
  classification.dependencyValidation = dependencyResult;
  if (!dependencyResult.ok) process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(classification, null, 2)}\n`);
