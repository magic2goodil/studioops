import assert from "node:assert/strict";
import test from "node:test";
import { assessCreditAdmission, freshHealthyCreditEvidence, normalizeCreditSnapshot } from "../src/credit-policy.js";
import { createCreditReservationPlan, assessCreditReservation, reserveCreditSelection, sanitizedCreditAdmission,
  commitPrepaidCreditClaimInState, updateCreditExhaustionState } from "../src/credit-reservations.js";
import { dispatchSupervisorActions, planDispatches, recoverAffordableCreditCircuitsInState } from "../src/dispatcher.js";
import { claimRuns, planRunnableRuns } from "../src/runner.js";
import { addProject, addTask, mutateState, mutateScopeDispatchState, readStateReadOnly, workflowSnapshotForTask } from "../src/store.js";
import { mutateRunClaimState, claimFailureContainmentPaidAttempt, readFailureIncidents, writeDatabaseState } from "../src/state-database.js";
import { createFailureIncident, failureFingerprint } from "../src/failure-containment.js";
import { canonicalCreditPolicyConfig, renderConfigMarkdown } from "../src/config.js";

const AT = "2026-08-01T12:00:00.000Z";
const NOW = "2026-08-01T12:01:00.000Z";
const POLICY = { enabled: true, prepaid: { enabled: true, maxEstimatedCredits: 100, maxConcurrentRuns: 1 } };
function snapshot(input = {}) {
  const { permission, spend, balance, unlimited, type, bucket } = { permission: false, spend: false,
    balance: "200", unlimited: false, type: "rate_limit_reached", bucket: "codex", ...input };
  return normalizeCreditSnapshot({ ordinaryUsageAllowed: permission, rateLimits: {
    limitId: bucket, primary: { usedPercent: 100 }, spendControlReached: spend,
    rateLimitReachedType: type, credits: { hasCredits: true, balance, unlimited },
  } }, { observedAt: AT });
}
const assess = (value, policy = POLICY, evaluation = {}) => assessCreditAdmission(value,
  { modelTier: "balanced" }, policy, { evaluatedAt: NOW, ...evaluation });

test("explicit bounded prepaid opt-in can fund exhausted included usage without inventing included permission", () => {
  for (const permission of [true, false, null, undefined]) {
    const value = snapshot({ permission });
    const admission = assess(value);
    assert.equal(admission.allowed, true);
    assert.equal(admission.fundingMode, "prepaid");
    assert.equal(admission.fallbackUsed, false);
    assert.equal(admission.estimatedCredits, 15);
    assert.equal(admission.prepaidCreditLimit, 100);
    assert.equal(assess(value, { enabled: true }).allowed, false);
    assert.equal(value.overageEligibility, "unverified");
  }
});

test("prepaid opt-in and both finite shared bounds reject missing or malformed authorization", () => {
  for (const enabled of [undefined, null, false, "true", 1]) {
    assert.equal(assess(snapshot(), { ...POLICY, prepaid: { ...POLICY.prepaid, enabled } }).allowed, false);
  }
  for (const key of ["maxEstimatedCredits", "maxConcurrentRuns"]) {
    for (const bad of [undefined, null, true, false, "", "invalid", "100", 0, -1, Infinity, NaN]) {
      assert.equal(assess(snapshot(), { ...POLICY, prepaid: { ...POLICY.prepaid, [key]: bad } }).allowed, false, `${key}:${String(bad)}`);
    }
  }
  assert.equal(assess(snapshot(), { ...POLICY, prepaid: { ...POLICY.prepaid, maxConcurrentRuns: 0.5 } }).allowed, false);
});

test("canonical generated configuration preserves explicit prepaid bounds and defaults off", () => {
  assert.deepEqual(canonicalCreditPolicyConfig().prepaid, { enabled: false });
  assert.deepEqual(canonicalCreditPolicyConfig(POLICY).prepaid, POLICY.prepaid);
  assert.match(renderConfigMarkdown({ defaults: { creditPolicy: POLICY } }), /"prepaid": \{\n\s+"enabled": true/);
  assert.equal(canonicalCreditPolicyConfig({ prepaid: { enabled: "true" } }).prepaid.enabled, false);
});

test("low but positive included capacity preserves the tier headroom denial instead of selecting prepaid", () => {
  const state = {};
  const included = normalizeCreditSnapshot({ ordinaryUsageAllowed: true, rateLimits: { limitId: "codex",
    primary: { usedPercent: 97 }, spendControlReached: false,
    credits: { hasCredits: true, balance: "200", unlimited: false } } }, { observedAt: AT });
  const result = assess(included);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "insufficient_quota_headroom");
  assert.equal(result.fundingMode, undefined);
  assert.equal(result.fallbackUsed, false);
  updateCreditExhaustionState(state, included, { policy: POLICY, now: NOW });
  assert.equal(state.meta?.creditObservedExhaustion?.clearanceFundingMode, undefined);
  for (const ordinaryUsageAllowed of [false, null]) {
    assert.equal(assess({ ...included, ordinaryUsageAllowed }).fundingMode, "prepaid");
  }
  assert.equal(assess({ ...included, remainingPercent: 0 }).fundingMode, "prepaid");
});

test("prepaid evidence fails closed on unknown spend status, hard refusal, unknown bucket/type and unavailable balance", () => {
  for (const spend of [null, undefined, true, "false", 0]) assert.equal(assess(snapshot({ spend })).allowed, false);
  const absent = normalizeCreditSnapshot({ ordinaryUsageAllowed: false, rateLimits: { limitId: "codex",
    primary: { usedPercent: 100 }, credits: { hasCredits: true, balance: "200", unlimited: false } } }, { observedAt: AT });
  assert.equal(absent.spendControlReached, null);
  assert.equal(assess(absent).allowed, false);
  for (const balance of [null, undefined, true, false, "", "invalid", 0, -1, Infinity, NaN]) {
    assert.equal(assess(snapshot({ balance })).allowed, false, String(balance));
  }
  for (const unlimited of [true, null, undefined, "false"]) assert.equal(assess(snapshot({ unlimited })).allowed, false);
  for (const type of ["workspace_owner_credits_depleted", "workspace_member_usage_limit_reached", "unknown", false, 0]) {
    assert.equal(assess(snapshot({ type })).allowed, false, String(type));
  }
  assert.equal(assess(snapshot({ bucket: "other" })).allowed, false);
  assert.equal(assess({ ...snapshot(), reached: true }).allowed, false);
  assert.equal(assess({ ...snapshot(), classificationVersion: 1 }).allowed, false);
  const unknownBucket = normalizeCreditSnapshot({ ordinaryUsageAllowed: false, rateLimitsByLimitId: { other: {
    primary: { usedPercent: 100 }, spendControlReached: false,
    credits: { hasCredits: true, balance: "200", unlimited: false },
  } } }, { observedAt: AT });
  assert.equal(unknownBucket.bucketId, "unclassified");
  assert.equal(assess(unknownBucket).allowed, false);
  for (const bucket of [["codex"], false, 0, null, undefined, "", "other"]) {
    assert.equal(assess(snapshot({ bucket })).allowed, false, `bucket ${String(bucket)}`);
    const mapped = normalizeCreditSnapshot({ ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: {
      limitId: bucket, spendControlReached: false, primary: { usedPercent: 100 },
      credits: { hasCredits: true, balance: "200", unlimited: false },
    } } }, { observedAt: AT });
    assert.equal(assess(mapped).allowed, false, `mapped bucket ${String(bucket)}`);
  }
  const implicitCodex = normalizeCreditSnapshot({ ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: {
    spendControlReached: false, primary: { usedPercent: 100 }, credits: { hasCredits: true, balance: "200", unlimited: false },
  } } }, { observedAt: AT });
  assert.equal(assess(implicitCodex).allowed, true);
});

function fixture() {
  const state = { projects: [{ id: "project_1", key: "synthetic", repoPath: "/synthetic", workflowMode: "local" }],
    tasks: [1, 2, 3].map(i => ({ id: `task_${i}`, projectId: "project_1", title: "Independent synthetic change", status: "ready",
      assignedAgentRole: "builder", lane: "backend", workAreas: [`src/${i}.js`] })), runs: [], comments: [], events: [] };
  const actions = state.tasks.map(t => ({ id: `${t.id}:start_builder`, type: "start_builder", role: "builder", taskId: t.id,
    projectId: t.projectId, taskStatus: "ready" }));
  const options = { state, creditPolicy: structuredClone(POLICY), creditSnapshot: { ...snapshot(), observedAt: new Date().toISOString() },
    failureIncidents: [], executionPolicy: { modelTiers: { balanced: { model: "synthetic-model" } }, tierRouting: { defaultTier: "balanced" } },
    builderConcurrency: 10, preflightRun: async () => ({ ok: true, workflowMode: "local" }) };
  return { state, actions, options };
}

function queued(state, task, id, tier = "balanced") {
  task.status = "queued";
  const run = { id, taskId: task.id, projectId: task.projectId, status: "queued", group: "builder", role: "builder",
    modelTier: tier, actionType: "start_builder", provider: "codex-sdk", attempt: 1, maxAttempts: 2,
    lane: "backend", fileScope: task.workAreas, fileScopeExplicit: true };
  state.runs.push(run);
  return run;
}

test("prepaid dispatch reserves the shared allowance without a durable charge or repeated pause", async () => {
  const { state, actions, options } = fixture();
  const result = await dispatchSupervisorActions(actions, options);
  assert.equal(result.runs.length, 1);
  const run = result.runs[0];
  assert.equal(run.creditAdmission.fundingMode, "prepaid");
  assert.equal(run.creditAdmission.fallbackUsed, false);
  assert.equal(run.creditAdmission.reservationBinding.runId, run.id);
  assert.equal(state.meta?.prepaidCreditLedger, undefined);
  assert.equal(state.tasks[1].status, "ready");
  assert.equal(state.tasks[1].automationCircuit, undefined);
  assert.equal(state.tasks[1].creditAdmissionPause.reasonCode, "prepaid_concurrency_exhausted");
  const audit = state.comments.find(c => c.taskId === state.tasks[1].id).body;
  assert.match(audit, /Prepaid reservations/);
  assert.doesNotMatch(audit, /Fallback reservations/);
  assert.deepEqual(state.events.find(e => e.type === "credit_prepaid_dispatched").creditAdmission, run.creditAdmission);
  await dispatchSupervisorActions(actions, options);
  assert.equal(state.events.filter(e => e.type === "credit_admission_paused").length, 2);
});

test("mixed tiers use one finite allowance and one concurrency pool", () => {
  const plan = createCreditReservationPlan({ runs: [] });
  const configured = { ...POLICY, prepaid: { enabled: true, maxEstimatedCredits: 50, maxConcurrentRuns: 2 } };
  const admission = tier => assessCreditAdmission(snapshot(), { modelTier: tier }, configured, { evaluatedAt: NOW });
  const first = assessCreditReservation(admission("frontier"), plan, { taskId: "first" });
  assert.equal(first.allowed, true);
  reserveCreditSelection(plan, first);
  assert.equal(assessCreditReservation(admission("balanced"), plan, { taskId: "second" }).code, "prepaid_allowance_exhausted");
  const smaller = assessCreditReservation(admission("economy"), plan, { taskId: "second" });
  assert.equal(smaller.allowed, true);
  reserveCreditSelection(plan, smaller);
  assert.equal(assessCreditReservation(admission("mechanical"), plan, { taskId: "third" }).code, "prepaid_concurrency_exhausted");
});

test("project-scoped sweeps cannot hide another project's outstanding prepaid reservation", async () => {
  const { state, actions, options } = fixture();
  await dispatchSupervisorActions([actions[0]], options);
  state.projects.push({ ...state.projects[0], id: "project_2", key: "another", repoPath: "/another" });
  state.tasks[1].projectId = "project_2";
  actions[1].projectId = "project_2";
  options.project = "project_2";
  assert.equal(planDispatches(state, [actions[1]], options).skipped[0].reason, "credit_gate:prepaid_concurrency_exhausted");
  const other = queued(state, state.tasks[1], "run_other_project");
  assert.equal((await claimRuns(options)).length, 0);
  assert.equal(other.creditClaimBlocker.code, "prepaid_concurrency_exhausted");
  assert.equal(state.meta?.prepaidCreditLedger, undefined);
});

test("planning never charges; own queued reservation is excluded and duplicate claims never recharge", async () => {
  const { state, actions, options } = fixture();
  await dispatchSupervisorActions([actions[0]], options);
  const before = structuredClone(state);
  assert.equal(planRunnableRuns(state, { ...options, limit: 10 }).runnable.length, 1);
  assert.deepEqual(state, before);
  const claimed = await claimRuns({ ...options, limit: 10 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].creditClaimAdmission.prepaidClaimSequence, 1);
  assert.deepEqual(state.meta.prepaidCreditLedger, { schemaVersion: 1, committedEstimatedCredits: 15,
    claimCount: 1, lastClaimedAt: claimed[0].startedAt });
  const ledger = structuredClone(state.meta.prepaidCreditLedger);
  assert.equal((await claimRuns({ ...options, limit: 10 })).length, 0);
  assert.deepEqual(state.meta.prepaidCreditLedger, ledger);
});

test("completed and archived work cannot replenish allowance or recycle a fresh provider balance", async () => {
  const { state, options } = fixture();
  options.creditPolicy.prepaid.maxEstimatedCredits = 25;
  queued(state, state.tasks[0], "run_first");
  assert.equal((await claimRuns(options)).length, 1);
  state.runs[0].status = "completed";
  queued(state, state.tasks[1], "run_second");
  options.creditSnapshot = { ...snapshot({ balance: "1000" }), observedAt: new Date().toISOString() };
  assert.equal((await claimRuns(options)).length, 0);
  assert.equal(state.runs[1].creditClaimBlocker.code, "prepaid_allowance_exhausted");
  state.runs.shift(); // Archive compaction may discard historical run rows, never the cumulative meta ledger.
  assert.equal((await claimRuns(options)).length, 0);
  assert.equal(state.meta.prepaidCreditLedger.committedEstimatedCredits, 15);
  assert.equal(state.meta.prepaidCreditLedger.claimCount, 1);
  // A lower observed balance is conjunctive with the allowance, even after increasing the configured bound.
  options.creditPolicy.prepaid.maxEstimatedCredits = 100;
  options.creditSnapshot = { ...snapshot({ balance: "30" }), observedAt: new Date().toISOString() };
  assert.equal((await claimRuns(options)).length, 0);
  assert.equal(state.runs[0].creditClaimBlocker.code, "prepaid_allowance_exhausted");
});

test("outstanding queue keeps order, paused queue releases reservation, running prepaid never releases capacity", async () => {
  const { state, options } = fixture();
  const first = queued(state, state.tasks[0], "run_first"), second = queued(state, state.tasks[1], "run_second");
  for (const run of [first, second]) run.creditAdmission = assessCreditReservation(
    assessCreditAdmission(options.creditSnapshot, { modelTier: "balanced" }, options.creditPolicy), createCreditReservationPlan({ runs: [] }),
    { taskId: run.taskId, claimRunId: run.id });
  assert.deepEqual(planRunnableRuns(state, options).runnable.map(r => r.id), [first.id]);
  state.tasks[0].budgetPause = { runId: first.id };
  assert.deepEqual((await claimRuns({ ...options, limit: 10 })).map(r => r.id), [second.id]);
  delete state.tasks[0].budgetPause;
  state.tasks[1].budgetPause = { runId: second.id };
  assert.equal((await claimRuns({ ...options, limit: 10 })).length, 0);
  assert.equal(first.creditClaimBlocker.code, "prepaid_concurrency_exhausted");
});

test("revoked or stale prepaid evidence never starts a previously queued prepaid run", async () => {
  for (const change of [o => { o.creditPolicy.enabled = false; }, o => { o.creditPolicy.prepaid.enabled = false; },
    o => { o.creditSnapshot.observedAt = AT; }, o => { o.creditSnapshot.spendControlReached = true; },
    o => { o.creditSnapshot = { status: "unknown", observedAt: new Date().toISOString() }; }]) {
    const { state, actions, options } = fixture();
    await dispatchSupervisorActions([actions[0]], options);
    change(options);
    let preflights = 0;
    options.preflightRun = async () => { preflights++; return { ok: true, workflowMode: "local" }; };
    assert.equal((await claimRuns(options)).length, 0);
    assert.equal(preflights, 0);
    assert.equal(state.meta?.prepaidCreditLedger, undefined);
    assert.equal(state.runs[0].status, "queued");
  }
});

test("malformed or missing-version ledger and duplicate retained claim sequences fail closed", () => {
  for (const ledger of [null, {}, { claimCount: 0, committedEstimatedCredits: 0, lastClaimedAt: "" },
    { schemaVersion: 2, claimCount: 1, committedEstimatedCredits: 15, lastClaimedAt: AT },
    { schemaVersion: 1, claimCount: -1, committedEstimatedCredits: 15, lastClaimedAt: AT }]) {
    const plan = createCreditReservationPlan({ meta: { prepaidCreditLedger: ledger }, runs: [] });
    assert.equal(assessCreditReservation(assess(snapshot()), plan).code, "prepaid_ledger_invalid");
  }
  const claim = { fundingMode: "prepaid", allowed: true, prepaidClaimSequence: 1, estimatedCredits: 15 };
  const runs = [1, 2].map(i => ({ id: `run_${i}`, status: "completed", startedAt: AT, creditClaimAdmission: claim }));
  const state = { meta: { prepaidCreditLedger: { schemaVersion: 1, claimCount: 2, committedEstimatedCredits: 30, lastClaimedAt: AT } }, runs };
  assert.equal(assessCreditReservation(assess(snapshot()), createCreditReservationPlan(state)).code, "prepaid_ledger_invalid");
  delete state.meta.prepaidCreditLedger;
  assert.equal(assessCreditReservation(assess(snapshot()), createCreditReservationPlan(state)).code, "prepaid_ledger_invalid");
});

function hold(task, reason = "prior_exhaustion_unverified") {
  const openedAt = new Date(Date.now() - 3000).toISOString();
  task.automationAttemptEpoch = 7;
  task.automationCircuit = { state: "open", reasonCode: "credit_budget_insufficient", attemptsConsumed: 0,
    maxAttempts: 0, openedAt, snapshot: workflowSnapshotForTask(task) };
  task.automationBlocker = { type: "circuit", reason, blockedAt: openedAt, actionType: "start_builder", modelTier: "balanced", resumeStatus: task.status };
  task.status = "blocked";
  task.assignedAgentRole = "owner";
}

test("serialized prepaid evidence cannot manufacture native incident-absence admission", async () => {
  for (const reason of ["prior_exhaustion_unverified", "overage_eligibility_unverified"]) {
    const { state, actions, options } = fixture();
    hold(state.tasks[0], reason);
    state.meta = { creditObservedExhaustion: { active: true, reasonCode: "rate_limit_reached", observedAt: state.tasks[0].automationCircuit.openedAt } };
    const report = await dispatchSupervisorActions([actions[0]], options);
    assert.deepEqual(report.recoveredCreditCircuitTaskIds, []);
    assert.equal(report.runs.length, 0);
    assert.equal(state.tasks[0].automationAttemptEpoch, 7);
    assert.equal(state.tasks[0].automationCircuit.state, "open");
    assert.equal(state.events.some(e => e.type === "automation_circuit_reset"), false);
    assert.equal(state.meta.prepaidCreditLedger, undefined);
  }
});

test("prepaid recovery rejects ambiguous, attempted, changed, racing and durable provider holds", () => {
  const cases = [f => { f.state.tasks[0].automationCircuit.attemptsConsumed = 1; },
    f => { delete f.state.tasks[0].automationCircuit.snapshot; },
    f => { f.state.tasks[0].reviewSubjectSha = "b".repeat(40); },
    f => { f.state.tasks[0].automationBlocker.blockedAt = AT; },
    f => { f.state.tasks[0].automationBlocker.reason = "rate_limit_reached"; },
    f => { f.state.tasks[0].automationCircuit.reasonCode = "provider_rate_limited"; },
    f => { f.options.creditSnapshot.observedAt = f.state.tasks[0].automationCircuit.openedAt; },
    f => { f.options.failureIncidentTaskIds = []; },
    f => { const incident = createFailureIncident({ fingerprint: failureFingerprint({ taskId: f.state.tasks[0].id,
      action: "start_builder", provider: "codex-sdk", reasonCode: "provider_rate_limited" }) });
      incident.state = "open"; f.options.failureIncidents = [incident]; }];
  for (const change of cases) {
    const f = fixture(); hold(f.state.tasks[0]); f.options.failureIncidentTaskIds = [f.state.tasks[0].id];
    change(f);
    const before = structuredClone(f.state);
    assert.deepEqual(recoverAffordableCreditCircuitsInState(f.state, f.options), []);
    assert.deepEqual(f.state, before);
  }
});

test("prepaid evidence retains bounded accounting facts without raw account payloads", () => {
  const clean = sanitizedCreditAdmission({ ...assess(snapshot()), rawProvider: { accountId: "private-account" }, balance: 987654,
    accountId: "private-account" });
  assert.equal(clean.fundingMode, "prepaid");
  assert.equal(clean.prepaidCreditLimit, 100);
  assert.doesNotMatch(JSON.stringify(clean), /private-account|rawProvider|"balance"|987654/);
});

test("verified prepaid balance never bypasses a durable provider denial or consumed paid-attempt budget", async () => {
  for (const exhausted of [false, true]) {
    const { state, actions, options } = fixture();
    const incident = createFailureIncident({ fingerprint: failureFingerprint({ taskId: state.tasks[0].id,
      action: "start_builder", provider: "codex-cli", reasonCode: "provider_rate_limited" }) });
    if (exhausted) incident.paidAttempts = 2;
    else incident.state = "open";
    options.failureIncidents = [incident];
    const prior = structuredClone(incident);
    const report = await dispatchSupervisorActions([actions[0]], options);
    assert.equal(report.runs.length, 0);
    assert.ok(["failure_circuit_open", "attempt_budget_exhausted"].includes(report.skipped[0].reason));
    assert.deepEqual(incident, prior);
    assert.equal(state.meta?.prepaidCreditLedger, undefined);
  }
});

test("native SQLite claims are cumulative, atomic, reload-safe, and cannot be reset through generic writes", async () => {
  const project = await addProject({ key: "prepaid-native-claims", name: "Prepaid native claims" });
  const tasks = await Promise.all([1, 2].map(i => addTask({ project: project.id, title: `Synthetic native claim ${i}`,
    status: "idea", type: "bug", architectureRequired: false })));
  await mutateState(state => tasks.forEach((task, i) => {
    const stored = state.tasks.find(t => t.id === task.id); stored.workAreas = [`src/native-${i}.js`];
    queued(state, stored, `run_prepaid_native_${i}`);
  }));
  const options = { ...fixture().options, project: project.id, limit: 10 };
  delete options.state;
  options.creditPolicy.prepaid.maxEstimatedCredits = 25;
  const beforeClaim = await readStateReadOnly();
  assert.equal(beforeClaim.meta.prepaidCreditLedger, undefined);
  await assert.rejects(mutateState(s => { s.meta.prepaidCreditLedger = { schemaVersion: 1, claimCount: 0,
    committedEstimatedCredits: 0, lastClaimedAt: "" }; }), /native bounded run claim/);
  assert.equal(planRunnableRuns(beforeClaim, options).runnable.length, 1, JSON.stringify(planRunnableRuns(beforeClaim, options).skipped));
  const results = await Promise.all([claimRuns(options), claimRuns(options)]);
  assert.equal(results.flat().length, 1, JSON.stringify(planRunnableRuns(await readStateReadOnly(), options)));
  let state = await readStateReadOnly();
  const ledger = structuredClone(state.meta.prepaidCreditLedger);
  assert.equal(ledger.claimCount, 1);
  assert.equal(ledger.committedEstimatedCredits, 15);
  const winner = results.flat()[0].id;
  for (const mutate of [s => { delete s.runs.find(r => r.id === winner).creditClaimAdmission; },
    s => { s.runs.find(r => r.id === winner).creditClaimAdmission = { allowed: true, fundingMode: "included" }; },
    s => { s.runs.find(r => r.id === winner).startedAt = AT; },
    s => { s.runs = s.runs.filter(r => r.id !== winner); }]) {
    await assert.rejects(mutateState(mutate), /native bounded run claim/);
    const replacement = await readStateReadOnly(); mutate(replacement);
    await assert.rejects(writeDatabaseState(replacement), /native bounded run claim/);
    assert.deepEqual((await readStateReadOnly()).meta.prepaidCreditLedger, ledger);
  }
  await mutateState(s => { s.runs.find(r => r.id === winner).status = "completed"; });
  assert.equal((await claimRuns(options)).length, 0);
  assert.deepEqual((await readStateReadOnly()).meta.prepaidCreditLedger, ledger);
  for (const mutate of [s => { delete s.meta.prepaidCreditLedger; },
    s => { s.meta.prepaidCreditLedger.committedEstimatedCredits = 0; },
    s => { s.meta.prepaidCreditLedger = { schemaVersion: 1, claimCount: 0, committedEstimatedCredits: 0, lastClaimedAt: "" }; },
    s => { s.runs.find(r => r.id === winner).status = "running"; }]) {
    await assert.rejects(mutateState(mutate), /native bounded run claim/);
    assert.deepEqual((await readStateReadOnly()).meta.prepaidCreditLedger, ledger);
  }
  options.creditPolicy.prepaid.maxEstimatedCredits = 100;
  await assert.rejects(mutateRunClaimState(s => {
    const run = s.runs.find(r => r.projectId === project.id && r.status === "queued");
    const admission = assessCreditReservation(assessCreditAdmission(options.creditSnapshot, { modelTier: "balanced" }, options.creditPolicy),
      createCreditReservationPlan(s), { taskId: run.taskId, claimRunId: run.id });
    const now = new Date().toISOString();
    run.creditClaimAdmission = commitPrepaidCreditClaimInState(s, run, admission, now);
    run.startedAt = now; run.status = "running";
    throw new Error("synthetic abort before commit");
  }), /synthetic abort/);
  assert.deepEqual((await readStateReadOnly()).meta.prepaidCreditLedger, ledger);
  assert.equal((await claimRuns(options)).length, 1);
  state = await readStateReadOnly();
  assert.equal(state.meta.prepaidCreditLedger.claimCount, 2);
  assert.equal(state.meta.prepaidCreditLedger.committedEstimatedCredits, 30);
  await mutateState(s => { for (const run of s.runs.filter(r => r.projectId === project.id)) run.status = "completed"; });
  await mutateState(s => { s.runs = s.runs.filter(r => r.projectId !== project.id); });
  assert.equal((await readStateReadOnly()).meta.prepaidCreditLedger.committedEstimatedCredits, 30);
});

async function nativeHeldFixture(key) {
  const project = await addProject({ key: `prepaid-hold-${key}`, name: "Synthetic prepaid hold", workflowMode: "local", repoPath: "/synthetic" });
  const task = await addTask({ project: project.id, title: "Synthetic held admission", status: "idea", type: "bug", architectureRequired: false });
  await mutateState(state => { const saved = state.tasks.find(t => t.id === task.id);
    saved.status = "ready"; saved.assignedAgentRole = "builder"; saved.workAreas = ["src/synthetic.js"]; hold(saved); });
  const action = { id: `${task.id}:start_builder`, taskId: task.id, projectId: project.id, type: "start_builder", role: "builder", taskStatus: "ready" };
  const options = { ...fixture().options, project: project.id };
  delete options.state;
  return { project, task, action, options };
}

const nativeIncident = f => ({ taskId: f.task.id, action: "start_builder", provider: "codex", reasonCode: "provider_rate_limited",
  evidence: { provider: "codex", reasonCode: "provider_rate_limited" } });

test("native prepaid hold retirement preserves epoch and resumes ordinary dispatch", async () => {
  const f = await nativeHeldFixture("healthy");
  const result = await dispatchSupervisorActions([f.action], f.options);
  assert.deepEqual(result.recoveredCreditCircuitTaskIds, [f.task.id]);
  assert.equal(result.runs.length, 1);
  const state = await readStateReadOnly(), task = state.tasks.find(t => t.id === f.task.id);
  assert.equal(task.automationAttemptEpoch, 7);
  assert.equal(task.automationCircuit.state, "closed");
  assert.equal(state.events.some(e => e.taskId === f.task.id && e.type === "automation_circuit_reset"), false);
  await mutateState(s => { s.runs.find(r => r.id === result.runs[0].id).status = "cancelled"; });
});

test("native incident absence is authoritative even when serialized incident options claim none", async () => {
  const f = await nativeHeldFixture("existing-incident");
  await claimFailureContainmentPaidAttempt(nativeIncident(f));
  const before = (await readStateReadOnly()).tasks.find(t => t.id === f.task.id);
  const incidents = await readFailureIncidents({ taskId: f.task.id });
  const result = await dispatchSupervisorActions([f.action], f.options);
  assert.equal(result.runs.length, 0);
  assert.deepEqual((await readStateReadOnly()).tasks.find(t => t.id === f.task.id), before);
  assert.deepEqual(await readFailureIncidents({ taskId: f.task.id }), incidents);
});

test("a provider incident inserted between prepaid retirement preparation and commit forces replay and retains the hold", async () => {
  const f = await nativeHeldFixture("racing-incident");
  const before = (await readStateReadOnly()).tasks.find(t => t.id === f.task.id);
  let attempts = 0;
  await mutateScopeDispatchState(async state => {
    const result = await dispatchSupervisorActions([f.action], { ...f.options, state });
    if (++attempts === 1) {
      assert.equal(result.runs.length, 1);
      assert.equal(state.tasks.find(t => t.id === f.task.id).automationCircuit.state, "closed");
      await claimFailureContainmentPaidAttempt(nativeIncident(f));
    }
  }, { operationName: "test.prepaid_credit_incident_race" });
  const state = await readStateReadOnly();
  assert.equal(attempts, 2);
  assert.deepEqual(state.tasks.find(t => t.id === f.task.id), before);
  assert.equal(state.runs.some(r => r.taskId === f.task.id), false);
  assert.equal(state.events.some(e => e.taskId === f.task.id && e.type === "credit_admission_recovered"), false);
  assert.equal((await readFailureIncidents({ taskId: f.task.id })).length, 1);
});

test("prepaid admission uses tier estimate plus reserve and does not accept stale or future capacity", () => {
  assert.equal(assess(snapshot({ balance: "19" })).allowed, false);
  assert.equal(assess(snapshot({ balance: "20" })).allowed, true);
  for (const observedAt of ["", "2026-07-01T12:00:00.000Z", "2026-08-01T12:02:00.000Z"]) {
    assert.equal(assess({ ...snapshot(), observedAt }).allowed, false);
    assert.equal(freshHealthyCreditEvidence({ ...snapshot(), observedAt }, POLICY, { evaluatedAt: NOW }).healthyCapacity, false);
  }
});

test("qualified newer prepaid funding clears only the dated global marker and preserves legacy cause", () => {
  const prior = { active: true, reasonCode: "rate_limit_reached", observedAt: "2026-08-01T11:00:00.000Z",
    latestBlockingObservedAt: "2026-08-01T11:30:00.000Z" };
  const state = { meta: { creditObservedExhaustion: structuredClone(prior) }, tasks: [{ id: "task_1",
    automationCircuit: { state: "open", reasonCode: "provider_rate_limited" }, automationAttemptEpoch: 5 }] };
  for (const observedAt of [prior.observedAt, prior.latestBlockingObservedAt]) {
    const value = { ...snapshot(), observedAt };
    assert.equal(assess(value, POLICY, { knownExhaustion: prior }).allowed, false);
    updateCreditExhaustionState(state, value, { policy: POLICY, now: NOW });
    assert.equal(state.meta.creditObservedExhaustion.active, true);
  }
  const tasks = structuredClone(state.tasks);
  updateCreditExhaustionState(state, snapshot(), { policy: POLICY, now: NOW });
  assert.deepEqual(state.meta.creditObservedExhaustion, { ...prior, active: false, clearanceFundingMode: "prepaid", clearedByFreshSnapshotAt: AT });
  assert.deepEqual(state.tasks, tasks);
  assert.equal(assess(snapshot(), POLICY, { knownExhaustion: prior }).allowed, true);
  const denied = snapshot({ spend: true });
  updateCreditExhaustionState(state, denied, { policy: POLICY, now: NOW });
  assert.equal(state.meta.creditObservedExhaustion.active, true);
  assert.equal(assess(denied, POLICY, { knownExhaustion: state.meta.creditObservedExhaustion }).allowed, false);
});

test("prepaid recovery provenance prevents new work from falling back on missing, stale or revoked funding", async () => {
  for (const withPrior of [false, true]) {
    const { state, actions, options } = fixture();
    if (withPrior) state.meta = { creditObservedExhaustion: { active: true, reasonCode: "rate_limit_reached",
      observedAt: new Date(Date.now() - 1000).toISOString() } };
    updateCreditExhaustionState(state, options.creditSnapshot, { policy: options.creditPolicy });
    assert.equal(state.meta.creditObservedExhaustion.clearanceFundingMode, "prepaid");
    for (const change of [o => { o.creditSnapshot = { status: "unknown" }; },
      o => { o.creditSnapshot.observedAt = AT; }, o => { o.creditPolicy.prepaid.enabled = false; },
      o => { o.creditPolicy.enabled = false; }]) {
      const cloned = structuredClone(state), current = { ...options, state: cloned,
        creditSnapshot: structuredClone(options.creditSnapshot), creditPolicy: structuredClone(options.creditPolicy) };
      change(current);
      const result = await dispatchSupervisorActions([actions[0]], current);
      assert.equal(result.runs.length, 0);
      assert.equal(result.skipped[0].creditAdmission?.fallbackUsed, false);
      const run = queued(cloned, cloned.tasks[1], "run_new_after_prepaid");
      let calls = 0;
      assert.equal((await claimRuns({ ...current, preflightRun: async () => { calls++; return { ok: true }; } })).length, 0);
      assert.equal(calls, 0);
      assert.equal(run.status, "queued");
      assert.equal(cloned.meta.prepaidCreditLedger, undefined);
    }
  }
});

test("only strictly newer verified included recovery retires prepaid provenance; ties remain metered", () => {
  const state = {};
  updateCreditExhaustionState(state, snapshot(), { policy: POLICY, now: NOW });
  const marker = structuredClone(state.meta.creditObservedExhaustion);
  const included = normalizeCreditSnapshot({ ordinaryUsageAllowed: true, rateLimits: { limitId: "codex",
    primary: { usedPercent: 20 }, spendControlReached: false, credits: { hasCredits: true, balance: "200", unlimited: false } } }, { observedAt: AT });
  assert.equal(assess(included, POLICY, { knownExhaustion: marker }).fundingMode, "prepaid");
  updateCreditExhaustionState(state, included, { policy: POLICY, now: NOW });
  assert.deepEqual(state.meta.creditObservedExhaustion, marker);
  for (const bad of [{ status: "available", observedAt: "2026-08-01T12:00:01.000Z", remainingPercent: 90 },
    { ...included, observedAt: "2026-08-01T12:00:01.000Z", bucketId: "unclassified" }]) {
    assert.equal(assess(bad, POLICY, { knownExhaustion: marker }).allowed, false);
    updateCreditExhaustionState(state, bad, { policy: POLICY, now: NOW });
    assert.deepEqual(state.meta.creditObservedExhaustion, marker);
  }
  included.observedAt = "2026-08-01T12:00:02.000Z";
  assert.equal(assess(included, POLICY, { knownExhaustion: marker }).code, "credit_headroom_available");
  updateCreditExhaustionState(state, included, { policy: POLICY, now: NOW });
  assert.equal(state.meta.creditObservedExhaustion.clearanceFundingMode, undefined);
  assert.equal(assess({ status: "unknown" }, POLICY, { knownExhaustion: state.meta.creditObservedExhaustion }).fallbackUsed, true);
});
