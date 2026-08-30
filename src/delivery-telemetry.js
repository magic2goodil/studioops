export const DELIVERY_TELEMETRY_CONTRACT_VERSION = 1;
export const DELIVERY_TELEMETRY_DEFAULT_LIMIT = 50;
export const DELIVERY_TELEMETRY_MAX_LIMIT = 100;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const TOKEN = /^[a-z][a-z0-9_.-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_ATTRIBUTE = /(^|[_-])(prompt|source|log|body|secret|token|credential|customer|content)([_-]|$)/i;

function fail(message, code = "DELIVERY_TELEMETRY_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function text(value, label, { required = true, max = 240, pattern = null } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) fail(`${label} is required.`);
  if (normalized.length > max) fail(`${label} must be at most ${max} characters.`);
  if (normalized && /[\u0000-\u001f\u007f]/.test(normalized)) fail(`${label} contains control characters.`);
  if (normalized && pattern && !pattern.test(normalized)) fail(`${label} has an invalid format.`);
  return normalized;
}

function identifier(value, label, required = true) {
  return text(value, label, { required, max: 240, pattern: IDENTIFIER });
}

function token(value, label) {
  return text(value, label, { max: 80, pattern: TOKEN });
}

export function utcTimestamp(value, label = "timestamp") {
  const normalized = text(value, label, { max: 32 });
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    fail(`${label} must be a canonical UTC ISO-8601 timestamp with milliseconds.`);
  }
  return normalized;
}

export function utcDate(value, label = "date") {
  const normalized = text(value, label, { max: 10, pattern: DATE });
  if (new Date(`${normalized}T00:00:00.000Z`).toISOString().slice(0, 10) !== normalized) {
    fail(`${label} must be a valid UTC calendar date.`);
  }
  return normalized;
}

function sha(value, label = "commitSha", required = false) {
  return text(value, label, { required, max: 40, pattern: SHA });
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e15) fail(`${label} must be a bounded finite number.`);
  return number;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) fail(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  return number;
}

function sortedObject(value, label, { sensitiveKeys = false, maxEntries = 32, maxString = 256 } = {}) {
  if (value == null) return {};
  if (!value || Array.isArray(value) || typeof value !== "object") fail(`${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) fail(`${label} must have at most ${maxEntries} entries.`);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => {
    const normalizedKey = text(key, `${label} key`, { max: 64, pattern: TOKEN });
    if (sensitiveKeys && SENSITIVE_ATTRIBUTE.test(normalizedKey)) fail(`${label}.${normalizedKey} is not permitted.`);
    if (!["string", "number", "boolean"].includes(typeof item) || item == null) {
      fail(`${label}.${normalizedKey} must be a string, number, or boolean.`);
    }
    if (typeof item === "string") return [normalizedKey, text(item, `${label}.${normalizedKey}`, { required: false, max: maxString })];
    if (typeof item === "number") return [normalizedKey, finiteNumber(item, `${label}.${normalizedKey}`)];
    return [normalizedKey, item];
  }));
}

function stringList(value, label, { maxEntries = 32 } = {}) {
  if (!Array.isArray(value) || value.length > maxEntries) fail(`${label} must be an array with at most ${maxEntries} entries.`);
  return [...new Set(value.map((item) => token(item, `${label} item`)))].sort();
}

function base(input, now) {
  const schemaVersion = input.schemaVersion == null
    ? DELIVERY_TELEMETRY_CONTRACT_VERSION
    : positiveInteger(input.schemaVersion, "schemaVersion");
  if (schemaVersion > DELIVERY_TELEMETRY_CONTRACT_VERSION) {
    fail(`schemaVersion ${schemaVersion} is newer than supported version ${DELIVERY_TELEMETRY_CONTRACT_VERSION}.`, "DELIVERY_TELEMETRY_SCHEMA_UNSUPPORTED");
  }
  return {
    id: input.id ? identifier(input.id, "id") : "",
    schemaVersion,
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    recordedAt: utcTimestamp(input.recordedAt || now(), "recordedAt"),
  };
}

export function normalizeDeliveryEvent(input = {}, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const common = base(input, now);
  return {
    id: common.id,
    schemaVersion: common.schemaVersion,
    projectId: identifier(input.projectId, "projectId"),
    taskId: identifier(input.taskId, "taskId", false),
    runId: identifier(input.runId, "runId", false),
    candidateId: identifier(input.candidateId, "candidateId", false),
    commitSha: sha(input.commitSha),
    stage: token(input.stage, "stage"),
    eventType: token(input.eventType, "eventType"),
    occurredAt: utcTimestamp(input.occurredAt, "occurredAt"),
    receivedAt: utcTimestamp(input.receivedAt || common.recordedAt, "receivedAt"),
    sourceKind: token(input.sourceKind, "sourceKind"),
    sourceReference: identifier(input.sourceReference, "sourceReference"),
    idempotencyKey: common.idempotencyKey,
    measures: Object.fromEntries(Object.entries(sortedObject(input.measures, "measures", { maxEntries: 24 })).map(([key, value]) => {
      if (typeof value !== "number") fail(`measures.${key} must be numeric.`);
      return [key, value];
    })),
    attributes: sortedObject(input.attributes, "attributes", { sensitiveKeys: true, maxEntries: 24 }),
  };
}

export function normalizeValidationEvidence(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    eventId: identifier(input.eventId, "eventId"),
    checkName: identifier(input.checkName, "checkName"),
    subjectSha: sha(input.subjectSha, "subjectSha"),
    outcome: token(input.outcome, "outcome"),
    observedAt: utcTimestamp(input.observedAt, "observedAt"),
    sourceReference: identifier(input.sourceReference, "sourceReference"),
    command: text(input.command, "command", { required: false, max: 500 }),
    artifactDigest: text(input.artifactDigest, "artifactDigest", { required: false, max: 128, pattern: /^[a-z0-9:-]+$/ }),
    durationMs: input.durationMs == null ? null : finiteNumber(input.durationMs, "durationMs"),
  };
}

export function normalizeCriterionEvidence(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    eventId: identifier(input.eventId, "eventId"),
    criterionKey: identifier(input.criterionKey, "criterionKey"),
    outcome: token(input.outcome, "outcome"),
    observedAt: utcTimestamp(input.observedAt, "observedAt"),
    evidenceReference: identifier(input.evidenceReference, "evidenceReference"),
  };
}

export function normalizeMetricDefinition(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  const targetDirection = token(input.targetDirection, "targetDirection");
  if (!["increase", "decrease", "maintain"].includes(targetDirection)) fail("targetDirection is invalid.");
  return {
    ...common,
    metricKey: identifier(input.metricKey, "metricKey"),
    definitionVersion: positiveInteger(input.definitionVersion, "definitionVersion"),
    numerator: text(input.numerator, "numerator", { max: 500 }),
    denominator: text(input.denominator, "denominator", { required: false, max: 500 }),
    unit: token(input.unit, "unit"),
    inclusionRules: stringList(input.inclusionRules || [], "inclusionRules"),
    exclusionRules: stringList(input.exclusionRules || [], "exclusionRules"),
    sourceEventTypes: stringList(input.sourceEventTypes || [], "sourceEventTypes"),
    minimumSampleSize: positiveInteger(input.minimumSampleSize, "minimumSampleSize"),
    percentileMethod: text(input.percentileMethod, "percentileMethod", { required: false, max: 160 }),
    targetDirection,
    compatibleFrom: utcDate(input.compatibleFrom, "compatibleFrom"),
  };
}

export function normalizeMetricSnapshot(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  const windowStartedAt = utcTimestamp(input.windowStartedAt, "windowStartedAt");
  const windowEndedAt = utcTimestamp(input.windowEndedAt, "windowEndedAt");
  if (windowStartedAt > windowEndedAt) fail("windowStartedAt must not be after windowEndedAt.");
  return {
    ...common,
    metricDefinitionId: identifier(input.metricDefinitionId, "metricDefinitionId"),
    projectId: identifier(input.projectId, "projectId"),
    windowStartedAt,
    windowEndedAt,
    value: finiteNumber(input.value, "value"),
    numeratorValue: finiteNumber(input.numeratorValue, "numeratorValue"),
    denominatorValue: input.denominatorValue == null ? null : finiteNumber(input.denominatorValue, "denominatorValue"),
    sampleSize: positiveInteger(input.sampleSize, "sampleSize", { allowZero: true }),
    computedAt: utcTimestamp(input.computedAt, "computedAt"),
  };
}

export function normalizeRetrospectiveJob(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    projectId: identifier(input.projectId, "projectId"),
    eventId: identifier(input.eventId, "eventId", false),
    status: token(input.status, "status"),
    dueAt: utcTimestamp(input.dueAt, "dueAt"),
    attempt: positiveInteger(input.attempt || 1, "attempt"),
  };
}

export function normalizeRetrospective(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    projectId: identifier(input.projectId, "projectId"),
    eventId: identifier(input.eventId, "eventId"),
    jobId: identifier(input.jobId, "jobId", false),
    journalDate: utcDate(input.journalDate, "journalDate"),
    title: text(input.title, "title", { max: 160 }),
    summary: text(input.summary, "summary", { max: 4_000 }),
    observations: sortedObject(input.observations, "observations", { sensitiveKeys: true, maxEntries: 32, maxString: 500 }),
  };
}

export function normalizeImprovementProposal(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    projectId: identifier(input.projectId, "projectId"),
    retrospectiveId: identifier(input.retrospectiveId, "retrospectiveId"),
    fingerprint: text(input.fingerprint, "fingerprint", { max: 128, pattern: /^[a-z0-9:-]+$/ }),
    status: token(input.status, "status"),
    title: text(input.title, "title", { max: 160 }),
    hypothesis: text(input.hypothesis, "hypothesis", { max: 2_000 }),
  };
}

export function normalizeExperiment(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    projectId: identifier(input.projectId, "projectId"),
    proposalId: identifier(input.proposalId, "proposalId"),
    status: token(input.status, "status"),
    dueAt: utcTimestamp(input.dueAt, "dueAt"),
    hypothesis: text(input.hypothesis, "hypothesis", { max: 2_000 }),
    successMetricDefinitionId: identifier(input.successMetricDefinitionId, "successMetricDefinitionId", false),
  };
}

export function normalizeJournalExport(input = {}, options = {}) {
  const common = base(input, options.now || (() => new Date().toISOString()));
  return {
    ...common,
    journalDate: utcDate(input.journalDate, "journalDate"),
    relativePath: text(input.relativePath, "relativePath", { max: 240, pattern: /^improvement-journal\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/ }),
    contentSha256: text(input.contentSha256, "contentSha256", { max: 64, pattern: /^[0-9a-f]{64}$/ }),
    entryCount: positiveInteger(input.entryCount, "entryCount", { allowZero: true }),
    throughRecordedAt: input.throughRecordedAt ? utcTimestamp(input.throughRecordedAt, "throughRecordedAt") : "",
    throughId: identifier(input.throughId, "throughId", false),
    exportedAt: utcTimestamp(input.exportedAt || common.recordedAt, "exportedAt"),
  };
}

export function boundedListInput(input = {}, timestampField = "occurredAt") {
  const limit = input.limit == null ? DELIVERY_TELEMETRY_DEFAULT_LIMIT : positiveInteger(input.limit, "limit");
  if (limit > DELIVERY_TELEMETRY_MAX_LIMIT) fail(`limit must be at most ${DELIVERY_TELEMETRY_MAX_LIMIT}.`);
  const cursor = input.cursor || null;
  return {
    limit,
    cursor: cursor ? {
      timestamp: utcTimestamp(cursor.timestamp, `cursor.${timestampField}`),
      id: identifier(cursor.id, "cursor.id"),
    } : null,
  };
}

