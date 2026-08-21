import { Router } from "express";

import { requireAuth, sanitizeDisplayName } from "../src/auth.js";
import { runExclusive } from "../src/queue.js";
import { processDeletion } from "../src/publish.js";
import * as storage from "../src/storage.js";
import * as manifest from "../src/manifest.js";
import * as jobs from "../src/jobs.js";
import { segmentsFor } from "../src/stageWeights.js";
import { log, logError } from "../src/logger.js";

/** Sorts newest-first; tracks with no known addedAt (legacy/TEMP entries)
 * sort to the end, alphabetically among themselves. */
function sortTracks(rows) {
  return [...rows].sort((a, b) => {
    if (a.addedAt && b.addedAt) return b.addedAt.localeCompare(a.addedAt);
    if (a.addedAt) return -1;
    if (b.addedAt) return 1;
    return a.trackName.localeCompare(b.trackName);
  });
}

export function createTracksRouter(config) {
  const router = Router();

  router.get("/tracks", requireAuth, async (req, res) => {
    const isAdmin = req.session.isAdmin === true;
    try {
      const trackNames = await storage.listTracks(config.r2Client, config.r2Bucket);

      let manifestData = await manifest.getManifest(config.r2Client, config.r2Bucket);
      const missing = trackNames.some((name) => !(`${name}.ogg` in manifestData.tracks));
      if (missing) {
        manifestData = await manifest.backfillLegacyTracks(config.r2Client, config.r2Bucket, trackNames);
      }

      const rows = sortTracks(
        trackNames.map((trackName) => {
          const entry = manifestData.tracks[`${trackName}.ogg`];
          return {
            trackName,
            filename: `${trackName}.ogg`,
            addedBy: entry?.addedBy ?? manifest.LEGACY_ADDED_BY,
            addedAt: entry?.addedAt ?? null,
          };
        })
      );

      const progressSegments = { real: segmentsFor("delete"), dryRun: segmentsFor("delete", { dryRun: true }) };
      res.render("tracks", { displayName: req.session.displayName, isAdmin, rows, error: null, progressSegments });
    } catch (err) {
      logError("Failed to load the track list:", err.message);
      const progressSegments = { real: segmentsFor("delete"), dryRun: segmentsFor("delete", { dryRun: true }) };
      res.status(500).render("tracks", { displayName: req.session.displayName, isAdmin, rows: [], error: "Couldn't load the track list right now — try again shortly.", progressSegments });
    }
  });

  // Same async-job pattern as POST /submit — see routes/jobs.js.
  router.post("/tracks/delete", requireAuth, async (req, res) => {
    const displayName = req.session.displayName;
    const isAdmin = req.session.isAdmin === true;
    const { filename } = req.body ?? {};
    // Same server-side enforcement as /submit's dry run — not just a hidden
    // checkbox, a hand-crafted request can't request one either.
    const dryRun = isAdmin && req.body?.dryRun === "on";

    if (!filename?.trim()) {
      return res.status(400).json({ error: "No track specified." });
    }

    log(`Deletion request received: "${filename}" from ${displayName}${dryRun ? " [DRY RUN]" : ""}`);
    const jobId = jobs.createJob("delete", { dryRun });

    runExclusive(() =>
      processDeletion({ filename, displayName: sanitizeDisplayName(displayName), dryRun }, config, {
        onStageChange: (stage) => jobs.recordStage(jobId, stage),
        checkCancelled: () => jobs.isCancelRequested(jobId),
      })
    )
      .then((result) => jobs.completeJob(jobId, result))
      .catch((err) => {
        logError("Deletion failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
        jobs.failJob(jobId, err);
      });

    res.json({ jobId });
  });

  return router;
}
