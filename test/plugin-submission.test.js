import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function json(relative) {
  return JSON.parse(await readFile(path.resolve(relative), "utf8"));
}

test("public plugin listing metadata satisfies directory limits", async () => {
  const manifest = await json("plugins/studioops/.codex-plugin/plugin.json");
  const listing = await json("docs/plugin-submission/listing.json");
  const ui = manifest.interface;

  assert.equal(listing.submissionType, "skills-only");
  assert.equal(listing.name, manifest.name);
  assert.equal(listing.version, manifest.version);
  assert.equal(listing.displayName, ui.displayName);
  assert.equal(listing.shortDescription, ui.shortDescription);
  assert.equal(listing.longDescription, ui.longDescription);
  assert.equal(listing.developerName, ui.developerName);
  assert.deepEqual(listing.starterPrompts, ui.defaultPrompt);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.ok(ui.displayName.length <= 30);
  assert.ok(ui.shortDescription.length <= 30);
  assert.ok(ui.longDescription.length <= 4000);
  assert.ok(ui.developerName.length <= 80);
  assert.ok(ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) {
    assert.ok(prompt.length <= 128);
    assert.doesNotMatch(prompt, /[@\r\n]/);
  }
  for (const key of ["websiteUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) {
    assert.match(listing[key], /^https:\/\/[^/]+/);
    assert.ok(listing[key].length <= 1024);
  }
});

test("submission includes exactly five positive and three negative tests", async () => {
  const cases = await json("docs/plugin-submission/test-cases.json");
  assert.equal(cases.positive.length, 5);
  assert.equal(cases.negative.length, 3);

  for (const item of cases.positive) {
    assert.ok(item.prompt);
    assert.ok(item.expectedBehavior);
    assert.ok(item.expectedResult);
    assert.ok(item.fixture);
  }
  for (const item of cases.negative) {
    assert.ok(item.prompt);
    assert.ok(item.expectedBehavior);
    assert.ok(item.reason);
  }
});

test("plugin exposes setup and workflow skills with policy documents", async () => {
  const files = [
    "plugins/studioops/skills/setup-studioops/SKILL.md",
    "plugins/studioops/skills/run-studioops/SKILL.md",
    "PRIVACY.md",
    "TERMS.md",
    "SUPPORT.md",
    "docs/plugin-submission/RELEASE_NOTES.md",
    "docs/plugin-submission/SUBMISSION_CHECKLIST.md",
  ];
  for (const file of files) {
    const content = await readFile(path.resolve(file), "utf8");
    assert.ok(content.trim().length > 100, `${file} should contain substantive content`);
  }
});
