import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { regenerateReadme, sortTrackNames } from "../src/readme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_README_PATH = path.join(__dirname, "..", "..", "README.md");

function extractTrackNamesFromReadme(readmeText) {
  const match = readmeText.match(/<!-- TRACKLIST:START -->\n([\s\S]*?)\n<!-- TRACKLIST:END -->/);
  assert.ok(match, "fixture README must have a TRACKLIST block to extract from");
  return match[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s/, ""));
}

test("regenerateReadme is a no-op (byte-identical) when given the exact same track list back", () => {
  const readmeText = fs.readFileSync(REAL_README_PATH, "utf8");
  const currentTracks = extractTrackNamesFromReadme(readmeText);
  const result = regenerateReadme(readmeText, currentTracks);
  assert.equal(result, readmeText);
});

test("regenerateReadme inserts a new track in correct sorted position and renumbers everything after it", () => {
  const readmeText = fs.readFileSync(REAL_README_PATH, "utf8");
  const currentTracks = extractTrackNamesFromReadme(readmeText);
  assert.equal(currentTracks.length, 57, "sanity check on the real README's current track count");

  const withNewTrack = regenerateReadme(readmeText, [...currentTracks, "Bohemian Rhapsody - Queen"]);
  const newTracks = extractTrackNamesFromReadme(withNewTrack);

  assert.equal(newTracks.length, 58);
  // "Bohemian..." sorts case-insensitively right after "Bangarang..." (both start with B, "Bo" > "Ba")
  // and before "Break Stuff" ("Bo" < "Br") — verify it landed in the right slot, not just appended.
  const idx = newTracks.indexOf("Bohemian Rhapsody - Queen");
  assert.ok(idx > 0, "new track should be found in the regenerated list");
  assert.equal(newTracks[idx - 1], "Because I'm Me - The Avalanches");
  assert.equal(newTracks[idx + 1], "Break Stuff - Limp Bizkit");

  // Numbering is sequential starting at 1 with no gaps
  const lines = withNewTrack.match(/<!-- TRACKLIST:START -->\n([\s\S]*?)\n<!-- TRACKLIST:END -->/)[1].split("\n");
  lines.forEach((line, i) => {
    assert.match(line, new RegExp(`^${i + 1}\\. `));
  });

  // Everything outside the sentinel block is untouched
  assert.ok(withNewTrack.startsWith("# TheFieldMixtape"));
  assert.ok(withNewTrack.includes("Want to add a song? See [CONTRIBUTING.md]"));
});

test("regenerateReadme throws clearly if the sentinel block is missing", () => {
  assert.throws(() => regenerateReadme("# No sentinels here", ["Some Track"]), /TRACKLIST:START/);
});

test("regenerateReadme handles a single-track list correctly (numbering starts at 1, no trailing artifacts)", () => {
  const text = "before\n<!-- TRACKLIST:START -->\nstale\n<!-- TRACKLIST:END -->\nafter";
  const result = regenerateReadme(text, ["Only Track"]);
  assert.equal(result, "before\n<!-- TRACKLIST:START -->\n1. Only Track\n<!-- TRACKLIST:END -->\nafter");
});

test("regenerateReadme handles an empty track list (degenerate case, shouldn't happen in practice but must not crash)", () => {
  const text = "<!-- TRACKLIST:START -->\nstale\n<!-- TRACKLIST:END -->";
  const result = regenerateReadme(text, []);
  assert.equal(result, "<!-- TRACKLIST:START -->\n\n<!-- TRACKLIST:END -->");
});

test("sortTrackNames is case-insensitive (lowercase 'a' should not sort after uppercase names)", () => {
  const sorted = sortTrackNames(["zebra", "Apple", "banana", "Aardvark"]);
  assert.deepEqual(sorted, ["Aardvark", "Apple", "banana", "zebra"]);
});
