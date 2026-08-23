// A thin relay that exists for exactly one reason: Render's shared outbound
// IP got caught in a Cloudflare-level rate limit block on discord.com
// (Cloudflare Error 1015 — not a Discord API rate limit at all), and no
// amount of retry/backoff logic on the app side can route around an IP
// ban. This Worker runs on Cloudflare's own edge network instead, so it
// posts to Discord from a completely different IP pool than Render's.
//
// The real Discord webhook URL lives only here, as a Worker secret — never
// passed in by the caller — so even if this Worker's public URL leaks,
// it can only ever relay to this one preconfigured webhook, not act as an
// open relay to anywhere an attacker chooses. Access is additionally
// gated by a shared secret header, checked before any of that.
export default {
  async fetch(request, env) {
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

    const body = await request.text();
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
