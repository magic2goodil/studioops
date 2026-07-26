import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const designDirectory = path.join(repositoryRoot, "docs/design/owner-first");
const assetDirectory = path.join(repositoryRoot, "plugins/studioops/assets");

async function bytes(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath));
}

async function text(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function csvRows(source) {
  const [header, ...lines] = source.trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) => {
    const values = line.split(",");
    assert.equal(values.length, keys.length, `CSV column drift in: ${line}`);
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  });
}

function leafStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(leafStrings);
  return [];
}

test("canonical brand asset identity and placement cannot drift", async () => {
  const logo = await readFile(path.join(assetDirectory, "studioops-logo.png"));
  assert.equal(
    sha256(logo),
    "3ae6318136d074f0613e6b972757022cb8460473e5eda2669ba581c63de57fa6",
  );

  const prototype = await readFile(path.join(designDirectory, "prototype.html"), "utf8");
  assert.match(prototype, /\.\.\/\.\.\/\.\.\/plugins\/studioops\/assets\/studioops-logo\.png/);
  assert.doesNotMatch(prototype, /studioops-icon\.png|studioops-composer-icon\.png/);
});

test("product copy is byte-bound to one checksum-protected source", async () => {
  const contractBytes = await readFile(path.join(designDirectory, "content-contract.json"));
  const checksumLine = await readFile(path.join(designDirectory, "content-contract.sha256"), "utf8");
  const expected = checksumLine.trim().split(/\s+/)[0];
  assert.equal(sha256(contractBytes), expected);
  assert.equal(expected, "4d7586403c27ec666f3a1edc14ce44f36987d64bd31e16c2d765d4ce768e21e9");

  const contract = JSON.parse(contractBytes);
  const prototype = await readFile(path.join(designDirectory, "prototype.html"), "utf8");
  const script = await readFile(path.join(designDirectory, "owner-first.js"), "utf8");
  assert.match(script, /const COPY_SOURCE = "\.\/content-contract\.json"/);
  assert.match(script, /element\.textContent = copyValue\(element\.dataset\.copy\)/);

  for (const value of leafStrings(contract).filter((entry) => entry.length >= 24)) {
    assert.equal(
      prototype.includes(value) || script.includes(value),
      false,
      `Long-form product copy must not be duplicated outside the checksum source: ${value}`,
    );
  }
});

test("route-first prototype excludes the global-feed-before-route defect", async () => {
  const prototype = await readFile(path.join(designDirectory, "prototype.html"), "utf8");
  const script = await readFile(path.join(designDirectory, "owner-first.js"), "utf8");

  assert.match(prototype, /<main id="main" tabindex="-1"><\/main>/);
  assert.doesNotMatch(prototype, /Run Automation Tick|New Task|Recovery checklist|inaccessible_github_remote/);
  assert.ok(
    script.indexOf('hash.startsWith("/tasks/")') < script.indexOf('hash === "/action-required"'),
    "Direct task dispatch must be resolved independently of Action Required.",
  );
  assert.match(script, /<article class="route task-route" aria-labelledby="page-title">/);
  assert.match(script, /<article class="route candidate-route" aria-labelledby="page-title">/);
  assert.match(script, /<h1 id="page-title" tabindex="-1">/);
});

test("task workspace uses the exact approved tab contract", async () => {
  const content = JSON.parse(await readFile(path.join(designDirectory, "content-contract.json")));
  assert.deepEqual(
    [
      content.task.brief,
      content.task.activity,
      content.task.reviews,
      content.task.qaEvidence,
      content.task.dependencies,
      content.task.runs,
    ],
    ["Brief", "Activity", "Reviews", "QA Evidence", "Dependencies", "Runs"],
  );

  const script = await readFile(path.join(designDirectory, "owner-first.js"), "utf8");
  for (const slug of ["brief", "activity", "reviews", "qa-evidence", "dependencies", "runs"]) {
    assert.match(script, new RegExp(`\\["${slug}",`));
  }
  assert.doesNotMatch(script.match(/const TASK_TABS = \[[\s\S]*?\];/)?.[0] || "", /prompt/i);
});

test("route and element inventory is complete at its required boundaries", async () => {
  const rows = csvRows(await readFile(path.join(designDirectory, "element-inventory.csv"), "utf8"));
  const routes = new Set(rows.map((row) => row.route));
  for (const route of [
    "/",
    "/work",
    "/tasks/:id",
    "/tasks/:id?tab=brief",
    "/qa",
    "/qa/candidates/:id",
    "/releases",
    "/releases/:id",
    "/action-required",
    "/operations",
    "/policies",
  ]) {
    assert.ok(routes.has(route), `Missing route inventory: ${route}`);
  }

  for (const row of rows) {
    for (const field of [
      "region",
      "data_source",
      "control_contract",
      "mobile_390",
      "tablet_834",
      "desktop_1440",
      "states",
      "privacy_boundary",
      "owning_task",
    ]) {
      assert.ok(row[field], `${row.element_id} is missing ${field}`);
    }
  }

  const allStates = rows.map((row) => row.states.toLowerCase()).join(";");
  for (const state of ["loading", "empty", "error", "offline", "stale", "permission", "degraded"]) {
    assert.match(allStates, new RegExp(state));
  }
});

test("component inventory covers the complete reusable surface and interaction states", async () => {
  const rows = csvRows(await readFile(path.join(designDirectory, "component-inventory.csv"), "utf8"));
  const names = new Set(rows.map((row) => row.component));
  for (const component of [
    "AppShell",
    "PrimaryNav",
    "Board",
    "DataTable",
    "FormField",
    "EvidenceViewer",
    "StatusBadge",
    "Dialog",
    "DecisionRow",
    "QAPacket",
  ]) {
    assert.ok(names.has(component), `Missing component: ${component}`);
  }
  for (const row of rows) {
    assert.ok(row.interaction_states, `${row.component} has no interaction states`);
    assert.ok(row.responsive_contract, `${row.component} has no responsive contract`);
    assert.ok(row.accessibility_contract, `${row.component} has no accessibility contract`);
  }
});

test("exact type, color, spacing, radius, elevation, z-index, and motion values are recorded", async () => {
  const tokens = JSON.parse(await readFile(path.join(designDirectory, "design-tokens.json")));
  for (const category of ["color", "type", "space", "radius", "elevation", "zIndex", "motion"]) {
    assert.ok(tokens[category], `Missing token category: ${category}`);
  }
  assert.equal(tokens.color.brand.value, "#6427E7");
  assert.equal(tokens.color.focus.value, "#00A3C4");
  assert.equal(tokens.type.size.body.value, "1rem");
  assert.equal(tokens.space["4"].value, "1rem");
  assert.equal(tokens.radius.large.value, "1rem");
  assert.match(tokens.elevation.raised.value, /0 8px 24px/);
  assert.equal(tokens.zIndex.dialog.value, 500);
  assert.equal(tokens.motion.durationBase.value, "180ms");
  assert.equal(tokens.motion.reducedMotion.value, "0ms");
});

test("responsive evidence is exact, synthetic, and immutable", async () => {
  const evidence = JSON.parse(await readFile(path.join(testDirectory, "render-evidence.json")));
  assert.equal(evidence.fixturePolicy, "synthetic-only");
  assert.equal(evidence.deviceScaleFactor, 1);
  assert.equal(evidence.references.length, 3);

  for (const reference of evidence.references) {
    assert.match(reference.route, /synthetic|action-required/);
    const image = await readFile(path.join(testDirectory, reference.file));
    assert.deepEqual(pngDimensions(image), {
      width: reference.width,
      height: reference.height,
    });
    assert.equal(sha256(image), reference.sha256);
    assert.ok(image.length > 50_000, `${reference.file} appears to be an empty or failed render`);
  }
});

test("zoom, WCAG, QA packet, audit correction, and unavailable-action notes stay durable", async () => {
  const contract = await readFile(
    path.join(designDirectory, "OWNER_FIRST_DESIGN_CONTRACT.md"),
    "utf8",
  );
  for (const requirement of [
    "### 200% zoom",
    "### 400% zoom",
    "focus the new `h1`",
    "at least 44 × 44 CSS px",
    "No color-only meaning",
    "Candidate ID and manifest digest",
    "Exact base/source/integration SHAs",
    "Accounts, fixtures, permissions, reset",
    "Acknowledgement and delivery receipts",
    "desktop-owner-inbox.png",
    "mobile-owner-inbox.png",
    "mobile-direct-task-route.png",
    "**Unavailable**",
  ]) {
    assert.ok(contract.includes(requirement), `Missing durable design note: ${requirement}`);
  }
});

