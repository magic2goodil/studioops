/** Persist only the public admission DTO, never raw provider/config payloads. */
export function sanitizedCreditAdmission(value = {}) {
  const result = {};
  for (const key of ["enabled", "allowed", "fallbackUsed", "explicitFailClosedMatch"]) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  for (const key of ["tier", "riskTier", "ruleId", "code", "mode", "fundingMode", "reasonCode", "snapshotStatus", "snapshotSource", "decision", "snapshotClass"]) {
    if (/^[a-zA-Z0-9_.:-]{1,120}$/.test(String(value[key] || ""))) result[key] = value[key];
  }
  for (const key of ["policyVersion", "estimatedCredits", "minRemainingPercent", "remainingPercent", "maxConcurrentRuns", "maxAttempts", "estimatedTokensPerRun", "maxInFlightEstimatedTokens", "snapshotAgeMs"]) {
    result[key] = value[key] !== null && value[key] !== undefined && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0 ? Number(value[key]) : null;
  }
  if (value.fundingMode === "prepaid") {
    for (const key of ["maxEstimatedCredits", "prepaidCreditLimit", "prepaidClaimSequence", "prepaidCommittedCreditsAfterClaim"]) {
      if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] > 0) result[key] = value[key];
    }
  }
  const timestamp = input => Number.isFinite(Date.parse(input || "")) ? new Date(input).toISOString() : "";
  result.snapshotObservedAt = timestamp(value.snapshotObservedAt);
  if (/^sha256:[a-f0-9]{64}$/.test(value.fallbackAttemptKey || "")) result.fallbackAttemptKey = value.fallbackAttemptKey;
  result.observedCounters = {};
  for (const key of ["activeRuns", "selectedRuns", "reservedRuns", "activeEstimatedTokens", "selectedEstimatedTokens", "reservedEstimatedTokens", "attemptsConsumed", "committedEstimatedCredits", "queuedEstimatedCredits", "selectedEstimatedCredits", "reservedEstimatedCredits", "prepaidClaimCount"]) {
    if (Number.isFinite(Number(value.observedCounters?.[key])) && Number(value.observedCounters[key]) >= 0) result.observedCounters[key] = Number(value.observedCounters[key]);
  }
  const retry = value.retryEvidence || {};
  result.retryEvidence = { attempted: retry.attempted === true, attemptCount: retry.attempted === true ? 1 : 0 };
  for (const key of ["initialSnapshotStatus", "resultSnapshotStatus", "initialSnapshotSource", "resultSnapshotSource"]) {
    if (/^[a-zA-Z0-9_.:-]{1,80}$/.test(retry[key] || "")) result.retryEvidence[key] = retry[key];
  }
  for (const key of ["initialSnapshotObservedAt", "resultSnapshotObservedAt"]) result.retryEvidence[key] = timestamp(retry[key]);
  const binding = value.reservationBinding || {};
  result.reservationBinding = { schemaVersion: 1 };
  for (const key of ["taskId", "runId", "ruleId"]) if (/^[a-zA-Z0-9_.:-]{1,180}$/.test(binding[key] || "")) result.reservationBinding[key] = binding[key];
  if (Number.isSafeInteger(binding.policyVersion) && binding.policyVersion > 0) result.reservationBinding.policyVersion = binding.policyVersion;
  return result;
}

export function validPrepaidCreditLedger(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "claimCount,committedEstimatedCredits,lastClaimedAt,schemaVersion"
    && value.schemaVersion === 1 && Number.isSafeInteger(value.claimCount) && value.claimCount >= 0
    && typeof value.committedEstimatedCredits === "number" && Number.isFinite(value.committedEstimatedCredits)
    && value.committedEstimatedCredits >= 0
    && (value.claimCount === 0 ? value.committedEstimatedCredits === 0 && value.lastClaimedAt === ""
      : value.committedEstimatedCredits > 0 && typeof value.lastClaimedAt === "string"
        && Number.isFinite(Date.parse(value.lastClaimedAt))));
}

