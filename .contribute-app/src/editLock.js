// Single shared "who's editing" lock — covers every batch-mutating action
// across the whole app (queueing an add, queueing/undoing a delete,
// publishing), not a per-page or per-action lock. In-memory, matches the
// rest of the app's single-instance assumption (same one runExclusive
// already relies on) — this doesn't need to survive a restart.
//
// A factory rather than module-level singleton state, so tests can create
// isolated instances instead of sharing (and needing to reset) one global
// lock. The real app creates exactly one instance at startup (server.js)
// and passes it to whatever needs it.

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// How long before the idle cutoff the "still there?" warning should start
// showing — a UI concern, but the exact cutoff line is defined here since
// it's derived from IDLE_TIMEOUT_MS and both server and client need to
// agree on it (the client polls getLockState and computes its own
// countdown from the timestamps returned).
export const WARNING_BEFORE_MS = 30 * 1000;

// `onExpire` defaults to a no-op so tests (and any other caller that
// doesn't care) don't have to supply one. The real app wires the real
// logger in (server.js) — otherwise a lock timing out mid-session is
// completely silent server-side: nothing else ever observes the moment it
// happens, only that a later acquire/status call finds it already gone.
export function createLockStore({ idleTimeoutMs = IDLE_TIMEOUT_MS, onExpire = () => {} } = {}) {
  // { sessionId, displayName, acquiredAt, lastActivityAt } | null
  let lock = null;

  function expireIfNeeded(now) {
    if (lock && now - lock.lastActivityAt > idleTimeoutMs) {
      const expired = lock;
      lock = null;
      onExpire(expired, now);
    }
  }

  /** Scoped to the requesting session — "you" vs "other" is computed here,
   * not left for the caller to figure out, so there's exactly one place
   * that knows what "holding the lock" means. `isDemo` is only included in
   * the returned state when true, so callers/tests that never deal with
   * demo sessions see the exact same shape as before. */
  function getLockState(sessionId, now = Date.now()) {
    expireIfNeeded(now);
    if (!lock) return { state: "idle" };
    if (lock.sessionId === sessionId) {
      return {
        state: "you",
        acquiredAt: lock.acquiredAt,
        lastActivityAt: lock.lastActivityAt,
        ...(lock.isDemo ? { isDemo: true } : {}),
      };
    }
    return {
      state: "other",
      displayName: lock.displayName,
      acquiredAt: lock.acquiredAt,
      ...(lock.isDemo ? { isDemo: true } : {}),
    };
  }

  /** Explicit acquire ("Start editing") — refuses if someone else holds
   * it. Re-acquiring while already holding it is a harmless no-op that
   * preserves the original acquiredAt (doesn't reset your own elapsed
   * timer just because you clicked twice). `isDemo` records whether a demo
   * session is the one holding the lock, so other viewers' "X is
   * recording" text can say so too — see routes/lock.js. Kept as a 4th,
   * defaulted param (after `now`, not before) so every existing 2/3-arg
   * call site keeps working unchanged. */
  function acquireLock(sessionId, displayName, now = Date.now(), isDemo = false) {
    expireIfNeeded(now);
    if (lock && lock.sessionId !== sessionId) {
      return { ok: false, heldBy: lock.displayName };
    }
    const acquiredAt = lock && lock.sessionId === sessionId ? lock.acquiredAt : now;
    // isDemo is only stored on the internal lock object when true, so the
    // raw shape (e.g. as seen by onExpire below) is byte-for-byte identical
    // to before this flag existed for every non-demo acquire.
    lock = { sessionId, displayName, acquiredAt, lastActivityAt: now, ...(isDemo ? { isDemo: true } : {}) };
    return { ok: true };
  }

  /** Explicit release ("Stop editing"). Releasing when you don't hold it
   * (already expired, or never held) is a harmless no-op, not an error —
   * the button should always just work. */
  function releaseLock(sessionId, now = Date.now()) {
    expireIfNeeded(now);
    if (lock && lock.sessionId === sessionId) lock = null;
    return { ok: true };
  }

  /** Resets the idle timer — called both explicitly ("I'm still here")
   * and automatically whenever the holder performs a real mutating action
   * (see requireLock below). Returns false (does nothing) if the caller
   * doesn't actually hold the lock, so a stale/reused request can't revive
   * an expired or someone-else's lock. */
  function touchActivity(sessionId, now = Date.now()) {
    expireIfNeeded(now);
    if (lock && lock.sessionId === sessionId) {
      lock.lastActivityAt = now;
      return true;
    }
    return false;
  }

  function isHeldBy(sessionId, now = Date.now()) {
    expireIfNeeded(now);
    return !!lock && lock.sessionId === sessionId;
  }

  return { getLockState, acquireLock, releaseLock, touchActivity, isHeldBy };
}

/**
 * Express middleware enforcing the lock server-side — the UI disables
 * gated controls when you don't hold it, but that's convenience, not
 * security; a hand-crafted request must be rejected the same way. Also
 * extends the idle timer on every successful pass, since reaching this
 * middleware means the holder just did a real mutating action.
 */
export function requireLock(lockStore) {
  return (req, res, next) => {
    if (!lockStore.isHeldBy(req.session.sessionId)) {
      return res.status(423).json({ error: 'Press "Start editing" above before making changes.' });
    }
    lockStore.touchActivity(req.session.sessionId);
    next();
  };
}

/**
 * Wraps a processPublish `onStageChange` callback (see src/publish.js) so
 * every real stage transition also refreshes the given session's idle
 * timer, not just requireLock's single touch at request-entry above. A
 * real publish is kicked off as a background job (routes/tracks.js's POST
 * /tracks/publish) and takes 1-2 minutes, dominated by `tcli publish` —
 * well past that one initial touch. Without this, an editor who walks away
 * right after clicking Publish has no guarantee the lock survives
 * idle-expiry until the job actually finishes; it would just happen to
 * usually fit inside the idle window.
 *
 * Refreshing on every stage transition (rather than, say, a timer) means
 * the lock only actually expires mid-publish if the job is truly
 * stuck/hung for a full idle timeout with no stage progressing at all —
 * which is correct, desired behavior: a genuinely hung job shouldn't hold
 * the lock forever either.
 */
export function touchOnStageChange(lockStore, sessionId, onStageChange) {
  return (stage) => {
    onStageChange(stage);
    lockStore.touchActivity(sessionId);
  };
}
