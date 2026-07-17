import { mkdir, readFile, writeFile, copyFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./config.js";
import {
  branchWebUrl,
  integrationBranchName,
  integrationBranchSafetyError,
  projectUsesTrustLeadQa,
  trustLeadApprovalsEnabled,
} from "./integration-policy.js";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "mission-control.json");
const EXAMPLE_FILE = path.join(DATA_DIR, "mission-control.example.json");
const LOCK_DIR = path.join(DATA_DIR, ".mission-control.lock");
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

const VALID_STATUSES = new Set([
  "idea",
  "ready",
  "queued",
  "in_progress",
  "blocked",
  "builder_review",
  "backend_review",
  "frontend_review",
  "accessibility_review",
  "lead_review",
  "qa_review",
  "needs_changes",
  "user_review",
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

const VALID_REVIEW_OUTCOMES = new Set([
  "approved",
  "changes_requested",
  "skipped",
]);

const REVIEW_COMPLETE_OUTCOMES = new Set([
  "approved",
  "skipped",
]);

const VALID_RUN_STATUSES = new Set([
  "queued",
  "running",
  "notified",
  "completed",
  "failed",
  "cancelled",
]);

const DEPENDENCY_COMPLETE_STATUSES = new Set([
  "approved",
  "merged",
  "deployed",
  "done",
  "closed",
]);

const DEFAULT_REVIEW_PIPELINE = [
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
];

const DEFAULT_REVIEW_POLICY = {
  maxBuilderReviewCycles: 2,
  reviewerMayFixSmallIssues: true,
  leadOwnsFinalDecisionAtLimit: true,
  trustLeadApprovals: false,
  qaReviewerRole: "qa-reviewer",
  integrationBranch: "",
};

export {
  DATA_FILE,
  VALID_STATUSES,
  VALID_REVIEW_OUTCOMES,
  VALID_RUN_STATUSES,
  DEFAULT_REVIEW_PIPELINE,
  DEFAULT_REVIEW_POLICY,
};

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
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpFile, DATA_FILE);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireStateLock() {
  await mkdir(DATA_DIR, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(path.join(LOCK_DIR, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(LOCK_DIR);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for Mission Control data lock.");
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseStateLock() {
  await rm(LOCK_DIR, { recursive: true, force: true });
}

export async function mutateState(mutator) {
  await acquireStateLock();
  try {
    const state = await readState();
    const result = await mutator(state);
    await writeState(state);
    return result;
  } finally {
    await releaseStateLock();
  }
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
  if (Array.isArray(value)) return [...new Set(value.map(String).filter(Boolean))];
  if (!value) return [];
  return [...new Set(String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
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

function standardReference(item) {
  const value = String(item || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value) || /^[a-z]+:\/\//i.test(value)) return value;
  return path.join(process.cwd(), value);
}

function normalizeReviewPipeline(value) {
  if (!Array.isArray(value)) return [];
  const stages = value
    .map((stage) => ({
      key: String(stage.key || "").trim(),
      label: String(stage.label || stage.key || "").trim(),
      role: String(stage.role || stage.key || "").trim(),
      status: String(stage.status || "").trim(),
      required: stage.required !== false,
      description: String(stage.description || "").trim(),
    }))
    .filter((stage) => stage.key && stage.role);
  return reviewStagesWithDefaultAccessibility(stages);
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

function normalizeReviewPolicy(value = {}) {
  const maxCycles = Number(value.maxBuilderReviewCycles ?? value.maxReviewCycles ?? DEFAULT_REVIEW_POLICY.maxBuilderReviewCycles);
  return {
    maxBuilderReviewCycles: Number.isFinite(maxCycles) ? Math.max(1, Math.floor(maxCycles)) : DEFAULT_REVIEW_POLICY.maxBuilderReviewCycles,
    reviewerMayFixSmallIssues: normalizeBoolean(value.reviewerMayFixSmallIssues, DEFAULT_REVIEW_POLICY.reviewerMayFixSmallIssues),
    leadOwnsFinalDecisionAtLimit: normalizeBoolean(value.leadOwnsFinalDecisionAtLimit, DEFAULT_REVIEW_POLICY.leadOwnsFinalDecisionAtLimit),
    trustLeadApprovals: normalizeBoolean(value.trustLeadApprovals ?? value.trustLeads, DEFAULT_REVIEW_POLICY.trustLeadApprovals),
    qaReviewerRole: String(value.qaReviewerRole || DEFAULT_REVIEW_POLICY.qaReviewerRole).trim(),
    integrationBranch: String(value.integrationBranch || value.reviewBranch || "").trim(),
  };
}

function reviewPolicyInputForProject(input = {}) {
  const reviewPolicy = { ...(input.reviewPolicy || {}) };
  if (
    !Object.prototype.hasOwnProperty.call(reviewPolicy, "trustLeadApprovals")
    && !Object.prototype.hasOwnProperty.call(reviewPolicy, "trustLeads")
    && Object.prototype.hasOwnProperty.call(input, "trustLeadApprovals")
  ) {
    reviewPolicy.trustLeadApprovals = input.trustLeadApprovals;
  }
  if (
    !Object.prototype.hasOwnProperty.call(reviewPolicy, "integrationBranch")
    && !Object.prototype.hasOwnProperty.call(reviewPolicy, "reviewBranch")
    && Object.prototype.hasOwnProperty.call(input, "integrationBranch")
  ) {
    reviewPolicy.integrationBranch = input.integrationBranch;
  }
  return reviewPolicy;
}

export async function addProject(input) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    const key = String(input.key || "").trim();
    if (!key) throw new Error("Project key is required.");
    if (state.projects.some((project) => project.key === key)) {
      throw new Error(`Project key already exists: ${key}`);
    }
    const reviewPolicy = normalizeReviewPolicy(reviewPolicyInputForProject(input));
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
      standards: normalizeList(input.standards),
      safetyRules: normalizeList(input.safetyRules),
      reviewPipeline: normalizeReviewPipeline(input.reviewPipeline),
      reviewPolicy,
      trustLeadApprovals: reviewPolicy.trustLeadApprovals,
      integrationBranch: reviewPolicy.integrationBranch,
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
    return project;
  });
}

export async function updateProject(projectId, patch = {}) {
  return mutateState(async (state) => {
    const project = findProject(state, projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const now = new Date().toISOString();
    const allowed = [
      "name",
      "description",
      "repoPath",
      "repoUrl",
      "defaultBranch",
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        project[key] = String(patch[key] || "").trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "validationCommands")) {
      project.validationCommands = normalizeList(patch.validationCommands);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "contextLinks")) {
      project.contextLinks = normalizeList(patch.contextLinks);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "standards")) {
      project.standards = normalizeList(patch.standards);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "safetyRules")) {
      project.safetyRules = normalizeList(patch.safetyRules);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "reviewPipeline")) {
      project.reviewPipeline = normalizeReviewPipeline(patch.reviewPipeline);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "reviewPolicy")) {
      project.reviewPolicy = normalizeReviewPolicy({
        ...(project.reviewPolicy || {}),
        ...(patch.reviewPolicy || {}),
      });
      project.trustLeadApprovals = project.reviewPolicy.trustLeadApprovals;
      project.integrationBranch = project.reviewPolicy.integrationBranch;
    }
    project.updatedAt = now;
    state.events.push({
      id: nextId(state.events, "event"),
      type: "project_updated",
      projectId: project.id,
      message: `Project updated: ${project.name}`,
      createdAt: now,
    });
    return project;
  });
}

export async function addTask(input) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    const project = findProject(state, input.project || input.projectId);
    if (!project) throw new Error(`Unknown project: ${input.project || input.projectId}`);
    const status = input.status || "idea";
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const title = String(input.title || "").trim();
    if (!title) throw new Error("Task title is required.");
    const parentTaskId = String(input.parentTaskId || input.parent || input.epic || "").trim();
    const dependsOnTaskIds = normalizeList(input.dependsOnTaskIds || input.dependsOn || input.dependencies);
    validateTaskRelationships(state, "", parentTaskId, dependsOnTaskIds);
    const task = {
      id: nextId(state.tasks, "task"),
      projectId: project.id,
      title,
      description: String(input.description || "").trim(),
      status,
      priority: String(input.priority || "medium").trim(),
      type: String(input.type || "feature").trim(),
      area: String(input.area || "").trim(),
      lane: String(input.lane || "").trim(),
      workAreas: normalizeList(input.workAreas || input.workArea || input["work-area"]),
      parentTaskId,
      dependsOnTaskIds,
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
      reviewCycle: 0,
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
    return task;
  });
}

export async function updateTask(taskId, patch) {
  return mutateState(async (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (patch.status && !VALID_STATUSES.has(patch.status)) {
      throw new Error(`Invalid status: ${patch.status}`);
    }
    const previousStatus = task.status;
    const allowed = [
      "title",
      "description",
      "status",
      "priority",
      "type",
      "area",
      "lane",
      "parentTaskId",
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
    if (Object.prototype.hasOwnProperty.call(patch, "dependsOnTaskIds")) {
      task.dependsOnTaskIds = normalizeList(patch.dependsOnTaskIds);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "workAreas")) {
      task.workAreas = normalizeList(patch.workAreas);
    }
    validateTaskRelationships(state, task.id, task.parentTaskId, task.dependsOnTaskIds || []);
    if (Object.prototype.hasOwnProperty.call(patch, "attachments")) {
      task.attachments = normalizeAttachments(patch.attachments);
    }
    if (patch.status === "builder_review" && previousStatus !== "builder_review") {
      task.reviewCycle = Number(task.reviewCycle || 0) + 1;
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
    return task;
  });
}

export async function addComment(taskId, body, author = "user") {
  return mutateState(async (state) => {
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
    return comment;
  });
}

export async function recordReview(taskId, input = {}) {
  return mutateState(async (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const project = findProject(state, task.projectId);
    if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
    const stages = reviewStagesForProject(project);
    const stage = findReviewStage(stages, input.stage || input.stageKey || input.role || task.status);
    if (!stage) throw new Error(`Unknown review stage: ${input.stage || input.stageKey || input.role || task.status}`);
    const outcome = String(input.outcome || "").trim();
    if (!VALID_REVIEW_OUTCOMES.has(outcome)) {
      throw new Error(`Invalid review outcome: ${outcome}`);
    }
    const now = new Date().toISOString();
    const review = {
      id: nextId(state.reviews, "review"),
      taskId,
      projectId: task.projectId,
      cycle: currentReviewCycle(task),
      stageKey: stage.key,
      status: stage.status,
      role: stage.role,
      outcome,
      author: String(input.author || stage.role || "reviewer").trim(),
      body: String(input.body || "").trim(),
      createdAt: now,
    };
    state.reviews.push(review);
    state.comments.push({
      id: nextId(state.comments, "comment"),
      taskId,
      author: review.author,
      body: `Review ${stage.label || stage.key}: ${outcome}${review.body ? `\n\n${review.body}` : ""}`,
      createdAt: now,
    });
    if (outcome === "changes_requested") {
      const actions = routeChangesRequestedInState(state, task, project, stage, now, "Mission Control Automation", []);
      state.events.push({
        id: nextId(state.events, "event"),
        type: "review_changes_requested",
        projectId: task.projectId,
        taskId,
        message: `${stage.label || stage.key} requested changes for ${task.title}`,
        createdAt: now,
      });
      return { review, actions };
    }
    const actions = advanceTaskWorkflowInState(state, task, {
      now,
      author: "Mission Control Automation",
      reason: `${stage.key} review ${outcome}`,
    });
    state.events.push({
      id: nextId(state.events, "event"),
      type: "review_recorded",
      projectId: task.projectId,
      taskId,
      message: `${stage.label || stage.key} review recorded for ${task.title}`,
      createdAt: now,
    });
    return { review, actions };
  });
}

export async function automationTick(input = {}) {
  return mutateState(async (state) => {
    const now = new Date().toISOString();
    const project = input.project || input.projectId ? findProject(state, input.project || input.projectId) : null;
    if ((input.project || input.projectId) && !project) throw new Error(`Unknown project: ${input.project || input.projectId}`);
    const parsedLimit = Number(input.limit || 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 10;
    const actions = [];
    const candidates = state.tasks
      .filter((task) => !project || task.projectId === project.id)
      .filter((task) => !["done", "closed", "deployed", "merged", "qa_review", "user_review", "approved"].includes(task.status))
      .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));

    for (const task of candidates) {
      if (actions.length >= limit) break;
      const before = `${task.status}|${task.assignedAgentRole || ""}|${task.reviewCycle || 0}`;
      const taskActions = advanceTaskWorkflowInState(state, task, {
        now,
        author: "Mission Control Automation",
        reason: "automation tick",
      });
      const after = `${task.status}|${task.assignedAgentRole || ""}|${task.reviewCycle || 0}`;
      if (taskActions.length || before !== after) {
        actions.push(...taskActions);
      }
    }

    state.events.push({
      id: nextId(state.events, "event"),
      type: "automation_tick",
      projectId: project?.id || "",
      message: `Automation tick completed with ${actions.length} action(s).`,
      createdAt: now,
    });
    return { actions };
  });
}

export async function updateRun(runId, patch = {}) {
  return mutateState(async (state) => {
    state.runs = state.runs || [];
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (patch.status && !VALID_RUN_STATUSES.has(patch.status)) {
      throw new Error(`Invalid run status: ${patch.status}`);
    }
    const allowed = [
      "status",
      "threadId",
      "notes",
      "provider",
      "outputPath",
      "lastMessagePath",
      "startedAt",
      "completedAt",
      "exitCode",
      "runnerPid",
      "externalNotifiedAt",
      "failureNotifiedAt",
      "notificationStatus",
      "notificationChannel",
      "notificationError",
      "notificationFailedAt",
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        run[key] = String(patch[key] || "").trim();
      }
    }
    run.updatedAt = new Date().toISOString();
    state.events = state.events || [];
    state.events.push({
      id: nextId(state.events, "event"),
      type: "run_updated",
      projectId: run.projectId || "",
      taskId: run.taskId || "",
      message: `${run.id} updated to ${run.status}`,
      createdAt: run.updatedAt,
    });
    return run;
  });
}

export function findProject(state, keyOrId) {
  if (!keyOrId) return null;
  return state.projects.find((project) => project.id === keyOrId || project.key === keyOrId) || null;
}

export function findTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

function validateTaskRelationships(state, taskId, parentTaskId, dependsOnTaskIds) {
  if (parentTaskId) {
    if (parentTaskId === taskId) throw new Error("A task cannot be its own parent.");
    if (!findTask(state, parentTaskId)) throw new Error(`Unknown parent task: ${parentTaskId}`);
    const seen = new Set([taskId]);
    let currentParentId = parentTaskId;
    while (currentParentId) {
      if (seen.has(currentParentId)) throw new Error("Task parent relationship would create a cycle.");
      seen.add(currentParentId);
      currentParentId = findTask(state, currentParentId)?.parentTaskId || "";
    }
  }
  for (const dependencyId of dependsOnTaskIds || []) {
    if (dependencyId === taskId) throw new Error("A task cannot depend on itself.");
    if (!findTask(state, dependencyId)) throw new Error(`Unknown dependency task: ${dependencyId}`);
  }
}

function stageSearchText(stage) {
  return [
    stage?.key,
    stage?.status,
    stage?.role,
    stage?.label,
  ].map((item) => String(item || "").toLowerCase().replaceAll("_", "-")).join(" ");
}

function isAccessibilityReviewStage(stage) {
  const text = stageSearchText(stage);
  return text.includes("accessibility") || text.includes("a11y");
}

function isFrontendReviewStage(stage) {
  return stageSearchText(stage).includes("frontend");
}

function reviewStagesWithDefaultAccessibility(stages) {
  if (!Array.isArray(stages) || !stages.length) return DEFAULT_REVIEW_PIPELINE;
  if (stages.some(isAccessibilityReviewStage) || !stages.some(isFrontendReviewStage)) return stages;
  const leadIndex = stages.findIndex(isLeadReviewStage);
  if (leadIndex === -1) return stages;
  const accessibilityStage = DEFAULT_REVIEW_PIPELINE.find((stage) => stage.key === "accessibility");
  return [
    ...stages.slice(0, leadIndex),
    { ...accessibilityStage },
    ...stages.slice(leadIndex),
  ];
}

export function reviewStagesForProject(project) {
  return reviewStagesWithDefaultAccessibility(project?.reviewPipeline || []);
}

export function reviewPolicyForProject(project) {
  return normalizeReviewPolicy(project?.reviewPolicy || {});
}

function findReviewStage(stages, value) {
  const normalized = String(value || "").toLowerCase().replaceAll("_", "-");
  return stages.find((stage) => {
    const keys = [
      stage.key,
      stage.status,
      stage.role,
      stage.label,
    ].map((item) => String(item || "").toLowerCase().replaceAll("_", "-"));
    return keys.includes(normalized) || keys.some((item) => item && normalized.includes(item));
  }) || null;
}

function currentReviewCycle(task) {
  return Number(task.reviewCycle || 0);
}

function latestReviewForStage(state, task, stage) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => Number(review.cycle || 0) === currentReviewCycle(task))
    .filter((review) => review.stageKey === stage.key || review.status === stage.status || review.role === stage.role)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function isLeadReviewStage(stage) {
  const key = String(stage?.key || "").toLowerCase();
  const role = String(stage?.role || "").toLowerCase();
  return key === "lead" || role.includes("lead");
}

function leadReviewStageForProject(project) {
  const stages = reviewStagesForProject(project);
  return stages.find(isLeadReviewStage) || stages[stages.length - 1] || null;
}

function reviewCycleAtLimit(project, task) {
  return currentReviewCycle(task) >= reviewPolicyForProject(project).maxBuilderReviewCycles;
}

function changeRequestedReviewsForCycle(state, task) {
  return (state.reviews || [])
    .filter((review) => review.taskId === task.id)
    .filter((review) => Number(review.cycle || 0) === currentReviewCycle(task))
    .filter((review) => review.outcome === "changes_requested");
}

function leadReviewCompleteForCycle(state, task, project) {
  const leadStage = leadReviewStageForProject(project);
  if (!leadStage) return false;
  const latestReview = latestReviewForStage(state, task, leadStage);
  return latestReview && REVIEW_COMPLETE_OUTCOMES.has(latestReview.outcome);
}

function shouldEscalateChangesToLead(project, task, stage) {
  const policy = reviewPolicyForProject(project);
  return policy.leadOwnsFinalDecisionAtLimit
    && reviewCycleAtLimit(project, task)
    && !isLeadReviewStage(stage)
    && leadReviewStageForProject(project);
}

function dependencyTasks(state, task) {
  return (task.dependsOnTaskIds || [])
    .map((id) => findTask(state, id))
    .filter(Boolean);
}

function incompleteDependencies(state, task) {
  return dependencyTasks(state, task).filter((dependency) => !DEPENDENCY_COMPLETE_STATUSES.has(dependency.status));
}

function addAutomationComment(state, task, body, now, author = "Mission Control Automation") {
  const exists = (state.comments || []).some((comment) => (
    comment.taskId === task.id
    && comment.author === author
    && comment.body === body
  ));
  if (exists) return false;
  state.comments.push({
    id: nextId(state.comments, "comment"),
    taskId: task.id,
    author,
    body,
    createdAt: now,
  });
  return true;
}

function setTaskWorkflowState(state, task, patch, now) {
  const previousStatus = task.status;
  for (const [key, value] of Object.entries(patch)) {
    task[key] = value;
  }
  if (patch.status === "builder_review" && previousStatus !== "builder_review") {
    task.reviewCycle = Number(task.reviewCycle || 0) + 1;
  }
  task.updatedAt = now;
  state.events.push({
    id: nextId(state.events, "event"),
    type: "workflow_state_changed",
    projectId: task.projectId,
    taskId: task.id,
    message: `Task moved to ${task.status}: ${task.title}`,
    createdAt: now,
  });
}

function moveTaskToOwnerReview(state, task, now, author, body, actions, actionLabel = "ready for owner review") {
  if (task.status !== "user_review" || task.assignedAgentRole !== "owner") {
    setTaskWorkflowState(state, task, {
      status: "user_review",
      assignedAgentRole: "owner",
      reviewerThreadId: "",
    }, now);
  }
  addAutomationComment(state, task, body, now, author);
  state.events.push({
    id: nextId(state.events, "event"),
    type: "owner_review_requested",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title} is ready for human owner review.`,
    createdAt: now,
  });
  actions.push(`${task.id}: ${actionLabel}`);
  return actions;
}

function moveTaskToQaReview(state, task, project, now, author, body, actions, actionLabel = "ready for QA review") {
  const policy = reviewPolicyForProject(project);
  const integrationBranch = integrationBranchName(project);
  const integrationBranchUrl = branchWebUrl(project, integrationBranch);
  if (task.status !== "qa_review" || task.assignedAgentRole !== (policy.qaReviewerRole || "qa-reviewer")) {
    setTaskWorkflowState(state, task, {
      status: "qa_review",
      assignedAgentRole: policy.qaReviewerRole || "qa-reviewer",
      reviewerThreadId: "",
      integrationStatus: task.integrationStatus || "pending",
      integrationBranch,
      integrationBranchUrl,
    }, now);
  }
  addAutomationComment(
    state,
    task,
    `${body} Lead-approved work can be merged into ${integrationBranch} for local QA.${integrationBranchUrl ? `\n\nIntegration branch: ${integrationBranchUrl}` : ""}`,
    now,
    author,
  );
  state.events.push({
    id: nextId(state.events, "event"),
    type: "qa_review_requested",
    projectId: task.projectId,
    taskId: task.id,
    message: `${task.title} is ready for QA integration.`,
    createdAt: now,
  });
  actions.push(`${task.id}: ${actionLabel}`);
  return actions;
}

function moveTaskAfterReviewsComplete(state, task, project, now, author, body, actions) {
  if (projectUsesTrustLeadQa(project)) {
    return moveTaskToQaReview(state, task, project, now, author, body, actions, "ready for QA integration");
  }

  if (trustLeadApprovalsEnabled(project)) {
    const reason = integrationBranchSafetyError(project);
    if (reason) {
      addAutomationComment(
        state,
        task,
        `Trust Leads QA integration is enabled, but this project is not eligible for QA branch routing: ${reason} Routing to human owner review without touching an integration branch.`,
        now,
        author,
      );
    }
  }

  return moveTaskToOwnerReview(state, task, now, author, body, actions);
}

function routeChangesRequestedInState(state, task, project, stage, now, author, actions) {
  const policy = reviewPolicyForProject(project);
  const stageLabel = stage.label || stage.key;

  if (policy.leadOwnsFinalDecisionAtLimit && reviewCycleAtLimit(project, task)) {
    const leadStage = leadReviewStageForProject(project);
    if (leadStage && !isLeadReviewStage(stage)) {
      setTaskWorkflowState(state, task, {
        status: leadStage.status,
        assignedAgentRole: leadStage.role,
        reviewerThreadId: "",
      }, now);
      addAutomationComment(
        state,
        task,
        `${stageLabel} requested changes on review cycle ${currentReviewCycle(task)}, which reached the configured ${policy.maxBuilderReviewCycles}-cycle builder review limit. Routing to ${leadStage.label || leadStage.key} for final decision instead of sending this back into another builder loop.`,
        now,
        author,
      );
      actions.push(`${task.id}: review cycle limit reached, routed to ${leadStage.role}`);
      return actions;
    }

    if (isLeadReviewStage(stage)) {
      return moveTaskToOwnerReview(
        state,
        task,
        now,
        author,
        `${stageLabel} requested changes after the configured ${policy.maxBuilderReviewCycles}-cycle builder review limit. Human owner review is required for the final call; this was not auto-approved.`,
        actions,
        "lead requested human owner decision after review limit",
      );
    }
  }

  setTaskWorkflowState(state, task, {
    status: "needs_changes",
    assignedAgentRole: "builder",
    reviewerThreadId: "",
  }, now);
  actions.push(`${task.id}: returned to builder after ${stage.key} review`);
  return actions;
}

function advanceTaskWorkflowInState(state, task, options = {}) {
  const now = options.now || new Date().toISOString();
  const author = options.author || "Mission Control Automation";
  const actions = [];
  const project = findProject(state, task.projectId);
  if (!project) return actions;

  const missingDependencies = incompleteDependencies(state, task);
  if (missingDependencies.length) {
    if (["ready", "queued", "in_progress"].includes(task.status)) {
      setTaskWorkflowState(state, task, {
        status: "blocked",
        assignedAgentRole: "",
        reviewerThreadId: "",
      }, now);
      const body = `Blocked by unfinished dependencies: ${missingDependencies.map((item) => `${item.id} (${item.status})`).join(", ")}. Automation will re-check this task on later ticks.`;
      addAutomationComment(state, task, body, now, author);
      actions.push(`${task.id}: blocked by dependencies`);
    }
    return actions;
  }

  if (task.status === "blocked") {
    const body = "Dependencies are now complete. Automation returned this task to the builder queue.";
    addAutomationComment(state, task, body, now, author);
    setTaskWorkflowState(state, task, {
      status: "queued",
      assignedAgentRole: "",
      reviewerThreadId: "",
    }, now);
    actions.push(`${task.id}: unblocked`);
  }

  if (["ready", "queued"].includes(task.status)) {
    return actions;
  }

  if (task.status === "needs_changes") {
    if (!task.assignedAgentRole) {
      setTaskWorkflowState(state, task, {
        assignedAgentRole: "builder",
        reviewerThreadId: "",
      }, now);
      actions.push(`${task.id}: reassigned to builder for changes`);
    }
    return actions;
  }

  const stages = reviewStagesForProject(project);
  if (task.status === "builder_review") {
    if (!task.reviewCycle) task.reviewCycle = 1;
    if (!task.branchName || !task.prUrl) {
      setTaskWorkflowState(state, task, {
        status: "needs_changes",
        assignedAgentRole: "builder",
        reviewerThreadId: "",
      }, now);
      addAutomationComment(state, task, "Builder review failed intake: task needs both a feature branch and PR URL before reviewers can start.", now, author);
      actions.push(`${task.id}: missing branch or PR, returned to builder`);
      return actions;
    }
    return routeToNextReviewStage(state, task, stages, now, author, actions);
  }

  const currentStage = findReviewStage(stages, task.status);
  if (currentStage) {
    const latestReview = latestReviewForStage(state, task, currentStage);
    if (!latestReview) {
      if (task.assignedAgentRole !== currentStage.role) {
        setTaskWorkflowState(state, task, {
          assignedAgentRole: currentStage.role,
          reviewerThreadId: "",
        }, now);
        actions.push(`${task.id}: assigned to ${currentStage.role}`);
      }
      return actions;
    }
    if (latestReview.outcome === "changes_requested") {
      return routeChangesRequestedInState(state, task, project, currentStage, now, author, actions);
    }
    return routeToNextReviewStage(state, task, stages, now, author, actions);
  }

  return actions;
}

function routeToNextReviewStage(state, task, stages, now, author, actions) {
  const project = findProject(state, task.projectId);
  if (
    project
    && reviewCycleAtLimit(project, task)
    && changeRequestedReviewsForCycle(state, task).length
    && leadReviewCompleteForCycle(state, task, project)
  ) {
    return moveTaskAfterReviewsComplete(
      state,
      task,
      project,
      now,
      author,
      "Lead review finalized this task after the configured review-cycle limit. Residual risk should be captured in review comments.",
      actions,
    );
  }

  for (const stage of stages) {
    const latestReview = latestReviewForStage(state, task, stage);
    if (latestReview?.outcome === "changes_requested" && project && shouldEscalateChangesToLead(project, task, stage)) {
      return routeChangesRequestedInState(state, task, project, stage, now, author, actions);
    }
    if (!latestReview || latestReview.outcome === "changes_requested") {
      if (task.status !== stage.status || task.assignedAgentRole !== stage.role) {
        setTaskWorkflowState(state, task, {
          status: stage.status,
          assignedAgentRole: stage.role,
          reviewerThreadId: "",
        }, now);
        addAutomationComment(state, task, `Routed to ${stage.label || stage.key}. Reviewer should record approved, skipped, or changes_requested for this review cycle.`, now, author);
        actions.push(`${task.id}: routed to ${stage.role}`);
      }
      return actions;
    }
  }

  if (task.status !== "user_review") {
    moveTaskAfterReviewsComplete(
      state,
      task,
      project,
      now,
      author,
      "All required review stages for this cycle are complete.",
      actions,
    );
  }
  return actions;
}

export function taskWithProject(state, task) {
  return {
    ...task,
    project: state.projects.find((project) => project.id === task.projectId) || null,
    parent: state.tasks.find((item) => item.id === task.parentTaskId) || null,
    children: state.tasks.filter((item) => item.parentTaskId === task.id),
    dependencies: state.tasks.filter((item) => (task.dependsOnTaskIds || []).includes(item.id)),
    comments: state.comments.filter((comment) => comment.taskId === task.id),
    runs: (state.runs || []).filter((run) => run.taskId === task.id),
    reviews: state.reviews.filter((review) => review.taskId === task.id),
  };
}

export function generatePrompt(state, taskId, role = "builder") {
  const task = findTask(state, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const project = findProject(state, task.projectId);
  if (!project) throw new Error(`Task has missing project: ${task.projectId}`);
  const criteria = (task.acceptanceCriteria || []).map((item) => `- ${item}`).join("\n") || "- No acceptance criteria recorded yet.";
  const parent = task.parentTaskId ? findTask(state, task.parentTaskId) : null;
  const dependencies = (task.dependsOnTaskIds || [])
    .map((id) => findTask(state, id))
    .filter(Boolean)
    .map((item) => `- ${item.id}: ${item.title}`)
    .join("\n") || "- None recorded.";
  const attachments = renderAttachments(task.attachments);
  const validation = (project.validationCommands || []).map((item) => `- \`${item}\``).join("\n") || "- No validation command recorded.";
  const safety = (project.safetyRules || []).map((item) => `- ${item}`).join("\n") || "- No project-specific safety rules recorded.";
  const context = (project.contextLinks || []).map((item) => `- ${item}`).join("\n") || "- README.md";
  const standards = (project.standards || []).map((item) => `- ${standardReference(item)}`).join("\n") || "- No project-specific standards recorded.";
  const reviewStages = reviewStagesForProject(project);
  const reviewPolicy = reviewPolicyForProject(project);
  const reviewPipeline = reviewStages.length
    ? reviewStages
        .map((stage) => `- ${stage.label || stage.key} (${stage.role})${stage.required ? "" : " optional"}: ${stage.description || stage.status || "No description recorded."}`)
        .join("\n")
    : "- Builder review -> domain review when relevant -> accessibility review for UI work -> lead review -> user review.";
  const reviewPolicyText = [
    `- Maximum routine builder review cycles: ${reviewPolicy.maxBuilderReviewCycles}`,
    `- Reviewers may fix small deterministic issues directly: ${reviewPolicy.reviewerMayFixSmallIssues ? "yes" : "no"}`,
    `- Lead owns final decision at the cycle limit: ${reviewPolicy.leadOwnsFinalDecisionAtLimit ? "yes" : "no"}`,
    `- Trust lead approvals after review completion: ${reviewPolicy.trustLeadApprovals ? "yes, route to QA review instead of per-task owner review" : "no, route to owner review"}`,
    `- Lead-approved integration branch: ${reviewPolicy.integrationBranch || "(not configured)"}`,
  ].join("\n");

  if (role !== "builder") {
    const reviewerProfile = reviewerProfileForRole(role);
    return `You are the ${reviewerProfile.label} for Mission Control task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Feature branch: ${task.branchName || "(not recorded)"}
PR: ${task.prUrl || "(not recorded)"}
Task type: ${task.type || "task"}
Work lane: ${task.lane || task.area || "(inferred by Mission Control)"}
Work areas:
${(task.workAreas || []).map((item) => `- ${item}`).join("\n") || "- Not explicitly scoped."}
Review cycle: ${currentReviewCycle(task)}
Parent epic/task: ${parent ? `${parent.id}: ${parent.title}` : "(none)"}

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

Dependencies:
${dependencies}

Acceptance criteria:
${criteria}

Project safety rules:
${safety}

Project standards:
${standards}

Review pipeline:
${reviewPipeline}

Review loop policy:
${reviewPolicyText}

Review instructions:
- Review as a senior engineer in the ${reviewerProfile.domain} lane.
- Lead with concrete findings ordered by severity.
- Focus especially on:
${reviewerProfile.focus.map((item) => `  - ${item}`).join("\n")}
- Still check scope, behavior, tests, security, privacy, and maintainability.
- Check the listed project standards and fail the task for material violations.
- For data/backend changes, check query shape, indexes, pagination, migrations, and privacy boundaries.
- For frontend/UI changes, check responsive behavior, accessibility, visual hierarchy, component reuse, content editability, and browser console/runtime errors.
- For accessibility review, check color contrast, readable typography, focus-visible states, keyboard tab order, semantic headings, link and button names, alt text, title text, form labels, ARIA use, and screen-reader basics across mobile, tablet, and desktop.
- For consent-sensitive features, check opt-in, revocation, transparency, retention, and data minimization.
- For deployment/release workflow changes, fail unsafe patterns where PR merges or integration branch pushes deploy production by default, release/tag deploys do not verify the commit is reachable from the protected integration branch, manual dispatch can mutate production without a dry-run/preview default and explicit emergency approval path, or production sync can broadly delete runtime state.
- Confirm whether the acceptance criteria are met.
- Confirm the task has branch/PR context and builder notes when implementation work was done.
- Confirm whether this PR has one primary task or intentionally covers multiple tasks. If it covers multiple tasks, verify each linked task has clear complete/partial scope notes.
- If you find small deterministic issues and the project policy allows reviewer fixes, fix them directly on the PR branch, run relevant validation, comment with exactly what changed, then continue the review.
- Use \`changes_requested\` only for material, risky, ambiguous, security/privacy-sensitive, or product-shaping problems that should not be quietly fixed inside review.
- Do not create an endless builder-review loop. If this is review cycle ${reviewPolicy.maxBuilderReviewCycles} or later, routine bounce-backs are exhausted.
- At or beyond the review-cycle limit, non-lead reviewers should record \`changes_requested\` only for material unresolved issues; Mission Control will route the task to lead review for the final decision.
- At or beyond the review-cycle limit, the lead reviewer should make the final call: fix and approve, approve with residual risk documented, or hand the task to the human owner if it is unsafe or genuinely blocked. Do not send it back for another routine builder pass.
- Record the result with \`mission-control review ${task.id} --stage ${reviewerProfile.stageHint} --outcome approved|skipped|changes_requested --body "..."\`
- Use \`changes_requested\` for material issues and include concrete findings.
- Use \`skipped\` only when this review lane truly has no relevant surface.
- Use \`approved\` when this lane is complete, with validation reviewed and residual risk summarized.
`;
  }

  return `You are the builder for Mission Control task ${task.id}.

Project: ${project.name}
Repository path: ${project.repoPath || "(not recorded)"}
Default branch: ${project.defaultBranch || "main"}
Suggested branch: ${task.branchName || `codex/${project.key}-${task.id}-${slugify(task.title)}`}
Task type: ${task.type || "task"}
Work lane: ${task.lane || task.area || "(inferred by Mission Control)"}
Work areas:
${(task.workAreas || []).map((item) => `- ${item}`).join("\n") || "- Not explicitly scoped."}
Review cycle: ${currentReviewCycle(task)}
Parent epic/task: ${parent ? `${parent.id}: ${parent.title}` : "(none)"}

Before editing:
- Read project context:
${context}
- Read project standards:
${standards}
- Follow project safety rules:
${safety}

Review loop policy:
${reviewPolicyText}

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

Dependencies:
${dependencies}

Acceptance criteria:
${criteria}

Validation commands:
${validation}

Builder instructions:
- Create or switch to the feature branch.
- For UI or bug tasks, inspect referenced images, screenshots, and mockups before editing.
- For UI tasks, implement and verify mobile, tablet, and desktop behavior unless the task explicitly scopes one breakpoint only.
- For repeated UI, prefer shared components/templates and Sass tokens/mixins/classes over page-specific copies.
- For data/backend tasks, consider query shape, indexes, pagination, migrations, and realistic data volume.
- For location, auth, social, notification, behavioral analytics, personalization, AI training, or persuasion/coaching features, define the consent path, opt-out/revocation behavior, data minimization, and privacy notes before implementation.
- For deployment/release tasks, keep PR and protected integration branch workflows to validation, artifacts, previews, or staging by default; require production deployment to run only from explicit releases/tags with safety checks; verify the release/tag commit is reachable from the protected integration branch; make \`workflow_dispatch\` dry-run/preview unless explicitly approved for an emergency production path; and avoid broad delete/sync cleanup against production.
- Keep changes scoped to this task.
- Keep changes inside the task's lane and work areas. If you need to touch files outside that scope, add a Mission Control comment and either create a dependent task or explain why the scope must expand.
- Do not commit secrets, private customer data, or unrelated refactors.
- Run validation before reporting ready.
- Commit and push only if the user/project workflow asks for that.
- Link the feature branch and pull request on the task when available.
- Add a task comment with changed files, validation results, known gaps, PR link, and next review step.
- Move the task to \`builder_review\` only after the branch, PR, validation notes, and builder comment are present.
`;
}

function reviewerProfileForRole(role) {
  const normalized = String(role || "reviewer").toLowerCase().replaceAll("_", "-");
  if (normalized.includes("backend")) {
    return {
      label: "backend reviewer",
      domain: "backend/data/security",
      stageHint: "backend",
      focus: [
        "API contracts and error handling",
        "data model ownership, migrations, indexes, pagination, and query shape",
        "auth/session handling, PII protection, secrets, consent, and auditability",
        "background jobs, queues, deployment impact, and operational risk",
      ],
    };
  }
  if (normalized.includes("frontend")) {
    return {
      label: "frontend reviewer",
      domain: "frontend/product UI",
      stageHint: "frontend",
      focus: [
        "mockup fidelity, visual hierarchy, spacing, typography, and interaction quality",
        "mobile, tablet, desktop, direct URL refresh, and no horizontal overflow",
        "component reuse, Sass/design-system consistency, content editability, and no one-off UI copies",
        "accessibility, semantic HTML, loading/empty/error states, and browser console health",
      ],
    };
  }
  if (normalized.includes("accessibility") || normalized.includes("a11y")) {
    return {
      label: "accessibility expert reviewer",
      domain: "accessibility/a11y product UI",
      stageHint: "accessibility",
      focus: [
        "WCAG-oriented color contrast, readable typography, non-color-only states, and zoom-safe text",
        "visible focus states, keyboard reachability, logical tab order, skip/escape behavior, and no keyboard traps",
        "semantic headings, landmarks, link names, button names, form labels, title text, and accessible error text",
        "informative alt text, decorative image handling, restrained ARIA use, and screen-reader basics",
        "mobile, tablet, and desktop accessibility coverage, including responsive navigation and dialogs",
      ],
    };
  }
  return {
    label: "primary team lead reviewer",
    domain: "product/architecture/release",
    stageHint: "lead",
    focus: [
      "acceptance criteria, product intent, scope control, and user-facing risk",
      "whether backend, frontend, and accessibility reviews are complete or explicitly waived",
      "cross-cutting architecture, security/privacy posture, deployment safety, and rollback path",
      "whether the PR should move to QA/user review, needs changes, or be split into smaller PRs",
    ],
  };
}

function slugify(value) {
  return String(value || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}
