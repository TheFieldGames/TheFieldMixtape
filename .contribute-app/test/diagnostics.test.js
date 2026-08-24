import { test } from "node:test";
import assert from "node:assert/strict";
import { checkThunderstoreConnectivity } from "../src/diagnostics.js";

function fakeFetch(response) {
  return async () => response;
}

test("a real JSON API response is recognized as such, with the version number extracted", async () => {
  const body = JSON.stringify({ latest: { version_number: "1.0.20" } });
  const fetchFn = fakeFetch({ ok: true, status: 200, text: async () => body, headers: { forEach: () => {} } });

  const result = await checkThunderstoreConnectivity({ fetchFn });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.isJson, true);
  assert.equal(result.latestVersionNumber, "1.0.20");
});

test("a non-JSON response (e.g. a Cloudflare block page) is flagged as such, with a body snippet captured", async () => {
  const html = "<!doctype html><title>Error 1015</title>You are being rate limited.";
  const fetchFn = fakeFetch({ ok: false, status: 429, text: async () => html, headers: { forEach: () => {} } });

  const result = await checkThunderstoreConnectivity({ fetchFn });

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.isJson, false);
  assert.equal(result.latestVersionNumber, null);
  assert.match(result.bodySnippet, /Error 1015/);
});

test("every response header is captured", async () => {
  const headerEntries = { "cf-ray": "abc123", server: "cloudflare" };
  const fetchFn = fakeFetch({
    ok: false,
    status: 429,
    text: async () => "blocked",
    headers: { forEach: (cb) => Object.entries(headerEntries).forEach(([k, v]) => cb(v, k)) },
  });

  const result = await checkThunderstoreConnectivity({ fetchFn });

  assert.equal(result.headers["cf-ray"], "abc123");
  assert.equal(result.headers.server, "cloudflare");
});

test("a body long enough to matter is truncated, not dumped in full", async () => {
  const longBody = "x".repeat(2000);
  const fetchFn = fakeFetch({ ok: true, status: 200, text: async () => longBody, headers: { forEach: () => {} } });

  const result = await checkThunderstoreConnectivity({ fetchFn });

  assert.equal(result.bodySnippet.length, 500);
});

test("a network-level failure (fetchFn rejects) is caught and reported, not thrown", async () => {
  const fetchFn = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  await assert.doesNotReject(checkThunderstoreConnectivity({ fetchFn }));
  const result = await checkThunderstoreConnectivity({ fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
});
