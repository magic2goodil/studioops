import { createHash, createPublicKey, verify } from "node:crypto";

export const HOSTED_RC_EVIDENCE_VERSION = "studioops.hosted-rc-evidence.v1";
export const HOSTED_RC_ENVELOPE_MAX_BYTES = 64 * 1024;
export const HOSTED_RC_PAGE_MAX = 50;
export const HOSTED_RC_REASON_CODES = Object.freeze([
  "qualified", "not_applicable", "evidence_missing", "evidence_malformed", "payload_too_large", "untrusted_producer",
  "untrusted_observation", "untrusted_policy", "untrusted_decision", "applicability_unknown",
  "policy_mismatch", "candidate_mismatch", "project_mismatch", "repository_mismatch", "source_mismatch",
  "artifact_mismatch", "deployment_mismatch", "runtime_mismatch", "snapshot_mismatch",
  "evidence_stale", "observation_stale", "snapshot_stale", "unsafe_isolation", "migration_failed",
  "scenario_failed", "device_missing", "native_backend_mismatch", "review_changed", "revoked",
  "owner_decision_missing", "qualification_missing", "state_conflict", "history_limit", "authority_required",
]);
export class HostedRcContractError extends Error {
  constructor(code) { super(code); this.name = "HostedRcContractError"; this.code = code; }
}
export function rcFail(code = "evidence_malformed") { throw new HostedRcContractError(code); }

function canonical(value, depth = 0, budget = { bytes: 0, nodes: 0 }) {
  budget.nodes += 1;
  budget.bytes += typeof value === "string" ? Buffer.byteLength(value) : 4;
  if (depth > 24 || budget.bytes > HOSTED_RC_ENVELOPE_MAX_BYTES || budget.nodes > 8192) rcFail("payload_too_large");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1, budget));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1, budget)]));
  }
  rcFail();
}
export function hostedRcCanonicalJson(value) {
  const text = JSON.stringify(canonical(value));
  if (Buffer.byteLength(text) > HOSTED_RC_ENVELOPE_MAX_BYTES) rcFail("payload_too_large");
  return text;
}
export function hostedRcDigest(value) {
  return `sha256:${createHash("sha256").update(hostedRcCanonicalJson(value)).digest("hex")}`;
}
export const rcId = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(v) ? v : rcFail();
export const rcDigest = (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v) ? v : rcFail();
export const rcSha = (v) => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v) ? v : rcFail();
export const rcInteger = (v) => Number.isSafeInteger(v) && v >= 0 ? v : rcFail();
export const rcEnum = (...values) => (v) => values.includes(v) ? v : rcFail();
export function rcTime(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT/.test(v) || !Number.isFinite(Date.parse(v))) rcFail();
  return new Date(v).toISOString();
}
export function rcObject(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !Object.hasOwn(fields, key))) rcFail();
  return Object.fromEntries(Object.entries(fields).map(([key, normalize]) => [key, normalize(value[key])]));
}
export const rcNullable = (normalize) => (value) => value === null ? null : normalize(value);
export const rcArray = (normalize, max = 64) => (value) => {
  if (!Array.isArray(value) || value.length > max) rcFail();
  const result = value.map(normalize);
  const keys = result.map((v) => hostedRcCanonicalJson(v));
  if (new Set(keys).size !== keys.length) rcFail();
  return result.sort((a, b) => hostedRcCanonicalJson(a) < hostedRcCanonicalJson(b) ? -1 : hostedRcCanonicalJson(a) > hostedRcCanonicalJson(b) ? 1 : 0);
};
export function rcOrigin(value) {
  let url;
  try { url = new URL(value); } catch { rcFail(); }
  if (typeof value !== "string" || url.protocol !== "https:" || url.username || url.password
    || url.search || url.hash || url.pathname !== "/" || url.hostname === "localhost"
    || url.hostname.endsWith(".localhost") || /^127\./.test(url.hostname)
    || ["[::1]", "0.0.0.0", "[::]"].includes(url.hostname)) rcFail();
  return url.origin;
}
export function rcRepository(value) {
  let url;
  try { url = new URL(value); } catch { rcFail(); }
  if (typeof value !== "string" || url.protocol !== "https:" || url.username || url.password
    || url.search || url.hash || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname)) rcFail();
  return `${url.origin}${url.pathname.replace(/\/$/, "").replace(/\.git$/, "")}`.toLowerCase();
}
export function normalizeHostedRcBinding(v) {
  return rcObject(v, { projectId: rcId, candidateId: rcId, repository: rcRepository,
    sourceSha: rcSha, integrationSha: rcSha, manifestDigest: rcDigest, ownershipDigest: rcDigest,
    artifactDigest: rcDigest, provenanceDigest: rcDigest, fullRegressionDigest: rcDigest });
}
export function normalizeHostedRcRuntime(v) {
  return rcObject(v, { platform: rcId, architecture: rcId, runtimeDigest: rcDigest,
    dependencyDigest: rcDigest, configSchemaDigest: rcDigest });
}
const control = (v) => rcObject(v, { mode: rcEnum("isolated", "disabled", "sandbox", "unsafe", "unknown"), evidenceDigest: rcDigest });
export const HOSTED_RC_ISOLATION_CONTROLS = Object.freeze([
  "secrets", "sessions", "jobs", "outbound", "providers", "writableContent", "notifications", "payments", "devices",
]);
export function normalizeHostedRcEvidence(value) {
  hostedRcCanonicalJson(value);
  const evidence = rcObject(value, {
    schemaVersion: rcEnum(HOSTED_RC_EVIDENCE_VERSION), binding: normalizeHostedRcBinding,
    policyDigest: rcDigest,
    environment: (v) => rcObject(v, { deploymentId: rcId, environmentId: rcId, origin: rcOrigin,
      contractDigest: rcDigest, runtime: normalizeHostedRcRuntime, differencesDigest: rcDigest }),
    snapshot: (v) => rcObject(v, { id: rcId, fingerprint: rcDigest, consistencyPoint: rcId,
      authorizationId: rcId, sourceId: rcId, mode: rcEnum("production_copy", "masked_copy", "representative"),
      createdAt: rcTime, restoredAt: rcTime, restoreEvidenceDigest: rcDigest,
      accessPolicyDigest: rcDigest, retentionExpiresAt: rcTime }),
    migration: (v) => rcObject(v, { planDigest: rcDigest, preSchemaDigest: rcDigest, postSchemaDigest: rcDigest,
      result: rcEnum("passed", "failed", "unknown"), evidenceDigest: rcDigest, dataTransferMode: rcEnum("none") }),
    isolation: (v) => rcObject(v, Object.fromEntries(HOSTED_RC_ISOLATION_CONTROLS.map((name) => [name, control]))),
    scenarios: rcArray((v) => rcObject(v, { id: rcId, deviceId: rcId, deviceKind: rcEnum("physical", "simulated"),
      authentication: rcEnum("normal", "test_bypass"), result: rcEnum("passed", "failed", "unknown"), evidenceDigest: rcDigest })),
    native: rcNullable((v) => rcObject(v, { distributionId: rcId, buildDigest: rcDigest,
      backendOrigin: rcOrigin, backendArtifactDigest: rcDigest })),
    producer: (v) => rcObject(v, { id: rcId, keyId: rcId }),
    capturedAt: rcTime, expiresAt: rcTime, result: rcEnum("passed", "failed", "unknown"),
    evidenceDigests: rcArray(rcDigest),
  });
  const scenarioKeys = evidence.scenarios.map((v) => `${v.id}/${v.deviceId}`);
  if (new Set(scenarioKeys).size !== scenarioKeys.length) rcFail();
  return evidence;
}

/** Domain-separated bytes for authenticated adapters. Private keys never enter the authority or DTOs. */
export function hostedRcSigningBytes(kind, payload) {
  rcId(kind);
  return Buffer.from(`studioops.hosted-rc.signature.v1\n${kind}\n${hostedRcCanonicalJson(payload)}`);
}
/** trustedKeys is deployment-owned configuration, NEVER taken from an evidence request. */
export function verifyHostedRcProof(kind, payload, proof, trustedKeys, code = "untrusted_observation") {
  try {
    if (!proof || Object.keys(proof).sort().join(",") !== "keyId,signature") rcFail(code);
    rcId(proof.keyId);
    if (typeof proof.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature)) rcFail(code);
    const configured = trustedKeys && Object.hasOwn(trustedKeys, proof.keyId) ? trustedKeys[proof.keyId] : null;
    if (!configured) rcFail(code);
    const key = createPublicKey(configured);
    if (key.asymmetricKeyType !== "ed25519"
      || !verify(null, hostedRcSigningBytes(kind, payload), key, Buffer.from(proof.signature, "base64"))) rcFail(code);
  } catch { rcFail(code); }
  return true;
}

export function normalizeHostedRcObservation(v) {
  return rcObject(v, { schemaVersion: rcEnum("studioops.hosted-rc-observation.v1"),
    binding: normalizeHostedRcBinding, evidenceDigest: rcDigest, policyDigest: rcDigest,
    deploymentId: rcId, environmentId: rcId, origin: rcOrigin, resolvedAddressClass: rcEnum("public", "private"),
    runtimeDigest: rcDigest, environmentContractDigest: rcDigest, snapshotFingerprint: rcDigest,
    snapshotAuthorizationId: rcId, migrationDigest: rcDigest, isolationDigest: rcDigest, scenariosDigest: rcDigest,
    nativeDigest: rcDigest, observerId: rcId, observedAt: rcTime });
}
