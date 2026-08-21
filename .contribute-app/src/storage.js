import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Verified against the real bucket during pre-flight: objects were uploaded
// via Cloudflare's dashboard folder-upload, which preserved the "my mixtape/"
// path prefix — matching the package's internal zip layout exactly.
export const TRACK_PREFIX = "my mixtape/";

// Dry-run uploads live under a completely separate prefix. listTracks() and
// downloadAllTracks() are scoped to TRACK_PREFIX only, so anything uploaded
// here is structurally invisible to the real track library — no extra
// filtering logic needed to keep dry runs from polluting real submissions.
export const DRY_RUN_PREFIX = "dry-run/";

// A queued (not-yet-published) track add lives here, not under TRACK_PREFIX
// — same isolation reasoning as DRY_RUN_PREFIX: listTracks()/
// downloadAllTracks() must never see a pending track, or it would leak into
// the published package (or this app's own /tracks display of "live"
// tracks) before anyone actually hit Publish. promotePendingTrack moves it
// to the real prefix once a Publish batch actually goes through.
export const PENDING_PREFIX = "pending/";

export function createR2Client({ accountId, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function keyForFilename(filename, prefix = TRACK_PREFIX) {
  return `${prefix}${filename}`;
}

/** Returns the plain track name ("Title - Artist") for a .ogg key under the
 * track prefix, or null for anything else (e.g. the stray mixtape.json
 * object also swept in by the dashboard folder-upload). */
export function trackNameFromKey(key) {
  if (!key.startsWith(TRACK_PREFIX) || !key.endsWith(".ogg")) return null;
  return key.slice(TRACK_PREFIX.length, -".ogg".length);
}

/** Internal: paginates the real track prefix, returning {Key, Size} pairs
 * for every .ogg object. Size comes free from ListObjectsV2 — no extra
 * per-object HeadObject calls needed. */
async function listTrackObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: TRACK_PREFIX,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key.endsWith(".ogg")) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

export async function listTrackKeys(client, bucket) {
  const objects = await listTrackObjects(client, bucket);
  return objects.map((o) => o.key);
}

/** Authoritative "what tracks currently exist" — used for README regeneration. */
export async function listTracks(client, bucket) {
  const keys = await listTrackKeys(client, bucket);
  return keys.map(trackNameFromKey).filter(Boolean);
}

/** Sum of all real track object sizes — used as the "current package size"
 * estimate for the bandwidth indicator (how many more publishes fit in the
 * remaining monthly allowance). */
export async function getTotalTrackBytes(client, bucket) {
  const objects = await listTrackObjects(client, bucket);
  return objects.reduce((sum, o) => sum + o.size, 0);
}

export async function trackExists(client, bucket, filename, { prefix = TRACK_PREFIX } = {}) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyForFilename(filename, prefix) }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}

export async function deleteTrack(client, bucket, filename, { prefix = TRACK_PREFIX } = {}) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyForFilename(filename, prefix) }));
}

/**
 * Moves a queued track from PENDING_PREFIX to the real TRACK_PREFIX — a
 * server-side copy (R2 handles this internally, no re-upload of the actual
 * bytes) followed by deleting the pending copy. Used by a Publish batch to
 * turn a "pending" manifest entry into a real, live track.
 *
 * S3's CopySource must be `<bucket>/<url-encoded key>`, but a naive
 * encodeURIComponent also escapes the "/" inside PENDING_PREFIX itself,
 * corrupting the path — so only the filename portion is encoded.
 */
export async function promotePendingTrack(client, bucket, filename) {
  const sourceKey = keyForFilename(filename, PENDING_PREFIX);
  const destKey = keyForFilename(filename, TRACK_PREFIX);
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${PENDING_PREFIX}${encodeURIComponent(filename)}`,
      Key: destKey,
    })
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
}

export async function uploadTrack(client, bucket, filename, filePath, { prefix = TRACK_PREFIX } = {}) {
  const body = await fsp.readFile(filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyForFilename(filename, prefix),
      Body: body,
      ContentType: "audio/ogg",
    })
  );
}

/** Downloads a single object to an exact local path — used by a dry-run
 * Publish preview to pull a queued (pending-prefix) track's real bytes down
 * for the build preview, since dry runs never touch the real R2 prefix. */
export async function downloadTrackTo(client, bucket, filename, destPath, { prefix = TRACK_PREFIX } = {}) {
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyForFilename(filename, prefix) }));
  await pipeline(Readable.from(resp.Body), fs.createWriteStream(destPath));
}

/**
 * Downloads the complete current track library into destDir, in parallel
 * (measured ~5x faster than sequential during pre-flight — 3.9s vs 18.9s
 * for the real 57-track/212MB bucket). Used right before tcli build/publish
 * so the build step has every track on disk, not just the newly-added one.
 *
 * Streams each object straight to disk rather than buffering the whole file
 * in memory first — found necessary after a real submission on Render's
 * free tier (very little RAM) exceeded the instance's memory limit here,
 * with all 59 tracks' full bytes resident in memory at once (parallel)
 * right before tcli also needed memory to zip that same data.
 */
export async function downloadAllTracks(client, bucket, destDir) {
  const keys = await listTrackKeys(client, bucket);
  await fsp.mkdir(destDir, { recursive: true });
  await Promise.all(
    keys.map(async (key) => {
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(Readable.from(resp.Body), fs.createWriteStream(path.join(destDir, path.basename(key))));
    })
  );
  return keys.length;
}
