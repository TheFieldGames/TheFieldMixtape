import { Router } from "express";

import { requireAuth } from "../src/auth.js";
import { log } from "../src/logger.js";

/**
 * The "who's editing" deck bar's backend — see src/editLock.js for the
 * actual lock semantics. Polled by public/lock-bar.js on every page that
 * has lock-gated controls (currently the queue page and the tracks page).
 */
export function createLockRouter(lockStore) {
  const router = Router();

  router.get("/lock/status", requireAuth, (req, res) => {
    res.json(lockStore.getLockState(req.session.sessionId));
  });

  router.post("/lock/acquire", requireAuth, (req, res) => {
    const result = lockStore.acquireLock(req.session.sessionId, req.session.displayName);
    if (result.ok) log(`Lock acquired by "${req.session.displayName}"`);
    res.json(result);
  });

  router.post("/lock/release", requireAuth, (req, res) => {
    lockStore.releaseLock(req.session.sessionId);
    log(`Lock released by "${req.session.displayName}"`);
    res.json({ ok: true });
  });

  router.post("/lock/heartbeat", requireAuth, (req, res) => {
    const touched = lockStore.touchActivity(req.session.sessionId);
    res.json({ ok: touched });
  });

  return router;
}
