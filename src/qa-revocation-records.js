import { isDeepStrictEqual } from "node:util";
import { normalizeGitSha } from "./candidate-manifest.js";

export const QA_REVOCATION_INTENT_SCHEMA_VERSION = "studioops.qa-revocation-intent.v1";
export const QA_REVOCATION_SETTLEMENT_SCHEMA_VERSION = "studioops.qa-revocation-settlement.v1";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^qa_revocation_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalTimestamp(value, label) {
  const timestamp = String(value || "");
  const parsed = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`);
  }
  return timestamp;
}

function exactKeys(record, expected, label) {
  const actual = Object.keys(record || {}).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

export function qaRevocationIntentCoordinates(candidate, input = {}) {
  return {
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
    ownerQaPacketDigest: String(input.ownerQaPacketDigest || ""),
    taskIds: candidate.manifest.sources.map((source) => source.taskId).sort(),
  };
}

export function assertQaRevocationIntent(candidate, intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new Error("Release-candidate QA revocation intent is missing.");
  }
  exactKeys(intent, [
    "schemaVersion",
    "requestId",
    "outcome",
    "candidateId",
    "manifestDigest",
    "integrationSha",
    "ownerQaPacketDigest",
    "taskIds",
    "author",
    "notes",
    "requestedAt",
  ], "Release-candidate QA revocation intent");
  const expected = qaRevocationIntentCoordinates(candidate, intent);
  const author = String(intent.author || "");
  const notes = String(intent.notes || "");
  if (
    intent.schemaVersion !== QA_REVOCATION_INTENT_SCHEMA_VERSION
    || intent.outcome !== "failed"
    || intent.candidateId !== expected.candidateId
    || intent.manifestDigest !== expected.manifestDigest
    || intent.integrationSha !== expected.integrationSha
    || !DIGEST_PATTERN.test(String(intent.ownerQaPacketDigest || ""))
    || intent.ownerQaPacketDigest !== candidate.qaPacket?.packetDigest
    || !isDeepStrictEqual(intent.taskIds, expected.taskIds)
    || !REQUEST_ID_PATTERN.test(String(intent.requestId || ""))
    || !author.trim()
    || author !== author.trim()
    || notes !== notes.trim()
    || author.length > 500
    || notes.length > 10_000
  ) {
    throw new Error("Release-candidate QA revocation intent does not match the immutable owner authority.");
  }
  canonicalTimestamp(intent.requestedAt, "Release-candidate QA revocation intent requestedAt");
  return intent;
}

function assertPromotionIdentity(candidate) {
  const promotion = candidate?.promotion;
  if (
    !promotion
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/i.test(String(promotion.prUrl || ""))
    || promotion.commitSha !== candidate.manifest?.integration?.sha
    || promotion.manifestDigest !== candidate.manifestDigest
  ) {
    throw new Error("Release-candidate QA revocation settlement has no exact promotion identity.");
  }
  return promotion;
}

export function normalizeQaRevocationSettlement(candidate, settlement, input = {}) {
  const status = String(settlement?.status || "").trim().toLowerCase();
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement) || !["absent", "closed", "merged"].includes(status)) {
    throw new Error("Release-candidate QA revocation settlement must be authoritatively absent, closed, or merged.");
  }
  const observedAt = settlement.observedAt
    ? canonicalTimestamp(settlement.observedAt, "Release-candidate QA revocation settlement observedAt")
    : canonicalTimestamp(input.now || new Date().toISOString(), "Release-candidate QA revocation settlement observedAt");
  if (status === "absent") {
    if (candidate.promotion?.prUrl || settlement.prUrl || settlement.mergeCommit || settlement.mergedAt) {
      throw new Error("An absent QA revocation settlement cannot contradict a persisted promotion or contain pull-request evidence.");
    }
    return {
      schemaVersion: QA_REVOCATION_SETTLEMENT_SCHEMA_VERSION,
      status,
      prUrl: "",
      observedAt,
      mergeCommit: "",
      mergedAt: "",
    };
  }
  const promotion = candidate.promotion
    ? assertPromotionIdentity(candidate)
    : null;
  const prUrl = String(settlement.prUrl || promotion?.prUrl || "").trim();
  if (
    (promotion && prUrl !== promotion.prUrl)
    || (!promotion && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/i.test(prUrl))
  ) {
    throw new Error("Release-candidate QA revocation settlement pull request does not match.");
  }
  const mergedAt = String(settlement.mergedAt || "");
  const suppliedMergeCommit = String(settlement.mergeCommit || "").trim().toLowerCase();
  let mergeCommit = "";
  let canonicalMergedAt = "";
  if (status === "merged") {
    canonicalMergedAt = canonicalTimestamp(mergedAt, "Release-candidate QA revocation settlement mergedAt");
    mergeCommit = normalizeGitSha(suppliedMergeCommit, "Release-candidate QA revocation settlement merge commit");
  }
  return {
    schemaVersion: QA_REVOCATION_SETTLEMENT_SCHEMA_VERSION,
    status,
    prUrl,
    observedAt,
    mergeCommit,
    mergedAt: canonicalMergedAt,
  };
}

export function assertQaRevocationSettlement(candidate, settlement) {
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) {
    throw new Error("Release-candidate QA revocation settlement is missing.");
  }
  exactKeys(settlement, [
    "schemaVersion",
    "status",
    "prUrl",
    "observedAt",
    "mergeCommit",
    "mergedAt",
  ], "Release-candidate QA revocation settlement");
  if (settlement.schemaVersion !== QA_REVOCATION_SETTLEMENT_SCHEMA_VERSION) {
    throw new Error("Release-candidate QA revocation settlement schema is invalid.");
  }
  const normalized = normalizeQaRevocationSettlement(candidate, settlement);
  if (!isDeepStrictEqual(settlement, normalized)) {
    throw new Error("Release-candidate QA revocation settlement is not canonical.");
  }
  return settlement;
}

export function assertCandidateQaRevocationRecords(candidate) {
  if (candidate.qaRevocationSettlement && !candidate.qaRevocationIntent) {
    throw new Error("A QA revocation settlement requires its durable revocation intent.");
  }
  if (candidate.qaRevocationIntent) assertQaRevocationIntent(candidate, candidate.qaRevocationIntent);
  if (candidate.qaRevocationSettlement) {
    assertQaRevocationSettlement(candidate, candidate.qaRevocationSettlement);
  }
  return candidate;
}

export function qaRevocationAllowsPromotion(candidate) {
  if (!candidate.qaRevocationIntent) return !candidate.qaRevocationSettlement;
  try {
    assertCandidateQaRevocationRecords(candidate);
    return candidate.qaRevocationSettlement?.status === "merged";
  } catch {
    return false;
  }
}
