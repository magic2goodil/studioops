const state = {
  projects: [],
  tasks: [],
  qaBundles: [],
  selectedProjectId: "",
  selectedTaskId: "",
  routeTaskId: "",
  statusFilter: "",
};

const appLayout = document.querySelector("#appLayout");
const projectList = document.querySelector("#projectList");
const taskBoard = document.querySelector("#taskBoard");
const boardSummary = document.querySelector("#boardSummary");
const taskDetail = document.querySelector("#taskDetail");
const projectForm = document.querySelector("#projectForm");
const taskForm = document.querySelector("#taskForm");
const projectSettings = document.querySelector("#projectSettings");
const qaReviewPanel = document.querySelector("#qaReviewPanel");
const newTaskButton = document.querySelector("#newTaskButton");
const automationButton = document.querySelector("#automationButton");
const refreshButton = document.querySelector("#refreshButton");
const statusFilter = document.querySelector("#statusFilter");
const projectCount = document.querySelector("#projectCount");
const configStatus = document.querySelector("#configStatus");
const productPlan = document.querySelector("#productPlan");
const detailPanel = document.querySelector(".detail-panel");
const detailHeading = document.querySelector(".detail-panel .panel-header h2");
const imageModal = document.querySelector("#imageModal");
const imageModalImage = document.querySelector("#imageModalImage");
const imageModalCaption = document.querySelector("#imageModalCaption");
const taskModal = document.querySelector("#taskModal");
const taskModalBody = document.querySelector("#taskModalBody");
const taskModalOpenLink = document.querySelector("#taskModalOpenLink");
const taskCreateDialog = document.querySelector("#taskCreateDialog");
const qaDisclosure = document.querySelector(".qa-disclosure");

if (window.matchMedia("(max-width: 760px)").matches) qaDisclosure?.removeAttribute("open");

const WORKFLOW_STAGES = [
  {
    key: "intake",
    number: "01",
    eyebrow: "Structured intake",
    title: "Make it real",
    description: "Story, scope, and acceptance criteria",
    statuses: ["idea", "ready", "queued"],
  },
  {
    key: "build",
    number: "02",
    eyebrow: "AI builders",
    title: "Build + validate",
    description: "Standards, checks, and linked PRs",
    statuses: ["in_progress", "builder_review", "blocked"],
  },
  {
    key: "review",
    number: "03",
    eyebrow: "Specialist review",
    title: "Challenge the PR",
    description: "Backend, frontend, a11y, and lead gates",
    statuses: ["backend_review", "frontend_review", "accessibility_review", "lead_review", "needs_changes"],
  },
  {
    key: "qa",
    number: "04",
    eyebrow: "QA integration",
    title: "Prove it works",
    description: "Integrated preview, tests, and evidence",
    statuses: ["qa_review"],
  },
  {
    key: "release",
    number: "05",
    eyebrow: "Human release gate",
    title: "You ship it",
    description: "Owner approval, merge, and deployment",
    statuses: ["approved_for_main", "promotion_blocked", "user_review", "approved", "merged", "deployed", "done", "closed"],
  },
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truthyFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
}

function humanize(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bQa\b/g, "QA")
    .replace(/\bPr\b/g, "PR")
    .replace(/\bApi\b/g, "API");
}

function truncate(value, length = 160) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized;
  return `${normalized.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function workflowStage(task) {
  return WORKFLOW_STAGES.find((stage) => stage.statuses.includes(task?.status)) || WORKFLOW_STAGES[0];
}

function workflowStageIndex(task) {
  return WORKFLOW_STAGES.findIndex((stage) => stage.key === workflowStage(task).key);
}

function reviewTone(outcome) {
  if (outcome === "approved") return "approved";
  if (outcome === "changes_requested") return "changes-requested";
  return "recorded";
}

function reviewOutcomeLabel(outcome) {
  if (outcome === "changes_requested") return "Changes requested";
  return humanize(outcome || "recorded");
}

function linkifyText(value) {
  return escapeHtml(value).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
}

function taskPath(taskId) {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

function taskUrl(taskId) {
  return `${window.location.origin}${taskPath(taskId)}`;
}

function taskById(taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}

function routeTaskId() {
  const routeMatch = window.location.pathname.match(/^\/tasks\/([^/]+)$/);
  if (routeMatch) return decodeURIComponent(routeMatch[1]);
  return decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

function isImageAttachment(item) {
  const value = item.url || item.label || "";
  return item.type === "image" || /\.(png|jpe?g|gif|webp|svg)$/i.test(value);
}

function attachmentImageSrc(item) {
  const value = item.url || item.label || "";
  if (!isImageAttachment(item) || !value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/api/")) return value;
  if (value.startsWith("file://") || value.startsWith("/")) {
    return `/api/attachments/local-image?path=${encodeURIComponent(value)}`;
  }
  return "";
}

function repoWebUrl(project) {
  const raw = (project?.repoUrl || "").trim();
  if (!raw) return "";
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;
  return raw.startsWith("https://github.com/") ? raw.replace(/\.git$/, "") : "";
}

function branchUrl(project, branchName) {
  const repoUrl = repoWebUrl(project);
  const branch = String(branchName || "").trim();
  if (!repoUrl || !branch) return "";
  return `${repoUrl}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

function integrationBranch(task, project) {
  return String(
    task.integrationBranch
    || project?.reviewPolicy?.integrationBranch
    || project?.reviewPolicy?.reviewBranch
    || project?.integrationBranch
    || "",
  ).trim();
}

function integrationBranchUrl(task, project) {
  const linkedUrl = String(task.integrationBranchUrl || "").trim();
  if (linkedUrl) return linkedUrl;
  return branchUrl(project, integrationBranch(task, project));
}

function integrationStatusLabel(task) {
  const status = String(task.integrationStatus || "").trim();
  if (!status) return "pending";
  return status.replaceAll("_", " ");
}

function trustLeadApprovalsEnabled(project) {
  const policy = project?.reviewPolicy || {};
  if (Object.prototype.hasOwnProperty.call(policy, "trustLeadApprovals")) return truthyFlag(policy.trustLeadApprovals);
  if (Object.prototype.hasOwnProperty.call(policy, "trustLeads")) return truthyFlag(policy.trustLeads);
  return truthyFlag(project?.trustLeadApprovals);
}

function taskSummaryMeta(task) {
  const project = projectFor(task);
  const owner = workflowOwner(task);
  return [
    project?.key || "unknown",
    task.status || "unknown",
    task.type || "",
    owner ? `owner: ${owner}` : "",
  ].filter(Boolean).join(" · ");
}

function taskReferenceCard(task) {
  if (!task) return "";
  return `
    <article class="task-reference-card">
      <button type="button" class="task-reference-main" data-task-preview-id="${escapeHtml(task.id)}">
        <span class="task-id-pill">${escapeHtml(task.id)}</span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(taskSummaryMeta(task))}</small>
      </button>
      <a class="task-reference-open" href="${escapeHtml(taskPath(task.id))}" aria-label="Open ${escapeHtml(task.id)} full page">Open</a>
    </article>
  `;
}

function taskRelationshipList(tasks, emptyText) {
  if (!tasks?.length) return `<p class="muted-note">${escapeHtml(emptyText)}</p>`;
  return `<div class="task-link-list">${tasks.map((task) => taskReferenceCard(task)).join("")}</div>`;
}

function workflowOwner(task) {
  if (task.assignedAgentRole) return task.assignedAgentRole;
  if (task.status === "qa_review") return "local QA";
  if (task.status === "approved_for_main") return "promotion-worker";
  if (task.status === "promotion_blocked") return "builder";
  if (task.status === "user_review") return "owner";
  if (["ready", "queued", "in_progress", "needs_changes"].includes(task.status)) return "builder";
  if (task.status === "builder_review") return "automation";
  return "";
}

function workflowGate(task) {
  const owner = workflowOwner(task);
  if (task.status === "qa_review") {
    if (task.integrationStatus === "ready") return "QA bundle ready";
    if (["conflict", "validation_failed", "push_failed", "blocked"].includes(task.integrationStatus)) return "QA integration blocked";
    return "QA integration pending";
  }
  if (task.status === "approved_for_main") return "Approved for main promotion";
  if (task.status === "promotion_blocked") return "Promotion blocked";
  if (owner) return `Owner: ${owner}`;
  if (task.status === "blocked") return "Waiting on dependencies";
  if (["done", "closed", "merged", "deployed"].includes(task.status)) return "Complete";
  return "Unassigned";
}

function renderWorkflowRail(task) {
  const currentIndex = workflowStageIndex(task);
  const isBlocked = ["blocked", "needs_changes", "promotion_blocked"].includes(task.status);
  return `
    <nav class="workflow-rail" aria-label="Task delivery stages">
      ${WORKFLOW_STAGES.map((stage, index) => {
    const stateClass = index < currentIndex ? "complete" : index === currentIndex ? (isBlocked ? "current blocked" : "current") : "pending";
    return `
        <div class="workflow-step ${stateClass}">
          <span class="workflow-step-number">${stage.number}</span>
          <span>
            <small>${escapeHtml(stage.eyebrow)}</small>
            <strong>${escapeHtml(stage.title)}</strong>
          </span>
        </div>
      `;
  }).join("")}
    </nav>
  `;
}

function reviewStageOptions(project) {
  const stages = project?.reviewPipeline?.length ? project.reviewPipeline : [
    { key: "backend", label: "Backend Review", role: "backend-reviewer" },
    { key: "frontend", label: "Frontend Review", role: "frontend-reviewer" },
    { key: "accessibility", label: "Accessibility Review", role: "accessibility-reviewer" },
    { key: "lead", label: "Primary Lead Review", role: "lead-reviewer" },
  ];
  return stages.map((stage) => `<option value="${escapeHtml(stage.key || stage.role)}">${escapeHtml(stage.label || stage.key || stage.role)}</option>`).join("");
}

function renderReviewPanel(task, project) {
  const reviews = task.reviews || [];
  const approvedCount = reviews.filter((review) => review.outcome === "approved").length;
  const changesCount = reviews.filter((review) => review.outcome === "changes_requested").length;
  return `
    <section class="detail-section workflow-section">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Specialist evidence</p>
          <h3>Review gates</h3>
        </div>
        <span>Cycle ${escapeHtml(task.reviewCycle || 0)}</span>
      </div>
      <div class="review-summary">
        <span class="review-summary-chip approved"><strong>${approvedCount}</strong> approved</span>
        <span class="review-summary-chip changes-requested"><strong>${changesCount}</strong> changes requested</span>
        <span class="review-summary-chip"><strong>${reviews.length}</strong> recorded</span>
      </div>
      <div class="review-list">
        ${[...reviews].reverse().map((review) => {
    const body = String(review.body || "").trim();
    const tone = reviewTone(review.outcome);
    return `
          <article class="review-card ${tone}">
            <div class="review-card-heading">
              <div>
                <span class="review-outcome ${tone}">${escapeHtml(reviewOutcomeLabel(review.outcome))}</span>
                <strong>${escapeHtml(humanize(review.stageKey || review.role || "review"))}</strong>
              </div>
              <time>${escapeHtml(new Date(review.createdAt).toLocaleString())}</time>
            </div>
            ${body ? `
              <details class="review-evidence">
                <summary>${escapeHtml(truncate(body, 190))}</summary>
                <div>${linkifyText(body)}</div>
              </details>
            ` : `<p class="muted-note">Outcome recorded without supporting notes.</p>`}
          </article>
        `;
  }).join("") || `<div class="empty-state"><strong>No review outcomes yet</strong><span>Evidence will appear here as specialist gates complete.</span></div>`}
      </div>
      <details class="editor-disclosure">
        <summary>Record a review outcome</summary>
        <form class="review-form" data-review-form>
          <div class="form-grid">
            <label>Review Stage
              <select name="stage">${reviewStageOptions(project)}</select>
            </label>
            <label>Outcome
              <select name="outcome">
                <option value="approved">Approved</option>
                <option value="skipped">Skipped</option>
                <option value="changes_requested">Changes requested</option>
              </select>
            </label>
          </div>
          <label>Reviewer <input name="author" value="${escapeHtml(workflowOwner(task) || "reviewer")}"></label>
          <label>Review Notes <textarea name="body" rows="4" placeholder="Scope reviewed, findings, validation checked, residual risk..."></textarea></label>
          <button class="button button-primary" type="submit">Record outcome</button>
        </form>
      </details>
    </section>
  `;
}

function attachmentList(attachments) {
  if (!attachments?.length) return "";
  return `
    <h3>Visual Attachments</h3>
    <div class="attachment-list">
      ${attachments.map((item, index) => {
        const imageSrc = attachmentImageSrc(item);
        return `
        <div class="attachment-item ${imageSrc ? "has-preview" : ""}">
          ${imageSrc ? `
            <button class="attachment-preview" type="button" data-expand-attachment data-src="${escapeHtml(imageSrc)}" data-title="${escapeHtml(item.label || item.url || "Attachment")}">
              <img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(item.label || item.url || `Attachment ${index + 1}`)}" loading="lazy" onerror="this.closest('.attachment-preview').classList.add('missing-preview')">
              <span>Click to expand</span>
            </button>
          ` : ""}
          <strong>${escapeHtml(item.label || item.url || "Attachment")}</strong>
          <span>${escapeHtml(item.type || "reference")}${item.note ? ` - ${escapeHtml(item.note)}` : ""}</span>
          ${item.url ? `<code>${escapeHtml(item.url)}</code>` : ""}
        </div>
      `;
      }).join("")}
    </div>
  `;
}

async function loadState() {
  const data = await api("/api/state");
  state.projects = data.projects || [];
  state.tasks = data.tasks || [];
  state.qaBundles = data.qaBundles || [];
  state.productAccess = data.productAccess || null;
  if (productPlan && state.productAccess) {
    productPlan.textContent = `${state.productAccess.planName} · ${state.productAccess.connectedToCloud ? "cloud" : "local"}`;
  }
  state.routeTaskId = routeTaskId();
  const linkedTask = state.routeTaskId ? state.tasks.find((task) => task.id === state.routeTaskId) : null;
  if (linkedTask) {
    state.selectedTaskId = linkedTask.id;
    state.selectedProjectId = linkedTask.projectId;
  } else if (state.routeTaskId) {
    state.selectedTaskId = state.routeTaskId;
    state.selectedProjectId = "";
  }
  if (!state.routeTaskId && !state.selectedProjectId && state.projects[0]) state.selectedProjectId = state.projects[0].id;
  if (!state.routeTaskId && !state.selectedTaskId && state.tasks[0]) state.selectedTaskId = state.tasks[0].id;
  configStatus.textContent = data.configLoaded
    ? "Local StudioOps configuration loaded"
    : "No local configuration yet. Run npm run setup or studioops setup.";
  render();
}

function projectFor(task) {
  return state.projects.find((project) => project.id === task.projectId) || null;
}

function activeProjectForNewTask() {
  const selectedTask = taskById(state.selectedTaskId || state.routeTaskId);
  return projectFor(selectedTask) || selectedProject() || state.projects[0] || null;
}

function visibleTasks() {
  return state.tasks.filter((task) => {
    if (state.selectedProjectId && task.projectId !== state.selectedProjectId) return false;
    if (state.statusFilter && task.status !== state.statusFilter) return false;
    return true;
  });
}

function renderProjects() {
  projectCount.textContent = state.projects.length;
  projectList.innerHTML = state.projects.map((project) => `
    <button type="button" class="project-item ${project.id === state.selectedProjectId ? "active" : ""}" data-project-id="${escapeHtml(project.id)}">
      <strong>${escapeHtml(project.name)}</strong>
      <span>${escapeHtml(project.repoPath || project.repoUrl || project.key)}</span>
    </button>
  `).join("") || `<div class="project-item"><strong>No projects yet</strong><span>Add one below or run setup.</span></div>`;

  const select = taskForm.elements.project;
  select.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.key)}">${escapeHtml(project.name)}</option>`).join("");
  const activeProject = activeProjectForNewTask();
  if (activeProject) select.value = activeProject.key;
  renderProjectSettings();
  renderQaReviewPanel();
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || null;
}

function renderProjectSettings() {
  const project = selectedProject();
  if (!project) {
    projectSettings.innerHTML = "";
    return;
  }
  const policy = project.reviewPolicy || {};
  projectSettings.innerHTML = `
    <form class="project-settings-form" data-project-settings>
      <h3>Review Policy</h3>
      <label class="checkbox-row">
        <input name="trustLeadApprovals" type="checkbox" ${policy.trustLeadApprovals ? "checked" : ""}>
        Trust Leads
      </label>
      <p class="muted-note">Lead-approved work goes to QA Review instead of asking you to review every task one by one.</p>
      <label>QA Integration Branch
        <input name="integrationBranch" value="${escapeHtml(policy.integrationBranch || "")}" placeholder="qa/${escapeHtml(project.key)}">
      </label>
      <button type="submit">Save Policy</button>
    </form>
  `;
}

function renderQaReviewPanel() {
  const project = selectedProject();
  if (!project) {
    qaReviewPanel.innerHTML = "";
    return;
  }
  const items = state.tasks
    .filter((task) => task.projectId === project.id)
    .filter((task) => ["qa_review", "approved_for_main", "promotion_blocked"].includes(task.status));
  const bundles = state.qaBundles
    .filter((bundle) => bundle.projectId === project.id)
    .filter((bundle) => ["ready", "partially_reviewed", "release_candidate_ready"].includes(bundle.status));
  qaReviewPanel.innerHTML = `
    <section class="qa-review-list">
      <div class="section-heading">
        <h3>QA Bundles</h3>
        <span>${bundles.length} active</span>
      </div>
      ${bundles.map((bundle) => `
        <article class="qa-bundle-card">
          <div class="qa-bundle-heading">
            <span class="task-id-pill">${escapeHtml(bundle.id)}</span>
            <strong>${escapeHtml(bundle.tasks?.length || 0)} changes ${bundle.status === "release_candidate_ready" ? "ready to merge" : "ready to test"}</strong>
          </div>
          <p>${escapeHtml(bundle.integrationBranch || "QA branch")} · ${escapeHtml((bundle.integrationCommit || "").slice(0, 10))}</p>
          ${bundle.status === "release_candidate_ready"
    ? `<a href="${escapeHtml(bundle.promotionPrUrl || "#")}" target="_blank" rel="noreferrer">Open release-candidate PR</a>`
    : bundle.previewUrl ? `<a href="${escapeHtml(bundle.previewUrl)}">Open local QA preview</a>` : `<code>${escapeHtml(bundle.previewCheckoutPath || "Preview URL not configured")}</code>`}
          <div class="qa-bundle-tasks">
            ${(bundle.tasks || []).map((task) => `
              <button type="button" data-task-id="${escapeHtml(task.id)}">
                <span>${escapeHtml(task.id)}</span>
                <strong>${escapeHtml(task.title)}</strong>
              </button>
            `).join("")}
          </div>
          ${bundle.status === "release_candidate_ready" ? `
            <p class="muted-note">Lead review and local QA passed. Merging the PR updates main; production still requires an explicit release.</p>
          ` : `
            <label>QA notes
              <textarea rows="2" data-qa-bundle-notes="${escapeHtml(bundle.id)}" placeholder="What you tested, or what needs to change"></textarea>
            </label>
            <div class="qa-bundle-actions">
              <button type="button" data-qa-bundle-decision="passed" data-qa-bundle-id="${escapeHtml(bundle.id)}">Pass bundle</button>
              <button type="button" class="secondary" data-qa-bundle-decision="failed" data-qa-bundle-id="${escapeHtml(bundle.id)}">Return bundle</button>
            </div>
          `}
        </article>
      `).join("") || `<p class="muted-note">No validated QA bundle is ready yet.</p>`}
      <div class="section-heading qa-task-heading">
        <h3>Tasks in QA</h3>
        <span>${items.length} active</span>
      </div>
      ${items.length ? `
        <div class="qa-review-items">
          ${items.map((task) => {
            const qaBranch = integrationBranch(task, project);
            const qaBranchHref = integrationBranchUrl(task, project);
            const qaBranchMeta = qaBranch
              ? `<div class="qa-card-meta">
                  <span>${escapeHtml(task.status === "approved_for_main" ? "promotion queued" : task.status === "promotion_blocked" ? "promotion blocked" : `QA ${integrationStatusLabel(task)}`)}</span>
                  ${qaBranchHref ? `<a href="${escapeHtml(qaBranchHref)}" target="_blank" rel="noreferrer">Open ${escapeHtml(qaBranch)}</a>` : `<span>${escapeHtml(qaBranch)}</span>`}
                </div>`
              : "";
            return `
            <article class="qa-review-item">
              <button type="button" data-task-id="${escapeHtml(task.id)}">
                <span class="task-id-pill">${escapeHtml(task.id)}</span>
                <strong>${escapeHtml(task.title)}</strong>
                <small>${escapeHtml(task.branchName || "No branch")} ${task.prUrl ? "· PR linked" : "· No PR"}</small>
              </button>
              ${qaBranchMeta}
            </article>
          `;
          }).join("")}
        </div>
      ` : `<p class="muted-note">Nothing is waiting for local QA yet.</p>`}
    </section>
  `;
}

function renderTasks() {
  const tasks = visibleTasks();
  const activeCount = tasks.filter((task) => !["done", "closed", "merged", "deployed"].includes(task.status)).length;
  const buildCount = tasks.filter((task) => workflowStage(task).key === "build").length;
  const reviewCount = tasks.filter((task) => workflowStage(task).key === "review").length;
  const ownerCount = tasks.filter((task) => ["qa", "release"].includes(workflowStage(task).key)).length;
  boardSummary.innerHTML = `
    <div><strong>${activeCount}</strong><span>Active work</span></div>
    <div><strong>${buildCount}</strong><span>With builders</span></div>
    <div><strong>${reviewCount}</strong><span>At review gates</span></div>
    <div><strong>${ownerCount}</strong><span>QA or release</span></div>
  `;

  const taskCard = (task) => {
    const project = projectFor(task);
    const childCount = state.tasks.filter((item) => item.parentTaskId === task.id).length;
    const dependencies = (task.dependsOnTaskIds || []).map(taskById).filter(Boolean);
    const qaBranch = integrationBranch(task, project);
    const qaBranchHref = integrationBranchUrl(task, project);
    const reviews = task.reviews || [];
    const latestReview = reviews.at(-1);
    return `
      <article class="task-card ${task.id === state.selectedTaskId ? "selected" : ""} ${["blocked", "needs_changes", "promotion_blocked"].includes(task.status) ? "attention" : ""}">
        <button type="button" class="task-card-main" data-task-id="${escapeHtml(task.id)}">
          <div class="task-card-top">
            <span class="task-id-pill">${escapeHtml(task.id)}</span>
            <span class="priority">${escapeHtml(task.priority || "medium")}</span>
          </div>
          <span class="status ${escapeHtml(task.status)}">${escapeHtml(humanize(task.status))}</span>
          <h3>${escapeHtml(task.title)}</h3>
          <p>${escapeHtml(truncate(task.description || task.expectedOutcome || "No delivery summary yet.", 130))}</p>
          ${latestReview ? `<span class="card-review ${reviewTone(latestReview.outcome)}">${escapeHtml(humanize(latestReview.stageKey || latestReview.role || "review"))}: ${escapeHtml(reviewOutcomeLabel(latestReview.outcome))}</span>` : ""}
          <div class="task-card-footer">
            <span><i aria-hidden="true"></i>${escapeHtml(workflowGate(task))}${task.reviewCycle ? ` · cycle ${escapeHtml(task.reviewCycle)}` : ""}</span>
            <small>${escapeHtml(project?.key || "unknown")}${childCount ? ` · ${childCount} child${childCount === 1 ? "" : "ren"}` : ""}${dependencies.length ? ` · ${dependencies.length} blocked by` : ""}</small>
          </div>
        </button>
        ${["qa_review", "approved_for_main", "promotion_blocked"].includes(task.status) && (qaBranch || task.promotionStatus) ? `
          <div class="qa-card-meta">
            <span>${escapeHtml(task.promotionStatus ? `Promotion ${promotionStatusLabel(task)}` : `QA ${integrationStatusLabel(task)}`)}</span>
            ${qaBranchHref ? `<a href="${escapeHtml(qaBranchHref)}" target="_blank" rel="noreferrer">Open QA branch</a>` : `<span>${escapeHtml(qaBranch)}</span>`}
          </div>
        ` : ""}
      </article>
    `;
  };

  taskBoard.innerHTML = WORKFLOW_STAGES.map((stage) => {
    const stageTasks = tasks.filter((task) => workflowStage(task).key === stage.key);
    return `
      <section class="workflow-lane" data-stage="${stage.key}">
        <header class="lane-header">
          <div class="lane-number">${stage.number}</div>
          <div>
            <p>${escapeHtml(stage.eyebrow)}</p>
            <h2>${escapeHtml(stage.title)}</h2>
          </div>
          <span class="lane-count">${stageTasks.length}</span>
        </header>
        <p class="lane-description">${escapeHtml(stage.description)}</p>
        <div class="lane-cards">
          ${stageTasks.map(taskCard).join("") || `<div class="lane-empty"><span>Clear</span><small>No work at this stage</small></div>`}
        </div>
      </section>
    `;
  }).join("");
}

function renderHierarchyPanel(task) {
  const dependsOnValue = (task.dependsOnTaskIds || []).join(", ");
  return `
    <details class="detail-section sidebar-details hierarchy-section">
      <summary>
        <span><small>Planning</small><strong>Epic & dependencies</strong></span>
        <span>${escapeHtml(humanize(task.type || "task"))}</span>
      </summary>
      <div class="sidebar-details-body">
        <div class="relationship-grid">
          <div>
            <h4>Parent</h4>
            ${task.parent ? taskReferenceCard(task.parent) : `<p class="muted-note">No parent epic/task linked.</p>`}
          </div>
          <div>
            <h4>Children</h4>
            ${taskRelationshipList(task.children || [], "No child tasks yet.")}
          </div>
          <div>
            <h4>Depends On</h4>
            ${taskRelationshipList(task.dependencies || [], "No dependencies recorded.")}
          </div>
        </div>
        <div class="relationship-edit-grid">
          <h4>Edit relationship IDs</h4>
          <label>Parent Epic/Task ID <input name="detailParentTaskId" value="${escapeHtml(task.parentTaskId || "")}" placeholder="task_12"></label>
          <label>Depends On Task IDs <textarea name="detailDependsOnTaskIds" rows="2" placeholder="task_1, task_2">${escapeHtml(dependsOnValue)}</textarea></label>
          <button class="button button-primary" type="button" data-action="save-relationships">Save relationships</button>
        </div>
      </div>
    </details>
  `;
}

function renderBranchPanel(task, project) {
  const branchHref = branchUrl(project, task.branchName);
  const prUrl = String(task.prUrl || "").trim();
  return `
    <details class="detail-section sidebar-details branch-section">
      <summary>
        <span><small>Delivery</small><strong>Git association</strong></span>
        <span>${task.prUrl ? "PR linked" : "Not linked"}</span>
      </summary>
      <div class="sidebar-details-body">
        <div class="branch-links">
          ${branchHref ? `<a class="button button-quiet" href="${escapeHtml(branchHref)}" target="_blank" rel="noreferrer">Open feature branch</a>` : `<span class="empty-pill">Add a repo URL and branch name to open the branch.</span>`}
          ${prUrl ? `<a class="button button-primary" href="${escapeHtml(prUrl)}" target="_blank" rel="noreferrer">Open pull request</a>` : `<span class="empty-pill">No PR linked yet</span>`}
        </div>
        <div class="branch-edit-grid">
          <label>Feature Branch <input name="branchName" value="${escapeHtml(task.branchName || "")}" placeholder="codex/project-task-short-title"></label>
          <label>Pull Request URL <input name="prUrl" value="${escapeHtml(task.prUrl || "")}" placeholder="https://github.com/owner/repo/pull/123"></label>
          <button class="button button-primary" type="button" data-action="save-git-links">Save git links</button>
        </div>
      </div>
    </details>
  `;
}

function renderIntegrationPanel(task, project) {
  const enabled = trustLeadApprovalsEnabled(project);
  const qaBranch = integrationBranch(task, project);
  if (!enabled && !qaBranch && !task.integrationStatus) return "";
  const qaBranchHref = integrationBranchUrl(task, project);
  const validation = task.integrationValidation?.commands || [];
  return `
    <section class="detail-section integration-section">
      <div class="section-heading">
        <h3>QA Integration</h3>
        <span>${escapeHtml(integrationStatusLabel(task))}</span>
      </div>
      <div class="workflow-grid">
        <div>
          <strong>Trust Leads</strong>
          <span>${enabled ? "enabled" : "disabled"}</span>
        </div>
        <div>
          <strong>Integration branch</strong>
          <span>${qaBranchHref ? `<a class="inline-link" href="${escapeHtml(qaBranchHref)}" target="_blank" rel="noreferrer">${escapeHtml(qaBranch)}</a>` : escapeHtml(qaBranch || "not configured")}</span>
        </div>
        <div>
          <strong>Commit</strong>
          <span>${escapeHtml(task.integrationCommit || "not ready")}</span>
        </div>
        <div>
          <strong>Updated</strong>
          <span>${task.integrationUpdatedAt ? escapeHtml(new Date(task.integrationUpdatedAt).toLocaleString()) : "not run"}</span>
        </div>
      </div>
      ${task.integrationConflictFiles?.length ? `
        <div class="conflict-list">
          <strong>Conflicts</strong>
          ${task.integrationConflictFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}
        </div>
      ` : ""}
      ${validation.length ? `
        <div class="validation-list">
          <strong>Validation</strong>
          ${validation.map((item) => `<code>${escapeHtml(item.command)}: ${item.ok ? "passed" : "failed"}</code>`).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function promotionStatusLabel(task) {
  const status = String(task.promotionStatus || "").trim();
  if (!status) return task.status === "approved_for_main" ? "queued" : "not queued";
  return status.replaceAll("_", " ");
}

function renderPromotionPanel(task, project) {
  if (!["approved_for_main", "promotion_blocked", "merged"].includes(task.status) && !task.promotionStatus) return "";
  const targetBranch = task.promotionTargetBranch || project?.promotion?.targetBranch || project?.defaultBranch || "main";
  const targetHref = branchUrl(project, targetBranch);
  const validation = task.promotionValidation?.commands || [];
  return `
    <section class="detail-section promotion-section">
      <div class="section-heading">
        <h3>Main Promotion</h3>
        <span>${escapeHtml(promotionStatusLabel(task))}</span>
      </div>
      <div class="workflow-grid">
        <div>
          <strong>Target branch</strong>
          <span>${targetHref ? `<a class="inline-link" href="${escapeHtml(targetHref)}" target="_blank" rel="noreferrer">${escapeHtml(targetBranch)}</a>` : escapeHtml(targetBranch || "not configured")}</span>
        </div>
        <div>
          <strong>Commit</strong>
          <span>${escapeHtml(task.promotionCommit || "not promoted")}</span>
        </div>
        <div>
          <strong>Updated</strong>
          <span>${task.promotionUpdatedAt ? escapeHtml(new Date(task.promotionUpdatedAt).toLocaleString()) : "not run"}</span>
        </div>
        <div>
          <strong>Worker</strong>
          <span>${escapeHtml(task.assignedAgentRole || "promotion-worker")}</span>
        </div>
      </div>
      ${task.promotionConflictFiles?.length ? `
        <div class="conflict-list">
          <strong>Conflicts</strong>
          ${task.promotionConflictFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}
        </div>
      ` : ""}
      ${validation.length ? `
        <div class="validation-list">
          <strong>Validation</strong>
          ${validation.map((item) => `<code>${escapeHtml(item.command)}: ${item.ok ? "passed" : "failed"}</code>`).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderQaDecisionPanel(task) {
  if (!["qa_review", "approved_for_main"].includes(task.status)) return "";
  const ready = task.status === "approved_for_main" || !task.integrationStatus || task.integrationStatus === "ready";
  const disabledAttr = ready ? "" : "disabled";
  const statusCopy = task.status === "approved_for_main"
    ? "This task passed local QA and is queued for promotion."
    : ready
      ? "Review the local QA preview, then pass or fail this task."
      : `QA cannot pass until integration is ready. Current state: ${integrationStatusLabel(task)}.`;
  return `
    <section class="detail-section qa-decision-section">
      <div class="section-heading">
        <h3>Owner QA Decision</h3>
        <span>${escapeHtml(task.status === "approved_for_main" ? "passed" : integrationStatusLabel(task))}</span>
      </div>
      <p class="muted-note">${escapeHtml(statusCopy)}</p>
      ${task.qaDecision ? `
        <div class="workflow-grid">
          <div>
            <strong>Last decision</strong>
            <span>${escapeHtml(task.qaDecision.outcome || "")}</span>
          </div>
          <div>
            <strong>By</strong>
            <span>${escapeHtml(task.qaDecision.author || "")}</span>
          </div>
          <div>
            <strong>At</strong>
            <span>${task.qaDecision.decidedAt ? escapeHtml(new Date(task.qaDecision.decidedAt).toLocaleString()) : ""}</span>
          </div>
        </div>
      ` : ""}
      <label>QA Notes
        <textarea name="qaDecisionNotes" rows="3" placeholder="What you checked locally, what failed, or anything the builder should know.">${escapeHtml(task.qaDecision?.notes || "")}</textarea>
      </label>
      <div class="qa-decision-actions">
        <button type="button" data-qa-decision="passed" ${disabledAttr}>QA Passed</button>
        <button type="button" data-qa-decision="failed">QA Failed</button>
      </div>
    </section>
  `;
}

function renderStandardsPanel(project) {
  const standards = project?.standards || [];
  return `
    <section class="detail-section standards-section">
      <div class="section-heading">
        <h3>Project Standards</h3>
        <span>${standards.length} file${standards.length === 1 ? "" : "s"}</span>
      </div>
      <div class="standards-list">
        ${standards.map((item) => `<code>${escapeHtml(item)}</code>`).join("") || `<p class="muted-note">No standards attached to this project yet.</p>`}
      </div>
    </section>
  `;
}

function renderComments(comments) {
  return `
    <section class="detail-section comments-section">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Delivery log</p>
          <h3>Builder notes & PR updates</h3>
        </div>
        <span>${comments.length} comment${comments.length === 1 ? "" : "s"}</span>
      </div>
      <div class="comment-list">
        ${comments.map((comment) => `
          <article class="comment-card">
            <div>
              <strong>${escapeHtml(comment.author || "user")}</strong>
              <time>${escapeHtml(new Date(comment.createdAt).toLocaleString())}</time>
            </div>
            <p>${linkifyText(comment.body)}</p>
          </article>
        `).join("") || `<p class="muted-note">No builder notes yet.</p>`}
      </div>
      <details class="editor-disclosure">
        <summary>Add delivery note</summary>
        <form class="comment-form" data-comment-form>
          <label>Author <input name="author" value="Codex Builder"></label>
          <label>Comment <textarea name="body" rows="4" placeholder="What changed, validation results, PR link, known gaps..."></textarea></label>
          <button class="button button-primary" type="submit">Add note</button>
        </form>
      </details>
    </section>
  `;
}

function renderRequirementsPanel(task) {
  const criteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria
    : String(task.acceptanceCriteria || "").split("\n").map((item) => item.trim()).filter(Boolean);
  return `
    <section class="detail-section contract-section">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Engineering contract</p>
          <h3>Definition of done</h3>
        </div>
        <span>${criteria.length} acceptance checks</span>
      </div>
      <div class="contract-grid">
        <article>
          <span>User story</span>
          <p>${escapeHtml(task.userStory || "No user story recorded yet.")}</p>
        </article>
        <article>
          <span>Expected outcome</span>
          <p>${escapeHtml(task.expectedOutcome || task.description || "No expected outcome recorded yet.")}</p>
        </article>
      </div>
      <div class="criteria-list">
        ${criteria.map((criterion) => `<div><span aria-hidden="true">✓</span><p>${escapeHtml(criterion)}</p></div>`).join("") || `<div class="empty-state"><strong>No acceptance criteria</strong><span>Add measurable checks before the task enters build.</span></div>`}
      </div>
    </section>
  `;
}

function renderTaskSnapshot(task, project) {
  const branchHref = branchUrl(project, task.branchName);
  return `
    <section class="detail-section snapshot-section">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Current handoff</p>
          <h3>${escapeHtml(workflowGate(task))}</h3>
        </div>
        <span class="status ${escapeHtml(task.status)}">${escapeHtml(humanize(task.status))}</span>
      </div>
      <dl class="snapshot-list">
        <div><dt>Owner</dt><dd>${escapeHtml(workflowOwner(task) || "Unassigned")}</dd></div>
        <div><dt>Review cycle</dt><dd>${escapeHtml(task.reviewCycle || 0)}</dd></div>
        <div><dt>Branch</dt><dd>${branchHref ? `<a class="inline-link" href="${escapeHtml(branchHref)}" target="_blank" rel="noreferrer">${escapeHtml(task.branchName)}</a>` : escapeHtml(task.branchName || "Not linked")}</dd></div>
        <div><dt>Pull request</dt><dd>${task.prUrl ? `<a class="inline-link" href="${escapeHtml(task.prUrl)}" target="_blank" rel="noreferrer">Open PR</a>` : "Not linked"}</dd></div>
      </dl>
    </section>
  `;
}

function renderStatusActions(task) {
  const statuses = [
    "ready", "in_progress", "builder_review", "backend_review", "frontend_review",
    "accessibility_review", "lead_review", "qa_review", "approved_for_main",
    "promotion_blocked", "needs_changes", "user_review", "done",
  ];
  return `
    <section class="detail-section action-section">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Owner control</p>
          <h3>Move task</h3>
        </div>
      </div>
      <label>Next status
        <select name="taskStatusUpdate">
          ${statuses.map((status) => `<option value="${status}" ${task.status === status ? "selected" : ""}>${escapeHtml(humanize(status))}</option>`).join("")}
        </select>
      </label>
      <button class="button button-primary" type="button" data-action="update-status">Update workflow</button>
    </section>
  `;
}

function renderPromptLibrary(prompts) {
  const roles = [
    ["builder", "Builder"],
    ["backend-reviewer", "Backend reviewer"],
    ["frontend-reviewer", "Frontend reviewer"],
    ["accessibility-reviewer", "Accessibility reviewer"],
    ["lead-reviewer", "Primary lead reviewer"],
  ];
  return `
    <section class="detail-section prompt-library">
      <div class="section-heading">
        <div>
          <p class="section-kicker">Agent context</p>
          <h3>Generated prompts</h3>
        </div>
        <span>${roles.length} roles</span>
      </div>
      ${roles.map(([key, label]) => `
        <details class="prompt-disclosure">
          <summary>${escapeHtml(label)}</summary>
          <div class="prompt-box">${escapeHtml(prompts[key] || "Prompt unavailable.")}</div>
        </details>
      `).join("")}
    </section>
  `;
}

async function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    taskDetail.innerHTML = `<p>${state.routeTaskId ? `Task ${escapeHtml(state.routeTaskId)} was not found.` : "Select a task to view prompts and review metadata."}</p>`;
    return;
  }
  const detail = await api(`/api/tasks/${task.id}/detail`);
  const fullTask = detail.task;
  const project = fullTask.project || projectFor(task);
  const prompts = detail.prompts || {};
  const link = taskUrl(task.id);
  const isFullPage = Boolean(state.routeTaskId);
  taskDetail.innerHTML = `
    ${isFullPage ? `<button class="back-link button button-quiet" type="button" data-action="back-to-board">← Back to pipeline</button>` : ""}
    <div class="detail-hero">
      <div>
        <div class="hero-meta">
          <span class="task-id-pill hero-task-id">${escapeHtml(fullTask.id)}</span>
          <span>${escapeHtml(project?.name || "Unknown project")}</span>
          <span>${escapeHtml(humanize(fullTask.type || "task"))}</span>
          <span>${escapeHtml(humanize(fullTask.priority || "medium"))} priority</span>
        </div>
        <h1 class="detail-title">${escapeHtml(fullTask.title)}</h1>
        <p>${escapeHtml(fullTask.description || "No delivery summary recorded yet.")}</p>
      </div>
      ${!isFullPage ? `<a class="button button-primary" href="${escapeHtml(link)}">Open workspace</a>` : ""}
    </div>
    ${renderWorkflowRail(fullTask)}
    <div class="task-workspace-grid">
      <div class="workspace-main">
        ${renderRequirementsPanel(fullTask)}
        ${renderReviewPanel(fullTask, project)}
        ${fullTask.attachments?.length ? `<section class="detail-section attachment-section">${attachmentList(fullTask.attachments)}</section>` : ""}
        ${renderComments(fullTask.comments || [])}
        ${renderPromptLibrary(prompts)}
      </div>
      <aside class="workspace-sidebar">
        ${renderTaskSnapshot(fullTask, project)}
        ${renderStatusActions(fullTask)}
        ${renderQaDecisionPanel(fullTask)}
        ${renderIntegrationPanel(fullTask, project)}
        ${renderPromotionPanel(fullTask, project)}
        ${renderStandardsPanel(project)}
        ${renderHierarchyPanel(fullTask)}
        ${renderBranchPanel(fullTask, project)}
        <section class="detail-section task-link-section">
          <p class="section-kicker">Shareable local link</p>
          <a class="plain-link" href="${escapeHtml(taskPath(task.id))}">${escapeHtml(link)}</a>
        </section>
      </aside>
    </div>
  `;
}

function render() {
  const isTaskPage = Boolean(state.routeTaskId);
  document.body.classList.toggle("task-page", isTaskPage);
  appLayout.classList.toggle("task-route", isTaskPage);
  detailPanel.classList.toggle("full-detail", isTaskPage);
  detailHeading.textContent = isTaskPage ? "Task Workspace" : "Task Detail";
  renderProjects();
  renderTasks();
  renderDetail().catch((error) => {
    taskDetail.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  });
}

function openImageModal(src, title) {
  if (!src) return;
  imageModalImage.src = src;
  imageModalImage.alt = title || "Attachment preview";
  imageModalCaption.textContent = title || "Attachment preview";
  imageModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeImageModal() {
  imageModal.hidden = true;
  imageModalImage.removeAttribute("src");
  imageModalCaption.textContent = "";
  document.body.classList.remove("modal-open");
}

async function openTaskModal(taskId) {
  const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}/detail`);
  const task = detail.task;
  const project = task.project || projectFor(task);
  const qaSummary = ["qa_review", "approved_for_main", "promotion_blocked"].includes(task.status) || integrationBranch(task, project) || task.integrationStatus
    ? `<section>
        <h3>QA & Promotion</h3>
        <p>${escapeHtml(integrationStatusLabel(task))}${task.promotionStatus ? ` · promotion ${escapeHtml(promotionStatusLabel(task))}` : ""}${integrationBranch(task, project) ? ` · ${escapeHtml(integrationBranch(task, project))}` : ""}</p>
      </section>`
    : "";
  taskModalOpenLink.href = taskPath(task.id);
  taskModalBody.innerHTML = `
    <div class="task-modal-hero">
      <span class="task-id-pill">${escapeHtml(task.id)}</span>
      <h2 id="taskModalTitle">${escapeHtml(task.title)}</h2>
      <p>${escapeHtml(project?.name || "Unknown project")} · ${escapeHtml(task.status)} · ${escapeHtml(task.priority || "medium")}</p>
    </div>
    <div class="task-modal-grid">
      <section>
        <h3>Description</h3>
        <p>${escapeHtml(task.description || "No description recorded.")}</p>
      </section>
      <section>
        <h3>Current Owner</h3>
        <p>${escapeHtml(workflowGate(task))}</p>
      </section>
      ${qaSummary}
      <section>
        <h3>Parent</h3>
        ${task.parent ? taskReferenceCard(task.parent) : `<p class="muted-note">No parent linked.</p>`}
      </section>
      <section>
        <h3>Depends On</h3>
        ${taskRelationshipList(task.dependencies || [], "No dependencies recorded.")}
      </section>
    </div>
  `;
  taskModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeTaskModal() {
  taskModal.hidden = true;
  taskModalBody.innerHTML = "";
  taskModalOpenLink.href = "/";
  document.body.classList.remove("modal-open");
}

projectList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) return;
  state.selectedProjectId = button.dataset.projectId;
  state.selectedTaskId = visibleTasks()[0]?.id || "";
  state.routeTaskId = "";
  window.history.pushState(null, "", "/");
  render();
});

projectSettings.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-project-settings]");
  if (!form) return;
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  const formData = new FormData(form);
  await api(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      reviewPolicy: {
        trustLeadApprovals: formData.get("trustLeadApprovals") === "on",
        integrationBranch: formData.get("integrationBranch") || "",
      },
    }),
  });
  await loadState();
});

qaReviewPanel.addEventListener("click", async (event) => {
  const decisionButton = event.target.closest("[data-qa-bundle-decision]");
  if (decisionButton) {
    const bundleId = decisionButton.dataset.qaBundleId;
    const notes = qaReviewPanel.querySelector(`[data-qa-bundle-notes="${CSS.escape(bundleId)}"]`)?.value || "";
    await api(`/api/qa/bundles/${encodeURIComponent(bundleId)}/decision`, {
      method: "POST",
      body: JSON.stringify({
        outcome: decisionButton.dataset.qaBundleDecision,
        notes,
        author: "Owner QA",
      }),
    });
    await loadState();
    return;
  }
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  state.selectedTaskId = button.dataset.taskId;
  window.history.pushState(null, "", taskPath(state.selectedTaskId));
  loadState().catch((error) => alert(error.message));
});

taskBoard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  state.selectedTaskId = button.dataset.taskId;
  window.history.pushState(null, "", taskPath(state.selectedTaskId));
  loadState().catch((error) => alert(error.message));
});

taskDetail.addEventListener("click", async (event) => {
  const taskPreviewButton = event.target.closest("[data-task-preview-id]");
  if (taskPreviewButton) {
    await openTaskModal(taskPreviewButton.dataset.taskPreviewId);
    return;
  }

  const backButton = event.target.closest("[data-action='back-to-board']");
  if (backButton) {
    state.routeTaskId = "";
    window.history.pushState(null, "", "/");
    await loadState();
    return;
  }

  const attachmentButton = event.target.closest("[data-expand-attachment]");
  if (attachmentButton) {
    openImageModal(attachmentButton.dataset.src, attachmentButton.dataset.title);
    return;
  }

  const gitButton = event.target.closest("[data-action='save-git-links']");
  if (gitButton && state.selectedTaskId) {
    await api(`/api/tasks/${state.selectedTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        branchName: taskDetail.querySelector("[name='branchName']")?.value || "",
        prUrl: taskDetail.querySelector("[name='prUrl']")?.value || "",
      }),
    });
    await loadState();
    return;
  }

  const relationshipButton = event.target.closest("[data-action='save-relationships']");
  if (relationshipButton && state.selectedTaskId) {
    await api(`/api/tasks/${state.selectedTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        parentTaskId: taskDetail.querySelector("[name='detailParentTaskId']")?.value || "",
        dependsOnTaskIds: taskDetail.querySelector("[name='detailDependsOnTaskIds']")?.value || "",
      }),
    });
    await loadState();
    return;
  }

  const qaDecisionButton = event.target.closest("[data-qa-decision]");
  if (qaDecisionButton && state.selectedTaskId) {
    await api(`/api/tasks/${state.selectedTaskId}/qa-decision`, {
      method: "POST",
      body: JSON.stringify({
        outcome: qaDecisionButton.dataset.qaDecision,
        notes: taskDetail.querySelector("[name='qaDecisionNotes']")?.value || "",
        author: "Owner QA",
      }),
    });
    await loadState();
    return;
  }

  const updateStatusButton = event.target.closest("[data-action='update-status']");
  if (updateStatusButton && state.selectedTaskId) {
    const nextStatus = taskDetail.querySelector("[name='taskStatusUpdate']")?.value;
    if (!nextStatus) return;
    await api(`/api/tasks/${state.selectedTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadState();
    return;
  }

  const statusButton = event.target.closest("[data-status]");
  if (!statusButton || !state.selectedTaskId) return;
  await api(`/api/tasks/${state.selectedTaskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: statusButton.dataset.status }),
  });
  await loadState();
});

taskDetail.addEventListener("submit", async (event) => {
  const reviewForm = event.target.closest("[data-review-form]");
  if (reviewForm && state.selectedTaskId) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(reviewForm).entries());
    await api(`/api/tasks/${state.selectedTaskId}/reviews`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    reviewForm.reset();
    await loadState();
    return;
  }

  const form = event.target.closest("[data-comment-form]");
  if (!form || !state.selectedTaskId) return;
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  await api(`/api/tasks/${state.selectedTaskId}/comments`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  form.reset();
  await loadState();
});

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(projectForm);
  const body = Object.fromEntries(form.entries());
  body.reviewPolicy = {
    trustLeadApprovals: form.get("trustLeadApprovals") === "on",
    integrationBranch: form.get("integrationBranch") || "",
  };
  delete body.trustLeadApprovals;
  delete body.integrationBranch;
  await api("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
  projectForm.reset();
  await loadState();
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(taskForm);
  const body = Object.fromEntries(form.entries());
  const result = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  taskForm.reset();
  taskCreateDialog.close();
  if (result.task?.id) window.history.pushState(null, "", taskPath(result.task.id));
  await loadState();
});

newTaskButton.addEventListener("click", () => {
  const activeProject = activeProjectForNewTask();
  if (activeProject) taskForm.elements.project.value = activeProject.key;
  taskCreateDialog.showModal();
  window.setTimeout(() => taskForm.elements.title.focus(), 0);
});

taskCreateDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-task-create]")) taskCreateDialog.close();
});

refreshButton.addEventListener("click", () => {
  loadState().catch((error) => alert(error.message));
});

automationButton.addEventListener("click", async () => {
  try {
    const project = state.projects.find((item) => item.id === state.selectedProjectId);
    const result = await api("/api/automation/tick", {
      method: "POST",
      body: JSON.stringify({
        project: project?.key || project?.id || "",
        limit: 10,
      }),
    });
    await loadState();
    alert(result.actions?.length ? result.actions.join("\n") : "No automation actions.");
  } catch (error) {
    alert(error.message);
  }
});

window.addEventListener("hashchange", () => {
  loadState().catch((error) => alert(error.message));
});

window.addEventListener("popstate", () => {
  loadState().catch((error) => alert(error.message));
});

imageModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-image-modal]")) closeImageModal();
});

taskModal.addEventListener("click", async (event) => {
  if (event.target.closest("[data-close-task-modal]")) {
    closeTaskModal();
    return;
  }
  const taskPreviewButton = event.target.closest("[data-task-preview-id]");
  if (taskPreviewButton) {
    await openTaskModal(taskPreviewButton.dataset.taskPreviewId);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageModal.hidden) closeImageModal();
});

statusFilter.addEventListener("change", () => {
  state.statusFilter = statusFilter.value;
  render();
});

loadState().catch((error) => {
  document.body.innerHTML = `<main class="panel"><h1>StudioOps failed to load</h1><p>${escapeHtml(error.message)}</p></main>`;
});
