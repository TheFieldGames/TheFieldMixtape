import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { buildTrackFilename } from "./filename.js";
import { PENDING_PREFIX } from "./storage.js";
import * as storageDefault from "./storage.js";
import { convertToOgg as convertToOggDefault } from "./convert.js";
import * as manifestDefault from "./manifest.js";
import { log as logDefault } from "./logger.js";
import { SubmissionError, MAX_TRACKS, MAX_TRACK_FILE_SIZE_KB, MAX_TRACK_FILE_SIZE_BYTES } from "./publish.js";

/**
 * Queues a new track add: validates (no duplicate live or already-queued
 * track, converted file under the size limit, projected count under
 * MAX_TRACKS), converts the upload to .ogg, and uploads it under R2's
 * pending prefix with a manifest entry recording who queued it and when.
 * Deliberately does NOT touch git or tcli at all — that's the whole point
 * of queueing being fast (a couple seconds, not 1-2 minutes). Nothing here
 * is visible in the published package or the live track list until an
 * explicit Publish action (processPublish in publish.js) promotes it.
 */
export async function queueTrackAdd(input, config, deps = {}) {
  const {
    storage = storageDefault,
    convert = convertToOggDefault,
    manifest = manifestDefault,
    tmpBase = os.tmpdir(),
    log = logDefault,
  } = deps;

  const { uploadPath, title, artist, displayName } = input;
  const { r2Client, r2Bucket } = config;

  const filename = buildTrackFilename(title, artist);
  const trackName = filename.slice(0, -".ogg".length);
  const convertedPath = path.join(tmpBase, `contribute-queue-${crypto.randomUUID()}.ogg`);

  try {
    if (await storage.trackExists(r2Client, r2Bucket, filename)) {
      throw new SubmissionError(`A track named "${filename}" already exists.`, { stage: "check-duplicate" });
    }
    if (await storage.trackExists(r2Client, r2Bucket, filename, { prefix: PENDING_PREFIX })) {
      throw new SubmissionError(`"${filename}" is already queued.`, { stage: "check-duplicate" });
    }

    const manifestData = await manifest.getManifest(r2Client, r2Bucket);
    const liveAndPendingCount = Object.values(manifestData.tracks).filter(
      (entry) => entry.status === "live" || entry.status === "pending"
    ).length;
    if (liveAndPendingCount + 1 > MAX_TRACKS) {
      throw new SubmissionError(
        `Queueing this would put the mixtape at ${liveAndPendingCount + 1} tracks, over the ${MAX_TRACKS}-track limit.`,
        { stage: "check-track-limit" }
      );
    }

    await convert(uploadPath, convertedPath);

    const convertedStat = await fsp.stat(convertedPath);
    if (convertedStat.size > MAX_TRACK_FILE_SIZE_BYTES) {
      throw new SubmissionError(
        `"${trackName}" converted to ${Math.ceil(convertedStat.size / 1024)}KB, over the ${MAX_TRACK_FILE_SIZE_KB}KB limit. Try a shorter clip or a lower-bitrate source.`,
        { stage: "check-file-size" }
      );
    }

    await storage.uploadTrack(r2Client, r2Bucket, filename, convertedPath, { prefix: PENDING_PREFIX });
    await manifest.queueTrackAdded(r2Client, r2Bucket, filename, displayName);

    log(`Queued add: "${trackName}" by ${displayName}`);
    return { filename, trackName };
  } finally {
    await fsp.rm(convertedPath, { force: true }).catch(() => {});
    await fsp.rm(uploadPath, { force: true }).catch(() => {});
  }
}

/**
 * Handles a "delete" click on the tracks page for either kind of track:
 * - A still-pending add (never published) is cancelled outright — its
 *   pending R2 object and manifest entry are removed, since there's
 *   nothing live to "queue for deletion."
 * - A live track is flagged pendingDelete in the manifest — actual removal
 *   from R2 only happens when a Publish action goes through.
 */
export async function queueTrackDelete(input, config, deps = {}) {
  const { storage = storageDefault, manifest = manifestDefault, log = logDefault } = deps;
  const { filename, displayName } = input;
  const { r2Client, r2Bucket } = config;

  const manifestData = await manifest.getManifest(r2Client, r2Bucket);
  const entry = manifestData.tracks[filename];

  if (entry?.status === "pending") {
    await storage.deleteTrack(r2Client, r2Bucket, filename, { prefix: PENDING_PREFIX });
    await manifest.removeTrack(r2Client, r2Bucket, filename);
    log(`Cancelled pending add: "${filename}" by ${displayName}`);
    return { filename, action: "cancelled-pending-add" };
  }

  if (!entry || entry.status !== "live") {
    throw new SubmissionError(`No track named "${filename}" exists.`, { stage: "check-exists" });
  }

  await manifest.queueTrackDeletion(r2Client, r2Bucket, filename);
  log(`Queued deletion: "${filename}" by ${displayName}`);
  return { filename, action: "queued-deletion" };
}

/** Undoes a queued deletion (the tracks page's "undo" action on a
 * pending-removal row) — the track's own live manifest entry and R2 object
 * are untouched, only the pendingDeletes flag is cleared. */
export async function cancelQueuedDeletion(input, config, deps = {}) {
  const { manifest = manifestDefault, log = logDefault } = deps;
  const { filename, displayName } = input;
  const { r2Client, r2Bucket } = config;

  await manifest.cancelPendingDeletion(r2Client, r2Bucket, filename);
  log(`Un-queued deletion: "${filename}" by ${displayName}`);
  return { filename };
}
