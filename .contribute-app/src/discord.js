import { logError as logErrorDefault } from "./logger.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord webhooks share one workspace-wide-ish rate limit with a very
// short burst window — a couple of logins/publishes landing within a
// second or two of each other is enough to trip it even at low overall
// volume. Cap how long a single retry is willing to wait regardless of
// what Discord asks for, since this is a best-effort convenience
// notification, not something worth blocking on for long.
const MAX_RETRY_AFTER_SECONDS = 5;

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
async function parseRateLimitInfo(response) {
  let retryAfterSeconds = null;
  let global = false;
  try {
    const body = await response.json();
    if (typeof body?.retry_after === "number") retryAfterSeconds = body.retry_after;
    if (body?.global === true) global = true;
  } catch {
    // Not JSON, already consumed, or no .json() at all — fall through to
    // the header for the wait time; global stays false, since there's no
    // header equivalent for it.
  }
  if (retryAfterSeconds === null) {
    const header = response.headers?.get?.("retry-after");
    const parsed = header ? Number(header) : NaN;
    retryAfterSeconds = Number.isFinite(parsed) ? parsed : 1;
  }
  return { retryAfterSeconds, global };
}

// Shared by notifyLogin/notifyPublish below. Never throws — a broken or
// unreachable webhook must never surface as a failure to the caller, since
// neither a login nor a publish should ever be blocked or failed by a
// notification going wrong. webhookUrl/fetchFn/logError/sleepFn are
// injected so tests never make a real network call or actually wait.
async function postToDiscord(content, { webhookUrl, fetchFn, logError, what, sleepFn = defaultSleep, retried = false }) {
  if (!webhookUrl) return;
  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (response.status === 429) {
      const { retryAfterSeconds, global } = await parseRateLimitInfo(response);
      if (!retried) {
        await sleepFn(Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000);
        return postToDiscord(content, { webhookUrl, fetchFn, logError, what, sleepFn, retried: true });
      }
      // global: true is the signal to look at Discord/Render's shared-IP
      // rate limiting rather than at our own call volume — a retry can't
      // route around a whole-IP block, only around this-webhook-specific
      // throttling.
      logError(`Discord ${what} notification failed: HTTP 429 (global: ${global})`);
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
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, logError = logErrorDefault, sleepFn } = {}
) {
  const tag = isDemo ? " (demo)" : isAdmin ? " (admin)" : "";
  const content = `🎧 **${displayName}**${tag} logged in to TheFieldMixtape.`;
  await postToDiscord(content, { webhookUrl, fetchFn, logError, what: "login", sleepFn });
}

// Only meant to be called for a real (non-dry-run) publish — the caller
// decides that, this module doesn't know about dryRun at all. `added`/
// `deleted` are the human-readable track names processPublish already
// returns (see src/publish.js's addedNames/deletedNames), not filenames.
export async function notifyPublish(
  { displayName, added = [], deleted = [], versionNumber, thunderstoreUrl },
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, logError = logErrorDefault, sleepFn } = {}
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
  await postToDiscord(lines.join("\n"), { webhookUrl, fetchFn, logError, what: "publish", sleepFn });
}
