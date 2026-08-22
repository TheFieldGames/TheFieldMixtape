import { test } from "node:test";
import assert from "node:assert/strict";
import { createLockStore, requireLock, touchOnStageChange, IDLE_TIMEOUT_MS } from "../src/editLock.js";

test("a fresh lock store starts idle for anyone", () => {
  const store = createLockStore();
  assert.deepEqual(store.getLockState("session-a"), { state: "idle" });
});

test("acquireLock succeeds when idle, and getLockState reports 'you' for that session", () => {
  const store = createLockStore();
  const now = 1000;
  const result = store.acquireLock("session-a", "Alex", now);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.getLockState("session-a", now), { state: "you", acquiredAt: now, lastActivityAt: now });
});

test("getLockState reports 'other' (with the holder's display name, no session id leaked) for a different session", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  assert.deepEqual(store.getLockState("session-b", 1500), { state: "other", displayName: "Alex", acquiredAt: 1000 });
});

test("acquireLock refuses when someone else already holds it", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  const result = store.acquireLock("session-b", "Dan", 1500);
  assert.deepEqual(result, { ok: false, heldBy: "Alex" });
  // The original holder's state is unaffected by the failed attempt.
  assert.deepEqual(store.getLockState("session-a", 1500), { state: "you", acquiredAt: 1000, lastActivityAt: 1000 });
});

test("re-acquiring while already holding it is a no-op that preserves the original acquiredAt", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  const result = store.acquireLock("session-a", "Alex", 5000);
  assert.deepEqual(result, { ok: true });
  assert.equal(store.getLockState("session-a", 5000).acquiredAt, 1000, "acquiredAt (the elapsed-timer origin) shouldn't reset just from clicking Start again");
  assert.equal(store.getLockState("session-a", 5000).lastActivityAt, 5000, "but lastActivityAt (the idle timer) does refresh");
});

test("releaseLock by the actual holder clears the lock back to idle", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  store.releaseLock("session-a", 1500);
  assert.deepEqual(store.getLockState("session-a", 1500), { state: "idle" });
});

test("releaseLock by a non-holder (or when nothing is held) is a harmless no-op", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  const result = store.releaseLock("session-b", 1500);
  assert.deepEqual(result, { ok: true });
  // Alex's lock is untouched — session-b never held it, so it can't release it.
  assert.equal(store.getLockState("session-a", 1500).state, "you");
});

test("touchActivity by the real holder resets the idle clock and returns true", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  const touched = store.touchActivity("session-a", 2000);
  assert.equal(touched, true);
  assert.equal(store.getLockState("session-a", 2000).lastActivityAt, 2000);
});

test("touchActivity by a non-holder does nothing and returns false", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  const touched = store.touchActivity("session-b", 2000);
  assert.equal(touched, false);
  assert.equal(store.getLockState("session-a", 2000).lastActivityAt, 1000, "the real holder's activity timestamp is unaffected");
});

test("isHeldBy is true only for the actual current holder", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  assert.equal(store.isHeldBy("session-a", 1000), true);
  assert.equal(store.isHeldBy("session-b", 1000), false);
});

// --- Idle auto-expiry ---

test("the lock auto-expires after idleTimeoutMs of no activity, freeing it for anyone", () => {
  const store = createLockStore({ idleTimeoutMs: 1000 });
  store.acquireLock("session-a", "Alex", 0);
  assert.equal(store.getLockState("session-a", 999).state, "you", "not expired yet, just under the timeout");
  assert.equal(store.getLockState("session-a", 1001).state, "idle", "expired just past the timeout");
});

test("onExpire fires exactly once, with the expired lock's details, the moment expiry is actually detected", () => {
  const expiredEvents = [];
  const store = createLockStore({
    idleTimeoutMs: 1000,
    onExpire: (expired, now) => expiredEvents.push({ expired, now }),
  });
  store.acquireLock("session-a", "Alex", 0);
  store.getLockState("session-a", 500); // still active, no expiry yet
  assert.equal(expiredEvents.length, 0);

  store.getLockState("session-b", 1500); // first check past the deadline
  assert.equal(expiredEvents.length, 1);
  assert.deepEqual(expiredEvents[0].expired, { sessionId: "session-a", displayName: "Alex", acquiredAt: 0, lastActivityAt: 0 });
  assert.equal(expiredEvents[0].now, 1500);

  store.getLockState("session-b", 2000); // already expired — must not fire again
  assert.equal(expiredEvents.length, 1);
});

test("onExpire is optional — a lock store created without one just expires silently, no throw", () => {
  const store = createLockStore({ idleTimeoutMs: 1000 });
  store.acquireLock("session-a", "Alex", 0);
  assert.doesNotThrow(() => store.getLockState("session-a", 2000));
});

test("touchActivity extends the deadline, so a lock kept warm never expires", () => {
  const store = createLockStore({ idleTimeoutMs: 1000 });
  store.acquireLock("session-a", "Alex", 0);
  store.touchActivity("session-a", 900);
  assert.equal(store.getLockState("session-a", 1500).state, "you", "still under 1000ms since the touch at 900");
});

test("a different session can acquire the lock once it's expired", () => {
  const store = createLockStore({ idleTimeoutMs: 1000 });
  store.acquireLock("session-a", "Alex", 0);
  const result = store.acquireLock("session-b", "Dan", 2000);
  assert.deepEqual(result, { ok: true });
  assert.equal(store.getLockState("session-b", 2000).state, "you");
  assert.equal(store.getLockState("session-a", 2000).state, "other");
});

test("default idleTimeoutMs matches the exported IDLE_TIMEOUT_MS constant (5 minutes)", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 0);
  assert.equal(store.getLockState("session-a", IDLE_TIMEOUT_MS - 1).state, "you");
  assert.equal(store.getLockState("session-a", IDLE_TIMEOUT_MS + 1).state, "idle");
});

// --- requireLock middleware ---

function fakeReqRes(sessionId) {
  const req = { session: { sessionId } };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

test("requireLock calls next() and touches activity when the requester holds the lock", () => {
  const store = createLockStore();
  // No explicit `now` here — the middleware itself always uses real
  // Date.now() internally, so acquiring with a real timestamp keeps this
  // test consistent with what requireLock actually checks against.
  const acquiredAt = Date.now();
  store.acquireLock("session-a", "Alex");
  const middleware = requireLock(store);
  const { req, res } = fakeReqRes("session-a");
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.ok(store.getLockState("session-a").lastActivityAt >= acquiredAt);
});

test("requireLock responds 423 and never calls next() when the requester doesn't hold the lock", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex");
  const middleware = requireLock(store);
  const { req, res, getStatus, getJson } = fakeReqRes("session-b");
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(getStatus(), 423);
  assert.match(getJson().error, /Start editing/);
});

test("requireLock responds 423 when nobody holds the lock at all", () => {
  const store = createLockStore();
  const middleware = requireLock(store);
  const { req, res, getStatus } = fakeReqRes("session-a");
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(getStatus(), 423);
});

// --- Demo session flag ---

test("acquireLock's isDemo flag is omitted from getLockState('you') when false (default), matching the pre-demo shape exactly", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000);
  assert.deepEqual(store.getLockState("session-a", 1000), { state: "you", acquiredAt: 1000, lastActivityAt: 1000 });
});

test("acquireLock's isDemo flag surfaces in getLockState for both the holder ('you') and everyone else ('other')", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000, true);
  assert.deepEqual(store.getLockState("session-a", 1000), { state: "you", acquiredAt: 1000, lastActivityAt: 1000, isDemo: true });
  assert.deepEqual(store.getLockState("session-b", 1500), { state: "other", displayName: "Alex", acquiredAt: 1000, isDemo: true });
});

test("a non-demo acquire never reports isDemo, even to other viewers", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex", 1000, false);
  assert.deepEqual(store.getLockState("session-b", 1500), { state: "other", displayName: "Alex", acquiredAt: 1000 });
});

test("two independently-created lock stores never share state", () => {
  const storeA = createLockStore();
  const storeB = createLockStore();
  storeA.acquireLock("session-a", "Alex", 1000);
  assert.equal(storeA.getLockState("session-a", 1000).state, "you");
  assert.equal(storeB.getLockState("session-a", 1000).state, "idle");
});

// --- touchOnStageChange (keeps a long-running publish job's lock warm) ---

test("touchOnStageChange still calls the wrapped onStageChange with the stage name", () => {
  const store = createLockStore();
  store.acquireLock("session-a", "Alex");
  const seenStages = [];
  const wrapped = touchOnStageChange(store, "session-a", (stage) => seenStages.push(stage));

  wrapped("clone");
  wrapped("commit");

  assert.deepEqual(seenStages, ["clone", "commit"]);
});

test("touchOnStageChange refreshes the given session's idle timer on every call", () => {
  // No explicit `now` here, same as the existing requireLock test above —
  // touchActivity (and therefore touchOnStageChange, which just calls it)
  // always uses real Date.now() internally, so acquiring with a real
  // timestamp keeps this test consistent with what's actually checked.
  const store = createLockStore();
  const acquiredAt = Date.now();
  store.acquireLock("session-a", "Alex");
  const wrapped = touchOnStageChange(store, "session-a", () => {});

  wrapped("clone");

  assert.ok(store.getLockState("session-a").lastActivityAt >= acquiredAt);
});

test("touchOnStageChange keeps a lock alive across a simulated long-running publish spanning more than one idle window", (t) => {
  // Mocked Date so touchOnStageChange's internal Date.now()-based
  // touchActivity() calls are driven deterministically instead of racing
  // real wall-clock time.
  t.mock.timers.enable({ apis: ["Date"] });
  const idleTimeoutMs = 1000;
  const store = createLockStore({ idleTimeoutMs });
  store.acquireLock("session-a", "Alex"); // acquired at mocked t=0
  const wrapped = touchOnStageChange(store, "session-a", () => {});

  // Simulate stage transitions arriving every 400ms — each individually
  // well within the 1000ms idle window, but the job as a whole runs 1600ms
  // total, longer than a single idle window. Without per-stage refreshing,
  // this lock would have expired around t=1000.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(400);
    wrapped("some-stage");
  }

  assert.equal(store.getLockState("session-a").state, "you", "still held after 1600ms total thanks to per-stage refreshes, despite exceeding one idle window");
});

test("a lock with no further stage transitions still expires after a genuinely stuck/hung job", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const idleTimeoutMs = 1000;
  const store = createLockStore({ idleTimeoutMs });
  store.acquireLock("session-a", "Alex");
  // Wired up, same as a real publish job, but never invoked again past the
  // initial acquire — simulating a hung job with no further stage progress.
  touchOnStageChange(store, "session-a", () => {});

  t.mock.timers.tick(idleTimeoutMs + 1);

  assert.equal(store.getLockState("session-a").state, "idle", "a hung job with no stage progress must not hold the lock forever");
});

test("touchOnStageChange does nothing to the lock when the given session doesn't actually hold it", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = createLockStore();
  store.acquireLock("session-a", "Alex"); // acquired at mocked t=0
  const wrapped = touchOnStageChange(store, "session-b", () => {});

  t.mock.timers.tick(1000);
  wrapped("clone");

  assert.equal(store.getLockState("session-a").lastActivityAt, 0, "the real holder's activity is unaffected by a non-holder's stage transitions");
});
