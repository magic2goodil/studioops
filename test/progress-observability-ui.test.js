import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, css] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("project board exposes accessible progress loading retry and degraded contracts", () => {
  assert.match(html, /id="projectProgress"[^>]+aria-busy="true"/);
  assert.match(html, /id="projectProgressBody"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /option value="1h"/);
  assert.match(html, /option value="24h" selected/);
  assert.match(html, /option value="7d"/);
  assert.match(app, /data-retry-progress/);
  assert.match(app, /Degraded view/);
  assert.match(app, /No project tasks are waiting/);
});

test("task detail reports one exact containment reason and backoff-only retry time", () => {
  assert.match(app, /function renderContainmentPanel\(task\)/);
  assert.match(app, /function renderTaskContainment\(\)/);
  assert.match(app, /waiting\.reasonCode/);
  assert.match(app, /waiting\.nextAction/);
  assert.match(app, /waiting\.retryAt/);
  assert.match(app, /No active containment or waiting condition/);
});

test("progress cards adapt from desktop to tablet and phone layouts", () => {
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]+repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]+grid-template-columns: 1fr/);
});
