import { Router } from "express";
import multer from "multer";
import os from "node:os";

import { requireAuth, sanitizeDisplayName } from "../src/auth.js";
import { runExclusive } from "../src/queue.js";
import {
  processSubmission,
  SubmissionError,
  THUNDERSTORE_URL,
  MAX_TRACKS,
  MAX_TRACK_FILE_SIZE_KB,
} from "../src/publish.js";
import * as storage from "../src/storage.js";
import * as bandwidth from "../src/bandwidth.js";
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
      error: null,
      usageInfo,
      thunderstoreUrl: THUNDERSTORE_URL,
      maxTracks: MAX_TRACKS,
      maxTrackFileSizeKb: MAX_TRACK_FILE_SIZE_KB,
    });
  });

  router.post("/submit", requireAuth, upload.single("audio"), async (req, res, next) => {
    const displayName = req.session.displayName;
    const { title, artist } = req.body ?? {};
    const dryRun = req.body?.dryRun === "on";

    const staticLocals = {
      thunderstoreUrl: THUNDERSTORE_URL,
      maxTracks: MAX_TRACKS,
      maxTrackFileSizeKb: MAX_TRACK_FILE_SIZE_KB,
    };

    if (!req.file) {
      return res.status(400).render("upload", {
        displayName,
        error: "Please choose an audio file to upload.",
        usageInfo: null,
        ...staticLocals,
      });
    }
    if (!title?.trim() || !artist?.trim()) {
      return res.status(400).render("upload", {
        displayName,
        error: "Title and artist are both required.",
        usageInfo: null,
        ...staticLocals,
      });
    }

    try {
      log(`Submission request received: "${title} - ${artist}" from ${displayName}${dryRun ? " [DRY RUN]" : ""}`);
      const result = await runExclusive(() =>
        processSubmission(
          { uploadPath: req.file.path, title, artist, displayName: sanitizeDisplayName(displayName), dryRun },
          config
        )
      );
      res.render("result", { success: true, error: null, committedButNotPublished: false, ...result });
    } catch (err) {
      // Always log the full error server-side, even though the result page
      // only shows err.message — found via real testing that relying on
      // the browser-rendered message alone made a real failure hard to
      // debug (message can be a summary; stack/full detail matters here).
      logError("Submission failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
      const committedButNotPublished = err instanceof SubmissionError ? err.committedButNotPublished : false;
      res.status(500).render("result", {
        success: false,
        error: err.message,
        committedButNotPublished,
        dryRun,
      });
    }
  });

  return router;
}
