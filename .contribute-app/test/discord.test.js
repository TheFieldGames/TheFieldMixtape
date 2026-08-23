import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyLogin, notifyPublish } from "../src/discord.js";

const NOOP_LOG = () => {};

function fakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  fn.calls = calls;
  return fn;
}

// Returns a different response on each successive call — used to simulate
// "429, then a real 200 on retry" without a real network.
function fakeFetchSequence(...responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

function rateLimitResponse(retryAfterSeconds, global = false, headers = {}, extraBodyFields = {}) {
  const bodyText = JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfterSeconds, global, ...extraBodyFields });
  const allHeaders = { "retry-after": String(retryAfterSeconds), ...headers };
  const lowerHeaders = Object.fromEntries(Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: false,
    status: 429,
    text: async () => bodyText,
    headers: {
      get: (name) => lowerHeaders[name.toLowerCase()] ?? null,
      forEach: (cb) => Object.entries(lowerHeaders).forEach(([key, value]) => cb(value, key)),
    },
  };
}

// A response with no body at all — Discord's real 429s are always JSON,
// but a proxy/edge layer sitting in front of it (unrelated to Discord's own
// API) could plausibly return something else entirely.
function unparseableRateLimitResponse() {
  return {
    ok: false,
    status: 429,
    text: async () => "<html>rate limited</html>",
    headers: { get: () => null, forEach: () => {} },
  };
}

function fakeSleep() {
  const waits = [];
  const fn = async (ms) => {
    waits.push(ms);
  };
  fn.waits = waits;
  return fn;
}

test("notifyLogin does nothing (never calls fetch) when no webhook URL is configured", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Rob" }, { webhookUrl: undefined, fetchFn, log: NOOP_LOG });
  assert.equal(fetchFn.calls.length, 0);
});

test("notifyLogin POSTs the webhook URL with a JSON content body naming the display name", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Rob" }, { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG });

  assert.equal(fetchFn.calls.length, 1);
  const { url, options } = fetchFn.calls[0];
  assert.equal(url, "https://discord.example/webhook");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["Content-Type"], "application/json");
  const body = JSON.parse(options.body);
  assert.match(body.content, /Rob/);
});

test("notifyLogin tags an admin login distinctly from a plain one", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin(
    { displayName: "Rob", isAdmin: true },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /\(admin\)/);
});

test("notifyLogin tags a demo login distinctly, and demo wins over admin if somehow both were true", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin(
    { displayName: "Demo", isAdmin: true, isDemo: true },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /\(demo\)/);
  assert.doesNotMatch(body.content, /\(admin\)/);
});

test("a plain login (neither admin nor demo) gets no parenthetical tag at all", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Alex" }, { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG });
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.doesNotMatch(body.content, /\(/);
});

test("a non-ok webhook response is logged, not thrown", async () => {
  const fetchFn = fakeFetch({ ok: false, status: 500 });
  const logLines = [];
  await assert.doesNotReject(
    notifyLogin(
      { displayName: "Rob" },
      { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
    )
  );
  assert.ok(logLines.some((l) => l.includes("500")));
});

test("a network-level failure (fetchFn rejects) is caught and logged, not thrown", async () => {
  const fetchFn = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const logLines = [];
  await assert.doesNotReject(
    notifyLogin(
      { displayName: "Rob" },
      { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
    )
  );
  assert.ok(logLines.some((l) => l.includes("ENOTFOUND")));
});

// --- Per-attempt logging (the diagnostic for telling apart a real overlap
// in activity from a duplicate-call bug — see the comment on
// postToDiscord in src/discord.js) ---

test("a successful notification logs exactly one 'attempt 1' line", async () => {
  const fetchFn = fakeFetch();
  const logLines = [];
  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: (...args) => logLines.push(args.join(" ")) }
  );
  assert.deepEqual(
    logLines.filter((l) => l.includes("Discord login notification: attempt")),
    ["Discord login notification: attempt 1"]
  );
});

test("a retried notification logs both attempt 1 and attempt 2, in order", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.1), { ok: true, status: 200 });
  const sleepFn = fakeSleep();
  const logLines = [];
  await notifyPublish(
    { displayName: "Rob", added: ["A - B"], deleted: [], versionNumber: "1.0.0" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: (...args) => logLines.push(args.join(" ")) }
  );
  assert.deepEqual(
    logLines.filter((l) => l.includes("Discord publish notification: attempt")),
    ["Discord publish notification: attempt 1", "Discord publish notification: attempt 2"]
  );
});

test("nothing is logged at all (attempt or otherwise) when no webhook URL is configured", async () => {
  const fetchFn = fakeFetch();
  const logLines = [];
  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: undefined, fetchFn, log: (...args) => logLines.push(args.join(" ")) }
  );
  assert.equal(logLines.length, 0);
});

// --- notifyPublish ---

test("notifyPublish does nothing when no webhook URL is configured", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    { displayName: "Rob", added: ["A - B"], deleted: [], versionNumber: "1.4.8" },
    { webhookUrl: undefined, fetchFn, log: NOOP_LOG }
  );
  assert.equal(fetchFn.calls.length, 0);
});

test("notifyPublish names who published, the version, and lists both added and deleted tracks", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    {
      displayName: "Rob",
      added: ["Electric Feel (Justice Remix) - MGMT, Justice"],
      deleted: ["Do I Wanna Know - Arctic Monkeys"],
      versionNumber: "1.4.8",
      thunderstoreUrl: "https://thunderstore.io/c/peak/p/TheField/TheFieldMixtape/",
    },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );

  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /Rob/);
  assert.match(body.content, /1\.4\.8/);
  assert.match(body.content, /Added:/);
  assert.match(body.content, /Electric Feel \(Justice Remix\) - MGMT, Justice/);
  assert.match(body.content, /Removed:/);
  assert.match(body.content, /Do I Wanna Know - Arctic Monkeys/);
  assert.match(body.content, /thunderstore\.io/);
});

test("notifyPublish omits the Added section entirely when nothing was added", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    { displayName: "Rob", added: [], deleted: ["Old Track - Someone"], versionNumber: "1.4.9" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.doesNotMatch(body.content, /Added:/);
  assert.match(body.content, /Removed:/);
});

test("notifyPublish omits the Removed section entirely when nothing was deleted", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    { displayName: "Rob", added: ["New Track - Someone"], deleted: [], versionNumber: "1.4.9" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /Added:/);
  assert.doesNotMatch(body.content, /Removed:/);
});

test("notifyPublish lists every added and deleted track, not just a count", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    {
      displayName: "Rob",
      added: ["Track One - Artist", "Track Two - Artist"],
      deleted: ["Track Three - Artist"],
      versionNumber: "2.0.0",
    },
    { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /Track One - Artist/);
  assert.match(body.content, /Track Two - Artist/);
  assert.match(body.content, /Track Three - Artist/);
});

test("a non-ok webhook response for a publish notification is logged, not thrown", async () => {
  const fetchFn = fakeFetch({ ok: false, status: 500 });
  const logLines = [];
  await assert.doesNotReject(
    notifyPublish(
      { displayName: "Rob", added: ["A - B"], deleted: [], versionNumber: "1.0.0" },
      { webhookUrl: "https://discord.example/webhook", fetchFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
    )
  );
  assert.ok(logLines.some((l) => l.includes("500")));
});

// --- 429 retry (see the doc comment on postToDiscord in src/discord.js) ---

test("a 429 is retried once, waiting the exact retry_after Discord requested, and succeeds if the retry lands", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.5), { ok: true, status: 200 });
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  assert.equal(fetchFn.calls.length, 2, "the original request plus exactly one retry");
  assert.deepEqual(sleepFn.waits, [500], "waited retry_after (0.5s) converted to milliseconds");
  assert.equal(logLines.length, 0, "a retry that succeeds logs nothing — it's not a failure from the caller's perspective");
});

test("a 429 followed by a second 429 only retries once and logs the final failure, noting global: false", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.2, false), rateLimitResponse(0.2, false));
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  assert.equal(fetchFn.calls.length, 2, "never more than one retry, even if the retry is also rate limited");
  assert.equal(sleepFn.waits.length, 1);
  assert.ok(logLines.some((l) => l.includes("429")));
  assert.ok(logLines.some((l) => l.includes("global: false")));
  assert.ok(logLines.some((l) => l.includes("retry_after: 0.2s")), "the final failure line names the real retry_after Discord asked for");
});

test("a global: true 429 is logged distinctly — the signal to look at shared-IP rate limiting, not this app's own call volume", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.2, true), rateLimitResponse(0.2, true));
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  assert.ok(logLines.some((l) => l.includes("global: true")));
});

test("the retry wait is capped, regardless of how long Discord asks for", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(9999), { ok: true, status: 200 });
  const sleepFn = fakeSleep();

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: () => {} }
  );

  assert.ok(sleepFn.waits[0] <= 30000, `waited ${sleepFn.waits[0]}ms, expected the 30s cap to apply`);
});

test("the real, uncapped retry_after Discord asked for is logged even when it exceeds the cap", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(9999), { ok: true, status: 200 });
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: (...args) => logLines.push(args.join(" ")), logError: () => {} }
  );

  assert.ok(
    logLines.some((l) => l.includes("9999") && l.includes("waiting 30s")),
    `expected a log line naming both the real requested wait and the capped wait, got: ${JSON.stringify(logLines)}`
  );
});

test("Discord's X-RateLimit-Scope/Bucket/Limit/Remaining headers are surfaced in the failure log when present", async () => {
  const headers = {
    "X-RateLimit-Scope": "shared",
    "X-RateLimit-Bucket": "abc123",
    "X-RateLimit-Limit": "5",
    "X-RateLimit-Remaining": "0",
  };
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.2, false, headers), rateLimitResponse(0.2, false, headers));
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  const failureLine = logLines.find((l) => l.includes("failed"));
  assert.ok(failureLine, "expected a final failure line");
  assert.match(failureLine, /x-ratelimit-scope=shared/);
  assert.match(failureLine, /x-ratelimit-bucket=abc123/);
  assert.match(failureLine, /x-ratelimit-limit=5/);
  assert.match(failureLine, /x-ratelimit-remaining=0/);
});

test("rate-limit headers that are absent are simply omitted from the log line, not printed as null/undefined", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.2, false), rateLimitResponse(0.2, false));
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  const failureLine = logLines.find((l) => l.includes("failed"));
  assert.doesNotMatch(failureLine, /x-ratelimit-scope|x-ratelimit-bucket|x-ratelimit-limit|x-ratelimit-remaining|null|undefined/);
});

test("the retry-after header itself always shows up in the full header dump", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.2, false), rateLimitResponse(0.2, false));
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  const failureLine = logLines.find((l) => l.includes("failed"));
  assert.match(failureLine, /retry-after=0\.2/);
});

test("an unanticipated body field Discord sends is included in the log too, not just the known ones", async () => {
  const fetchFn = fakeFetchSequence(
    rateLimitResponse(0.2, false, {}, { code: 20028, some_new_field: "surprise" }),
    rateLimitResponse(0.2, false, {}, { code: 20028, some_new_field: "surprise" })
  );
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  const failureLine = logLines.find((l) => l.includes("failed"));
  assert.match(failureLine, /"code":20028/);
  assert.match(failureLine, /"some_new_field":"surprise"/);
});

test("a 429 with a body that isn't valid JSON logs the raw text instead of silently dropping it", async () => {
  const fetchFn = fakeFetchSequence(unparseableRateLimitResponse(), unparseableRateLimitResponse());
  const sleepFn = fakeSleep();
  const logLines = [];

  await notifyLogin(
    { displayName: "Rob" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: (...args) => logLines.push(args.join(" ")) }
  );

  const failureLine = logLines.find((l) => l.includes("failed"));
  assert.match(failureLine, /<unparsed: <html>rate limited<\/html>>/);
});

test("notifyPublish also retries a 429 the same way", async () => {
  const fetchFn = fakeFetchSequence(rateLimitResponse(0.1), { ok: true, status: 200 });
  const sleepFn = fakeSleep();

  await notifyPublish(
    { displayName: "Rob", added: ["A - B"], deleted: [], versionNumber: "1.0.0" },
    { webhookUrl: "https://discord.example/webhook", fetchFn, sleepFn, log: NOOP_LOG, logError: () => {} }
  );

  assert.equal(fetchFn.calls.length, 2);
});
