import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandHome, loadConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CREDENTIALS_DIR = path.join(process.cwd(), ".mission-control", "github-apps");
const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), "data", "run-outputs", "github-app-auth");
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_REDACTION = "[REDACTED_GITHUB_APP_TOKEN]";

const ROLE_PERMISSIONS = {
  builder: {
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
  "backend-reviewer": {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
  "frontend-reviewer": {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
  "accessibility-reviewer": {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
  "lead-reviewer": {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
  default: {
    contents: "write",
    issues: "write",
    pull_requests: "write",
  },
};

function booleanOption(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  return fallback;
}

function safeName(value) {
  return String(value || "run")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "run";
}

function resolvePath(value, fallback) {
  const raw = expandHome(String(value || fallback));
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function normalizeRole(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  if (normalized.includes("backend")) return "backend-reviewer";
  if (normalized.includes("frontend")) return "frontend-reviewer";
  if (normalized.includes("accessibility") || normalized.includes("a11y")) return "accessibility-reviewer";
  if (normalized.includes("lead")) return "lead-reviewer";
  if (normalized.includes("builder")) return "builder";
  return normalized || "builder";
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function createGitHubAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  }));
  const signingInput = `${header}.${payload}`;
  try {
    const signature = crypto
      .createSign("RSA-SHA256")
      .update(signingInput)
      .end()
      .sign(privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  } catch (error) {
    throw new Error(`Invalid GitHub App private key for app ${appId}: ${error.message}`);
  }
}

function parseJson(text, fallback = {}) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function appDirectoryExists(appDir, key) {
  try {
    const appDirStat = await stat(appDir);
    if (!appDirStat.isDirectory()) {
      throw new Error(`GitHub App credentials path for ${key} is not a directory: ${appDir}`);
    }
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function readCredentialFile(filePath, label) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`missing ${label}`);
    }
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

async function githubJson(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${GITHUB_API_BASE}${pathname}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "codex-mission-control",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = parseJson(text, { message: text });
  if (!response.ok) {
    throw new Error(payload.message || `GitHub API ${method} ${pathname} failed with HTTP ${response.status}`);
  }
  return payload;
}

function parseGitHubRepoUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1], name: sshMatch[2].replace(/\.git$/i, "") };

  const sshUrlMatch = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) return { owner: sshUrlMatch[1], name: sshUrlMatch[2].replace(/\.git$/i, "") };

  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], name: parts[1].replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

async function gitRemoteUrl(repoPath) {
  if (!repoPath) return "";
  try {
    const result = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

async function resolveRunRepository(run) {
  const candidates = [
    run.project?.repoUrl,
    run.project?.remoteUrl,
    await gitRemoteUrl(run.project?.sourceRepoPath || run.project?.repoPath),
  ];
  for (const candidate of candidates) {
    const repo = parseGitHubRepoUrl(candidate);
    if (repo) return repo;
  }
  throw new Error(`GitHub App auth requires a github.com origin or repoUrl for ${run.project?.key || run.projectId || "the project"}.`);
}

async function safeLoadConfig() {
  try {
    return await loadConfig();
  } catch {
    return null;
  }
}

async function loadAppAt(credentialsDir, key) {
  const appDir = path.join(credentialsDir, key);
  if (!(await appDirectoryExists(appDir, key))) return null;

  try {
    const appText = await readCredentialFile(path.join(appDir, "app.json"), "app.json");
    const privateKey = await readCredentialFile(path.join(appDir, "private-key.pem"), "private-key.pem");
    const app = JSON.parse(appText);
    if (!app || typeof app !== "object" || Array.isArray(app)) {
      throw new Error("app.json must contain an object");
    }
    if (!app.appId) throw new Error("app.json is missing appId");
    return {
      ...app,
      key: app.key || key,
      role: app.role || "",
      appId: app.appId,
      privateKey,
      appDir,
    };
  } catch (error) {
    throw new Error(`GitHub App credentials for ${key} are invalid: ${error.message}`);
  }
}

async function loadConfiguredApp(credentialsDir, role, appOptions = {}) {
  const roleMap = appOptions.roleMap && typeof appOptions.roleMap === "object" ? appOptions.roleMap : {};
  const defaultRole = String(appOptions.defaultRole || "default").trim();
  const mappedCandidates = unique([
    roleMap[role],
    roleMap[role.replace("-reviewer", "")],
  ]);
  for (const key of mappedCandidates) {
    const app = await loadAppAt(credentialsDir, key);
    if (app) return app;
    throw new Error(`GitHub App credentials for role ${role} are mapped to ${key}, but ${path.join(credentialsDir, key)} was not found.`);
  }

  const roleApp = await loadAppAt(credentialsDir, role);
  if (roleApp) return roleApp;

  try {
    const entries = await readdir(credentialsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === defaultRole || entry.name === "default") continue;
      if (entry.name === role) continue;
      const app = await loadAppAt(credentialsDir, entry.name);
      if (app && normalizeRole(app.role || app.key) === role) return app;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  const fallbackCandidates = unique([defaultRole, "default"]);
  for (const key of fallbackCandidates) {
    const app = await loadAppAt(credentialsDir, key);
    if (app) return app;
  }

  throw new Error(
    `GitHub App credentials for role ${role} were not found under ${credentialsDir}. Run npm run setup-github-app or npm run setup-github-role-apps, then install the app on the target repository.`,
  );
}

function permissionsForRole(role) {
  return { ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.default) };
}

async function createRuntimeAskpass(runId, runtimeDir = DEFAULT_RUNTIME_DIR) {
  await mkdir(runtimeDir, { recursive: true });
  const askpassPath = path.join(runtimeDir, `${safeName(runId)}.git-askpass.sh`);
  const script = `#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\\n' "\${MISSION_CONTROL_GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s\\n' "\${MISSION_CONTROL_GITHUB_TOKEN:-\${GH_TOKEN:-}}" ;;
esac
`;
  await writeFile(askpassPath, script, { mode: 0o700 });
  await chmod(askpassPath, 0o700).catch(() => {});
  return askpassPath;
}

function quoteGitConfigParameter(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appendGitConfigParameters(existing, entries) {
  const rendered = entries.map(([key, value]) => quoteGitConfigParameter(`${key}=${value}`)).join(" ");
  return [existing, rendered].filter(Boolean).join(" ");
}

function gitHubGitConfigEntries() {
  return [
    ["credential.helper", ""],
    ["credential.username", "x-access-token"],
    ["credential.useHttpPath", "true"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
}

export function githubAppAuthEnv(auth, baseEnv = process.env) {
  if (!auth) return { ...baseEnv };
  return {
    ...baseEnv,
    GH_TOKEN: auth.token,
    GITHUB_TOKEN: auth.token,
    MISSION_CONTROL_GITHUB_TOKEN: auth.token,
    MISSION_CONTROL_GITHUB_APP_AUTH: "1",
    MISSION_CONTROL_GITHUB_APP_ROLE: auth.role,
    MISSION_CONTROL_GITHUB_APP_SLUG: auth.app.slug || "",
    MISSION_CONTROL_GITHUB_REPOSITORY: `${auth.repo.owner}/${auth.repo.name}`,
    MISSION_CONTROL_GIT_USERNAME: "x-access-token",
    GIT_ASKPASS: auth.askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_PARAMETERS: appendGitConfigParameters(baseEnv.GIT_CONFIG_PARAMETERS, gitHubGitConfigEntries()),
  };
}

export function githubAppAuthSecrets(auth) {
  return auth ? [auth.token, auth.jwt].filter(Boolean) : [];
}

export function redactSecrets(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of unique(secrets).sort((a, b) => b.length - a.length)) {
    if (secret.length >= 8) text = text.split(secret).join(TOKEN_REDACTION);
  }
  return text;
}

export function createSecretRedactor(secrets = []) {
  const filtered = unique(secrets).filter((secret) => secret.length >= 8);
  const carryLength = Math.max(0, ...filtered.map((secret) => secret.length - 1));
  let carry = "";
  return {
    write(chunk, writer) {
      const text = carry + String(chunk);
      if (!carryLength) {
        writer(text);
        carry = "";
        return;
      }
      if (text.length <= carryLength) {
        carry = text;
        return;
      }
      const redacted = redactSecrets(text, filtered);
      if (redacted.length <= carryLength) {
        carry = redacted;
        return;
      }
      const emitLength = redacted.length - carryLength;
      writer(redacted.slice(0, emitLength));
      carry = redacted.slice(emitLength);
    },
    flush(writer) {
      if (carry) writer(redactSecrets(carry, filtered));
      carry = "";
    },
  };
}

export function formatGitHubAppAuthForLog(auth) {
  if (!auth) return "GitHub App auth: disabled\n";
  const permissions = Object.entries(auth.permissions)
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
  return [
    "GitHub App auth: enabled",
    `  Role: ${auth.role}`,
    `  App: ${auth.app.name || auth.app.slug || auth.app.key}`,
    `  Repository: ${auth.repo.owner}/${auth.repo.name}`,
    `  Installation: ${auth.installationId}`,
    `  Token expires: ${auth.expiresAt}`,
    `  Token permissions: ${permissions}`,
    "",
  ].join("\n");
}

export function formatGitHubAppAuthForPrompt(auth) {
  if (!auth) {
    return `GitHub App bot auth: disabled by runner configuration. Do not push, create PRs, or comment as a bot unless explicit credentials are available.`;
  }
  const permissions = Object.entries(auth.permissions)
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
  return `GitHub App bot auth:
- Enabled for run role: ${auth.role}
- App identity: ${auth.app.name || auth.app.slug || auth.app.key}
- Repository: ${auth.repo.owner}/${auth.repo.name}
- Installation token expires at: ${auth.expiresAt}
- Requested token permissions: ${permissions}
- \`git\` will use HTTPS with \`GIT_ASKPASS\`; SSH GitHub remotes are rewritten to HTTPS for this process only.
- \`gh\` will use the inherited \`GH_TOKEN\`/ \`GITHUB_TOKEN\` installation token.
- Do not run \`gh auth login\`, print token values, write tokens into git remotes, or store credentials in files.`;
}

export async function cleanupGitHubAppAuth(auth) {
  if (!auth?.askpassPath) return;
  await rm(auth.askpassPath, { force: true }).catch(() => {});
}

export async function prepareGitHubAppAuth(run, input = {}) {
  const config = await safeLoadConfig();
  const githubApps = config?.githubApps || {};
  const runnerDefaults = {
    ...(config?.defaults?.runner || {}),
    ...(config?.runner || {}),
  };
  const enabled = booleanOption(
    input.githubAppAuth ?? process.env.MISSION_CONTROL_GITHUB_APP_AUTH ?? runnerDefaults.githubAppAuth,
    true,
  );
  if (!enabled) return null;

  const role = normalizeRole(run.role);
  const credentialsDir = resolvePath(
    input.githubAppCredentialsDir
      || process.env.MISSION_CONTROL_GITHUB_APPS_DIR
      || githubApps.credentialsDir,
    DEFAULT_CREDENTIALS_DIR,
  );
  const roleMap = input.githubAppRoleMap || githubApps.roleMap || {};
  const defaultRole = input.githubAppDefaultRole || githubApps.defaultRole || "default";
  const repo = await resolveRunRepository(run);
  const app = await loadConfiguredApp(credentialsDir, role, { roleMap, defaultRole });
  const jwt = createGitHubAppJwt(app.appId, app.privateKey);
  const installation = await githubJson(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
    { token: jwt },
  );
  const permissions = permissionsForRole(role);
  const accessToken = await githubJson(
    `/app/installations/${encodeURIComponent(installation.id)}/access_tokens`,
    {
      method: "POST",
      token: jwt,
      body: {
        repositories: [repo.name],
        permissions,
      },
    },
  );
  if (!accessToken.token) throw new Error(`GitHub App installation ${installation.id} did not return an access token.`);
  if (!accessToken.expires_at || Date.parse(accessToken.expires_at) <= Date.now()) {
    throw new Error(`GitHub App installation ${installation.id} returned an expired or invalid token.`);
  }

  return {
    role,
    repo,
    app,
    jwt,
    token: accessToken.token,
    expiresAt: accessToken.expires_at,
    permissions,
    installationId: installation.id,
    askpassPath: await createRuntimeAskpass(run.id, input.githubAppRuntimeDir || DEFAULT_RUNTIME_DIR),
  };
}
