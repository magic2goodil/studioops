import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { maintenanceWriteBlocker } from "../src/state-database.js";
import { environmentForTestControlRoot } from "../scripts/test-environment.js";
import { createCandidateEnvelope, manifestDigest } from "../src/candidate-manifest.js";
import { readPersistedState } from "./state-database-helper.js";

const execFileAsync = promisify(execFile);
const storeModuleUrl = pathToFileURL(path.join(process.cwd(), "src/store.js")).href;
const candidateManifestModuleUrl = pathToFileURL(path.join(process.cwd(), "src/candidate-manifest.js")).href;

test("maintenance lease blocks non-owner writes until it expires", () => {
  const state = {
    meta: {
      selfUpdateLease: {
        id: "lease_1",
        ownerPid: "100",
        expiresAt: "2026-07-22T22:00:00.000Z",
      },
    },
  };
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "200",
  })?.id, "lease_1");
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T21:00:00.000Z"),
    ownerPid: "100",
  }), null);
  assert.equal(maintenanceWriteBlocker(state, {
    nowMs: Date.parse("2026-07-22T22:00:01.000Z"),
    ownerPid: "200",
  }), null);
});

function baseState() {
  return {
    meta: { source: "legacy" },
    projects: [{ id: "project_1", key: "demo", name: "Demo" }],
    tasks: [{ id: "task_1", projectId: "project_1", title: "Persist me", status: "ready" }],
    comments: [],
    reviews: [],
    events: [],
    runs: [],
    qaBundles: [],
  };
}

async function writeLegacyState(root, state = baseState()) {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "mission-control.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runStoreScript(root, source) {
  const env = await environmentForTestControlRoot(root);
  return execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    timeout: 30_000,
  });
}

test("SQLite migrates legacy state once and protects persisted PII at rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-migration-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { readState } from ${JSON.stringify(storeModuleUrl)};
      const state = await readState();
      console.log(JSON.stringify(state));
    `);

    const state = readPersistedState(root);
    assert.equal(state.projects[0].key, "demo");
    assert.equal(state.tasks[0].title, "Persist me");
    assert.equal(state.meta.storageBackend, "sqlite");
    assert.match(state.meta.migratedFrom, /mission-control\.json$/);

    const dataMode = (await stat(path.join(root, "data"))).mode & 0o777;
    const databaseMode = (await stat(path.join(root, "data", "mission-control.sqlite3"))).mode & 0o777;
    const legacyMode = (await stat(path.join(root, "data", "mission-control.json"))).mode & 0o777;
    assert.equal(dataMode, 0o700);
    assert.equal(databaseMode, 0o600);
    assert.equal(legacyMode, 0o600);

    const backupPath = path.join(root, "backups", "snapshot.sqlite3");
    await runStoreScript(root, `
      import { backupStateDatabase } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/state-database.js")).href)};
      await backupStateDatabase(${JSON.stringify(backupPath)});
    `);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent worker processes serialize updates without dropping comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-concurrency-"));
  try {
    await writeLegacyState(root);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);
    await Promise.all(Array.from({ length: 6 }, (_, index) => runStoreScript(root, `
      import { addComment } from ${JSON.stringify(storeModuleUrl)};
      await addComment("task_1", "worker-${index}", "Concurrency test");
    `)));

    const state = readPersistedState(root);
    const bodies = state.comments.map((comment) => comment.body).sort();
    assert.deepEqual(bodies, ["worker-0", "worker-1", "worker-2", "worker-3", "worker-4", "worker-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite rejects mutation of a frozen candidate manifest and rolls back atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-candidate-immutability-"));
  const sourceSha = "a".repeat(40);
  const integrationSha = "b".repeat(40);
  const candidate = createCandidateEnvelope({
    createdAt: "2026-07-25T12:00:00.000Z",
    manifest: {
      candidateId: "candidate_immutable",
      projectId: "project_1",
      base: { branch: "main", sha: "c".repeat(40) },
      sources: [{
        taskId: "task_1",
        sourceRef: "refs/heads/codex/task-1",
        headSha: sourceSha,
        candidateCycle: 1,
        reviews: [{
          id: "review_1",
          stageKey: "lead",
          role: "lead-reviewer",
          outcome: "approved",
          subjectSha: sourceSha,
          candidateCycle: 1,
          reviewedAt: "2026-07-25T11:00:00.000Z",
        }],
      }],
      integration: { branch: "qa/candidate-immutable", sha: integrationSha },
      checks: [{
        id: "check_1",
        kind: "local-validation",
        name: "npm test",
        outcome: "passed",
        subjectSha: integrationSha,
        evidenceDigest: `sha256:${"d".repeat(64)}`,
      }],
      preview: {
        url: "http://127.0.0.1:4174/",
        status: "healthy",
        commitSha: integrationSha,
        verifiedAt: "2026-07-25T12:00:00.000Z",
        attestation: {
          kind: "header",
          key: "x-studioops-commit",
          observedSha: integrationSha,
        },
      },
      assembly: {
        mode: "atomic",
        requestedTaskIds: ["task_1"],
        includedTaskIds: ["task_1"],
        excludedTaskIds: [],
      },
    },
  });

  try {
    await writeLegacyState(root);
    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.candidates.push(${JSON.stringify(candidate)});
      });
    `);

    const altered = structuredClone(candidate);
    altered.manifest.base.sha = "e".repeat(40);
    altered.manifestDigest = manifestDigest(altered.manifest);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0] = ${JSON.stringify(altered)};
        });
      `),
      /manifest is immutable/,
    );

    const persisted = readPersistedState(root);
    assert.equal(persisted.candidates[0].manifest.base.sha, candidate.manifest.base.sha);
    assert.equal(persisted.candidates[0].manifestDigest, candidate.manifestDigest);

    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates = [];
        });
      `),
      /cannot be deleted/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates = [];
        await writeState(state);
      `),
      /cannot be deleted/,
    );

    const qaDecision = {
      outcome: "passed",
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      integrationSha,
      taskIds: ["task_1"],
      author: "Owner QA",
      notes: "",
      repositoryVerifiedAt: "2026-07-25T12:29:59.000Z",
      decidedAt: "2026-07-25T12:30:00.000Z",
    };
    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.candidates[0].qaDecision = ${JSON.stringify(qaDecision)};
        state.candidates[0].status = "qa_passed";
      });
    `);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].qaDecision = {
            ...state.candidates[0].qaDecision,
            notes: "rewritten"
          };
        });
      `),
      /qaDecision record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates[0].qaDecision = {
          ...state.candidates[0].qaDecision,
          author: "replacement"
        };
        await writeState(state);
      `),
      /qaDecision record is append-only/,
    );

    const promotion = {
      branch: "qa/promotion-demo",
      prUrl: "https://github.com/example/demo/pull/1",
      commitSha: integrationSha,
      manifestDigest: candidate.manifestDigest,
      readyAt: "2026-07-25T13:00:00.000Z",
    };
    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        state.candidates[0].promotion = ${JSON.stringify(promotion)};
        state.candidates[0].status = "release_candidate_ready";
      });
    `);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].promotion = {
            ...state.candidates[0].promotion,
            prUrl: "https://github.com/example/demo/pull/2"
          };
        });
      `),
      /promotion record is append-only/,
    );
    await assert.rejects(
      () => runStoreScript(root, `
        import { readState, writeState } from ${JSON.stringify(storeModuleUrl)};
        const state = await readState();
        state.candidates[0].promotion = {
          ...state.candidates[0].promotion,
          branch: "qa/replaced"
        };
        await writeState(state);
      `),
      /promotion record is append-only/,
    );

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      import { invalidateCandidate } from ${JSON.stringify(candidateManifestModuleUrl)};
      await mutateState((state) => {
        invalidateCandidate(state.candidates[0], {
          reason: "Source drift.",
          expected: "${sourceSha}",
          observed: "${"f".repeat(40)}"
        });
      });
    `);
    await assert.rejects(
      () => runStoreScript(root, `
        import { mutateState } from ${JSON.stringify(storeModuleUrl)};
        await mutateState((state) => {
          state.candidates[0].invalidation = null;
          state.candidates[0].status = "frozen";
        });
      `),
      /invalidation record is append-only/,
    );
    const invalidated = readPersistedState(root).candidates[0];
    assert.equal(invalidated.status, "invalidated");
    assert.equal(invalidated.invalidation.reason, "Source drift.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite import removes orphaned and cross-project QA bundle references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-integrity-"));
  try {
    const state = baseState();
    state.projects.push({ id: "project_2", key: "other", name: "Other" });
    state.tasks[0].qaBundleId = "qa_bundle_1";
    state.tasks.push({
      id: "task_2",
      projectId: "project_2",
      title: "Valid QA task",
      status: "qa_review",
      qaBundleId: "qa_bundle_1",
    });
    state.qaBundles.push({
      id: "qa_bundle_1",
      projectId: "project_2",
      status: "ready",
      tasks: [
        { id: "task_1", title: "Wrong project" },
        { id: "task_2", title: "Valid QA task" },
      ],
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks.find((task) => task.id === "task_1").qaBundleId, undefined);
    assert.equal(persisted.tasks.find((task) => task.id === "task_2").qaBundleId, "qa_bundle_1");
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.qaBundles[0].legacyStatus, "ready");
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite migration reconstructs bundles for previously integrated QA tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-sqlite-bundle-backfill-"));
  try {
    const state = baseState();
    state.projects[0].repoUrl = "git@github.com:example/demo.git";
    state.projects[0].localQaPreview = {
      checkoutPath: "/tmp/demo-qa",
      previewUrl: "http://127.0.0.1:4174/",
    };
    Object.assign(state.tasks[0], {
      status: "qa_review",
      qaBundleId: "qa_bundle_99",
      localQaPreview: {
        status: "current",
        branch: "qa/demo",
        after: "abc123",
        checkoutPath: "/tmp/demo-qa",
      },
    });
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.qaBundles.length, 1);
    assert.equal(persisted.qaBundles[0].projectId, "project_1");
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.qaBundles[0].previewUrl, "http://127.0.0.1:4174/");
    assert.equal(persisted.qaBundles[0].integrationBranchUrl, "https://github.com/example/demo/tree/qa/demo");
    assert.equal(persisted.tasks[0].qaBundleId, persisted.qaBundles[0].id);
    assert.deepEqual(persisted.qaBundles[0].tasks.map((task) => task.id), ["task_1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy QA bundles remain visible but cannot authorize a new QA decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-qa-ineligible-"));
  try {
    const state = baseState();
    state.tasks[0].status = "qa_review";
    state.tasks[0].qaBundleId = "qa_bundle_legacy";
    state.qaBundles.push({
      id: "qa_bundle_legacy",
      projectId: "project_1",
      status: "ready",
      tasks: [{ id: "task_1", title: state.tasks[0].title }],
    });
    await writeLegacyState(root, state);

    await assert.rejects(
      () => runStoreScript(root, `
        import { recordQaBundleDecision } from ${JSON.stringify(storeModuleUrl)};
        await recordQaBundleDecision("qa_bundle_legacy", {
          outcome: "passed",
          author: "Owner QA",
          candidateId: "candidate_missing",
          manifestDigest: "sha256:${"a".repeat(64)}",
          integrationSha: "${"b".repeat(40)}"
        });
      `),
      /legacy and has no immutable candidate/,
    );
    const persisted = readPersistedState(root);
    assert.equal(persisted.qaBundles[0].status, "legacy_untrusted");
    assert.equal(persisted.tasks[0].status, "qa_review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy task-level QA approvals remain visible but are not promotion authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-legacy-task-approval-"));
  try {
    const state = baseState();
    state.tasks[0].status = "approved_for_main";
    state.tasks[0].promotionStatus = "queued";
    state.tasks[0].qaDecision = {
      outcome: "passed",
      author: "Legacy owner",
      decidedAt: "2026-07-24T12:00:00.000Z",
    };
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    const persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].status, "legacy_untrusted");
    assert.equal(persisted.tasks[0].legacyStatus, "approved_for_main");
    assert.equal(persisted.tasks[0].legacyQaDecisionUntrusted, true);
    assert.equal(persisted.tasks[0].promotionStatus, "");
    assert.match(persisted.tasks[0].integrityBlocker, /immutable candidate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite archives excess machine QA history without compacting human comments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-history-compaction-"));
  try {
    const state = baseState();
    const machineComments = Array.from({ length: 30 }, (_, index) => ({
      id: `comment_${index + 1}`,
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: `QA integration blocked report ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    }));
    state.comments = [...machineComments];
    state.comments.splice(5, 0, {
      id: "comment_human",
      taskId: "task_1",
      author: "Mission Control QA Integration",
      body: "QA integration is a name I used for this human decision.",
      createdAt: "2026-07-01T00:05:30.000Z",
    });
    state.events = Array.from({ length: 50 }, (_, index) => ({
      id: `event_${index + 1}`,
      type: "qa_integration_blocked",
      projectId: "project_1",
      taskId: "task_1",
      message: `Blocked ${index + 1}`,
      createdAt: index < machineComments.length
        ? machineComments[index].createdAt
        : new Date(Date.UTC(2026, 6, 1, 1, index)).toISOString(),
    }));
    await writeLegacyState(root, state);
    await runStoreScript(root, `import { readState } from ${JSON.stringify(storeModuleUrl)}; await readState();`);

    let persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human").length, 20);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);

    const backupPath = persisted.meta.operationalArchive.backupPath;
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare("SELECT count(*) count FROM comments").get().count, 31);
      assert.equal(backupDb.prepare("SELECT count(*) count FROM events").get().count, 50);
    } finally {
      backupDb.close();
    }

    await runStoreScript(root, `
      import { mutateState } from ${JSON.stringify(storeModuleUrl)};
      await mutateState((state) => {
        for (let index = 1; index <= 5; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 6, 2, 0, index)).toISOString();
          state.comments.push({
            id: \`comment_new_\${index}\`,
            taskId: "task_1",
            author: "StudioOps QA Integration",
            systemGenerated: true,
            kind: "qa_integration",
            body: \`QA integration blocked new report \${index}\`,
            createdAt,
          });
          state.events.push({
            id: \`event_new_\${index}\`,
            type: "qa_integration_blocked",
            projectId: "project_1",
            taskId: "task_1",
            message: \`New blocked report \${index}\`,
            createdAt,
          });
        }
      });
    `);
    persisted = readPersistedState(root);
    assert.equal(persisted.comments.filter((item) => item.id !== "comment_human").length, 20);
    assert.equal(persisted.comments.filter((item) => item.id === "comment_human").length, 1);
    assert.equal(persisted.events.filter((item) => item.type === "qa_integration_blocked").length, 40);

    const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
    try {
      const archived = db.prepare("SELECT entity_type, count(*) count FROM operational_archive GROUP BY entity_type ORDER BY entity_type")
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(archived, [
        { entity_type: "comments", count: 15 },
        { entity_type: "events", count: 15 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
