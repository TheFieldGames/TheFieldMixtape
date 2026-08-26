// A thin relay that exists for exactly one reason: Render's shared outbound
// IP got caught in a Cloudflare-level rate limit block on discord.com
// (Cloudflare Error 1015 — not a Discord API rate limit at all), and no
// amount of retry/backoff logic on the app side can route around an IP
// ban. This Worker runs on Cloudflare's own edge network instead, so it
// posts to Discord from a completely different IP pool than Render's.
//
// The real Discord webhook URLs live only here, as Worker secrets — never
// passed in by the caller — so even if this Worker's public URL leaks, it
// can only ever relay to these preconfigured webhooks, not act as an open
// relay to anywhere an attacker chooses. Access is additionally gated by a
// shared secret header, checked before any of that.
//
// A "publish" event (src/discord.js's notifyPublish, tagged via the
// X-Notification-Type header) also fans out to DISCORD_WEBHOOK_URL_SECONDARY
// — a second, more public channel — while a "login" event only ever goes to
// the primary. The secondary send is fire-and-forget (ctx.waitUntil, not
// awaited before responding) and never affects the response the caller
// sees: that's still driven entirely by the primary webhook, same as
// before this existed. If DISCORD_WEBHOOK_URL_SECONDARY isn't set, nothing
// fans out at all — this app works exactly as it always did.
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const providedSecret = request.headers.get("X-Relay-Secret");
    if (!env.RELAY_SECRET || providedSecret !== env.RELAY_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!env.DISCORD_WEBHOOK_URL) {
      return new Response("Relay not configured", { status: 500 });
    }

    const notificationType = request.headers.get("X-Notification-Type");
    const body = await request.text();

    if (notificationType === "publish" && env.DISCORD_WEBHOOK_URL_SECONDARY) {
      const secondaryPost = fetch(env.DISCORD_WEBHOOK_URL_SECONDARY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch((err) => {
        console.error("Secondary webhook post failed:", err.message);
      });
      ctx.waitUntil(secondaryPost);
    }

    const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    // Passed through verbatim — status, body, and content-type — so the
    // caller's existing response-parsing logic (which inspects Discord's
    // real status/body/headers) keeps working unchanged whether it's
    // talking to Discord directly or through this relay.
    const responseBody = await discordResponse.text();
    return new Response(responseBody, {
      status: discordResponse.status,
      headers: { "Content-Type": discordResponse.headers.get("content-type") ?? "application/json" },
    });
  },
};
