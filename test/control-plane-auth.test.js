import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneAuth } from "../src/control-plane-auth.js";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-control-auth-"));
  let nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  const auth = createControlPlaneAuth({
    authDir: path.join(root, "auth"),
    operatorLogPath: path.join(root, "logs", "operator.log"),
    scryptCost: 1024,
    clock: () => nowMs,
    ...options,
  });
  const initialization = await auth.initialize();
  const log = await readFile(initialization.operatorLogPath, "utf8");
  const bootstrapSecret = log.match(/single use\): ([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(bootstrapSecret);
  return {
    root,
    auth,
    bootstrapSecret,
    advance(milliseconds) { nowMs += milliseconds; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("first-run enrollment writes only owner-restricted secrets and consumes bootstrap once", async () => {
  const item = await fixture();
  try {
    assert.equal((await stat(path.join(item.root, "auth"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(item.root, "logs", "operator.log"))).mode & 0o777, 0o600);

    const enrolled = await item.auth.enroll({
      bootstrapSecret: item.bootstrapSecret,
      password: "correct horse battery staple",
      displayName: "Studio Owner",
    });
    assert.equal(enrolled.owner.displayName, "Studio Owner");
    assert.equal(enrolled.recoveryCodes.length, 8);
    assert.match(enrolled.cookie, /HttpOnly/);
    assert.match(enrolled.cookie, /SameSite=Strict/);
    assert.equal((await stat(path.join(item.root, "auth", "owner.json"))).mode & 0o777, 0o600);
    const stored = await readFile(path.join(item.root, "auth", "owner.json"), "utf8");
    assert.doesNotMatch(stored, /correct horse battery staple/);
    assert.doesNotMatch(stored, new RegExp(item.bootstrapSecret));
    for (const code of enrolled.recoveryCodes) assert.doesNotMatch(stored, new RegExp(code));

    await assert.rejects(
      () => item.auth.enroll({ bootstrapSecret: item.bootstrapSecret, password: "another acceptable password" }),
      (error) => error.status === 409 && error.code === "owner_already_enrolled",
    );
  } finally {
    await item.cleanup();
  }
});

test("sessions are bounded, idle-expiring, CSRF-protected, and absent after restart", async () => {
  const item = await fixture({ maxSessions: 2, sessionIdleMs: 1_000, sessionTtlMs: 10_000 });
  try {
    await item.auth.enroll({ bootstrapSecret: item.bootstrapSecret, password: "correct horse battery staple" });
    const first = await item.auth.login({ password: "correct horse battery staple" });
    await item.auth.login({ password: "correct horse battery staple" });
    assert.equal(item.auth.sessionCount(), 2);
    const headers = { cookie: first.cookie.split(";", 1)[0] };
    const context = item.auth.authenticateRequest(headers);
    assert.throws(() => item.auth.verifyCsrf(context, "wrong"), (error) => error.status === 403);
    item.auth.verifyCsrf(context, first.csrfToken);
    item.advance(1_001);
    assert.throws(() => item.auth.authenticateRequest(headers), (error) => error.status === 401);

    const restarted = createControlPlaneAuth({
      authDir: path.join(item.root, "auth"),
      operatorLogPath: path.join(item.root, "logs", "operator.log"),
      scryptCost: 1024,
    });
    await restarted.initialize();
    assert.throws(() => restarted.authenticateRequest(headers), (error) => error.status === 401);
    const loggedIn = await restarted.login({ password: "correct horse battery staple" });
    assert.equal(restarted.authenticateRequest({ cookie: loggedIn.cookie.split(";", 1)[0] }).actor.role, "owner");
  } finally {
    await item.cleanup();
  }
});

test("login throttling, password rotation, and single-use recovery revoke old sessions", async () => {
  const item = await fixture({ throttleLimit: 2 });
  try {
    const enrolled = await item.auth.enroll({ bootstrapSecret: item.bootstrapSecret, password: "correct horse battery staple" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(() => item.auth.login({ password: "wrong password", remoteAddress: "127.0.0.9" }), (error) => error.status === 401);
    }
    await assert.rejects(() => item.auth.login({ password: "correct horse battery staple", remoteAddress: "127.0.0.9" }), (error) => error.status === 429);

    const originalContext = item.auth.authenticateRequest({ cookie: enrolled.cookie.split(";", 1)[0] });
    const rotated = await item.auth.rotatePassword(originalContext, {
      currentPassword: "correct horse battery staple",
      newPassword: "a newer and stronger owner password",
      remoteAddress: "127.0.0.1",
    });
    assert.throws(() => item.auth.authenticateRequest({ cookie: enrolled.cookie.split(";", 1)[0] }), (error) => error.status === 401);
    await assert.rejects(() => item.auth.login({ password: "correct horse battery staple", remoteAddress: "127.0.0.2" }), (error) => error.status === 401);

    const recovered = await item.auth.recover({
      recoveryCode: rotated.recoveryCodes[0],
      newPassword: "recovered owner password is strong",
      remoteAddress: "127.0.0.3",
    });
    assert.throws(() => item.auth.authenticateRequest({ cookie: rotated.cookie.split(";", 1)[0] }), (error) => error.status === 401);
    assert.equal(item.auth.authenticateRequest({ cookie: recovered.cookie.split(";", 1)[0] }).actor.role, "owner");
    await assert.rejects(() => item.auth.recover({
      recoveryCode: rotated.recoveryCodes[0],
      newPassword: "another recovered owner password",
      remoteAddress: "127.0.0.4",
    }), (error) => error.status === 401);
  } finally {
    await item.cleanup();
  }
});

test("reauthentication grants expire in two minutes and are single-use and subject-bound", async () => {
  const item = await fixture({ reauthTtlMs: 120_000 });
  try {
    const enrolled = await item.auth.enroll({ bootstrapSecret: item.bootstrapSecret, password: "correct horse battery staple" });
    const context = item.auth.authenticateRequest({ cookie: enrolled.cookie.split(";", 1)[0] });
    const binding = { action: "lifecycle:owner_override", aggregateId: "task_1", aggregateVersion: 7, candidateIdentity: { sha: "a".repeat(40) } };
    const first = await item.auth.createReauthenticationGrant(context, { ...binding, password: "correct horse battery staple" });
    assert.equal(item.auth.consumeReauthenticationGrant(context, first.grant, binding), true);
    assert.throws(() => item.auth.consumeReauthenticationGrant(context, first.grant, binding), (error) => error.status === 428);

    const mismatched = await item.auth.createReauthenticationGrant(context, { ...binding, password: "correct horse battery staple" });
    assert.throws(() => item.auth.consumeReauthenticationGrant(context, mismatched.grant, { ...binding, aggregateVersion: 8 }), (error) => error.status === 428);
    assert.throws(() => item.auth.consumeReauthenticationGrant(context, mismatched.grant, binding), (error) => error.status === 428);

    const expired = await item.auth.createReauthenticationGrant(context, { ...binding, password: "correct horse battery staple" });
    item.advance(120_001);
    assert.throws(() => item.auth.consumeReauthenticationGrant(context, expired.grant, binding), (error) => error.status === 428);
  } finally {
    await item.cleanup();
  }
});

test("service tokens authorize only their explicit capabilities", async () => {
  const item = await fixture({
    serviceCapabilities: [{
      token: "service-token-with-at-least-thirty-two-characters",
      capabilities: ["state:read"],
      actor: { id: "review-bot", type: "worker", role: "backend-reviewer", runId: "run_1", leaseId: "lease_1" },
    }],
  });
  try {
    const context = item.auth.authenticateRequest({ authorization: "Bearer service-token-with-at-least-thirty-two-characters" });
    item.auth.authorize(context, "state:read");
    assert.throws(() => item.auth.authorize(context, "tasks:write"), (error) => error.status === 403);
    assert.equal(context.actor.runId, "run_1");
    assert.throws(() => item.auth.authenticateRequest({ authorization: "Bearer invalid" }), (error) => error.status === 401);
  } finally {
    await item.cleanup();
  }
});
