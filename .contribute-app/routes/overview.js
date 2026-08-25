import { Router } from "express";

import { requireAuth } from "../src/auth.js";

/**
 * The "how this app works" page, linked from the tracklist's batch bar —
 * a guided tour for two very different audiences (hiring managers and
 * engineers) at once, rather than two separate pages to keep in sync.
 * Behind the same login as everything else (a demo session can reach it
 * exactly the way a real one can).
 */
export function createOverviewRouter() {
  const router = Router();

  router.get("/how-it-works", requireAuth, (req, res) => {
    res.render("how-it-works");
  });

  return router;
}
