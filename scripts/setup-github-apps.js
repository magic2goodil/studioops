#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

const DEFAULT_PORT = 4328;
const DEFAULT_OWNER = "magic2goodil";
const CONFIG_DIR = path.join(process.cwd(), ".mission-control", "github-apps");
const REPO_URL = "https://github.com/magic2goodil/studioops";
const GITHUB_API_VERSION = "2026-03-10";

const ROLE_SETS = {
  single: [
    {
      key: "default",
      role: "default",
      name: "StudioOps Bot",
      description: "Creates branches, pull requests, comments, and review handoffs for StudioOps.",
    },
  ],
  roles: [
    {
      key: "builder",
      role: "builder",
      name: "StudioOps Builder",
      description: "Creates implementation branches and pull requests for StudioOps tasks.",
    },
    {
      key: "backend-reviewer",
      role: "backend-reviewer",
      name: "MC Backend Reviewer",
      description: "Reviews API, persistence, auth, privacy, security, migrations, and deployment risk.",
    },
    {
      key: "frontend-reviewer",
      role: "frontend-reviewer",
      name: "MC Frontend Reviewer",
      description: "Reviews UI, accessibility, responsiveness, design-system reuse, and browser behavior.",
    },
    {
      key: "accessibility-reviewer",
      role: "accessibility-reviewer",
      name: "MC Accessibility Reviewer",
      description: "Reviews contrast, keyboard behavior, semantics, labels, alt text, ARIA use, and screen-reader basics.",
    },
    {
      key: "lead-reviewer",
      role: "lead-reviewer",
      name: "MC Lead Reviewer",
      description: "Reviews product fit, architecture, task scope, and owner-readiness.",
    },
    {
      key: "promotion-worker",
      role: "promotion-worker",
      name: "MC Promotion Worker",
      description: "Promotes owner-QA-passed work into protected target branches after validation.",
    },
  ],
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function usage() {
  console.log(`StudioOps GitHub App setup

Usage:
  npm run setup-github-app
  npm run setup-github-role-apps
  node scripts/setup-github-apps.js single --owner magic2goodil --open
  node scripts/setup-github-apps.js roles --owner magic2goodil --open

Options:
  --owner NAME          GitHub user or organization that will own the app registration.
  --org                Register under an organization instead of the signed-in user account.
  --port PORT          Local callback server port. Default: ${DEFAULT_PORT}.
  --open               Open the local setup page in the default browser.

Credentials are written under .mission-control/github-apps/ and ignored by git.
`);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jsonForAttribute(value) {
  return htmlEscape(JSON.stringify(value));
}

function appEndpoint({ owner, org }) {
  if (org) return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`;
  return "https://github.com/settings/apps/new";
}

function appManifest(app, baseUrl) {
  return {
    name: app.name,
    url: REPO_URL,
    redirect_url: `${baseUrl}/callback`,
    callback_urls: [`${baseUrl}/callback`],
    description: app.description,
    public: false,
    default_permissions: {
      actions: "read",
      checks: "read",
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

function installUrlFor(slug) {
  return `https://github.com/apps/${slug}/installations/new`;
}

async function writePrivateFile(filePath, contents) {
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
}

async function storeAppRegistration({ app, owner, org, payload }) {
  const appDir = path.join(CONFIG_DIR, app.key);
  await mkdir(appDir, { recursive: true });

  const installUrl = installUrlFor(payload.slug);
  const publicConfig = {
    role: app.role,
    key: app.key,
    name: payload.name,
    slug: payload.slug,
    appId: payload.id,
    clientId: payload.client_id,
    owner,
    ownerType: org ? "organization" : "user",
    htmlUrl: payload.html_url,
    installUrl,
    credentialsDir: appDir,
    createdAt: new Date().toISOString(),
  };
  const secrets = {
    clientSecret: payload.client_secret,
    webhookSecret: payload.webhook_secret,
  };

  await writeFile(path.join(appDir, "app.json"), `${JSON.stringify(publicConfig, null, 2)}\n`, "utf8");
  await writePrivateFile(path.join(appDir, "secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`);
  await writePrivateFile(path.join(appDir, "private-key.pem"), payload.pem);
  await writeFile(path.join(appDir, "install-url.txt"), `${installUrl}\n`, "utf8");
  return publicConfig;
}

async function exchangeManifestCode(code) {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "studioops",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    throw new Error(payload.message || `GitHub manifest conversion failed with ${response.status}`);
  }
  return payload;
}

function page({ apps, states, endpoint, baseUrl, owner, org }) {
  const forms = apps.map((app) => {
    const manifest = appManifest(app, baseUrl);
    const state = states.get(app.key);
    return `<section class="card">
      <h2>${htmlEscape(app.name)}</h2>
      <p>${htmlEscape(app.description)}</p>
      <form action="${htmlEscape(endpoint)}?state=${encodeURIComponent(state)}" method="post">
        <input type="hidden" name="manifest" value="${jsonForAttribute(manifest)}">
        <button type="submit">Create ${htmlEscape(app.name)}</button>
      </form>
    </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StudioOps GitHub App Setup</title>
  <style>
    body { background: #07111f; color: #e8ecf6; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 40px; }
    main { max-width: 920px; margin: 0 auto; }
    h1 { font-size: 34px; line-height: 1.1; margin: 0 0 12px; }
    p { color: #aab5c7; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 28px; }
    .card { border: 1px solid rgba(255,255,255,.12); border-radius: 18px; background: rgba(255,255,255,.06); padding: 22px; box-shadow: 0 18px 50px rgba(0,0,0,.28); }
    h2 { font-size: 20px; margin: 0 0 8px; }
    button { appearance: none; border: 0; border-radius: 999px; background: linear-gradient(135deg, #7c3cff, #2f80ff); color: white; cursor: pointer; font-weight: 700; padding: 12px 18px; width: 100%; }
    code { color: #c8d5ff; }
  </style>
</head>
<body>
  <main>
    <h1>StudioOps GitHub App Setup</h1>
    <p>Owner target: <code>${htmlEscape(org ? `organization/${owner}` : `user/${owner}`)}</code></p>
    <p>Click each app you want GitHub to create. GitHub will redirect back here, StudioOps will exchange the one-time code, and private credentials will be stored locally under <code>.mission-control/github-apps/</code>.</p>
    <div class="grid">${forms}</div>
  </main>
</body>
</html>`;
}

function successPage(config) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub App Created</title>
  <style>
    body { background: #07111f; color: #e8ecf6; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 40px; }
    main { max-width: 760px; margin: 0 auto; }
    a { color: #8fb8ff; }
    code { color: #c8d5ff; }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(config.name)} created</h1>
    <p>Credentials were saved locally at <code>${htmlEscape(config.credentialsDir)}</code>.</p>
    <p>Next step: <a href="${htmlEscape(config.installUrl)}">install the app on the repositories it should manage</a>.</p>
    <p>After installation, StudioOps can use this app registration to request short-lived installation tokens.</p>
  </main>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") {
    usage();
    return;
  }

  const mode = args._[0] || "single";
  const apps = ROLE_SETS[mode];
  if (!apps) throw new Error(`Unknown mode: ${mode}. Use single or roles.`);

  const port = Number(args.port || DEFAULT_PORT);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid port: ${args.port}`);
  const owner = String(args.owner || DEFAULT_OWNER);
  const org = Boolean(args.org);
  const baseUrl = `http://127.0.0.1:${port}`;
  const endpoint = appEndpoint({ owner, org });
  const states = new Map(apps.map((app) => [app.key, `${app.key}:${crypto.randomBytes(24).toString("hex")}`]));
  const appByState = new Map([...states.entries()].map(([key, state]) => [state, apps.find((app) => app.key === key)]));

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", baseUrl);
      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page({ apps, states, endpoint, baseUrl, owner, org }));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/callback") {
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        const app = appByState.get(state || "");
        if (!code || !app) {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Missing or invalid GitHub App manifest callback state/code.");
          return;
        }
        const payload = await exchangeManifestCode(code);
        const config = await storeAppRegistration({ app, owner, org, payload });
        console.log(`Created ${config.name}: ${config.installUrl}`);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(successPage(config));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname.startsWith("/webhook/")) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await mkdir(CONFIG_DIR, { recursive: true });
  const url = `${baseUrl}/`;
  console.log(`StudioOps GitHub App setup is running: ${url}`);
  console.log(`Mode: ${mode}`);
  console.log(`Credentials will be written under: ${CONFIG_DIR}`);
  console.log("Keep this process running until GitHub redirects back after app creation.");

  if (args.open) {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
