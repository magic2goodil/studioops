#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactOperationalHistory, operationalRetentionPolicy } from "../src/state-database.js";
import { planWatchdogActions } from "../src/watchdog.js";

const WORKERS = ["dispatcher", "runner", "supervisor", "notifier"];

function healthyHeartbeats(now) {
  return WORKERS.map((worker) => ({
    worker,
    status: "idle",
    updatedAt: now,
    lastSweepStartedAt: now,
    intervalSeconds: 15,
  }));
}

function assertBound(condition, message) {
  if (!condition) throw new Error(`Operational soak failed: ${message}`);
}

export function runOperationalSoak(input = {}) {
  const hours = Math.max(1, Number(input.hours || 24));
  const stepMinutes = Math.max(1, Number(input.stepMinutes || 5));
  const steps = Math.ceil((hours * 60) / stepMinutes);
  const startMs = Number(input.startMs || Date.parse("2026-08-01T00:00:00.000Z"));
  const policy = operationalRetentionPolicy({
    machineCommentsPerTask: input.machineCommentsPerTask || 12,
    eventsPerStream: input.eventsPerStream || 40,
    terminalRunsPerWorkflowAction: input.terminalRunsPerWorkflowAction || 3,
    notificationDays: input.notificationDays || 1,
    notificationMaxRows: input.notificationMaxRows || 50,
  }, {});
  const state = {
    meta: {}, projects: [], tasks: [], reviews: [], qaBundles: [], candidates: [],
    comments: [], events: [], runs: [], notificationOutbox: [],
  };
  const archived = { comments: 0, events: 0, runs: 0, notificationOutbox: 0 };
  const failures = [];
  const injectionSteps = new Map([6, 12, 18]
    .filter((hour) => hour < hours)
    .map((hour) => [Math.round((hour * 60) / stepMinutes), hour]));

  for (let step = 0; step < steps; step += 1) {
    const nowMs = startMs + step * stepMinutes * 60 * 1000;
    const now = new Date(nowMs).toISOString();
    state.comments.push({
      id: `comment_${step}`, taskId: "task_soak", kind: "run_update",
      systemGenerated: true, body: "bounded machine evidence", createdAt: now,
    });
    state.events.push({
      id: `event_${step}`, taskId: "task_soak", type: "automation_tick",
      executionKey: "soak-loop", message: "bounded loop evidence", createdAt: now,
    });
    state.runs.push({
      id: `run_${step}`, taskId: "task_soak", actionType: "builder", role: "builder",
      status: step % 7 === 0 ? "failed" : "completed", maxAttempts: 2,
      createdAt: now, completedAt: now, updatedAt: now,
    });
    state.notificationOutbox.push({
      id: `notification_${step}`, status: "acknowledged", attempts: 1,
      createdAt: now, updatedAt: now, acknowledgedAt: now,
    });
    const compacted = compactOperationalHistory(state, { ...policy, nowMs });
    for (const key of Object.keys(archived)) archived[key] += compacted[key].length;

    const elapsedHours = injectionSteps.get(step);
    if (elapsedHours !== undefined) {
      const heartbeats = healthyHeartbeats(now);
      let actions;
      let kind;
      if (elapsedHours < 9) {
        kind = "queue_stall";
        heartbeats.find((item) => item.worker === "runner").lastSweepStartedAt = new Date(nowMs - 120_000).toISOString();
        actions = planWatchdogActions({
          meta: {},
          tasks: [],
          runs: [{ id: "queued_failure", status: "queued", createdAt: new Date(nowMs - 120_000).toISOString() }],
        }, heartbeats, { nowMs, workWaitMs: 45_000 });
      } else if (elapsedHours < 15) {
        kind = "worker_loss";
        actions = planWatchdogActions({ meta: {}, tasks: [], runs: [] }, heartbeats.filter((item) => item.worker !== "notifier"), { nowMs });
      } else {
        kind = "disk_pressure";
        actions = planWatchdogActions({ meta: {}, tasks: [], runs: [] }, heartbeats, {
          nowMs,
          disk: { pressure: true, availableBytes: 1, availablePercent: 0.1, path: "/test" },
        });
      }
      const recoveredActions = planWatchdogActions({ meta: {}, tasks: [], runs: [] }, healthyHeartbeats(now), {
        nowMs: nowMs + 60_000,
        disk: { pressure: false },
      });
      failures.push({ kind, detected: actions.length > 0, recovered: recoveredActions.length === 0, actions });
    }
  }

  const bounds = {
    comments: state.comments.length,
    events: state.events.length,
    runs: state.runs.length,
    notifications: state.notificationOutbox.length,
  };
  assertBound(bounds.comments <= policy.machineCommentsPerTask, "machine comments exceeded policy");
  assertBound(bounds.events <= policy.eventsPerStream, "events exceeded policy");
  assertBound(bounds.runs <= Math.max(policy.terminalRunsPerWorkflowAction, 3), "terminal runs exceeded policy");
  assertBound(bounds.notifications <= policy.notificationMaxRows, "notifications exceeded policy");
  assertBound(failures.length === 3 && failures.every((failure) => failure.detected && failure.recovered), "injected failures did not detect and recover");
  return {
    simulatedHours: hours,
    stepMinutes,
    iterations: steps,
    policy,
    bounds,
    archived,
    injectedFailures: failures,
    bounded: true,
    recovered: true,
  };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const hoursIndex = process.argv.indexOf("--hours");
  const hours = hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1]) : 24;
  console.log(JSON.stringify(runOperationalSoak({ hours }), null, 2));
}
