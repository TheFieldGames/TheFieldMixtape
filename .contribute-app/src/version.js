import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TAG_LINE_RE = /refs\/tags\/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$/;

/**
 * Parses the raw output of `git ls-remote --tags <repo>` into semver-tagged
 * version objects. Ignores non-vX.Y.Z tags and de-dupes the `^{}` peeled
 * refs annotated tags produce (same version, second line).
 */
export function parseSemverTags(lsRemoteOutput) {
  const seen = new Set();
  const versions = [];
  for (const line of lsRemoteOutput.split("\n")) {
    const match = line.match(TAG_LINE_RE);
    if (!match) continue;
    const [, major, minor, patch] = match;
    const key = `${major}.${minor}.${patch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    versions.push({ major: Number(major), minor: Number(minor), patch: Number(patch) });
  }
  return versions;
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function getHighestVersion(versions) {
  if (versions.length === 0) return null;
  return versions.reduce((highest, v) => (compareVersions(v, highest) > 0 ? v : highest));
}

export function bumpPatch(version) {
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

export function formatVersionNumber(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function formatTagName(version) {
  return `v${formatVersionNumber(version)}`;
}

/**
 * Pure core: given raw `git ls-remote --tags` output, compute the next
 * version. Throws if no existing vX.Y.Z tags are found (this repo always
 * has at least v1.0.0, so an empty result means something is wrong upstream
 * rather than "start fresh at 0.0.1").
 */
export function computeNextVersion(lsRemoteOutput) {
  const versions = parseSemverTags(lsRemoteOutput);
  const highest = getHighestVersion(versions);
  if (!highest) {
    throw new Error("No existing vX.Y.Z tags found in repo — refusing to guess a starting version");
  }
  const next = bumpPatch(highest);
  return { versionNumber: formatVersionNumber(next), tagName: formatTagName(next) };
}

/** I/O wrapper: runs the real `git ls-remote --tags` and computes the next version. */
export async function fetchNextVersion(repoUrl, runExecFile = execFileAsync) {
  const { stdout } = await runExecFile("git", ["ls-remote", "--tags", repoUrl]);
  return computeNextVersion(stdout);
}
