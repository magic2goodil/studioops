const FORBIDDEN_INTEGRATION_BRANCHES = new Set([
  "main",
  "master",
  "production",
]);

function booleanFlag(value) {
  if (value === true) return true;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

export function integrationBranchName(project = {}) {
  return String(
    project.integrationBranch
    || project.qaIntegrationBranch
    || project.reviewPolicy?.integrationBranch
    || project.reviewPolicy?.reviewBranch
    || "",
  ).trim();
}

export function trustLeadApprovalsEnabled(project = {}) {
  return booleanFlag(project.trustLeadApprovals ?? project.reviewPolicy?.trustLeadApprovals ?? project.reviewPolicy?.trustLeads);
}

export function integrationBranchSafetyError(project = {}, branchName = integrationBranchName(project)) {
  const branch = String(branchName || "").trim();
  if (!branch) return "Integration branch is not configured.";

  const normalized = branch.toLowerCase();
  if (FORBIDDEN_INTEGRATION_BRANCHES.has(normalized)) {
    return `Integration branch ${branch} is protected; use a non-production QA branch instead.`;
  }

  const defaultBranch = String(project.defaultBranch || "").trim().toLowerCase();
  if (defaultBranch && normalized === defaultBranch) {
    return `Integration branch ${branch} matches the project default branch.`;
  }

  return "";
}

export function projectUsesTrustLeadQa(project = {}) {
  return trustLeadApprovalsEnabled(project) && !integrationBranchSafetyError(project);
}

export function repoWebUrl(project = {}) {
  const raw = String(project.repoUrl || "").trim();
  if (!raw) return "";
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;
  return raw.startsWith("https://github.com/") ? raw.replace(/\.git$/, "") : "";
}

export function branchWebUrl(project = {}, branchName = integrationBranchName(project)) {
  const webUrl = repoWebUrl(project);
  const branch = String(branchName || "").trim();
  if (!webUrl || !branch) return "";
  return `${webUrl}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}
