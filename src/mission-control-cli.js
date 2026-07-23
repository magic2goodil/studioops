#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  addComment,
  addProject,
  addTask,
  automationTick,
  generatePrompt,
  recordQaDecision,
  recordReview,
  readState,
  resetAutomationCircuit,
  resumeOperatorAutomation,
  setOperatorPause,
  updateProject,
  updateTask,
  updateRun,
} from "./store.js";
import { createSupervisorReport, formatSupervisorReport } from "./supervisor.js";
import { dispatchSupervisorActions, formatDispatchReport, planDispatches } from "./dispatcher.js";
import { formatRunnerPlan, formatRunnerReport, planRunnableRuns, runQueuedRuns } from "./runner.js";
import { formatNotificationReport, sendPendingNotifications } from "./notifier.js";
import { formatQaIntegrationReport, planQaIntegrations, runQaIntegration } from "./qa-integration.js";
import { formatPromotionReport, planPromotions, runPromotion } from "./promotion.js";
import { formatSelfUpdateReport, runSelfUpdate } from "./self-update.js";
import { branchWebUrl, integrationBranchName } from "./integration-policy.js";
import {
  expandHome,
  loadConfig,
  projectFromConfig,
  writeConfig,
} from "./config.js";
import { backupStateDatabase } from "./state-database.js";
import {
  defaultStudioOpsCredentialsRoot,
  defaultStudioOpsGitLockRoot,
  defaultStudioOpsWorkspaceRoot,
} from "./runtime-paths.js";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const rawKey = item.slice(2);
    const equalsIndex = rawKey.indexOf("=");
    if (equalsIndex !== -1) {
      args[rawKey.slice(0, equalsIndex)] = rawKey.slice(equalsIndex + 1);
      continue;
    }
    const key = rawKey;
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

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
    console.log("StudioOps setup");
    console.log("This will write the local StudioOps configuration. It will not ask for or store private keys.\n");
    const displayName = await rl.question("Your display name: ");
    const githubOwner = await rl.question("GitHub user or organization for repos: ");
    const workspaceRoot = await rl.question("Local workspace root [~/.codex/workspaces]: ");
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
        root: workspaceRoot.trim() || "~/.codex/workspaces",
      },
      githubApps: {
        credentialsDir: defaultStudioOpsCredentialsRoot(),
        defaultRole: "default",
        roleMap: {
          builder: "default",
          "backend-reviewer": "default",
          "frontend-reviewer": "default",
          "accessibility-reviewer": "default",
          "lead-reviewer": "default",
          "promotion-worker": "default",
        },
      },
      defaults: {
        executionPolicy: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          leadReasoningEffort: "xhigh",
          complexReasoningEffort: "xhigh",
          maxAttempts: 2,
          retryBackoffMs: 300000,
          staleRunMs: 7200000,
        },
        supervisor: {
          intervalSeconds: 300,
          baseUrl: "http://127.0.0.1:4317",
          ownerNotificationStatus: "user_review",
          builderConcurrency: 1,
          reviewerConcurrency: 2,
          requireHumanMerge: true,
          requireGitHubActionsDeploy: true,
        },
        steward: {
          intervalSeconds: 300,
          limit: 50,
        },
        dispatcher: {
          intervalSeconds: 300,
          provider: "prompt-outbox",
          maxDispatchesPerSweep: 6,
          builderConcurrency: 3,
          reviewerConcurrency: 3,
          ownerConcurrency: 10,
          requireHumanMerge: true,
          requireGitHubActionsDeploy: true,
        },
        runner: {
          intervalSeconds: 300,
          limit: 3,
          provider: "codex-cli",
          model: "gpt-5.6-sol",
          modelReasoningEffort: "high",
          useWorkspaces: true,
          workspaceRoot: defaultStudioOpsWorkspaceRoot("run"),
          gitLock: {
            lockRoot: defaultStudioOpsGitLockRoot(),
          },
          timeoutMs: 7200000,
        },
        qaIntegration: {
          intervalSeconds: 300,
          validationTimeoutMs: 600000,
          workspaceRoot: defaultStudioOpsWorkspaceRoot("qa"),
        },
        promotion: {
          intervalSeconds: 300,
          validationTimeoutMs: 600000,
          workspaceRoot: defaultStudioOpsWorkspaceRoot("promotion"),
          githubAppAuth: true,
          githubAppRole: "promotion-worker",
        },
        notifier: {
          intervalSeconds: 60,
          channel: "macos",
          limit: 10,
        },
        selfUpdate: {
          intervalSeconds: 300,
          remote: "origin",
          branch: "main",
          staleRunMs: 7200000,
          notify: false,
        },
        validationCommands: [],
        reviewPolicy: {
          maxBuilderReviewCycles: 2,
          reviewerMayFixSmallIssues: true,
          leadOwnsFinalDecisionAtLimit: true,
          trustLeadApprovals: false,
          qaReviewerRole: "qa-reviewer",
          integrationBranch: "",
        },
        trustLeadApprovals: false,
        integrationBranch: "",
        standards: [
          "standards/engineering.md",
          "standards/design-system.md",
          "standards/frontend.md",
          "standards/styles.md",
          "standards/javascript.md",
          "standards/assets.md",
          "standards/content.md",
          "standards/data.md",
          "standards/mockup-intake.md",
          "standards/seo.md",
          "standards/performance.md",
          "standards/accessibility.md",
          "standards/security-privacy.md",
          "standards/testing.md",
          "standards/release-deployment.md",
          "standards/review-checklist.md",
        ],
        reviewPipeline: [
          {
            key: "backend",
            label: "Backend Review",
            role: "backend-reviewer",
            status: "backend_review",
            required: true,
            description: "Review API contracts, persistence, auth, privacy, security, migrations, and deployment risk.",
          },
          {
            key: "frontend",
            label: "Frontend Review",
            role: "frontend-reviewer",
            status: "frontend_review",
            required: true,
            description: "Review UI/UX, responsiveness, accessibility, design-system reuse, content editability, and browser health.",
          },
          {
            key: "accessibility",
            label: "Accessibility Review",
            role: "accessibility-reviewer",
            status: "accessibility_review",
            required: true,
            description: "Expert review of contrast, readable typography, focus-visible states, keyboard behavior, semantics, labels, alt text, ARIA use, and screen-reader basics before lead review.",
          },
          {
            key: "lead",
            label: "Primary Lead Review",
            role: "lead-reviewer",
            status: "lead_review",
            required: true,
            description: "Review product fit, architecture, reviewer findings, PR/task scope, and readiness for the human owner.",
          },
        ],
        safetyRules: [
          "Do not deploy production without explicit approval.",
          "PR merges and protected integration branch pushes must not deploy production by default; production deploys must run from explicit releases or tags after safety checks.",
          "Release/tag deploy workflows must verify the target commit is reachable from the protected integration branch and gated to the approved deploy owner or allowed deployer list.",
          "Manual workflow_dispatch deploys must be dry-run or preview-only unless explicitly approved for an emergency production path.",
          "Production deployment automation must not use broad delete/sync cleanup or remove production env files, databases, uploads, media, generated assets, logs, virtualenvs, backups, or production-only state.",
          "Do not send emails, push notifications, or external messages without explicit approval.",
          "Do not commit secrets, private keys, tokens, or private customer data.",
          "Do not add sensitive data collection, training, personalization, or outbound messaging without clear consent and opt-out behavior.",
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
        standards: config.defaults.standards,
        validationCommands: validation.trim() ? [validation.trim()] : [],
        safetyRules: config.defaults.safetyRules,
        reviewPolicy: config.defaults.reviewPolicy,
        trustLeadApprovals: false,
        integrationBranch: "",
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
  if (!config) throw new Error("No local StudioOps configuration found. Run `studioops setup` first.");
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
    console.log(`StudioOps

Commands:
  setup                         Create studioops.config.md interactively
  import-config                 Register projects from StudioOps configuration
  projects                      List projects
  tasks                         List tasks, optionally --project key and --status value
  add-project --key --name      Add a project
  update-project PROJECT        Update project settings and Trust Leads policy
  add-task --project --title    Add a task
  update-task TASK_ID           Update task status, branch, PR, or metadata
  status TASK_ID --status       Update task status
  comment TASK_ID --body        Add a builder/reviewer comment
  review TASK_ID --stage        Record approved, skipped, or changes_requested
  automation-tick               Advance ready, blocked, and review tasks
  automation-pause              Pause new builder and reviewer work
  automation-resume             Resume builder and reviewer work after verification
  circuit-reset                 Reset one verified task or project circuit
  supervisor                    Show next builder, reviewer, dependency, and owner actions
  dispatcher                    Create durable dispatch runs from supervisor actions
  runner                        Run queued builder/reviewer dispatches with Codex
  qa-integrate                  Merge lead-approved PR heads into QA integration branches
  qa-pass TASK_ID --body        Mark local QA passed and queue promotion to main
  qa-fail TASK_ID --body        Mark local QA failed and return the task for changes
  promote                       Merge owner-QA-passed PR heads into target branches
  notifier                      Send local owner/failure notifications
  self-update                   Fast-forward StudioOps main and restart workers
  backup [--output PATH]        Create a transactionally consistent SQLite backup
  runs                          List dispatch runs
  run-prompt RUN_ID             Print the prompt snapshot for a dispatch run
  update-run RUN_ID             Update dispatch run status, thread ID, or notes
  prompt TASK_ID --role         Print builder, backend-reviewer, frontend-reviewer, accessibility-reviewer, or lead-reviewer prompt
  qa-list                       List tasks waiting for local QA review

Task fields:
  --story                       User story, such as "As a customer..."
  --expected                    Expected outcome or feature behavior
  --criteria                    Acceptance criteria, comma or newline separated
  --attachment                  Image, screenshot, mockup, URL, or reference path
  --lane                        Work lane: backend, frontend, design, devops, product
  --work-area                   Expected file/work areas, comma or newline separated
  --branch                      Associated feature branch
  --pr-url                      Associated pull request URL
  --standards                   Project standards, comma or newline separated
  --trust-leads                 Route lead-approved work to QA integration and review
  --trust-lead-approvals        Alias for --trust-leads
  --no-trust-leads              Disable Trust Leads for a project
  --integration-branch          Non-production branch used for QA integration bundles
  --workflow-mode               Project workflow: auto, local, or github
  --parent                      Parent epic/task ID
  --depends-on                  Dependency task IDs, comma or newline separated

Automation:
  studioops automation-tick --project dollos --limit 10
  studioops automation-pause --reason "Incident investigation"
  studioops automation-resume --reason "Database and workers verified"
  studioops circuit-reset --task task_101 --reason "Credentials verified"
  studioops supervisor --json
  studioops dispatcher --plan
  studioops runner --plan
  studioops runner --provider codex-sdk
  studioops qa-integrate --plan
  studioops promote --plan
  studioops notifier --plan
  studioops self-update --plan
  studioops runs --status queued
  studioops review task_1 --stage backend --outcome approved --body "Reviewed API and migrations."
  studioops qa-pass task_1 --body "Looks good locally."
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

  if (command === "backup") {
    const outputPath = await backupStateDatabase(args.output || args.path || "");
    console.log(`StudioOps backup created: ${outputPath}`);
    return;
  }

  if (command === "projects") {
    const state = await readState();
    printTable(state.projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      workflowMode: project.workflowMode || "auto",
      repo: project.repoPath || project.repoUrl,
      trustLeads: project.reviewPolicy?.trustLeadApprovals ? "yes" : "no",
      integrationBranch: project.reviewPolicy?.integrationBranch || "",
    })), ["id", "key", "name", "workflowMode", "repo", "trustLeads", "integrationBranch"]);
    return;
  }

  if (command === "qa-list") {
    const state = await readState();
    const projectFilter = args.project
      ? state.projects.find((project) => project.id === args.project || project.key === args.project)
      : null;
    if (args.project && !projectFilter) throw new Error(`Unknown project: ${args.project}`);
    const tasks = state.tasks
      .filter((task) => task.status === "qa_review")
      .filter((task) => !projectFilter || task.projectId === projectFilter.id);
    printTable(tasks.map((task) => {
      const project = state.projects.find((item) => item.id === task.projectId);
      const integrationBranch = task.integrationBranch || integrationBranchName(project);
      const integrationLink = task.integrationBranchUrl || branchWebUrl(project, integrationBranch);
      return {
        id: task.id,
        project: project?.key || task.projectId,
        integrationBranch,
        integrationLink,
        branch: task.branchName || "",
        pr: task.prUrl || "",
        title: task.title,
      };
    }), ["id", "project", "integrationBranch", "integrationLink", "branch", "pr", "title"]);
    return;
  }

  if (command === "qa-pass" || command === "qa-fail") {
    const taskId = args._[1] || args.task || args["task-id"];
    const result = await recordQaDecision(taskId, {
      outcome: command === "qa-pass" ? "passed" : "failed",
      body: args.body || args.notes || "",
      author: args.author || "Owner QA",
    });
    console.log(`${result.task.id}: QA ${result.outcome}. Status now ${result.task.status}.`);
    return;
  }

  if (command === "tasks") {
    const state = await readState();
    const projectFilter = args.project
      ? state.projects.find((project) => project.id === args.project || project.key === args.project)
      : null;
    if (args.project && !projectFilter) throw new Error(`Unknown project: ${args.project}`);
    const tasks = state.tasks
      .filter((task) => !projectFilter || task.projectId === projectFilter.id)
      .filter((task) => !args.status || task.status === args.status);
    printTable(tasks.map((task) => {
      const project = state.projects.find((item) => item.id === task.projectId);
      return {
        id: task.id,
        project: project?.key || task.projectId,
        status: task.status,
        owner: task.assignedAgentRole || (task.status === "user_review" ? "owner" : ""),
        cycle: task.reviewCycle || 0,
        type: task.type,
        priority: task.priority,
        parent: task.parentTaskId || "",
        title: task.title,
      };
    }), ["id", "project", "status", "owner", "cycle", "type", "priority", "parent", "title"]);
    return;
  }

  if (command === "runs") {
    const state = await readState();
    const projectFilter = args.project
      ? state.projects.find((project) => project.id === args.project || project.key === args.project)
      : null;
    if (args.project && !projectFilter) throw new Error(`Unknown project: ${args.project}`);
    const runs = (state.runs || [])
      .filter((run) => !projectFilter || run.projectId === projectFilter.id)
      .filter((run) => !args.status || run.status === args.status);
    printTable(runs.map((run) => {
      const task = state.tasks.find((item) => item.id === run.taskId);
      const project = state.projects.find((item) => item.id === run.projectId);
      return {
        id: run.id,
        project: project?.key || run.projectId,
        task: run.taskId,
        status: run.status,
        role: run.role,
        action: run.actionType,
        model: run.model || "",
        effort: run.modelReasoningEffort || "",
        attempt: run.attempt ? `${run.attempt}/${run.maxAttempts || "?"}` : "",
        thread: run.threadId || "",
        title: task?.title || "",
      };
    }), ["id", "project", "task", "status", "role", "action", "model", "effort", "attempt", "thread", "title"]);
    return;
  }

  if (command === "run-prompt") {
    const state = await readState();
    const runId = args._[1];
    const run = (state.runs || []).find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    console.log(run.prompt || "");
    return;
  }

  if (command === "add-project") {
    const trustLeadApprovals = args["no-trust-leads"]
      ? false
      : args["trust-lead-approvals"] || args.trustLeadApprovals || args["trust-leads"];
    const integrationBranch = args["integration-branch"] || args.integrationBranch || "";
    const project = await addProject({
      key: args.key,
      name: args.name,
      description: args.description,
      repoPath: expandHome(args["repo-path"] || ""),
      repoUrl: args["repo-url"],
      workflowMode: args["workflow-mode"] || "auto",
      defaultBranch: args["default-branch"] || "main",
      validationCommands: args.validation,
      contextLinks: args.context,
      standards: args.standards,
      safetyRules: args.safety,
      reviewPolicy: {
        trustLeadApprovals,
        integrationBranch,
      },
      trustLeadApprovals,
      integrationBranch,
    });
    console.log(`Added project ${project.id}: ${project.name}`);
    return;
  }

  if (command === "update-project") {
    const projectId = args._[1] || args.project;
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(args, "name")) patch.name = args.name;
    if (Object.prototype.hasOwnProperty.call(args, "description")) patch.description = args.description;
    if (Object.prototype.hasOwnProperty.call(args, "repo-path")) patch.repoPath = expandHome(args["repo-path"] || "");
    if (Object.prototype.hasOwnProperty.call(args, "repo-url")) patch.repoUrl = args["repo-url"];
    if (Object.prototype.hasOwnProperty.call(args, "workflow-mode")) patch.workflowMode = args["workflow-mode"];
    if (Object.prototype.hasOwnProperty.call(args, "default-branch")) patch.defaultBranch = args["default-branch"];
    if (Object.prototype.hasOwnProperty.call(args, "validation")) patch.validationCommands = args.validation;
    if (Object.prototype.hasOwnProperty.call(args, "context")) patch.contextLinks = args.context;
    if (Object.prototype.hasOwnProperty.call(args, "standards")) patch.standards = args.standards;
    if (Object.prototype.hasOwnProperty.call(args, "safety")) patch.safetyRules = args.safety;
    const reviewPolicy = {};
    if (Object.prototype.hasOwnProperty.call(args, "trust-leads")) reviewPolicy.trustLeadApprovals = true;
    if (Object.prototype.hasOwnProperty.call(args, "trust-lead-approvals")) reviewPolicy.trustLeadApprovals = args["trust-lead-approvals"];
    if (Object.prototype.hasOwnProperty.call(args, "no-trust-leads")) reviewPolicy.trustLeadApprovals = false;
    if (Object.prototype.hasOwnProperty.call(args, "qa-reviewer-role")) reviewPolicy.qaReviewerRole = args["qa-reviewer-role"];
    if (Object.prototype.hasOwnProperty.call(args, "integration-branch")) reviewPolicy.integrationBranch = args["integration-branch"];
    if (Object.keys(reviewPolicy).length) patch.reviewPolicy = reviewPolicy;
    if (
      Object.prototype.hasOwnProperty.call(args, "local-qa-preview")
      || Object.prototype.hasOwnProperty.call(args, "no-local-qa-preview")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-checkout")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-branch")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-stash-dirty")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-create")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-post-update")
      || Object.prototype.hasOwnProperty.call(args, "local-qa-preview-restart-agent")
    ) {
      patch.localQaPreview = args["no-local-qa-preview"] ? null : {
        enabled: booleanOption(args["local-qa-preview"], true),
        checkoutPath: expandHome(args["local-qa-preview-checkout"] || ""),
        branch: args["local-qa-preview-branch"] || args["integration-branch"] || "",
        stashDirty: booleanOption(args["local-qa-preview-stash-dirty"], false),
        createIfMissing: booleanOption(args["local-qa-preview-create"], false),
        postUpdateCommands: normalizeList(args["local-qa-preview-post-update"]),
        restartLaunchAgents: normalizeList(args["local-qa-preview-restart-agent"]),
      };
    }
    const project = await updateProject(projectId, patch);
    console.log(`Updated project ${project.id}: ${project.name}`);
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
      lane: args.lane,
      workAreas: args["work-area"] || args["work-areas"],
      parentTaskId: args.parent || args["parent-task-id"] || args.epic,
      dependsOnTaskIds: args["depends-on"] || args.dependencies,
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
    if (Object.prototype.hasOwnProperty.call(args, "type")) patch.type = args.type;
    if (Object.prototype.hasOwnProperty.call(args, "lane")) patch.lane = args.lane;
    if (Object.prototype.hasOwnProperty.call(args, "work-area")) patch.workAreas = args["work-area"];
    if (Object.prototype.hasOwnProperty.call(args, "work-areas")) patch.workAreas = args["work-areas"];
    if (Object.prototype.hasOwnProperty.call(args, "priority")) patch.priority = args.priority;
    if (Object.prototype.hasOwnProperty.call(args, "parent")) patch.parentTaskId = args.parent;
    if (Object.prototype.hasOwnProperty.call(args, "parent-task-id")) patch.parentTaskId = args["parent-task-id"];
    if (Object.prototype.hasOwnProperty.call(args, "depends-on")) patch.dependsOnTaskIds = args["depends-on"];
    if (Object.prototype.hasOwnProperty.call(args, "dependencies")) patch.dependsOnTaskIds = args.dependencies;
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

  if (command === "review") {
    const taskId = args._[1];
    const result = await recordReview(taskId, {
      stage: args.stage || args.role,
      outcome: args.outcome,
      body: args.body,
      author: args.author,
    });
    console.log(`Recorded review ${result.review.id}: ${result.review.stageKey} -> ${result.review.outcome}`);
    for (const action of result.actions || []) console.log(`- ${action}`);
    return;
  }

  if (command === "automation-tick" || command === "tick") {
    const result = await automationTick({
      project: args.project,
      limit: args.limit,
    });
    if (!result.actions.length) {
      console.log("No automation actions.");
      return;
    }
    for (const action of result.actions) console.log(`- ${action}`);
    return;
  }

  if (command === "automation-pause") {
    const pause = await setOperatorPause({
      reason: args.reason,
      author: args.author,
    });
    console.log(`StudioOps automation paused: ${pause.reason}`);
    return;
  }

  if (command === "automation-resume") {
    const pause = await resumeOperatorAutomation({
      reason: args.reason,
      author: args.author,
    });
    console.log(`StudioOps automation resumed: ${pause.resumeReason}`);
    return;
  }

  if (command === "circuit-reset") {
    const target = await resetAutomationCircuit({
      task: args.task,
      project: args.project,
      reason: args.reason,
      author: args.author,
    });
    console.log(`Reset automation circuit for ${target.id}.`);
    return;
  }

  if (command === "dispatcher" || command === "dispatch") {
    const state = await readState();
    const config = await loadConfig();
    const supervisor = createSupervisorReport(state, {
      baseUrl: args["base-url"] || "http://127.0.0.1:4317",
      intervalSeconds: args.interval || args["interval-seconds"] || 300,
    });
    const options = {
      project: args.project || args.projects,
      dryRun: args["dry-run"] || args.dryRun,
      provider: args.provider || "prompt-outbox",
      maxDispatchesPerSweep: args.limit || args["max-dispatches"],
      builderConcurrency: args["builder-concurrency"],
      reviewerConcurrency: args["reviewer-concurrency"],
      ownerConcurrency: args["owner-concurrency"],
      executionPolicy: {
        ...(config?.defaults?.executionPolicy || {}),
        ...(config?.executionPolicy || {}),
      },
    };
    if (args.plan) {
      const plan = planDispatches(state, supervisor.actions, options);
      const report = {
        generatedAt: supervisor.generatedAt,
        dryRun: true,
        runs: [],
        selected: plan.selected,
        skipped: plan.skipped,
      };
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatDispatchReport(report));
      return;
    }
    const report = await dispatchSupervisorActions(supervisor.actions, options);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatDispatchReport(report));
    return;
  }

  if (command === "runner" || command === "run") {
    const config = await loadConfig();
    const runnerDefaults = {
      ...(config?.defaults?.runner || {}),
      ...(config?.runner || {}),
    };
    const options = {
      project: args.project || args.projects,
      limit: args.limit || args["max-runs"],
      provider: args.provider || process.env.MISSION_CONTROL_RUNNER_PROVIDER || runnerDefaults.provider,
      codexBin: args["codex-bin"],
      model: args.model || process.env.MISSION_CONTROL_RUNNER_MODEL || runnerDefaults.model || "gpt-5.6-sol",
      modelReasoningEffort: args["model-reasoning-effort"] || args.reasoning || process.env.MISSION_CONTROL_RUNNER_REASONING_EFFORT || runnerDefaults.modelReasoningEffort || "high",
      executionPolicy: {
        ...(config?.defaults?.executionPolicy || {}),
        ...(config?.executionPolicy || {}),
      },
      useWorkspaces: args["no-workspace"] ? false : args.workspaces,
      workspaceRoot: args["workspace-root"],
      timeoutMs: args["timeout-ms"],
      githubAppAuth: args["no-github-app-auth"] ? false : args["github-app-auth"],
      githubAppCredentialsDir: args["github-apps-dir"],
    };
    if (args.plan || args["dry-run"] || args.dryRun) {
      const state = await readState();
      const plan = planRunnableRuns(state, options);
      if (args.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(formatRunnerPlan(plan));
      return;
    }
    const report = await runQueuedRuns(options);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatRunnerReport(report));
    return;
  }

  if (command === "notifier" || command === "notify") {
    const report = await sendPendingNotifications({
      project: args.project || args.projects,
      limit: args.limit || args["max-notifications"],
      dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatNotificationReport(report));
    return;
  }

  if (command === "self-update") {
    const config = await loadConfig();
    const defaults = {
      ...(config?.defaults?.selfUpdate || {}),
      ...(config?.selfUpdate || {}),
    };
    const report = await runSelfUpdate({
      repoPath: args.repo || args["repo-path"] || defaults.repoPath || process.cwd(),
      remote: args.remote || defaults.remote,
      branch: args.branch || defaults.branch || defaults.defaultBranch,
      staleRunMs: args["stale-run-ms"] || defaults.staleRunMs,
      restartAgentLabels: args.agents || args["restart-agents"] || defaults.restartAgentLabels || defaults.agents,
      restartAgents: args["no-restart"] ? false : booleanOption(args.restart || defaults.restartAgents, true),
      commentTaskId: args.task || args["task-id"] || defaults.commentTaskId || defaults.taskId,
      notify: args["no-notify"] ? false : booleanOption(args.notify || defaults.notify, false),
      recordNoop: booleanOption(args["record-noop"] || defaults.recordNoop, false),
      dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
      checkPids: args["check-pids"] ? true : booleanOption(defaults.checkPids, false),
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatSelfUpdateReport(report));
    return;
  }

  if (command === "qa-integrate" || command === "qa-integration") {
    const options = {
      project: args.project || args.projects,
      task: args.task || args.tasks || args["task-id"],
      dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
      force: Boolean(args.force || args.reintegrate),
      validationTimeoutMs: args["validation-timeout-ms"],
      githubAppAuth: args["no-github-app-auth"] ? false : args["github-app-auth"],
      githubAppCredentialsDir: args["github-apps-dir"],
      githubAppRole: args["github-app-role"],
      githubAppDefaultRole: args["github-app-default-role"],
    };
    if (args.plan || args["dry-run"] || args.dryRun) {
      const state = await readState();
      const plan = planQaIntegrations(state, options);
      if (args.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(formatQaIntegrationReport(plan));
      return;
    }
    const report = await runQaIntegration(options);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatQaIntegrationReport(report));
    return;
  }

  if (command === "promote" || command === "promotion") {
    const config = await loadConfig();
    const defaults = {
      ...(config?.defaults?.promotion || {}),
      ...(config?.promotion || {}),
    };
    const options = {
      project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
      task: args.task || args.tasks || args["task-id"],
      dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
      validationTimeoutMs: args["validation-timeout-ms"] || defaults.validationTimeoutMs,
      promotionWorkspaceRoot: args["workspace-root"] || defaults.workspaceRoot,
      githubAppAuth: args["no-github-app-auth"] ? false : (args["github-app-auth"] || defaults.githubAppAuth),
      githubAppCredentialsDir: args["github-apps-dir"] || defaults.githubAppCredentialsDir,
      githubAppRole: args["github-app-role"] || defaults.githubAppRole || "promotion-worker",
      githubAppDefaultRole: args["github-app-default-role"] || defaults.githubAppDefaultRole,
    };
    if (args.plan || args["dry-run"] || args.dryRun) {
      const state = await readState();
      const plan = planPromotions(state, options);
      if (args.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(formatPromotionReport(plan));
      return;
    }
    const report = await runPromotion(options);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatPromotionReport(report));
    return;
  }

  if (command === "update-run") {
    const runId = args._[1];
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(args, "status")) patch.status = args.status;
    if (Object.prototype.hasOwnProperty.call(args, "thread")) patch.threadId = args.thread;
    if (Object.prototype.hasOwnProperty.call(args, "thread-id")) patch.threadId = args["thread-id"];
    if (Object.prototype.hasOwnProperty.call(args, "notes")) patch.notes = args.notes;
    if (Object.prototype.hasOwnProperty.call(args, "provider")) patch.provider = args.provider;
    const run = await updateRun(runId, patch);
    console.log(`Updated ${run.id}: ${run.status}`);
    return;
  }

  if (command === "supervisor") {
    const state = await readState();
    const report = createSupervisorReport(state, {
      baseUrl: args["base-url"] || "http://127.0.0.1:4317",
      includeWaiting: args.all || args["include-waiting"],
      intervalSeconds: args.interval || args["interval-seconds"] || 300,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatSupervisorReport(report));
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
