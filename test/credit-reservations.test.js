import assert from "node:assert/strict";
import test from "node:test";
import { assessCreditAdmission, normalizeCreditSnapshot } from "../src/credit-policy.js";
import { planDispatches, dispatchSupervisorActions } from "../src/dispatcher.js";
import { claimRuns, runConsumesExecutionCapacity } from "../src/runner.js";
import { createCreditReservationPlan, creditFallbackAttemptKey, assessCreditReservation, sanitizedCreditAdmission, updateCreditExhaustionState } from "../src/credit-reservations.js";
import { createFailureIncident, failureFingerprint } from "../src/failure-containment.js";
import { addProject, addTask, mutateState, readStateReadOnly, persistCreditAdmissionPauseInState,
  recoverCreditAdmissionPauseInState } from "../src/store.js";

const unknown = () => ({ status: "unknown", source: "studioops", observedAt: new Date().toISOString(), remainingPercent: null });
const policy = (patch = {}) => ({ enabled: true, degradedTelemetryFallback: { policyVersion: 1, explicitFailClosedLabels: ["credit-fail-closed"],
  rules: { balanced: { ruleId: "balanced-v1", mode: "bounded", maxConcurrentRuns: 1, maxAttempts: 1,
    estimatedTokensPerRun: 1000, maxInFlightEstimatedTokens: 1000, ...patch } } } });

function fixture() {
  const state = { projects: [{ id: "project_1", key: "synthetic", repoPath: "/synthetic", workflowMode: "local" }],
    tasks: [1, 2, 3].map(i => ({ id: `task_${i}`, projectId: "project_1", title: "Independent change", status: "ready",
      assignedAgentRole: "builder", lane: "backend", workAreas: [`src/${i}.js`] })), runs: [], comments: [], events: [] };
  const actions = state.tasks.map(t => ({ id: `${t.id}:start_builder`, type: "start_builder", role: "builder", taskId: t.id,
    projectId: t.projectId, taskStatus: "ready" }));
  const options = { state, creditPolicy: policy(), creditSnapshot: unknown(), creditSnapshotProbe: async () => unknown(),
    failureIncidents: [], executionPolicy: { modelTiers: { balanced: { model: "synthetic-model" } }, tierRouting: { defaultTier: "balanced" } }, builderConcurrency: 10 };
  return { state, actions, options };
}

function queued(state, task, id) {
  task.status = "queued";
  const run = { id, taskId: task.id, projectId: task.projectId, status: "queued", group: "builder", role: "builder",
    modelTier: "balanced", actionType: "start_builder", provider: "codex-sdk", attempt: 1, maxAttempts: 2,
    lane: "backend", fileScope: task.workAreas, fileScopeExplicit: true };
  state.runs.push(run);
  return run;
}

test("fallback planning reserves same-sweep concurrency/tokens and persists immutable sanitized evidence", async () => {
  const { state, actions, options } = fixture();
  const report = await dispatchSupervisorActions(actions, options);
  assert.equal(report.runs.length, 1);
  assert.equal(report.skipped.filter(s => s.reason === "credit_gate:fallback_concurrency_exhausted").length, 2);
  const run = report.runs[0];
  assert.equal(run.creditAdmission.fallbackUsed, true);
  assert.equal(run.creditAdmission.maxAttempts, 1);
  assert.equal(run.maxAttempts, 2); // Fault ordinal and actual fallback claims are distinct counters.
  assert.equal(run.maxFallbackAttempts, 1);
  assert.equal(run.creditAdmission.reservationBinding.runId, run.id);
  assert.deepEqual(state.events.find(e => e.type === "credit_fallback_dispatched").creditAdmission, run.creditAdmission);
  assert.equal(state.tasks[1].status, "ready");
  assert.equal(state.tasks[1].automationCircuit, undefined);
  assert.equal(state.tasks[1].creditAdmissionPause.active, true);
  await dispatchSupervisorActions(actions, options);
  assert.equal(state.events.filter(e => e.type === "credit_admission_paused").length, 2);
});

test("aggregate token reservations remain conjunctive with concurrency", () => {
  const { state, actions, options } = fixture();
  options.creditPolicy = policy({ maxConcurrentRuns: 3, maxInFlightEstimatedTokens: 1500 });
  const report = planDispatches(state, actions, options);
  assert.equal(report.selected.length, 1);
  assert.equal(report.skipped[0].reason, "credit_gate:fallback_token_reservation_exhausted");
});

test("claim rechecks current capacity atomically for normal-queued runs that now need fallback", async () => {
  const { state, options } = fixture();
  const first = queued(state, state.tasks[0], "run_1");
  const second = queued(state, state.tasks[1], "run_2");
  let preflights = 0;
  const claimed = await claimRuns({ ...options, limit: 10, preflightRun: async () => { preflights++; return { ok: true, workflowMode: "local" }; } });
  assert.equal(claimed.length, 1);
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.equal(second.creditClaimBlocker.code, "fallback_concurrency_exhausted");
  assert.equal(runConsumesExecutionCapacity(state, second), false);
  assert.equal(runConsumesExecutionCapacity(state, first), true);
  const reservations = createCreditReservationPlan(state, r => runConsumesExecutionCapacity(state, r));
  const admission = assessCreditReservation(assessCreditAdmission(unknown(), { modelTier: "balanced" }, policy()), reservations, { attemptKey: "other" });
  assert.equal(admission.allowed, false); // Claim-time fallback ownership survives the next sweep.
  assert.ok(preflights <= 2);
});

test("own queued reservation is not double counted and earlier queue owner wins", async () => {
  const { state, options } = fixture();
  for (let i = 0; i < 2; i++) {
    const run = queued(state, state.tasks[i], `run_${i + 1}`);
    const admission = assessCreditAdmission(unknown(), { modelTier: "balanced" }, policy());
    run.creditAdmission = assessCreditReservation(admission, createCreditReservationPlan({ runs: [] }), {
      taskId: run.taskId, attemptKey: creditFallbackAttemptKey(state.tasks[i], run), claimRunId: run.id });
  }
  const claimed = await claimRuns({ ...options, limit: 10, preflightRun: async () => ({ ok: true, workflowMode: "local" }) });
  assert.deepEqual(claimed.map(r => r.id), ["run_1"]);
  assert.equal(claimed[0].fallbackAttempt, 1);
});

test("paused queued work releases reservation while paused running ownership remains", async () => {
  const { state, options } = fixture();
  const first = queued(state, state.tasks[0], "run_1");
  const second = queued(state, state.tasks[1], "run_2");
  first.creditAdmission = { fallbackUsed: true, tier: "balanced", estimatedTokensPerRun: 1000 };
  state.tasks[0].budgetPause = { runId: first.id };
  let claimed = await claimRuns({ ...options, limit: 10, preflightRun: async () => ({ ok: true, workflowMode: "local" }) });
  assert.deepEqual(claimed.map(r => r.id), ["run_2"]);
  assert.equal(first.status, "queued");
  state.tasks[2].status = "queued";
  queued(state, state.tasks[2], "run_3");
  state.tasks[1].budgetPause = { runId: second.id };
  claimed = await claimRuns({ ...options, limit: 10, preflightRun: async () => ({ ok: true, workflowMode: "local" }) });
  assert.equal(claimed.length, 0);
  assert.equal(second.status, "running");
});

test("fallback attempt binding survives provider/action/rule/cycle aliases and advances only verified recovery", () => {
  const { state, actions } = fixture();
  const task = state.tasks[0], action = actions[0];
  const key = creditFallbackAttemptKey(task, action);
  assert.equal(creditFallbackAttemptKey({ ...task, reviewCycle: 99, candidateIdentity: { candidateCycle: 999 } }, { ...action, type: "return_to_builder", provider: "codex-cli" }), key);
  const incident = createFailureIncident({ fingerprint: failureFingerprint({ taskId: task.id, action: "start_builder", provider: "codex-sdk", reasonCode: "provider_unavailable" }) });
  incident.history.push({ type: "evidence_verified", evidenceDigest: `sha256:${"a".repeat(64)}`, recordedAt: new Date().toISOString() });
  assert.notEqual(creditFallbackAttemptKey(task, action, [incident]), key);
  const run = { id: "old", taskId: task.id, status: "failed", startedAt: new Date().toISOString(),
    creditAdmission: { fallbackUsed: true, tier: "balanced", estimatedTokensPerRun: 1000, fallbackAttemptKey: key } };
  const plan = createCreditReservationPlan({ runs: [run] });
  const admission = assessCreditAdmission(unknown(), { modelTier: "balanced" }, policy({ ruleId: "renamed-rule" }));
  assert.equal(assessCreditReservation(admission, plan, { attemptKey: key }).code, "fallback_attempt_budget_exhausted");
  assert.equal(assessCreditReservation(admission, plan, { attemptKey: creditFallbackAttemptKey(task, action, [incident]) }).allowed, true);
});

test("known exhaustion never falls back after telemetry becomes stale and missing numbers remain unknown", () => {
  for (const snapshot of [{ ...unknown(), status: "stale", reached: true }, { ...unknown(), remainingPercent: 0 },
    { ...unknown(), credits: { available: true, balance: 0 } }]) {
    const admission = assessCreditAdmission(snapshot, { modelTier: "balanced" }, policy());
    assert.equal(admission.allowed, false);
    assert.equal(admission.fallbackUsed, false);
  }
  assert.equal(assessCreditAdmission(unknown(), { modelTier: "balanced" }, policy()).allowed, true);
});

test("fresh telemetry clears one transient pause and evaluates normal admission in the same sweep", async () => {
  const { state, actions, options } = fixture();
  options.creditPolicy = policy({ mode: "fail_closed" });
  await dispatchSupervisorActions([actions[0]], options);
  assert.equal(state.tasks[0].creditAdmissionPause.active, true);
  options.creditSnapshot = { status: "available", source: "studioops", observedAt: new Date().toISOString(), remainingPercent: 90 };
  const result = await dispatchSupervisorActions([actions[0]], options);
  assert.equal(result.runs.length, 1);
  assert.equal(state.tasks[0].creditAdmissionPause.active, false);
  assert.equal(state.events.filter(e => e.type === "credit_admission_recovered").length, 1);
});

test("credit evidence strips unrecognized payloads and normalizes bounded retry facts", () => {
  const evidence = sanitizedCreditAdmission({ secret: "synthetic-secret", accountEmail: "synthetic@example.invalid", code: "safe", retryEvidence: { attempted: true, attemptCount: 999, token: "hidden" } });
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic|hidden|token/);
  assert.deepEqual(evidence.retryEvidence.attemptCount, 1);
});

test("claim blocks known exhaustion and mismatched reservation binding before any preflight", async () => {
  const { state, options } = fixture();
  const run = queued(state, state.tasks[0], "run_1");
  let calls = 0;
  const input = { ...options, limit: 10, preflightRun: async () => { calls++; return { ok: true, workflowMode: "local" }; } };
  input.creditSnapshot = { ...unknown(), status: "stale", reached: true };
  assert.equal((await claimRuns(input)).length, 0);
  assert.equal(calls, 0);
  assert.equal(run.startedAt, undefined);
  const second = fixture();
  const other = queued(second.state, second.state.tasks[0], "run_other");
  other.creditAdmission = { fallbackUsed: true, reservationBinding: { taskId: "another_task", runId: other.id } };
  assert.equal((await claimRuns({ ...second.options, preflightRun: input.preflightRun })).length, 0);
  assert.equal(other.creditClaimBlocker.code, "fallback_reservation_binding_invalid");
  assert.equal(calls, 0);
});

test("observed global exhaustion survives unknown ticks/new tasks until newer fresh telemetry", async () => {
  const { state, actions, options } = fixture();
  let probes = 0;
  options.creditSnapshotProbe = async () => { probes++; return unknown(); };
  options.creditSnapshot = { ...unknown(), reached: true, observedAt: new Date(Date.now() - 1000).toISOString() };
  await dispatchSupervisorActions([actions[0]], options);
  assert.equal(state.meta.creditObservedExhaustion.active, true);
  options.creditSnapshot = unknown();
  const blocked = await dispatchSupervisorActions([actions[1]], options);
  assert.equal(blocked.runs.length, 0);
  assert.equal(blocked.skipped[0].reason, "credit_gate:rate_limit_reached");
  assert.equal(probes, 0);
  options.creditSnapshot = { status: "available", source: "studioops", observedAt: new Date().toISOString(), remainingPercent: 80 };
  const recovered = await dispatchSupervisorActions([actions[1]], options);
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(recovered.runs.length, 1);
});

test("an older observer cannot resurrect exhaustion after a newer fresh confirmation", () => {
  const now = Date.now();
  const staleLimit = { status: "available", source: "studioops", observedAt: new Date(now - 2000).toISOString(), reached: true, remainingPercent: 0 };
  const fresh = { status: "available", source: "studioops", observedAt: new Date(now - 1000).toISOString(), remainingPercent: 80 };
  const state = {};
  updateCreditExhaustionState(state, staleLimit);
  updateCreditExhaustionState(state, fresh, { policy: policy() });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  updateCreditExhaustionState(state, staleLimit);
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  const result = assessCreditAdmission(staleLimit, { modelTier: "balanced" }, policy(), { knownExhaustion: state.meta.creditObservedExhaustion });
  assert.equal(result.snapshotStatus, "stale");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.allowed, true);
  updateCreditExhaustionState(state, { ...staleLimit, observedAt: new Date(now).toISOString() });
  assert.equal(state.meta.creditObservedExhaustion.active, true);
});

test("configured freshness preserves observed exhaustion at dispatch and atomic claim", async () => {
  const now = Date.now();
  const exhausted = { status: "available", observedAt: new Date(now - 60_000).toISOString(), remainingPercent: 0, reached: true };
  const incoming = { status: "available", observedAt: new Date(now - 5_000).toISOString(), remainingPercent: 90 };
  for (const mode of ["dispatch", "claim"]) {
    const { state, actions, options } = fixture();
    options.creditPolicy.snapshotMaxAgeMs = 1_000;
    options.creditSnapshot = incoming;
    updateCreditExhaustionState(state, exhausted, { policy: options.creditPolicy });
    const marker = structuredClone(state.meta.creditObservedExhaustion);
    if (mode === "dispatch") {
      assert.equal((await dispatchSupervisorActions([actions[0]], options)).runs.length, 0);
    } else {
      const run = queued(state, state.tasks[0], "run_freshness");
      let preflights = 0;
      assert.equal((await claimRuns({ ...options, preflightRun: async () => { preflights++; return { ok: true }; } })).length, 0);
      assert.equal(preflights, 0);
      assert.equal(run.creditClaimBlocker.code, "rate_limit_reached");
    }
    assert.deepEqual(state.meta.creditObservedExhaustion, marker);
    const assessed = assessCreditAdmission(incoming, { modelTier: "balanced" }, options.creditPolicy,
      { knownExhaustion: marker });
    assert.equal(assessed.snapshotStatus, "stale");
    assert.equal(assessed.allowed, false);
  }
});

test("partial telemetry and status labels cannot invent measured capacity or clear exhaustion", () => {
  const now = Date.now(), observedAt = new Date(now).toISOString();
  const partial = normalizeCreditSnapshot({ rateLimits: { limitId: "codex" } }, { observedAt });
  assert.equal(partial.status, "unknown");
  for (const incoming of [partial,
    { status: "available", observedAt, remainingPercent: null, credits: { available: false, balance: null } },
    { status: "recovered", observedAt, remainingPercent: " ", credits: { unlimited: "true" } },
    { status: "available", observedAt, remainingPercent: true, credits: { available: true, balance: false } }]) {
    const configured = policy({ mode: "fail_closed" }), state = {};
    const prior = { status: "available", observedAt: new Date(now - 1_000).toISOString(), reached: true, remainingPercent: 0 };
    updateCreditExhaustionState(state, prior, { policy: configured });
    const before = structuredClone(state.meta.creditObservedExhaustion);
    updateCreditExhaustionState(state, incoming, { policy: configured });
    assert.deepEqual(state.meta.creditObservedExhaustion, before);
    const assessed = assessCreditAdmission(incoming, { modelTier: "balanced" }, configured, { knownExhaustion: before });
    assert.equal(assessed.allowed, false);
    assert.equal(assessed.code, "rate_limit_reached");
    const noPrior = assessCreditAdmission(incoming, { modelTier: "balanced" }, configured);
    assert.equal(noPrior.snapshotStatus, "unknown");
    assert.equal(noPrior.allowed, false);
    assert.equal(noPrior.fallbackUsed, true);
  }
  const bounded = assessCreditAdmission({ status: "available", observedAt, remainingPercent: null },
    { modelTier: "balanced" }, policy());
  assert.equal(bounded.allowed, true);
  assert.equal(bounded.fallbackUsed, true); // Only the configured metered fallback, never normal quota.
});

test("newer fresh measured recovery clears exhaustion under the same policy and time", () => {
  const now = Date.now(), configured = { ...policy(), snapshotMaxAgeMs: 1_000 };
  const state = {};
  updateCreditExhaustionState(state, { reached: true, observedAt: new Date(now - 2_000).toISOString() }, { policy: configured });
  const fresh = { status: "recovered", observedAt: new Date(now - 100).toISOString(), remainingPercent: 90 };
  updateCreditExhaustionState(state, fresh, { policy: configured, now: new Date(now).toISOString() });
  assert.equal(state.meta.creditObservedExhaustion.active, false);
  assert.equal(state.meta.creditObservedExhaustion.clearedByFreshSnapshotAt, fresh.observedAt);
  assert.equal(assessCreditAdmission(fresh, { modelTier: "balanced" }, configured,
    { knownExhaustion: state.meta.creditObservedExhaustion, nowMs: now }).allowed, true);
});

test("dry-run neither records nor clears exhaustion in supplied or persisted state", async () => {
  const now = Date.now();
  const exhausted = { status: "available", observedAt: new Date(now - 1_000).toISOString(), remainingPercent: 0, reached: true };
  const fresh = { status: "available", observedAt: new Date(now).toISOString(), remainingPercent: 90 };
  for (const clear of [false, true]) {
    const { state, actions, options } = fixture();
    if (clear) updateCreditExhaustionState(state, exhausted, { policy: options.creditPolicy });
    const before = structuredClone(state);
    await dispatchSupervisorActions(actions, { ...options, dryRun: true, creditSnapshot: clear ? fresh : exhausted });
    assert.deepEqual(state, before);
    await mutateState(stored => {
      if (clear) stored.meta.creditObservedExhaustion = structuredClone(state.meta.creditObservedExhaustion);
      else delete stored.meta.creditObservedExhaustion;
    });
    const storedBefore = await readStateReadOnly();
    await dispatchSupervisorActions([], { dryRun: true, failureIncidents: [], creditPolicy: options.creditPolicy,
      creditSnapshot: clear ? fresh : exhausted });
    assert.deepEqual(await readStateReadOnly(), storedBefore);
  }
});

test("only fresh admissible recovered evidence restores an unchanged credit circuit", async () => {
  const { state, actions, options } = fixture();
  options.creditPolicy = { ...policy({ mode: "fail_closed" }), snapshotMaxAgeMs: 1_000,
    tierBudgets: { balanced: { minRemainingPercent: 20, estimatedCredits: 15 } } };
  options.creditSnapshot = { status: "available", observedAt: new Date().toISOString(), remainingPercent: 10 };
  await dispatchSupervisorActions([actions[0]], options);
  assert.equal(state.tasks[0].automationCircuit.state, "open");
  for (const snapshot of [unknown(), { status: "recovered", observedAt: new Date(Date.now() - 5_000).toISOString(), remainingPercent: 90 },
    { status: "recovered", observedAt: new Date().toISOString(), remainingPercent: null }]) {
    const report = await dispatchSupervisorActions([actions[0]], { ...options, creditSnapshot: snapshot });
    assert.deepEqual(report.recoveredCreditCircuitTaskIds, []);
    assert.equal(state.tasks[0].automationCircuit.state, "open");
  }
  const report = await dispatchSupervisorActions([actions[0]], { ...options,
    creditSnapshot: { status: "recovered", observedAt: new Date().toISOString(), remainingPercent: 90 } });
  assert.deepEqual(report.recoveredCreditCircuitTaskIds, [state.tasks[0].id]);
  assert.equal(report.runs.length, 1);
  assert.equal(state.tasks[0].automationCircuit.recoveryEvidence.snapshotStatus, "recovered");
});

test("a provider/action alias cannot get another fallback claim until verified repair", async () => {
  const { state, options, actions } = fixture();
  const task = state.tasks[0];
  const attemptKey = creditFallbackAttemptKey(task, actions[0]);
  state.runs.push({ id: "old", taskId: task.id, projectId: task.projectId, status: "failed", startedAt: new Date().toISOString(),
    creditAdmission: { fallbackUsed: true, tier: "balanced", estimatedTokensPerRun: 1000, fallbackAttemptKey: attemptKey } });
  const run = queued(state, task, "run_new");
  run.provider = "codex-cli";
  run.actionType = "return_to_builder";
  let calls = 0;
  assert.equal((await claimRuns({ ...options, limit: 10, preflightRun: async () => { calls++; return { ok: true, workflowMode: "local" }; } })).length, 0);
  assert.equal(run.creditClaimBlocker.code, "fallback_attempt_budget_exhausted");
  assert.equal(calls, 0);
});

test("fallback reservations remain live across a renamed rule and do not count cancelled queues", () => {
  const { state, actions, options } = fixture();
  state.runs.push({ id: "owned", taskId: "other", status: "running", creditAdmission: {
    fallbackUsed: true, tier: "balanced", ruleId: "old-rule", policyVersion: 1, estimatedTokensPerRun: 1000 } });
  assert.equal(planDispatches(state, [actions[0]], options).skipped[0].reason, "credit_gate:fallback_concurrency_exhausted");
  state.runs[0].status = "cancelled";
  assert.equal(planDispatches(state, [actions[0]], options).selected.length, 1);
});

test("dry-run performs no probe or pause mutation and frontier/explicit fail-closed remain paused", async () => {
  const { state, actions, options } = fixture();
  options.dryRun = true;
  let calls = 0;
  options.creditSnapshotProbe = async () => { calls++; return unknown(); };
  const before = structuredClone(state);
  await dispatchSupervisorActions(actions, options);
  assert.equal(calls, 0);
  assert.deepEqual(state, before);
  options.dryRun = false;
  state.tasks[0].labels = ["credit-fail-closed"];
  const result = await dispatchSupervisorActions([actions[0]], options);
  assert.equal(result.runs.length, 0);
  assert.equal(state.tasks[0].creditAdmissionPause.active, true);
  assert.equal(state.tasks[0].status, "ready");
  assert.equal(state.tasks[0].automationCircuit, undefined);
});

test("probe backoff survives repeated live sweeps and permits one probe at the refresh boundary", async () => {
  const { state, actions, options } = fixture();
  options.creditPolicy = policy({ mode: "fail_closed" });
  let calls = 0;
  options.creditSnapshotProbe = async () => { calls++; return unknown(); };
  options.nowMs = Date.now();
  await Promise.all([dispatchSupervisorActions([actions[0]], options), dispatchSupervisorActions([actions[1]], options)]);
  await dispatchSupervisorActions([actions[0]], options);
  assert.equal(calls, 1);
  options.nowMs += 300_001;
  await dispatchSupervisorActions([actions[0]], options);
  assert.equal(calls, 2);
  assert.equal(state.events.filter(e => e.type === "credit_admission_paused").length, 2);
});

test("transient pause and recovery survive SQLite reload without changing workflow or leaking unknown fields", async () => {
  const project = await addProject({ key: "credit-reservation-persistence", name: "Credit reservation persistence" });
  const task = await addTask({ project: project.id, title: "Synthetic persistence task", status: "idea" });
  const blocked = assessCreditAdmission(unknown(), { modelTier: "balanced" }, policy({ mode: "fail_closed" }));
  await mutateState(state => {
    const stored = state.tasks.find(t => t.id === task.id);
    persistCreditAdmissionPauseInState(state, stored, { actionType: "start_builder", creditAdmission: { ...blocked, rawProvider: "never-persist" } });
    persistCreditAdmissionPauseInState(state, stored, { actionType: "start_builder", creditAdmission: blocked });
  });
  let loaded = await readStateReadOnly();
  const saved = loaded.tasks.find(t => t.id === task.id);
  assert.equal(saved.status, "idea");
  assert.equal(saved.creditAdmissionPause.active, true);
  assert.equal(loaded.events.filter(e => e.taskId === task.id && e.type === "credit_admission_paused").length, 1);
  assert.doesNotMatch(JSON.stringify(saved.creditAdmissionPause), /never-persist|rawProvider/);
  await mutateState(state => recoverCreditAdmissionPauseInState(state, state.tasks.find(t => t.id === task.id), {
    creditAdmission: assessCreditAdmission({ status: "available", observedAt: new Date().toISOString(), source: "studioops", remainingPercent: 90 }, { modelTier: "balanced" }, policy()),
  }));
  loaded = await readStateReadOnly();
  assert.equal(loaded.tasks.find(t => t.id === task.id).creditAdmissionPause.active, false);
  assert.equal(loaded.events.filter(e => e.taskId === task.id && e.type === "credit_admission_recovered").length, 1);
});

test("50 compatible actions and terminal reservations plan within the bounded local budget", () => {
  const { state, options } = fixture();
  state.tasks = Array.from({ length: 50 }, (_, i) => ({ ...state.tasks[0], id: `task_${i + 1}`, workAreas: [`src/${i}.js`] }));
  state.runs = state.tasks.map((task, i) => ({ id: `old_${i}`, taskId: task.id, status: "cancelled",
    creditAdmission: { fallbackUsed: true, tier: "balanced", estimatedTokensPerRun: 1000 } }));
  const actions = state.tasks.map(task => ({ id: task.id, type: "start_builder", role: "builder", taskId: task.id, projectId: task.projectId, taskStatus: "ready" }));
  options.creditPolicy = policy({ maxConcurrentRuns: 60, maxInFlightEstimatedTokens: 60_000 });
  const started = performance.now();
  const result = planDispatches(state, actions, { ...options, builderConcurrency: 60, maxDispatchesPerSweep: 60 });
  assert.equal(result.selected.length, 50);
  assert.ok(performance.now() - started < 200, "bounded planning should not rescan historical state per action");
});
