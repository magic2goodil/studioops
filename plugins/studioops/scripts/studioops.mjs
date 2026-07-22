#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const command = args.shift() || "help";

function option(name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function usage() {
  return `StudioOps plugin client

Usage:
  studioops.mjs status [--url http://127.0.0.1:4317]
  studioops.mjs projects [--url URL]
  studioops.mjs tasks [--url URL]
  studioops.mjs intake --file /path/to/intake.json [--url URL]
  studioops.mjs intake --stdin [--url URL]
  studioops.mjs intake --json '{"project": {...}, "task": {...}}' [--url URL]

Environment:
  STUDIOOPS_URL overrides the default http://127.0.0.1:4317`;
}

function normalize(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

const baseUrl = normalize(option("url", process.env.STUDIOOPS_URL || "http://127.0.0.1:4317"));

async function request(pathname, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (error) {
    throw new Error(`StudioOps is not reachable at ${baseUrl}. Start it with \`npm run dev\` from the StudioOps checkout, then retry. ${error.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(body.error || `StudioOps returned HTTP ${response.status}.`);
  return body;
}

function projectMatch(projects, input = {}) {
  const fields = ["key", "name", "repoPath", "repoUrl"];
  return projects.find((project) => fields.some((field) => (
    normalize(input[field]) && normalize(project[field]).toLowerCase() === normalize(input[field]).toLowerCase()
  ))) || null;
}

async function state() {
  return request("/api/state");
}

async function readStandardInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function intakePayload() {
  const inline = option("json");
  const file = option("file");
  const fromStdin = args.includes("--stdin");
  const selected = [Boolean(inline), Boolean(file), fromStdin].filter(Boolean).length;
  if (selected !== 1) {
    throw new Error("intake requires exactly one payload source: --file, --stdin, or --json.");
  }
  const raw = file
    ? await readFile(file, "utf8")
    : fromStdin
      ? await readStandardInput()
      : inline;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const source = file ? `file ${file}` : fromStdin ? "standard input" : "--json";
    throw new Error(`Could not parse the intake payload from ${source}: ${error.message}`);
  }
}

async function intake() {
  const payload = await intakePayload();
  const projectInput = payload.project || {};
  const taskInput = payload.task || {};
  const current = await state();
  let project = projectMatch(current.projects || [], projectInput);
  let projectCreated = false;
  if (!project) {
    if (!normalize(projectInput.key) || !normalize(projectInput.name)) {
      throw new Error("No matching project exists. project.key and project.name are required to create one.");
    }
    const result = await request("/api/projects", { method: "POST", body: JSON.stringify(projectInput) });
    project = result.project;
    projectCreated = true;
  }
  const result = await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ ...taskInput, project: project.id }),
  });
  const task = result.task;
  return {
    ok: true,
    projectCreated,
    project: { id: project.id, key: project.key, name: project.name },
    task,
    taskUrl: `${baseUrl}/tasks/${encodeURIComponent(task.id)}`,
    nextOwner: task.status === "ready" ? "StudioOps automation" : "human planning",
  };
}

let result;
if (command === "help" || command === "--help" || command === "-h") {
  console.log(usage());
  process.exit(0);
} else if (command === "status") {
  const current = await state();
  result = {
    ok: true,
    url: baseUrl,
    product: current.productAccess || { planName: "Community" },
    projects: current.projects?.length || 0,
    tasks: current.tasks?.length || 0,
  };
} else if (command === "projects") {
  const current = await state();
  result = { projects: current.projects || [] };
} else if (command === "tasks") {
  const current = await state();
  result = { tasks: current.tasks || [] };
} else if (command === "intake") {
  result = await intake();
} else {
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

console.log(JSON.stringify(result, null, 2));
