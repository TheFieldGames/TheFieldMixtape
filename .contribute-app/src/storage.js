import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import fsp from "node:fs/promises";
import path from "node:path";

// Verified against the real bucket during pre-flight: objects were uploaded
// via Cloudflare's dashboard folder-upload, which preserved the "my mixtape/"
// path prefix — matching the package's internal zip layout exactly.
export const TRACK_PREFIX = "my mixtape/";

// Dry-run uploads live under a completely separate prefix. listTracks() and
// downloadAllTracks() are scoped to TRACK_PREFIX only, so anything uploaded
// here is structurally invisible to the real track library — no extra
// filtering logic needed to keep dry runs from polluting real submissions.
export const DRY_RUN_PREFIX = "dry-run/";

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

export async function trackExists(client, bucket, filename) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyForFilename(filename) }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Downloads the complete current track library into destDir, in parallel
 * (measured ~5x faster than sequential during pre-flight — 3.9s vs 18.9s
 * for the real 57-track/212MB bucket). Used right before tcli build/publish
 * so the build step has every track on disk, not just the newly-added one.
 */
export async function downloadAllTracks(client, bucket, destDir) {
  const keys = await listTrackKeys(client, bucket);
  await fsp.mkdir(destDir, { recursive: true });
  await Promise.all(
    keys.map(async (key) => {
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const buffer = await streamToBuffer(resp.Body);
      await fsp.writeFile(path.join(destDir, path.basename(key)), buffer);
    })
  );
  return keys.length;
}
