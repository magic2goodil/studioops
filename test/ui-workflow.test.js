import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

test("task management UI presents the five-stage StudioOps delivery flow", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("public/index.html", ROOT), "utf8"),
    readFile(new URL("public/app.js", ROOT), "utf8"),
    readFile(new URL("public/styles.css", ROOT), "utf8"),
  ]);

  for (const label of ["Structured intake", "AI builders", "Specialist review", "QA integration", "Human release gate"]) {
    assert.match(app, new RegExp(label, "i"));
  }
  assert.match(html, /id="taskCreateDialog"/);
  assert.match(html, /From request to release/);
  assert.match(app, /class="review-evidence"/);
  assert.match(app, /class="workflow-rail"/);
  assert.match(styles, /\.task-workspace-grid/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test("README product captures use the intended 1280 by 720 frame", async () => {
  for (const filename of ["screenshot-pipeline-board.png", "screenshot-review-gate.png"]) {
    const png = await readFile(new URL(`plugins/studioops/assets/${filename}`, ROOT));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png.readUInt32BE(16), 1280, `${filename} width`);
    assert.equal(png.readUInt32BE(20), 720, `${filename} height`);
  }
});
