import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  requireAuth,
  verifyPassword,
  sanitizeDisplayName,
  handleLogin,
  handleDemoLogin,
  handleLogout,
} from "../src/auth.js";
import { createLockStore } from "../src/editLock.js";

function fakeRes() {
  const res = {
    statusCode: 200,
    redirectedTo: null,
    rendered: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    redirect(path) {
      this.redirectedTo = path;
      return this;
    },
    render(view, locals) {
      this.rendered = { view, locals };
      return this;
    },
  };
  return res;
}

test("requireAuth calls next() when the session is authenticated", () => {
  const req = { session: { authenticated: true } };
  let nextCalled = false;
  requireAuth(req, fakeRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("requireAuth redirects to /login when not authenticated", () => {
  const req = { session: {} };
  const res = fakeRes();
  requireAuth(req, res, () => assert.fail("next() should not be called"));
  assert.equal(res.redirectedTo, "/login");
});

test("requireAuth redirects to /login when there is no session at all", () => {
  const req = {};
  const res = fakeRes();
  requireAuth(req, res, () => assert.fail("next() should not be called"));
  assert.equal(res.redirectedTo, "/login");
});

test("sanitizeDisplayName trims, rejects empty/whitespace-only names, caps length", () => {
  assert.equal(sanitizeDisplayName("  Rob  "), "Rob");
  assert.throws(() => sanitizeDisplayName(""), /required/);
  assert.throws(() => sanitizeDisplayName("   "), /required/);
  assert.throws(() => sanitizeDisplayName(undefined), /required/);
  assert.equal(sanitizeDisplayName("x".repeat(500)).length, 100);
});

test("verifyPassword correctly validates against a real bcrypt hash", async () => {
  const hash = await bcrypt.hash("correct-horse-battery-staple", 10);
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("verifyPassword throws a clear error when APP_PASSWORD_HASH isn't configured", async () => {
  await assert.rejects(verifyPassword("anything", undefined), /not configured/);
  await assert.rejects(verifyPassword("anything", ""), /not configured/);
});

test("handleLogin: correct password + name sets session and redirects to /", async () => {
  const hash = await bcrypt.hash("shared-secret", 10);
  const prev = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = hash;
  try {
    const req = { body: { password: "shared-secret", name: "  Alex  " }, session: {} };
    const res = fakeRes();
    await handleLogin(req, res, { log: () => {} });
    assert.equal(req.session.authenticated, true);
    assert.equal(req.session.displayName, "Alex");
    assert.equal(res.redirectedTo, "/");
  } finally {
    process.env.APP_PASSWORD_HASH = prev;
  }
});

test("handleLogin calls notifyLogin with the display name and admin status on success, and never on failure", async () => {
  const hash = await bcrypt.hash("shared-secret", 10);
  const prev = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = hash;
  try {
    const calls = [];
    const notifyLogin = (args) => calls.push(args);

    await handleLogin(
      { body: { password: "shared-secret", name: "Alex" }, session: {} },
      fakeRes(),
      { log: () => {}, notifyLogin }
    );
    assert.deepEqual(calls, [{ displayName: "Alex", isAdmin: false }]);

    await handleLogin(
      { body: { password: "wrong", name: "Alex" }, session: {} },
      fakeRes(),
      { log: () => {}, notifyLogin }
    );
    assert.equal(calls.length, 1, "a failed login must never trigger a notification");
  } finally {
    process.env.APP_PASSWORD_HASH = prev;
  }
});

test("handleLogin: wrong password renders 401 with an error, does not set session", async () => {
  const hash = await bcrypt.hash("shared-secret", 10);
  const prev = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = hash;
  try {
    const req = { body: { password: "wrong", name: "Alex" }, session: {} };
    const res = fakeRes();
    await handleLogin(req, res, { log: () => {} });
    assert.equal(req.session.authenticated, undefined);
    assert.equal(res.statusCode, 401);
    assert.equal(res.rendered.view, "login");
    assert.match(res.rendered.locals.error, /Incorrect password/);
  } finally {
    process.env.APP_PASSWORD_HASH = prev;
  }
});

test("handleLogin: missing display name renders 400 without ever checking the password", async () => {
  const req = { body: { password: "shared-secret", name: "" }, session: {} };
  const res = fakeRes();
  await handleLogin(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.rendered.locals.error, /required/);
  assert.equal(req.session.authenticated, undefined);
});

test("handleLogin: ADMIN_PASSWORD_HASH also logs in, and flags the session as admin", async () => {
  const appHash = await bcrypt.hash("shared-secret", 10);
  const adminHash = await bcrypt.hash("itsme", 10);
  const prevApp = process.env.APP_PASSWORD_HASH;
  const prevAdmin = process.env.ADMIN_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = appHash;
  process.env.ADMIN_PASSWORD_HASH = adminHash;
  try {
    const req = { body: { password: "itsme", name: "Rob" }, session: {} };
    await handleLogin(req, fakeRes(), { log: () => {} });
    assert.equal(req.session.authenticated, true);
    assert.equal(req.session.isAdmin, true);
  } finally {
    process.env.APP_PASSWORD_HASH = prevApp;
    process.env.ADMIN_PASSWORD_HASH = prevAdmin;
  }
});

test("handleLogin: the regular shared password logs in without the admin flag", async () => {
  const appHash = await bcrypt.hash("shared-secret", 10);
  const adminHash = await bcrypt.hash("itsme", 10);
  const prevApp = process.env.APP_PASSWORD_HASH;
  const prevAdmin = process.env.ADMIN_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = appHash;
  process.env.ADMIN_PASSWORD_HASH = adminHash;
  try {
    const req = { body: { password: "shared-secret", name: "Alex" }, session: {} };
    await handleLogin(req, fakeRes(), { log: () => {} });
    assert.equal(req.session.authenticated, true);
    assert.equal(req.session.isAdmin, false);
    assert.equal(typeof req.session.sessionId, "string");
    assert.ok(req.session.sessionId.length > 0);
  } finally {
    process.env.APP_PASSWORD_HASH = prevApp;
    process.env.ADMIN_PASSWORD_HASH = prevAdmin;
  }
});

test("handleLogin: admin password is rejected when ADMIN_PASSWORD_HASH isn't configured at all", async () => {
  const appHash = await bcrypt.hash("shared-secret", 10);
  const prevApp = process.env.APP_PASSWORD_HASH;
  const prevAdmin = process.env.ADMIN_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = appHash;
  delete process.env.ADMIN_PASSWORD_HASH;
  try {
    const req = { body: { password: "itsme", name: "Rob" }, session: {} };
    const res = fakeRes();
    await handleLogin(req, res, { log: () => {} });
    assert.equal(req.session.authenticated, undefined);
    assert.equal(res.statusCode, 401);
  } finally {
    process.env.APP_PASSWORD_HASH = prevApp;
    process.env.ADMIN_PASSWORD_HASH = prevAdmin;
  }
});

test("handleLogin: the regular shared password logs in with isDemo explicitly false", async () => {
  const appHash = await bcrypt.hash("shared-secret", 10);
  const prevApp = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = appHash;
  try {
    const req = { body: { password: "shared-secret", name: "Alex" }, session: {} };
    await handleLogin(req, fakeRes(), { log: () => {} });
    assert.equal(req.session.authenticated, true);
    assert.equal(req.session.isDemo, false);
  } finally {
    process.env.APP_PASSWORD_HASH = prevApp;
  }
});

test("handleDemoLogin: no password needed — logs straight in as a demo session named Demo", () => {
  const req = { session: {} };
  const res = fakeRes();
  handleDemoLogin(req, res, { log: () => {} });
  assert.equal(req.session.authenticated, true);
  assert.equal(req.session.displayName, "Demo");
  assert.equal(req.session.isDemo, true);
  assert.equal(req.session.isAdmin, false);
  assert.equal(res.redirectedTo, "/");
});

test("handleDemoLogin: gives each session a distinct sessionId, same as a real login", () => {
  const reqA = { session: {} };
  const reqB = { session: {} };
  handleDemoLogin(reqA, fakeRes(), { log: () => {} });
  handleDemoLogin(reqB, fakeRes(), { log: () => {} });
  assert.notEqual(reqA.session.sessionId, reqB.session.sessionId);
});

test("handleDemoLogin logs a success line noting [demo]", () => {
  const logLines = [];
  handleDemoLogin({ session: {} }, fakeRes(), { log: (...args) => logLines.push(args.join(" ")) });
  assert.ok(logLines.some((l) => l.includes("succeeded") && l.includes("Demo") && l.includes("[demo]")));
});

test("handleDemoLogin calls notifyLogin with displayName Demo and isDemo true", () => {
  const calls = [];
  handleDemoLogin({ session: {} }, fakeRes(), { log: () => {}, notifyLogin: (args) => calls.push(args) });
  assert.deepEqual(calls, [{ displayName: "Demo", isDemo: true }]);
});

test("handleLogout clears the session and redirects to /login", () => {
  const req = { session: { authenticated: true, displayName: "Alex" } };
  const res = fakeRes();
  handleLogout(req, res, { log: () => {} });
  assert.equal(req.session, null);
  assert.equal(res.redirectedTo, "/login");
});

test("handleLogin logs a success line naming who logged in", async () => {
  const hash = await bcrypt.hash("shared-secret", 10);
  const prev = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = hash;
  const logLines = [];
  try {
    const req = { body: { password: "shared-secret", name: "Alex" }, session: {} };
    await handleLogin(req, fakeRes(), { log: (...args) => logLines.push(args.join(" ")) });
  } finally {
    process.env.APP_PASSWORD_HASH = prev;
  }
  assert.ok(logLines.some((l) => l.includes("succeeded") && l.includes("Alex")));
});

test("handleLogin logs a failure line on wrong password, but NEVER logs the password itself", async () => {
  const hash = await bcrypt.hash("shared-secret", 10);
  const prev = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = hash;
  const logLines = [];
  const attemptedPassword = "totally-wrong-guess-xyz";
  try {
    const req = { body: { password: attemptedPassword, name: "Alex" }, session: {} };
    await handleLogin(req, fakeRes(), { log: (...args) => logLines.push(args.join(" ")) });
  } finally {
    process.env.APP_PASSWORD_HASH = prev;
  }
  assert.ok(logLines.some((l) => l.includes("failed")));
  assert.ok(!logLines.some((l) => l.includes(attemptedPassword)), "the attempted password must never appear in logs");
});

test("handleLogout logs who logged out", () => {
  const req = { session: { authenticated: true, displayName: "Alex" } };
  const logLines = [];
  handleLogout(req, fakeRes(), { log: (...args) => logLines.push(args.join(" ")) });
  assert.ok(logLines.some((l) => l.includes("Alex")));
});

test("handleLogout releases the edit lock if the logging-out session holds it", () => {
  const lockStore = createLockStore();
  lockStore.acquireLock("session-1", "Rob");
  assert.equal(lockStore.getLockState("session-1").state, "you");

  const req = { session: { authenticated: true, displayName: "Rob", sessionId: "session-1" } };
  handleLogout(req, fakeRes(), { log: () => {}, lockStore });

  assert.equal(lockStore.getLockState("anyone-else").state, "idle");
});

test("handleLogout does not release a lock held by someone else's session", () => {
  const lockStore = createLockStore();
  lockStore.acquireLock("session-other", "Dan");

  const req = { session: { authenticated: true, displayName: "Rob", sessionId: "session-1" } };
  handleLogout(req, fakeRes(), { log: () => {}, lockStore });

  assert.equal(lockStore.getLockState("session-other").state, "you");
});

test("handleLogout without a lockStore (or without a sessionId) still clears the session and doesn't throw", () => {
  const req = { session: { authenticated: true, displayName: "Alex" } };
  assert.doesNotThrow(() => handleLogout(req, fakeRes(), { log: () => {} }));
});

test("handleLogin: two separate logins get distinct sessionId values — the edit lock depends on this to tell two browser sessions apart even if they share a display name", async () => {
  const appHash = await bcrypt.hash("shared-secret", 10);
  const prevApp = process.env.APP_PASSWORD_HASH;
  process.env.APP_PASSWORD_HASH = appHash;
  try {
    const reqA = { body: { password: "shared-secret", name: "Rob" }, session: {} };
    const reqB = { body: { password: "shared-secret", name: "Rob" }, session: {} };
    await handleLogin(reqA, fakeRes(), { log: () => {} });
    await handleLogin(reqB, fakeRes(), { log: () => {} });
    assert.notEqual(reqA.session.sessionId, reqB.session.sessionId);
  } finally {
    process.env.APP_PASSWORD_HASH = prevApp;
  }
});
