// A direct connectivity check against Thunderstore's own API, run from
// wherever this app is actually deployed — the same raw-response-capture
// technique that found the Cloudflare Error 1015 block on discord.com
// (see src/discord.js). tcli itself only ever surfaces a generic "upload
// failed" message on this kind of failure (it's a compiled binary we don't
// control, unlike our own fetch calls), so this exists specifically to get
// the same quality of evidence for Thunderstore that discord.js's
// full-response logging got for Discord: is Render's outbound IP also
// blocked from reaching thunderstore.io, or is something else going on?
const THUNDERSTORE_API_URL = "https://thunderstore.io/api/experimental/package/TheField/TheFieldMixtape/";

export async function checkThunderstoreConnectivity({ fetchFn = fetch, url = THUNDERSTORE_API_URL } = {}) {
  try {
    const response = await fetchFn(url);
    const rawBody = await response.text();
    let parsedVersion = null;
    try {
      parsedVersion = JSON.parse(rawBody)?.latest?.version_number ?? null;
    } catch {
      // Not JSON — most likely exactly the case this exists to catch: a
      // Cloudflare block page instead of Thunderstore's real API response.
    }
    const headers = {};
    if (response.headers?.forEach) {
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
    }
    return {
      ok: response.ok,
      status: response.status,
      isJson: parsedVersion !== null,
      latestVersionNumber: parsedVersion,
      // Capped — this exists to spot a Cloudflare block page (or any other
      // non-JSON response) in the logs, not to dump a full HTML document.
      bodySnippet: rawBody.slice(0, 500),
      headers,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
