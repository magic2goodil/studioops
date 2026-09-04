import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProgressReport,
  decodeProgressCursor,
  encodeProgressCursor,
  normalizeProgressWindow,
  progressReportLimits,
  resolveProgressProject,
} from "../src/progress-report.js";

const NOW = "2026-09-05T12:00:00.000Z";

function fixture() {
  return {
    meta: {},
    projects: [
      { id: "project_studioops", key: "studioops", name: "StudioOps", repoPath: "/Users/private/studioops" },
      { id: "project_other", key: "other", name: "Other Project" },
    ],
    tasks: [
      { id: "task_956", projectId: "project_studioops", title: "Expose progress", status: "blocked", retryNotBefore: "2026-09-05T12:30:00.000Z", automationBlocker: { reason: "provider_rate_limited" } },
      { id: "task_other", projectId: "project_other", title: "Do not cross projects", status: "blocked", automationBlocker: { reason: "repository_unavailable", message: "/Users/private/token=secret" } },
    ],
    runs: [
      { id: "run_1", taskId: "task_956", projectId: "project_studioops", status: "completed", completedAt: "2026-09-05T11:00:00.000Z", outputPath: "/private/log" },
      { id: "run_2", taskId: "task_other", projectId: "project_other", status: "completed", completedAt: "2026-09-05T11:00:00.000Z" },
    ],
    events: [
      { id: "event_1", taskId: "task_956", projectId: "project_studioops", type: "review_recorded", createdAt: "2026-09-05T11:30:00.000Z", message: "Bearer secret" },
      { id: "event_2", taskId: "task_other", projectId: "project_other", type: "review_recorded", createdAt: "2026-09-05T11:30:00.000Z" },
    ],
  };
}

function incident(overrides = {}) {
  return {
    incidentId: "failure_aaaaaaaaaaaaaaaaaaaaaaaa-g1",
    taskId: "task_956",
    reasonCode: "provider_rate_limited",
    state: "backoff",
    generation: 1,
    paidAttempts: 1,
    cheapProbeAttempts: 2,
    repairAttempts: 1,
    avoidedRetries: 3,
    backoffUntil: "2026-09-05T12:30:00.000Z",
    updatedAt: "2026-09-05T11:50:00.000Z",
    evidence: { repository: { branch: "secret" } },
    ...overrides,
  };
}

test("progress report is project-bound, durable, bounded, and browser-safe", () => {
  const state = fixture();
  const project = resolveProgressProject(state, "studioops");
  const report = buildProgressReport(state, {
    incidents: [incident(), incident({ incidentId: "failure_bbbbbbbbbbbbbbbbbbbbbbbb-g1", taskId: "task_other" })],
    windowIncidents: [incident()],
    incidentTotals: {
      containedFingerprintGenerations: 1,
      cheapProbesAndRepairs: 3,
      paidModelAttempts: 1,
      avoidedModelRetries: 3,
    },
    limit: 100,
  }, { project, window: "24h", nowMs: Date.parse(NOW) });

  assert.deepEqual(report.project, { id: "project_studioops", key: "studioops", name: "StudioOps" });
  assert.equal(report.summary.productiveCompletions, 1);
  assert.equal(report.summary.meaningfulAdvances, 1);
  assert.equal(report.summary.containedFingerprintGenerations, 1);
  assert.equal(report.summary.cheapProbesAndRepairs, 3);
  assert.equal(report.summary.paidModelAttempts, 1);
  assert.equal(report.summary.avoidedModelRetries, 3);
  assert.equal(report.waiting.length, 1);
  assert.equal(report.waiting[0].retryAt, "2026-09-05T12:30:00.000Z");
  assert.equal(report.incidents.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < progressReportLimits.maxResponseBytes);
  assert.doesNotMatch(JSON.stringify(report), /Users|Bearer|secret|outputPath|evidence/);
});

test("progress parameters are allowlisted and cursors are opaque exact row coordinates", () => {
  assert.equal(normalizeProgressWindow(), "24h");
  assert.throws(() => normalizeProgressWindow("30d"), (error) => error.code === "PROGRESS_WINDOW_INVALID");
  assert.throws(() => resolveProgressProject(fixture(), "missing"), (error) => error.status === 404);
  const value = incident();
  const cursor = encodeProgressCursor(value);
  assert.deepEqual(decodeProgressCursor(cursor), { updatedAt: value.updatedAt, incidentId: value.incidentId });
  assert.throws(() => decodeProgressCursor("not-a-cursor"), (error) => error.code === "PROGRESS_CURSOR_INVALID");
});

test("retry time appears only while a task is actually in future backoff", () => {
  const state = fixture();
  state.tasks[0].retryNotBefore = "2026-09-05T11:59:00.000Z";
  const report = buildProgressReport(state, {}, {
    project: state.projects[0],
    window: "1h",
    nowMs: Date.parse(NOW),
  });
  assert.equal(Object.hasOwn(report.waiting[0], "retryAt"), false);
});
