import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createCandidateEnvelope } from "../src/candidate-manifest.js";
import { buildOwnerQaPacket } from "../src/owner-qa-packet.js";
import { createHermeticTestEnvironment } from "../scripts/test-environment.js";

const run = promisify(execFile);
const environment = await createHermeticTestEnvironment({ tempParent: os.tmpdir() });
Object.assign(process.env, environment.env);
test.after(async () => environment.cleanup());

const { qaDecisionCoordinatesForState, readState, writeState } = await import(
  `../src/store.js?qa-bundle-cli=${Date.now()}`
);

const BASE_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const INTEGRATION_SHA = "c".repeat(40);

function candidateFixture({ candidateId, bundleId, taskIds }) {
  return createCandidateEnvelope({
    qaBundleId: bundleId,
    manifest: {
      candidateId,
      projectId: "project_1",
      base: { branch: "main", sha: BASE_SHA },
      sources: taskIds.map((taskId, index) => ({
        taskId,
        sourceRef: `refs/heads/feature/${taskId}`,
        headSha: SOURCE_SHA,
        candidateCycle: 1,
        reviews: [{
          id: `review_${candidateId}_${index + 1}`,
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: SOURCE_SHA,
          candidateCycle: 1,
          reviewedAt: "2026-09-03T12:00:00.000Z",
        }],
      })),
      integration: { branch: `qa/${candidateId}`, sha: INTEGRATION_SHA },
      checks: [{
        id: `check_${candidateId}`,
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: INTEGRATION_SHA,
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: `http://127.0.0.1:4393/${candidateId}`,
        status: "healthy",
        commitSha: INTEGRATION_SHA,
        verifiedAt: "2026-09-03T12:05:00.000Z",
        attestation: { kind: "json", key: "commitSha", observedSha: INTEGRATION_SHA },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: taskIds,
        includedTaskIds: taskIds,
        excludedTaskIds: [],
      },
    },
    createdAt: "2026-09-03T12:05:00.000Z",
  });
}

function fixtureState() {
  const definitions = [
    { candidateId: "candidate_single", bundleId: "qa_bundle_single", taskIds: ["task_single"] },
    { candidateId: "candidate_multi", bundleId: "qa_bundle_multi", taskIds: ["task_multi_1", "task_multi_2"] },
  ];
  const candidates = definitions.map(candidateFixture);
  const state = {
    meta: {},
    projects: [{
      id: "project_1",
      key: "demo",
      name: "Demo",
      repoPath: "/private/demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      workflowMode: "github",
    }],
    tasks: definitions.flatMap((definition) => definition.taskIds.map((taskId) => {
      const candidate = candidates.find((item) => item.id === definition.candidateId);
      return {
        id: taskId,
        projectId: "project_1",
        title: `Review ${taskId}`,
        status: "qa_review",
        assignedAgentRole: "owner",
        stateVersion: 1,
        reviewCycle: 1,
        reviewSubjectSha: SOURCE_SHA,
        reviewSubjectCycle: 1,
        integrationStatus: "ready",
        integrationBranch: candidate.manifest.integration.branch,
        integrationCommit: INTEGRATION_SHA,
        candidateManifestDigest: candidate.manifestDigest,
        candidateId: candidate.id,
        qaBundleId: definition.bundleId,
      };
    })),
    comments: [],
    events: [],
    reviews: [],
    runs: [],
    qaBundles: definitions.map((definition) => {
      const candidate = candidates.find((item) => item.id === definition.candidateId);
      return {
        id: definition.bundleId,
        projectId: "project_1",
        candidateId: candidate.id,
        manifestDigest: candidate.manifestDigest,
        integrationBranch: candidate.manifest.integration.branch,
        integrationCommit: INTEGRATION_SHA,
        previewUrl: candidate.manifest.preview.url,
        status: "ready",
        updatedAt: "2026-09-03T12:05:00.000Z",
        tasks: definition.taskIds.map((taskId) => ({ id: taskId, title: `Review ${taskId}` })),
      };
    }),
    candidates,
  };
  for (const candidate of candidates) {
    const bundle = state.qaBundles.find((item) => item.id === candidate.qaBundleId);
    candidate.qaPacket = buildOwnerQaPacket(state, candidate, {
      bundle,
      generatedAt: "2026-09-03T12:05:00.000Z",
    });
    bundle.qaPacket = candidate.qaPacket;
    bundle.packetDigest = candidate.qaPacket.packetDigest;
  }
  return state;
}

function decisionArgs(coordinates, notes) {
  return [
    "--candidate", coordinates.candidateId,
    "--manifest-digest", coordinates.manifestDigest,
    "--integration-sha", coordinates.integrationSha,
    "--owner-qa-packet-digest", coordinates.ownerQaPacketDigest,
    "--body", notes,
  ];
}

test("QA CLI acts on bundle rows atomically and preserves positional task decisions", async () => {
  const state = fixtureState();
  await writeState(state);
  const coordinates = qaDecisionCoordinatesForState(state);
  const cliPath = path.resolve("src/mission-control-cli.js");
  const common = { cwd: process.cwd(), env: process.env };

  const help = await run(process.execPath, [cliPath, "help"], common);
  assert.match(help.stdout, /qa-pass TASK_ID\|--bundle BUNDLE_ID/);
  assert.match(help.stdout, /qa-fail --bundle qa_bundle_ID --candidate candidate_ID/);

  await assert.rejects(
    run(process.execPath, [cliPath, "qa-fail", "--bundle="], common),
    /--bundle requires an exact QA bundle ID/,
  );

  await assert.rejects(
    run(process.execPath, [
      cliPath,
      "qa-fail",
      "task_multi_1",
      "--bundle",
      "qa_bundle_multi",
      ...decisionArgs({
        candidateId: "candidate_multi",
        manifestDigest: state.candidates[1].manifestDigest,
        integrationSha: INTEGRATION_SHA,
        ownerQaPacketDigest: coordinates.bundles.qa_bundle_multi,
      }, "Ambiguous selector must not apply."),
    ], common),
    /Choose exactly one QA decision selector/,
  );
  assert.equal((await readState()).candidates.find((item) => item.id === "candidate_multi").status, "frozen");

  const singleResult = await run(process.execPath, [
    cliPath,
    "qa-fail",
    "task_single",
    ...decisionArgs({
      candidateId: "candidate_single",
      manifestDigest: state.candidates[0].manifestDigest,
      integrationSha: INTEGRATION_SHA,
      ownerQaPacketDigest: coordinates.tasks.task_single,
    }, "Single-task QA still uses the positional selector."),
  ], common);
  assert.match(singleResult.stdout, /candidate_single: QA failed\. Status now qa_failed\./);

  const bundleResult = await run(process.execPath, [
    cliPath,
    "qa-fail",
    "--bundle",
    "qa_bundle_multi",
    ...decisionArgs({
      candidateId: "candidate_multi",
      manifestDigest: state.candidates[1].manifestDigest,
      integrationSha: INTEGRATION_SHA,
      ownerQaPacketDigest: coordinates.bundles.qa_bundle_multi,
    }, "The complete bundle needs changes."),
  ], common);
  assert.match(bundleResult.stdout, /candidate_multi: QA failed\. Status now qa_failed\./);

  const persisted = await readState();
  assert.equal(persisted.tasks.find((item) => item.id === "task_single").status, "needs_changes");
  assert.deepEqual(
    persisted.tasks.filter((item) => item.id.startsWith("task_multi_")).map((item) => item.status),
    ["needs_changes", "needs_changes"],
  );
  assert.equal(persisted.candidates.find((item) => item.id === "candidate_multi").status, "qa_failed");
  assert.equal(persisted.qaBundles.find((item) => item.id === "qa_bundle_multi").status, "failed");
  assert.equal(persisted.comments.filter((comment) => comment.body.includes("The complete bundle needs changes.")).length, 2);
});
