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

function valueAtPath(value, keyPath) {
  return keyPath.split(".").reduce((current, key) => current?.[key], value);
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

test("every visible or accessible string is byte-bound to one checksum-protected source", async () => {
  const contractBytes = await readFile(path.join(designDirectory, "content-contract.json"));
  const checksumLine = await readFile(path.join(designDirectory, "content-contract.sha256"), "utf8");
  const expected = checksumLine.trim().split(/\s+/)[0];
  assert.equal(sha256(contractBytes), expected);

  const contract = JSON.parse(contractBytes);
  const prototype = await readFile(path.join(designDirectory, "prototype.html"), "utf8");
  const script = await readFile(path.join(designDirectory, "owner-first.js"), "utf8");
  assert.match(script, /const COPY_SOURCE = "\.\/content-contract\.json"/);
  assert.match(script, /element\.textContent = copyValue\(element\.dataset\.copy\)/);

  const copyAttributes = [
    ...prototype.matchAll(/data-copy(?:-aria-label|-alt)?="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(copyAttributes.length > 20);
  for (const keyPath of copyAttributes) {
    assert.equal(
      typeof valueAtPath(contract, keyPath),
      "string",
      `Static copy path must resolve to a canonical string: ${keyPath}`,
    );
  }

  for (const match of prototype.matchAll(/>([^<]+)</g)) {
    const visibleText = match[1].trim();
    if (!visibleText) continue;
    assert.match(visibleText, /^[◫≡✓!⌁◇•]+$/u, `Unsourced HTML copy: ${visibleText}`);
  }
  assert.doesNotMatch(prototype, /\s(?:aria-label|alt)="[^"]+\S"/);
  for (const match of script.matchAll(/`([\s\S]*?)`/g)) {
    const template = match[1];
    if (!template.includes("<")) continue;
    assert.doesNotMatch(template, />\s*(?:[A-Za-z]|\d+\s+[A-Za-z])[^<]*</);
    assert.doesNotMatch(template, /aria-label="[A-Za-z]/);
  }
});

test("route-first prototype excludes the global-feed-before-route defect", async () => {
  const prototype = await readFile(path.join(designDirectory, "prototype.html"), "utf8");
  const script = await readFile(path.join(designDirectory, "owner-first.js"), "utf8");

  assert.match(prototype, /<main id="main" tabindex="-1"><\/main>/);
  assert.doesNotMatch(prototype, /Run Automation Tick|New Task|Recovery checklist|inaccessible_github_remote/);
  assert.match(prototype, /href="#\/portfolio"/);
  assert.match(prototype, /href="#\/actions"/);
  assert.doesNotMatch(`${prototype}\n${script}`, /action-required/);
  assert.ok(
    script.indexOf('hash.startsWith("/tasks/")') < script.indexOf('hash === "/actions"'),
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
    "/portfolio",
    "/work",
    "/tasks/:id",
    "/tasks/:id?tab=brief",
    "/qa",
    "/qa/candidates/:id",
    "/releases",
    "/releases/:id",
    "/actions",
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
  const dataContracts = rows.map((row) => row.data_source).join("\n");
  assert.doesNotMatch(
    dataContracts,
    /\/api\/state|\/api\/inbox|\/api\/tasks\/:id\/detail|\/api\/qa\/review-list/,
  );
  for (const row of rows.filter((entry) => entry.data_kind === "dynamic")) {
    assert.match(
      row.data_source,
      /\/api\/ui\/v1|schemaVersion|stateVersion|audited mutation/,
      `${row.element_id} must consume an approved bounded projection or its envelope`,
    );
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
    assert.match(
      row.data_contract,
      /\/api\/ui\/v1|envelope|canonical|checksum|route configuration|stateVersion|projection error/,
      `${row.component} must define its projection or static canonical source`,
    );
  }
});

test("approved UI projections are versioned, bounded, capability-aware, and fresh", async () => {
  const contract = await readFile(
    path.join(designDirectory, "OWNER_FIRST_DESIGN_CONTRACT.md"),
    "utf8",
  );
  for (const requirement of [
    "/api/ui/v1/portfolio",
    "/api/ui/v1/work",
    "/api/ui/v1/tasks/:id/summary",
    "/api/ui/v1/qa/candidates/:id",
    "/api/ui/v1/actions",
    '"schemaVersion": "1"',
    '"generatedAt"',
    '"stateVersion"',
    '"data"',
    '"page"',
    '"capabilities"',
    "default to 50 rows",
    "limit above 100",
    "25 cards independently",
    "opaque server encoding of the stable `(updated_at, id)`",
    "Legacy `/api/state`, `/api/inbox`, `/api/tasks/:id/detail`, and",
    "non-authoritative for owner UI",
  ]) {
    assert.ok(contract.includes(requirement), `Missing approved read-model contract: ${requirement}`);
  }
});

test("exact type, color, spacing, radius, elevation, z-index, and motion values are recorded", async () => {
  const tokens = JSON.parse(await readFile(path.join(designDirectory, "design-tokens.json")));
  const css = await readFile(path.join(designDirectory, "owner-first.css"), "utf8");
  for (const category of ["color", "type", "space", "radius", "elevation", "zIndex", "motion"]) {
    assert.ok(tokens[category], `Missing token category: ${category}`);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(tokens.color).map(([key, token]) => [key, token.value])),
    {
      canvas: "#0B1020",
      surface: "#121827",
      raised: "#182033",
      border: "#2A344A",
      text: "#F7F9FC",
      muted: "#B8C2D6",
      primary: "#A990FF",
      focus: "#67E8F9",
      success: "#57D68D",
      warning: "#F4B860",
      danger: "#FF8799",
    },
  );
  assert.deepEqual(
    Object.values(tokens.type.size).map((token) => token.value),
    ["0.75rem", "0.875rem", "1rem", "1.25rem", "1.5rem", "2rem"],
  );
  assert.deepEqual(
    Object.values(tokens.space).map((token) => token.value),
    ["0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "3rem"],
  );
  assert.deepEqual(
    Object.values(tokens.radius).map((token) => token.value),
    ["0.375rem", "0.625rem", "0.875rem", "1.125rem"],
  );
  assert.match(tokens.elevation.raised.value, /0 8px 24px/);
  assert.equal(tokens.zIndex.dialog.value, 500);
  assert.equal(tokens.motion.durationBase.value, "180ms");
  assert.equal(tokens.motion.durationSlow.value, "240ms");
  assert.equal(tokens.motion.reducedMotion.value, "0ms");
  for (const [name, token] of Object.entries(tokens.color)) {
    assert.match(
      css,
      new RegExp(`--color-${name}: ${token.value.toLowerCase()}`),
      `Prototype CSS must consume the approved ${name} color`,
    );
  }
  assert.doesNotMatch(
    css,
    /#f5f6fa|#ffffff|#211d36|#665f78|#6427e7|#00a3c4|Inter,/i,
  );
});

test("responsive evidence is exact, synthetic, and immutable", async () => {
  const evidence = JSON.parse(await readFile(path.join(testDirectory, "render-evidence.json")));
  assert.equal(evidence.fixturePolicy, "synthetic-only");
  assert.equal(evidence.deviceScaleFactor, 1);
  assert.equal(evidence.references.length, 3);
  assert.equal(
    evidence.contentContractSha256,
    sha256(await readFile(path.join(designDirectory, "content-contract.json"))),
  );
  assert.equal(
    evidence.canonicalAssetSha256,
    sha256(await readFile(path.join(assetDirectory, "studioops-logo.png"))),
  );

  for (const reference of evidence.references) {
    assert.match(reference.route, /synthetic|actions/);
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
  const content = JSON.parse(
    await readFile(path.join(designDirectory, "content-contract.json"), "utf8"),
  );
  for (const historyKey of [
    "qaHistory",
    "releaseHistory",
    "exceptionHistory",
    "incidentHistory",
  ]) {
    assert.equal(
      content.actionRequired[historyKey],
      "No acknowledgement recorded",
      "An active Action Required handoff cannot already be acknowledged.",
    );
  }
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
    "Acknowledgement removes",
    "never resolves",
    "desktop-owner-inbox.png",
    "mobile-owner-inbox.png",
    "mobile-direct-task-route.png",
    "**Unavailable**",
  ]) {
    assert.ok(contract.includes(requirement), `Missing durable design note: ${requirement}`);
  }
});
