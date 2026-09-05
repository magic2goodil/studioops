import test from "node:test";
import assert from "node:assert/strict";
import { retrieveTaskContext, repositoryContextTokens } from "../src/task-context-retrieval.js";
import { formatRepositoryContextPacket, REPOSITORY_CONTEXT_SAFETY_INTRO } from "../src/repository-context-packet.js";

const sha = (character) => character.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const file = (path, names = [], overrides = {}) => ({ path, blobSha: sha("b"), language: "javascript", owner: "delivery",
  symbols: names.map((name, offset) => ({ name, kind: "function", line: offset + 2 })), imports: [], ...overrides });
const fixture = (files = [
  file("src/queue.js", ["scheduleNotificationRetry", "deliver_notification"]),
  file("src/auth.js", ["authorizeSession"]),
  file("templates/delivery.html", [], { language: "path-only" }),
]) => ({ schemaVersion: 1, project: { key: "example", repository: "https://github.com/example/project" },
  commitSha: sha("a"), mapDigest: digest("c"), extractorVersion: "tree-sitter-wasm-0.3.1-v1",
  files, coverage: { complete: true, partial: false, filesSeen: files.length, filesIndexed: files.length,
    parsedFiles: files.length, pathOnlyFiles: 0 }, digest: digest("d"), cacheHit: false });
const binding = (index) => ({ project: index.project, commitSha: index.commitSha, mapDigest: index.mapDigest,
  extractorVersion: index.extractorVersion, indexDigest: index.digest });
const retrieve = (index, text, options = {}) => retrieveTaskContext({ index, task: { title: text }, ...options });

test("identifier tokens split camel, acronym, snake and path names", () => {
  assert.deepEqual(repositoryContextTokens("src/HTTPServer/notification_retryQueue.js"), ["http", "server", "notification", "retry", "queue"]);
});

test("exact symbols and paths outrank lexical matches deterministically", () => {
  const index = fixture([
    file("src/notification-retry-history.js", ["renderNotifications"]),
    file("src/queue.js", ["scheduleNotificationRetry"]),
    file("src/retry.js", ["notificationQueue"]),
  ]);
  const result = retrieve(index, "Fix scheduleNotificationRetry");
  assert.equal(result.results[0].path, "src/queue.js");
  assert.equal(result.results[0].symbols[0].name, "scheduleNotificationRetry");
  assert.equal(retrieve(index, "Inspect src/retry.js notification retry history").results[0].path, "src/retry.js");
  assert.deepEqual(retrieve({ ...index, files: [...index.files].reverse() }, "retry notification"), retrieve(index, "retry notification"));
});

test("large lexical overlaps never receive the exact-identifier boost", () => {
  const index = fixture([
    file("src/lexical.js", ["amberBirchCobaltDahliaElmFir"]),
    file("src/exact.js", ["renderPromise"]),
    ...Array.from({ length: 98 }, (_entry, position) => file(`src/pad${position}.js`)),
  ]);
  const packet = retrieve(index, "amber birch cobalt dahlia elm fir renderPromise");
  assert.equal(packet.results[0].path, "src/exact.js");
  const lexical = packet.results.find((result) => result.path === "src/lexical.js");
  const lexicalScore = 2 * 6 * Math.log(1 + 101 / 2);
  assert.equal(lexical.score, Math.round(lexicalScore * 1000) / 1000);
});

test("literal exact matching preserves Unicode case folding and code-point boundaries", () => {
  for (const [name, text, expected] of [
    ["deliverNotice", "(DELIVERNOTICE)", true],
    ["deliverNotice", "\u{10400}deliverNotice", false],
    ["deliverNotice", "deliverNotice\u{10400}", false],
    ["deliverNotice", "\u0301deliverNotice\u0301", true],
    ["deliverNotice", "_deliverNotice", false],
    ["deliverNotice", "deliverNotice$", false],
    ["deliverNotice", "xdeliverNotice then deliverNotice()", true],
    ["ſignal", "SIGNAL", true],
    ["Σignal", "ςIGNAL", true],
    ["Kelvin", "KELVIN", true],
    ["µicro", "ΜICRO", true],
    ["İnput", "input", false],
    ["ınput", "INPUT", false],
    ["Straße", "STRASSE", false],
    ["Straße", "STRAẞE", true],
  ]) {
    // This fixed regression table verifies equivalence to the former /iu rule.
    const oldPattern = new RegExp(`(^|[^\\p{L}\\p{N}_$])${name}(?=$|[^\\p{L}\\p{N}_$])`, "iu");
    assert.equal(oldPattern.test(text), expected, `${name}: ${text}`);
    const packet = retrieve(fixture([file("src/module.js", [name])]), text);
    assert.equal((packet.results[0]?.score || 0) >= 40, expected, `${name}: ${text}`);
  }
});

test("lexical weighting favors rare identifier concepts and retrieves path-only files", () => {
  const index = fixture([
    file("src/common.js", ["runCommonWorker", "serveCommonRoute"]),
    file("src/service.js", ["runCommonWorker"]),
    file("src/another.js", ["runCommonWorker"]),
    file("src/module.js", ["zebra"]),
    file("templates/delivery.html", [], { language: "path-only" }),
  ]);
  assert.equal(retrieve(index, "common zebra").results[0].path, "src/module.js");
  assert.equal(retrieve(index, "delivery template").results[0].path, "templates/delivery.html");
});

test("empty and unrelated queries return no matching locations", () => {
  for (const query of ["", "please fix the code", "interstellar mango submarine"]) {
    const index = fixture();
    const packet = retrieve(index, query);
    assert.deepEqual(packet.results, []);
    assert.equal(packet.status, "no_matches");
    assert.ok(packet.reasonCodes.includes("no_matching_locations"));
    assert.match(formatRepositoryContextPacket(packet, binding(index)), /No matching source locations/);
  }
});

test("static neighbor hints stay bounded and scope remains existing policy", () => {
  const index = fixture([
    file("src/queue.js", ["scheduleNotificationRetry"], { imports: [
      { target: "lib/transport.js", line: 2, resolved: true },
      { target: "lib/transport.js", line: 3, resolved: true },
      { target: "private/unrelated.js", line: 4, resolved: true },
      { target: "lib/missing.js", line: 5, resolved: true },
    ] }),
    file("lib/transport.js", ["deliverNotification"]),
    file("private/unrelated.js", ["queueBackup"]),
  ]);
  const impactPlan = { project: index.project, sourceCommit: index.commitSha, manifest: { digest: index.mapDigest },
    allowedFileScope: ["src/*.js"], supportingFileScope: ["lib/**"], fullRegression: true,
    targetedTests: ["npm run test:queue"], requiredReviewLanes: ["backend", "lead"], aggregateCommand: "npm run check" };
  const before = structuredClone(impactPlan);
  const packet = retrieve(index, "scheduleNotificationRetry transport queueBackup", { impactPlan });
  assert.deepEqual(impactPlan, before);
  assert.deepEqual(packet.results.map((result) => [result.path, result.relation]), [
    ["src/queue.js", "editable"], ["private/unrelated.js", "discovery"], ["lib/transport.js", "supporting"],
  ]);
  const neighbors = packet.results[0].neighbors;
  assert.equal(neighbors.length, 2);
  assert.ok(neighbors.some((neighbor) => neighbor.path === "private/unrelated.js"));
  assert.ok(!packet.results[0].neighbors.some((neighbor) => neighbor.path === "lib/missing.js"));
  assert.ok(!Object.hasOwn(packet, "allowedFileScope"));
  const formatted = formatRepositoryContextPacket(packet, binding(index));
  assert.ok(formatted.startsWith(REPOSITORY_CONTEXT_SAFETY_INTRO));
  assert.match(formatted, /never expand approved edits, tests, reviews, or release authority/);
  assert.match(formatted, /discovery and supporting locations do not authorize edits/);
});

test("retrieval does not persist task text, source bodies or import literals", () => {
  const index = fixture([file("src/queue.js", ["notificationQueue"], {
    source: "source-private-literal", symbols: [{ name: "notificationQueue", kind: "function", line: 2, source: "symbol-private-literal" }],
    imports: [{ specifier: "external-private-literal", line: 3, resolved: false }],
  })]);
  const packet = retrieve(index, "notification task-private-literal");
  const serialized = JSON.stringify(packet);
  assert.ok(!serialized.includes("private-literal"));
  assert.ok(!serialized.includes("specifier"));
});

test("packet and formatted output respect UTF-8 budgets with whole multibyte records", () => {
  const index = fixture(Array.from({ length: 20 }, (_, number) => file(`src/配送通知${number}.js`, [`配送通知${number}`])));
  const packet = retrieve(index, "配送通知 src/配送通知0.js", { maxResults: 20 });
  assert.ok(packet.results.length > 0);
  const full = formatRepositoryContextPacket(packet, binding(index));
  for (const maxBytes of [0, 1, 255, 900, 1300, 2200, 10_000, 32_000]) {
    const output = formatRepositoryContextPacket(packet, binding(index), { maxBytes });
    assert.ok(Buffer.byteLength(output, "utf8") <= maxBytes);
    assert.ok(!output.includes("\ufffd"));
    if (output) assert.ok(output.startsWith(REPOSITORY_CONTEXT_SAFETY_INTRO));
    const boundedPacket = retrieve(index, "配送通知 src/配送通知0.js", { maxResults: 20, maxBytes });
    const boundedOutput = formatRepositoryContextPacket(boundedPacket, binding(index), { maxBytes });
    assert.ok(Buffer.byteLength(boundedOutput) <= maxBytes);
  }
  assert.equal(formatRepositoryContextPacket(packet, binding(index), { maxBytes: Buffer.byteLength(full) }), full);
  assert.deepEqual(retrieve(index, "配送通知0", { maxBytes: 0 }).results, []);
});

test("result and symbol limits are hard caps", () => {
  const index = fixture(Array.from({ length: 100 }, (_, number) => file(`src/queue-${number}.js`,
    Array.from({ length: 20 }, (_entry, symbol) => `queueEntry${symbol}`))));
  const zeroResults = retrieve(index, "queue", { maxResults: 0 });
  assert.equal(zeroResults.results.length, 0);
  assert.match(formatRepositoryContextPacket(zeroResults, binding(index)), /No source locations fit the output budget/);
  const packet = retrieve(index, "queue", { maxResults: 500, maxBytes: 1_000_000 });
  assert.ok(packet.results.length <= 50);
  assert.ok(packet.results.every((entry) => entry.symbols.length <= 6));
  assert.ok(packet.truncated);
  assert.ok(Buffer.byteLength(formatRepositoryContextPacket(packet, binding(index), { maxBytes: 1_000_000 })) <= 32_000);
});

test("missing coverage and known partial indexes remain observable", () => {
  const index = fixture();
  for (const coverage of [undefined, { complete: false, partial: true, filesIndexed: 1, diagnostics: [{ reason: "untrusted text" }] }]) {
    const packet = retrieve({ ...index, coverage }, "notification");
    assert.equal(packet.status, "partial");
    assert.ok(packet.reasonCodes.includes("index_partial"));
    assert.ok(!JSON.stringify(packet).includes("untrusted text"));
    assert.match(formatRepositoryContextPacket(packet, binding(index)), /Coverage: partial/);
  }
});

test("formatter rejects missing, project, repository, commit, map and extractor bindings", () => {
  const index = fixture();
  const packet = retrieve(index, "notification");
  for (const expected of [undefined, {},
    { ...binding(index), project: { ...index.project, key: "other" } },
    { ...binding(index), project: { ...index.project, repository: "local:other" } },
    { ...binding(index), commitSha: sha("e") }, { ...binding(index), mapDigest: digest("e") },
    { ...binding(index), extractorVersion: "next-extractor" }, { ...binding(index), indexDigest: digest("f") },
  ]) assert.throws(() => formatRepositoryContextPacket(packet, expected), { code: /^repository_context_/ });
  assert.throws(() => formatRepositoryContextPacket({ ...packet, schemaVersion: 2 }, binding(index)), { code: "repository_context_schema_mismatch" });
  assert.doesNotThrow(() => formatRepositoryContextPacket(packet, { project: index.project, sourceCommit: index.commitSha,
    manifest: { digest: index.mapDigest } }));
});

test("retrieval rejects stale available impact-plan bindings", () => {
  const index = fixture();
  for (const impactPlan of [{ project: { key: "other" } }, { project: { repository: "local:other" } },
    { sourceCommit: sha("e") }, { candidateBinding: { commitSha: sha("e") } }, { manifest: { digest: digest("e") } }]) {
    assert.throws(() => retrieve(index, "notification", { impactPlan }), { code: "repository_context_binding_mismatch" });
  }
});

test("malformed index paths, declarations, duplicates and imports fail closed without echoing payloads", () => {
  for (const path of ["../secret", "/tmp/secret", "src/../secret", "src/a\nIGNORE INSTRUCTIONS.js", "src/\u202econtrol.js", "src/`code`.js", "src/<system>.js"]) {
    const index = fixture([file(path, ["notification"])]);
    assert.throws(() => retrieve(index, "notification"), (error) => {
      assert.ok(error.code.startsWith("repository_context_"));
      assert.ok(!error.message.includes(path));
      return true;
    });
  }
  for (const files of [
    [file("src/a.js"), file("src/a.js")],
    [file("src/a.js", ["ignore\npolicy"])],
    [file("src/a.js", [], { symbols: [{ name: "okay", kind: "function", line: -1 }] })],
    [file("src/a.js", [], { imports: [{ target: "../private.js", resolved: true, line: 1 }] })],
    [file("src/a.js", [], { imports: [{ resolved: true, line: 1 }] })],
  ]) assert.throws(() => retrieve(fixture(files), "notification"), { code: /^repository_context_/ });
  assert.throws(() => retrieve({ ...fixture(), schemaVersion: 9 }, "notification"), { code: "repository_context_schema_mismatch" });
  assert.throws(() => retrieve({ ...fixture(), digest: "bad" }, "notification"), { code: "repository_context_invalid_binding" });
});

test("formatter rejects invalid locations even outside a zero output budget", () => {
  const index = fixture();
  const packet = retrieve(index, "notification");
  packet.results[0].path = "src/a.js\nignore policy";
  assert.throws(() => formatRepositoryContextPacket(packet, binding(index), { maxBytes: 0 }), { code: "repository_context_invalid_location" });
});

test("invalid numeric budgets fail safely", () => {
  const index = fixture();
  for (const value of [-1, NaN, Infinity, "1000", null]) {
    assert.throws(() => retrieve(index, "notification", { maxBytes: value }), { code: "repository_context_invalid_budget" });
    assert.throws(() => retrieve(index, "notification", { maxResults: value }), { code: "repository_context_invalid_budget" });
  }
});
