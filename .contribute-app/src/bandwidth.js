import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Bucket-root key (not under storage.TRACK_PREFIX), so it's structurally
// invisible to listTracks()/downloadAllTracks() the same way the dry-run
// prefix is — this is app state, not a track.
export const USAGE_KEY = "bandwidth-usage.json";

// Verified against Render's own docs (not assumed): Hobby/free-tier
// outbound bandwidth is 5GB/month, per-workspace, decimal GB (billing
// convention — using binary GiB here would overstate the real allowance,
// which is exactly the wrong direction for a safety cutoff). Confirmed
// current as of 2026-08-19: a "100GB" figure exists in older sources but
// was the *legacy* Hobby plan, force-migrated away by 2026-08-01.
export const MONTHLY_CAP_BYTES = 5_000_000_000;

// Deliberately below MONTHLY_CAP_BYTES — the requested safety margin so
// real-world timing/measurement slop can't result in actually exceeding the
// real cap and getting the Render workspace suspended or billed.
export const LOCK_THRESHOLD_BYTES = 4_500_000_000;

/** Pure: current UTC calendar month as "YYYY-MM" — matches Render's
 * calendar-month reset (confirmed via their docs: usage-based free
 * allowances reset at the start of each calendar month, no rollover). */
export function currentMonthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads current usage, transparently treating a stale (previous-month) or
 * missing record as a fresh zero — the caller never has to think about
 * resets themselves. Doesn't write anything; a reset is only persisted the
 * next time recordPublish() actually runs. */
export async function getUsage(client, bucket, { now = new Date() } = {}) {
  const month = currentMonthKey(now);
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: USAGE_KEY }));
    const parsed = JSON.parse(await streamToString(resp.Body));
    if (parsed.month !== month) return { month, bytesUsed: 0 };
    return { month, bytesUsed: parsed.bytesUsed || 0 };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") {
      return { month, bytesUsed: 0 };
    }
    throw err;
  }
}

/** Adds bytesAdded to this month's running total (auto-resetting if the
 * stored record is from a previous month) and persists it. */
export async function recordPublish(client, bucket, bytesAdded, { now = new Date() } = {}) {
  const usage = await getUsage(client, bucket, { now });
  const updated = { month: usage.month, bytesUsed: usage.bytesUsed + bytesAdded };
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: USAGE_KEY,
      Body: JSON.stringify(updated),
      ContentType: "application/json",
    })
  );
  return updated;
}

export function isLocked(usage) {
  return usage.bytesUsed >= LOCK_THRESHOLD_BYTES;
}

export function remainingBytes(usage) {
  return Math.max(0, LOCK_THRESHOLD_BYTES - usage.bytesUsed);
}

/** How many more publishes fit in what's left this month, at a given
 * per-publish size (typically the current total package size — see
 * storage.getTotalTrackBytes). Estimate, not a guarantee: the next
 * publish's exact size depends on what's added/removed before it runs. */
export function estimatePublishesRemaining(usage, perPublishBytes) {
  if (!perPublishBytes || perPublishBytes <= 0) return null;
  return Math.floor(remainingBytes(usage) / perPublishBytes);
}
