import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNamePart, buildTrackFilename, isMp3Filename } from "../src/filename.js";

test("buildTrackFilename joins title and artist with the existing repo convention", () => {
  assert.equal(buildTrackFilename("Nightcall", "Kavinsky"), "Nightcall - Kavinsky.ogg");
});

test("sanitizeNamePart trims surrounding whitespace", () => {
  assert.equal(sanitizeNamePart("  Nightcall  "), "Nightcall");
});

test("sanitizeNamePart strips filesystem-illegal characters", () => {
  assert.equal(sanitizeNamePart('Bad/Name\\With:Illegal*Chars?"<>|'), "BadNameWithIllegalChars");
});

test("buildTrackFilename preserves characters that are legal but notable (parens, commas, apostrophes)", () => {
  assert.equal(
    buildTrackFilename("Bangarang (Ft. Sirah)", "Skrillex"),
    "Bangarang (Ft. Sirah) - Skrillex.ogg"
  );
  assert.equal(
    buildTrackFilename("Don't Stop Me Now", "Queen"),
    "Don't Stop Me Now - Queen.ogg"
  );
});

test("sanitizeNamePart throws on empty input", () => {
  assert.throws(() => sanitizeNamePart(""), /empty/);
});

test("sanitizeNamePart throws when only illegal characters are given", () => {
  assert.throws(() => sanitizeNamePart('///:::'), /empty/);
});

test("isMp3Filename accepts .mp3, case-insensitively", () => {
  assert.equal(isMp3Filename("song.mp3"), true);
  assert.equal(isMp3Filename("song.MP3"), true);
  assert.equal(isMp3Filename("Song.Mp3"), true);
});

test("isMp3Filename rejects other extensions, including near-misses", () => {
  assert.equal(isMp3Filename("song.wav"), false);
  assert.equal(isMp3Filename("song.mp4"), false);
  assert.equal(isMp3Filename("song.mp3.exe"), false);
  assert.equal(isMp3Filename("song"), false);
});

test("isMp3Filename handles missing/empty input without throwing", () => {
  assert.equal(isMp3Filename(""), false);
  assert.equal(isMp3Filename(undefined), false);
  assert.equal(isMp3Filename(null), false);
});
