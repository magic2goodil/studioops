import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runnerModuleUrl = pathToFileURL(path.join(process.cwd(), "src/runner.js")).href;

test("runner sweep reaps stale running runs before checking capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-runner-reap-"));

  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "mission-control.json"), `${JSON.stringify({
      meta: {},
      projects: [
        {
          id: "project_1",
          key: "demo",
          name: "Demo",
          repoPath: root,
        },
      ],
      tasks: [
        {
          id: "task_1",
          projectId: "project_1",
          title: "Stale task",
          status: "in_progress",
        },
      ],
      runs: [
        {
          id: "run_1",
          taskId: "task_1",
          projectId: "project_1",
          actionType: "start_builder",
          group: "builder",
          role: "builder",
          status: "running",
          startedAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          runnerPid: "99999999",
        },
      ],
      comments: [],
      events: [],
      reviews: [],
    }, null, 2)}\n`, "utf8");

    const script = `
      import { claimRuns } from ${JSON.stringify(runnerModuleUrl)};
      const claimed = await claimRuns({ runTimeoutMs: 1 });
      console.log(JSON.stringify(claimed));
    `;
    const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    assert.deepEqual(JSON.parse(result.stdout.trim()), []);

    const state = JSON.parse(await readFile(path.join(root, "data", "mission-control.json"), "utf8"));
    assert.equal(state.runs[0].status, "failed");
    assert.equal(state.runs[0].exitCode, "stale_runner_pid");
    assert.match(state.runs[0].notes, /reaped stale run/);
    assert.equal(state.comments.length, 1);
    assert.equal(state.events[0].type, "run_reaped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
