const COPY_SOURCE = "./content-contract.json";
const TASK_TABS = [
  ["brief", "brief"],
  ["activity", "activity"],
  ["reviews", "reviews"],
  ["qa-evidence", "qaEvidence"],
  ["dependencies", "dependencies"],
  ["runs", "runs"],
];

const response = await fetch(COPY_SOURCE, { cache: "no-store" });
if (!response.ok) {
  throw new Error("The checksum-protected product copy could not be loaded.");
}
const copy = await response.json();

function copyValue(path) {
  return path.split(".").reduce((value, key) => value?.[key], copy) ?? "";
}

function formatCopy(template, values) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function hydrateStaticCopy() {
  document.querySelectorAll("[data-copy]").forEach((element) => {
    element.textContent = copyValue(element.dataset.copy);
  });
  document.querySelectorAll("[data-copy-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", copyValue(element.dataset.copyAriaLabel));
  });
  document.querySelectorAll("[data-copy-alt]").forEach((element) => {
    element.setAttribute("alt", copyValue(element.dataset.copyAlt));
  });
  document.title = copy.shell.documentTitle;
}

function referenceChip() {
  return `<span class="reference-chip">${escapeHtml(copy.brand.referenceBadge)}</span>`;
}

function decisionRow({ title, meta, history, state, tone, action, href = "", unavailable = false }) {
  const primary = unavailable
    ? `<button class="button button--disabled" type="button" disabled>${escapeHtml(action)}</button>`
    : `<a class="button button--primary" href="${escapeHtml(href)}">${escapeHtml(action)}</a>`;
  return `
    <article class="decision-row">
      <div class="decision-row__copy">
        <h3 class="decision-row__title">${escapeHtml(title)}</h3>
        <p class="decision-row__meta">${escapeHtml(meta)}</p>
      </div>
      <p class="decision-row__history">${escapeHtml(history)}</p>
      <span class="status-badge status-badge--${tone}">${escapeHtml(state)}</span>
      ${primary}
      <button class="icon-button" type="button" disabled aria-label="${escapeHtml(formatCopy(copy.actions.openMenuFor, { title }))}">•••</button>
    </article>
  `;
}

function renderActionRequired() {
  return `
    <section class="route action-route" aria-labelledby="page-title">
      <header class="page-header">
        <div class="page-header__copy">
          <p class="eyebrow">${escapeHtml(copy.actionRequired.eyebrow)}</p>
          <h1 id="page-title" tabindex="-1">${escapeHtml(copy.actionRequired.title)}</h1>
          <p class="lede">${escapeHtml(copy.actionRequired.intro)}</p>
        </div>
        ${referenceChip()}
      </header>
      <div class="decision-stack">
        <section class="decision-group" aria-labelledby="qa-group">
          <header class="decision-group__header">
            <h2 id="qa-group">${escapeHtml(copy.actionRequired.qaGroup)}</h2>
            <span>${escapeHtml(copy.actionRequired.oneItem)}</span>
          </header>
          ${decisionRow({
            title: copy.actionRequired.qaTitle,
            meta: copy.actionRequired.qaMeta,
            history: copy.actionRequired.qaHistory,
            state: copy.actionRequired.readyState,
            tone: "success",
            action: copy.actions.reviewCandidate,
            href: "#/qa/candidates/candidate_synthetic",
          })}
        </section>
        <section class="decision-group" aria-labelledby="release-group">
          <header class="decision-group__header">
            <h2 id="release-group">${escapeHtml(copy.actionRequired.releaseGroup)}</h2>
            <span>${escapeHtml(copy.actionRequired.oneItem)}</span>
          </header>
          ${decisionRow({
            title: copy.actionRequired.releaseTitle,
            meta: copy.actionRequired.releaseMeta,
            history: copy.actionRequired.releaseHistory,
            state: copy.actionRequired.authorityState,
            tone: "warning",
            action: copy.actions.approveRelease,
            unavailable: true,
          })}
        </section>
        <section class="decision-group" aria-labelledby="exception-group">
          <header class="decision-group__header">
            <h2 id="exception-group">${escapeHtml(copy.actionRequired.exceptionGroup)}</h2>
            <span>${escapeHtml(copy.actionRequired.oneOverdue)}</span>
          </header>
          ${decisionRow({
            title: copy.actionRequired.exceptionTitle,
            meta: copy.actionRequired.exceptionMeta,
            history: copy.actionRequired.exceptionHistory,
            state: copy.actionRequired.overdueState,
            tone: "danger",
            action: copy.actions.openTask,
            href: "#/tasks/task_synthetic",
          })}
        </section>
        <section class="decision-group" aria-labelledby="incident-group">
          <header class="decision-group__header">
            <h2 id="incident-group">${escapeHtml(copy.actionRequired.incidentGroup)}</h2>
            <span>${escapeHtml(copy.actionRequired.oneItem)}</span>
          </header>
          ${decisionRow({
            title: copy.actionRequired.incidentTitle,
            meta: copy.actionRequired.incidentMeta,
            history: copy.actionRequired.incidentHistory,
            state: copy.actionRequired.pausedState,
            tone: "warning",
            action: copy.actions.inspectIncident,
            href: "#/operations",
          })}
        </section>
      </div>
    </section>
  `;
}

function renderTask() {
  const tabs = TASK_TABS.map(([slug, copyKey], index) => `
    <button
      type="button"
      role="tab"
      aria-selected="${index === 0 ? "true" : "false"}"
      aria-controls="task-panel"
      tabindex="${index === 0 ? "0" : "-1"}"
      ${index === 0 ? "" : "disabled"}
    >${escapeHtml(copy.task[copyKey])}</button>
  `).join("");
  return `
    <article class="route task-route" aria-labelledby="page-title">
      <nav class="breadcrumb" aria-label="${escapeHtml(copy.task.breadcrumbLabel)}">
        <a href="#/work">${escapeHtml(copy.navigation.work)}</a> /
        <span>${escapeHtml(copy.task.project)}</span>
      </nav>
      <header class="page-header">
        <div class="page-header__copy">
          <p class="eyebrow">${escapeHtml(copy.task.project)} · ${escapeHtml(copy.task.id)}</p>
          <h1 id="page-title" tabindex="-1">${escapeHtml(copy.task.title)}</h1>
          <p class="lede">${escapeHtml(copy.task.summary)}</p>
          <div class="task-meta">
            <span class="status-badge status-badge--success">${escapeHtml(copy.task.state)}</span>
            <span>${escapeHtml(copy.task.priorityLabel)}</span>
            <span>${escapeHtml(copy.task.owner)}</span>
            <span>${escapeHtml(copy.task.updated)}</span>
          </div>
        </div>
        ${referenceChip()}
      </header>
      <div class="tabs" role="tablist" aria-label="${escapeHtml(copy.task.workspaceLabel)}">
        ${tabs}
      </div>
      <div id="task-panel" class="brief-grid" role="tabpanel" aria-label="${escapeHtml(copy.task.brief)}">
        <section class="panel">
          <h2>${escapeHtml(copy.task.outcomeLabel)}</h2>
          <p>${escapeHtml(copy.task.outcome)}</p>
        </section>
        <section class="panel">
          <h2>${escapeHtml(copy.task.criteriaLabel)}</h2>
          <ul class="criteria-list">
            <li>${escapeHtml(copy.task.criterionOne)}</li>
            <li>${escapeHtml(copy.task.criterionTwo)}</li>
            <li>${escapeHtml(copy.task.criterionThree)}</li>
          </ul>
        </section>
      </div>
      <details class="diagnostics">
        <summary>${escapeHtml(copy.task.diagnostics)}</summary>
        <p>${escapeHtml(copy.task.diagnosticsSummary)}</p>
      </details>
    </article>
  `;
}

function renderCandidate() {
  return `
    <article class="route candidate-route" aria-labelledby="page-title">
      <header class="page-header">
        <div class="page-header__copy">
          <p class="eyebrow">${escapeHtml(copy.candidate.eyebrow)}</p>
          <h1 id="page-title" tabindex="-1">${escapeHtml(copy.candidate.title)}</h1>
          <p class="lede">${escapeHtml(copy.candidate.summary)}</p>
        </div>
        ${referenceChip()}
      </header>
      <section class="integrity-banner" aria-label="${escapeHtml(copy.candidate.integrity)}">
        <div class="integrity-banner__title"><span aria-hidden="true">✓</span>${escapeHtml(copy.candidate.integrity)}</div>
        <div class="integrity-banner__item"><small>${escapeHtml(copy.candidate.manifestLabel)}</small>${escapeHtml(copy.candidate.digest)}</div>
        <div class="integrity-banner__item"><small>${escapeHtml(copy.candidate.integrationLabel)}</small>${escapeHtml(copy.candidate.integration)}</div>
        <div class="integrity-banner__item"><small>${escapeHtml(copy.candidate.sourceLabel)}</small>${escapeHtml(copy.candidate.source)}</div>
        <div class="integrity-banner__item"><small>${escapeHtml(copy.candidate.previewLabel)}</small>${escapeHtml(copy.candidate.preview)}</div>
      </section>
      <section class="panel qa-plan">
        <h2>${escapeHtml(copy.candidate.testPlan)}</h2>
        <ol class="qa-steps">
          <li>${escapeHtml(copy.candidate.stepOne)}</li>
          <li>${escapeHtml(copy.candidate.stepTwo)}</li>
          <li>${escapeHtml(copy.candidate.stepThree)}</li>
        </ol>
      </section>
      <aside class="qa-side" aria-label="${escapeHtml(copy.candidate.sideLabel)}">
        <section class="panel">
          <h2>${escapeHtml(copy.candidate.decisionScopeTitle)}</h2>
          <div class="key-value"><small>${escapeHtml(copy.candidate.affected)}</small><span>${escapeHtml(copy.candidate.affectedValue)}</span></div>
          <div class="key-value"><small>${escapeHtml(copy.candidate.evidence)}</small><span>${escapeHtml(copy.candidate.evidenceValue)}</span></div>
          <div class="key-value"><small>${escapeHtml(copy.candidate.risk)}</small><span>${escapeHtml(copy.candidate.riskValue)}</span></div>
        </section>
        <section class="panel decision-card">
          <h2>${escapeHtml(copy.candidate.ownerDecisionTitle)}</h2>
          <p>${escapeHtml(copy.candidate.decisionNote)}</p>
          <button class="button button--disabled" type="button" disabled>${escapeHtml(copy.candidate.decisionUnavailable)}</button>
        </section>
      </aside>
    </article>
  `;
}

function renderPlaceholder(routeCopy, heading) {
  return `
    <section class="route" aria-labelledby="page-title">
      <header class="page-header">
        <div class="page-header__copy">
          <p class="eyebrow">${escapeHtml(routeCopy.eyebrow)}</p>
          <h1 id="page-title" tabindex="-1">${escapeHtml(heading)}</h1>
          <p class="lede">${escapeHtml(routeCopy.description)}</p>
        </div>
        ${referenceChip()}
      </header>
      <section class="panel">
        <h2>${escapeHtml(copy.placeholders.contractTitle)}</h2>
        <p>${escapeHtml(copy.placeholders.contractBody)}</p>
      </section>
    </section>
  `;
}

function routeState() {
  const hash = window.location.hash.replace(/^#/, "") || "/portfolio";
  if (hash.startsWith("/tasks/")) return { key: "work", content: renderTask };
  if (hash.startsWith("/qa/candidates/")) return { key: "qa", content: renderCandidate };
  if (hash === "/actions") return { key: "actions", content: renderActionRequired };
  if (hash === "/work") return { key: "work", content: () => renderPlaceholder(copy.placeholders.work, copy.navigation.work) };
  if (hash === "/qa") return { key: "qa", content: () => renderPlaceholder(copy.placeholders.qa, copy.navigation.qaRelease) };
  if (hash === "/operations") return { key: "operations", content: () => renderPlaceholder(copy.placeholders.operations, copy.navigation.operations) };
  if (hash === "/policies") return { key: "policies", content: () => renderPlaceholder(copy.placeholders.policies, copy.navigation.policies) };
  return { key: "portfolio", content: () => renderPlaceholder(copy.placeholders.portfolio, copy.navigation.portfolio) };
}

function render({ moveFocus = false } = {}) {
  const route = routeState();
  const main = document.querySelector("main");
  main.innerHTML = route.content();
  document.querySelectorAll("[data-nav], [data-mobile-nav]").forEach((link) => {
    const active = link.dataset.nav === route.key || link.dataset.mobileNav === route.key;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (moveFocus) {
    document.querySelector("#page-title")?.focus({ preventScroll: true });
  }
}

hydrateStaticCopy();
render();
window.addEventListener("hashchange", () => render({ moveFocus: true }));
