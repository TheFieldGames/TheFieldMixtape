import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyLogin } from "../src/discord.js";

function fakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  fn.calls = calls;
  return fn;
}

test("notifyLogin does nothing (never calls fetch) when no webhook URL is configured", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Rob" }, { webhookUrl: undefined, fetchFn });
  assert.equal(fetchFn.calls.length, 0);
});

test("notifyLogin POSTs the webhook URL with a JSON content body naming the display name", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Rob" }, { webhookUrl: "https://discord.example/webhook", fetchFn });

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
  await notifyLogin({ displayName: "Rob", isAdmin: true }, { webhookUrl: "https://discord.example/webhook", fetchFn });
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /\(admin\)/);
});

test("notifyLogin tags a demo login distinctly, and demo wins over admin if somehow both were true", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin(
    { displayName: "Demo", isAdmin: true, isDemo: true },
    { webhookUrl: "https://discord.example/webhook", fetchFn }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.match(body.content, /\(demo\)/);
  assert.doesNotMatch(body.content, /\(admin\)/);
});

test("a plain login (neither admin nor demo) gets no parenthetical tag at all", async () => {
  const fetchFn = fakeFetch();
  await notifyLogin({ displayName: "Alex" }, { webhookUrl: "https://discord.example/webhook", fetchFn });
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.doesNotMatch(body.content, /\(/);
});

test("a non-ok webhook response is logged, not thrown", async () => {
  const fetchFn = fakeFetch({ ok: false, status: 500 });
  const logLines = [];
  await assert.doesNotReject(
    notifyLogin(
      { displayName: "Rob" },
      { webhookUrl: "https://discord.example/webhook", fetchFn, logError: (...args) => logLines.push(args.join(" ")) }
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
      { webhookUrl: "https://discord.example/webhook", fetchFn, logError: (...args) => logLines.push(args.join(" ")) }
    )
  );
  assert.ok(logLines.some((l) => l.includes("ENOTFOUND")));
});
