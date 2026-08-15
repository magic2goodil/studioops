import assert from "node:assert/strict";
import test from "node:test";
import { buildOwnerInbox } from "../src/owner-inbox.js";
import { createCandidateEnvelope, manifestDigest } from "../src/candidate-manifest.js";
import { exactShaEvidenceFixture } from "./exact-sha-evidence-fixture.js";

const SUBJECT_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);
const PROMOTION_SHA = "d".repeat(40);
const PREVIEW_URL = "http://127.0.0.1:5080/";
const INTEGRATION_BRANCH = "qa/candidate-dollos";

function currentReviews() {
  return [
    ["backend", "backend_review", "backend-reviewer"],
    ["frontend", "frontend_review", "frontend-reviewer"],
    ["accessibility", "accessibility_review", "accessibility-reviewer"],
    ["lead", "lead_review", "lead-reviewer"],
  ].map(([stageKey, status, role], index) => ({
    id: `review_${index + 1}`,
    taskId: "task_7",
    projectId: "project_1",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: SUBJECT_SHA,
    stageKey,
    status,
    role,
    outcome: "approved",
    createdAt: `2026-07-23T15:0${index}:00.000Z`,
  }));
}

function fixtureState() {
  return {
    meta: {},
    projects: [{
      id: "project_1",
      key: "dollos",
      name: "DollOS",
      localQaPreview: {
        previewUrl: PREVIEW_URL,
      },
      reviewPolicy: {
        integrationBranch: "qa/dollos",
      },
    }],
    tasks: [{
      id: "task_7",
      projectId: "project_1",
      title: "Fix ritual duration",
      status: "user_review",
      assignedAgentRole: "owner",
      reviewCycle: 1,
      reviewSubjectSha: SUBJECT_SHA,
      reviewSubjectCycle: 1,
      branchName: "codex/dollos-task_7",
      prUrl: "https://github.com/example/dollos/pull/36",
      acceptanceCriteria: [
        "The updated ritual duration is visible in the local preview.",
      ],
      updatedAt: "2026-07-23T15:02:00.000Z",
    }],
    runs: [{
      id: "run_32",
      projectId: "project_1",
      taskId: "task_7",
      actionType: "notify_owner",
      status: "notified",
      notificationStatus: "sent",
      notificationChannel: "macos",
      externalNotifiedAt: "2026-07-23T15:02:36.000Z",
    }],
    reviews: currentReviews(),
    qaBundles: [],
    candidates: [],
  };
}

function candidateManifest() {
  return {
    candidateId: "candidate_1",
    projectId: "project_1",
    base: {
      branch: "main",
      sha: BASE_SHA,
    },
    sources: [{
      taskId: "task_7",
      sourceRef: "refs/heads/codex/dollos-task_7",
      headSha: SUBJECT_SHA,
      candidateCycle: 1,
      reviews: [{
        id: "review_1",
        stageKey: "lead",
        role: "lead-reviewer",
        outcome: "approved",
        subjectSha: SUBJECT_SHA,
        candidateCycle: 1,
        reviewedAt: "2026-07-23T15:00:00.000Z",
      }],
    }],
    integration: {
      branch: INTEGRATION_BRANCH,
      sha: INTEGRATION_SHA,
    },
    checks: [{
      id: "check_1",
      kind: "local-validation",
      name: "npm run check",
      outcome: "passed",
      subjectSha: INTEGRATION_SHA,
      evidenceDigest: `sha256:${"e".repeat(64)}`,
    }],
    validationEvidence: exactShaEvidenceFixture(INTEGRATION_SHA),
    preview: {
      url: PREVIEW_URL,
      status: "healthy",
      commitSha: INTEGRATION_SHA,
      verifiedAt: "2026-07-23T15:04:00.000Z",
      attestation: {
        kind: "header",
        key: "x-studioops-commit",
        observedSha: INTEGRATION_SHA,
      },
    },
    assembly: {
      mode: "atomic",
      requestedTaskIds: ["task_7"],
      includedTaskIds: ["task_7"],
      excludedTaskIds: [],
    },
  };
}

function addCurrentBundle(state, status = "ready", input = {}) {
  const candidate = createCandidateEnvelope({
    qaBundleId: "qa_bundle_1",
    manifest: candidateManifest(),
    createdAt: "2026-07-23T15:04:00.000Z",
  });
  const releaseReady = status === "release_candidate_ready";
  if (releaseReady) {
    candidate.status = "release_candidate_ready";
    candidate.qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha: candidate.manifest.integration.sha,
      taskIds: ["task_7"],
      repositoryVerifiedAt: "2026-07-23T15:04:30.000Z",
      author: "Owner QA",
      notes: "Validated locally.",
      decidedAt: "2026-07-23T15:04:45.000Z",
    };
    candidate.promotion = {
      branch: "release/candidate-dollos",
      prUrl: input.promotionPrUrl || "",
      commitSha: PROMOTION_SHA,
      manifestDigest: candidate.manifestDigest,
      readyAt: "2026-07-23T15:05:00.000Z",
    };
  }
  state.tasks[0] = {
    ...state.tasks[0],
    status: releaseReady ? "user_review" : "qa_review",
    integrationStatus: "ready",
    qaBundleId: "qa_bundle_1",
    candidateId: candidate.id,
  };
  state.qaBundles = [{
    id: "qa_bundle_1",
    projectId: "project_1",
    status,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationBranch: INTEGRATION_BRANCH,
    integrationCommit: INTEGRATION_SHA,
    previewUrl: input.previewUrl === undefined ? PREVIEW_URL : input.previewUrl,
    promotionBranch: releaseReady ? candidate.promotion.branch : "",
    promotionPrUrl: input.promotionPrUrl || "",
    promotionCommit: releaseReady ? candidate.promotion.commitSha : "",
    promotedTaskIds: releaseReady ? ["task_7"] : [],
    qaDecision: releaseReady ? candidate.qaDecision : null,
    tasks: [{ id: "task_7" }],
    updatedAt: "2026-07-23T15:05:00.000Z",
  }];
  state.candidates = [candidate];
}

function group(inbox, id) {
  return inbox.groups.find((item) => item.id === id);
}

test("current owner exceptions remain decision-counted after desktop notification delivery", () => {
  const inbox = buildOwnerInbox(fixtureState());
  assert.equal(inbox.count, 1);
  assert.equal(inbox.counts.decisions, 1);
  assert.equal(inbox.items[0].classification, "owner_exception");
  assert.equal(inbox.items[0].taskId, "task_7");
  assert.equal(inbox.items[0].notification.status, "sent");
  assert.equal(inbox.items[0].prUrl, "https://github.com/example/dollos/pull/36");
  assert.equal(inbox.items[0].checklist[0].taskId, "task_7");
  assert.match(inbox.items[0].checklist[0].text, /ritual duration/);
});

test("standalone owner decisions require every current exact-SHA review", () => {
  const state = fixtureState();
  state.reviews = state.reviews.filter((review) => review.stageKey !== "backend");

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.legacy, 1);
  assert.equal(group(inbox, "legacy").items[0].classification, "legacy_record");
});

test("standalone owner decisions accept full SHA-256 Git object IDs", () => {
  const state = fixtureState();
  const subjectSha = "f".repeat(64);
  state.tasks[0].reviewSubjectSha = subjectSha;
  for (const review of state.reviews) review.subjectSha = subjectSha;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(inbox.counts.decisions, 1);
});

test("legacy user_review records remain visible without incrementing owner decisions", () => {
  const state = fixtureState();
  state.tasks[0].reviewSubjectSha = "";

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.totalCount, 1);
  assert.equal(inbox.counts.legacy, 1);
  assert.equal(group(inbox, "legacy").items[0].kind, "legacy_owner_review");
  assert.match(group(inbox, "legacy").items[0].nextAction, /not QA-ready/);
  assert.equal(group(inbox, "legacy").items[0].primaryAction.label, "Open historical task");
});

test("non-Trust-Leads standalone QA requires current review evidence and exposes preview plus task", () => {
  const state = fixtureState();
  state.tasks[0].status = "qa_review";
  state.tasks[0].integrationStatus = "ready";

  const inbox = buildOwnerInbox(state);
  const decision = group(inbox, "decisions").items[0];
  assert.equal(inbox.count, 1);
  assert.equal(decision.kind, "qa_review");
  assert.equal(decision.previewUrl, "http://127.0.0.1:5080/");
  assert.equal(decision.taskUrl, "/tasks/task_7");
  assert.equal(decision.primaryAction.type, "preview");
});

test("Trust Leads QA handoffs remain legacy until integration and preview validation are ready", () => {
  const state = fixtureState();
  state.projects[0].reviewPolicy = {
    trustLeadApprovals: true,
    integrationBranch: "qa/dollos",
  };
  state.tasks[0].status = "qa_review";
  delete state.tasks[0].integrationStatus;

  let inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.legacy, 1);

  state.tasks[0].integrationStatus = "ready";
  inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 1);
  assert.equal(group(inbox, "decisions").items[0].kind, "qa_review");
});

test("desktop delivery failures remain visible on a current owner decision", () => {
  const state = fixtureState();
  state.runs[0] = {
    ...state.runs[0],
    notificationStatus: "failed",
    notificationError: "osascript unavailable",
    notificationFailedAt: "2026-07-23T15:03:00.000Z",
    externalNotifiedAt: "",
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(group(inbox, "decisions").items[0].notification.status, "failed");
  assert.equal(group(inbox, "decisions").items[0].notification.error, "osascript unavailable");
  assert.equal(group(inbox, "decisions").items[0].notification.attemptedAt, "2026-07-23T15:03:00.000Z");
});

test("open circuits and operator pauses remain operational without becoming owner decisions", () => {
  const state = fixtureState();
  state.meta.operatorPause = {
    active: true,
    reason: "Incident recovery",
  };
  state.tasks[0] = {
    ...state.tasks[0],
    status: "blocked",
    automationBlocker: {
      type: "circuit",
      reason: "sdk_error",
      attempts: 2,
    },
    automationCircuit: {
      state: "open",
      normalizedReason: "Automatic attempts were exhausted.",
      attemptsConsumed: 2,
      maxAttempts: 2,
      resumeAction: "studioops circuit-reset --task task_7 --reason verified",
    },
  };

  const inbox = buildOwnerInbox(state);
  const operation = group(inbox, "operations").items[0];
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(inbox.operatorPause.active, true);
  assert.equal(operation.kind, "automation_blocked");
  assert.equal(operation.blocker.attempts, 2);
  assert.match(operation.nextAction, /circuit-reset/);
  assert.equal(operation.primaryAction.label, "Open recovery task");
  assert.doesNotMatch(operation.nextAction, /code review/i);
});

test("project circuits remain visibly resettable in Operations", () => {
  const state = fixtureState();
  state.tasks[0].status = "ready";
  state.projects[0].automationCircuit = {
    state: "open",
    normalizedReason: "Repository access is unavailable.",
    openedAt: "2026-07-23T15:04:00.000Z",
  };

  const inbox = buildOwnerInbox(state);
  const operation = group(inbox, "operations").items[0];
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(operation.kind, "project_automation_blocked");
  assert.equal(operation.blocker.reason, "Repository access is unavailable.");
  assert.match(operation.primaryAction.value, /circuit-reset --project dollos/);
  assert.equal(operation.notification.status, "not_applicable");
});

test("immutable ready QA bundles expose preview and task evidence as one decision", () => {
  const state = fixtureState();
  addCurrentBundle(state);

  const inbox = buildOwnerInbox(state);
  const decision = group(inbox, "decisions").items[0];
  assert.equal(state.candidates[0].status, "frozen");
  assert.equal(inbox.count, 1);
  assert.equal(decision.kind, "qa_bundle");
  assert.equal(decision.primaryAction.type, "preview");
  assert.equal(decision.tasks[0].id, "task_7");
  assert.equal(decision.tasks[0].taskUrl, "/tasks/task_7");
  assert.equal(decision.checklist[0].taskId, "task_7");
  assert.match(decision.checklist[0].text, /ritual duration/);
});

test("release candidates count only with immutable evidence and a concrete PR action", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });

  const inbox = buildOwnerInbox(state);
  const decision = group(inbox, "decisions").items[0];
  assert.equal(inbox.count, 1);
  assert.equal(decision.classification, "release_approval");
  assert.equal(decision.primaryAction.type, "pr");
  assert.equal(decision.primaryAction.href, "https://github.com/example/dollos/pull/99");
});

test("release candidates without a passed immutable QA decision route to Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });
  state.candidates[0].qaDecision = null;
  state.qaBundles[0].qaDecision = null;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("release candidates with stale QA decision bindings route to Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });
  state.candidates[0].qaDecision.integrationSha = BASE_SHA;
  state.qaBundles[0].qaDecision = state.candidates[0].qaDecision;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("malformed QA task membership fails closed without crashing the inbox", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });
  state.candidates[0].qaDecision.taskIds = { task_7: true };
  state.qaBundles[0].qaDecision = state.candidates[0].qaDecision;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("release candidates with unsafe or local primary actions route to Operations", () => {
  for (const promotionPrUrl of [
    "javascript:alert(1)",
    "/Users/example/.codex/private-checkout",
    "//external.example/release",
  ]) {
    const state = fixtureState();
    addCurrentBundle(state, "release_candidate_ready", { promotionPrUrl });

    const inbox = buildOwnerInbox(state);
    assert.equal(inbox.count, 0, promotionPrUrl);
    assert.equal(inbox.counts.operations, 1, promotionPrUrl);
    assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
    assert.doesNotMatch(JSON.stringify(inbox), /\/Users\/example|javascript:|external\.example/);
  }
});

test("release candidates with a mismatched promotion handoff route to Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });
  state.candidates[0].promotion.prUrl = "https://github.com/example/dollos/pull/98";

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("current bundles with missing owner handoff evidence route to Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "ready", { previewUrl: "" });
  state.projects[0].localQaPreview.previewUrl = "";

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].kind, "qa_preview_blocked");
  assert.match(group(inbox, "operations").items[0].nextAction, /before asking the owner/);
});

test("active bundles with invalid candidate evidence route to Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  state.candidates[0].manifest.integration.sha = "not-a-sha";

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
  assert.match(group(inbox, "operations").items[0].blocker.reason, /candidate evidence/);
});

test("candidate manifest mutations fail closed even when their digest is replaced", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  state.candidates[0].manifest.internalOverride = true;
  state.candidates[0].manifestDigest = manifestDigest(state.candidates[0].manifest);
  state.qaBundles[0].manifestDigest = state.candidates[0].manifestDigest;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("candidate digest mismatches fail closed", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  state.candidates[0].manifestDigest = `sha256:${"f".repeat(64)}`;
  state.qaBundles[0].manifestDigest = state.candidates[0].manifestDigest;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("candidate checks that no longer pass fail closed even with a recomputed digest", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  state.candidates[0].manifest.checks[0].outcome = "failed";
  state.candidates[0].manifestDigest = manifestDigest(state.candidates[0].manifest);
  state.qaBundles[0].manifestDigest = state.candidates[0].manifestDigest;

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
});

test("legacy QA bundles remain available without being promoted to decisions", () => {
  const state = fixtureState();
  state.tasks[0].status = "qa_review";
  state.tasks[0].qaBundleId = "qa_bundle_1";
  state.qaBundles = [{
    id: "qa_bundle_1",
    projectId: "project_1",
    status: "legacy_untrusted",
    legacyStatus: "ready",
    previewUrl: "http://127.0.0.1:5080/",
    tasks: [{ id: "task_7" }],
    updatedAt: "2026-07-23T15:05:00.000Z",
  }];

  const inbox = buildOwnerInbox(state);
  const legacy = group(inbox, "legacy").items[0];
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.legacy, 1);
  assert.equal(legacy.kind, "legacy_qa_bundle");
  assert.equal(legacy.status, "ready");
  assert.match(legacy.nextAction, /not bound to current immutable QA evidence/);
});

test("synthetic circuit failures are explicitly labeled non-production diagnostics", () => {
  const state = fixtureState();
  state.tasks[0].status = "ready";
  state.projects[0] = {
    ...state.projects[0],
    key: "fixture",
    name: "Circuit Fixture",
    automationCircuit: {
      state: "open",
      normalizedReason: "Synthetic failure.",
      resumeAction: "studioops circuit-probe --project fixture",
    },
  };

  const operation = group(buildOwnerInbox(state), "operations").items[0];
  assert.equal(operation.diagnostic, true);
  assert.equal(operation.diagnosticLabel, "Non-production diagnostic");
  assert.equal(operation.classification, "non_production_diagnostic");
  assert.match(operation.nextAction, /not production work/);
});

test("inbox response items expose only whitelisted project identity fields", () => {
  const state = fixtureState();
  state.projects[0].repoPath = "/private/studioops/repositories/dollos";
  state.projects[0].repoUrl = "https://token@example.invalid/private.git";
  state.projects[0].qaIntegration = {
    internalMarker: "private-project-config",
    localPreview: {
      previewUrl: PREVIEW_URL,
      checkoutPath: "/private/studioops/preview-checkout",
    },
  };
  addCurrentBundle(state);

  const inbox = buildOwnerInbox(state);
  for (const item of inbox.items) {
    assert.equal(Object.hasOwn(item, "project"), false);
    assert.equal(typeof item.projectId, "string");
    assert.equal(typeof item.projectKey, "string");
    assert.equal(typeof item.projectName, "string");
  }
  const responseBody = JSON.stringify(inbox);
  assert.doesNotMatch(responseBody, /private-project-config/);
  assert.doesNotMatch(responseBody, /\/private\/studioops/);
  assert.doesNotMatch(responseBody, /token@example/);
});

test("owner-facing operational strings redact local paths and credential-shaped values", () => {
  const state = fixtureState();
  state.tasks[0].status = "blocked";
  state.tasks[0].automationBlocker = {
    reason: "Read /Users/example/.codex/studioops/private-checkout with token=secret-value",
  };
  state.runs[0].notificationError = "Bearer abcdefghijklmnopqrstuvwxyz failed at file:///tmp/private.log";

  const responseBody = JSON.stringify(buildOwnerInbox(state));
  assert.doesNotMatch(responseBody, /\/Users\/example/);
  assert.doesNotMatch(responseBody, /file:\/\/\/tmp/);
  assert.doesNotMatch(responseBody, /secret-value/);
  assert.doesNotMatch(responseBody, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(responseBody, /\[local path\]/);
  assert.match(responseBody, /\[redacted credential\]/);
});

test("empty, stale, and mixed-category summaries are deterministic and rendering is read-only", () => {
  const empty = buildOwnerInbox({
    meta: {},
    projects: [],
    tasks: [],
    runs: [],
    qaBundles: [],
    candidates: [],
  }, { now: "2026-07-26T12:00:00.000Z" });
  assert.equal(empty.count, 0);
  assert.equal(empty.totalCount, 0);
  assert.deepEqual(empty.counts, { decisions: 0, operations: 0, legacy: 0 });
  assert.equal(empty.groups.length, 3);

  const state = fixtureState();
  state.tasks[0].updatedAt = "2026-07-20T12:00:00.000Z";
  state.tasks.push({
    id: "task_8",
    projectId: "project_1",
    title: "Old handoff",
    status: "user_review",
    assignedAgentRole: "owner",
    reviewSubjectSha: "",
    updatedAt: "2026-07-25T12:00:00.000Z",
  }, {
    id: "task_9",
    projectId: "project_1",
    title: "Automation recovery",
    status: "blocked",
    automationBlocker: { reason: "worker_failed" },
    updatedAt: "2026-07-26T11:00:00.000Z",
  });
  const before = structuredClone(state);
  const mixed = buildOwnerInbox(state, {
    now: "2026-07-26T12:00:00.000Z",
    staleAfterMs: 24 * 60 * 60 * 1000,
  });

  assert.equal(mixed.count, 1);
  assert.deepEqual(mixed.counts, { decisions: 1, operations: 1, legacy: 1 });
  assert.equal(mixed.totalCount, 3);
  assert.equal(group(mixed, "decisions").items[0].stale, true);
  assert.equal(group(mixed, "decisions").items[0].ageMs, 6 * 24 * 60 * 60 * 1000);
  assert.equal(group(mixed, "decisions").oldestAt, "2026-07-20T12:00:00.000Z");
  assert.deepEqual(state, before, "building the inbox must not mutate workflow records");
});
