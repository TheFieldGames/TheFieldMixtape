import { logError as logErrorDefault } from "./logger.js";

// Shared by notifyLogin/notifyPublish below. Never throws — a broken or
// unreachable webhook must never surface as a failure to the caller, since
// neither a login nor a publish should ever be blocked or failed by a
// notification going wrong. webhookUrl/fetchFn/logError are injected so
// tests never make a real network call.
async function postToDiscord(content, { webhookUrl, fetchFn, logError, what }) {
  if (!webhookUrl) return;
  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
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
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, logError = logErrorDefault } = {}
) {
  const tag = isDemo ? " (demo)" : isAdmin ? " (admin)" : "";
  const content = `🎧 **${displayName}**${tag} logged in to TheFieldMixtape.`;
  await postToDiscord(content, { webhookUrl, fetchFn, logError, what: "login" });
}

// Only meant to be called for a real (non-dry-run) publish — the caller
// decides that, this module doesn't know about dryRun at all. `added`/
// `deleted` are the human-readable track names processPublish already
// returns (see src/publish.js's addedNames/deletedNames), not filenames.
export async function notifyPublish(
  { displayName, added = [], deleted = [], versionNumber, thunderstoreUrl },
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, logError = logErrorDefault } = {}
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
  await postToDiscord(lines.join("\n"), { webhookUrl, fetchFn, logError, what: "publish" });
}
