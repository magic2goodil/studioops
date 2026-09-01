import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createRemediationHandoff,
  currentRemediationHandoff,
  REMEDIATION_HANDOFF_LIMITS,
  remediationPromptSection,
  supersedeRemediationHandoff,
} from "../src/remediation-handoff.js";
import {
  addProject,
  addTask,
  generatePrompt,
  readState,
  recordReview,
  recordReviewInState,
  taskWithProject,
  updateTask,
} from "../src/store.js";

const SUBJECT_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

function review(id, body, patch = {}) {
  return {
    id,
    taskId: "task_1",
    projectId: "project_1",
    cycle: 1,
    candidateCycle: 1,
    subjectSha: SUBJECT_SHA,
    stageKey: "backend",
    status: "backend_review",
    role: "backend-reviewer",
    outcome: "changes_requested",
    author: "Backend Lead",
    body,
    createdAt: `2026-08-17T10:00:0${id.replace(/\D/g, "") || 0}.000Z`,
    ...patch,
  };
}

function fixtureState() {
  return {
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/tmp/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      validationCommands: ["npm test"],
      reviewPipeline: [
        {
          key: "backend",
          label: "Backend Review",
          role: "backend-reviewer",
          status: "backend_review",
          required: true,
        },
        {
          key: "lead",
          label: "Primary Lead Review",
          role: "lead-reviewer",
          status: "lead_review",
          required: true,
        },
      ],
    }],
    tasks: [{
      id: "task_1",
      projectId: "project_1",
      title: "Repair candidate",
      type: "bug",
      status: "backend_review",
      priority: "high",
      branchName: "codex/demo-task_1",
      prUrl: "https://github.com/example/demo/pull/1",
      reviewCycle: 1,
      reviewSubjectCycle: 1,
      reviewSubjectSha: SUBJECT_SHA,
      acceptanceCriteria: ["The rejected behavior is fixed."],
    }],
    runs: [],
    reviews: [],
    comments: [],
    events: [],
  };
}

test("handoffs deduplicate findings, preserve attribution, order severity, and redact sensitive data", () => {
  const task = fixtureState().tasks[0];
  const handoff = createRemediationHandoff(task, [
    review("review_1", "High: authorization bypass. Token: github_pat_abcdefghijk and owner@example.com in /Users/jrobison/project."),
    review("review_2", "High: authorization bypass. Token: github_pat_abcdefghijk and owner@example.com in /Users/jrobison/project.", {
      stageKey: "lead",
      role: "lead-reviewer",
      author: "Primary Lead",
    }),
    review("review_3", "Low: align the label spacing."),
  ], "2026-08-17T10:05:00.000Z");

  assert.equal(handoff.findings.length, 2);
  assert.equal(handoff.findings[0].severity, "high");
  assert.equal(handoff.findings[0].sources.length, 2);
  assert.deepEqual(handoff.findings[0].sources.map((source) => source.reviewId), ["review_1", "review_2"]);
  assert.doesNotMatch(JSON.stringify(handoff), /github_pat_|owner@example\.com|\/Users\/jrobison/);
  assert.match(JSON.stringify(handoff), /REDACTED/);
});

test("recorded changes create an exact-candidate builder handoff without another discovery pass", () => {
  const state = fixtureState();
  state.tasks[0].candidateIdentity = {
    commitSha: SUBJECT_SHA,
    treeSha: "b".repeat(40),
    baseSha: "c".repeat(40),
    branch: "codex/exact-candidate",
    candidateCycle: 1,
  };
  const result = recordReviewInState(state, "task_1", {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "High: preserve the idempotency key across retries.\nRepro: retry a timed-out request.\nEvidence: https://local.test/evidence/1\nPatch boundary: src/retry.js only.",
  });
  const task = state.tasks[0];
  const prompt = generatePrompt(state, task.id, "builder");
  const detailed = taskWithProject(state, task);

  assert.equal(result.review.id, "review_1");
  assert.equal(task.status, "needs_changes");
  assert.equal(task.remediationHandoff.taskId, task.id);
  assert.equal(task.remediationHandoff.candidateCycle, 1);
  assert.equal(task.remediationHandoff.subjectSha, SUBJECT_SHA);
  assert.equal(detailed.currentRemediationHandoff.subjectSha, SUBJECT_SHA);
  assert.match(prompt, /Current reviewer remediation handoff/);
  assert.match(prompt, /preserve the idempotency key across retries/);
  assert.match(prompt, /Reproduction: retry a timed-out request/);
  assert.match(prompt, /Evidence: https:\/\/local\.test\/evidence\/1/);
  assert.match(prompt, /Approved patch boundary: src\/retry\.js only/);
  assert.match(prompt, /backend\/backend-reviewer \(review_1\)/);
  assert.match(prompt, new RegExp(SUBJECT_SHA));
  assert.match(prompt, /candidate tree: b{40}/);
  assert.match(prompt, /candidate base: c{40}/);
  assert.match(prompt, /candidate branch: codex\/exact-candidate/);
  assert.match(prompt, /Context efficiency contract:/);
  assert.match(prompt, /Cap ordinary inspection output at roughly 200 lines or 12 KB per command/);
});

test("superseded candidate findings are archived and excluded from later prompts", () => {
  const state = fixtureState();
  const task = state.tasks[0];
  task.remediationHandoff = createRemediationHandoff(task, [
    review("review_1", "Medium: fix the stale candidate only."),
  ]);

  supersedeRemediationHandoff(task, {
    status: "submitted",
    replacementSubjectSha: NEXT_SHA,
    resolution: "Builder submitted a replacement candidate.",
  });
  task.reviewSubjectCycle = 2;
  task.reviewSubjectSha = NEXT_SHA;
  const prompt = remediationPromptSection(task);

  assert.equal(currentRemediationHandoff(task), null);
  assert.equal(task.remediationHistory.at(-1).status, "submitted");
  assert.equal(task.remediationHistory.at(-1).replacementSubjectSha, NEXT_SHA);
  assert.doesNotMatch(prompt, /fix the stale candidate only/);
  assert.match(prompt, /No current reviewer remediation handoff/);
});

test("a persisted builder resubmission resolves the prior handoff and excludes it from the next candidate", async () => {
  const project = await addProject({
    key: "remediation-resubmission",
    name: "Remediation resubmission",
    repoPath: "/tmp/remediation-resubmission",
    repoUrl: "https://github.com/example/remediation-resubmission",
    reviewPipeline: [{
      key: "backend",
      label: "Backend Review",
      role: "backend-reviewer",
      status: "backend_review",
      required: true,
    }],
  });
  const task = await addTask({
    project: project.id,
    title: "Persist remediation handoff",
    type: "bug",
    status: "in_progress",
    architectureRequired: false,
  });
  await updateTask(task.id, {
    status: "builder_review",
    branchName: "codex/remediation-resubmission",
    prUrl: "https://github.com/example/remediation-resubmission/pull/1",
    subjectSha: SUBJECT_SHA,
  });
  await recordReview(task.id, {
    stage: "backend",
    outcome: "changes_requested",
    subjectSha: SUBJECT_SHA,
    candidateCycle: 1,
    body: "High: make the retry path idempotent.",
  });
  await updateTask(task.id, {
    status: "builder_review",
    subjectSha: NEXT_SHA,
  });

  const state = await readState();
  const updated = state.tasks.find((item) => item.id === task.id);
  assert.equal(updated.remediationHandoff, null);
  assert.equal(updated.remediationHistory.at(-1).status, "submitted");
  assert.equal(updated.remediationHistory.at(-1).replacementSubjectSha, NEXT_SHA);
  assert.doesNotMatch(generatePrompt(state, task.id, "builder"), /make the retry path idempotent/);
});

test("builder prompt remediation text is bounded and points to an exact local artifact", () => {
  const task = fixtureState().tasks[0];
  task.remediationHandoff = createRemediationHandoff(
    task,
    Array.from({ length: REMEDIATION_HANDOFF_LIMITS.maxFindings + 4 }, (_, index) => (
      review(`review_${index + 1}`, `Medium: finding ${index + 1} ${"detail ".repeat(900)}`)
    )),
  );
  const prompt = remediationPromptSection(task);

  assert.ok(prompt.length <= REMEDIATION_HANDOFF_LIMITS.maxPromptCharacters + 500);
  assert.match(prompt, /additional finding\(s\) are available/);
  assert.match(prompt, new RegExp(`/api/tasks/task_1/remediation-handoff\\?candidateCycle=1&subjectSha=${SUBJECT_SHA}`));
});

test("task UI and local artifact route expose remediation status and pull request context", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function renderRemediationPanel\(task\)/);
  assert.match(app, /Reviewer Remediation/);
  assert.match(app, /Open PR/);
  assert.match(app, /Prior handoffs/);
  assert.match(server, /remediation-handoff/);
  assert.match(server, /Current remediation handoff not found for that exact candidate/);
});
