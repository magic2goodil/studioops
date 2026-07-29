const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const TERMINAL_HOTFIX_STATUSES = new Set(["rejected", "succeeded", "failed", "cancelled", "expired"]);

export const HOTFIX_PROHIBITED_CHANGE_FLAGS = Object.freeze([
  "mixedScope",
  "broadScope",
  "binaryOrUninspectable",
  "migrationChanges",
  "workflowChanges",
  "secretMaterial",
  "stateDeletion",
  "unrelatedFeatureChanges",
]);

export const HOTFIX_RELEASE_TRANSITIONS = Object.freeze({
  authorized: Object.freeze(["executing", "cancelled", "expired"]),
  executing: Object.freeze(["succeeded", "failed", "cancelled"]),
});

function fail(code, diagnostic, evidence = {}) {
  return {
    ok: false,
    code,
    diagnostics: sanitizeHotfixDiagnostics([diagnostic]),
    ...evidence,
  };
}

function normalizedWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function parseHotfixAuthorizationPhrase(value) {
  const requestedPhrase = String(value || "");
  const normalizedPhrase = normalizedWhitespace(requestedPhrase).toLowerCase();
  let match = normalizedPhrase.match(
    /^green-light ([a-z0-9][a-z0-9_-]*) hotfix pr #([1-9][0-9]*) for production$/,
  );
  if (match) {
    return {
      requestedPhrase,
      normalizedPhrase,
      projectKey: match[1],
      subject: {
        kind: "pull_request",
        pullRequestNumber: Number(match[2]),
      },
    };
  }
  match = normalizedPhrase.match(
    /^green-light ([a-z0-9][a-z0-9_-]*) hotfix commit ([0-9a-f]{40}) for production$/,
  );
  if (!match) return null;
  return {
    requestedPhrase,
    normalizedPhrase,
    projectKey: match[1],
    subject: {
      kind: "commit",
      commitSha: match[2],
    },
  };
}

export const parseOwnerHotfixAuthorization = parseHotfixAuthorizationPhrase;

export function assertHotfixAuthorizationPhrase(value) {
  const parsed = parseHotfixAuthorizationPhrase(value);
  if (!parsed) {
    throw new Error(
      "Owner hotfix authorization must use exactly “green-light <project-key> hotfix PR #<number> for production” or “green-light <project-key> hotfix commit <40-hex-sha> for production”.",
    );
  }
  return parsed;
}

function canonicalRepository(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized.startsWith("github.com/") ? normalized : "";
}

function pullRequestNumber(value) {
  const direct = Number(value?.number ?? value?.pullRequestNumber ?? value?.prNumber);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  const match = String(value?.url || value?.prUrl || value?.htmlUrl || "").match(/\/pull\/([1-9][0-9]*)(?:[/?#]|$)/i);
  return match ? Number(match[1]) : 0;
}

function pullRequestRepository(value) {
  const direct = value?.repositoryUrl || value?.repoUrl || value?.repository?.url || value?.base?.repo?.html_url;
  if (direct) return canonicalRepository(direct);
  const url = String(value?.url || value?.prUrl || value?.htmlUrl || "");
  const match = url.match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\//i);
  return match ? canonicalRepository(`github.com/${match[1]}`) : "";
}

function pullRequestHeadSha(value) {
  return String(
    value?.headSha
    || value?.headRefOid
    || value?.head?.sha
    || value?.commitSha
    || "",
  ).trim().toLowerCase();
}

function pullRequestBase(value) {
  return String(value?.baseBranch || value?.baseRefName || value?.base?.ref || "").trim();
}

function taskPullRequestNumber(task) {
  return pullRequestNumber({ number: task?.pullRequestNumber, url: task?.prUrl });
}

function taskHasHotfixMarker(task) {
  return task?.productionHotfix === true
    || (Array.isArray(task?.labels) && task.labels.some((label) => String(label).trim().toLowerCase() === "production-hotfix"));
}

function normalizedPullRequests(state, input) {
  const supplied = input?.pullRequests ?? input?.prs ?? input?.pullRequest ?? state?.pullRequests ?? [];
  return (Array.isArray(supplied) ? supplied : [supplied]).filter(Boolean);
}

export function resolveHotfixCandidate(state, parsedAuthorization, input = {}) {
  if (!parsedAuthorization) return fail("invalid_owner_phrase", "The owner phrase is not canonical.");
  if (!PROJECT_KEY.test(parsedAuthorization.projectKey || "")) {
    return fail("invalid_project_key", "The normalized project key is invalid.");
  }
  const projects = (state?.projects || []).filter(
    (project) => String(project.key || "").trim().toLowerCase() === parsedAuthorization.projectKey,
  );
  if (projects.length !== 1) {
    return fail(
      projects.length ? "duplicate_project_mapping" : "missing_project",
      `Expected one project mapping and found ${projects.length}.`,
    );
  }
  const project = projects[0];
  const repository = canonicalRepository(project.repoUrl);
  if (!repository) return fail("missing_project_repository", "The project has no canonical GitHub repository.");

  const subject = parsedAuthorization.subject;
  const pullRequests = normalizedPullRequests(state, input).filter((pullRequest) => {
    if (pullRequestRepository(pullRequest) !== repository) return false;
    if (subject.kind === "pull_request") {
      return pullRequestNumber(pullRequest) === subject.pullRequestNumber;
    }
    return pullRequestHeadSha(pullRequest) === subject.commitSha;
  });
  if (pullRequests.length !== 1) {
    return fail(
      pullRequests.length ? "duplicate_pull_request_mapping" : "missing_pull_request",
      `Expected one GitHub pull request mapping and found ${pullRequests.length}.`,
      { project },
    );
  }
  const pullRequest = pullRequests[0];
  const prNumber = pullRequestNumber(pullRequest);
  const candidateSha = pullRequestHeadSha(pullRequest);
  if (!FULL_GIT_SHA.test(candidateSha)) {
    return fail("invalid_pull_request_head", "The pull request does not expose a full 40-hex head SHA.", { project });
  }
  if (subject.kind === "commit" && subject.commitSha !== candidateSha) {
    return fail("stale_commit_mapping", "The requested commit is not the pull request head.", { project });
  }
  const prState = String(pullRequest.state || "open").trim().toLowerCase();
  if (prState !== "open") return fail("pull_request_not_open", "The pull request is not open.", { project });
  if (pullRequest.isDraft === true || pullRequest.draft === true) {
    return fail("draft_pull_request", "Draft pull requests cannot use the production hotfix exception.", { project });
  }
  const expectedBase = String(project.defaultBranch || "main").trim();
  if (!pullRequestBase(pullRequest) || pullRequestBase(pullRequest) !== expectedBase) {
    return fail("wrong_base_branch", "The pull request base does not match the project default branch.", { project });
  }

  const tasks = (state?.tasks || []).filter((task) => (
    task.projectId === project.id
    && taskPullRequestNumber(task) === prNumber
  ));
  if (tasks.length !== 1) {
    return fail(
      tasks.length ? "duplicate_or_mixed_task_mapping" : "missing_task_mapping",
      `Expected one current StudioOps task mapping and found ${tasks.length}.`,
      { project, pullRequest, candidateSha, pullRequestNumber: prNumber },
    );
  }
  const task = tasks[0];
  if (String(task.reviewSubjectSha || "").toLowerCase() !== candidateSha) {
    return fail(
      "stale_review_subject",
      "The pull request head does not match the task current reviewSubjectSha.",
      { project, pullRequest, task, candidateSha, pullRequestNumber: prNumber },
    );
  }
  return {
    ok: true,
    project,
    pullRequest,
    pullRequestNumber: prNumber,
    task,
    candidateSha,
  };
}

function explicitBoolean(value) {
  return value === true || value === false;
}

export function normalizeLeadHotfixAssessment(value, subjectSha = "") {
  const assessment = value && typeof value === "object" ? value : {};
  const prohibited = assessment.prohibitedChanges && typeof assessment.prohibitedChanges === "object"
    ? assessment.prohibitedChanges
    : {};
  const normalized = {
    kind: String(assessment.kind || assessment.type || "").trim(),
    subjectSha: String(assessment.subjectSha || subjectSha || "").trim().toLowerCase(),
    prohibitedChanges: {},
  };
  for (const flag of HOTFIX_PROHIBITED_CHANGE_FLAGS) {
    normalized.prohibitedChanges[flag] = prohibited[flag];
  }
  return normalized;
}

export function validateLeadHotfixAssessment(value, subjectSha) {
  const assessment = normalizeLeadHotfixAssessment(value, subjectSha);
  if (assessment.kind !== "narrow_production_fix") {
    return fail("missing_narrow_lead_assessment", "Lead review lacks a narrow_production_fix release assessment.");
  }
  if (!FULL_GIT_SHA.test(assessment.subjectSha) || assessment.subjectSha !== subjectSha) {
    return fail("stale_lead_assessment", "Lead release assessment is not bound to the exact candidate SHA.");
  }
  for (const flag of HOTFIX_PROHIBITED_CHANGE_FLAGS) {
    if (!explicitBoolean(assessment.prohibitedChanges[flag])) {
      return fail("incomplete_lead_assessment", `Lead release assessment does not explicitly classify ${flag}.`);
    }
    if (assessment.prohibitedChanges[flag]) {
      return fail("prohibited_lead_assessment", `Lead release assessment identifies prohibited change: ${flag}.`);
    }
  }
  return { ok: true, assessment };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function normalizeHotfixPolicy(project) {
  const source = project?.hotfixPolicy || project?.productionHotfixPolicy || {};
  return {
    enabled: source.enabled === true,
    maxFiles: positiveInteger(source.maxFiles),
    maxChangedLines: positiveInteger(source.maxChangedLines),
    blockedPaths: Array.isArray(source.blockedPaths)
      ? [...new Set(source.blockedPaths.map((item) => String(item).trim()).filter(Boolean))]
      : null,
    requireCompleteTextPatches: source.requireCompleteTextPatches === true,
  };
}

export function validateHotfixPolicy(project) {
  const policy = normalizeHotfixPolicy(project);
  if (!policy.enabled) return fail("hotfix_policy_disabled", "The project production hotfix policy is disabled.");
  if (!policy.maxFiles || !policy.maxChangedLines || policy.blockedPaths === null || !policy.requireCompleteTextPatches) {
    return fail("hotfix_policy_incomplete", "The project production hotfix policy envelope is incomplete.");
  }
  return { ok: true, policy };
}

function filePath(file) {
  return String(file?.path || file?.filename || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function matchesBlockedPath(file, rule) {
  const path = filePath(file);
  const normalizedRule = String(rule || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!path || !normalizedRule) return false;
  if (!normalizedRule.includes("*")) {
    const prefix = normalizedRule.replace(/\/+$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  const expression = normalizedRule
    .split("**").map((part) => part.split("*").map((value) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(path);
}

function addedPatchText(patch) {
  return String(patch || "")
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

function explicitScopeFlag(input, flag) {
  if (input?.prohibitedChanges?.[flag] === true || input?.scopeFlags?.[flag] === true) return true;
  return input?.[flag] === true;
}

export function classifyHotfixScope(files, policy, input = {}) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const flags = Object.fromEntries(HOTFIX_PROHIBITED_CHANGE_FLAGS.map((flag) => [flag, explicitScopeFlag(input, flag)]));
  const diagnostics = [];
  let changedLines = 0;
  const paths = [];
  const declaredScopeIds = new Set();

  if (normalizedFiles.length === 0) {
    flags.binaryOrUninspectable = true;
    diagnostics.push("No changed files were supplied.");
  }
  if (normalizedFiles.length > policy.maxFiles) {
    flags.broadScope = true;
    diagnostics.push(`Changed file count ${normalizedFiles.length} exceeds ${policy.maxFiles}.`);
  }

  for (const file of normalizedFiles) {
    const path = filePath(file);
    paths.push(path);
    const additions = Number(file?.additions);
    const deletions = Number(file?.deletions);
    const patch = file?.patch;
    if (
      !path
      || !Number.isSafeInteger(additions)
      || additions < 0
      || !Number.isSafeInteger(deletions)
      || deletions < 0
      || typeof patch !== "string"
      || !patch
      || file?.binary === true
      || file?.isBinary === true
      || file?.truncated === true
      || file?.patchAvailable === false
    ) {
      flags.binaryOrUninspectable = true;
      diagnostics.push(`${path || "(unknown path)"} lacks a complete inspectable text patch.`);
      continue;
    }
    changedLines += additions + deletions;
    if (policy.blockedPaths.some((rule) => matchesBlockedPath(file, rule))) {
      flags.broadScope = true;
      diagnostics.push(`${path} is blocked by project hotfix policy.`);
    }
    const lowerPath = path.toLowerCase();
    const added = addedPatchText(patch);
    const scopeId = String(file?.scopeId || "").trim();
    if (scopeId) declaredScopeIds.add(scopeId);
    if (
      /(^|\/)(migrations?|schema)(\/|$)|\.(?:ddl|sql)$/i.test(lowerPath)
      || /^\+.*\b(?:create\s+table|alter\s+table|pragma\s+user_version|schema[_ ]version)\b/im.test(added)
    ) flags.migrationChanges = true;
    if (/^\.github\/workflows\/|(^|\/)(?:workflows?|actions?)\/.*\.ya?ml$/i.test(lowerPath)) flags.workflowChanges = true;
    if (
      /(^|\/)\.env(?:\.|$)|(^|\/)(?:secrets?|credentials?)(\/|$)|\.(?:pem|p12|pfx|key)$/i.test(lowerPath)
      || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*['"][^'"]+['"]/i.test(added)
    ) flags.secretMaterial = true;
    if (
      String(file?.status || "").toLowerCase() === "removed"
      || /^\+\s*(?:drop\s+(?:table|database)|truncate\s+table)\b/im.test(added)
      || /^\+\s*delete\s+from\b/im.test(added)
      || /^\+\s*(?:rm\s+-rf|fs\.rmSync|removeRecursive)\b/im.test(added)
    ) flags.stateDeletion = true;
    if (
      file?.relatedToTask === false
      || ["unrelated_feature", "unrelated-feature", "feature"].includes(String(file?.classification || "").toLowerCase())
    ) flags.unrelatedFeatureChanges = true;
    if (String(file?.classification || "").toLowerCase() === "mixed") flags.mixedScope = true;
  }

  if (declaredScopeIds.size > 1) {
    flags.mixedScope = true;
    diagnostics.push("Changed files declare more than one task scope.");
  }
  if (changedLines > policy.maxChangedLines) {
    flags.broadScope = true;
    diagnostics.push(`Changed line count ${changedLines} exceeds ${policy.maxChangedLines}.`);
  }
  for (const flag of HOTFIX_PROHIBITED_CHANGE_FLAGS) {
    if (flags[flag] && !diagnostics.some((item) => item.includes(flag))) diagnostics.push(`Prohibited scope classification: ${flag}.`);
  }
  return {
    ok: HOTFIX_PROHIBITED_CHANGE_FLAGS.every((flag) => flags[flag] === false),
    fileCount: normalizedFiles.length,
    changedLines,
    paths,
    prohibitedChanges: flags,
    diagnostics: sanitizeHotfixDiagnostics(diagnostics),
  };
}

export const assessHotfixScope = classifyHotfixScope;

function leadReviewForEvidence(state, task, evidence) {
  const leadEvidence = [...(evidence?.reviews || [])].reverse().find((review) => (
    String(review.stageKey || "").toLowerCase() === "lead"
    || String(review.role || "").toLowerCase().includes("lead")
  ));
  if (!leadEvidence) return null;
  return (state?.reviews || []).find((review) => review.id === leadEvidence.id) || leadEvidence;
}

export function evaluateHotfixEligibility(state, input = {}) {
  const parsed = input.parsedAuthorization || parseHotfixAuthorizationPhrase(input.phrase || input.requestedPhrase);
  if (!parsed) return fail("invalid_owner_phrase", "The owner phrase is not canonical.");
  const resolved = resolveHotfixCandidate(state, parsed, input);
  if (!resolved.ok) return { ...resolved, parsedAuthorization: parsed };

  const { project, task, pullRequest, candidateSha } = resolved;
  const policyResult = validateHotfixPolicy(project);
  if (!policyResult.ok) return { ...policyResult, parsedAuthorization: parsed, resolved };
  if (!taskHasHotfixMarker(task)) {
    return fail("missing_hotfix_task_marker", "The task lacks the explicit production-hotfix marker.", {
      parsedAuthorization: parsed,
      resolved,
    });
  }
  if (!["bug", "security"].includes(String(task.type || "").trim().toLowerCase())) {
    return fail("invalid_hotfix_task_type", "Only bug or security tasks may use the production hotfix exception.", {
      parsedAuthorization: parsed,
      resolved,
    });
  }

  const reviewEvidence = input.reviewEvidence
    || input.candidateReviewEvidence
    || (typeof input.candidateReviewEvidenceForTask === "function"
      ? input.candidateReviewEvidenceForTask(state, task)
      : null);
  if (!reviewEvidence?.ok) {
    return fail("incomplete_candidate_review", reviewEvidence?.error || "Current candidate review evidence is unavailable.", {
      parsedAuthorization: parsed,
      resolved,
      reviewEvidence: reviewEvidence || null,
    });
  }
  if (reviewEvidence.subjectSha !== candidateSha) {
    return fail("stale_candidate_review", "Review evidence is not bound to the exact pull request head.", {
      parsedAuthorization: parsed,
      resolved,
      reviewEvidence,
    });
  }
  const leadReview = leadReviewForEvidence(state, task, reviewEvidence);
  const assessmentResult = validateLeadHotfixAssessment(leadReview?.releaseAssessment, candidateSha);
  if (!assessmentResult.ok) {
    return { ...assessmentResult, parsedAuthorization: parsed, resolved, reviewEvidence };
  }

  const files = input.files || pullRequest.files || pullRequest.changedFiles || [];
  const scopeEvidence = classifyHotfixScope(files, policyResult.policy, input.scope || input);
  if (!scopeEvidence.ok) {
    return fail("prohibited_hotfix_scope", scopeEvidence.diagnostics.join(" "), {
      parsedAuthorization: parsed,
      resolved,
      reviewEvidence,
      leadAssessment: assessmentResult.assessment,
      scopeEvidence,
    });
  }
  return {
    ok: true,
    code: "eligible",
    diagnostics: [],
    parsedAuthorization: parsed,
    resolved,
    reviewEvidence,
    leadAssessment: assessmentResult.assessment,
    scopeEvidence,
    policy: policyResult.policy,
  };
}

export function sanitizeHotfixDiagnostics(values, maxItems = 12, maxLength = 500) {
  const source = Array.isArray(values) ? values : [values];
  return source
    .map((value) => String(value || "")
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
      .replace(/\b(?:github_pat_|gh[pousr]_)[a-z0-9_]{8,}\b/gi, "[REDACTED]")
      .replace(/\b((?:authorization|bearer|token|secret|password|private[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]")
      .trim()
      .slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function sanitizeHotfixOwnerAttribution(value) {
  const source = value && typeof value === "object" ? value : { id: value };
  const rawId = String(source.id || source.actorId || source.login || "owner").trim();
  const id = (/@|https?:|[\\/]/i.test(rawId) ? "redacted-owner" : rawId)
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 128) || "owner";
  const provider = String(source.provider || source.source || "local")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 32) || "local";
  return { id, provider };
}

export function assertHotfixReleaseTransition(record, nextStatus, executionId = "") {
  const current = String(record?.status || "");
  const target = String(nextStatus || "");
  if (current === target && target === "executing" && record?.execution?.id === executionId) return;
  if (TERMINAL_HOTFIX_STATUSES.has(current)) {
    throw new Error(`Terminal hotfix release ${record?.id || ""} requires a new explicit owner invocation.`);
  }
  if (!(HOTFIX_RELEASE_TRANSITIONS[current] || []).includes(target)) {
    throw new Error(`Invalid hotfix release transition: ${current || "(missing)"} -> ${target || "(missing)"}.`);
  }
}

export function hotfixReleaseIsTerminal(record) {
  return TERMINAL_HOTFIX_STATUSES.has(String(record?.status || ""));
}
