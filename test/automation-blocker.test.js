import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createSupervisorReport } from "../src/supervisor.js";
import { planDispatches, recoverAffordableCreditCircuitsInState } from "../src/dispatcher.js";
import { claimRuns, completeRun, completeRunAfterExecution, denyPaidFailureAttemptInState, observedDeniedFailureRun, pauseTaskForAutomationConfig,
  queuedRunExecutionBlocker, stopHeldRunBeforeProviderStart } from "../src/runner.js";
import { readFailureIncidents } from "../src/state-database.js";
import {
  addProject,
  addTask,
  automationTick,
  mutateState,
  readState,
  recoverCreditAdmissionPauseInState,
  recoverPrepaidCreditCircuitInState,
  resetAutomationCircuitInState,
  resolveWorkerHandoff,
  supersedeStaleTaskCircuitInState,
  transitionTask,
  updateTask,
} from "../src/store.js";

// Test-only pseudoterminal exercises the actual local confirmation path. No
// production identity or user approval is asserted by this fixture.
async function confirmFixtureHandoff(taskId, version, reason) {
  const command = [process.execPath, path.resolve("src/mission-control-cli.js"), "resolve-worker-handoff",
    taskId, "--expected-state-version", String(version), "--reason", reason];
  const driver = `import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
output = b''
sent = False
deadline = time.monotonic() + 9
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], .25)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    if not sent and b'Confirm by typing' in output:
        os.write(fd, ('RESOLVE ' + sys.argv[4] + ' ' + sys.argv[6] + '\\n').encode())
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))`;
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", driver, ...command], { env: process.env });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Fixture terminal timed out: ${output}`)); }, 10000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !output.includes("Resolved the handoff")) reject(new Error(`Fixture confirmation failed: ${output}`));
      else resolve(output);
    });
  });
}

function fixtureState(taskPatch = {}) {
  return {
    projects: [
      {
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath: "/tmp/demo",
      },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Review the design foundation",
        status: "blocked",
        dependsOnTaskIds: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        ...taskPatch,
      },
    ],
    comments: [],
    events: [],
    reviews: [],
    runs: [],
  };
}

test("automation configuration blockers are not mistaken for completed dependencies", async () => {
  const state = fixtureState({
    assignedAgentRole: "owner",
    automationBlocker: {
      type: "configuration",
      reason: "invalid_github_app_credentials",
      runId: "run_1",
      resumeStatus: "lead_review",
      blockedAt: "2026-07-20T10:00:00.000Z",
    },
  });

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, []);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].assignedAgentRole, "owner");
  assert.equal(state.tasks[0].automationBlocker.resumeStatus, "lead_review");

  const report = createSupervisorReport(state);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "repair_automation_config");
  assert.equal(report.actions[0].role, "owner");
  assert.equal(report.actions[0].nextStatus, "lead_review");
  assert.match(report.actions[0].reason, /invalid_github_app_credentials/);
});

test("explicit configuration repair clears stale retry suppression and assignment", async () => {
  const project = await addProject({ key: "config-repair", name: "Configuration repair" });
  const task = await addTask({
    project: project.id,
    title: "Resume after an output-policy repair",
    status: "ready",
    architectureRequired: false,
    architectureStatus: "not_required",
    architectureDecision: "No architecture work is required for this bounded recovery fixture.",
    userStory: "As an operator, I want repaired work to resume without stale suppression.",
    expectedOutcome: "The repaired task is eligible for a fresh dispatch.",
    acceptanceCriteria: ["The old failure fingerprint is cleared."],
    workAreas: ["src/store.js"],
    affectedSurfaces: ["configuration recovery"],
    validationPlan: ["Run the isolated test suite."],
    riskClassification: "medium",
    privacyNotes: "No personal data.",
    securityNotes: "The repair remains an explicit owner action.",
    dependsOnTaskIds: [],
  });
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "blocked";
    stored.assignedAgentRole = "owner";
    stored.retryNotBefore = "2026-09-01T20:00:00.000Z";
    stored.lastAutomationFailure = "command_output_budget_exceeded";
    stored.lastAutomationFailureRunId = "run_old";
    stored.automationAttemptEpoch = 2;
    stored.automationBlocker = {
      type: "configuration",
      reason: "command_output_budget_exceeded",
      runId: "run_old",
      resumeStatus: "queued",
      blockedAt: "2026-09-01T18:00:00.000Z",
    };
  });

  await updateTask(task.id, { status: "queued" });
  const repaired = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(repaired.status, "queued");
  assert.equal(repaired.assignedAgentRole, "");
  assert.equal(repaired.retryNotBefore, "");
  assert.equal(repaired.lastAutomationFailure, "");
  assert.equal(repaired.lastAutomationFailureRunId, "");
  assert.equal(repaired.automationAttemptEpoch, 3);
  assert.equal(repaired.automationBlocker, undefined);
});

test("explicit configuration repair can restore a blocked architecture run", async () => {
  const project = await addProject({ key: "architecture-repair", name: "Architecture repair" });
  const task = await addTask({
    project: project.id,
    title: "Resume architecture after output-policy repair",
    status: "architecture_pending",
    architectureRequired: true,
    userStory: "As an operator, I want interrupted architecture work to resume at the same stage.",
    expectedOutcome: "The repaired task is eligible for a fresh architecture dispatch.",
    acceptanceCriteria: ["The configuration blocker is cleared without bypassing architecture."],
    workAreas: ["src/store.js"],
    affectedSurfaces: ["configuration recovery"],
    validationPlan: ["Run the isolated automation-blocker test suite."],
    riskClassification: "medium",
    privacyNotes: "No personal data.",
    securityNotes: "The repair remains an explicit owner action.",
    dependsOnTaskIds: [],
  });
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "blocked";
    stored.assignedAgentRole = "owner";
    stored.lastAutomationFailure = "cumulative_command_output_budget_exceeded";
    stored.lastAutomationFailureRunId = "run_architecture";
    stored.automationBlocker = {
      type: "configuration",
      reason: "cumulative_command_output_budget_exceeded",
      runId: "run_architecture",
      resumeStatus: "architecture_pending",
      blockedAt: "2026-09-03T12:00:00.000Z",
    };
  });

  await updateTask(task.id, { status: "architecture_pending" });
  const repaired = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(repaired.status, "architecture_pending");
  assert.equal(repaired.assignedAgentRole, "");
  assert.equal(repaired.lastAutomationFailure, "");
  assert.equal(repaired.lastAutomationFailureRunId, "");
  assert.equal(repaired.automationBlocker, undefined);
});

test("ordinary dependency blockers still return to the builder queue", async () => {
  const state = fixtureState();

  const tick = await automationTick({ state, limit: 10 });

  assert.deepEqual(tick.actions, ["task_1: unblocked"]);
  assert.equal(state.tasks[0].status, "queued");
});

test("a worker's explicit scope block stays blocked through a tick and completed handoff", async () => {
  const project = await addProject({ key: "worker-scope-block", name: "Worker scope block" });
  const task = await addTask({
    project: project.id,
    title: "Architecture needs a scoped remap",
    status: "architecture_pending",
    architectureRequired: true,
    userStory: "As an owner, I want a blocked architect to stop instead of repeating unchanged work.",
    expectedOutcome: "The scope handoff remains blocked until it is addressed.",
    acceptanceCriteria: ["No duplicate architect is queued while the scope is unchanged."],
    workAreas: ["src/store.js"],
    affectedSurfaces: ["architecture handoff"],
    validationPlan: ["Run the isolated workflow test."],
    riskClassification: "medium",
    privacyNotes: "No personal data.",
    securityNotes: "The blocker cannot be inferred as approval.",
    dependsOnTaskIds: [],
  });
  const runId = "run_scope_handoff_fixture";
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "architecture_in_progress";
    const now = new Date().toISOString();
    state.runs.push({ id: runId, projectId: project.id, taskId: task.id,
      status: "running", group: "architect", role: "systems-architect",
      actionType: "start_architecture", startedAt: now, updatedAt: now });
  });

  await updateTask(task.id, { status: "blocked" });
  let state = await readState();
  let stored = state.tasks.find((item) => item.id === task.id);
  assert.equal(stored.workerHandoffBlock?.reason, "explicit_block_requires_resolution");
  assert.ok(stored.workerHandoffBlock.runIds.includes(runId));
  await assert.rejects(updateTask(task.id, { status: "architecture_pending" }), /worker_handoff_resolution_required/);
  await assert.rejects(resolveWorkerHandoff(task.id, { expectedStateVersion: stored.stateVersion, reason: "Reviewed the scope blocker and prepared a bounded repair." },
    { confirm: async () => "fixture-owner" }), /worker_handoff_run_active/);
  await automationTick({ state, project: project.id });
  assert.equal(stored.status, "blocked", "the steward must not requeue an active worker's explicit block");

  const completed = await completeRun(runId, { state, status: "completed", notes: "A bounded scope remap is needed." });
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionDisposition, "worker_blocked");
  assert.notEqual(stored.architectureStatus, "completed");
  assert.equal(stored.status, "blocked");
  assert.equal(stored.workerHandoffBlock.reason, "explicit_block_requires_resolution");
  await automationTick({ state, project: project.id });
  const report = createSupervisorReport(state, { project: project.key, includeWaiting: true });
  const action = report.actions.find((item) => item.taskId === task.id);
  assert.equal(stored.status, "blocked", "a completed blocked handoff must not silently retry");
  assert.equal(action?.type, "resolve_worker_handoff");
  assert.equal(action?.role, "owner");
  assert.deepEqual(planDispatches(state, report.actions.filter((item) => item.taskId === task.id)).selected, []);

  await completeRun(runId, { status: "completed", notes: "A bounded scope remap is needed." });
  await updateTask(task.id, { workAreas: ["src/store.js", "src/supervisor.js"] });
  stored = (await readState()).tasks.find((item) => item.id === task.id);
  await assert.rejects(resolveWorkerHandoff(task.id, { expectedStateVersion: stored.stateVersion,
    reason: "The scope was remapped and reviewed before resumption." }, { confirm: async () => "forged" }), /worker_handoff_local_confirmation_required/);
  await confirmFixtureHandoff(task.id, stored.stateVersion, "The scope was remapped and reviewed before resumption.");
  state = await readState();
  stored = state.tasks.find((item) => item.id === task.id);
  assert.equal(stored.workerHandoffBlock.state, "awaiting_explicit_resume");
  await automationTick({ state, project: project.id });
  assert.equal(stored.status, "blocked", "resolving the handoff must not itself queue another run");
  const resumeReport = createSupervisorReport(state, { project: project.key, includeWaiting: true });
  assert.equal(resumeReport.actions.find((item) => item.taskId === task.id)?.type, "resume_worker_handoff");
  assert.deepEqual(planDispatches(state, resumeReport.actions.filter((item) => item.taskId === task.id)).selected, []);
  await updateTask(task.id, { status: "architecture_pending" });
  stored = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(stored.status, "architecture_pending");
  assert.equal(stored.workerHandoffBlock, undefined, "explicit resumption after repair clears the handoff hold");
});

test("a running worker holds a blocked task even if a legacy record lacks a handoff marker", async () => {
  const state = fixtureState();
  state.runs.push({ id: "run_active", taskId: "task_1", projectId: "project_1", status: "running" });
  assert.deepEqual((await automationTick({ state })).actions, []);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(createSupervisorReport(state, { includeWaiting: true }).actions[0].type, "waiting_for_worker_handoff");
  state.runs[0].status = "completed";
  assert.deepEqual((await automationTick({ state })).actions, ["task_1: unblocked"]);
});

test("an explicit handoff survives transient recovery and stops an already queued run", async () => {
  const state = fixtureState({
    workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_prior"], blockedAt: "2026-07-20T10:00:00.000Z" },
    automationBlocker: { type: "transient", reason: "provider_unavailable", runId: "run_prior", retryAt: "2026-07-20T10:01:00.000Z", resumeStatus: "queued" },
  });
  const run = { id: "run_queued", taskId: "task_1", projectId: "project_1", group: "builder", role: "builder", actionType: "start_builder", status: "queued" };
  state.runs.push(run);
  assert.deepEqual((await automationTick({ state, nowMs: Date.parse("2026-07-20T12:00:00.000Z") })).actions, []);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].automationBlocker.type, "transient");
  assert.equal(queuedRunExecutionBlocker(state, run), "worker_handoff_blocked");
  assert.deepEqual(await claimRuns({ state, limit: 1 }), []);
  assert.equal(run.status, "queued", "an existing queued run is held, not launched or discarded");

  const stale = structuredClone(state);
  stale.tasks[0].status = "queued";
  stale.runs = [];
  const action = { type: "start_builder", taskId: "task_1", projectId: "project_1", role: "builder", taskStatus: "queued" };
  const plan = planDispatches(stale, [action]);
  assert.deepEqual(plan.selected, []);
  assert.ok(plan.skipped.some((item) => item.reason === "worker_handoff_blocked"));
});

test("completion of an unrelated dependency does not erase an explicit worker handoff", async () => {
  const project = await addProject({ key: "worker-block-with-dependency", name: "Worker block with dependency" });
  const dependency = await addTask({ project: project.id, title: "Separate prerequisite", status: "idea", architectureRequired: false });
  const task = await addTask({
    project: project.id, title: "Architect needs scope", status: "architecture_pending", architectureRequired: true,
    userStory: "As an owner, I want an explicit scope issue preserved when a different dependency changes.",
    expectedOutcome: "The worker handoff stays blocked until the scope issue is addressed.",
    acceptanceCriteria: ["Completing an unrelated prerequisite does not restart the worker."], workAreas: ["src/store.js"],
    affectedSurfaces: ["architecture handoff"], validationPlan: ["Run the isolated workflow test."],
    riskClassification: "medium", privacyNotes: "No personal data.", securityNotes: "No dependency is fabricated.",
    dependsOnTaskIds: [],
  });
  const runId = "run_worker_block_dependency_fixture";
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "architecture_in_progress";
    stored.dependsOnTaskIds = [dependency.id];
    const now = new Date().toISOString();
    state.runs.push({ id: runId, projectId: project.id, taskId: task.id, status: "running", group: "architect",
      role: "systems-architect", actionType: "start_architecture", startedAt: now, updatedAt: now });
  });
  await updateTask(task.id, { status: "blocked" });
  const state = await readState();
  const stored = state.tasks.find((item) => item.id === task.id);
  assert.ok(stored.workerHandoffBlock.runIds.includes(runId));
  state.tasks.find((item) => item.id === dependency.id).status = "done";
  await completeRun(runId, { state, status: "completed", notes: "Scope remains incomplete." });
  await automationTick({ state, project: project.id });
  assert.equal(stored.status, "blocked");
  assert.ok(stored.workerHandoffBlock);
});

test("a genuine failure after an explicit worker block keeps the failure incident and the block", async () => {
  const project = await addProject({ key: "worker-block-failure", name: "Worker block failure" });
  const task = await addTask({
    project: project.id, title: "Blocked architect fails", status: "architecture_pending", architectureRequired: true,
    userStory: "As an owner, I want a real failure recorded without retrying a blocked task.",
    expectedOutcome: "The failure remains visible and the task remains blocked.",
    acceptanceCriteria: ["The incident and its attempt count are retained."], workAreas: ["src/store.js"],
    affectedSurfaces: ["architecture handoff"], validationPlan: ["Run the isolated workflow test."],
    riskClassification: "medium", privacyNotes: "No personal data.", securityNotes: "No failure is discarded.",
    dependsOnTaskIds: [],
  });
  const runId = "run_worker_block_failure_fixture";
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.status = "architecture_in_progress";
    const now = new Date().toISOString();
    state.runs.push({ id: runId, projectId: project.id, taskId: task.id,
      status: "running", group: "architect", role: "systems-architect", provider: "codex-cli",
      actionType: "start_architecture", startedAt: now, updatedAt: now });
  });
  await updateTask(task.id, { status: "blocked" });
  const run = await completeRun(runId, { status: "failed", exitCode: "execution_failed", notes: "Fixture failure after scope block." });
  const state = await readState();
  const stored = state.tasks.find((item) => item.id === task.id);
  const incidents = await readFailureIncidents({ taskId: task.id });
  assert.equal(run.status, "failed");
  assert.equal(stored.status, "blocked");
  assert.ok(stored.workerHandoffBlock.runIds.includes(runId));
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].paidAttempts, 1);
  assert.equal(incidents[0].reasonCode, "execution_failed");
  const blocker = structuredClone(stored.automationBlocker);
  await assert.rejects(updateTask(task.id, { status: "architecture_pending" }), /worker_handoff_resolution_required/);
  await confirmFixtureHandoff(task.id, stored.stateVersion, "The scope handoff was reviewed; the separate failure remains open.");
  const afterResolution = (await readState()).tasks.find((item) => item.id === task.id);
  assert.deepEqual(afterResolution.automationBlocker, blocker);
  assert.equal(afterResolution.status, "blocked");
  await automationTick({ state, project: project.id });
  assert.equal(stored.status, "blocked");
  assert.equal(createSupervisorReport(state, { project: project.key, includeWaiting: true }).actions.find((item) => item.taskId === task.id)?.type, "resolve_worker_handoff");
});

test("an over-budget blocked handoff preserves both the block and budget pause", async () => {
  const state = fixtureState({ workerHandoffBlock: {
    reason: "explicit_block_requires_resolution", runIds: ["run_scope_budget"], blockedAt: "2026-07-20T10:00:00.000Z",
  } });
  state.runs.push({ id: "run_scope_budget", taskId: "task_1", projectId: "project_1",
    status: "running", group: "architect", role: "systems-architect", actionType: "start_architecture", tokenBudget: 100 });
  const run = await completeRun("run_scope_budget", { state, status: "completed", usage: { input_tokens: 101, output_tokens: 1 } });
  assert.equal(run.completionDisposition, "worker_blocked_over_budget");
  assert.equal(run.exitCode, "effective_token_budget_exceeded");
  assert.equal(state.tasks[0].status, "blocked");
  assert.ok(state.tasks[0].workerHandoffBlock);
  assert.equal(state.tasks[0].budgetPause.runId, "run_scope_budget");
  assert.equal(state.tasks[0].budgetTelemetry.disposition, "worker_blocked");
  await automationTick({ state });
  assert.equal(state.tasks[0].status, "blocked");
});

test("resolving a handoff cancels only its unstarted queued work and retains independent failure evidence", async () => {
  const project = await addProject({ key: "handoff-queue", name: "Handoff queue" });
  const task = await addTask({ project: project.id, title: "Blocked work", status: "blocked", architectureRequired: false });
  const now = new Date().toISOString();
  await mutateState((state) => {
    const stored = state.tasks.find((item) => item.id === task.id);
    stored.workerHandoffBlock = { reason: "explicit_block_requires_resolution", runIds: ["run_held_queue"], blockedAt: now };
    stored.automationBlocker = { type: "failure_containment", reason: "provider_unavailable", incidentId: "fixture_incident" };
    state.runs.push({ id: "run_held_queue", taskId: task.id, projectId: project.id, status: "queued", notes: "Original queued evidence." });
  });
  let state = await readState();
  let held = state.tasks.find((item) => item.id === task.id);
  await assert.rejects(resolveWorkerHandoff(task.id, { expectedStateVersion: held.stateVersion - 1, reason: "The owner reviewed the original scope issue." },
    { confirm: async () => "fixture-owner" }), /worker_handoff_stale_state|authority_required/);
  await assert.rejects(updateTask(task.id, { resolveWorkerHandoff: true }), /worker_handoff_local_resolution_required/);
  await confirmFixtureHandoff(task.id, held.stateVersion, "The scope handoff was investigated and resolved.");
  state = await readState();
  held = state.tasks.find((item) => item.id === task.id);
  const queued = state.runs.find((item) => item.id === "run_held_queue");
  assert.equal(held.status, "blocked");
  assert.equal(held.workerHandoffBlock.state, "awaiting_explicit_resume");
  assert.equal(held.automationBlocker.incidentId, "fixture_incident");
  assert.equal(queued.status, "cancelled");
  assert.equal(queued.attemptConsumed, false);
  assert.match(queued.notes, /Original queued evidence/);
  assert.ok(state.events.some((item) => item.type === "run_cancelled" && item.runId === queued.id));
});

test("a blocked local builder cannot materialize a candidate and a late completion cannot erase a terminal failure", async () => {
  const run = { id: "run_builder_hold", taskId: "task_1", projectId: "project_1", status: "running",
    group: "builder", role: "builder", actionType: "start_builder", workflowMode: "local", workspacePath: "/missing-on-purpose" };
  const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: [run.id], blockedAt: new Date().toISOString() } });
  state.runs.push(run);
  const result = await completeRunAfterExecution(run, { state, status: "completed" }, run);
  assert.equal(result.completionDisposition, "worker_blocked");
  assert.equal(state.tasks[0].candidateIdentity, undefined);
  assert.equal(state.tasks[0].reviewSubjectCycle, undefined);
  run.status = "failed"; run.exitCode = "orphaned_run:fixture"; run.notes = "Original failure evidence.";
  const late = await completeRunAfterExecution(run, { state, status: "completed" }, run);
  assert.equal(late.status, "failed");
  assert.equal(late.exitCode, "orphaned_run:fixture");
  assert.equal(late.notes, "Original failure evidence.");
  assert.equal(late.completionObservedExisting, true);
  assert.equal(state.tasks[0].candidateIdentity, undefined);
});

test("a denied failure claim racing a worker block preserves the block and independent failure state", () => {
  for (const incidentState of ["backoff", "open"]) for (const existingCircuit of [true, false]) {
    const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_claim_race"], blockedAt: new Date().toISOString() },
      automationBlocker: { type: "configuration", runId: "run_older", reason: "existing_failure" },
      ...(existingCircuit ? { automationCircuit: { state: "open", reasonCode: "existing_failure" } } : {}),
      retryNotBefore: "2026-12-02T00:00:00Z" });
    const run = { id: "run_claim_race", projectId: "project_1", taskId: "task_1", status: "running", group: "builder" };
    state.runs.push(run);
    const previousBlocker = structuredClone(state.tasks[0].automationBlocker);
    const previousCircuit = structuredClone(state.tasks[0].automationCircuit);
    const claim = { reason: incidentState === "open" ? "attempt_budget_exhausted" : "backoff",
      incident: { state: incidentState, incidentId: "failure_fixture", generation: 1, backoffUntil: "2026-12-01T00:00:00Z" } };
    assert.equal(denyPaidFailureAttemptInState(state, run, claim), true);
    assert.equal(run.status, "cancelled");
    assert.equal(run.failureAttemptDenial.incidentId, "failure_fixture");
    assert.equal(state.tasks[0].status, "blocked");
    assert.deepEqual(state.tasks[0].automationBlocker, previousBlocker);
    assert.deepEqual(state.tasks[0].automationCircuit, previousCircuit);
    assert.equal(state.tasks[0].retryNotBefore, "2026-12-02T00:00:00Z");
    assert.ok(state.tasks[0].workerHandoffBlock);
  }
});

test("a held denial keeps an unrelated closed circuit and no task blocker unchanged", () => {
  const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_closed_circuit"], blockedAt: new Date().toISOString() },
    automationCircuit: { state: "closed", reasonCode: "older_incident" } });
  const run = { id: "run_closed_circuit", taskId: "task_1", projectId: "project_1", status: "running", group: "builder" };
  state.runs.push(run);
  assert.equal(denyPaidFailureAttemptInState(state, run, { reason: "attempt_budget_exhausted",
    incident: { state: "open", incidentId: "failure_new", generation: 2, backoffUntil: "" } }), true);
  assert.equal(state.tasks[0].automationCircuit.reasonCode, "older_incident");
  assert.equal(state.tasks[0].automationBlocker, undefined);
  assert.equal(run.failureAttemptDenial.incidentId, "failure_new");
});

test("a late configuration failure cannot overwrite an earlier terminal run or independent blocker", async () => {
  const state = fixtureState({ automationBlocker: { type: "configuration", runId: "run_other", reason: "preserved" } });
  const run = { id: "run_late", projectId: "project_1", taskId: "task_1", status: "failed", exitCode: "invalid_github_app_credentials",
    completedAt: "2026-07-20T10:00:00.000Z" };
  state.runs.push(run);
  const before = structuredClone(state.tasks[0]);
  assert.equal(await pauseTaskForAutomationConfig(run, run.exitCode, "late result", { ...run, completionObservedExisting: true }, { state }), false);
  assert.equal(await pauseTaskForAutomationConfig(run, run.exitCode, "late result", run, { state }), false);
  assert.deepEqual(state.tasks[0], before);
  delete state.tasks[0].automationBlocker;
  assert.equal(await pauseTaskForAutomationConfig(run, run.exitCode, "current result", run, { state }), true);
  assert.equal(state.tasks[0].automationBlocker.runId, run.id);
});

test("a denied claim reports an already terminal failure without inventing cancellation", async () => {
  const state = fixtureState();
  const run = { id: "run_terminal_denial", projectId: "project_1", taskId: "task_1", status: "failed", exitCode: "orphaned_run:watchdog" };
  state.runs.push(run);
  assert.equal(denyPaidFailureAttemptInState(state, run, { reason: "backoff", incident: { state: "backoff" } }), false);
  assert.deepEqual(await observedDeniedFailureRun(run.id, { state }), run);
});

test("a provider start is stopped by a new handoff without erasing a paid claim", async () => {
  const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_claimed"], blockedAt: new Date().toISOString() } });
  state.runs.push({ id: "run_claimed", projectId: "project_1", taskId: "task_1", status: "running",
    failureContainmentClaim: { incidentId: "fixture-claim" }, notes: "Claim evidence." });
  const stopped = await stopHeldRunBeforeProviderStart("run_claimed", { state });
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.failureContainmentClaim.incidentId, "fixture-claim");
  assert.equal(stopped.attemptConsumed, false);
  assert.match(stopped.notes, /Claim evidence/);
});

test("a held handoff retains diagnostics when an inferred validation or materialization failure races the block", async () => {
  for (const kind of ["validation", "materialization"]) {
    const runId = `run_handoff_${kind}`;
    const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: [runId], blockedAt: new Date().toISOString() } });
    state.runs.push({ id: runId, taskId: "task_1", projectId: "project_1", status: "running", group: "builder", role: "builder" });
    const code = kind === "validation" ? "validation_evidence_missing" : "local_candidate_materialization_failed";
    const run = await completeRun(runId, { state, status: "failed", exitCode: code, notes: "Observed handoff diagnostic.",
      ...(kind === "validation" ? { validationFailureWhileAttemptingHandoff: true } : { materializationFailureWhileAttemptingHandoff: true }) });
    if (kind === "validation") {
      assert.equal(run.completionDisposition, "worker_blocked");
      assert.equal(run.contextEvidence.deferredHandoffFailure, code);
    } else {
      assert.equal(run.status, "failed");
      assert.equal(run.exitCode, code);
    }
    assert.match(run.notes, /Observed handoff diagnostic/);
    assert.equal(state.tasks[0].status, "blocked");
  }
});

test("direct lifecycle blocking captures a versioned hold and cannot be resumed through ordinary lifecycle commands", async () => {
  const project = await addProject({ key: "handoff-transition", name: "Handoff transition" });
  const task = await addTask({ project: project.id, title: "Architect task", status: "architecture_pending", architectureRequired: true });
  await mutateState((state) => {
    state.tasks.find((item) => item.id === task.id).status = "architecture_in_progress";
    state.runs.push({ id: "run_transition_hold", taskId: task.id, projectId: project.id, status: "running" });
  });
  let stored = (await readState()).tasks.find((item) => item.id === task.id);
  const before = stored.stateVersion;
  await transitionTask({ action: "block_workflow", taskId: task.id, expectedStateVersion: before,
    actorContext: { actorId: "fixture-engine", actorType: "system", role: "workflow-engine", trusted: true }, evidence: { targetStatus: "blocked" } });
  stored = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(stored.stateVersion, before + 1);
  assert.ok(stored.workerHandoffBlock.runIds.includes("run_transition_hold"));
  await assert.rejects(transitionTask({ action: "resume_workflow", taskId: task.id, expectedStateVersion: stored.stateVersion,
    actorContext: { actorId: "fixture-owner", actorType: "owner", role: "owner", trusted: true }, evidence: { targetStatus: "architecture_pending" } }),
  /worker_handoff_resolution_required/);
});

test("adding a hold to an already blocked task increments the version and rejects stale lifecycle commands", async () => {
  const project = await addProject({ key: "handoff-cas", name: "Handoff CAS" });
  const task = await addTask({ project: project.id, title: "Already blocked", status: "blocked", architectureRequired: false });
  await mutateState((state) => state.runs.push({ id: "run_cas_hold", projectId: project.id, taskId: task.id, status: "running" }));
  let stored = (await readState()).tasks.find((item) => item.id === task.id);
  const before = stored.stateVersion;
  await updateTask(task.id, { status: "blocked" });
  stored = (await readState()).tasks.find((item) => item.id === task.id);
  assert.equal(stored.stateVersion, before + 1);
  await assert.rejects(transitionTask({ action: "mutate_assignment", taskId: task.id, expectedStateVersion: before,
    actorContext: { actorId: "fixture", actorType: "owner", role: "owner", trusted: true }, evidence: { targetStatus: "blocked" } }), /Stale lifecycle command/);
});

test("automatic credit and circuit recovery cannot erase an explicit handoff or its independent holds", () => {
  const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_prior"], blockedAt: "2026-07-20T10:00:00.000Z" },
    automationCircuit: { state: "open", reasonCode: "credit_budget_insufficient", openedAt: "2026-07-20T09:00:00.000Z", snapshot: { status: "queued" } },
    automationBlocker: { type: "circuit", reason: "insufficient_credit_balance" },
    creditAdmissionPause: { active: true, reasonCode: "insufficient_credit_balance" } });
  const task = state.tasks[0];
  const before = structuredClone(task);
  assert.equal(recoverPrepaidCreditCircuitInState(state, task, {}), false);
  assert.equal(recoverCreditAdmissionPauseInState(state, task, {}).recovered, false);
  assert.equal(supersedeStaleTaskCircuitInState(state, task), false);
  assert.deepEqual(recoverAffordableCreditCircuitsInState(state, { creditPolicy: { enabled: true } }), []);
  assert.throws(() => resetAutomationCircuitInState(state, { task: task.id }), /worker_handoff_resolution_required/);
  assert.deepEqual(task, before);
});

test("an independently verified circuit reset preserves the resolved handoff until explicit resume", async () => {
  const state = fixtureState({ workerHandoffBlock: { reason: "explicit_block_requires_resolution", runIds: ["run_prior"],
    blockedAt: "2026-07-20T10:00:00.000Z", resolvedAt: "2026-07-20T11:00:00.000Z", state: "awaiting_explicit_resume" },
    automationCircuit: { state: "open", reasonCode: "attempt_budget_exhausted", openedAt: "2026-07-20T09:00:00.000Z",
      snapshot: { status: "queued", assignedAgentRole: "builder", reviewCycle: 0, reviewSubjectCycle: 0, reviewSubjectSha: "", candidateIdentity: null, branchName: "" } },
    automationBlocker: { type: "circuit", reason: "attempt_budget_exhausted" } });
  resetAutomationCircuitInState(state, { task: "task_1", expectedOpenedAt: "2026-07-20T09:00:00.000Z", reason: "Separate circuit repair verified." });
  assert.equal(state.tasks[0].automationCircuit.state, "closed");
  assert.equal(state.tasks[0].automationBlocker, undefined);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.tasks[0].workerHandoffBlock.state, "awaiting_explicit_resume");
  await automationTick({ state });
  assert.equal(state.tasks[0].status, "blocked");
});

test("explicit status repair can clear a resolved handoff with independently repaired configuration or elapsed transient backoff", async () => {
  const project = await addProject({ key: "handoff-legacy-repair", name: "Handoff legacy repair" });
  for (const type of ["configuration", "transient"]) {
    const task = await addTask({ project: project.id, title: `${type} blocker`, status: "blocked", architectureRequired: false,
      userStory: "As an operator, I want separately repaired work to resume.",
      expectedOutcome: "The repaired task can reenter its normal queue.", acceptanceCriteria: ["The independent repair is recorded."],
      affectedSurfaces: ["workflow"], workAreas: ["src/store.js"], validationPlan: ["Run focused workflow tests."],
      riskClassification: "medium", privacyNotes: "No personal data.", securityNotes: "Preserve all failures." });
    await mutateState((state) => {
      const stored = state.tasks.find((item) => item.id === task.id);
      stored.workerHandoffBlock = { reason: "explicit_block_requires_resolution", runIds: ["run_old"], blockedAt: "2026-01-01T00:00:00Z",
        resolvedAt: "2026-01-02T00:00:00Z", state: "awaiting_explicit_resume" };
      stored.automationBlocker = { type, reason: "fixture_fault", retryAt: "2026-01-02T00:00:00Z", resumeStatus: "queued" };
    });
    await updateTask(task.id, { status: "queued" });
    const state = await readState();
    const stored = state.tasks.find((item) => item.id === task.id);
    assert.equal(stored.status, "queued");
    assert.equal(stored.workerHandoffBlock, undefined);
    assert.equal(stored.automationBlocker, undefined);
    assert.equal(state.events.findLast((item) => item.type === "worker_handoff_independent_repair" && item.taskId === task.id).previousBlocker.type, type);
  }
});
