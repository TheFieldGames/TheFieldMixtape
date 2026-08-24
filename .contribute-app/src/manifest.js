import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { log as logDefault } from "./logger.js";

// Bucket-root key (not under storage.TRACK_PREFIX), so it's structurally
// invisible to listTracks()/downloadAllTracks() — same pattern as
// bandwidth.js's USAGE_KEY. This is app state, not a track.
export const MANIFEST_KEY = "manifest.json";

// Marks a track that predates the manifest — the real author is known to
// the maintainer and gets corrected individually later. Not a claim the
// author is genuinely unknown, just "not yet backfilled with a real name."
export const LEGACY_ADDED_BY = "TEMP";

function defaultManifest() {
  return { tracks: {}, pendingDeletes: [], publishLog: [] };
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads the manifest, transparently treating a missing object as a fresh
 * empty one — the caller never has to think about first-run/not-yet-created
 * state themselves. Doesn't write anything. */
export async function getManifest(client, bucket) {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    const parsed = JSON.parse(await streamToString(resp.Body));
    return { ...defaultManifest(), ...parsed };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") {
      return defaultManifest();
    }
    throw err;
  }
}

async function saveManifest(client, bucket, manifest) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    })
  );
}

/** Records a newly-published track. Read-modify-write, same as
 * bandwidth.recordPublish — safe under processSubmission's existing
 * runExclusive mutex, no new concurrency mechanism needed. */
export async function recordTrackAdded(client, bucket, filename, addedBy, { now = new Date() } = {}) {
  const manifest = await getManifest(client, bucket);
  const updated = {
    ...manifest,
    tracks: {
      ...manifest.tracks,
      [filename]: { addedBy, addedAt: now.toISOString(), status: "live" },
    },
  };
  await saveManifest(client, bucket, updated);
  return updated;
}

/** Drops a track's manifest entry entirely (used when a track is deleted —
 * unlike recordTrackAdded/applyManualCorrections, there's nothing to keep
 * around once the track itself is gone). A no-op (no write) if the given
 * filename has no entry to begin with. */
export async function removeTrack(client, bucket, filename) {
  const manifest = await getManifest(client, bucket);
  if (!(filename in manifest.tracks)) return manifest;
  const remainingTracks = { ...manifest.tracks };
  delete remainingTracks[filename];
  const updated = { ...manifest, tracks: remainingTracks };
  await saveManifest(client, bucket, updated);
  return updated;
}

/**
 * Fills in a manifest entry for any real track that doesn't have one yet —
 * tracks that predate the manifest itself, or that otherwise slipped
 * through (e.g. a manual out-of-band R2 change). Idempotent and cheap when
 * there's nothing to do: reads the manifest, and only writes if at least
 * one track was actually missing.
 *
 * `trackNames` should be the plain names from storage.listTracks()
 * ("Title - Artist", no extension) — converted to filenames here since
 * that's the manifest's key shape (matches storage.keyForFilename's target).
 */
export async function backfillLegacyTracks(client, bucket, trackNames, { now = new Date() } = {}, { log = logDefault } = {}) {
  const manifest = await getManifest(client, bucket);
  const missing = trackNames.filter((name) => !(`${name}.ogg` in manifest.tracks));
  if (missing.length === 0) return manifest;

  // Legitimate on this app's very first runs (genuinely pre-manifest
  // tracks) — but it's also exactly the mechanism that silently masked a
  // real bug once: a track promoted to the live R2 prefix by a failed
  // Publish attempt, then orphaned by a "cancel" action that removed its
  // manifest entry without checking where the file actually was (see
  // queueTrackDelete's fix in queueActions.js). Logging every occurrence
  // loudly, by name, means that never disappears into the noise silently
  // again — an unexpected backfill of recently-known track names is the
  // signal something upstream went wrong.
  log(`Backfilling ${missing.length} track(s) missing from the manifest as legacy/live: ${missing.join(", ")}`);

  const updated = {
    ...manifest,
    tracks: {
      ...manifest.tracks,
      ...Object.fromEntries(
        missing.map((name) => [
          `${name}.ogg`,
          { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" },
        ])
      ),
    },
  };
  await saveManifest(client, bucket, updated);
  return updated;
}

/** Records a newly-queued track add. Unlike recordTrackAdded, this doesn't
 * mean the track is live yet — the real R2 object lives under
 * storage.PENDING_PREFIX until a Publish action promotes it. `addedAt`
 * reflects when it was queued (there's no second, separate "went live"
 * timestamp — the manifest only ever tracks one addedAt per track). */
export async function queueTrackAdded(client, bucket, filename, addedBy, { now = new Date() } = {}) {
  const manifest = await getManifest(client, bucket);
  const updated = {
    ...manifest,
    tracks: {
      ...manifest.tracks,
      [filename]: { addedBy, addedAt: now.toISOString(), status: "pending" },
    },
  };
  await saveManifest(client, bucket, updated);
  return updated;
}

/** Flags a currently-live track for removal at the next publish — doesn't
 * touch R2 or the track's own manifest entry yet (mirrors the plan's
 * "mis-click is reversible from the queue view before it's live" design).
 * Idempotent: a filename already queued for deletion isn't duplicated. */
export async function queueTrackDeletion(client, bucket, filename) {
  const manifest = await getManifest(client, bucket);
  if (manifest.pendingDeletes.includes(filename)) return manifest;
  const updated = { ...manifest, pendingDeletes: [...manifest.pendingDeletes, filename] };
  await saveManifest(client, bucket, updated);
  return updated;
}

/** Undoes a queued deletion (removes `filename` from pendingDeletes,
 * leaving its still-live manifest entry and R2 object untouched). A no-op
 * if it wasn't queued for deletion to begin with. */
export async function cancelPendingDeletion(client, bucket, filename) {
  const manifest = await getManifest(client, bucket);
  if (!manifest.pendingDeletes.includes(filename)) return manifest;
  const updated = { ...manifest, pendingDeletes: manifest.pendingDeletes.filter((f) => f !== filename) };
  await saveManifest(client, bucket, updated);
  return updated;
}

/**
 * Applies the outcome of a successful Publish batch in one read-modify-
 * write: every filename in `publishedFilenames` (tracks that were
 * "pending" and just got promoted to the real R2 prefix) flips to
 * `status: "live"`, keeping its original addedBy/addedAt; every filename in
 * `deletedFilenames` (tracks that were queued for deletion and just got
 * removed from R2) has its manifest entry dropped entirely and is cleared
 * from pendingDeletes. Only ever called after the real git/tcli work has
 * already succeeded — see processPublish in publish.js.
 */
export async function applyPublishBatch(client, bucket, { publishedFilenames = [], deletedFilenames = [] } = {}) {
  const manifest = await getManifest(client, bucket);
  const updatedTracks = { ...manifest.tracks };

  for (const filename of publishedFilenames) {
    const existing = updatedTracks[filename];
    if (existing) updatedTracks[filename] = { ...existing, status: "live" };
  }
  for (const filename of deletedFilenames) {
    delete updatedTracks[filename];
  }

  const deletedSet = new Set(deletedFilenames);
  const updated = {
    ...manifest,
    tracks: updatedTracks,
    pendingDeletes: manifest.pendingDeletes.filter((f) => !deletedSet.has(f)),
  };
  await saveManifest(client, bucket, updated);
  return updated;
}

/**
 * Applies a batch of manually-supplied corrections (real addedBy/addedAt
 * values for tracks that were backfilled as LEGACY_ADDED_BY) in a single
 * read-modify-write, rather than one round trip per track. Each correction
 * fully replaces that track's addedBy/addedAt/status; a filename with no
 * existing manifest entry gets one created outright, so this also works for
 * tracks manifest.js has never seen. `addedAt` is taken as-is (already
 * resolved to an ISO string or a Date) — this function doesn't parse dates
 * itself, so caller-side timezone handling (e.g. treating a bare date as
 * local time in some zone) is the caller's responsibility.
 */
export async function applyManualCorrections(client, bucket, corrections) {
  const manifest = await getManifest(client, bucket);
  const updatedTracks = { ...manifest.tracks };
  for (const { filename, addedBy, addedAt } of corrections) {
    const existing = updatedTracks[filename];
    updatedTracks[filename] = {
      status: existing?.status || "live",
      ...existing,
      addedBy,
      addedAt: addedAt instanceof Date ? addedAt.toISOString() : addedAt,
    };
  }
  const updated = { ...manifest, tracks: updatedTracks };
  await saveManifest(client, bucket, updated);
  return updated;
}
