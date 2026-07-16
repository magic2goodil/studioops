const state = {
  projects: [],
  tasks: [],
  selectedProjectId: "",
  selectedTaskId: "",
  routeTaskId: "",
  statusFilter: "",
};

const appLayout = document.querySelector("#appLayout");
const projectList = document.querySelector("#projectList");
const taskBoard = document.querySelector("#taskBoard");
const taskDetail = document.querySelector("#taskDetail");
const projectForm = document.querySelector("#projectForm");
const taskForm = document.querySelector("#taskForm");
const refreshButton = document.querySelector("#refreshButton");
const statusFilter = document.querySelector("#statusFilter");
const projectCount = document.querySelector("#projectCount");
const configStatus = document.querySelector("#configStatus");
const detailPanel = document.querySelector(".detail-panel");
const detailHeading = document.querySelector(".detail-panel .panel-header h2");
const imageModal = document.querySelector("#imageModal");
const imageModalImage = document.querySelector("#imageModalImage");
const imageModalCaption = document.querySelector("#imageModalCaption");

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

function linkifyText(value) {
  return escapeHtml(value).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
}

function taskPath(taskId) {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

function taskUrl(taskId) {
  return `${window.location.origin}${taskPath(taskId)}`;
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
    ? "Local config loaded from mission-control.config.md"
    : "No mission-control.config.md yet. Run npm run setup or mission-control setup.";
  render();
}

function projectFor(task) {
  return state.projects.find((project) => project.id === task.projectId) || null;
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
}

function renderTasks() {
  const tasks = visibleTasks();
  taskBoard.innerHTML = tasks.map((task) => {
    const project = projectFor(task);
    return `
      <button type="button" class="task-card ${task.id === state.selectedTaskId ? "selected" : ""}" data-task-id="${escapeHtml(task.id)}">
        <div class="task-card-top">
          <span class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
          <span class="priority">${escapeHtml(task.priority)}</span>
        </div>
        <h3>${escapeHtml(task.title)}</h3>
        <p>${escapeHtml(task.description || "No description yet.")}</p>
        <small>${escapeHtml(project?.key || "unknown")} · ${escapeHtml(task.type || "task")}${task.attachments?.length ? ` · ${task.attachments.length} attachment${task.attachments.length === 1 ? "" : "s"}` : ""}</small>
      </button>
    `;
  }).join("") || `<p>No tasks match this view.</p>`;
}

function renderBranchPanel(task, project) {
  const branchHref = branchUrl(project, task.branchName);
  const prUrl = String(task.prUrl || "").trim();
  return `
    <section class="detail-section branch-section">
      <div class="section-heading">
        <h3>Git Association</h3>
        <span>${escapeHtml(task.branchName || "No branch linked yet")}</span>
      </div>
      <div class="branch-links">
        ${branchHref ? `<a href="${escapeHtml(branchHref)}" target="_blank" rel="noreferrer">Open Feature Branch</a>` : `<span class="empty-pill">Add a GitHub repo URL and branch name to open the branch.</span>`}
        ${prUrl ? `<a href="${escapeHtml(prUrl)}" target="_blank" rel="noreferrer">Open Pull Request</a>` : `<span class="empty-pill">No PR linked yet</span>`}
      </div>
      <div class="branch-edit-grid">
        <label>Feature Branch <input name="branchName" value="${escapeHtml(task.branchName || "")}" placeholder="codex/project-task-short-title"></label>
        <label>Pull Request URL <input name="prUrl" value="${escapeHtml(task.prUrl || "")}" placeholder="https://github.com/owner/repo/pull/123"></label>
        <button type="button" data-action="save-git-links">Save Git Links</button>
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
        <h3>Builder Notes & PR Updates</h3>
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
      <form class="comment-form" data-comment-form>
        <label>Author <input name="author" value="Codex Builder"></label>
        <label>Comment <textarea name="body" rows="4" placeholder="What changed, validation results, PR link, known gaps..."></textarea></label>
        <button type="submit">Add Comment</button>
      </form>
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
  const builderPrompt = await api(`/api/tasks/${task.id}/prompt?role=builder`);
  const reviewerPrompt = await api(`/api/tasks/${task.id}/prompt?role=reviewer`);
  const link = taskUrl(task.id);
  const isFullPage = Boolean(state.routeTaskId);
  taskDetail.innerHTML = `
    ${isFullPage ? `<button class="back-link" type="button" data-action="back-to-board">Back to board</button>` : ""}
    <div class="detail-hero">
      <div>
        <div class="detail-title">${escapeHtml(fullTask.title)}</div>
        <p>${escapeHtml(project?.name || "Unknown project")} · ${escapeHtml(fullTask.status)} · ${escapeHtml(fullTask.priority)}</p>
      </div>
      ${!isFullPage ? `<a href="${escapeHtml(link)}">Open Full Page</a>` : ""}
    </div>
    <div class="detail-grid ${isFullPage ? "detail-grid-full" : ""}">
      <section class="detail-section">
        <h3>Description</h3>
        <p>${escapeHtml(fullTask.description || "No description yet.")}</p>
        ${fullTask.userStory ? `<h3>User Story</h3><p>${escapeHtml(fullTask.userStory)}</p>` : ""}
        ${fullTask.expectedOutcome ? `<h3>Expected Outcome</h3><p>${escapeHtml(fullTask.expectedOutcome)}</p>` : ""}
      </section>
      ${renderBranchPanel(fullTask, project)}
      ${renderStandardsPanel(project)}
    </div>
    ${attachmentList(fullTask.attachments)}
    <h3>Task Link</h3>
    <p><a class="plain-link" href="${escapeHtml(taskPath(task.id))}">${escapeHtml(link)}</a></p>
    <div class="detail-actions">
      <button type="button" data-status="ready">Ready</button>
      <button type="button" data-status="in_progress">In Progress</button>
      <button type="button" data-status="builder_review">Builder Review</button>
      <button type="button" data-status="user_review">User Review</button>
      <button type="button" data-status="done">Done</button>
    </div>
    ${renderComments(fullTask.comments || [])}
    <h3>Builder Prompt</h3>
    <div class="prompt-box">${escapeHtml(builderPrompt.prompt)}</div>
    <h3>Reviewer Prompt</h3>
    <div class="prompt-box">${escapeHtml(reviewerPrompt.prompt)}</div>
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

projectList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) return;
  state.selectedProjectId = button.dataset.projectId;
  state.selectedTaskId = visibleTasks()[0]?.id || "";
  state.routeTaskId = "";
  window.history.pushState(null, "", "/");
  render();
});

taskBoard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  state.selectedTaskId = button.dataset.taskId;
  window.history.pushState(null, "", taskPath(state.selectedTaskId));
  loadState().catch((error) => alert(error.message));
});

taskDetail.addEventListener("click", async (event) => {
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

  const statusButton = event.target.closest("[data-status]");
  if (!statusButton || !state.selectedTaskId) return;
  await api(`/api/tasks/${state.selectedTaskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: statusButton.dataset.status }),
  });
  await loadState();
});

taskDetail.addEventListener("submit", async (event) => {
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
  if (result.task?.id) window.history.pushState(null, "", taskPath(result.task.id));
  await loadState();
});

refreshButton.addEventListener("click", () => {
  loadState().catch((error) => alert(error.message));
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

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageModal.hidden) closeImageModal();
});

statusFilter.addEventListener("change", () => {
  state.statusFilter = statusFilter.value;
  render();
});

loadState().catch((error) => {
  document.body.innerHTML = `<main class="panel"><h1>Mission Control failed to load</h1><p>${escapeHtml(error.message)}</p></main>`;
});
