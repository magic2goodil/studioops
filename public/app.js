const state = {
  projects: [],
  tasks: [],
  selectedProjectId: "",
  selectedTaskId: "",
  statusFilter: "",
};

const projectList = document.querySelector("#projectList");
const taskBoard = document.querySelector("#taskBoard");
const taskDetail = document.querySelector("#taskDetail");
const projectForm = document.querySelector("#projectForm");
const taskForm = document.querySelector("#taskForm");
const refreshButton = document.querySelector("#refreshButton");
const statusFilter = document.querySelector("#statusFilter");
const projectCount = document.querySelector("#projectCount");
const configStatus = document.querySelector("#configStatus");

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

function taskUrl(taskId) {
  return `${window.location.origin}${window.location.pathname}#${encodeURIComponent(taskId)}`;
}

function attachmentList(attachments) {
  if (!attachments?.length) return "";
  return `
    <h3>Visual Attachments</h3>
    <div class="attachment-list">
      ${attachments.map((item) => `
        <div class="attachment-item">
          <strong>${escapeHtml(item.label || item.url || "Attachment")}</strong>
          <span>${escapeHtml(item.type || "reference")}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>
          ${item.url ? `<code>${escapeHtml(item.url)}</code>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

async function loadState() {
  const data = await api("/api/state");
  state.projects = data.projects || [];
  state.tasks = data.tasks || [];
  const hashTaskId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  const linkedTask = hashTaskId ? state.tasks.find((task) => task.id === hashTaskId) : null;
  if (linkedTask) {
    state.selectedTaskId = linkedTask.id;
    state.selectedProjectId = linkedTask.projectId;
  }
  if (!state.selectedProjectId && state.projects[0]) state.selectedProjectId = state.projects[0].id;
  if (!state.selectedTaskId && state.tasks[0]) state.selectedTaskId = state.tasks[0].id;
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

async function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    taskDetail.innerHTML = `<p>Select a task to view prompts and review metadata.</p>`;
    return;
  }
  const project = projectFor(task);
  const builderPrompt = await api(`/api/tasks/${task.id}/prompt?role=builder`);
  const reviewerPrompt = await api(`/api/tasks/${task.id}/prompt?role=reviewer`);
  const link = taskUrl(task.id);
  taskDetail.innerHTML = `
    <div class="detail-title">${escapeHtml(task.title)}</div>
    <p>${escapeHtml(project?.name || "Unknown project")} · ${escapeHtml(task.status)} · ${escapeHtml(task.priority)}</p>
    <p>${escapeHtml(task.description || "No description yet.")}</p>
    ${task.userStory ? `<h3>User Story</h3><p>${escapeHtml(task.userStory)}</p>` : ""}
    ${task.expectedOutcome ? `<h3>Expected Outcome</h3><p>${escapeHtml(task.expectedOutcome)}</p>` : ""}
    ${attachmentList(task.attachments)}
    <h3>Task Link</h3>
    <p><a class="plain-link" href="#${escapeHtml(task.id)}">${escapeHtml(link)}</a></p>
    <div class="detail-actions">
      <button type="button" data-status="ready">Ready</button>
      <button type="button" data-status="in_progress">In Progress</button>
      <button type="button" data-status="builder_review">Builder Review</button>
      <button type="button" data-status="user_review">User Review</button>
      <button type="button" data-status="done">Done</button>
    </div>
    <h3>Builder Prompt</h3>
    <div class="prompt-box">${escapeHtml(builderPrompt.prompt)}</div>
    <h3>Reviewer Prompt</h3>
    <div class="prompt-box">${escapeHtml(reviewerPrompt.prompt)}</div>
  `;
}

function render() {
  renderProjects();
  renderTasks();
  renderDetail().catch((error) => {
    taskDetail.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  });
}

projectList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) return;
  state.selectedProjectId = button.dataset.projectId;
  state.selectedTaskId = visibleTasks()[0]?.id || "";
  if (state.selectedTaskId) window.history.replaceState(null, "", `#${encodeURIComponent(state.selectedTaskId)}`);
  render();
});

taskBoard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  state.selectedTaskId = button.dataset.taskId;
  window.history.replaceState(null, "", `#${encodeURIComponent(state.selectedTaskId)}`);
  render();
});

taskDetail.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-status]");
  if (!button || !state.selectedTaskId) return;
  await api(`/api/tasks/${state.selectedTaskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: button.dataset.status }),
  });
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
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  taskForm.reset();
  await loadState();
});

refreshButton.addEventListener("click", () => {
  loadState().catch((error) => alert(error.message));
});

window.addEventListener("hashchange", () => {
  loadState().catch((error) => alert(error.message));
});

statusFilter.addEventListener("change", () => {
  state.statusFilter = statusFilter.value;
  render();
});

loadState().catch((error) => {
  document.body.innerHTML = `<main class="panel"><h1>Mission Control failed to load</h1><p>${escapeHtml(error.message)}</p></main>`;
});
