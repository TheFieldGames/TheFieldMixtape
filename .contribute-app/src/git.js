import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Placeholder identity used for commit attribution — no real email is ever
// collected from submitters (see plan: "lightweight commit attribution, not
// a full auth system").
export const COMMIT_EMAIL = "contribute-app@noreply.thefieldmixtape.local";

export async function cloneRepo(repoUrl, branch, destDir, { runExecFile = execFileAsync } = {}) {
  await runExecFile("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, destDir]);
}

/**
 * Tolerates "nothing to commit" as a success case, not a failure — this
 * matters for retrying a "committed but not published" Publish. If an
 * earlier attempt at the exact same batch already got this far (committed
 * README.md, then failed later, e.g. at tcli-publish), a retry clones the
 * now-already-updated main, regenerates the identical README from the same
 * unchanged track list, and has nothing new to stage. HEAD is already the
 * commit this attempt would have made, so that's exactly the right state to
 * tag/push/publish from — treating it as a hard failure (the old behavior)
 * made every retry of a stuck publish fail immediately with a confusing
 * raw git error, even though nothing was actually wrong.
 */
export async function addAndCommit(
  cwd,
  files,
  { authorName, message },
  { runExecFile = execFileAsync } = {}
) {
  await runExecFile("git", ["-C", cwd, "add", ...files]);
  try {
    await runExecFile("git", [
      "-C",
      cwd,
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${COMMIT_EMAIL}`,
      "commit",
      "-m",
      message,
    ]);
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`;
    if (/nothing to commit/i.test(output)) return;
    // A bare execFile error's .message is just "Command failed: <argv>" —
    // no stdout/stderr at all, the same opacity problem already fixed for
    // tcli failures (see describeTcliFailure in src/tcli.js). Surface the
    // real git output instead of leaving it silently dropped.
    throw new Error(`git commit failed: ${output.trim() || err.message}`);
  }
}

export async function tagCommit(cwd, tagName, { runExecFile = execFileAsync } = {}) {
  await runExecFile("git", ["-C", cwd, "tag", tagName]);
}

/**
 * `force` is needed for the reused dry-run branch: each dry run starts from
 * a fresh clone of `main`, so its commit history necessarily diverges from
 * whatever the dry-run branch pointed to last time — a plain push would be
 * rejected as non-fast-forward. Real submissions never pass force: true.
 */
export async function pushBranch(cwd, branch, { force = false, runExecFile = execFileAsync } = {}) {
  const refspec = `HEAD:${branch}`;
  const args = force ? ["push", "--force", "origin", refspec] : ["push", "origin", refspec];
  await runExecFile("git", ["-C", cwd, ...args]);
}

/** See pushBranch's force note — dry-run tags also get reused/overwritten across runs. */
export async function pushTag(cwd, tagName, { force = false, runExecFile = execFileAsync } = {}) {
  const args = force ? ["push", "--force", "origin", tagName] : ["push", "origin", tagName];
  await runExecFile("git", ["-C", cwd, ...args]);
}

export async function getHeadSha(cwd, { runExecFile = execFileAsync } = {}) {
  const { stdout } = await runExecFile("git", ["-C", cwd, "rev-parse", "HEAD"]);
  return stdout.trim();
}
