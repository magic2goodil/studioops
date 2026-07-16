import { mkdir, readFile, writeFile, copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./config.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "mission-control.json");
const EXAMPLE_FILE = path.join(DATA_DIR, "mission-control.example.json");

const VALID_STATUSES = new Set([
  "idea",
  "ready",
  "queued",
  "in_progress",
  "blocked",
  "builder_review",
  "needs_changes",
  "user_review",
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

export { DATA_FILE, VALID_STATUSES };

export async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!(await fileExists(DATA_FILE))) {
    await copyFile(EXAMPLE_FILE, DATA_FILE);
  }
}

export async function readState() {
  await ensureDataFile();
  return JSON.parse(await readFile(DATA_FILE, "utf8"));
}

export async function writeState(state) {
  const now = new Date().toISOString();
  state.meta = state.meta || {};
  state.meta.updatedAt = now;
  const tmpFile = `${DATA_FILE}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpFile, DATA_FILE);
}

function nextId(items, prefix) {
  const max = items
    .map((item) => String(item.id || ""))
    .filter((id) => id.startsWith(`${prefix}_`))
    .map((id) => Number(id.split("_")[1]))
    .filter(Number.isFinite)
    .reduce((highest, value) => Math.max(highest, value), 0);
  return `${prefix}_${max + 1}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferAttachmentType(value) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(String(value || "")) ? "image" : "reference";
}

function normalizeAttachments(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          const trimmed = item.trim();
          return {
            label: trimmed,
            url: trimmed,
            type: inferAttachmentType(trimmed),
            note: "",
          };
        }
        const url = String(item.url || item.path || "").trim();
        const label = String(item.label || url || "Attachment").trim();
        return {
          label,
          url,
          type: String(item.type || inferAttachmentType(url || label)).trim(),
          note: String(item.note || "").trim(),
        };
      })
      .filter((item) => item.label || item.url || item.note);
  }

  return normalizeList(value).map((item) => ({
    label: item,
    url: item,
    type: inferAttachmentType(item),
    note: "",
  }));
}

function renderAttachments(attachments) {
  return (attachments || []).length
    ? attachments
        .map((item) => {
          const label = item.label || item.url || "Attachment";
          const url = item.url && item.url !== label ? `: ${item.url}` : "";
          const note = item.note ? ` - ${item.note}` : "";
          return `- [${item.type || "reference"}] ${label}${url}${note}`;
        })
        .join("\n")
    : "- None recorded.";
}

export async function addProject(input) {
  const state = await readState();
  const now = new Date().toISOString();
  const key = String(input.key || "").trim();
  if (!key) throw new Error("Project key is required.");
  if (state.projects.some((project) => project.key === key)) {
    throw new Error(`Project key already exists: ${key}`);
  }
  const project = {
    id: nextId(state.projects, "project"),
    key,
    name: String(input.name || key).trim(),
    description: String(input.description || "").trim(),
    repoPath: String(input.repoPath || "").trim(),
    repoUrl: String(input.repoUrl || "").trim(),
    defaultBranch: String(input.defaultBranch || "main").trim(),
    validationCommands: normalizeList(input.validationCommands),
    contextLinks: normalizeList(input.contextLinks),
    safetyRules: normalizeList(input.safetyRules),
    createdAt: now,
    updatedAt: now,
  };
  state.projects.push(project);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "project_created",
    projectId: project.id,
    message: `Project created: ${project.name}`,
    createdAt: now,
  });
  await writeState(state);
  return project;
}

export async function addTask(input) {
  const state = await readState();
  const now = new Date().toISOString();
  const project = findProject(state, input.project || input.projectId);
  if (!project) throw new Error(`Unknown project: ${input.project || input.projectId}`);
  const status = input.status || "idea";
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Task title is required.");
  const task = {
    id: nextId(state.tasks, "task"),
    projectId: project.id,
    title,
    description: String(input.description || "").trim(),
    status,
    priority: String(input.priority || "medium").trim(),
    type: String(input.type || "feature").trim(),
    area: String(input.area || "").trim(),
    userStory: String(input.userStory || input.story || "").trim(),
    expectedOutcome: String(input.expectedOutcome || input.expected || "").trim(),
    attachments: normalizeAttachments(input.attachments || input.attachment),
    acceptanceCriteria: normalizeList(input.acceptanceCriteria),
    privacyNotes: String(input.privacyNotes || "").trim(),
    securityNotes: String(input.securityNotes || "").trim(),
    branchName: String(input.branchName || "").trim(),
    prUrl: String(input.prUrl || "").trim(),
    assignedAgentRole: String(input.assignedAgentRole || "").trim(),
    assignedThreadId: String(input.assignedThreadId || "").trim(),
    reviewerThreadId: String(input.reviewerThreadId || "").trim(),
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "task_created",
    projectId: project.id,
    taskId: task.id,
    message: `Task created: ${task.title}`,
    createdAt: now,
  });
  await writeState(state);
  return task;
}

export async function updateTask(taskId, patch) {
  const state = await readState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`Invalid status: ${patch.status}`);
  }
  const allowed = [
    "title",
    "description",
    "status",
    "priority",
    "type",
    "area",
    "userStory",
    "expectedOutcome",
    "privacyNotes",
    "securityNotes",
    "branchName",
    "prUrl",
    "assignedAgentRole",
    "assignedThreadId",
    "reviewerThreadId",
  ];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      task[key] = String(patch[key] || "").trim();
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "acceptanceCriteria")) {
    task.acceptanceCriteria = normalizeList(patch.acceptanceCriteria);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "attachments")) {
    task.attachments = normalizeAttachments(patch.attachments);
  }
  task.updatedAt = new Date().toISOString();
  state.events.push({
    id: nextId(state.events, "event"),
    type: "task_updated",
    projectId: task.projectId,
    taskId: task.id,
    message: `Task updated: ${task.title}`,
    createdAt: task.updatedAt,
  });
  await writeState(state);
  return task;
}

export async function addComment(taskId, body, author = "user") {
  const state = await readState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const now = new Date().toISOString();
  const comment = {
    id: nextId(state.comments, "comment"),
    taskId,
    author,
    body: String(body || "").trim(),
    createdAt: now,
  };
  if (!comment.body) throw new Error("Comment body is required.");
  state.comments.push(comment);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "comment_created",
    projectId: task.projectId,
    taskId,
    message: `Comment added to ${task.title}`,
    createdAt: now,
  });
  await writeState(state);
  return comment;
}

export function findProject(state, keyOrId) {
  if (!keyOrId) return null;
  return state.projects.find((project) => project.id === keyOrId || project.key === keyOrId) || null;
}

export function findTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

export function taskWithProject(state, task) {
  return {
    ...task,
    project: state.projects.find((project) => project.id === task.projectId) || null,
    comments: state.comments.filter((comment) => comment.taskId === task.id),
    runs: state.runs.filter((run) => run.taskId === task.id),
    reviews: state.reviews.filter((review) => review.taskId === task.id),
  };
}

export function generatePrompt(state, taskId, role = "builder") {
  const task = findTask(state, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const project = findProject(state, task.projectId);
  if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
  const criteria = (task.acceptanceCriteria || []).map((item) => `- ${item}`).join("\n") || "- No acceptance criteria recorded yet.";
  const attachments = renderAttachments(task.attachments);
  const validation = (project.validationCommands || []).map((item) => `- \`${item}\``).join("\n") || "- No validation command recorded.";
  const safety = (project.safetyRules || []).map((item) => `- ${item}`).join("\n") || "- No project-specific safety rules recorded.";
  const context = (project.contextLinks || []).map((item) => `- ${item}`).join("\n") || "- README.md";

  if (role === "reviewer") {
    return `You are the team-lead reviewer for Mission Control task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Feature branch: ${task.branchName || "(not recorded)"}
PR: ${task.prUrl || "(not recorded)"}

Task:
${task.title}

Description:
${task.description || "(none)"}

User story:
${task.userStory || "(not recorded)"}

Expected outcome:
${task.expectedOutcome || "(not recorded)"}

Visual/context attachments:
${attachments}

Acceptance criteria:
${criteria}

Project safety rules:
${safety}

Review instructions:
- Review as a senior engineer.
- Lead with concrete findings ordered by severity.
- Check scope, behavior, tests, security, privacy, and maintainability.
- Confirm whether the acceptance criteria are met.
- Confirm the task has branch/PR context and builder notes when implementation work was done.
- If it is not ready for the human owner, mark what needs to change.
- If it is ready, summarize validation and remaining risk clearly.
`;
  }

  return `You are the builder for Mission Control task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Default branch: ${project.defaultBranch || "main"}
Suggested branch: ${task.branchName || `codex/${project.key}-${task.id}-${slugify(task.title)}`}

Before editing:
- Read project context:
${context}
- Follow project safety rules:
${safety}

Task:
${task.title}

Description:
${task.description || "(none)"}

User story:
${task.userStory || "(not recorded)"}

Expected outcome:
${task.expectedOutcome || "(not recorded)"}

Visual/context attachments:
${attachments}

Acceptance criteria:
${criteria}

Validation commands:
${validation}

Builder instructions:
- Create or switch to the feature branch.
- For UI or bug tasks, inspect referenced images, screenshots, and mockups before editing.
- Keep changes scoped to this task.
- Do not commit secrets, private customer data, or unrelated refactors.
- Run validation before reporting ready.
- Commit and push only if the user/project workflow asks for that.
- Link the feature branch and pull request on the task when available.
- Add a task comment with changed files, validation results, known gaps, PR link, and next review step.
`;
}

function slugify(value) {
  return String(value || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}
