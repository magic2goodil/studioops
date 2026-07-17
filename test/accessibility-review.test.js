import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extractConfigJson, projectFromConfig } from "../src/config.js";
import { createSupervisorReport } from "../src/supervisor.js";
import { DEFAULT_REVIEW_PIPELINE, generatePrompt } from "../src/store.js";
import { laneProfile } from "../src/work-lanes.js";

function fixtureState(taskPatch = {}, reviews = [], projectPatch = {}) {
  return {
    projects: [
      {
        id: "project_1",
        key: "demo",
        name: "Demo",
        repoPath: "/tmp/demo",
        repoUrl: "https://github.com/example/demo",
        defaultBranch: "main",
        validationCommands: ["npm run check"],
        ...projectPatch,
      },
    ],
    tasks: [
      {
        id: "task_1",
        projectId: "project_1",
        title: "Improve dashboard accessibility",
        status: "builder_review",
        priority: "medium",
        type: "feature",
        lane: "frontend",
        branchName: "codex/demo-task_1-a11y",
        prUrl: "https://github.com/example/demo/pull/1",
        reviewCycle: 1,
        acceptanceCriteria: [
          "Dashboard UI works on mobile, tablet, and desktop.",
          "Keyboard and screen-reader behavior are reviewed before QA handoff.",
        ],
        ...taskPatch,
      },
    ],
    comments: [],
    events: [],
    reviews,
    runs: [],
  };
}

test("default review pipeline routes accessibility review before lead review", () => {
  assert.deepEqual(
    DEFAULT_REVIEW_PIPELINE.map((stage) => stage.key),
    ["backend", "frontend", "accessibility", "lead"],
  );

  const state = fixtureState({}, [
    {
      id: "review_1",
      taskId: "task_1",
      stageKey: "backend",
      role: "backend-reviewer",
      cycle: 1,
      outcome: "approved",
      createdAt: "2026-07-17T10:00:00.000Z",
    },
    {
      id: "review_2",
      taskId: "task_1",
      stageKey: "frontend",
      role: "frontend-reviewer",
      cycle: 1,
      outcome: "approved",
      createdAt: "2026-07-17T10:05:00.000Z",
    },
  ]);

  const report = createSupervisorReport(state);

  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "start_review");
  assert.equal(report.actions[0].role, "accessibility-reviewer");
  assert.equal(report.actions[0].nextStatus, "accessibility_review");
  assert.match(report.actions[0].promptCommand, /--role accessibility-reviewer$/);
  assert.match(report.actions[0].reviewCommand, /--stage accessibility /);
});

test("legacy frontend review pipelines gain accessibility review before lead review", () => {
  const state = fixtureState({}, [
    {
      id: "review_1",
      taskId: "task_1",
      stageKey: "backend",
      role: "backend-reviewer",
      cycle: 1,
      outcome: "approved",
      createdAt: "2026-07-17T10:00:00.000Z",
    },
    {
      id: "review_2",
      taskId: "task_1",
      stageKey: "frontend",
      role: "frontend-reviewer",
      cycle: 1,
      outcome: "approved",
      createdAt: "2026-07-17T10:05:00.000Z",
    },
  ], {
    reviewPipeline: [
      {
        key: "backend",
        label: "Backend Review",
        role: "backend-reviewer",
        status: "backend_review",
        required: true,
      },
      {
        key: "frontend",
        label: "Frontend Review",
        role: "frontend-reviewer",
        status: "frontend_review",
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
  });

  const report = createSupervisorReport(state);
  const prompt = generatePrompt(state, "task_1", "lead-reviewer");

  assert.equal(report.actions[0].role, "accessibility-reviewer");
  assert.equal(report.actions[0].nextStatus, "accessibility_review");
  assert.match(prompt, /Accessibility Review \(accessibility-reviewer\)/);
});

test("accessibility reviewer prompt includes the required checklist and breakpoints", () => {
  const prompt = generatePrompt(fixtureState(), "task_1", "accessibility-reviewer");

  assert.match(prompt, /accessibility expert reviewer/);
  assert.match(prompt, /color contrast/);
  assert.match(prompt, /readable typography/);
  assert.match(prompt, /focus-visible states/);
  assert.match(prompt, /keyboard tab order/);
  assert.match(prompt, /semantic headings/);
  assert.match(prompt, /link and button names/);
  assert.match(prompt, /alt text/);
  assert.match(prompt, /title text/);
  assert.match(prompt, /form labels/);
  assert.match(prompt, /ARIA use/);
  assert.match(prompt, /screen-reader basics/);
  assert.match(prompt, /mobile, tablet, and desktop/);
  assert.match(prompt, /mission-control review task_1 --stage accessibility/);
});

test("accessibility reviewer runs use the frontend lane profile", () => {
  const task = fixtureState({ lane: "" }).tasks[0];
  const profile = laneProfile(task, { role: "accessibility-reviewer" });

  assert.equal(profile.lane, "frontend");
  assert.equal(profile.conflictGroup, "frontend-surface");
});

test("example config imports accessibility review before lead review", async () => {
  const markdown = await readFile("mission-control.config.example.md", "utf8");
  const config = extractConfigJson(markdown);

  assert.equal(config.githubApps.roleMap["accessibility-reviewer"], "default");
  assert.deepEqual(
    config.defaults.reviewPipeline.map((stage) => stage.key),
    ["backend", "frontend", "accessibility", "lead"],
  );

  const project = projectFromConfig(config.projects[0], config.defaults);
  assert.deepEqual(
    project.reviewPipeline.map((stage) => stage.key),
    ["backend", "frontend", "accessibility", "lead"],
  );
  assert.equal(project.reviewPipeline[2].status, "accessibility_review");
  assert.equal(project.reviewPipeline[2].role, "accessibility-reviewer");
});
