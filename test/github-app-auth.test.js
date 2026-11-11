import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupGitHubAppAuth,
  classifyWorkflowWritePermission,
  formatGitHubAppAuthForLog,
  formatGitHubAppAuthForPrompt,
  githubAppAuthSecrets,
  prepareGitHubAppAuth,
  redactSecrets,
} from "../src/github-app-auth.js";
import { appManifest } from "../scripts/setup-github-apps.js";
import { prepareQaIntegrationAuth } from "../src/qa-integration.js";

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

function runFixture(role = "backend-reviewer") {
  return {
    id: `run_${role}`,
    role,
    project: {
      key: "example",
      repoUrl: "git@github.com:example/repo.git",
    },
  };
}

function workflowRun(patch = {}) {
  return {
    ...runFixture("builder"),
    actionType: "start_builder",
    workAreas: [".github/workflows/validate.yml"],
    fileScope: [".github/workflows/validate.yml"],
    ...patch,
  };
}

async function withPermissionMint(run, options, inspect) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-gh-permission-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  const token = "ghs_synthetic_scoped_token";
  let jwt = "";
  let auth = null;
  let error = null;
  try {
    await writeApp(root, options.credentialRole || run.role, { role: options.credentialRole || run.role });
    globalThis.fetch = async (url, input = {}) => {
      requests.push({ url: String(url), body: input.body ? JSON.parse(input.body) : null });
      jwt = String(input.headers?.Authorization || "").slice("Bearer ".length);
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return { ok: true, text: async () => JSON.stringify({ id: 123 }) };
      }
      assert.ok(String(url).endsWith("/app/installations/123/access_tokens"));
      if (options.denied) {
        return { ok: false, status: 403, text: async () => JSON.stringify({ message: `Permission missing ${jwt}` }) };
      }
      return { ok: true, text: async () => JSON.stringify({ token, expires_at: new Date(Date.now() + 3600000).toISOString() }) };
    };
    try {
      auth = await (options.prepareAuth || prepareGitHubAppAuth)(run, {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
        githubAppRoleMap: {},
        githubAppDefaultRole: options.defaultRole || "default",
      });
    } catch (caught) {
      error = caught;
    }
    await inspect({ auth, error, requests, token, jwt });
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
}

test("workflow permission accepts exact approved paths and non-workflow impact expansion", () => {
  assert.equal(classifyWorkflowWritePermission(workflowRun()).granted, true);
  assert.equal(classifyWorkflowWritePermission(workflowRun({
    workAreas: ["./.github/workflows/validate.yml", "src/feature.js"],
    fileScope: ["src/**", "package*.json", ".github/workflows/validate.yml"],
  })).granted, true);
  assert.equal(classifyWorkflowWritePermission(workflowRun({
    workAreas: [".github/workflows"],
    fileScope: [".github/workflows/validate.yml", "src/support.js"],
  })).granted, true);
});

test("workflow permission denies role, action, broad, missing, lookalike and mismatched scope authority", () => {
  for (const patch of [
    { role: "backend-reviewer" }, { role: "builder-reviewer" }, { role: "qa-integration-worker" },
    { role: "promotion-worker" }, { role: "" }, { actionType: "start_review" }, { actionType: "start_architecture" },
    { workAreas: [] }, { fileScope: [] }, { workAreas: undefined },
    { workAreas: ["src/**"] }, { fileScope: ["src/**"] },
    { fileScope: [".github/**"] }, { workAreas: [".github/**"] },
    { fileScope: ["**/*"] }, { fileScope: [".g*/**"] },
    { fileScope: [".github/workflows/**"] }, { workAreas: [".github/workflows/*.yml"] },
    { fileScope: [".github/workflows-ci/validate.yml"] },
    { fileScope: [".GitHub/workflows/validate.yml"] },
    { fileScope: ["nested/.github/workflows/validate.yml"] },
    { fileScope: [".github/workflows/../secret.yml"] },
    { fileScope: ["/work/.github/workflows/validate.yml"] },
    { fileScope: [".github\\workflows\\validate.yml"] },
    { fileScope: [".github/workflows/other.yml"] },
    { fileScope: [".github/workflows"] },
    { fileScope: [".github/workflows/validate.yml", ".github/workflows/other.yml"] },
  ]) {
    assert.equal(classifyWorkflowWritePermission(workflowRun(patch)).granted, false, JSON.stringify(patch));
  }
});

test("QA integration fallback App identity mints only the dedicated protected-check token profile", async () => {
  await withPermissionMint(runFixture("qa-integration-worker"), { credentialRole: "builder", defaultRole: "builder" }, ({ auth, error, requests, token, jwt }) => {
    assert.ifError(error);
    assert.equal(auth.app.key, "builder");
    assert.equal(auth.role, "qa-integration-worker");
    assert.deepEqual(requests[1].body, {
      repositories: ["repo"],
      permissions: { checks: "read", statuses: "read", contents: "write", issues: "write", pull_requests: "write" },
    });
    const displayed = formatGitHubAppAuthForLog(auth) + formatGitHubAppAuthForPrompt(auth);
    assert.equal(displayed.includes(token), false);
    assert.equal(displayed.includes(jwt), false);
    assert.equal(redactSecrets(`${token} ${jwt}`, githubAppAuthSecrets(auth)).includes(token), false);
  });
});

test("ordinary builder token does not inherit QA or workflow permissions", async () => {
  await withPermissionMint(workflowRun({ workAreas: ["src/**"], fileScope: ["src/feature.js"] }), {}, ({ auth, error, requests }) => {
    assert.ifError(error);
    assert.deepEqual(requests[1].body, { repositories: ["repo"], permissions: { contents: "write", issues: "write", pull_requests: "write" } });
    assert.equal(auth.workflowPermission.granted, false);
  });
});

test("QA adapter pins its permission profile when the configured identity fallback is a builder App", async () => {
  await withPermissionMint(runFixture("qa-integration-worker"), {
    credentialRole: "builder",
    defaultRole: "builder",
    prepareAuth: (run, input) => prepareQaIntegrationAuth({
      projectId: "project_test", projectKey: "example", repoUrl: "https://github.com/example/repo",
    }, { ...input, githubAppRole: "builder" }),
  }, ({ auth, error, requests }) => {
    assert.ifError(error);
    assert.equal(auth.role, "qa-integration-worker");
    assert.equal(auth.app.key, "builder");
    assert.deepEqual(requests[1].body.permissions, { checks: "read", statuses: "read", contents: "write", issues: "write", pull_requests: "write" });
  });
});

test("only a scoped builder mint requests workflows write and remains one-repository scoped", async () => {
  await withPermissionMint(workflowRun({ fileScope: [".github/workflows/validate.yml", "package*.json"] }), {}, ({ auth, error, requests }) => {
    assert.ifError(error);
    assert.deepEqual(requests[1].body, { repositories: ["repo"], permissions: { contents: "write", issues: "write", pull_requests: "write", workflows: "write" } });
    assert.equal(auth.workflowPermission.granted, true);
  });
});

test("unapproved installation permissions fail once without leaking JWT or changing credential identity", async () => {
  await withPermissionMint(workflowRun(), { denied: true }, ({ auth, error, requests, jwt }) => {
    assert.equal(auth, null);
    assert.equal(requests.length, 2);
    assert.equal(error.code, "github_app_permissions_not_approved");
    assert.match(error.message, /approve any pending installation permission update/i);
    assert.match(error.message, /fresh token/);
    assert.equal(error.message.includes(jwt), false);
  });
});

test("setup ceilings separate QA inspection and Builder workflow authority", () => {
  const make = (role) => appManifest({ role, name: "Synthetic App", description: "Synthetic" }, "http://127.0.0.1:4328").default_permissions;
  assert.deepEqual(make("qa-integration-worker"), { checks: "read", contents: "write", issues: "write", metadata: "read", pull_requests: "write", statuses: "read" });
  assert.equal(make("builder").workflows, "write");
  assert.equal(make("builder").statuses, "read");
  assert.equal(make("default").statuses, "read");
  for (const role of ["default", "backend-reviewer", "frontend-reviewer", "lead-reviewer", "promotion-worker", "qa-integration-worker"]) {
    assert.equal(make(role).workflows, undefined);
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
        githubAppRoleMap: {},
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
      githubAppRoleMap: {},
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
        githubAppRoleMap: {},
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
      githubAppRoleMap: {},
    });

    assert.equal(auth.app.key, "accessibility-reviewer");
    assert.equal(auth.role, "accessibility-reviewer");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("owner QA verification requests a read-only repository token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let auth = null;

  try {
    await writeApp(root, "lead-reviewer", { role: "lead-reviewer" });
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
        assert.deepEqual(body.permissions, { contents: "read" });
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: "ghs_read_only_qa_token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    auth = await prepareGitHubAppAuth(runFixture("qa-reviewer"), {
      githubAppCredentialsDir: root,
      githubAppRuntimeDir: path.join(root, "runtime"),
      githubAppRoleMap: { "qa-reviewer": "lead-reviewer" },
    });

    assert.equal(auth.role, "qa-reviewer");
    assert.equal(auth.app.key, "lead-reviewer");
    assert.deepEqual(auth.permissions, { contents: "read" });
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});

test("installation lookup aborts at its bounded timeout without exposing the app JWT", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let authorization = "";

  try {
    await writeApp(root, "backend-reviewer", { role: "backend-reviewer" });
    globalThis.fetch = async (url, options = {}) => {
      assert.ok(String(url).endsWith("/repos/example/repo/installation"));
      assert.ok(options.signal instanceof AbortSignal);
      authorization = options.headers.Authorization;
      return await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error(`request aborted with ${authorization}`));
        }, { once: true });
      });
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(runFixture(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
        githubAppRoleMap: {},
        githubAppRequestTimeoutMs: 10,
      }),
      (error) => {
        assert.equal(error.code, "github_api_request_timeout");
        assert.match(error.message, /GET \/repos\/example\/repo\/installation timed out after 10ms/);
        assert.equal(error.message.includes(authorization.slice("Bearer ".length)), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("installation token exchange has its own bounded timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  const signals = [];

  try {
    await writeApp(root, "backend-reviewer", { role: "backend-reviewer" });
    globalThis.fetch = async (url, options = {}) => {
      signals.push(options.signal);
      assert.ok(options.signal instanceof AbortSignal);
      if (String(url).endsWith("/repos/example/repo/installation")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ id: 98765 }),
        };
      }
      if (String(url).endsWith("/app/installations/98765/access_tokens")) {
        return await new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("token exchange aborted")), { once: true });
        });
      }
      throw new Error(`Unexpected GitHub API call: ${url}`);
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(runFixture(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
        githubAppRoleMap: {},
        githubAppRequestTimeoutMs: 10,
      }),
      (error) => {
        assert.equal(error.code, "github_api_request_timeout");
        assert.match(error.message, /POST \/app\/installations\/98765\/access_tokens timed out after 10ms/);
        return true;
      },
    );
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[1].aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub App request failures redact the app JWT", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-gh-app-auth-"));
  const originalFetch = globalThis.fetch;
  let jwt = "";

  try {
    await writeApp(root, "backend-reviewer", { role: "backend-reviewer" });
    globalThis.fetch = async (url, options = {}) => {
      assert.ok(String(url).endsWith("/repos/example/repo/installation"));
      jwt = options.headers.Authorization.slice("Bearer ".length);
      throw new Error(`socket rejected credential ${jwt}`);
    };

    await assert.rejects(
      () => prepareGitHubAppAuth(runFixture(), {
        githubAppCredentialsDir: root,
        githubAppRuntimeDir: path.join(root, "runtime"),
        githubAppRoleMap: {},
      }),
      (error) => {
        assert.equal(error.code, "github_api_request_failed");
        assert.match(error.message, /\[REDACTED_GITHUB_APP_TOKEN\]/);
        assert.equal(error.message.includes(jwt), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
