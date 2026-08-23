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
// if neither is present or parseable (e.g. a minimal fake Response in
// tests). The body also carries `global`, which distinguishes two very
// different failure modes: `false` means just this webhook/route is over
// its own limit; `true` means Discord is throttling the whole caller (IP
// or bot token), not this specific request — common on shared-IP hosting
// (Render's free tier, Cloudflare Workers, etc.), where unrelated traffic
// from other tenants on the same IP pool can trip it.
//
// A Response's body can only be read once (it's a stream) — read the raw
// text first, then JSON.parse it ourselves, so both the parsed fields
// *and* the untouched raw body are available. Every response header is
// captured too, not just the couple of named X-RateLimit-* ones we
// initially guessed mattered — a rate limit weird enough to need this much
// diagnosis (e.g. a Discord-documented-as-per-webhook limit that turns out
// to be scoped to something else entirely) is exactly the case where an
// unanticipated header or body field ends up being the useful one, and
// there's no way to know which one that'll be in advance.
async function parseRateLimitInfo(response) {
  let rawBody = null;
  let body = null;
  try {
    rawBody = await response.text();
    body = JSON.parse(rawBody);
  } catch {
    // Not JSON, empty, or (for a minimal test double with no .text() at
    // all) unreadable this way — body/rawBody stay null; retryAfterSeconds
    // below falls back to the header, then to a plain 1s guess.
  }

  let retryAfterSeconds = typeof body?.retry_after === "number" ? body.retry_after : null;
  if (retryAfterSeconds === null) {
    const header = response.headers?.get?.("retry-after");
    const parsed = header ? Number(header) : NaN;
    retryAfterSeconds = Number.isFinite(parsed) ? parsed : 1;
  }
  const global = body?.global === true;

  const headers = {};
  if (response.headers?.forEach) {
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (response.headers?.entries) {
    for (const [key, value] of response.headers.entries()) headers[key] = value;
  }

  return { retryAfterSeconds, global, body, rawBody, headers };
}

// Dumps the whole captured picture — the parsed body if it parsed, the raw
// text if it didn't, and every header Discord sent back — rather than a
// curated subset, so nothing potentially-useful gets silently discarded
// before we even see it once.
function describeRateLimit({ global, retryAfterSeconds, body, rawBody, headers }) {
  const bodyPart = body ? JSON.stringify(body) : rawBody ? `<unparsed: ${rawBody}>` : "<empty>";
  const headerPart = Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return `global: ${global}, retry_after: ${retryAfterSeconds}s, body: ${bodyPart}${headerPart ? `, headers: [${headerPart}]` : ""}`;
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
