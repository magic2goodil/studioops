import { createHash } from "node:crypto";
import {
  assertCandidateEnvelope,
  canonicalJson,
} from "./candidate-manifest.js";

export const OWNER_QA_PACKET_SCHEMA_VERSION = "studioops.owner-qa-packet.v2";
export const LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION = "studioops.owner-qa-packet.v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OWNER_QA_ACTIONS = Object.freeze([
  "pass",
  "fail",
  "request_changes",
  "defer",
  "open_candidate",
]);

export const OWNER_QA_PROJECT_DEFINITION_FIELDS = Object.freeze([
  "name",
  "description",
  "repoPath",
  "repoUrl",
  "workflowMode",
  "defaultBranch",
  "validationCommands",
  "contextLinks",
  "standards",
  "safetyRules",
  "reviewPipeline",
  "reviewPolicy",
  "qaIntegration",
  "localQaPreview",
  "promotion",
  "deliveryPolicy",
]);

export const OWNER_QA_TASK_DEFINITION_FIELDS = Object.freeze([
  "title",
  "description",
  "priority",
  "type",
  "area",
  "lane",
  "labels",
  "parentTaskId",
  "userStory",
  "expectedOutcome",
  "acceptanceCriteria",
  "affectedSurfaces",
  "workAreas",
  "validationPlan",
  "riskClassification",
  "privacyNotes",
  "securityNotes",
  "dependsOnTaskIds",
  "architectureDecision",
  "architectureWaiver",
  "architectureRequired",
  "architectureStatus",
  "architectureSummary",
  "architectureParentTaskId",
  "architectureDecisionTaskIds",
  "architectureCompletedAt",
  "architectureCompletedBy",
  "deliveryMode",
  "attachments",
  "branchName",
  "prUrl",
  "operationalLocalArtifactRef",
  "impactEvidence",
  "candidateIdentity",
  "knownRisks",
  "risks",
  "accountsOrFixtures",
  "fixtures",
  "resetSteps",
  "evidence",
  "verificationEvidence",
  "migrations",
  "featureFlags",
  "rollback",
]);

function packetError(message) {
  const error = new Error(message);
  error.code = "OWNER_QA_PACKET_INVALID";
  return error;
}

function jsonValue(value, fallback = null) {
  return JSON.parse(JSON.stringify(value === undefined ? fallback : value));
}

function definition(record, fields) {
  return Object.fromEntries(fields.map((field) => [field, jsonValue(record?.[field], null)]));
}

function findProject(state, projectId) {
  return (state?.projects || []).find((project) => project.id === projectId) || null;
}

function findTask(state, taskId) {
  return (state?.tasks || []).find((task) => task.id === taskId) || null;
}

function taskIdList(bundle) {
  return (bundle?.tasks || [])
    .map((task) => String(task?.id || task?.taskId || task || ""))
    .filter(Boolean)
    .sort();
}

function normalizeGeneratedAt(value) {
  const generatedAt = String(value || "").trim();
  const parsed = Date.parse(generatedAt);
  if (!generatedAt || !Number.isFinite(parsed)) throw packetError("Owner QA packet generatedAt must be an ISO timestamp.");
  return new Date(parsed).toISOString();
}

function taskUrl(baseUrl, taskId) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
}

function criterionSteps(task) {
  return (task.acceptanceCriteria || []).map((criterion, index) => {
    const value = typeof criterion === "string" ? { text: criterion } : criterion || {};
    return {
      order: index + 1,
      criterion: String(value.text || value.criterion || value.description || criterion || "").trim(),
      steps: Array.isArray(value.steps) && value.steps.length
        ? value.steps.map(String)
        : [
            "Open the candidate preview and exercise the criterion.",
            "Record observed evidence for this criterion.",
          ],
      expected: String(
        value.expected
        || value.expectedResult
        || "The criterion is satisfied without console errors.",
      ).trim(),
    };
  }).filter((item) => item.criterion);
}

function digestPacketBase(packet) {
  return `sha256:${createHash("sha256").update(canonicalJson(packet)).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function dependencyRecords(state, task, candidateTaskIds) {
  return [...new Set((task.dependsOnTaskIds || []).map(String).filter(Boolean))]
    .sort()
    .map((taskId) => {
      const dependency = findTask(state, taskId);
      return {
        taskId,
        projectId: String(dependency?.projectId || ""),
        title: String(dependency?.title || ""),
        expectedOutcome: String(dependency?.expectedOutcome || ""),
        includedInCandidate: candidateTaskIds.has(taskId),
      };
    });
}

/**
 * The single authoritative gate for owner QA. It fails closed on missing
 * manifest, task membership, check, preview, or bundle identity evidence.
 */
export function candidateCompletenessGate(candidate, state = {}, bundle = null) {
  const reasons = [];
  let manifest;
  try {
    assertCandidateEnvelope(candidate);
    manifest = candidate.manifest;
  } catch (error) {
    reasons.push(`invalid_manifest:${error.message}`);
  }
  if (!manifest) return { ready: false, reasons };
  if (!["frozen", "qa_passed", "release_candidate_ready", "merged"].includes(candidate.status)) {
    reasons.push("candidate_not_frozen");
  }
  if (!candidate.manifestDigest) reasons.push("manifest_digest_missing");
  if (!manifest.sources?.length) reasons.push("candidate_membership_empty");
  const tasks = (manifest.sources || []).map((source) => findTask(state, source.taskId));
  if (tasks.some((task) => !task)) reasons.push("candidate_membership_incomplete");
  if (tasks.some((task) => task && task.projectId !== candidate.projectId)) {
    reasons.push("candidate_cross_project_membership");
  }
  if ((manifest.checks || []).some((check) => (
    check.outcome !== "passed" || check.subjectSha !== manifest.integration.sha
  ))) {
    reasons.push("required_gate_failed");
  }
  if (
    manifest.preview?.status !== "healthy"
    || manifest.preview?.commitSha !== manifest.integration.sha
    || manifest.preview?.attestation?.observedSha !== manifest.integration.sha
  ) {
    reasons.push("preview_not_verified_at_candidate_sha");
  }
  if (bundle && (
    bundle.id !== candidate.qaBundleId
    || bundle.projectId !== candidate.projectId
    || bundle.candidateId !== candidate.id
    || bundle.manifestDigest !== candidate.manifestDigest
    || bundle.integrationBranch !== manifest.integration.branch
    || bundle.integrationCommit !== manifest.integration.sha
    || bundle.previewUrl !== manifest.preview.url
    || canonicalJson(taskIdList(bundle)) !== canonicalJson(
      manifest.sources.map((source) => source.taskId).sort(),
    )
  )) {
    reasons.push("bundle_manifest_mismatch");
  }
  return {
    ready: reasons.length === 0,
    reasons,
    taskIds: (manifest.sources || []).map((source) => source.taskId).sort(),
  };
}

/** Build the canonical immutable owner-facing QA contract for a candidate. */
export function buildOwnerQaPacket(state, candidate, input = {}) {
  const bundle = input.bundle || null;
  if (!bundle) throw packetError("Owner QA packet requires an authoritative QA bundle.");
  const gate = candidateCompletenessGate(candidate, state, bundle);
  if (!gate.ready) throw packetError(`Candidate is not QA-ready: ${gate.reasons.join(", ")}`);
  const project = findProject(state, candidate.projectId);
  if (!project) throw packetError(`Candidate project ${candidate.projectId} is missing.`);
  const taskUrlBase = String(input.baseUrl || "").replace(/\/+$/, "");
  const candidateUrl = String(input.candidateUrl || "");
  const generatedAt = normalizeGeneratedAt(input.generatedAt || new Date().toISOString());
  const candidateTaskIds = new Set(gate.taskIds);
  const tasks = candidate.manifest.sources.map((source) => {
    const task = findTask(state, source.taskId);
    const taskDefinition = definition(task, OWNER_QA_TASK_DEFINITION_FIELDS);
    return {
      id: task.id,
      projectId: task.projectId,
      title: String(task.title || ""),
      description: String(task.description || ""),
      expectedOutcome: String(task.expectedOutcome || task.title || ""),
      taskUrl: taskUrl(taskUrlBase, task.id),
      prUrl: String(task.prUrl || ""),
      branchName: String(task.branchName || ""),
      definition: taskDefinition,
      source: jsonValue(source),
      acceptanceCriteria: jsonValue(task.acceptanceCriteria, []),
      orderedTests: criterionSteps(task),
      validation: {
        plan: jsonValue(task.validationPlan, []),
        verificationEvidence: jsonValue(task.verificationEvidence, null),
        evidence: jsonValue(task.evidence, []),
      },
      dependencies: dependencyRecords(state, task, candidateTaskIds),
      architecture: {
        required: Boolean(task.architectureRequired),
        status: String(task.architectureStatus || ""),
        parentTaskId: String(task.architectureParentTaskId || task.parentTaskId || ""),
        decision: String(task.architectureDecision || ""),
        summary: String(task.architectureSummary || ""),
        waiver: jsonValue(task.architectureWaiver, ""),
        decisionTaskIds: jsonValue(task.architectureDecisionTaskIds, []),
      },
      delivery: {
        mode: String(task.deliveryMode || ""),
        migrations: jsonValue(task.migrations, []),
        featureFlags: jsonValue(task.featureFlags, []),
        rollback: jsonValue(
          task.rollback,
          "Revert the candidate commit and disable its feature flag, if applicable.",
        ),
      },
      safety: {
        riskClassification: String(task.riskClassification || ""),
        privacyNotes: String(task.privacyNotes || ""),
        securityNotes: String(task.securityNotes || ""),
        knownRisks: jsonValue(task.knownRisks, []),
        risks: jsonValue(task.risks, []),
      },
      attachments: jsonValue(task.attachments, []),
      candidateIdentity: jsonValue(task.candidateIdentity, null),
      impactEvidence: jsonValue(task.impactEvidence, null),
      accountsOrFixtures: jsonValue(task.accountsOrFixtures ?? task.fixtures, []),
      resetSteps: jsonValue(
        task.resetSteps,
        ["Reset the preview data or fixture state before the next criterion."],
      ),
    };
  });
  const base = {
    schemaVersion: OWNER_QA_PACKET_SCHEMA_VERSION,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    projectId: candidate.projectId,
    projectKey: String(project.key || ""),
    projectName: String(project.name || project.key || ""),
    taskUrlBase,
    candidateUrl,
    previewUrl: candidate.manifest.preview.url,
    integration: jsonValue(candidate.manifest.integration),
    candidate: {
      id: candidate.id,
      projectId: candidate.projectId,
      qaBundleId: String(candidate.qaBundleId || ""),
      manifestDigest: candidate.manifestDigest,
      manifest: jsonValue(candidate.manifest),
    },
    project: {
      id: project.id,
      key: String(project.key || ""),
      name: String(project.name || project.key || ""),
      description: String(project.description || ""),
      definition: definition(project, OWNER_QA_PROJECT_DEFINITION_FIELDS),
      reviewAndSafety: {
        reviewPolicy: jsonValue(project.reviewPolicy, null),
        reviewPipeline: jsonValue(project.reviewPipeline, []),
        safetyRules: jsonValue(project.safetyRules, []),
      },
      validationCommands: jsonValue(project.validationCommands, []),
      architectureStandards: jsonValue(project.standards, []),
      deliveryPolicy: jsonValue(project.deliveryPolicy, null),
    },
    bundle: bundle ? {
      id: String(bundle.id || ""),
      projectId: String(bundle.projectId || ""),
      candidateId: String(bundle.candidateId || ""),
      manifestDigest: String(bundle.manifestDigest || ""),
      integrationBranch: String(bundle.integrationBranch || ""),
      integrationCommit: String(bundle.integrationCommit || ""),
      previewUrl: String(bundle.previewUrl || ""),
      taskIds: taskIdList(bundle),
    } : null,
    tasks,
    actions: OWNER_QA_ACTIONS.map((action) => ({
      action,
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
    })),
    generatedAt,
  };
  return deepFreeze({ ...base, packetDigest: digestPacketBase(base) });
}

/** Validate packet structure/digest and immutable candidate identity. */
function assertLegacyOwnerQaPacket(packet, candidate, bundle = null) {
  const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  const packetTaskIds = (packet.tasks || []).map((task) => String(task?.id || "")).sort();
  const expectedActions = OWNER_QA_ACTIONS.map((action) => ({
    action,
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
  }));
  if (
    packet.candidateId !== candidate.id
    || packet.projectId !== candidate.projectId
    || packet.manifestDigest !== candidate.manifestDigest
    || canonicalJson(packetTaskIds) !== canonicalJson(expectedTaskIds)
    || packet.integration?.branch !== candidate.manifest.integration.branch
    || packet.integration?.sha !== candidate.manifest.integration.sha
    || packet.previewUrl !== candidate.manifest.preview.url
    || canonicalJson(packet.actions || []) !== canonicalJson(expectedActions)
    || normalizeGeneratedAt(packet.generatedAt) !== packet.generatedAt
  ) {
    throw packetError("Legacy owner QA packet candidate identity is inconsistent.");
  }
  if (bundle && (
    bundle.id !== candidate.qaBundleId
    || bundle.projectId !== candidate.projectId
    || bundle.candidateId !== candidate.id
    || bundle.manifestDigest !== candidate.manifestDigest
    || bundle.integrationBranch !== candidate.manifest.integration.branch
    || bundle.integrationCommit !== candidate.manifest.integration.sha
    || bundle.previewUrl !== candidate.manifest.preview.url
    || canonicalJson(taskIdList(bundle)) !== canonicalJson(expectedTaskIds)
  )) {
    throw packetError("Legacy owner QA packet bundle identity is inconsistent.");
  }
  return packet;
}

export function assertOwnerQaPacket(packet, candidate, bundle = null) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw packetError("Candidate owner QA packet is missing.");
  }
  const { packetDigest, ...base } = packet;
  if (!DIGEST_PATTERN.test(String(packetDigest || "")) || packetDigest !== digestPacketBase(base)) {
    throw packetError("Owner QA packet digest is missing or invalid.");
  }
  assertCandidateEnvelope(candidate);
  if (packet.schemaVersion === LEGACY_OWNER_QA_PACKET_SCHEMA_VERSION) {
    return assertLegacyOwnerQaPacket(packet, candidate, bundle);
  }
  if (packet.schemaVersion !== OWNER_QA_PACKET_SCHEMA_VERSION) {
    throw packetError(`Unsupported owner QA packet schema: ${packet.schemaVersion || "missing"}.`);
  }
  const expectedTaskIds = candidate.manifest.sources.map((source) => source.taskId).sort();
  if (
    packet.candidateId !== candidate.id
    || packet.projectId !== candidate.projectId
    || packet.manifestDigest !== candidate.manifestDigest
    || packet.candidate?.id !== candidate.id
    || packet.candidate?.projectId !== candidate.projectId
    || packet.candidate?.qaBundleId !== candidate.qaBundleId
    || packet.candidate?.manifestDigest !== candidate.manifestDigest
    || canonicalJson(packet.candidate?.manifest) !== canonicalJson(candidate.manifest)
    || canonicalJson((packet.tasks || []).map((task) => task.id).sort()) !== canonicalJson(expectedTaskIds)
    || packet.integration?.branch !== candidate.manifest.integration.branch
    || packet.integration?.sha !== candidate.manifest.integration.sha
    || packet.previewUrl !== candidate.manifest.preview.url
    || normalizeGeneratedAt(packet.generatedAt) !== packet.generatedAt
  ) {
    throw packetError("Owner QA packet candidate identity is inconsistent.");
  }
  if (bundle && (
    packet.bundle?.id !== bundle.id
    || packet.bundle?.projectId !== bundle.projectId
    || packet.bundle?.candidateId !== bundle.candidateId
    || packet.bundle?.manifestDigest !== bundle.manifestDigest
    || packet.bundle?.integrationBranch !== bundle.integrationBranch
    || packet.bundle?.integrationCommit !== bundle.integrationCommit
    || packet.bundle?.previewUrl !== bundle.previewUrl
    || canonicalJson(packet.bundle?.taskIds || []) !== canonicalJson(taskIdList(bundle))
  )) {
    throw packetError("Owner QA packet bundle identity is inconsistent.");
  }
  return packet;
}

/**
 * Validate the stored packet and recompute it from current authoritative state
 * using only the packet's stable timestamp and URL inputs.
 */
export function assertCurrentOwnerQaPacket(state, candidate, bundle = null) {
  const currentBundle = bundle || (state?.qaBundles || []).find((item) => item.id === candidate?.qaBundleId);
  if (!currentBundle) throw packetError("Owner QA packet has no authoritative QA bundle.");
  const packet = assertOwnerQaPacket(candidate?.qaPacket, candidate, currentBundle);
  if (packet.schemaVersion !== OWNER_QA_PACKET_SCHEMA_VERSION) {
    throw packetError("Legacy owner QA packets are historical evidence and cannot authorize a new QA decision.");
  }
  if (
    currentBundle.packetDigest !== packet.packetDigest
    || canonicalJson(currentBundle.qaPacket) !== canonicalJson(packet)
  ) {
    throw packetError("Candidate and bundle owner QA packet records do not match.");
  }
  const recomputed = buildOwnerQaPacket(state, candidate, {
    bundle: currentBundle,
    generatedAt: packet.generatedAt,
    baseUrl: packet.taskUrlBase,
    candidateUrl: packet.candidateUrl,
  });
  if (canonicalJson(recomputed) !== canonicalJson(packet)) {
    throw packetError("Owner QA packet no longer matches current project or task definitions.");
  }
  return packet;
}

/**
 * Historical v1 packets may authorize only reconciliation of an already-
 * persisted release handoff. They never authorize initial QA or PR creation.
 */
export function assertReconciliationOwnerQaPacket(state, candidate, bundle = null) {
  const currentBundle = bundle || (state?.qaBundles || []).find((item) => item.id === candidate?.qaBundleId);
  if (!currentBundle) throw packetError("Reconciliation owner QA packet has no authoritative bundle.");
  const packet = assertOwnerQaPacket(candidate?.qaPacket, candidate, currentBundle);
  if (packet.schemaVersion === OWNER_QA_PACKET_SCHEMA_VERSION) {
    return assertCurrentOwnerQaPacket(state, candidate, currentBundle);
  }
  if (!candidate.promotion || !["release_candidate_ready", "merged"].includes(candidate.status)) {
    throw packetError("Legacy owner QA packet is not attached to an existing release handoff.");
  }
  if (
    currentBundle.packetDigest !== packet.packetDigest
    || canonicalJson(currentBundle.qaPacket) !== canonicalJson(packet)
    || currentBundle.promotionPrUrl !== candidate.promotion.prUrl
    || currentBundle.promotionBranch !== candidate.promotion.branch
    || currentBundle.promotionCommit !== candidate.promotion.commitSha
    || candidate.promotion.commitSha !== candidate.manifest.integration.sha
    || candidate.promotion.manifestDigest !== candidate.manifestDigest
    || !Number.isFinite(Date.parse(candidate.promotion.readyAt || ""))
  ) {
    throw packetError("Legacy owner QA packet release handoff mirror is inconsistent.");
  }
  const tasksById = new Map((state?.tasks || []).map((task) => [task.id, task]));
  for (const source of candidate.manifest.sources) {
    const task = tasksById.get(source.taskId);
    if (
      !task
      || task.projectId !== candidate.projectId
      || task.candidateId !== candidate.id
      || task.qaBundleId !== candidate.qaBundleId
      || task.candidateManifestDigest !== candidate.manifestDigest
      || task.integrationCommit !== candidate.manifest.integration.sha
      || String(task.reviewSubjectSha || "").toLowerCase() !== source.headSha
      || Number(task.reviewSubjectCycle) !== Number(source.candidateCycle)
    ) {
      throw packetError(`Legacy owner QA packet task ${source.taskId} no longer matches the release handoff.`);
    }
  }
  return packet;
}
