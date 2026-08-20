import { test } from "node:test";
import assert from "node:assert/strict";
import { injectPatIntoUrl, loadConfig } from "../src/config.js";

test("injectPatIntoUrl embeds x-access-token:<PAT> into an HTTPS GitHub URL", () => {
  const url = injectPatIntoUrl("https://github.com/TheFieldGames/TheFieldMixtape.git", "ghp_secrettoken123");
  assert.equal(url, "https://x-access-token:ghp_secrettoken123@github.com/TheFieldGames/TheFieldMixtape.git");
});

test("injectPatIntoUrl URL-encodes special characters in the token safely", () => {
  const url = injectPatIntoUrl("https://github.com/Org/Repo.git", "token/with special@chars");
  const parsed = new URL(url);
  assert.equal(parsed.password, encodeURIComponent("token/with special@chars"));
});

const FULL_ENV = {
  APP_PASSWORD_HASH: "$2a$10$fakehash",
  SESSION_SECRET: "random-secret",
  GITHUB_PAT: "ghp_token",
  GIT_REPO_URL: "https://github.com/TheFieldGames/TheFieldMixtape.git",
  TCLI_AUTH_TOKEN: "tss_token",
  R2_ACCOUNT_ID: "account123",
  R2_ACCESS_KEY_ID: "keyid",
  R2_SECRET_ACCESS_KEY: "secretkey",
  R2_BUCKET_NAME: "thefieldmixtape-audio",
};

test("loadConfig throws listing every missing required env var (not just the first)", () => {
  assert.throws(() => loadConfig({}), (err) => {
    for (const key of [
      "APP_PASSWORD_HASH",
      "SESSION_SECRET",
      "GITHUB_PAT",
      "GIT_REPO_URL",
      "TCLI_AUTH_TOKEN",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
    ]) {
      assert.ok(err.message.includes(key), `expected error to mention ${key}`);
    }
    return true;
  });
});

test("loadConfig succeeds and wires everything together when all required vars are present", () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.port, 3000);
  assert.equal(config.branch, "main");
  assert.equal(config.tcliPath, "tcli");
  assert.equal(config.r2Bucket, "thefieldmixtape-audio");
  assert.equal(config.repoUrl, "https://x-access-token:ghp_token@github.com/TheFieldGames/TheFieldMixtape.git");
  assert.ok(config.r2Client, "should construct a real R2 client instance");
});

test("loadConfig respects PORT and GIT_TARGET_BRANCH overrides", () => {
  const config = loadConfig({ ...FULL_ENV, PORT: "8080", GIT_TARGET_BRANCH: "contribute-app-test" });
  assert.equal(config.port, 8080);
  assert.equal(config.branch, "contribute-app-test");
});

test("loadConfig defaults trackBandwidth to true (safe default — Render is protected even with no extra config)", () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.trackBandwidth, true);
});

test("loadConfig only disables trackBandwidth on the exact opt-out value 'true', not any other truthy string", () => {
  assert.equal(loadConfig({ ...FULL_ENV, DISABLE_BANDWIDTH_TRACKING: "true" }).trackBandwidth, false);
  assert.equal(loadConfig({ ...FULL_ENV, DISABLE_BANDWIDTH_TRACKING: "false" }).trackBandwidth, true);
  assert.equal(loadConfig({ ...FULL_ENV, DISABLE_BANDWIDTH_TRACKING: "1" }).trackBandwidth, true);
  assert.equal(loadConfig({ ...FULL_ENV, DISABLE_BANDWIDTH_TRACKING: "yes" }).trackBandwidth, true);
});
