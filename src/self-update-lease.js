const DEFAULT_SELF_UPDATE_LEASE_MS = 10 * 60 * 1000;

export { DEFAULT_SELF_UPDATE_LEASE_MS };

function nowMsFrom(input = {}) {
  const parsed = Number(input.nowMs);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function leaseDurationMs(input = {}) {
  const parsed = Number(input.selfUpdateLeaseMs || input.leaseMs || DEFAULT_SELF_UPDATE_LEASE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SELF_UPDATE_LEASE_MS;
}

export function activeSelfUpdateLease(state, input = {}) {
  const lease = state?.meta?.selfUpdateLease;
  if (!lease || typeof lease !== "object") return null;

  const expiresMs = Date.parse(lease.expiresAt || "");
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMsFrom(input)) return null;

  return {
    id: String(lease.id || "unknown").trim() || "unknown",
    ownerPid: String(lease.ownerPid || "").trim(),
    repoPath: String(lease.repoPath || "").trim(),
    branch: String(lease.branch || "").trim(),
    remoteRef: String(lease.remoteRef || "").trim(),
    startedAt: String(lease.startedAt || "").trim(),
    expiresAt: String(lease.expiresAt || "").trim(),
  };
}

export function createSelfUpdateLease(input = {}) {
  const nowMs = nowMsFrom(input);
  const leaseMs = Math.max(1000, leaseDurationMs(input));
  const leaseId = String(input.leaseId || `self_update_${process.pid}_${nowMs}`).trim();

  return {
    id: leaseId,
    ownerPid: String(process.pid),
    repoPath: String(input.repoPath || "").trim(),
    branch: String(input.branch || "").trim(),
    remoteRef: String(input.remoteRef || "").trim(),
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
  };
}
