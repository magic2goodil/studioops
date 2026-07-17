import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupGitHubAppAuth,
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
    });

    assert.equal(auth.app.key, "accessibility-reviewer");
    assert.equal(auth.role, "accessibility-reviewer");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupGitHubAppAuth(auth);
    await rm(root, { recursive: true, force: true });
  }
});
