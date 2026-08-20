const TRACKLIST_BLOCK_RE = /<!-- TRACKLIST:START -->[\s\S]*?<!-- TRACKLIST:END -->/;

/**
 * Case-insensitive sort matching the intent of the existing
 * .github/workflows/sync-tracklist.yml Python (`sorted(..., key=str.casefold)`).
 * Uses plain lowercase + code-unit comparison rather than localeCompare so
 * ordering isn't affected by locale-aware collation rules Python's sort
 * doesn't apply either — a closer (if not byte-for-byte identical for exotic
 * Unicode) match to the original algorithm.
 */
export function sortTrackNames(names) {
  return [...names].sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });
}

/**
 * Rebuilds the numbered tracklist between the TRACKLIST:START/END sentinels
 * in README.md's text. Pure function: takes the current README text and the
 * full list of current track names (no ".ogg", as returned by
 * storage.listTracks()), returns the updated README text.
 */
export function regenerateReadme(readmeText, trackNames) {
  if (!TRACKLIST_BLOCK_RE.test(readmeText)) {
    throw new Error("README.md is missing the <!-- TRACKLIST:START/END --> sentinel block");
  }
  const sorted = sortTrackNames(trackNames);
  const tracklist = sorted.map((name, i) => `${i + 1}. ${name}`).join("\n");
  const newBlock = `<!-- TRACKLIST:START -->\n${tracklist}\n<!-- TRACKLIST:END -->`;
  return readmeText.replace(TRACKLIST_BLOCK_RE, newBlock);
}
