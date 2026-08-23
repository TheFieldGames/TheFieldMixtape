import { log as logDefault, logError as logErrorDefault } from "./logger.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord webhooks share one workspace-wide-ish rate limit with a very
// short burst window — a couple of logins/publishes landing within a
// second or two of each other is enough to trip it even at low overall
// volume. Cap how long a single retry is willing to wait regardless of
// what Discord asks for, as a guard against a runaway value — but this
// call is always fire-and-forget (never awaited by anything a user is
// waiting on), so there's no real cost to waiting out a longer
// Discord-requested cooldown. A too-tight cap is actively harmful: if
// Discord's real retry_after exceeds it, the retry fires while the
// webhook is still inside its cooldown window and is guaranteed to 429
// again — indistinguishable in the logs from a "retry that should have
// worked but didn't" unless the real requested value is logged too.
const MAX_RETRY_AFTER_SECONDS = 30;

// Discord's 429 response carries the wait time in the JSON body
// (`retry_after`, in seconds — the documented, authoritative source) and
// usually also as a `Retry-After` header; falls back to a plain 1s guess
// if neither is present or parseable (e.g. a fake Response in tests that
// doesn't implement .json()/.headers). The body also carries `global`,
// which distinguishes two very different failure modes: `false` means
// just this webhook is over its own limit; `true` means Discord is
// throttling the whole outbound IP, not this app specifically — common on
// shared-IP hosting (Render's free tier, Cloudflare Workers, etc.), where
// unrelated traffic from other tenants on the same IP pool can trip it.
//
// Also pulled: Discord's `X-RateLimit-*` headers, present on the 429
// independent of the JSON body. `scope` is the most diagnostic of these —
// it reads "shared" specifically when a limit is enforced across more than
// one caller hitting the same resource (as opposed to "user", one caller's
// own bucket) — the clearest possible confirmation, if it shows up, that
// something *other* than this app's own call volume is hitting this exact
// webhook (e.g. a second app instance configured with the same URL).
async function parseRateLimitInfo(response) {
  let retryAfterSeconds = null;
  let global = false;
  let message = null;
  try {
    const body = await response.json();
    if (typeof body?.retry_after === "number") retryAfterSeconds = body.retry_after;
    if (body?.global === true) global = true;
    if (typeof body?.message === "string") message = body.message;
  } catch {
    // Not JSON, already consumed, or no .json() at all — fall through to
    // the header for the wait time; global/message stay at their defaults,
    // since there's no header equivalent for either.
  }
  if (retryAfterSeconds === null) {
    const header = response.headers?.get?.("retry-after");
    const parsed = header ? Number(header) : NaN;
    retryAfterSeconds = Number.isFinite(parsed) ? parsed : 1;
  }
  const scope = response.headers?.get?.("x-ratelimit-scope") ?? null;
  const bucket = response.headers?.get?.("x-ratelimit-bucket") ?? null;
  const limit = response.headers?.get?.("x-ratelimit-limit") ?? null;
  const remaining = response.headers?.get?.("x-ratelimit-remaining") ?? null;
  return { retryAfterSeconds, global, message, scope, bucket, limit, remaining };
}

// Renders only the fields that were actually present — most of these are
// undocumented-for-webhooks and may not show up on every 429, so a fixed
// template would print a wall of "null"s that bury the fields that matter.
function describeRateLimit({ global, retryAfterSeconds, message, scope, bucket, limit, remaining }) {
  const parts = [`global: ${global}`, `retry_after: ${retryAfterSeconds}s`];
  if (scope) parts.push(`scope: ${scope}`);
  if (bucket) parts.push(`bucket: ${bucket}`);
  if (limit !== null) parts.push(`limit: ${limit}`);
  if (remaining !== null) parts.push(`remaining: ${remaining}`);
  if (message) parts.push(`message: "${message}"`);
  return parts.join(", ");
}

// Shared by notifyLogin/notifyPublish below. Never throws — a broken or
// unreachable webhook must never surface as a failure to the caller, since
// neither a login nor a publish should ever be blocked or failed by a
// notification going wrong. webhookUrl/fetchFn/logError/sleepFn are
// injected so tests never make a real network call or actually wait.
async function postToDiscord(content, { webhookUrl, fetchFn, log, logError, what, sleepFn = defaultSleep, retried = false }) {
  if (!webhookUrl) return;
  try {
    // A timestamped line per real attempt (log() prepends one — see
    // src/logger.js) — the only way to actually tell, from the logs
    // alone, whether two notifications are landing close together (real
    // overlapping activity, or a duplicate-call bug) instead of guessing
    // at it indirectly from 429s.
    log(`Discord ${what} notification: attempt ${retried ? 2 : 1}`);
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (response.status === 429) {
      const info = await parseRateLimitInfo(response);
      if (!retried) {
        const waitSeconds = Math.min(info.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
        // Logs everything Discord told us before we decide how long to
        // wait — the only way to tell after the fact whether a subsequent
        // second 429 happened because the cap cut the wait short (real
        // value > cap) or because something else is going on entirely.
        log(`Discord ${what} notification: HTTP 429 (${describeRateLimit(info)}), waiting ${waitSeconds}s`);
        await sleepFn(waitSeconds * 1000);
        return postToDiscord(content, { webhookUrl, fetchFn, log, logError, what, sleepFn, retried: true });
      }
      // global: true is the signal to look at Discord/Render's shared-IP
      // rate limiting rather than at our own call volume — a retry can't
      // route around a whole-IP block, only around this-webhook-specific
      // throttling. scope: "shared" (if present) is the same signal at the
      // webhook level instead of the IP level.
      logError(`Discord ${what} notification failed: HTTP 429 (${describeRateLimit(info)})`);
      return;
    }
    if (!response.ok) {
      logError(`Discord ${what} notification failed: HTTP ${response.status}`);
    }
  } catch (err) {
    logError(`Discord ${what} notification failed:`, err.message);
  }
}

// DISCORD_WEBHOOK_URL is optional, same reasoning as ADMIN_PASSWORD_HASH —
// deployments that don't set it simply never send notifications, rather
// than failing to boot.
export async function notifyLogin(
  { displayName, isAdmin = false, isDemo = false },
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, log = logDefault, logError = logErrorDefault, sleepFn } = {}
) {
  const tag = isDemo ? " (demo)" : isAdmin ? " (admin)" : "";
  const content = `🎧 **${displayName}**${tag} logged in to TheFieldMixtape.`;
  await postToDiscord(content, { webhookUrl, fetchFn, log, logError, what: "login", sleepFn });
}

// Only meant to be called for a real (non-dry-run) publish — the caller
// decides that, this module doesn't know about dryRun at all. `added`/
// `deleted` are the human-readable track names processPublish already
// returns (see src/publish.js's addedNames/deletedNames), not filenames.
export async function notifyPublish(
  { displayName, added = [], deleted = [], versionNumber, thunderstoreUrl },
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, log = logDefault, logError = logErrorDefault, sleepFn } = {}
) {
  const lines = [`📦 **${displayName}** published TheFieldMixtape v${versionNumber}`];
  if (added.length > 0) {
    lines.push("", "**Added:**", ...added.map((name) => `• ${name}`));
  }
  if (deleted.length > 0) {
    lines.push("", "**Removed:**", ...deleted.map((name) => `• ${name}`));
  }
  if (thunderstoreUrl) {
    lines.push("", thunderstoreUrl);
  }
  await postToDiscord(lines.join("\n"), { webhookUrl, fetchFn, log, logError, what: "publish", sleepFn });
}
