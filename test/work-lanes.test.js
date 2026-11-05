import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { laneProfilesConflict, repositoryConflictIdentity } from "../src/work-lanes.js";

function profile(project, overrides = {}) {
  return {
    projectId: project.id,
    ...repositoryConflictIdentity(project),
    conflictGroup: "backend",
    fileScope: ["src/shared.js"],
    fileScopeExplicit: true,
    ...overrides,
  };
}

const app = { id: "project_4", repoUrl: "https://github.com/Example/Application.git" };
const appAlias = { id: "project_14", repoUrl: "git@github.com:example/application.git" };

test("repository conflict identity unifies Git transports, casing and .git suffixes", () => {
  assert.equal(repositoryConflictIdentity(app).repositoryUrl, repositoryConflictIdentity(appAlias).repositoryUrl);
  assert.equal(
    repositoryConflictIdentity({ repoUrl: "ssh://git@GITHUB.COM:22/Example/Application.git/" }).repositoryUrl,
    repositoryConflictIdentity(app).repositoryUrl,
  );
  assert.equal(
    repositoryConflictIdentity({ repoUrl: "https://user:secret@github.com/Example/Application.git?token=secret#branch" }).repositoryUrl,
    "github.com/example/application",
  );
  assert.notEqual(
    repositoryConflictIdentity({ repoUrl: "ssh://git@github.com:2222/Example/Application.git" }).repositoryUrl,
    repositoryConflictIdentity(app).repositoryUrl,
  );
});

test("repository source paths normalize without treating relative unknown paths as identity", () => {
  assert.equal(repositoryConflictIdentity({ repoPath: "/workspace/parent/../app/" }).repositoryPath, "/workspace/app");
  assert.equal(repositoryConflictIdentity({ sourceRepoPath: "/workspace/app/.", repoPath: "/temporary/clone" }).repositoryPath, "/workspace/app");
  assert.equal(repositoryConflictIdentity({ repoPath: "C:\\Work\\App\\..\\App\\" }).repositoryPath, "c:/work/app");
  assert.equal(repositoryConflictIdentity({ repoPath: "relative/clone" }).repositoryPath, "");
  assert.equal(repositoryConflictIdentity({ repoUrl: "not a repository", repoPath: "" }).repositoryUrl, "");
});

test("duplicate App project registrations serialize overlapping edits", () => {
  assert.equal(laneProfilesConflict(profile(app), profile(appAlias)), true);
  assert.equal(laneProfilesConflict(
    profile(app, { conflictGroup: "devops", fileScope: ["config/**"] }),
    profile(appAlias, { conflictGroup: "backend", fileScope: ["config/components.json"] }),
  ), true);
});

test("the same checkout serializes edits even when remote names differ or are absent", () => {
  const left = { id: "left", repoUrl: "https://github.com/example/one", repoPath: "/work/one" };
  const right = { id: "right", repoUrl: "https://github.com/example/two", repoPath: "/work/parent/../one/" };
  assert.equal(laneProfilesConflict(profile(left), profile(right)), true);
  assert.equal(laneProfilesConflict(profile({ id: "a", repoPath: "/work/one" }), profile({ id: "b", repoPath: "/work/one/." })), true);
});

test("checkout symlink aliases serialize edits and refresh identity after retargeting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-repository-alias-"));
  try {
    const checkout = path.join(root, "checkout");
    const otherCheckout = path.join(root, "other-checkout");
    const alias = path.join(root, "alias");
    await mkdir(checkout);
    await mkdir(otherCheckout);
    await symlink(checkout, alias, "dir");
    const original = { id: "original", repoPath: checkout };
    const linked = { id: "linked", repoPath: alias };
    assert.equal(repositoryConflictIdentity(original).repositoryPath, repositoryConflictIdentity(linked).repositoryPath);
    assert.equal(laneProfilesConflict(profile(original), profile(linked)), true);
    assert.equal(laneProfilesConflict(
      profile({ ...original, repoUrl: "https://github.com/example/original" }),
      profile({ ...linked, repoUrl: "https://github.com/example/other-name" }),
    ), true);

    await rm(alias);
    await symlink(otherCheckout, alias, "dir");
    assert.notEqual(repositoryConflictIdentity(original).repositoryPath, repositoryConflictIdentity(linked).repositoryPath);
    assert.equal(laneProfilesConflict(profile(original), profile(linked)), false);
    assert.equal(laneProfilesConflict(profile({ id: "other", repoPath: otherCheckout }), profile(linked)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown or ambiguous edit scope cannot open another lane through a repository alias", () => {
  assert.equal(laneProfilesConflict(
    profile(app, { conflictGroup: "devops", fileScopeExplicit: false }),
    profile(appAlias, { conflictGroup: "backend" }),
  ), true);
  assert.equal(laneProfilesConflict(profile(app, { fileScope: [] }), profile(appAlias)), true);
  assert.equal(laneProfilesConflict(profile(app, { fileScope: ["../outside"] }), profile(appAlias)), true);
});

test("explicit disjoint scopes in a shared repository can run in parallel", () => {
  assert.equal(laneProfilesConflict(
    profile(app, { fileScope: ["src/catalog.js"] }),
    profile(appAlias, { fileScope: ["src/giveaway.js"] }),
  ), false);
});

test("independent repositories can edit similarly named files in parallel", () => {
  assert.equal(laneProfilesConflict(
    profile(app),
    profile({ id: "project_6", repoUrl: "https://github.com/example/studioops.git" }),
  ), false);
});

test("missing repository identity does not invent aliases across projects", () => {
  assert.equal(laneProfilesConflict(profile({ id: "a" }), profile({ id: "b" })), false);
  assert.equal(laneProfilesConflict(profile({ id: "a", repoPath: "relative/repo" }), profile({ id: "b", repoPath: "relative/repo" })), false);
});

test("same-project and read-only role semantics remain unchanged", () => {
  assert.equal(laneProfilesConflict(profile(app, { fileScopeExplicit: false }), profile(app)), true);
  assert.equal(laneProfilesConflict(
    profile(app, { conflictGroup: "devops", fileScopeExplicit: false }),
    profile(app, { conflictGroup: "backend", fileScopeExplicit: false }),
  ), false);
  assert.equal(laneProfilesConflict(profile(app, { conflictGroup: "read-only" }), profile(appAlias)), false);
  assert.equal(laneProfilesConflict(profile(app, { conflictGroup: "owner" }), profile(appAlias)), false);
  assert.equal(laneProfilesConflict(profile(app, { conflictGroup: "project-wide" }), profile(appAlias)), true);
});
