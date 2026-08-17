import assert from "node:assert/strict";
import test from "node:test";
import { resolveQaIntegrationOptions } from "../src/qa-integration-options.js";

test("QA integration entrypoints share configured defaults", () => {
  const options = resolveQaIntegrationOptions({}, {
    defaults: {
      qaIntegration: {
        githubAppAuth: true,
        githubAppFallbackToLocalAuth: true,
        githubAppCredentialsDir: "/local/credentials",
      },
    },
  });

  assert.equal(options.githubAppAuth, true);
  assert.equal(options.githubAppFallbackToLocalAuth, true);
  assert.equal(options.githubAppCredentialsDir, "/local/credentials");
});

test("explicit QA authentication flags override configured defaults", () => {
  const disabled = resolveQaIntegrationOptions({
    "no-github-app-auth": true,
    "no-github-app-local-fallback": true,
  }, {
    qaIntegration: {
      githubAppAuth: true,
      githubAppFallbackToLocalAuth: true,
    },
  });
  assert.equal(disabled.githubAppAuth, false);
  assert.equal(disabled.githubAppFallbackToLocalAuth, false);

  const enabled = resolveQaIntegrationOptions({
    "github-app-auth": true,
    "github-app-local-fallback": true,
  }, {
    qaIntegration: {
      githubAppAuth: false,
      githubAppFallbackToLocalAuth: false,
    },
  });
  assert.equal(enabled.githubAppAuth, true);
  assert.equal(enabled.githubAppFallbackToLocalAuth, true);
});

test("project filters and partial candidate authority remain explicit", () => {
  const options = resolveQaIntegrationOptions({
    project: "event-horizons-web",
    task: "task_621",
    "partial-tasks": "task_621",
    "partial-actor-id": "release-owner",
    "partial-reason-code": "independent_repair",
    force: true,
  }, {});

  assert.equal(options.project, "event-horizons-web");
  assert.equal(options.task, "task_621");
  assert.equal(options.partialTasks, "task_621");
  assert.equal(options.partialActorId, "release-owner");
  assert.equal(options.partialReasonCode, "independent_repair");
  assert.equal(options.force, true);
});
