import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { mutateState, readStateReadOnly } from "./store.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
  registerIsolatedTestAdapter,
} from "./test-authority-realm.js";

const SCHEMA = "studioops.qa-integration-attempt-claim.v1";
const PROBE_KIND = "qa-claim-recovery-owner-probe";
const testAuthority = consumeIsolatedTestAuthority((capability) => capability);

function refused(message) {
  const error = new Error(message);
  error.code = "QA_CLAIM_RECOVERY_REFUSED";
  return error;
}

export function createQaClaimRecoveryTestProbe(run) {
  assertCurrentIsolatedTestAuthority(testAuthority);
  return registerIsolatedTestAdapter(testAuthority, PROBE_KIND, run);
}

function expectedClaim(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw refused("Recovery requires an explicit claim identity object.");
  for (const key of ["projectId", "claimId", "ownerHost"]) {
    if (typeof input[key] !== "string") throw refused(`Recovery requires an explicit string ${key}.`);
  }
  for (const key of ["fence", "ownerPid"]) {
    if (!(typeof input[key] === "number" || (typeof input[key] === "string" && /^[1-9]\d*$/.test(input[key])))) {
      throw refused(`Recovery requires an explicit integer ${key}.`);
    }
  }
  for (const key of ["state", "qaProcessAlive", "qaOwnerHost", "qaAttemptNowMs", "nowMs", "processAlive"]) {
    if (key in input) throw refused(`Recovery does not accept ${key} overrides.`);
  }
  const expected = {
    projectId: String(input.projectId || ""),
    claimId: String(input.claimId || ""),
    fence: Number(input.fence),
    ownerPid: Number(input.ownerPid),
    ownerHost: String(input.ownerHost || "").trim().toLowerCase(),
  };
  if (![expected.projectId, expected.claimId].every((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    || !Number.isSafeInteger(expected.fence) || expected.fence < 1
    || !Number.isSafeInteger(expected.ownerPid) || expected.ownerPid < 1 || expected.ownerPid > 2147483647
    || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(expected.ownerHost)) {
    throw refused("Recovery requires the exact project, claim ID, positive fence, owner PID and owner host.");
  }
  if (expected.ownerHost !== os.hostname().trim().toLowerCase()) {
    throw refused("Recovery can verify only a claim owned by this host.");
  }
  return expected;
}

function exactClaim(state, expected) {
  const claim = state.meta?.qaIntegrationAttemptClaims?.[expected.projectId];
  if (!claim || typeof claim !== "object" || Array.isArray(claim) || claim.schemaVersion !== SCHEMA
    || Object.entries(expected).some(([key, value]) => claim[key] !== value)
    || typeof claim.authorityDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(claim.authorityDigest)
    || typeof claim.expiresAt !== "string" || !Number.isFinite(Date.parse(claim.expiresAt))) {
    throw refused("The current QA claim does not match the exact requested identity.");
  }
  return claim;
}

function alreadyRecovered(state, claim) {
  if (claim.status !== "terminal" || claim.outcome !== "owner_process_absent") return false;
  if (!Array.isArray(state.meta?.qaIntegrationAttemptClaimHistory)) return false;
  return (state.meta?.qaIntegrationAttemptClaimHistory || []).some((entry) => (
    entry.status === "abandoned" && entry.outcome === "owner_process_absent"
    && entry.claimId === claim.claimId && entry.fence === claim.fence
    && entry.projectId === claim.projectId && entry.ownerPid === claim.ownerPid
    && entry.ownerHost === claim.ownerHost && entry.terminalAt === claim.terminalAt
    && entry.originalClaim?.status === "active"
    && isDeepStrictEqual(claim, { ...entry.originalClaim, status: "terminal", terminalAt: entry.terminalAt, outcome: "owner_process_absent" })
  ));
}

function requireAbsentOwner(claim, input) {
  let probe;
  if (input.testOwnerProbe !== undefined) {
    assertCurrentIsolatedTestAuthority(testAuthority);
    probe = isolatedTestAdapterRun(input.testOwnerProbe, PROBE_KIND);
    if (!probe) throw refused("Unregistered recovery owner probe.");
  }
  // Never use caller-supplied host/liveness functions as production evidence.
  if (claim.ownerHost !== os.hostname().trim().toLowerCase()) throw refused("Owner host changed.");
  try {
    if (probe) {
      if (probe(claim.ownerPid) === "absent") return;
    } else {
      process.kill(claim.ownerPid, 0);
    }
  } catch (error) {
    if (!probe && error?.code === "ESRCH") return;
    throw refused("Owner absence could not be verified.");
  }
  throw refused("The QA owner is alive or its absence is uncertain.");
}

export async function recoverAbandonedQaClaim(input = {}) {
  const expected = expectedClaim(input);
  const state = await readStateReadOnly();
  const current = exactClaim(state, expected);
  if (alreadyRecovered(state, current)) {
    return { ...expected, status: "already_recovered", changed: false };
  }
  if (current.status !== "active") throw refused("Only an active abandoned claim can be recovered.");
  requireAbsentOwner(current, input);
  if (input.dryRun) return { ...expected, status: "recoverable", changed: false };
  return mutateState((latest) => {
    const claim = exactClaim(latest, expected);
    if (alreadyRecovered(latest, claim)) return { ...expected, status: "already_recovered", changed: false };
    if (claim.status !== "active") throw refused("QA claim status changed before recovery.");
    // This synchronous check runs again on every optimistic transaction replay.
    requireAbsentOwner(claim, input);
    const terminalAt = new Date().toISOString();
    const history = latest.meta.qaIntegrationAttemptClaimHistory;
    if (history !== undefined && !Array.isArray(history)) throw refused("Malformed QA claim history.");
    latest.meta.qaIntegrationAttemptClaimHistory = [
      ...(history || []),
      { ...claim, status: "abandoned", terminalAt, outcome: "owner_process_absent", originalClaim: structuredClone(claim) },
    ];
    claim.status = "terminal";
    claim.terminalAt = terminalAt;
    claim.outcome = "owner_process_absent";
    return { ...expected, status: "recovered", changed: true, terminalAt };
  }, { operationName: "qa_integration.recover_abandoned_claim" });
}
