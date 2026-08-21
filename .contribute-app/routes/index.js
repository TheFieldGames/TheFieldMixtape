import { Router } from "express";
import multer from "multer";
import os from "node:os";

import { requireAuth, sanitizeDisplayName } from "../src/auth.js";
import { runExclusive } from "../src/queue.js";
import {
  processSubmission,
  THUNDERSTORE_URL,
  MAX_TRACKS,
  MAX_TRACK_FILE_SIZE_KB,
} from "../src/publish.js";
import * as storage from "../src/storage.js";
import * as bandwidth from "../src/bandwidth.js";
import * as jobs from "../src/jobs.js";
import { segmentsFor } from "../src/stageWeights.js";
import { log, logError } from "../src/logger.js";

// 100MB cap per the plan — a normal .ogg/.mp3 track is a few MB, this is
// generous headroom, not a real ceiling. ffmpeg is the real format
// validator, so no strict mimetype allowlist here.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export function createIndexRouter(config) {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const displayName = req.session.displayName;
    const isAdmin = req.session.isAdmin === true;

    // Best-effort: a transient R2 read hiccup here shouldn't block the
    // whole upload page from loading — degrade to "usage info unavailable"
    // rather than a 500. The server-side lock in processSubmission is the
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

    res.render("upload", {
      displayName,
      isAdmin,
      error: null,
      usageInfo,
      thunderstoreUrl: THUNDERSTORE_URL,
      maxTracks: MAX_TRACKS,
      maxTrackFileSizeKb: MAX_TRACK_FILE_SIZE_KB,
      progressSegments: { real: segmentsFor("add"), dryRun: segmentsFor("add", { dryRun: true }) },
    });
  });

  // Kicks the job off and returns {jobId} immediately — the client opens
  // the progress modal and streams stage updates from GET
  // /jobs/:jobId/events, then navigates to GET /jobs/:jobId/result once
  // it's done. See routes/jobs.js and public/progress-modal.js.
  router.post("/submit", requireAuth, upload.single("audio"), async (req, res) => {
    const displayName = req.session.displayName;
    const isAdmin = req.session.isAdmin === true;
    const { title, artist } = req.body ?? {};
    // Dry Run is only ever offered in the UI to admin sessions — enforce
    // that server-side too, not just by hiding the checkbox, so a
    // hand-crafted request can't request a dry run either.
    const dryRun = isAdmin && req.body?.dryRun === "on";

    if (!req.file) {
      return res.status(400).json({ error: "Please choose an audio file to upload." });
    }
    if (!title?.trim() || !artist?.trim()) {
      return res.status(400).json({ error: "Title and artist are both required." });
    }

    log(`Submission request received: "${title} - ${artist}" from ${displayName}${dryRun ? " [DRY RUN]" : ""}`);
    const jobId = jobs.createJob("add", { dryRun });

    runExclusive(() =>
      processSubmission(
        { uploadPath: req.file.path, title, artist, displayName: sanitizeDisplayName(displayName), dryRun },
        config,
        {
          onStageChange: (stage) => jobs.recordStage(jobId, stage),
          checkCancelled: () => jobs.isCancelRequested(jobId),
        }
      )
    )
      .then((result) => jobs.completeJob(jobId, result))
      .catch((err) => {
        // Always log the full error server-side, even though the result
        // page only shows err.message — found via real testing that
        // relying on the browser-rendered message alone made a real
        // failure hard to debug (message can be a summary; stack/full
        // detail matters here).
        logError("Submission failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
        jobs.failJob(jobId, err);
      });

    res.json({ jobId });
  });

  return router;
}
