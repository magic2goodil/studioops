import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function uiSources() {
  const [html, app, css] = await Promise.all([
    readFile(new URL("public/index.html", ROOT), "utf8"),
    readFile(new URL("public/app.js", ROOT), "utf8"),
    readFile(new URL("public/styles.css", ROOT), "utf8"),
  ]);
  return { html, app, css };
}

test("the initial owner inbox has an explicit non-mutating loading state", async () => {
  const { html, app } = await uiSources();
  assert.match(html, /id="ownerInbox"[^>]*aria-busy="true"/);
  assert.match(html, /Loading owner inbox/);
  assert.match(html, /without changing task state/);
  assert.match(app, /function renderInboxLoading\(\)/);
  assert.match(app, /function renderInboxError\(error\)/);
  assert.match(app, /data-retry-inbox/);
});

test("grouped inbox controls remain native, keyboard reachable, and count owner decisions separately", async () => {
  const { html, app } = await uiSources();
  assert.match(html, /id="attentionButton"[^>]*type="button"/);
  assert.match(html, /id="operationsButton"[^>]*type="button"/);
  assert.match(html, /id="ownerInboxTitle"[^>]*tabindex="-1"/);
  assert.match(app, /<details id="inbox-group-\$\{escapeHtml\(group\.id\)\}/);
  assert.match(app, /attentionCount\.textContent = String\(decisionCount\)/);
  assert.match(app, /operationsCount\.textContent = String\(operationCount\)/);
  assert.match(app, /group\.querySelector\("summary"\)\?\.focus/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
});

test("standalone QA decisions render both the preview action and their task link", async () => {
  const { app } = await uiSources();
  assert.match(app, /item\.taskId && item\.primaryAction\?\.type !== "task"/);
  assert.match(app, /\$\{showTaskLinks \? `<div class="owner-inbox-tasks"/);
});

test("inbox layout defines desktop, tablet, mobile, focus, and reduced-motion behavior", async () => {
  const { css } = await uiSources();
  assert.match(css, /button:focus-visible,[\s\S]*summary:focus-visible/);
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.owner-inbox-group > summary/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.owner-inbox-actions button/);
});
