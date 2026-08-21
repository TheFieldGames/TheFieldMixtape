import { Router } from "express";

import { requireAuth, sanitizeDisplayName } from "../src/auth.js";
import { runExclusive } from "../src/queue.js";
import { requireLock } from "../src/editLock.js";
import { queueTrackDelete, cancelQueuedDeletion } from "../src/queueActions.js";
import { processPublish, SubmissionError } from "../src/publish.js";
import * as storage from "../src/storage.js";
import * as manifest from "../src/manifest.js";
import * as bandwidth from "../src/bandwidth.js";
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

function toRow(filename, entry) {
  return {
    filename,
    trackName: filename.slice(0, -".ogg".length),
    addedBy: entry?.addedBy ?? manifest.LEGACY_ADDED_BY,
    addedAt: entry?.addedAt ?? null,
  };
}

export function createTracksRouter(config, lockStore) {
  const router = Router();

  router.get("/tracks", requireAuth, async (req, res) => {
    const isAdmin = req.session.isAdmin === true;
    const progressSegments = { real: segmentsFor("publish"), dryRun: segmentsFor("publish", { dryRun: true }) };

    try {
      const trackNames = await storage.listTracks(config.r2Client, config.r2Bucket);

      let manifestData = await manifest.getManifest(config.r2Client, config.r2Bucket);
      const missing = trackNames.some((name) => !(`${name}.ogg` in manifestData.tracks));
      if (missing) {
        manifestData = await manifest.backfillLegacyTracks(config.r2Client, config.r2Bucket, trackNames);
      }

      const pendingDeleteSet = new Set(manifestData.pendingDeletes);

      // Live tracks, excluding anything queued for deletion — those show
      // in their own "pending removal" section below instead, so a track
      // isn't listed twice with conflicting actions.
      const rows = sortTracks(
        trackNames
          .filter((trackName) => !pendingDeleteSet.has(`${trackName}.ogg`))
          .map((trackName) => toRow(`${trackName}.ogg`, manifestData.tracks[`${trackName}.ogg`]))
      );

      const pendingAddRows = sortTracks(
        Object.entries(manifestData.tracks)
          .filter(([, entry]) => entry.status === "pending")
          .map(([filename, entry]) => toRow(filename, entry))
      );

      const pendingDeleteRows = sortTracks(
        manifestData.pendingDeletes.map((filename) => toRow(filename, manifestData.tracks[filename]))
      );

      // Best-effort: a transient R2 read hiccup here shouldn't block the
      // whole page from loading — degrade to "usage info unavailable"
      // rather than a 500. The server-side lock in processPublish is the
      // real enforcement either way; this is just the UI indicator.
      let usageInfo = null;
      try {
        const usage = await bandwidth.getUsage(config.r2Client, config.r2Bucket);
        const totalTrackBytes = await storage.getTotalTrackBytes(config.r2Client, config.r2Bucket);
        usageInfo = {
          locked: bandwidth.isLocked(usage),
          usageGB: (usage.bytesUsed / 1e9).toFixed(2),
          capGB: (bandwidth.LOCK_THRESHOLD_BYTES / 1e9).toFixed(1),
          publishesRemaining: bandwidth.estimatePublishesRemaining(usage, totalTrackBytes),
        };
      } catch (err) {
        logError("Failed to load bandwidth usage for the indicator (non-fatal):", err.message);
      }

      res.render("tracks", {
        displayName: req.session.displayName,
        isAdmin,
        rows,
        pendingAddRows,
        pendingDeleteRows,
        usageInfo,
        error: null,
        progressSegments,
        lockState: lockStore.getLockState(req.session.sessionId),
      });
    } catch (err) {
      logError("Failed to load the track list:", err.message);
      res.status(500).render("tracks", {
        displayName: req.session.displayName,
        isAdmin,
        rows: [],
        pendingAddRows: [],
        pendingDeleteRows: [],
        usageInfo: null,
        error: "Couldn't load the track list right now — try again shortly.",
        progressSegments,
        lockState: lockStore.getLockState(req.session.sessionId),
      });
    }
  });

  // Queueing a deletion (or cancelling a still-pending add) is fast — no
  // git/tcli involved — so this responds synchronously, same as POST
  // /submit. See queueActions.queueTrackDelete for which of the two it
  // actually does, based on the track's current status.
  router.post("/tracks/delete", requireAuth, requireLock(lockStore), async (req, res) => {
    const displayName = req.session.displayName;
    const { filename } = req.body ?? {};

    if (!filename?.trim()) {
      return res.status(400).json({ error: "No track specified." });
    }

    log(`Delete/queue request received: "${filename}" from ${displayName}`);
    try {
      const result = await runExclusive(() =>
        queueTrackDelete({ filename, displayName: sanitizeDisplayName(displayName) }, config)
      );
      res.json(result);
    } catch (err) {
      logError("Queueing deletion failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
      const status = err instanceof SubmissionError ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post("/tracks/undo-delete", requireAuth, requireLock(lockStore), async (req, res) => {
    const displayName = req.session.displayName;
    const { filename } = req.body ?? {};

    if (!filename?.trim()) {
      return res.status(400).json({ error: "No track specified." });
    }

    try {
      const result = await runExclusive(() =>
        cancelQueuedDeletion({ filename, displayName: sanitizeDisplayName(displayName) }, config)
      );
      res.json(result);
    } catch (err) {
      logError("Cancelling queued deletion failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // The only route that actually touches git/tcli — same async-job pattern
  // as the old immediate add/delete flows used. See routes/jobs.js.
  router.post("/tracks/publish", requireAuth, requireLock(lockStore), async (req, res) => {
    const displayName = req.session.displayName;
    const isAdmin = req.session.isAdmin === true;
    // Dry Run is only ever offered in the UI to admin sessions — enforce
    // that server-side too, not just by hiding the checkbox, so a
    // hand-crafted request can't request a dry run either.
    const dryRun = isAdmin && req.body?.dryRun === "on";

    log(`Publish request received from ${displayName}${dryRun ? " [DRY RUN]" : ""}`);
    const jobId = jobs.createJob("publish", { dryRun });

    runExclusive(() =>
      processPublish({ displayName: sanitizeDisplayName(displayName), dryRun }, config, {
        onStageChange: (stage) => jobs.recordStage(jobId, stage),
        checkCancelled: () => jobs.isCancelRequested(jobId),
      })
    )
      .then((result) => jobs.completeJob(jobId, result))
      .catch((err) => {
        logError("Publish failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
        jobs.failJob(jobId, err);
      });

    res.json({ jobId });
  });

  return router;
}
