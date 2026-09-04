import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_VALIDATION_FAILURE_EXCERPT_CHARS,
  MAX_VALIDATION_PASS_SUMMARY_CHARS,
  boundedValidationTranscript,
  executeValidationCommand,
  redactValidationOutput,
} from "../src/run-output-evidence.js";

test("validation transcripts are redacted and bounded by outcome", () => {
  const secret = "github_pat_test_secret_123456789";
  assert.doesNotMatch(redactValidationOutput(`token=${secret} bearer abcdefghijklmnop`, {
    GITHUB_TOKEN: secret,
  }), new RegExp(secret));
  assert.ok(boundedValidationTranscript("p".repeat(20_000), "passed").length <= MAX_VALIDATION_PASS_SUMMARY_CHARS);
  assert.ok(boundedValidationTranscript("f".repeat(20_000), "failed").length <= MAX_VALIDATION_FAILURE_EXCERPT_CHARS);
});
test("validation helper writes exact, private, redacted evidence artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-validation-evidence-"));
  try {
    const artifactPath = path.join(root, "command.log");
    const evidencePath = path.join(root, "candidate.evidence.tmp");
    await writeFile(evidencePath, "schema_version=1\n", { mode: 0o600 });
    const secret = "github_pat_validation_secret_123456789";
    const result = await executeValidationCommand({
      command: "printf '%s\\n' \"$GITHUB_TOKEN\"; printf 'finished\\n'",
      cwd: root,
      env: { ...process.env, GITHUB_TOKEN: secret },
      artifactRoot: root,
      artifactPath,
      evidencePath,
      label: "validation-1",
      commandIndex: 1,
      commandDigest: "sha256:command",
      environmentContractDigest: "sha256:environment",
      sourceSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      manifestDigest: "sha256:manifest",
      selectedComponentsDigest: "sha256:components",
      candidateCycle: 3,
    });
    assert.equal(result.outcome, "passed");
    assert.match(result.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await lstat(artifactPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(artifactPath, "utf8"), new RegExp(secret));
    const evidence = await readFile(evidencePath, "utf8");
    assert.match(evidence, /command_1_candidate_cycle=3/);
    assert.match(evidence, /command_1_source_sha=a{40}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
