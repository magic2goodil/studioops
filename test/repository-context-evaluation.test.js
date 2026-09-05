import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_FIXTURE, aggregateMetrics, baselineCandidatePaths, embeddingMetadata,
  evaluatePaths, fuseRankings,
} from "../scripts/evaluate-repository-context.js";

test("evaluation distinguishes missing labels, known distractors, and unjudged neighbors", () => {
  const labels = { neededFiles: ["src/a.js", "src/b.js"], confusingFiles: ["src/distractor.js"] };
  const metrics = evaluatePaths(labels, ["src/distractor.js", "src/a.js", "test/a.test.js", "src/a.js"]);
  assert.equal(metrics.recall, 0.5);
  assert.equal(metrics.reciprocalRank, 0.5);
  assert.equal(metrics.returned, 3);
  assert.equal(metrics.knownIrrelevantHits, 1);
  assert.equal(metrics.unjudgedHits, 1);
  assert.equal(metrics.isolationViolations, 0);
});

test("null-query abstention and cross-repository leakage are distinct measurements", () => {
  const labels = { neededFiles: [], forbiddenFiles: ["foreign/rewards.php"] };
  const silent = evaluatePaths(labels, []);
  assert.equal(silent.recall, null);
  assert.equal(silent.abstained, true);
  const noisy = evaluatePaths(labels, ["src/local.js"]);
  assert.equal(noisy.knownIrrelevantHits, 1);
  assert.equal(noisy.isolationViolations, 0);
  const leaking = evaluatePaths(labels, ["foreign/rewards.php"]);
  assert.equal(leaking.isolationViolations, 1);
  assert.equal(leaking.abstained, false);
});

test("aggregate recall excludes null queries and accounts for every needed file", () => {
  const rows = [
    { metrics: evaluatePaths({ neededFiles: ["a", "b"] }, ["a"]), outputBytes: 20, elapsedMs: 2 },
    { metrics: evaluatePaths({ neededFiles: ["c"] }, ["c"]), outputBytes: 40, elapsedMs: 4 },
    { metrics: evaluatePaths({ neededFiles: [] }, []), outputBytes: 0, elapsedMs: 0 },
  ];
  const summary = aggregateMetrics(rows);
  assert.equal(summary.microRecall, 2 / 3);
  assert.equal(summary.meanReciprocalRank, 1);
  assert.equal(summary.neededQueries, 2);
  assert.equal(summary.nullCaseAbstentions, 1);
  assert.equal(summary.meanOutputBytes, 20);
  assert.equal(summary.meanElapsedMs, 2);
  const unranked = aggregateMetrics(rows.map((row) => ({ ...row, metrics: { ...row.metrics, reciprocalRank: null } })));
  assert.equal(unranked.meanReciprocalRank, null);
  assert.equal(unranked.microRecall, summary.microRecall);
});

test("map baseline keeps all allowed and supporting files in the shared eligible corpus", () => {
  const plan = { allowedFileScope: ["src/a.js"], supportingFileScope: ["test/*"] };
  const files = ["src/a.js", "src/b.js", "test/a.js", "test/b.js", "docs/map.md"].map((file) => ({ path: file }));
  assert.deepEqual(baselineCandidatePaths(plan, files), ["src/a.js", "test/a.js", "test/b.js"]);
  assert.deepEqual(baselineCandidatePaths({}, files), []);
  assert.deepEqual(plan.allowedFileScope, ["src/a.js"]);
});

test("embedding payload contains metadata names only and covers late declarations", () => {
  const symbols = Array.from({ length: 28 }, (_, index) => ({ name: `namedFunction${index}`, body: "PRIVATE_BODY_SENTINEL" }));
  const rendered = embeddingMetadata({ path: "src/example.js", owner: "runtime", language: "javascript", symbols,
    source: "PRIVATE_SOURCE_SENTINEL", imports: [{ literal: "PRIVATE_IMPORT_SENTINEL" }] });
  const text = JSON.stringify(rendered);
  assert.doesNotMatch(text, /PRIVATE_/);
  assert.match(text, /named Function27/);
  assert.equal(rendered.texts.length, 3);
  assert.ok(rendered.texts.every((chunk) => chunk.length <= 1200));
});

test("experimental fusion is deterministic, bounded, and has no query-specific weighting", () => {
  assert.deepEqual(fuseRankings(["a", "b"], ["c", "b"], 2), ["b", "a"]);
  assert.deepEqual(fuseRankings([], [], 5), []);
});

test("fixed source-labeled suite covers five repositories and required query classes", async () => {
  const fixture = JSON.parse(await readFile(DEFAULT_FIXTURE, "utf8"));
  assert.equal(fixture.repositories.length, 5);
  const kinds = new Set(fixture.repositories.flatMap((repo) => repo.queries.map((query) => query.kind)));
  for (const kind of ["exact", "conceptual", "confusing", "no-match", "repository-isolation"]) assert.ok(kinds.has(kind));
  for (const repository of fixture.repositories) {
    assert.match(repository.commitSha, /^[a-f0-9]{40}$/);
    assert.ok(repository.queries.length >= 3);
    assert.equal(new Set(repository.queries.map((query) => query.id)).size, repository.queries.length);
    for (const query of repository.queries) {
      assert.ok(query.evidence.length > 15);
      for (const file of query.neededFiles) assert.ok(!file.startsWith("/") && !file.includes(".."));
    }
  }
  assert.doesNotMatch(JSON.stringify(fixture), /\/Users\/|@gmail\.com|Team Robison/);
});
