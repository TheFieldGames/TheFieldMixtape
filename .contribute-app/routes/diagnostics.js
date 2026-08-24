import { Router } from "express";

import { requireAuth } from "../src/auth.js";
import { checkThunderstoreConnectivity } from "../src/diagnostics.js";
import { log } from "../src/logger.js";

/**
 * Read-only, no lock required (mirrors the read-only track list) —
 * temporary diagnostic for the "publishes are committing to git but never
 * reaching Thunderstore" investigation. Logs the full result server-side
 * (visible in Render's logs) in addition to returning it, since the log is
 * what's actually needed here, not the JSON response.
 */
export function createDiagnosticsRouter() {
  const router = Router();

  router.get("/diag/thunderstore", requireAuth, async (req, res) => {
    const result = await checkThunderstoreConnectivity();
    log(`[diag] Thunderstore connectivity check: ${JSON.stringify(result)}`);
    res.json(result);
  });

  return router;
}
