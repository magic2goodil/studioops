#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadProjectComponentImpactMapAtCommit, pathMatchesImpactScope } from "../src/component-impact-map.js";
import { resolveProjectImpactPlan, formatImpactPlanForPrompt } from "../src/impact-planner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_FIXTURE = path.join(ROOT, "test/fixtures/repository-context-evaluation.json");
export const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const IMPLEMENTATION_FILES = ["scripts/evaluate-repository-context.js", "src/repository-context-index.js", "src/repository-context-extractor.js", "src/task-context-retrieval.js", "src/repository-context-packet.js", "src/component-impact-map.js", "src/impact-planner.js", "package-lock.json"];

async function implementationDigests() {
  return Object.fromEntries(await Promise.all(IMPLEMENTATION_FILES.map(async (file) => [file,
    createHash("sha256").update(await readFile(path.join(ROOT, file))).digest("hex")])));
}

function trustedTrackedFiles(repoRoot, commitSha) {
  return execFileSync("/usr/bin/git", ["-C", repoRoot, "ls-tree", "-r", "--name-only", "-z", commitSha], {
    encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  }).split("\0").filter(Boolean);
}

// The model is downloaded in a separate invocation with no corpus or queries.
// During evaluation socket connection attempts fail before Python reads input.
const EMBEDDING_PROGRAM = String.raw`
import os, sys, json, socket, hashlib, time, pathlib, re, importlib.metadata
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
def no_network(*args, **kwargs):
    raise RuntimeError("Evaluation is offline: network access is disabled")
socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
from fastembed import TextEmbedding
import numpy as np
import onnxruntime
onnxruntime.disable_telemetry_events()
payload = json.load(sys.stdin)
model_name = payload["model"]
started = time.perf_counter()
model = TextEmbedding(model_name=model_name, cache_dir=payload["cacheRoot"], threads=2, local_files_only=True, providers=["CPUExecutionProvider"])
load_ms = (time.perf_counter() - started) * 1000
description = next(m for m in TextEmbedding.list_supported_models() if m["model"] == model_name)
model_root = pathlib.Path(model.model._model_dir)
artifacts = []
for name in ["model.onnx", "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]:
    candidate = model_root / name
    if candidate.is_file():
        artifacts.append({"file": name, "bytes": candidate.stat().st_size, "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest()})
reports = []
for repository in payload["repositories"]:
    chunks, owners = [], []
    for file in repository["files"]:
        for text in file["texts"]:
            chunks.append(text)
            owners.append(file["path"])
    started = time.perf_counter()
    vectors = np.array(list(model.embed(chunks)), dtype=np.float32)
    vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    index_ms = (time.perf_counter() - started) * 1000
    queries = []
    for query in repository["queries"]:
        started = time.perf_counter()
        vector = np.asarray(next(model.embed([query["query"]])), dtype=np.float32)
        vector /= max(float(np.linalg.norm(vector)), 1e-12)
        scores = vectors @ vector
        by_file = {}
        for owner, score in zip(owners, scores):
            by_file[owner] = max(by_file.get(owner, -2), float(score))
        ranked = sorted(by_file.items(), key=lambda pair: (-pair[1], pair[0]))
        queries.append({"id": query["id"], "elapsedMs": (time.perf_counter() - started) * 1000,
            "results": [{"path": p, "score": round(s, 8)} for p, s in ranked[:payload["cutoff"]]]})
    reports.append({"key": repository["key"], "indexMs": index_ms, "chunks": len(chunks),
        "vectorBytes": int(vectors.nbytes), "queries": queries})
print(json.dumps({"model": model_name, "description": description,
    "checkpointRevision": model_root.name if re.fullmatch(r"[a-f0-9]{40}", model_root.name) else None,
    "versions": {name: importlib.metadata.version(name) for name in ["fastembed", "onnxruntime", "numpy", "tokenizers", "huggingface-hub"]},
    "pythonVersion": sys.version.split()[0], "provider": "CPUExecutionProvider", "threads": 2,
    "offline": True, "loadMs": load_ms, "artifacts": artifacts, "repositories": reports}))
`;

export function evaluatePaths(query, paths) {
  const returned = [...new Set(paths)];
  const needed = new Set(query.neededFiles);
  const found = returned.filter((item) => needed.has(item));
  const forbidden = new Set([...(query.forbiddenFiles || []), ...(query.confusingFiles || [])]);
  return {
    needed: needed.size,
    found: found.length,
    recall: needed.size ? found.length / needed.size : null,
    reciprocalRank: needed.size ? (returned.findIndex((item) => needed.has(item)) < 0 ? 0 : 1 / (returned.findIndex((item) => needed.has(item)) + 1)) : null,
    returned: returned.length,
    unjudgedHits: needed.size ? returned.filter((item) => !needed.has(item) && !forbidden.has(item)).length : 0,
    knownIrrelevantHits: needed.size ? returned.filter((item) => forbidden.has(item)).length : returned.length,
    isolationViolations: returned.filter((item) => (query.forbiddenFiles || []).includes(item)).length,
    abstained: returned.length === 0,
  };
}

export function aggregateMetrics(rows) {
  const eligible = rows.filter((row) => row.metrics.needed);
  const ranked = eligible.filter((row) => row.metrics.reciprocalRank !== null);
  const nullCases = rows.filter((row) => !row.metrics.needed);
  const sum = (field) => rows.reduce((total, row) => total + row.metrics[field], 0);
  return {
    queries: rows.length, neededQueries: eligible.length,
    neededFiles: sum("needed"), foundFiles: sum("found"),
    microRecall: sum("needed") ? sum("found") / sum("needed") : null,
    meanReciprocalRank: ranked.length ? ranked.reduce((total, row) => total + row.metrics.reciprocalRank, 0) / ranked.length : null,
    returned: sum("returned"), unjudgedHits: sum("unjudgedHits"), knownIrrelevantHits: sum("knownIrrelevantHits"),
    isolationViolations: sum("isolationViolations"), nullCases: nullCases.length,
    nullCaseAbstentions: nullCases.filter((row) => row.metrics.abstained).length,
    meanOutputBytes: rows.length ? rows.reduce((total, row) => total + row.outputBytes, 0) / rows.length : 0,
    meanElapsedMs: rows.length ? rows.reduce((total, row) => total + row.elapsedMs, 0) / rows.length : 0,
  };
}

export function baselineCandidatePaths(plan, files) {
  const scopes = [...(plan.allowedFileScope || []), ...(plan.supportingFileScope || [])];
  return files.map((file) => file.path).filter((file) => scopes.some((scope) => pathMatchesImpactScope(file, scope))).sort();
}

function words(value) {
  return String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[^a-zA-Z0-9]+/g, " ").trim();
}

export function embeddingMetadata(file) {
  const prefix = `${words(file.path)} ${words(file.owner)} ${words(file.language)}`;
  const identifiers = (file.symbols || []).map((symbol) => words(symbol.name)).filter(Boolean);
  // Every symbol can contribute; no source, literals, comments, or bodies enter embeddings.
  const texts = [];
  for (let offset = 0; offset < identifiers.length; offset += 12) {
    texts.push(`${prefix}\n${identifiers.slice(offset, offset + 12).join("; ")}`.slice(0, 1200));
  }
  if (!texts.length) texts.push(prefix);
  return { path: file.path, texts };
}

export function fuseRankings(left, right, cutoff) {
  const scores = new Map();
  for (const ranking of [left, right]) ranking.forEach((item, rank) => {
    scores.set(item, (scores.get(item) || 0) + 1 / (60 + rank + 1));
  });
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, cutoff).map(([file]) => file);
}

async function runLocalEmbeddings(python, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", EMBEDDING_PROGRAM], {
      env: { ...process.env, HF_HOME: path.join(payload.cacheRoot, "huggingface"), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Local embedding evaluation exceeded 10 minutes.")); }, 600_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Local embedding evaluation failed (${code}): ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function evaluateRepositories({ repositories, fixture, cacheRoot, embeddingPython, embeddingCacheRoot }) {
  const initialImplementationDigests = await implementationDigests();
  const { loadOrBuildRepositoryContextIndex } = await import("../src/repository-context-index.js");
  const { retrieveTaskContext } = await import("../src/task-context-retrieval.js");
  const { formatRepositoryContextPacket } = await import("../src/repository-context-packet.js");
  const reports = [], embeddingRepositories = [];
  for (const definition of fixture.repositories) {
    const repoRoot = repositories[definition.key];
    if (!repoRoot) continue;
    const project = { id: definition.key, key: definition.key, repository: definition.repository, repoPath: repoRoot };
    const commitSha = definition.commitSha;
    // Verify every label exists in this immutable corpus, independently of retrieval coverage.
    const tracked = new Set(trustedTrackedFiles(repoRoot, commitSha));
    for (const query of definition.queries) for (const file of query.neededFiles) {
      if (!tracked.has(file)) throw new Error(`Missing labeled file ${definition.key}/${file} at ${commitSha}`);
    }
    const loadStarted = performance.now();
    const index = await loadOrBuildRepositoryContextIndex({ project, repoRoot, commitSha, cacheRoot });
    const indexLoadMs = performance.now() - loadStarted;
    const warmStarted = performance.now();
    const warmIndex = await loadOrBuildRepositoryContextIndex({ project, repoRoot, commitSha, cacheRoot });
    const warmLoadMs = performance.now() - warmStarted;
    if (warmIndex.digest !== index.digest) throw new Error("Index content changed between immediate reads.");
    const loadedMap = loadProjectComponentImpactMapAtCommit(project, commitSha, { repoRoot });
    const queries = [];
    for (const query of definition.queries) {
      const task = { title: query.query, candidateIdentity: { commitSha } };
      const baselineStarted = performance.now();
      const impactPlan = resolveProjectImpactPlan({ project, task, loadedMap, repoRoot, sourceCommit: commitSha });
      const baselineText = formatImpactPlanForPrompt(impactPlan);
      const baselinePaths = baselineCandidatePaths(impactPlan, index.files);
      const baselineMs = performance.now() - baselineStarted;
      const retrievalStarted = performance.now();
      const packet = retrieveTaskContext({ index, task, impactPlan, maxResults: fixture.cutoff, maxBytes: fixture.maxBytes });
      const text = formatRepositoryContextPacket(packet, {
        project: index.project, commitSha: index.commitSha, mapDigest: index.mapDigest,
        extractorVersion: index.extractorVersion, indexDigest: index.digest,
      }, { maxBytes: fixture.maxBytes });
      const retrievalMs = performance.now() - retrievalStarted;
      const paths = packet.results.map((file) => file.path);
      const escapes = paths.filter((file) => !tracked.has(file));
      if (escapes.length) throw new Error(`Retrieval returned files outside immutable repository: ${escapes.join(", ")}`);
      queries.push({ id: query.id, kind: query.kind, neededFiles: query.neededFiles,
        indexedNeededFiles: query.neededFiles.filter((file) => index.files.some((entry) => entry.path === file)),
        baseline: { paths: baselinePaths, outputBytes: Buffer.byteLength(baselineText), elapsedMs: baselineMs,
          metrics: { ...evaluatePaths(query, baselinePaths), reciprocalRank: null }, status: impactPlan.status },
        structural: { paths, outputBytes: Buffer.byteLength(text), elapsedMs: retrievalMs,
          metrics: evaluatePaths(query, paths), status: packet.status, truncated: packet.truncated },
      });
    }
    reports.push({ key: definition.key, repository: definition.repository, commitSha, mapStatus: loadedMap.status,
      index: { coverage: index.coverage, digest: index.digest, cacheHit: index.cacheHit, loadMs: indexLoadMs,
        warmCacheHit: warmIndex.cacheHit, warmLoadMs, serializedBytes: Buffer.byteLength(JSON.stringify(index)) }, queries });
    embeddingRepositories.push({ key: definition.key, files: index.files.map(embeddingMetadata), queries: definition.queries });
  }
  let embeddings = null;
  if (embeddingPython) {
    embeddings = await runLocalEmbeddings(embeddingPython, { model: EMBEDDING_MODEL, cacheRoot: embeddingCacheRoot, cutoff: fixture.cutoff, repositories: embeddingRepositories });
    for (const report of reports) {
      const semantic = embeddings.repositories.find((item) => item.key === report.key);
      const definition = fixture.repositories.find((item) => item.key === report.key);
      for (const row of report.queries) {
        const query = definition.queries.find((item) => item.id === row.id);
        const result = semantic.queries.find((item) => item.id === row.id);
        const paths = result.results.map((item) => item.path);
        row.semantic = { paths, scores: result.results.map((item) => item.score), elapsedMs: result.elapsedMs,
          outputBytes: Buffer.byteLength(JSON.stringify(result.results)), metrics: evaluatePaths(query, paths) };
        const fused = fuseRankings(row.structural.paths, paths, fixture.cutoff);
        row.hybrid = { paths: fused, elapsedMs: result.elapsedMs + row.structural.elapsedMs,
          outputBytes: Buffer.byteLength(JSON.stringify(fused)), metrics: evaluatePaths(query, fused) };
      }
    }
  }
  for (const report of reports) {
    report.summary = {};
    for (const method of ["baseline", "structural", ...(embeddings ? ["semantic", "hybrid"] : [])]) {
      report.summary[method] = aggregateMetrics(report.queries.map((query) => query[method]));
    }
  }
  if (JSON.stringify(await implementationDigests()) !== JSON.stringify(initialImplementationDigests)) {
    throw new Error("Evaluation implementation changed during this run; rerun against a stable implementation.");
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), fixtureDigest: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"), implementationDigests: initialImplementationDigests,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release(), cpuModel: os.cpus()[0]?.model || "unavailable" },
    cutoff: fixture.cutoff, maxBytes: fixture.maxBytes,
    methodology: { baseline: "Unranked authored-map allowed plus supporting scopes, intersected with the same indexed corpus; no artificial top-k truncation.",
      structural: "Actual advisory retrieval and formatter at cutoff; elapsed time excludes the already-resolved impact plan and index.",
      irrelevant: "Only explicitly confusing/forbidden labels and null-query hits count as known irrelevant; other non-needed hits are unjudged.",
      outputBytes: "Baseline and structural measure actual prompt text. Semantic/hybrid measure experimental path/score JSON and are not equivalent prompt packets.",
      timing: "Single-process retrieval timing, not worker task-completion time. First index load may already be cached; warm load is measured separately.",
      semantic: "Offline CPU MiniLM, metadata-only chunks of up to 12 symbol names and 1200 characters; maximum chunk similarity per file, no tuned threshold.",
      hybrid: "Experimental reciprocal rank fusion of structural and semantic top-k lists with constant 60; no query-specific tuning." },
    repositories: reports, embeddings };
}

async function main(argv) {
  const options = { repositories: {}, fixturePath: DEFAULT_FIXTURE,
    cacheRoot: path.join(os.homedir(), ".codex/workspaces/repository-context-evaluation/cache"),
    embeddingCacheRoot: path.join(os.homedir(), ".codex/workspaces/repository-context-evaluation/models") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") {
      console.log("Usage: node scripts/evaluate-repository-context.js [--repo key=/absolute/repo] [--fixture path] [--out path] [--cache-root path] [--embedding-python /absolute/python --embedding-cache-root path]");
      return;
    }
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--repo") {
      const separator = value.indexOf("=");
      if (separator < 1 || !path.isAbsolute(value.slice(separator + 1))) throw new Error("--repo requires key=/absolute/path");
      options.repositories[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (flag === "--fixture") options.fixturePath = path.resolve(value);
    else if (flag === "--out") options.out = path.resolve(value);
    else if (flag === "--cache-root") options.cacheRoot = path.resolve(value);
    else if (flag === "--embedding-python") options.embeddingPython = path.resolve(value);
    else if (flag === "--embedding-cache-root") options.embeddingCacheRoot = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Object.keys(options.repositories).length) options.repositories.studioops = ROOT;
  const fixture = JSON.parse(await readFile(options.fixturePath, "utf8"));
  const report = await evaluateRepositories({ ...options, fixture });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    await mkdir(path.dirname(options.out), { recursive: true, mode: 0o700 });
    await writeFile(options.out, serialized, { mode: 0o600 });
    await chmod(options.out, 0o600);
    console.log(JSON.stringify({ report: options.out, repositories: report.repositories.map(({ key, summary }) => ({ key, summary })) }, null, 2));
  } else process.stdout.write(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
