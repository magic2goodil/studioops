#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadProjectComponentImpactMapAtCommit } from "./component-impact-map.js";
import { resolveProjectImpactPlan } from "./impact-planner.js";
import { withRepositoryContext } from "./repository-context-service.js";

export async function runContextCommand(argv, output = console.log) {
  const allowed = new Set(["repo", "project", "repository", "commit", "query", "cache-root", "work-area"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--help") {
      output("Usage: studioops-context --repo PATH --project KEY --repository URL --query TEXT [--commit FULL_SHA] [--work-area PATH] [--cache-root PATH]\nReads committed repository metadata only. No board, Git, or source changes.");
      return;
    }
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !allowed.has(name) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Invalid context command arguments. Use --help.");
    if (Object.hasOwn(options, name)) throw new Error("Duplicate context command option.");
    options[name] = argv[++i];
  }
  if (!options.repo || !options.project || !options.repository || !options.query) throw new Error("--repo, --project, --repository and --query are required.");
  const repoRoot = path.resolve(options.repo);
  const commitSha = options.commit || execFileSync("/usr/bin/git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("--commit must be a full immutable Git commit SHA.");
  const project = { key: options.project, repoUrl: options.repository, repoPath: repoRoot };
  const loadedMap = loadProjectComponentImpactMapAtCommit(project, commitSha, { repoRoot });
  if (!loadedMap.manifest) throw new Error("A valid repository-bound component map is required at the selected commit.");
  const task = { title: options.query, workAreas: options["work-area"] ? [options["work-area"]] : [] };
  const impactPlan = resolveProjectImpactPlan({ project, task, repoRoot, loadedMap, sourceCommit: commitSha });
  const run = await withRepositoryContext({ project, task, impactPlan, preflightBaseCommit: commitSha, executionRepoPath: repoRoot }, { cacheRoot: options["cache-root"] });
  output(run.repositoryContextPacket);
  output(JSON.stringify(run.repositoryContext));
  if (run.repositoryContext.status === "unavailable") throw new Error("Repository context is unavailable; the existing scope and validation policy is unchanged.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runContextCommand(process.argv.slice(2)).catch(() => {
    console.error("Context retrieval failed. Check --help, repository identity, commit and component map.");
    process.exitCode = 1;
  });
}
