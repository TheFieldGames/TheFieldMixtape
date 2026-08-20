import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSemverTags,
  getHighestVersion,
  bumpPatch,
  formatVersionNumber,
  formatTagName,
  computeNextVersion,
  fetchNextVersion,
} from "../src/version.js";

const REAL_LS_REMOTE_FIXTURE = `
e9f8a1c\trefs/tags/v1.0.0
1a2b3c4\trefs/tags/v1.0.1
2b3c4d5\trefs/tags/v1.0.10
3c4d5e6\trefs/tags/v1.0.10^{}
4d5e6f7\trefs/tags/v1.0.11
5e6f7a8\trefs/tags/v1.0.11^{}
6f7a8b9\trefs/tags/v1.0.2
`.trim();

test("parseSemverTags extracts vX.Y.Z tags and de-dupes annotated ^{} peel lines", () => {
  const versions = parseSemverTags(REAL_LS_REMOTE_FIXTURE);
  assert.equal(versions.length, 5);
  assert.deepEqual(versions.map(formatVersionNumber).sort(), ["1.0.0", "1.0.1", "1.0.10", "1.0.11", "1.0.2"].sort());
});

test("parseSemverTags ignores non-semver / malformed tags", () => {
  const versions = parseSemverTags("abc\trefs/tags/not-a-version\ndef\trefs/tags/v1.2\nghi\trefs/tags/v1.2.3");
  assert.equal(versions.length, 1);
  assert.equal(formatVersionNumber(versions[0]), "1.2.3");
});

test("getHighestVersion picks the numerically highest version, not lexicographically highest (v1.0.2 vs v1.0.10)", () => {
  const versions = parseSemverTags(REAL_LS_REMOTE_FIXTURE);
  const highest = getHighestVersion(versions);
  assert.equal(formatVersionNumber(highest), "1.0.11");
});

test("getHighestVersion returns null for an empty list", () => {
  assert.equal(getHighestVersion([]), null);
});

test("bumpPatch increments only the patch component", () => {
  assert.deepEqual(bumpPatch({ major: 1, minor: 0, patch: 11 }), { major: 1, minor: 0, patch: 12 });
});

test("formatTagName keeps the v prefix, formatVersionNumber strips it", () => {
  const v = { major: 1, minor: 4, patch: 7 };
  assert.equal(formatVersionNumber(v), "1.4.7");
  assert.equal(formatTagName(v), "v1.4.7");
});

test("computeNextVersion end-to-end against the real repo's current tag shape yields v1.0.12", () => {
  const result = computeNextVersion(REAL_LS_REMOTE_FIXTURE);
  assert.equal(result.versionNumber, "1.0.12");
  assert.equal(result.tagName, "v1.0.12");
});

test("computeNextVersion throws when no vX.Y.Z tags exist at all", () => {
  assert.throws(() => computeNextVersion(""), /No existing/);
});

test("fetchNextVersion wraps git ls-remote via the injected exec function", async () => {
  let calledWith = null;
  const fakeExecFile = async (cmd, args) => {
    calledWith = [cmd, args];
    return { stdout: "abc\trefs/tags/v2.3.4\n" };
  };
  const result = await fetchNextVersion("https://github.com/TheFieldGames/TheFieldMixtape.git", fakeExecFile);
  assert.deepEqual(calledWith, ["git", ["ls-remote", "--tags", "https://github.com/TheFieldGames/TheFieldMixtape.git"]]);
  assert.equal(result.versionNumber, "2.3.5");
});
