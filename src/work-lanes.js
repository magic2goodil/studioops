const FRONTEND_TYPES = new Set([
  "frontend",
  "component",
  "ui",
  "ux",
  "styles",
  "style",
  "sass",
  "css",
  "page",
  "accessibility",
  "a11y",
]);

const DESIGN_TYPES = new Set([
  "design",
  "designer",
  "mockup",
  "mockup-critique",
  "information-architecture",
  "content-model",
]);

const BACKEND_TYPES = new Set([
  "backend",
  "data",
  "api",
  "auth",
  "security",
  "privacy",
  "analytics",
  "queue",
  "integration",
]);

const DEVOPS_TYPES = new Set([
  "devops",
  "deploy",
  "deployment",
  "release",
  "ci",
  "github-actions",
  "infrastructure",
]);

function normalize(value) {
  return String(value || "").trim().toLowerCase().replaceAll("_", "-");
}

function textIncludesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function roleLane(role) {
  const normalized = normalize(role);
  if (!normalized) return "";
  if (normalized.includes("architect")) return "project-wide";
  if (normalized.includes("lead")) return "project-wide";
  if (normalized.includes("backend")) return "backend";
  if (normalized.includes("frontend")) return "frontend";
  if (normalized.includes("accessibility") || normalized.includes("a11y")) return "frontend";
  if (normalized.includes("design")) return "design";
  if (normalized.includes("owner")) return "owner";
  return "";
}

function actorIsReadOnly(actor = {}) {
  const role = normalize(actor.role);
  const actionType = normalize(actor.actionType || actor.type);
  return actionType === "start-architecture" || role === "systems-architect";
}

export function inferTaskLane(task = {}, role = "") {
  const explicit = normalize(task.lane);
  if (explicit) return explicit;

  const fromRole = roleLane(role);
  if (fromRole) return fromRole;

  const type = normalize(task.type);
  const area = normalize(task.area);
  if (DEVOPS_TYPES.has(type) || DEVOPS_TYPES.has(area)) return "devops";
  if (DESIGN_TYPES.has(type) || DESIGN_TYPES.has(area)) return "design";
  if (FRONTEND_TYPES.has(type) || FRONTEND_TYPES.has(area)) return "frontend";
  if (BACKEND_TYPES.has(type) || BACKEND_TYPES.has(area)) return "backend";

  const text = normalize(`${task.title || ""} ${task.description || ""} ${task.userStory || ""} ${task.expectedOutcome || ""}`);
  if (textIncludesAny(text, ["deploy", "release", "github action", "ci", "workflow", "production"])) return "devops";
  if (textIncludesAny(text, ["mockup", "design", "visual", "layout", "typography", "figma", "image"])) return "design";
  if (textIncludesAny(text, ["css", "sass", "frontend", "component", "responsive", "browser", "page", "ui", "ux", "accessibility", "a11y"])) return "frontend";
  if (textIncludesAny(text, ["api", "database", "postgres", "auth", "session", "migration", "index", "queue", "privacy", "security"])) return "backend";

  return "product";
}

export function fileScopeForLane(lane, task = {}) {
  if (Array.isArray(task.workAreas) && task.workAreas.length) return task.workAreas;
  switch (normalize(lane)) {
    case "backend":
      return ["src/**", "db/**", "migrations/**", "server/**", "api/**", "package*.json"];
    case "frontend":
      return ["public/**", "src/styles/**", "views/**", "templates/**", "assets/**", "package*.json"];
    case "design":
      return ["public/**", "src/styles/**", "assets/**", "docs/mockup-intake/**", "design/**"];
    case "devops":
      return [".github/**", "deploy/**", "docs/*deployment*", "package*.json", "Dockerfile", "docker-compose*.yml"];
    case "project-wide":
      return ["**/*"];
    case "owner":
      return [];
    default:
      return ["docs/**", "README.md"];
  }
}

export function conflictGroupForLane(lane) {
  switch (normalize(lane)) {
    case "backend":
      return "backend";
    case "frontend":
    case "design":
      return "frontend-surface";
    case "devops":
      return "devops";
    case "project-wide":
      return "project-wide";
    case "owner":
      return "owner";
    default:
      return "product";
  }
}

export function laneProfile(task = {}, actor = {}) {
  if (actorIsReadOnly(actor)) {
    return {
      lane: "architecture-readonly",
      conflictGroup: "read-only",
      fileScope: [],
      fileScopeExplicit: true,
    };
  }
  const role = actor.role || task.assignedAgentRole || "";
  const lane = normalize(actor.lane) || inferTaskLane(task, role);
  const actorHasFileScope = Array.isArray(actor.fileScope) && actor.fileScope.length > 0;
  const taskHasFileScope = Array.isArray(task.workAreas) && task.workAreas.length > 0;
  const fileScope = actorHasFileScope
    ? actor.fileScope
    : fileScopeForLane(lane, task);
  return {
    lane,
    conflictGroup: conflictGroupForLane(lane),
    fileScope,
    fileScopeExplicit: actor.fileScopeExplicit === true
      || actor.scopeExplicit === true
      || taskHasFileScope,
  };
}

function normalizeScopePattern(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function literalPatternPrefix(value) {
  const pattern = normalizeScopePattern(value);
  const wildcardIndex = pattern.search(/[?*[\]{}]/);
  return wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
}

function scopePatternIsAmbiguous(pattern) {
  return pattern.startsWith("/")
    || /^[a-z]:\//i.test(pattern)
    || pattern.split("/").includes("..")
    || pattern.includes("\0");
}

function scopePairMayOverlap(left, right) {
  const leftPattern = normalizeScopePattern(left);
  const rightPattern = normalizeScopePattern(right);
  if (!leftPattern || !rightPattern) return true;
  if (scopePatternIsAmbiguous(leftPattern) || scopePatternIsAmbiguous(rightPattern)) return true;
  if (leftPattern === rightPattern) return true;

  const leftHasWildcard = /[?*[\]{}]/.test(leftPattern);
  const rightHasWildcard = /[?*[\]{}]/.test(rightPattern);
  if (!leftHasWildcard && !rightHasWildcard) {
    return leftPattern.startsWith(`${rightPattern}/`)
      || rightPattern.startsWith(`${leftPattern}/`);
  }

  const leftPrefix = literalPatternPrefix(leftPattern);
  const rightPrefix = literalPatternPrefix(rightPattern);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

export function fileScopesMayOverlap(leftScope, rightScope) {
  if (!Array.isArray(leftScope) || !leftScope.length) return true;
  if (!Array.isArray(rightScope) || !rightScope.length) return true;
  return leftScope.some((left) => rightScope.some((right) => scopePairMayOverlap(left, right)));
}

export function laneProfilesConflict(left, right) {
  if (!left || !right) return false;
  if (left.projectId && right.projectId && left.projectId !== right.projectId) return false;
  if (left.conflictGroup === "read-only" || right.conflictGroup === "read-only") return false;
  if (left.conflictGroup === "owner" || right.conflictGroup === "owner") return false;
  if (left.conflictGroup === "project-wide" || right.conflictGroup === "project-wide") return true;
  const bothScopesExplicit = left.fileScopeExplicit === true && right.fileScopeExplicit === true;
  if (left.conflictGroup === right.conflictGroup && !bothScopesExplicit) return true;
  if (!bothScopesExplicit) return false;
  return fileScopesMayOverlap(left.fileScope, right.fileScope);
}
