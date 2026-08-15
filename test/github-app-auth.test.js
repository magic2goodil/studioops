import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyWorkflowWritePermission,
  cleanupGitHubAppAuth,
  formatGitHubAppAuthForLog,
  formatGitHubAppAuthForPrompt,
  prepareGitHubAppAuth,
} from "../src/github-app-auth.js";

function privateKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

async function writeApp(root, key, options = {}) {
  const appDir = path.join(root, key);
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "app.json"), `${JSON.stringify({
    key,
    role: options.role || key,
    name: options.name || key,
    slug: options.slug || key,
    appId: options.appId || "12345",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(appDir, "private-key.pem"), options.privateKey || privateKeyPem(), "utf8");
}

function runFixture(role = "backend-reviewer", overrides = {}) {
  return {
    id: `run_${role}`,
    role,
    ...overrides,
    project: {
      key: "example",
      repoUrl: "git@github.com:example/repo.git",
      ...(overrides.project || {}),
    },
  };
}

function workflowBuilderRun(scope = [".github/workflows/validation.yml"]) {
  return runFixture("builder", {
    actionType: "start_builder",
    fileScope: scope,
    workAreas: scope,
  });
}

test("workflow permission classifier requires an exact declared workflow builder scope", () => {
  for (const scope of [
    [".github/workflows"],
    [".github/workflows/validation.yml"],
    ["./.github/workflows/**/validation.yml"],
  ]) {
    assert.deepEqual(classifyWorkflowWritePermission(workflowBuilderRun(scope)), {
      granted: true,
      reason: "declared_workflow_builder_run",
    });
  }

  const denied = [
    workflowBuilderRun(["src/runner.js"]),
    workflowBuilderRun([".github/workflows-ci/validation.yml"]),
    workflowBuilderRun([".github/workflows.yml"]),
    workflowBuilderRun([".github/WORKFLOWS/validation.yml"]),
    workflowBuilderRun(["automation/.github/workflows/validation.yml"]),
    workflowBuilderRun([".github/workflows/../CODEOWNERS"]),
    workflowBuilderRun([".github/**"]),
    workflowBuilderRun(["**/.github/workflows/validation.yml"]),
    { ...workflowBuilderRun(), fileScope: [] },
    { ...workflowBuilderRun(), workAreas: [] },
    { ...workflowBuilderRun(), workAreas: [".github/workflows/other.yml"] },
    ...["backend-reviewer", "accessibility-reviewer", "qa-integration-worker", "promotion-worker"]
      .map((role) => ({ ...workflowBuilderRun(), role })),
    { ...workflowBuilderRun(), role: "builder-lookalike" },
    { ...workflowBuilderRun(), actionType: "start_review" },
  ];
  for (const run of denied) {
    assert.equal(classifyWorkflowWritePermission(run).granted, false);
  }
});

test("workflow-scoped builder token requests remain repository-limited", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let auth = null;

  try {
    await writeApp(root, "builder", { role: "builder" });
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.repositories, ["repo"]);
        assert.deepEqual(body.permissions, {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          workflows: "write",
        });
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: "ghs_workflow_installation_token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    auth = await prepareGitHubAppAuth(workflowBuilderRun(), {
      githubAppCredentialsDir: root,
      githubAppRuntimeDir: path.join(root, "runtime"),
    });

    assert.equal(auth.permissions.workflows, "write");
    assert.deepEqual(auth.workflowPermission, {
      granted: true,
      reason: "declared_workflow_builder_run",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary builder token requests keep the existing narrow permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let auth = null;

  try {
    await writeApp(root, "builder", { role: "builder" });
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.repositories, ["repo"]);
        assert.deepEqual(body.permissions, {
          contents: "write",
          issues: "write",
          pull_requests: "write",
        });
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: "synthetic_ordinary_builder_token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    const scope = ["src/runner.js"];
    auth = await prepareGitHubAppAuth(runFixture("builder", {
      actionType: "start_builder",
      fileScope: scope,
      workAreas: scope,
    }), {
      githubAppCredentialsDir: root,
      githubAppRuntimeDir: path.join(root, "runtime"),
    });

    assert.equal(auth.permissions.workflows, undefined);
    assert.equal(auth.workflowPermission.granted, false);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed role-specific GitHub App credentials fail before default fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  try {
    const roleDir = path.join(root, "backend-reviewer");
    await mkdir(roleDir, { recursive: true });
    await writeFile(path.join(roleDir, "app.json"), "{not json", "utf8");
    await writeFile(path.join(roleDir, "private-key.pem"), "not a private key", "utf8");
    await writeApp(root, "default", { role: "default" });

    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("GitHub API should not be called when role credentials are invalid.");
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(runFixture(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
      }),
      (error) => {
        assert.match(error.message, /backend-reviewer/);
        assert.match(error.message, /invalid/);
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("default GitHub App credentials remain an intentional fallback when no role app exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  const calls = [];
  let auth = null;

  try {
    await writeApp(root, "default", { role: "default" });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.repositories, ["repo"]);
        assert.equal(body.permissions.contents, "write");
        assert.equal(body.permissions.pull_requests, "write");
        assert.equal(body.permissions.actions, "read");
        assert.equal(body.permissions.workflows, undefined);
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: "ghs_test_installation_token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    auth = await prepareGitHubAppAuth(runFixture(), {
      githubAppCredentialsDir: root,
      githubAppRuntimeDir: path.join(root, "runtime"),
    });

    assert.equal(auth.app.key, "default");
    assert.equal(auth.role, "backend-reviewer");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing repository installation reports the exact repository and remediation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;

  try {
    await writeApp(root, "backend-reviewer", { role: "backend-reviewer" });
    globalThis.fetch = async (url) => {
      assert.ok(String(url).endsWith("/repos/example/repo/installation"));
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not Found" }),
      };
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(runFixture(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
      }),
      (error) => {
        assert.equal(error.code, "github_app_not_installed_on_repository");
        assert.match(error.message, /example\/repo/);
        assert.match(error.message, /Install that role app/);
        assert.doesNotMatch(error.message, /^Not Found$/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("accessibility reviewer GitHub App credentials resolve as a reviewer role", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let auth = null;

  try {
    await writeApp(root, "accessibility-reviewer", { role: "accessibility-reviewer" });
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        const body = JSON.parse(options.body);
        assert.equal(body.permissions.actions, "read");
        assert.equal(body.permissions.checks, "read");
        assert.equal(body.permissions.contents, "write");
        assert.equal(body.permissions.pull_requests, "write");
        assert.equal(body.permissions.workflows, undefined);
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: "ghs_test_installation_token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    auth = await prepareGitHubAppAuth(runFixture("accessibility-reviewer"), {
      githubAppCredentialsDir: root,
      githubAppRuntimeDir: path.join(root, "runtime"),
    });

    assert.equal(auth.app.key, "accessibility-reviewer");
    assert.equal(auth.role, "accessibility-reviewer");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub permission approval failures stop without credential fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  const calls = [];

  try {
    await writeApp(root, "builder", { role: "builder" });
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ message: "Resource not accessible by integration" }),
        };
      }
      throw new Error(`Unexpected fallback request: ${url}`);
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(workflowBuilderRun(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
      }),
      (error) => {
        assert.equal(error.code, "github_app_permissions_not_approved");
        assert.match(error.message, /Approve any pending GitHub App permission changes/);
        assert.match(error.message, /will not fall back to personal credentials or a cached token/);
        return true;
      },
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("permission summaries never expose installation tokens or app JWTs", () => {
  const auth = {
    role: "builder",
    app: { key: "builder", name: "StudioOps Builder" },
    repo: { owner: "example", name: "repo" },
    installationId: 98765,
    expiresAt: "2030-01-01T00:00:00.000Z",
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      workflows: "write",
    },
    token: "ghs_secret_installation_token",
    jwt: "secret_app_jwt_value",
  };

  for (const summary of [
    formatGitHubAppAuthForLog(auth),
    formatGitHubAppAuthForPrompt(auth),
  ]) {
    assert.match(summary, /workflows:write/);
    assert.doesNotMatch(summary, /ghs_secret_installation_token/);
    assert.doesNotMatch(summary, /secret_app_jwt_value/);
  }
});
