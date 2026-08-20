import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addReviewedQaTask,
  advanceReviewedQaTask,
  createProtectedBranchFixture,
  git,
  runQaIntegrationFixture,
} from "./helpers/qa-integration-fixture.js";
import { qaIntegrationScenarios } from "./helpers/qa-integration-scenarios.js";
import { readPersistedState } from "./state-database-helper.js";

const scenario = qaIntegrationScenarios(import.meta.url);

scenario("protected QA branches use one idempotent integration PR and advance only after policy merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const pendingProject = pending.projects[0];
    const pendingTask = pendingProject.tasks[0];

    assert.equal(pendingProject.status, "pr_waiting", JSON.stringify(pendingProject, null, 2));
    assert.equal(pendingTask.status, "pr_waiting");
    assert.equal(pendingProject.protectedBranchFallback, true);
    assert.match(pendingProject.integrationCandidateBranch, /^studioops\/qa-candidate\/demo-[0-9a-f]{12}$/);
    assert.equal(pendingProject.integrationCandidateCommit, pendingProject.commit);
    assert.equal(pendingProject.integrationPr.url, "https://github.com/example/demo/pull/42");
    assert.equal(pendingProject.integrationCheckState.state, "pending");
    assert.match(pendingProject.integrationBlocker, /required human review/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", "refs/heads/qa/integration"]),
      fixture.baseSha,
    );
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", `refs/heads/${pendingProject.integrationCandidateBranch}`]),
      pendingProject.commit,
    );

    let persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationCandidateCommit, pendingProject.commit);
    assert.equal(persisted.tasks[0].integrationPrUrl, pendingProject.integrationPr.url);
    assert.equal(persisted.tasks[0].integrationCheckState.state, "pending");
    assert.match(persisted.tasks[0].integrationBlocker, /required human review/);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);

    const failed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "failed",
        FAKE_GH_REVIEW_DECISION: "",
      },
    });
    assert.equal(failed.projects[0].status, "checks_failed");
    assert.equal(failed.projects[0].commit, pendingProject.commit);
    assert.equal(failed.projects[0].integrationCandidateBranch, pendingProject.integrationCandidateBranch);
    assert.equal(failed.projects[0].integrationCheckState.failed, 1);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);

    const checksPassed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    assert.equal(checksPassed.projects[0].status, "pr_waiting");
    assert.equal(checksPassed.projects[0].integrationCheckState.state, "passed");
    assert.match(checksPassed.projects[0].integrationBlocker, /required human review/);

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${pendingProject.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "integration-merge",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    const mergeCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, [
      "push",
      "origin",
      "HEAD:refs/heads/qa/integration",
    ]);
    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: mergeCommit,
      },
    });

    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, mergeCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, mergeCommit);
    assert.match(merged.projects[0].output, /Source commits were not merged or pushed again/);
    assert.match(merged.projects[0].integrationCandidateCleanup, /Removed merged integration-candidate branch/);
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${pendingProject.integrationCandidateBranch}`]),
      "",
    );
    persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationPrUrl, "https://github.com/example/demo/pull/42");
    assert.equal(persisted.tasks[0].integrationCandidateCommit, pendingProject.commit);
    assert.equal(persisted.tasks[0].integrationCommit, mergeCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.notEqual(persisted.tasks[0].integrationStatus, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("merged protected QA handoff validates a squash result without repushing source commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-squash-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${project.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "integration-squash",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--squash", "FETCH_HEAD"]);
    await git(fixture.repoPath, ["commit", "-m", "squash QA candidate"]);
    const squashCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await assert.rejects(
      git(fixture.repoPath, ["merge-base", "--is-ancestor", project.integrationCandidateCommit, squashCommit]),
    );
    await git(fixture.repoPath, ["push", "origin", "HEAD:refs/heads/qa/integration"]);

    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: squashCommit,
      },
    });

    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, squashCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, squashCommit);
    assert.match(merged.projects[0].output, /Source commits were not merged or pushed again/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", "refs/heads/qa/integration"]),
      squashCommit,
    );
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${project.integrationCandidateBranch}`]),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("new QA tasks wait behind an existing protected integration handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-serialized-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await git(fixture.repoPath, ["checkout", "-b", "feature/task-2", "main"]);
    await writeFile(path.join(fixture.repoPath, "feature-2.txt"), "later QA feature\n", "utf8");
    await git(fixture.repoPath, ["add", "feature-2.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "later feature"]);
    const secondHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task-2"]);
    await addReviewedQaTask(root, {
      id: "task_2",
      projectId: "project_1",
      title: "Later feature task",
      status: "qa_review",
      branchName: "feature/task-2",
      prUrl: "",
    }, secondHead);

    const repeated = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: fixture.env,
    });

    assert.equal(repeated.projects[0].status, "pr_waiting");
    assert.deepEqual(repeated.projects[0].tasks.map((task) => task.taskId), ["task_1"]);
    assert.deepEqual(repeated.projects[0].deferredTaskIds, ["task_2"]);
    assert.equal(repeated.projects[0].integrationCandidateBranch, project.integrationCandidateBranch);
    assert.equal(repeated.projects[0].integrationCandidateCommit, project.integrationCandidateCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(
      (await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", "refs/heads/studioops/qa-candidate"])).split("\n").filter(Boolean).length,
      1,
    );

    const persisted = readPersistedState(root);
    const laterTask = persisted.tasks.find((task) => task.id === "task_2");
    assert.equal(laterTask.integrationCandidateBranch || "", "");
    assert.equal(laterTask.integrationPrUrl || "", "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("failed protected handoffs are audited and safely replaced after new source review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-replacement-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const previous = pending.projects[0];

    const failed = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_CHECK_STATE: "failed",
        FAKE_GH_REVIEW_DECISION: "",
      },
    });
    assert.equal(failed.projects[0].status, "checks_failed");
    let persisted = readPersistedState(root);
    assert.equal(persisted.tasks[0].integrationStatus, "blocked");
    assert.equal(persisted.tasks[0].integrationValidation.status, "checks_failed");
    assert.equal(persisted.tasks[0].integrationSourceHeadSha, persisted.tasks[0].reviewSubjectSha);
    assert.equal(persisted.tasks[0].integrationSourceCandidateCycle, 1);

    await git(fixture.repoPath, ["checkout", "feature/task"]);
    await writeFile(path.join(fixture.repoPath, "feature.txt"), "corrected protected QA feature\n", "utf8");
    await git(fixture.repoPath, ["commit", "-am", "correct protected feature"]);
    const correctedHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task"]);
    await advanceReviewedQaTask(root, "task_1", correctedHead);

    await git(fixture.repoPath, ["checkout", "-b", "feature/task-2", "main"]);
    await writeFile(path.join(fixture.repoPath, "feature-2.txt"), "later reviewed feature\n", "utf8");
    await git(fixture.repoPath, ["add", "feature-2.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "later reviewed feature"]);
    const secondHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "feature/task-2"]);
    await addReviewedQaTask(root, {
      id: "task_2",
      projectId: "project_1",
      title: "Later feature task",
      status: "qa_review",
      branchName: "feature/task-2",
      prUrl: "",
    }, secondHead);

    const replacement = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_FAILED_PR_NUMBER: "42",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    const replacementProject = replacement.projects[0];

    assert.equal(replacementProject.status, "pr_waiting", JSON.stringify(replacementProject, null, 2));
    assert.equal(replacementProject.integrationPr.url, "https://github.com/example/demo/pull/43");
    assert.notEqual(replacementProject.integrationCandidateCommit, previous.integrationCandidateCommit);
    assert.deepEqual(replacementProject.tasks.map((task) => task.taskId), ["task_1", "task_2"]);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
    assert.equal((await readFile(fixture.prCloseLog, "utf8")).trim(), "close 42");
    assert.equal(
      await git(fixture.remotePath, ["for-each-ref", "--format=%(refname)", `refs/heads/${previous.integrationCandidateBranch}`]),
      "",
    );

    persisted = readPersistedState(root);
    const correctedTask = persisted.tasks.find((task) => task.id === "task_1");
    const laterTask = persisted.tasks.find((task) => task.id === "task_2");
    assert.equal(correctedTask.integrationPrUrl, "https://github.com/example/demo/pull/43");
    assert.equal(correctedTask.integrationSourceHeadSha, correctedHead);
    assert.equal(correctedTask.integrationSourceCandidateCycle, 2);
    assert.equal(correctedTask.integrationHandoffHistory.length, 1);
    assert.equal(correctedTask.integrationHandoffHistory[0].candidateCommit, previous.integrationCandidateCommit);
    assert.equal(correctedTask.integrationHandoffHistory[0].prUrl, "https://github.com/example/demo/pull/42");
    assert.equal(correctedTask.integrationHandoffHistory[0].checkState.state, "failed");
    assert.match(correctedTask.integrationHandoffHistory[0].cleanup, /Removed superseded/);
    assert.equal(laterTask.integrationPrUrl, "https://github.com/example/demo/pull/43");
    assert.equal(laterTask.integrationHandoffHistory, undefined);

    const repeated = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_FAILED_PR_NUMBER: "42",
        FAKE_GH_REVIEW_DECISION: "REVIEW_REQUIRED",
      },
    });
    assert.equal(repeated.projects[0].status, "pr_waiting");
    assert.equal(repeated.projects[0].integrationPr.url, "https://github.com/example/demo/pull/43");
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
    assert.equal((await readFile(fixture.prCloseLog, "utf8")).trim(), "close 42");

    await rm(fixture.hookPath);
    await git(fixture.repoPath, [
      "fetch",
      "origin",
      `refs/heads/${replacementProject.integrationCandidateBranch}`,
    ]);
    await git(fixture.repoPath, [
      "checkout",
      "-B",
      "replacement-merge",
      "refs/remotes/origin/qa/integration",
    ]);
    await git(fixture.repoPath, ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    const mergeCommit = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", "HEAD:refs/heads/qa/integration"]);

    const merged = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: {
        ...fixture.env,
        FAKE_GH_PR_STATE: "MERGED",
        FAKE_GH_CHECK_STATE: "passed",
        FAKE_GH_REVIEW_DECISION: "APPROVED",
        FAKE_GH_MERGE_STATE: "CLEAN",
        FAKE_GH_MERGE_COMMIT: mergeCommit,
      },
    });
    assert.equal(merged.projects[0].status, "preview_missing");
    assert.equal(merged.projects[0].commit, mergeCommit);
    assert.equal(merged.projects[0].integrationMergeCommit, mergeCommit);
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario("protected QA handoff refuses changed candidate heads without force-pushing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-qa-protected-drift-"));

  try {
    const fixture = await createProtectedBranchFixture(root);
    const pending = await runQaIntegrationFixture(root, { env: fixture.env });
    const project = pending.projects[0];

    await git(fixture.repoPath, ["fetch", "origin", project.integrationCandidateBranch]);
    await git(fixture.repoPath, ["checkout", "-B", "tamper-candidate", "FETCH_HEAD"]);
    await writeFile(path.join(fixture.repoPath, "remote-change.txt"), "unexpected\n", "utf8");
    await git(fixture.repoPath, ["add", "remote-change.txt"]);
    await git(fixture.repoPath, ["commit", "-m", "unexpected candidate change"]);
    const changedHead = await git(fixture.repoPath, ["rev-parse", "HEAD"]);
    await git(fixture.repoPath, ["push", "origin", `HEAD:refs/heads/${project.integrationCandidateBranch}`]);

    const drift = await runQaIntegrationFixture(root, {
      input: { force: true },
      env: fixture.env,
    });
    assert.equal(drift.projects[0].status, "candidate_drift");
    assert.match(drift.projects[0].integrationBlocker, /will not overwrite/);
    assert.equal(
      await git(fixture.remotePath, ["rev-parse", `refs/heads/${project.integrationCandidateBranch}`]),
      changedHead,
    );
    assert.equal((await readFile(fixture.prCreateLog, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

scenario.assertComplete();
