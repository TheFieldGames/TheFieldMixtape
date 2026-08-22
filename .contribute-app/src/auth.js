import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { log as logDefault } from "./logger.js";

/** Express middleware: gates every route except /login behind the session flag set at login. */
export function requireAuth(req, res, next) {
  if (req.session?.authenticated) {
    return next();
  }
  return res.redirect("/login");
}

export async function verifyPassword(password, passwordHash) {
  if (!passwordHash) {
    throw new Error("APP_PASSWORD_HASH is not configured");
  }
  return bcrypt.compare(password, passwordHash);
}

/** Lightweight attribution, not real auth: trimmed, required, length-capped. */
export function sanitizeDisplayName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    throw new Error("Display name is required");
  }
  return trimmed.slice(0, 100);
}

// ADMIN_PASSWORD_HASH is optional (unlike APP_PASSWORD_HASH) — a second,
// separate password that also logs a user in, but additionally flags the
// session as admin (currently just: unlocks the Dry Run option in the UI,
// server-enforced too, not just hidden). Deliberately not required config:
// deployments that don't set it simply never have an admin path, rather
// than failing to boot.
async function verifyAdminPassword(password) {
  if (!process.env.ADMIN_PASSWORD_HASH) return false;
  return bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
}

// Never logs the submitted password itself, only that an attempt happened
// and whether it succeeded — this is a shared password, so a failed
// attempt is worth seeing in the terminal, but the value never should be.
export async function handleLogin(req, res, { log = logDefault } = {}) {
  const { password, name } = req.body ?? {};
  try {
    const displayName = sanitizeDisplayName(name);
    const pw = password || "";
    const isAdmin = await verifyAdminPassword(pw);
    const ok = isAdmin || (await verifyPassword(pw, process.env.APP_PASSWORD_HASH));
    if (!ok) {
      log(`Login failed (wrong password) for name "${displayName}"`);
      return res.status(401).render("login", { error: "Incorrect password" });
    }
    req.session.authenticated = true;
    req.session.displayName = displayName;
    req.session.isAdmin = isAdmin;
    req.session.isDemo = false;
    // A real per-login identity, distinct from displayName (free text,
    // never verified unique) — this is what the edit lock actually checks
    // "do you hold it" against, so two different browser sessions typing
    // the same display name can never be confused for one another.
    req.session.sessionId = crypto.randomUUID();
    log(`Login succeeded: "${displayName}"${isAdmin ? " [admin]" : ""}`);
    return res.redirect("/");
  } catch (err) {
    log(`Login attempt rejected: ${err.message}`);
    return res.status(400).render("login", { error: err.message });
  }
}

// No password at all, by design — a one-click "show me the app" path.
// Skips straight to a session flagged isDemo, which forces every publish
// from it into dry-run (see routes/tracks.js's POST /tracks/publish) and
// is visibly marked "demo" in the UI (public/lock-bar.js, views/tracks.ejs)
// so a real editor can tell a demo session apart from a real one. Display
// name is always "Demo" — there's nothing to attribute, since it can never
// actually publish.
export function handleDemoLogin(req, res, { log = logDefault } = {}) {
  req.session.authenticated = true;
  req.session.displayName = "Demo";
  req.session.isAdmin = false;
  req.session.isDemo = true;
  req.session.sessionId = crypto.randomUUID();
  log(`Login succeeded: "Demo" [demo]`);
  return res.redirect("/");
}

export function handleLogout(req, res, { log = logDefault, lockStore } = {}) {
  log(`Logout: "${req.session?.displayName}"`);
  // Otherwise the lock stays held by a sessionId no session can ever match
  // again — not even the same person logging back in, since login mints a
  // fresh sessionId — leaving it stuck until the 5-minute idle auto-expiry.
  if (lockStore && req.session?.sessionId) {
    lockStore.releaseLock(req.session.sessionId);
  }
  req.session = null;
  res.redirect("/login");
}
