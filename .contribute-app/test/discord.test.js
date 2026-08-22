import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyLogin, notifyPublish } from "../src/discord.js";

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

// --- notifyPublish ---

test("notifyPublish does nothing when no webhook URL is configured", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    { displayName: "Rob", added: ["A - B"], deleted: [], versionNumber: "1.4.8" },
    { webhookUrl: undefined, fetchFn }
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
    { webhookUrl: "https://discord.example/webhook", fetchFn }
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
    { webhookUrl: "https://discord.example/webhook", fetchFn }
  );
  const body = JSON.parse(fetchFn.calls[0].options.body);
  assert.doesNotMatch(body.content, /Added:/);
  assert.match(body.content, /Removed:/);
});

test("notifyPublish omits the Removed section entirely when nothing was deleted", async () => {
  const fetchFn = fakeFetch();
  await notifyPublish(
    { displayName: "Rob", added: ["New Track - Someone"], deleted: [], versionNumber: "1.4.9" },
    { webhookUrl: "https://discord.example/webhook", fetchFn }
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
    { webhookUrl: "https://discord.example/webhook", fetchFn }
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
      { webhookUrl: "https://discord.example/webhook", fetchFn, logError: (...args) => logLines.push(args.join(" ")) }
    )
  );
  assert.ok(logLines.some((l) => l.includes("500")));
});
