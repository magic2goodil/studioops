#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  addComment,
  addProject,
  addTask,
  generatePrompt,
  readState,
  updateTask,
} from "./store.js";
import {
  expandHome,
  loadConfig,
  projectFromConfig,
  writeConfig,
} from "./config.js";

const execFileAsync = promisify(execFile);

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

function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column] || "").length)));
  console.log(columns.map((column, index) => column.padEnd(widths[index])).join("  "));
  console.log(columns.map((column, index) => "-".repeat(widths[index])).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => String(row[column] || "").padEnd(widths[index])).join("  "));
  }
}

async function bestEffortCheck(command, args) {
  try {
    const result = await execFileAsync(command, args, { timeout: 10_000 });
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ""}${error.stderr || error.message}`.trim() };
  }
}

async function setup() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Codex Mission Control setup");
    console.log("This will write mission-control.config.md. It will not ask for or store private keys.\n");
    const displayName = await rl.question("Your display name: ");
    const githubOwner = await rl.question("GitHub user or organization for repos: ");
    const workspaceRoot = await rl.question("Local workspace root [~/Development]: ");
    const preferredProtocol = await rl.question("Git protocol [ssh]: ");
    const aiToolsRaw = await rl.question("AI tools to generate prompts for [codex]: ");
    const addFirstProject = (await rl.question("Add a first project now? [Y/n]: ")).trim().toLowerCase() !== "n";

    const config = {
      owner: {
        displayName: displayName.trim() || "Local User",
        githubOwner: githubOwner.trim() || "",
      },
      git: {
        preferredProtocol: preferredProtocol.trim() || "ssh",
        defaultBranch: "main",
        branchPrefix: "codex/",
      },
      aiTools: (aiToolsRaw.trim() || "codex").split(",").map((tool) => tool.trim()).filter(Boolean),
      workspace: {
        root: workspaceRoot.trim() || "~/Development",
      },
      defaults: {
        validationCommands: [],
        safetyRules: [
          "Do not deploy production without explicit approval.",
          "Do not send emails, push notifications, or external messages without explicit approval.",
          "Do not commit secrets, private keys, tokens, or private customer data.",
        ],
      },
      projects: [],
    };

    if (addFirstProject) {
      const key = await rl.question("Project key, such as myapp: ");
      const name = await rl.question("Project name: ");
      const repoPath = await rl.question("Local repo path: ");
      const repoUrl = await rl.question("Git repo URL, optional: ");
      const validation = await rl.question("Validation command, optional: ");
      config.projects.push({
        key: key.trim(),
        name: name.trim() || key.trim(),
        description: "",
        repoPath: repoPath.trim(),
        repoUrl: repoUrl.trim(),
        defaultBranch: "main",
        contextLinks: ["README.md", "AGENTS.md"],
        validationCommands: validation.trim() ? [validation.trim()] : [],
        safetyRules: config.defaults.safetyRules,
      });
    }

    const configPath = await writeConfig(config);
    console.log(`\nWrote ${configPath}`);

    for (const rawProject of config.projects) {
      const project = projectFromConfig(rawProject, config.defaults);
      try {
        await addProject(project);
        console.log(`Registered project: ${project.name}`);
      } catch (error) {
        console.log(`Skipped project ${project.key}: ${error.message}`);
      }
    }

    const gh = await bestEffortCheck("gh", ["auth", "status"]);
    console.log(`GitHub CLI check: ${gh.ok ? "ok" : "not ready"}`);
    if (!gh.ok) console.log("Run `gh auth login` if you want GitHub CLI integration.");

    const ssh = await bestEffortCheck("ssh", ["-T", "git@github.com"]);
    const sshLooksOk = ssh.ok || ssh.output.includes("successfully authenticated");
    console.log(`GitHub SSH check: ${sshLooksOk ? "ok" : "not ready"}`);
    if (!sshLooksOk) console.log("Add a GitHub SSH key or use HTTPS/GitHub CLI auth.");
  } finally {
    rl.close();
  }
}

async function importConfig() {
  const config = await loadConfig();
  if (!config) throw new Error("No mission-control.config.md found. Run `mission-control setup` first.");
  let count = 0;
  for (const rawProject of config.projects || []) {
    const project = projectFromConfig(rawProject, config.defaults);
    await addProject(project);
    count += 1;
  }
  console.log(`Imported ${count} project(s).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (command === "help" || args.help) {
    console.log(`Codex Mission Control

Commands:
  setup                         Create mission-control.config.md interactively
  import-config                 Register projects from mission-control.config.md
  projects                      List projects
  tasks                         List tasks
  add-project --key --name      Add a project
  add-task --project --title    Add a task
  update-task TASK_ID           Update task status, branch, PR, or metadata
  status TASK_ID --status       Update task status
  comment TASK_ID --body        Add a builder/reviewer comment
  prompt TASK_ID --role         Print builder or reviewer prompt

Task fields:
  --story                       User story, such as "As a customer..."
  --expected                    Expected outcome or feature behavior
  --criteria                    Acceptance criteria, comma or newline separated
  --attachment                  Image, screenshot, mockup, URL, or reference path
  --branch                      Associated feature branch
  --pr-url                      Associated pull request URL
`);
    return;
  }

  if (command === "setup") {
    await setup();
    return;
  }

  if (command === "import-config") {
    await importConfig();
    return;
  }

  if (command === "projects") {
    const state = await readState();
    printTable(state.projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      repo: project.repoPath || project.repoUrl,
    })), ["id", "key", "name", "repo"]);
    return;
  }

  if (command === "tasks") {
    const state = await readState();
    printTable(state.tasks.map((task) => {
      const project = state.projects.find((item) => item.id === task.projectId);
      return {
        id: task.id,
        project: project?.key || task.projectId,
        status: task.status,
        priority: task.priority,
        title: task.title,
      };
    }), ["id", "project", "status", "priority", "title"]);
    return;
  }

  if (command === "add-project") {
    const project = await addProject({
      key: args.key,
      name: args.name,
      description: args.description,
      repoPath: expandHome(args["repo-path"] || ""),
      repoUrl: args["repo-url"],
      defaultBranch: args["default-branch"] || "main",
      validationCommands: args.validation,
      contextLinks: args.context,
      safetyRules: args.safety,
    });
    console.log(`Added project ${project.id}: ${project.name}`);
    return;
  }

  if (command === "add-task") {
    const task = await addTask({
      project: args.project,
      title: args.title,
      description: args.description,
      status: args.status,
      priority: args.priority,
      type: args.type,
      area: args.area,
      userStory: args.story || args["user-story"],
      expectedOutcome: args.expected || args["expected-outcome"],
      attachments: args.attachment || args.attachments,
      acceptanceCriteria: args.criteria,
      privacyNotes: args.privacy,
      securityNotes: args.security,
      branchName: args.branch || args["branch-name"],
      prUrl: args.pr || args["pr-url"],
    });
    console.log(`Added task ${task.id}: ${task.title}`);
    return;
  }

  if (command === "update-task") {
    const taskId = args._[1];
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(args, "status")) patch.status = args.status;
    if (Object.prototype.hasOwnProperty.call(args, "branch")) patch.branchName = args.branch;
    if (Object.prototype.hasOwnProperty.call(args, "branch-name")) patch.branchName = args["branch-name"];
    if (Object.prototype.hasOwnProperty.call(args, "pr")) patch.prUrl = args.pr;
    if (Object.prototype.hasOwnProperty.call(args, "pr-url")) patch.prUrl = args["pr-url"];
    if (Object.prototype.hasOwnProperty.call(args, "description")) patch.description = args.description;
    if (Object.prototype.hasOwnProperty.call(args, "story")) patch.userStory = args.story;
    if (Object.prototype.hasOwnProperty.call(args, "expected")) patch.expectedOutcome = args.expected;
    if (Object.prototype.hasOwnProperty.call(args, "criteria")) patch.acceptanceCriteria = args.criteria;
    if (Object.prototype.hasOwnProperty.call(args, "attachment")) patch.attachments = args.attachment;
    const task = await updateTask(taskId, patch);
    console.log(`Updated ${task.id}: ${task.title}`);
    return;
  }

  if (command === "status") {
    const taskId = args._[1];
    const task = await updateTask(taskId, { status: args.status });
    console.log(`${task.id} -> ${task.status}`);
    return;
  }

  if (command === "comment") {
    const taskId = args._[1];
    const comment = await addComment(taskId, args.body, args.author || "Codex Builder");
    console.log(`Added comment ${comment.id} to ${taskId}`);
    return;
  }

  if (command === "prompt") {
    const state = await readState();
    const taskId = args._[1];
    console.log(generatePrompt(state, taskId, args.role || "builder"));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
