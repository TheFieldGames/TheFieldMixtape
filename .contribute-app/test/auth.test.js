import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  requireAuth,
  verifyPassword,
  sanitizeDisplayName,
  handleLogin,
  handleLogout,
} from "../src/auth.js";

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
