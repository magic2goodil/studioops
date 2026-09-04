import { createHash } from "node:crypto";
import { canonicalJson } from "./candidate-manifest.js";

export const FAILURE_CONTAINMENT_SCHEMA_VERSION = "studioops.failure-containment.v1";
export const FAILURE_CONTAINMENT_MIGRATION_VERSION = 1;
export const MAX_PAID_ATTEMPTS_PER_GENERATION = 2;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;
const REASON_CODES = new Set([
  "attempt_budget_exhausted",
  "configuration_invalid",
  "credential_unavailable",
  "dependency_unavailable",
  "execution_failed",
  "output_guard_exceeded",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_unavailable",
  "repository_unavailable",
  "service_unhealthy",
  "validation_failed",
  "unknown_failure",
]);
const PROVIDERS = new Set(["codex", "github", "local", "unknown"]);
const CREDENTIAL_CLASSES = new Set(["available", "denied", "expired", "missing", "unknown"]);
const SERVICE_STATES = new Set(["degraded", "healthy", "unavailable", "unknown"]);
const INCIDENT_STATES = new Set(["active", "backoff", "open", "closed", "superseded"]);
const VERIFIERS_BY_REASON = Object.freeze({
  attempt_budget_exhausted: new Set(["candidate_change", "policy_probe"]),
  configuration_invalid: new Set(["configuration_probe", "policy_probe"]),
  credential_unavailable: new Set(["credential_probe"]),
  dependency_unavailable: new Set(["dependency_probe", "service_health_probe"]),
  execution_failed: new Set(["candidate_change", "deterministic_repair", "service_health_probe"]),
  output_guard_exceeded: new Set(["candidate_change", "deterministic_repair", "policy_probe"]),
  provider_auth_failed: new Set(["credential_probe"]),
  provider_rate_limited: new Set(["quota_probe"]),
  provider_unavailable: new Set(["service_health_probe"]),
  repository_unavailable: new Set(["credential_probe", "repository_probe"]),
  service_unhealthy: new Set(["service_health_probe"]),
  validation_failed: new Set(["candidate_change", "deterministic_repair"]),
  unknown_failure: new Set(["candidate_change", "deterministic_repair", "policy_probe"]),
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function safeToken(value, label, max = 120) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized.length > max || !SAFE_TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a bounded lowercase identifier.`);
  }
  return normalized;
}

function optionalToken(value, label, max = 120) {
  return value === undefined || value === null || value === "" ? "" : safeToken(value, label, max);
}

function gitRef(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (
    normalized.length > 240
    || /^[./-]|[/.]$|\.\.|\/\//.test(normalized)
    || /[\x00-\x20~^:?*[\\]/.test(normalized)
  ) throw new Error(`${label} must be a bounded safe Git ref.`);
  return normalized;
}

function gitSha(value, label, optional = true) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized && optional) return "";
  if (!SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full Git SHA.`);
  return normalized;
}

function digest(value, label, optional = true) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized && optional) return "";
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function isoTime(value, label, optional = true) {
  const normalized = String(value || "").trim();
  if (!normalized && optional) return "";
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return normalized;
}

function boundedCount(value, label) {
  const count = Number(value || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} must be a nonnegative integer.`);
  return count;
}

export function normalizeFailureProvider(value) {
  const raw = String(value || "unknown").trim().toLowerCase().replaceAll("_", "-");
  const normalized = ["codex-sdk", "codex-cli", "openai-codex", "sdk", "cli"].includes(raw)
    ? "codex"
    : ["watchdog", "dispatcher", "runner", "system", "none"].includes(raw)
      ? "local"
      : raw;
  if (!PROVIDERS.has(normalized)) throw new Error("Failure provider is not allowlisted.");
  return normalized;
}

export function normalizeFailureReasonCode(value) {
  const reasonCode = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!REASON_CODES.has(reasonCode)) throw new Error("Failure reason code is not allowlisted.");
  return reasonCode;
}

export function failureActionIdentity(input = {}) {
  const action = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return safeToken(
    action.action || action.actionType || action.type || action.reviewStage || action.role,
    "Failure action",
    120,
  );
}

function candidateIdentity(value = {}) {
  const identity = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {
    candidateId: optionalToken(identity.candidateId, "Candidate ID", 180),
    commitSha: gitSha(identity.commitSha || identity.headSha, "Candidate commit SHA"),
    treeSha: gitSha(identity.treeSha, "Candidate tree SHA"),
    baseSha: gitSha(identity.baseSha, "Candidate base SHA"),
    manifestDigest: digest(identity.manifestDigest, "Candidate manifest digest"),
    candidateCycle: boundedCount(identity.candidateCycle, "Candidate cycle"),
  };
  const hasStableIdentity = Boolean(
    normalized.candidateId
    || normalized.commitSha
    || normalized.treeSha
    || normalized.baseSha
    || normalized.manifestDigest
  );
  return hasStableIdentity ? normalized : null;
}

export function failureFingerprint(input = {}) {
  const value = {
    schemaVersion: FAILURE_CONTAINMENT_SCHEMA_VERSION,
    taskId: safeToken(input.taskId, "Failure task ID", 180),
    action: failureActionIdentity(input),
    candidate: candidateIdentity(input.candidate || input.candidateIdentity),
    provider: normalizeFailureProvider(input.provider),
    reasonCode: normalizeFailureReasonCode(input.reasonCode),
  };
  return { value, canonical: canonicalJson(value), digest: sha256(value) };
}

function normalizedRepositoryEvidence(value = {}) {
  const repository = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const prUrl = String(repository.prUrl || "").trim();
  if (prUrl && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(prUrl)) {
    throw new Error("Failure evidence pull request URL must be canonical GitHub HTTPS.");
  }
  return {
    branch: gitRef(repository.branch, "Failure evidence branch"),
    prUrl,
    commitSha: gitSha(repository.commitSha, "Failure evidence commit SHA"),
  };
}

function normalizedDependencies(values = []) {
  if (!Array.isArray(values)) throw new Error("Failure evidence dependencies must be an array.");
  const dependencies = values.map((entry) => ({
    taskId: safeToken(entry?.taskId, "Failure evidence dependency task ID", 180),
    stateVersion: boundedCount(entry?.stateVersion, "Failure evidence dependency state version"),
    status: optionalToken(entry?.status, "Failure evidence dependency status", 80),
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length) {
    throw new Error("Failure evidence dependencies must be unique.");
  }
  return dependencies;
}

function normalizedServiceHealth(values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Failure evidence service health must be an object.");
  }
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [safeToken(key, "Failure evidence service", 80), String(value || "").trim().toLowerCase()])
    .map(([key, value]) => {
      if (!SERVICE_STATES.has(value)) throw new Error("Failure evidence service state is not allowlisted.");
      return [key, value];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function failureEvidence(input = {}) {
  const credentialClass = String(input.credentialClass || "unknown").trim().toLowerCase();
  if (!CREDENTIAL_CLASSES.has(credentialClass)) {
    throw new Error("Failure evidence credential class is not allowlisted.");
  }
  const value = {
    schemaVersion: FAILURE_CONTAINMENT_SCHEMA_VERSION,
    repository: normalizedRepositoryEvidence(input.repository),
    dependencies: normalizedDependencies(input.dependencies),
    credentialClass,
    configurationDigest: digest(input.configurationDigest, "Failure evidence configuration digest"),
    policyDigest: digest(input.policyDigest, "Failure evidence policy digest"),
    componentMapDigest: digest(input.componentMapDigest, "Failure evidence component-map digest"),
    serviceHealth: normalizedServiceHealth(input.serviceHealth),
  };
  return { value, canonical: canonicalJson(value), digest: sha256(value) };
}

function notificationKey(fingerprintDigest, generation) {
  return `failure:${fingerprintDigest.slice("sha256:".length, 29)}:${generation}`;
}

function normalizedIncident(incident) {
  if (!incident || typeof incident !== "object" || Array.isArray(incident)) {
    throw new Error("Failure incident is required.");
  }
  if (incident.schemaVersion !== FAILURE_CONTAINMENT_SCHEMA_VERSION) {
    throw new Error("Failure incident schema is unsupported.");
  }
  if (!INCIDENT_STATES.has(incident.state)) throw new Error("Failure incident state is invalid.");
  const normalized = structuredClone(incident);
  const fingerprint = failureFingerprint(incident.fingerprint || {});
  const evidence = failureEvidence(incident.evidence || {});
  if (
    !/^failure_[a-f0-9]{24}-g[1-9][0-9]*$/.test(String(incident.incidentId || ""))
    || incident.taskId !== fingerprint.value.taskId
    || incident.action !== fingerprint.value.action
    || incident.provider !== fingerprint.value.provider
    || incident.reasonCode !== fingerprint.value.reasonCode
    || incident.fingerprintDigest !== fingerprint.digest
    || incident.evidenceDigest !== evidence.digest
  ) throw new Error("Failure incident authority fields are inconsistent.");
  normalized.generation = boundedCount(incident.generation, "Failure incident generation");
  if (normalized.generation < 1) throw new Error("Failure incident generation must be positive.");
  normalized.paidAttempts = boundedCount(incident.paidAttempts, "Failure incident paid attempts");
  normalized.cheapProbeAttempts = boundedCount(incident.cheapProbeAttempts, "Failure incident cheap probes");
  normalized.repairAttempts = boundedCount(incident.repairAttempts, "Failure incident repairs");
  normalized.avoidedRetries = boundedCount(incident.avoidedRetries, "Failure incident avoided retries");
  normalized.fingerprintDigest = digest(incident.fingerprintDigest, "Failure incident fingerprint digest", false);
  normalized.evidenceDigest = digest(incident.evidenceDigest, "Failure incident evidence digest", false);
  normalized.openedAt = isoTime(incident.openedAt, "Failure incident opened time");
  normalized.updatedAt = isoTime(incident.updatedAt, "Failure incident updated time", false);
  normalized.backoffUntil = isoTime(incident.backoffUntil, "Failure incident backoff time");
  normalized.createdAt = isoTime(incident.createdAt, "Failure incident creation time", false);
  if (!Array.isArray(incident.history) || incident.history.length > 1_000) {
    throw new Error("Failure incident history must be a bounded array.");
  }
  return normalized;
}

export function createFailureIncident(input = {}) {
  const fingerprint = input.fingerprint?.digest ? input.fingerprint : failureFingerprint(input);
  const evidence = input.evidence?.digest ? input.evidence : failureEvidence(input.evidence || {});
  const now = isoTime(input.now || new Date().toISOString(), "Failure incident creation time", false);
  return normalizedIncident({
    schemaVersion: FAILURE_CONTAINMENT_SCHEMA_VERSION,
    incidentId: String(input.incidentId || `failure_${fingerprint.digest.slice(7, 31)}-g1`).trim(),
    taskId: fingerprint.value.taskId,
    action: fingerprint.value.action,
    provider: fingerprint.value.provider,
    reasonCode: fingerprint.value.reasonCode,
    fingerprint: fingerprint.value,
    fingerprintDigest: fingerprint.digest,
    evidence: evidence.value,
    evidenceDigest: evidence.digest,
    generation: Math.max(1, Number(input.generation || 1)),
    state: "active",
    paidAttempts: 0,
    cheapProbeAttempts: 0,
    repairAttempts: 0,
    avoidedRetries: 0,
    backoffUntil: "",
    openedAt: "",
    circuitEventKey: "",
    notificationKey: "",
    createdAt: now,
    updatedAt: now,
    history: [],
  });
}

function verifierForEvidenceChange(incident, evidenceDigest, verifier) {
  const allowed = VERIFIERS_BY_REASON[incident.reasonCode] || new Set();
  const id = String(verifier?.id || "").trim().toLowerCase();
  return Boolean(
    allowed.has(id)
    && verifier?.outcome === "passed"
    && String(verifier?.evidenceDigest || "").toLowerCase() === evidenceDigest
  );
}

function supersedeForEvidence(incident, evidence, input = {}) {
  if (!verifierForEvidenceChange(incident, evidence.digest, input.verifier)) {
    throw new Error("Changed failure evidence requires a successful allowlisted verifier for this reason class.");
  }
  const now = isoTime(input.now || new Date().toISOString(), "Failure evidence verification time", false);
  const generation = incident.generation + 1;
  return normalizedIncident({
    ...incident,
    incidentId: `failure_${incident.fingerprintDigest.slice(7, 31)}-g${generation}`,
    evidence: evidence.value,
    evidenceDigest: evidence.digest,
    generation,
    state: "active",
    paidAttempts: 0,
    cheapProbeAttempts: 0,
    repairAttempts: 0,
    avoidedRetries: incident.avoidedRetries,
    backoffUntil: "",
    openedAt: "",
    circuitEventKey: "",
    notificationKey: "",
    createdAt: now,
    updatedAt: now,
    history: [...(incident.history || []), {
      type: "evidence_verified",
      priorEvidenceDigest: incident.evidenceDigest,
      evidenceDigest: evidence.digest,
      verifier: String(input.verifier.id),
      recordedAt: now,
    }],
  });
}

export function openFailureCircuit(incidentInput, input = {}) {
  const incident = normalizedIncident(incidentInput);
  if (incident.state === "open") return incident;
  const now = isoTime(input.now || new Date().toISOString(), "Failure circuit open time", false);
  return normalizedIncident({
    ...incident,
    state: "open",
    openedAt: now,
    backoffUntil: "",
    circuitEventKey: notificationKey(incident.fingerprintDigest, incident.generation),
    notificationKey: notificationKey(incident.fingerprintDigest, incident.generation),
    updatedAt: now,
  });
}

export function claimPaidFailureAttempt(incidentInput, input = {}) {
  let incident = normalizedIncident(incidentInput);
  const now = isoTime(input.now || new Date().toISOString(), "Failure attempt time", false);
  const nowMs = Date.parse(now);
  const evidence = input.evidence?.digest ? input.evidence : failureEvidence(input.evidence || {});
  if (evidence.digest !== incident.evidenceDigest) {
    incident = supersedeForEvidence(incident, evidence, { ...input, now });
  }
  if (incident.state === "open") {
    incident.avoidedRetries += 1;
    incident.updatedAt = now;
    return { admitted: false, reason: "circuit_open", incident: normalizedIncident(incident) };
  }
  if (incident.backoffUntil && Date.parse(incident.backoffUntil) > nowMs) {
    incident.avoidedRetries += 1;
    incident.updatedAt = now;
    return { admitted: false, reason: "backoff", incident: normalizedIncident(incident) };
  }
  if (incident.paidAttempts >= MAX_PAID_ATTEMPTS_PER_GENERATION) {
    const opened = openFailureCircuit({ ...incident, avoidedRetries: incident.avoidedRetries + 1 }, { now });
    return { admitted: false, reason: "attempt_budget_exhausted", incident: opened };
  }
  incident.state = "active";
  incident.paidAttempts += 1;
  incident.updatedAt = now;
  incident.history = [...(incident.history || []), {
    type: "paid_attempt_claimed",
    initiator: optionalToken(input.initiator, "Failure attempt initiator", 80),
    transport: optionalToken(input.transport, "Failure attempt transport", 80),
    attempt: incident.paidAttempts,
    recordedAt: now,
  }];
  return { admitted: true, reason: "admitted", incident: normalizedIncident(incident) };
}

export function recordFailureRecoveryActivity(incidentInput, input = {}) {
  let incident = normalizedIncident(incidentInput);
  const now = isoTime(input.now || new Date().toISOString(), "Failure recovery activity time", false);
  const evidence = input.evidence?.digest ? input.evidence : failureEvidence(input.evidence || {});
  if (evidence.digest !== incident.evidenceDigest) {
    incident = supersedeForEvidence(incident, evidence, { ...input, now });
  }
  const type = String(input.type || "").trim();
  if (!new Set(["cheap_probe", "repair", "retry_avoided"]).has(type)) {
    throw new Error("Failure recovery activity type is invalid.");
  }
  if (type === "cheap_probe") incident.cheapProbeAttempts += 1;
  if (type === "repair") incident.repairAttempts += 1;
  if (type === "retry_avoided") incident.avoidedRetries += 1;
  incident.updatedAt = now;
  incident.history = [...(incident.history || []), {
    type,
    verifier: optionalToken(input.verifier?.id, "Failure activity verifier", 80),
    outcome: optionalToken(input.outcome, "Failure activity outcome", 40),
    recordedAt: now,
  }];
  return normalizedIncident(incident);
}

export function scheduleFailureBackoff(incidentInput, input = {}) {
  const incident = normalizedIncident(incidentInput);
  if (incident.state === "open") return incident;
  const now = isoTime(input.now || new Date().toISOString(), "Failure backoff start time", false);
  const delayMs = Number(input.delayMs);
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 24 * 60 * 60 * 1000) {
    throw new Error("Failure backoff delay must be between one millisecond and 24 hours.");
  }
  incident.state = "backoff";
  incident.backoffUntil = new Date(Date.parse(now) + delayMs).toISOString();
  incident.updatedAt = now;
  return normalizedIncident(incident);
}

export function failureIncidentCompatibilityCircuit(incidentInput, snapshot = {}) {
  const incident = normalizedIncident(incidentInput);
  return {
    schemaVersion: "studioops.automation-circuit.compatibility.v1",
    state: incident.state === "open" ? "open" : "closed",
    scope: "task",
    reasonCode: incident.reasonCode,
    normalizedReason: incident.state === "open"
      ? "The durable failure-containment incident exhausted its paid-attempt budget."
      : "The durable failure-containment incident is not open.",
    failureFingerprint: incident.fingerprintDigest,
    evidenceDigest: incident.evidenceDigest,
    incidentId: incident.incidentId,
    incidentGeneration: incident.generation,
    attemptsConsumed: incident.paidAttempts,
    maxAttempts: MAX_PAID_ATTEMPTS_PER_GENERATION,
    cheapProbeCount: incident.cheapProbeAttempts,
    recoveryCount: incident.repairAttempts,
    avoidedRetries: incident.avoidedRetries,
    snapshot: structuredClone(snapshot),
    openedAt: incident.openedAt,
    notificationKey: incident.notificationKey,
    nextCheapProbe: "Run the allowlisted verifier for this incident reason without launching a model.",
  };
}

export function assertFailureIncident(value) {
  return normalizedIncident(value);
}
