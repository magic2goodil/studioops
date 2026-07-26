import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);

async function uiSources() {
  const [html, app, css] = await Promise.all([
    readFile(new URL("public/index.html", ROOT), "utf8"),
    readFile(new URL("public/app.js", ROOT), "utf8"),
    readFile(new URL("public/styles.css", ROOT), "utf8"),
  ]);
  return { html, app, css };
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function blend(foreground, background, alpha) {
  return foreground.map((channel, index) => (
    (channel * alpha) + (background[index] * (1 - alpha))
  ));
}

function relativeLuminance(color) {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

test("the initial owner inbox has an explicit non-mutating loading state", async () => {
  const { html, app } = await uiSources();
  assert.match(html, /id="ownerInbox"[^>]*aria-busy="true"/);
  assert.doesNotMatch(html, /id="ownerInbox"[^>]*aria-live/);
  assert.match(html, /id="ownerInboxSummary"[^>]*role="status"[^>]*aria-atomic="true"/);
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
  assert.match(app, /class="visually-hidden">\$\{plural\(count, "record"\)\} in this group/);
  assert.match(app, /group\.querySelector\("summary"\)\?\.focus/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
});

test("standalone QA decisions render both the preview action and their task link", async () => {
  const { app } = await uiSources();
  assert.match(app, /item\.taskId && item\.primaryAction\?\.type !== "task"/);
  assert.match(app, /\$\{showTaskLinks \? `<div class="owner-inbox-tasks"/);
});

test("missing PR URLs cannot render a false pull request action", async () => {
  const { app } = await uiSources();
  const context = {
    URL,
    window: { location: { origin: "https://local.studioops.com" } },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(app, "escapeHtml"),
    extractFunction(app, "safeHttpUrl"),
    extractFunction(app, "inboxSecondaryActions"),
  ].join("\n"), context);

  const missingPrAction = vm.runInContext(
    'inboxSecondaryActions({ group: "decisions", primaryAction: {}, prUrl: "" })',
    context,
  );
  const validPrAction = vm.runInContext(
    'inboxSecondaryActions({ group: "decisions", primaryAction: {}, prUrl: "https://github.com/example/repo/pull/1" })',
    context,
  );

  assert.equal(missingPrAction, "");
  assert.match(validPrAction, /Open pull request/);
  assert.match(validPrAction, /https:\/\/github\.com\/example\/repo\/pull\/1/);
});

test("inbox layout defines desktop, tablet, mobile, focus, and reduced-motion behavior", async () => {
  const { app, css } = await uiSources();
  assert.match(css, /button:focus-visible,[\s\S]*summary:focus-visible/);
  assert.match(css, /\.owner-inbox-group > summary:focus-visible\s*\{[^}]*outline-offset: -4px/);
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.owner-inbox-group > summary/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(app, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(css, /\.owner-inbox-actions button/);
});

test("inbox primary action text meets WCAG AA contrast across its gradient", async () => {
  const { css } = await uiSources();
  const rule = css.match(/\.owner-inbox-actions \.primary-action\s*\{([\s\S]*?)\}/)?.[1] || "";
  const gradient = rule.match(/background:\s*linear-gradient\(([^;]+)\)/)?.[1] || "";
  const stops = [...gradient.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)]
    .map((match) => ({
      color: match.slice(1, 4).map(Number),
      alpha: Number(match[4]),
    }));
  assert.equal(stops.length, 2);

  const text = [245, 247, 251];
  const conservativeCardBackground = [52, 54, 64];
  const renderedStops = stops.map((stop) => blend(
    stop.color,
    conservativeCardBackground,
    stop.alpha,
  ));
  for (let step = 0; step <= 20; step += 1) {
    const renderedColor = blend(renderedStops[1], renderedStops[0], step / 20);
    assert.ok(
      contrastRatio(text, renderedColor) >= 4.5,
      `primary action gradient step ${step} must meet 4.5:1 contrast`,
    );
  }
});
