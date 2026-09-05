import { normalizeRepositoryIdentity, pathMatchesImpactScope } from "./component-impact-map.js";
import {
  assertRepositoryContextBinding, boundedContextInteger, contextError,
  formatRepositoryContextPacket, REPOSITORY_CONTEXT_MAX_BYTES,
  safeContextPath, safeContextSymbol,
} from "./repository-context-packet.js";

const STOP_WORDS = new Set("a an and are as at be been being but by can could did do does for from had has have how i if in into is it its may might more must my of on or our should that the their them then there these they this those to up us use using was we were what when where which who why will with would you your fix add update change implement need please file files code function functions test tests src js ts py php".split(" "));
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER_BOUNDARY = /[\p{L}\p{N}_$]/u;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Identifier parts work for camelCase, HTTPServer, snake_case and repository paths. */
export function repositoryContextTokens(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.slice(0, 32_000).replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 && term.length <= 80 && !STOP_WORDS.has(term)))];
}

function taskText(task) {
  const scalar = [task.title, task.description, task.userStory, task.expectedOutcome];
  const arrays = [task.labels, task.affectedSurfaces, task.workAreas, task.acceptanceCriteria]
    .filter(Array.isArray).flatMap((items) => items.slice(0, 64));
  return [...scalar, ...arrays].filter((value) => typeof value === "string")
    .map((value) => value.slice(0, 8000)).join("\n").slice(0, 32_000);
}

function foldExact(value) {
  if (!/[^\x00-\x7f]/.test(value)) return value.toLowerCase();
  // Unicode simple folding preserves single-character matches, including final
  // sigma and long s. Full uppercase expansions (such as ß -> SS) do not match
  // the former /iu expression; dotted/dotless Turkish I also stay distinct.
  return Array.from(value, (character) => {
    if (character === "\u0130" || character === "\u0131") return character;
    const upper = character.toUpperCase();
    return Array.from(upper).length === 1 ? upper.toLowerCase() : character.toLowerCase();
  }).join("");
}

function exactMentions(text, name) {
  let position = text.indexOf(name);
  while (position !== -1) {
    let previous = position - 1;
    // indexOf uses UTF-16 positions; boundaries must inspect full code points.
    if (previous > 0 && text.charCodeAt(previous) >= 0xdc00 && text.charCodeAt(previous) <= 0xdfff
      && text.charCodeAt(previous - 1) >= 0xd800 && text.charCodeAt(previous - 1) <= 0xdbff) previous--;
    const before = previous >= 0 ? String.fromCodePoint(text.codePointAt(previous)) : "";
    const end = position + name.length;
    const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)) : "";
    if ((!before || !IDENTIFIER_BOUNDARY.test(before)) && (!after || !IDENTIFIER_BOUNDARY.test(after))) return true;
    position = text.indexOf(name, position + 1);
  }
  return false;
}

function validateFiles(index) {
  if (!Array.isArray(index.files) || index.files.length > 50_000) throw contextError("repository_context_invalid_index");
  const seen = new Set();
  return index.files.map((file) => {
    if (!file || !safeContextPath(file.path) || seen.has(file.path) || !SHA.test(file.blobSha || "")
      || typeof file.owner !== "string" || file.owner.length > 200
      || (file.owner && !/^[a-zA-Z0-9_.:/-]+$/.test(file.owner))
      || !/^[a-zA-Z0-9_-]{0,50}$/.test(file.language || "")
      || !Array.isArray(file.symbols) || file.symbols.length > 10_000
      || !Array.isArray(file.imports) || file.imports.length > 10_000) {
      throw contextError("repository_context_invalid_index");
    }
    seen.add(file.path);
    for (const symbol of file.symbols) {
      if (!safeContextSymbol(symbol?.name) || !/^[a-zA-Z0-9_-]{1,50}$/.test(symbol.kind || "")
        || !Number.isSafeInteger(symbol.line) || symbol.line < 1) {
        throw contextError("repository_context_invalid_symbol");
      }
    }
    for (const entry of file.imports) {
      if (!entry || typeof entry.resolved !== "boolean" || !Number.isSafeInteger(entry.line) || entry.line < 1
        || (entry.target !== undefined && !safeContextPath(entry.target))
        || (entry.resolved && !entry.target)) {
        throw contextError("repository_context_invalid_import");
      }
    }
    return file;
  });
}

function assertPlanBinding(index, plan) {
  const project = plan.project;
  const commit = plan.sourceCommit || plan.candidateBinding?.commitSha;
  if ((project?.key && project.key !== index.project.key)
    || (project?.repository && normalizeRepositoryIdentity(project.repository) !== normalizeRepositoryIdentity(index.project.repository))
    || (commit && commit !== index.commitSha)
    || (plan.manifest?.digest && plan.manifest.digest !== index.mapDigest)) {
    throw contextError("repository_context_binding_mismatch");
  }
}

function relationFor(file, impactPlan) {
  const matches = (scope) => Array.isArray(scope) && scope.some((pattern) => (
    typeof pattern === "string" && pattern.length <= 1024 && pathMatchesImpactScope(file, pattern)
  ));
  if (matches(impactPlan.allowedFileScope)) return "editable";
  if (matches(impactPlan.supportingFileScope)) return "supporting";
  return "discovery";
}

function coverageSummary(coverage) {
  const summary = { complete: coverage?.complete === true, partial: coverage?.partial === true || coverage?.complete !== true };
  for (const field of ["filesSeen", "filesIndexed", "parsedFiles", "pathOnlyFiles"]) {
    if (Number.isSafeInteger(coverage?.[field]) && coverage[field] >= 0) summary[field] = coverage[field];
  }
  return summary;
}

/** Pure, local ranking. The returned packet contains metadata only, never the task or source. */
export function retrieveTaskContext({ index, task = {}, impactPlan = {}, maxResults, maxBytes } = {}) {
  const limit = boundedContextInteger(maxResults, 12, 50);
  const budget = boundedContextInteger(maxBytes, 10_000, REPOSITORY_CONTEXT_MAX_BYTES);
  assertRepositoryContextBinding(index);
  assertPlanBinding(index, impactPlan);
  const files = validateFiles(index);
  const text = taskText(task);
  const terms = repositoryContextTokens(text).slice(0, 128);
  const queryTerms = new Set(terms);
  const foldedText = foldExact(text);
  // Per-call caches are derived only after validation. Mutable indexes and task
  // text never survive this invocation or enter the persistent index cache.
  const tokenCache = new Map(), exactCache = new Map();
  const tokensFor = (value) => {
    if (!tokenCache.has(value)) tokenCache.set(value, repositoryContextTokens(value));
    return tokenCache.get(value);
  };
  const mentioned = (value) => {
    if (!exactCache.has(value)) exactCache.set(value, exactMentions(foldedText, foldExact(value)));
    return exactCache.get(value);
  };
  const documents = files.map((file) => {
    const pathTerms = new Set(tokensFor(file.path));
    const symbols = file.symbols.map((symbol) => ({ symbol, tokens: tokensFor(symbol.name) }));
    const symbolTerms = new Set(symbols.flatMap(({ tokens }) => tokens));
    return { file, symbols, pathTerms, symbolTerms, allTerms: new Set([...pathTerms, ...symbolTerms]) };
  });
  const frequencies = new Map(terms.map((term) => [term, 0]));
  for (const document of documents) {
    for (const term of terms) if (document.allTerms.has(term)) frequencies.set(term, frequencies.get(term) + 1);
  }
  const weights = new Map(terms.map((term) => [term, Math.log(1 + (documents.length + 1) / (1 + frequencies.get(term)))]));
  const idf = (term) => weights.get(term);
  const ranked = documents.map(({ file, symbols: declarations, pathTerms, symbolTerms }) => {
    let score = 0;
    for (const term of terms) {
      if (pathTerms.has(term)) score += 2.5 * idf(term);
      if (symbolTerms.has(term)) score += 2 * idf(term);
    }
    const exactPath = mentioned(file.path);
    if (exactPath) score += 80;
    const basename = file.path.split("/").at(-1);
    if (basename.includes(".") && mentioned(basename)) score += 30;
    const symbols = declarations.map(({ symbol, tokens }) => {
      const overlap = tokens.filter((term) => queryTerms.has(term))
        .reduce((sum, term) => sum + idf(term), 0);
      const exact = tokens.length > 0 && mentioned(symbol.name);
      return { symbol, exact, score: overlap + (exact ? 20 : 0) };
    });
    if (symbols.some((symbol) => symbol.exact)) score += 40;
    if (score > 0) symbols.sort((a, b) => b.score - a.score || a.symbol.line - b.symbol.line || compareText(a.symbol.name, b.symbol.name));
    return { file, score: Math.round(score * 1000) / 1000, symbols };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareText(a.file.path, b.file.path));
  const filePaths = new Set(files.map((file) => file.path));
  const neighbors = new Map(files.map((file) => [file.path, []]));
  for (const file of files) {
    for (const entry of file.imports) {
      if (!entry.resolved || !filePaths.has(entry.target) || entry.target === file.path) continue;
      neighbors.get(file.path).push({ path: entry.target, line: entry.line, kind: "imports" });
      neighbors.get(entry.target).push({ path: file.path, line: entry.line, kind: "imported_by" });
    }
  }
  const results = ranked.slice(0, limit).map(({ file, score, symbols }) => ({
    path: file.path, blobSha: file.blobSha, language: file.language, owner: file.owner,
    relation: relationFor(file.path, impactPlan), score,
    symbols: symbols.slice(0, 6).map(({ symbol }) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line })),
    neighbors: neighbors.get(file.path).sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind) || a.line - b.line)
      .filter((entry, position, all) => !position || entry.path !== all[position - 1].path || entry.kind !== all[position - 1].kind)
      .slice(0, 3),
  }));
  const packet = { schemaVersion: 1, project: { key: index.project.key, repository: index.project.repository },
    commitSha: index.commitSha, mapDigest: index.mapDigest, extractorVersion: index.extractorVersion,
    indexDigest: index.digest, status: ranked.length ? "available" : "no_matches",
    reasonCodes: [], coverage: coverageSummary(index.coverage), results, truncated: ranked.length > results.length };
  if (packet.coverage.partial) {
    if (packet.status === "available") packet.status = "partial";
    packet.reasonCodes.push("index_partial");
  }
  if (!ranked.length) packet.reasonCodes.push("no_matching_locations");
  const binding = { ...index, indexDigest: index.digest };
  // Keep the packet and its formatter in agreement about locations that fit the cap.
  const formatted = formatRepositoryContextPacket(packet, binding, { maxBytes: budget });
  const included = new Set(formatted.split("\n").filter((line) => line.startsWith("Location: "))
    .map((line) => JSON.parse(line.slice("Location: ".length)).path));
  packet.results = results.filter((result) => included.has(result.path));
  packet.truncated ||= packet.results.length < results.length || !formatted;
  if (packet.truncated) packet.reasonCodes.push("budget_truncated");
  return packet;
}
