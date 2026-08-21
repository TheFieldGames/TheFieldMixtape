import { Router } from "express";
import multer from "multer";
import os from "node:os";

import { requireAuth, sanitizeDisplayName } from "../src/auth.js";
import { runExclusive } from "../src/queue.js";
import { requireLock } from "../src/editLock.js";
import { queueTrackAdd } from "../src/queueActions.js";
import { SubmissionError } from "../src/publish.js";
import { log, logError } from "../src/logger.js";

// 100MB cap per the plan — a normal .ogg/.mp3 track is a few MB, this is
// generous headroom, not a real ceiling. ffmpeg is the real format
// validator, so no strict mimetype allowlist here.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export function createIndexRouter(config, lockStore) {
  const router = Router();

  // Queueing is fast (convert + upload to R2's pending prefix + a manifest
  // write — no git/tcli involved at all), so unlike a Publish this responds
  // synchronously rather than kicking off a tracked job/progress modal.
  // Still runs through the same runExclusive mutex as everything else that
  // touches the manifest, so it can't race a concurrent Publish.
  router.post("/submit", requireAuth, upload.single("audio"), requireLock(lockStore), async (req, res) => {
    const displayName = req.session.displayName;
    const { title, artist } = req.body ?? {};

    if (!req.file) {
      return res.status(400).json({ error: "Please choose an audio file to upload." });
    }
    if (!title?.trim() || !artist?.trim()) {
      return res.status(400).json({ error: "Title and artist are both required." });
    }

    log(`Queue request received: "${title} - ${artist}" from ${displayName}`);
    try {
      const result = await runExclusive(() =>
        queueTrackAdd(
          { uploadPath: req.file.path, title, artist, displayName: sanitizeDisplayName(displayName) },
          config
        )
      );
      res.json({ trackName: result.trackName });
    } catch (err) {
      logError("Queueing failed:", err.stage ? `[stage: ${err.stage}] ` : "", err);
      const status = err instanceof SubmissionError ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  return router;
}
