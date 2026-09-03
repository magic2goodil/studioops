import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  boundedHeadTail,
  persistPromotionValidationEvidence,
  promotionValidationPolicyDigest,
  scrubProjectRepositoryCredentials,
} from "../src/promotion-validation-evidence.js";

const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const INTEGRATION_SHA = "b".repeat(40);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("private promotion evidence preserves complete redacted output with verified permissions and digest", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-evidence-"));
  const root = path.join(temporary, "private-evidence", "promotion-validation");
  const head = "HEAD-SENTINEL";
  const middle = "MIDDLE-SENTINEL";
  const tail = "TAIL-SENTINEL";
  const genericSecret = "generic-command-secret";
  const outputSecret = "generic-output-secret";
  const output = `${head}\n${"x".repeat(5_000)}\n${middle}\n${"y".repeat(5_000)}\npassword=${outputSecret}\n${tail}`;
  const policyDigest = promotionValidationPolicyDigest({
    commands: ["npm run check"],
    timeoutMs: 600_000,
  });

  try {
    const evidence = await persistPromotionValidationEvidence({
      root,
      candidateId: "candidate_123",
      manifestDigest: MANIFEST_DIGEST,
      integrationSha: INTEGRATION_SHA,
      attempt: 2,
      policyDigest,
      createdAt: "2026-09-03T16:00:00.000Z",
      idFactory: () => "fixed-evidence-id",
      commands: [{
        command: `TOKEN=${genericSecret} npm run check`,
        ok: false,
        output,
      }],
    });
    const stored = await readFile(evidence.path);
    const text = stored.toString("utf8");
    const rootInfo = await stat(root);
    const fileInfo = await stat(evidence.path);

    assert.equal(rootInfo.mode & 0o777, 0o700);
    assert.equal(fileInfo.mode & 0o777, 0o600);
    assert.equal(evidence.digest, sha256(stored));
    assert.equal(evidence.bytes, stored.length);
    assert.equal(evidence.commandCount, 1);
    assert.equal(evidence.createdAt, "2026-09-03T16:00:00.000Z");
    assert.match(evidence.path, /candidate_123-attempt-2-fixed-evidence-id\.json$/);
    assert.match(text, new RegExp(head));
    assert.match(text, new RegExp(middle));
    assert.match(text, new RegExp(tail));
    assert.match(text, /TOKEN=\[REDACTED\]/);
    assert.match(text, /password=\[REDACTED\]/);
    assert.equal(text.includes(genericSecret), false);
    assert.equal(text.includes(outputSecret), false);
    assert.equal(JSON.stringify(evidence).includes(head), false);
    assert.equal(JSON.stringify(evidence).includes(middle), false);
    assert.equal(JSON.stringify(evidence).includes(tail), false);

    await assert.rejects(
      persistPromotionValidationEvidence({
        root,
        candidateId: "candidate_123",
        manifestDigest: MANIFEST_DIGEST,
        integrationSha: INTEGRATION_SHA,
        attempt: 2,
        policyDigest,
        createdAt: "2026-09-03T16:01:00.000Z",
        idFactory: () => "fixed-evidence-id",
        commands: [{ command: "npm test", ok: true, output: "replacement" }],
      }),
      /destination already exists/,
    );
    assert.deepEqual(await readFile(evidence.path), stored);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("promotion evidence persistence fails closed when its private root cannot be created", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "studioops-promotion-evidence-failure-"));
  const root = path.join(temporary, "not-a-directory");
  await writeFile(root, "occupied\n", { mode: 0o600 });
  try {
    await assert.rejects(
      persistPromotionValidationEvidence({
        root,
        candidateId: "candidate_123",
        manifestDigest: MANIFEST_DIGEST,
        integrationSha: INTEGRATION_SHA,
        attempt: 1,
        policyDigest: promotionValidationPolicyDigest({ commands: [], timeoutMs: 0 }),
        commands: [],
      }),
      /EEXIST|ENOTDIR|real directory/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("repository credential scrubbing covers every managed key family without removing safe markers", () => {
  const denied = [
    "GH_TOKEN",
    "gh_enterprise_token",
    "GITHUB_TOKEN",
    "GIT_ASKPASS",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "git_config_value_0",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_TERMINAL_PROMPT",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "MISSION_CONTROL_GITHUB_TOKEN",
    "MISSION_CONTROL_GITHUB_APP_ROLE",
    "MISSION_CONTROL_GIT_USERNAME",
    "STUDIOOPS_GITHUB_PRIVATE_KEY",
    "GITHUB_APP_ID",
    "GITHUB_AUTH_TOKEN",
    "GITHUB_INSTALLATION_ID",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_TOKEN_SECONDARY",
  ];
  const source = Object.fromEntries(denied.map((key) => [key, `secret-for-${key}`]));
  source.SAFE_VALIDATION_MARKER = "preserved";
  source.PATH = "/usr/bin:/bin";

  const scrubbed = scrubProjectRepositoryCredentials(source);

  for (const key of denied) assert.equal(Object.hasOwn(scrubbed, key), false, key);
  assert.equal(scrubbed.SAFE_VALIDATION_MARKER, "preserved");
  assert.equal(scrubbed.PATH, "/usr/bin:/bin");
  assert.equal(source.GH_TOKEN, "secret-for-GH_TOKEN");
});

test("bounded head-tail output handles zero, negative, small, and normal limits deterministically", () => {
  assert.equal(boundedHeadTail("abcdef", 0), "");
  assert.equal(boundedHeadTail("abcdef", -5), "");
  assert.equal(boundedHeadTail("abcdef", 3), "abf");
  assert.equal(boundedHeadTail("abc", 10), "abc");
  const bounded = boundedHeadTail(`START-${"x".repeat(100)}-END`, 40);
  assert.equal(bounded.length, 40);
  assert.match(bounded, /^START/);
  assert.match(bounded, /\.\.\.\[truncated\]\.\.\./);
  assert.match(bounded, /END$/);
});

test("promotion validation policy digests are deterministic and bind command order, timeout, and environment policy", () => {
  const input = {
    commands: ["npm run check", "git diff --check"],
    timeoutMs: 600_000,
  };
  const first = promotionValidationPolicyDigest(input);
  assert.equal(first, promotionValidationPolicyDigest({ ...input }));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first, promotionValidationPolicyDigest({ ...input, commands: [...input.commands].reverse() }));
  assert.notEqual(first, promotionValidationPolicyDigest({ ...input, timeoutMs: 600_001 }));
  assert.notEqual(first, promotionValidationPolicyDigest({ ...input, environmentPolicyVersion: "v2" }));
});
