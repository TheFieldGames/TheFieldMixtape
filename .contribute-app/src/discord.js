import { logError as logErrorDefault } from "./logger.js";

// DISCORD_WEBHOOK_URL is optional, same reasoning as ADMIN_PASSWORD_HASH —
// deployments that don't set it simply never send notifications, rather
// than failing to boot. fetchFn/logError are injected for tests, matching
// the rest of this app's real-I/O-behind-a-default-param pattern (see
// src/convert.js, src/tcli.js).
export async function notifyLogin(
  { displayName, isAdmin = false, isDemo = false },
  { webhookUrl = process.env.DISCORD_WEBHOOK_URL, fetchFn = fetch, logError = logErrorDefault } = {}
) {
  if (!webhookUrl) return;

  const tag = isDemo ? " (demo)" : isAdmin ? " (admin)" : "";
  const content = `🎧 **${displayName}**${tag} logged in to TheFieldMixtape.`;

  // Never let a notification failure surface to the caller — login must
  // succeed regardless of whether Discord is reachable. Errors are logged,
  // not thrown, so callers can fire this without awaiting or catching.
  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      logError(`Discord login notification failed: HTTP ${response.status}`);
    }
  } catch (err) {
    logError("Discord login notification failed:", err.message);
  }
}
