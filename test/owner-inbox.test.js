import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertCurrentOwnerQaPacket,
  buildOwnerInbox,
  buildOwnerQaPacket,
} from "../src/owner-inbox.js";
import {
  canonicalJson,
  createCandidateEnvelope,
  manifestDigest,
} from "../src/candidate-manifest.js";

const SUBJECT_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);
const PROMOTION_SHA = "d".repeat(40);
const PREVIEW_URL = "http://127.0.0.1:5080/";
const INTEGRATION_BRANCH = "qa/candidate-dollos";

function withPacketDigest(packet) {
  const { packetDigest: _discarded, ...base } = packet;
  return {
    ...base,
    packetDigest: `sha256:${createHash("sha256").update(canonicalJson(base)).digest("hex")}`,
  };
}

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
      repoUrl: "https://github.com/example/dollos",
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
  const packet = buildOwnerQaPacket(state, candidate, {
    bundle: state.qaBundles[0],
    generatedAt: "2026-07-23T15:04:10.000Z",
  });
  candidate.qaPacket = packet;
  state.qaBundles[0].qaPacket = packet;
  state.qaBundles[0].packetDigest = packet.packetDigest;
  if (releaseReady) {
    candidate.qaDecision.ownerQaPacketDigest = packet.packetDigest;
    state.qaBundles[0].qaDecision = candidate.qaDecision;
  }
}

function addPendingQaRevocation(state, input = {}) {
  const candidate = state.candidates[0];
  candidate.qaRevocationIntent = {
    schemaVersion: "studioops.qa-revocation-intent.v1",
    requestId: "qa_revocation_11111111-1111-4111-8111-111111111111",
    outcome: "failed",
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    ownerQaPacketDigest: candidate.qaPacket.packetDigest,
    taskIds: candidate.manifest.sources.map((source) => source.taskId).sort(),
    author: "Owner QA",
    notes: "Revoke this approval.",
    requestedAt: "2026-07-23T15:06:00.000Z",
  };
  if (input.settlement) candidate.qaRevocationSettlement = input.settlement;
}

function group(inbox, id) {
  return inbox.groups.find((item) => item.id === id);
}

test("owner QA packet v2 snapshots complete approval authority and detects definition drift", () => {
  const state = fixtureState();
  state.projects[0] = {
    ...state.projects[0],
    description: "Owner-visible product scope",
    repoPath: "/workspace/dollos",
    repoUrl: "https://github.com/example/dollos",
    validationCommands: ["npm test"],
    contextLinks: ["https://example.com/product-brief"],
    standards: ["modular architecture"],
    safetyRules: ["Never expose credentials"],
    deliveryPolicy: { profile: "standard" },
  };
  state.tasks[0] = {
    ...state.tasks[0],
    description: "Change the exact ritual duration.",
    expectedOutcome: "The owner sees the intended duration.",
    validationPlan: ["npm test"],
    dependsOnTaskIds: [],
    architectureDecision: "Use the existing duration service.",
    deliveryMode: "functional",
    attachments: [{ id: "attachment_1", name: "reference.png" }],
    branchName: "codex/dollos-task_7",
    prUrl: "https://github.com/example/dollos/pull/7",
    operationalLocalArtifactRef: "artifact://owner-preview/task_7",
    candidateIdentity: {
      commitSha: SUBJECT_SHA,
      treeSha: "e".repeat(40),
      baseSha: BASE_SHA,
      branch: "codex/dollos-task_7",
      candidateCycle: 1,
    },
  };
  addCurrentBundle(state);

  const packet = assertCurrentOwnerQaPacket(state, state.candidates[0], state.qaBundles[0]);
  assert.equal(packet.schemaVersion, "studioops.owner-qa-packet.v2");
  assert.equal(packet.project.definition.reviewPolicy.integrationBranch, "qa/dollos");
  assert.deepEqual(packet.project.definition.safetyRules, ["Never expose credentials"]);
  assert.deepEqual(packet.project.validationCommands, ["npm test"]);
  assert.deepEqual(packet.project.definition.contextLinks, ["https://example.com/product-brief"]);
  assert.equal(packet.tasks[0].definition.expectedOutcome, "The owner sees the intended duration.");
  assert.deepEqual(packet.tasks[0].acceptanceCriteria, state.tasks[0].acceptanceCriteria);
  assert.deepEqual(packet.tasks[0].validation.plan, ["npm test"]);
  assert.deepEqual(packet.tasks[0].dependencies, []);
  assert.equal(packet.tasks[0].architecture.decision, "Use the existing duration service.");
  assert.equal(packet.tasks[0].delivery.mode, "functional");
  assert.equal(packet.tasks[0].attachments[0].id, "attachment_1");
  assert.equal(packet.tasks[0].definition.branchName, "codex/dollos-task_7");
  assert.equal(packet.tasks[0].definition.prUrl, "https://github.com/example/dollos/pull/7");
  assert.equal(packet.tasks[0].definition.operationalLocalArtifactRef, "artifact://owner-preview/task_7");
  assert.equal(packet.tasks[0].candidateIdentity.commitSha, SUBJECT_SHA);
  assert.match(packet.packetDigest, /^sha256:[a-f0-9]{64}$/);

  state.tasks[0].acceptanceCriteria = ["Changed after packet generation"];
  assert.throws(
    () => assertCurrentOwnerQaPacket(state, state.candidates[0], state.qaBundles[0]),
    /no longer matches current project or task definitions/,
  );
});

test("owner QA packet validation rejects unsupported schemas and candidate/bundle packet divergence", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  const candidate = state.candidates[0];
  const bundle = state.qaBundles[0];

  assert.throws(
    () => buildOwnerQaPacket(state, candidate, { generatedAt: "2026-07-23T15:04:10.000Z" }),
    /requires an authoritative QA bundle/,
  );

  candidate.qaPacket = withPacketDigest({
    ...candidate.qaPacket,
    schemaVersion: "studioops.owner-qa-packet.v0",
  });
  assert.throws(() => assertCurrentOwnerQaPacket(state, candidate, bundle), /Unsupported owner QA packet schema/);

  candidate.qaPacket = bundle.qaPacket;
  bundle.packetDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => assertCurrentOwnerQaPacket(state, candidate, bundle),
    /Candidate and bundle owner QA packet records do not match/,
  );
});

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

test("a stale circuit does not duplicate a current QA decision as an Operations failure", () => {
  const state = fixtureState();
  addCurrentBundle(state);
  state.tasks[0] = {
    ...state.tasks[0],
    status: "qa_review",
    candidateId: state.candidates[0].id,
    automationCircuit: {
      state: "open",
      openedAt: "2026-07-23T14:00:00.000Z",
      snapshot: {
        status: "queued",
        assignedAgentRole: "",
        reviewCycle: 0,
        reviewSubjectCycle: 0,
        reviewSubjectSha: "",
        candidateIdentity: null,
        branchName: "",
      },
    },
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(group(inbox, "decisions").items[0].kind, "qa_bundle");
  assert.equal(group(inbox, "operations").items.some((item) => item.taskId === state.tasks[0].id), false);
});

test("a blocked circuit with candidate drift is not reported as a current Operations failure", () => {
  const state = fixtureState();
  state.tasks[0] = {
    ...state.tasks[0],
    status: "blocked",
    assignedAgentRole: "owner",
    reviewSubjectSha: "f".repeat(40),
    candidateIdentity: {
      commitSha: "f".repeat(40),
      treeSha: "e".repeat(40),
      baseSha: BASE_SHA,
      branch: "codex/dollos-task_7",
      candidateCycle: 2,
    },
    automationBlocker: {
      type: "circuit",
      reason: "attempt_budget_exhausted",
      resumeStatus: "backend_review",
    },
    automationCircuit: {
      state: "open",
      snapshot: {
        status: "backend_review",
        assignedAgentRole: "backend-reviewer",
        reviewCycle: 1,
        reviewSubjectCycle: 1,
        reviewSubjectSha: SUBJECT_SHA,
        candidateIdentity: {
          commitSha: SUBJECT_SHA,
          treeSha: "e".repeat(40),
          baseSha: BASE_SHA,
          branch: "codex/dollos-task_7",
          candidateCycle: 1,
        },
        branchName: "codex/dollos-task_7",
      },
    },
  };

  const inbox = buildOwnerInbox(state);
  assert.equal(group(inbox, "operations").items.some((item) => item.taskId === state.tasks[0].id), false);
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
  assert.match(decision.title, /local QA ready/);
  assert.match(decision.summary, /duration/i);
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

test("release candidates with a PR in another GitHub repository route to non-actionable Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/attacker/forged-release/pull/99",
  });

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.decisions, 0);
  assert.equal(inbox.counts.operations, 1);
  const operation = group(inbox, "operations").items[0];
  assert.equal(operation.status, "candidate_evidence_invalid");
  assert.equal(operation.primaryAction.type, "task");
  assert.doesNotMatch(JSON.stringify(inbox), /attacker|forged-release|Review release candidate/);
});

test("release candidates with durable QA revocation intent route to non-actionable Operations", () => {
  const state = fixtureState();
  addCurrentBundle(state, "release_candidate_ready", {
    promotionPrUrl: "https://github.com/example/dollos/pull/99",
  });
  addPendingQaRevocation(state);

  const inbox = buildOwnerInbox(state);
  const operation = group(inbox, "operations").items[0];
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.decisions, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(operation.classification, "revocation_pending");
  assert.equal(operation.kind, "qa_revocation_pending");
  assert.equal(operation.status, "revocation_pending");
  assert.equal(operation.bundleId, "qa_bundle_1");
  assert.equal(operation.candidateId, "candidate_1");
  assert.equal(operation.prUrl, "");
  assert.equal(operation.primaryAction.type, "task");
  assert.match(operation.nextAction, /durable QA revocation request/i);
  assert.doesNotMatch(JSON.stringify(inbox), /Review release candidate|release_approval/);
});

test("remote revocation settlement cannot restore release approval before local invalidation", () => {
  for (const status of ["closed", "merged"]) {
    const state = fixtureState();
    addCurrentBundle(state, "release_candidate_ready", {
      promotionPrUrl: "https://github.com/example/dollos/pull/99",
    });
    addPendingQaRevocation(state, {
      settlement: {
        schemaVersion: "studioops.qa-revocation-settlement.v1",
        status,
        prUrl: "https://github.com/example/dollos/pull/99",
        observedAt: "2026-07-23T15:07:00.000Z",
        mergeCommit: status === "merged" ? "e".repeat(40) : "",
        mergedAt: status === "merged" ? "2026-07-23T15:06:30.000Z" : "",
      },
    });

    const inbox = buildOwnerInbox(state);
    assert.equal(inbox.count, 0, status);
    assert.equal(inbox.counts.operations, 1, status);
    assert.equal(group(inbox, "operations").items[0].classification, "revocation_pending", status);
  }
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
  addCurrentBundle(state);
  state.qaBundles[0].previewUrl = "";
  state.projects[0].localQaPreview.previewUrl = "";

  const inbox = buildOwnerInbox(state);
  assert.equal(inbox.count, 0);
  assert.equal(inbox.counts.operations, 1);
  assert.equal(group(inbox, "operations").items[0].status, "candidate_evidence_invalid");
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
