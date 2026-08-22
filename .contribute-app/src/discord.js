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
// doesn't implement .json()/.headers).
async function getRetryAfterSeconds(response) {
  try {
    const body = await response.json();
    if (typeof body?.retry_after === "number") return body.retry_after;
  } catch {
    // Not JSON, already consumed, or no .json() at all — fall through.
  }
  const header = response.headers?.get?.("retry-after");
  const parsed = header ? Number(header) : NaN;
  return Number.isFinite(parsed) ? parsed : 1;
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
    if (response.status === 429 && !retried) {
      const retryAfterSeconds = Math.min(await getRetryAfterSeconds(response), MAX_RETRY_AFTER_SECONDS);
      await sleepFn(retryAfterSeconds * 1000);
      return postToDiscord(content, { webhookUrl, fetchFn, logError, what, sleepFn, retried: true });
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
