import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { buildTrackFilename } from "./filename.js";
import { regenerateReadme } from "./readme.js";
import { TRACK_PREFIX, DRY_RUN_PREFIX } from "./storage.js";
import * as storageDefault from "./storage.js";
import * as gitDefault from "./git.js";
import { convertToOgg as convertToOggDefault } from "./convert.js";
import { fetchNextVersion as fetchNextVersionDefault } from "./version.js";
import { publishPackage as publishPackageDefault, buildPackage as buildPackageDefault } from "./tcli.js";
import { log as logDefault, logError as logErrorDefault } from "./logger.js";
import * as bandwidthDefault from "./bandwidth.js";

export const THUNDERSTORE_URL = "https://thunderstore.io/c/peak/p/TheField/TheFieldMixtape/";

// Must match thunderstore.toml's [package] namespace/name exactly — used to
// compute tcli's deterministic build output filename
// (`{namespace}-{name}-{versionNumber}.zip`) so it can be located and
// stat'd for the bandwidth measurement below.
export const PACKAGE_NAMESPACE = "TheField";
export const PACKAGE_NAME = "TheFieldMixtape";

export function buildOutputZipPath(cloneDir, versionNumber) {
  return path.join(cloneDir, "build", `${PACKAGE_NAMESPACE}-${PACKAGE_NAME}-${versionNumber}.zip`);
}

// Dry runs always push here, never to `config.branch` (which is `main` in
// production) — force-pushed and reused across runs rather than
// accumulating a new branch per attempt.
export const DRY_RUN_BRANCH = "contribute-app-dry-run";

// Prefixing the tag keeps it outside version.js's `vX.Y.Z` parsing, so a
// dry run can never consume/skip a real version number in the sequence.
export const DRY_RUN_TAG_PREFIX = "dryrun-";

// Always clone from here, regardless of dryRun or config.branch (the PUSH
// target). This is the one real, authoritative source of the current
// README/thunderstore.toml/etc. `git clone --branch <name>` requires that
// branch to already exist on the remote — config.branch may be a disposable
// test branch that doesn't exist yet (that's the whole point of it), so
// cloning from it directly would fail on first use.
export const SOURCE_BRANCH = "main";

// Hard cap on total tracks in the mixtape. Checked twice: once early
// (before any clone/convert work, so a rejection is cheap) and again
// immediately before the real publish call, as a final safety net against
// the (currently narrow, e.g. manual out-of-band R2 changes) possibility
// that the count changed between the first check and now.
export const MAX_TRACKS = 70;

// Hard cap on a single converted .ogg file's size, checked after conversion
// (this is about the file that actually goes into the mixtape, not the raw
// upload). 1024-based KB (KiB), matching standard OS file-size conventions.
export const MAX_TRACK_FILE_SIZE_KB = 8000;
export const MAX_TRACK_FILE_SIZE_BYTES = MAX_TRACK_FILE_SIZE_KB * 1024;

export class SubmissionError extends Error {
  constructor(message, { stage, committedButNotPublished = false } = {}) {
    super(message);
    this.name = "SubmissionError";
    this.stage = stage;
    this.committedButNotPublished = committedButNotPublished;
  }
}

/**
 * Core orchestration for a single track submission: clone -> duplicate
 * check -> convert -> upload to R2 -> regenerate README (from R2 listing)
 * -> commit -> compute+tag version -> push branch -> push tag -> download
 * full library from R2 -> tcli publish. Matches the plan's "Request flow"
 * section step-for-step.
 *
 * When `input.dryRun` is true, everything above still runs for real EXCEPT
 * the final `tcli publish` call (replaced with a local-only `tcli build`):
 * uploads go under a separate R2 prefix, invisible to the real track
 * listing; the branch/tag are isolated (force-pushed, reused) so `main`
 * and the real vX.Y.Z tag sequence are never touched.
 *
 * All I/O is dependency-injected (`deps`) so this function's sequencing and
 * error-handling can be fully unit-tested without a real git/network/ffmpeg/
 * tcli. Production callers only need to pass `config`; `deps` defaults to
 * the real implementations.
 *
 * Logs a line per stage transition (with elapsed time) via the injected
 * `log`/`logError` — this whole function takes 1-2 minutes in production,
 * so silent progress made a real failure hard to diagnose from the
 * terminal alone.
 */
export async function processSubmission(input, config, deps = {}) {
  const {
    storage = storageDefault,
    git = gitDefault,
    convert = convertToOggDefault,
    fetchNextVersion = fetchNextVersionDefault,
    publishPackage = publishPackageDefault,
    buildPackage = buildPackageDefault,
    bandwidth = bandwidthDefault,
    tmpBase = os.tmpdir(),
    log = logDefault,
    logError = logErrorDefault,
  } = deps;

  const { uploadPath, title, artist, displayName, dryRun = false } = input;
  const {
    repoUrl,
    branch,
    r2Client,
    r2Bucket,
    tcliPath,
    thunderstoreTomlRelPath = "thunderstore.toml",
    trackBandwidth = true,
  } = config;

  const filename = buildTrackFilename(title, artist);
  const trackName = filename.slice(0, -".ogg".length);
  const jobId = crypto.randomUUID();
  const jobTag = `[submission ${jobId.slice(0, 8)}]`;
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  const cloneDir = path.join(tmpBase, `contribute-clone-${jobId}`);
  const convertedPath = path.join(tmpBase, `contribute-track-${jobId}.ogg`);

  const r2Prefix = dryRun ? DRY_RUN_PREFIX : TRACK_PREFIX;
  const pushBranchName = dryRun ? DRY_RUN_BRANCH : branch;
  // Force whenever pushing anywhere other than the real main branch — a dry
  // run, or (during local dev) a disposable, deliberately-reused test
  // branch. Since the clone always starts fresh from main (above), a second
  // push to the same non-main branch would otherwise be a non-fast-forward
  // rejection. NEVER force when actually pushing to main.
  const forcePush = pushBranchName !== SOURCE_BRANCH;

  let stage = "start";
  const setStage = (name) => {
    stage = name;
    log(`${jobTag} ${name}... (+${elapsed()})`);
  };

  log(
    `${jobTag} started: "${trackName}" submitted by ${displayName}${dryRun ? " [DRY RUN]" : ""} -> target branch "${pushBranchName}"`
  );

  try {
    // Locks out real submissions once this month's tracked publish
    // bandwidth hits the safety threshold — before any clone/convert work.
    // Dry runs are exempt: they never call tcli publish, so they never
    // consume this budget, and stay useful for testing even while locked.
    // trackBandwidth is also off for a local instance's real publishes by
    // choice (config.trackBandwidth === false, opted out via
    // DISABLE_BANDWIDTH_TRACKING in a local .env) — Render's actual
    // bandwidth cap only meters traffic leaving Render's own servers, so a
    // publish made from a machine that isn't Render structurally can't
    // consume any of it, regardless of which branch it targets.
    if (!dryRun && trackBandwidth) {
      setStage("check-bandwidth-lock");
      const usage = await bandwidth.getUsage(r2Client, r2Bucket);
      if (bandwidth.isLocked(usage)) {
        throw new SubmissionError(
          `Monthly publish limit reached (${(usage.bytesUsed / 1e9).toFixed(2)}GB of ${(bandwidth.LOCK_THRESHOLD_BYTES / 1e9).toFixed(1)}GB used this month). Try again next month, or use a dry run to keep testing.`,
          { stage }
        );
      }
    }

    // Duplicate check always looks at the real track namespace, regardless
    // of dryRun — dry-run uploads are isolated test data, not real tracks,
    // and shouldn't be treated as blocking (or blocked by) each other.
    setStage("check-duplicate");
    if (await storage.trackExists(r2Client, r2Bucket, filename)) {
      throw new SubmissionError(`A track named "${filename}" already exists.`, { stage });
    }

    // Checked before clone/convert so a rejection doesn't waste that work.
    // Real track count regardless of dryRun, same reasoning as the
    // duplicate check above — the mixtape's real size is what the cap is
    // protecting, dry-run uploads don't count toward it either way.
    setStage("check-track-limit");
    const existingTrackCount = (await storage.listTracks(r2Client, r2Bucket)).length;
    if (existingTrackCount >= MAX_TRACKS) {
      throw new SubmissionError(
        `The mixtape is at its ${MAX_TRACKS}-track limit (currently ${existingTrackCount}). Remove a track before adding a new one.`,
        { stage }
      );
    }

    setStage("clone");
    await git.cloneRepo(repoUrl, SOURCE_BRANCH, cloneDir);

    setStage("convert");
    await convert(uploadPath, convertedPath);

    setStage("check-file-size");
    const convertedStat = await fsp.stat(convertedPath);
    if (convertedStat.size > MAX_TRACK_FILE_SIZE_BYTES) {
      throw new SubmissionError(
        `"${trackName}" converted to ${Math.ceil(convertedStat.size / 1024)}KB, over the ${MAX_TRACK_FILE_SIZE_KB}KB limit. Try a shorter clip or a lower-bitrate source.`,
        { stage }
      );
    }

    setStage("upload-to-r2");
    await storage.uploadTrack(r2Client, r2Bucket, filename, convertedPath, { prefix: r2Prefix });

    setStage("regenerate-readme");
    const realTrackNames = await storage.listTracks(r2Client, r2Bucket);
    // Dry-run uploads live under a separate prefix, invisible to
    // listTracks() — splice the new track in manually so the README
    // preview is still accurate.
    const trackNames = dryRun ? [...realTrackNames, trackName] : realTrackNames;
    const readmePath = path.join(cloneDir, "README.md");
    const readmeText = await fsp.readFile(readmePath, "utf8");
    await fsp.writeFile(readmePath, regenerateReadme(readmeText, trackNames));

    setStage("commit");
    const commitMessage = dryRun
      ? `[DRY RUN] Add track: ${trackName} (submitted by ${displayName} via contribute-app)`
      : `Add track: ${trackName} (submitted by ${displayName} via contribute-app)`;
    await git.addAndCommit(cloneDir, ["README.md"], { authorName: displayName, message: commitMessage });

    setStage("compute-version");
    const { versionNumber, tagName: realTagName } = await fetchNextVersion(repoUrl);
    const tagName = dryRun ? `${DRY_RUN_TAG_PREFIX}${realTagName}` : realTagName;
    log(`${jobTag} computed next version: ${versionNumber} (tag: ${tagName})`);
    await git.tagCommit(cloneDir, tagName);

    // Past this point, the track is uploaded to R2 and committed locally,
    // but nothing has reached the remote yet. For a real submission, a
    // failure from here on is the "committed but not published"
    // partial-failure mode the plan calls out explicitly — surfaced
    // distinctly below, not swallowed. Dry runs push to the isolated,
    // force-pushed branch/tag above and stop before ever calling tcli
    // publish, so there's no equivalent partial-publish risk for them.
    let pushedBranch = false;
    let published = false;
    try {
      setStage("push-branch");
      await git.pushBranch(cloneDir, pushBranchName, { force: forcePush });
      pushedBranch = true;

      setStage("push-tag");
      await git.pushTag(cloneDir, tagName, { force: forcePush });

      setStage("download-all-tracks");
      const mixtapeDir = path.join(cloneDir, "my mixtape");
      const downloadedCount = await storage.downloadAllTracks(r2Client, r2Bucket, mixtapeDir);
      log(`${jobTag} downloaded ${downloadedCount} existing tracks from R2 for the build`);
      if (dryRun) {
        // The new track lives under the dry-run R2 prefix, not the real
        // one, so downloadAllTracks() (scoped to the real prefix) never
        // pulls it down — copy the already-converted local file in so the
        // build step below sees the complete, accurate package contents.
        await fsp.copyFile(convertedPath, path.join(mixtapeDir, filename));
      }

      // Always build first (even for real submissions) rather than letting
      // `tcli publish` rebuild internally — this is what lets us measure
      // the exact zip size before/instead of uploading it: for dry runs,
      // that's the whole point (never publish at all); for real
      // submissions, it's what makes the bandwidth accounting exact rather
      // than estimated. `tcli publish --file <path>` verified to skip its
      // internal build entirely and upload exactly that file.
      const configPath = path.join(cloneDir, thunderstoreTomlRelPath);
      setStage("tcli-build");
      await buildPackage({ configPath, versionNumber, tcliPath });
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      const zipStat = await fsp.stat(zipPath);
      log(`${jobTag} built package: ${(zipStat.size / 1024 / 1024).toFixed(1)}MB`);

      if (!dryRun) {
        // Redundant, final check right before the irreversible call — see
        // MAX_TRACKS's comment for why this exists alongside the earlier,
        // cheaper check of the same limit.
        setStage("check-track-limit-pre-publish");
        const finalTrackCount = (await storage.listTracks(r2Client, r2Bucket)).length;
        if (finalTrackCount > MAX_TRACKS) {
          throw new SubmissionError(
            `Track count (${finalTrackCount}) exceeds the ${MAX_TRACKS}-track limit right before publish — refusing to publish. This shouldn't happen under normal use; check for out-of-band changes to the R2 bucket.`,
            { stage }
          );
        }

        setStage("tcli-publish");
        await publishPackage({ configPath, filePath: zipPath, tcliPath });
        published = true;

        // The publish itself already fully succeeded and is irreversible —
        // a failure here must never be reported as "not published" (that
        // would risk a well-meaning retry causing a second, real publish).
        // Same trackBandwidth gate as the lock check above — see its
        // comment for why (this instance may not be Render at all).
        if (trackBandwidth) {
          setStage("record-bandwidth");
          const updatedUsage = await bandwidth.recordPublish(r2Client, r2Bucket, zipStat.size);
          log(
            `${jobTag} recorded ${(zipStat.size / 1e9).toFixed(3)}GB against this month's budget (now ${(updatedUsage.bytesUsed / 1e9).toFixed(2)}GB of ${(bandwidth.LOCK_THRESHOLD_BYTES / 1e9).toFixed(1)}GB)`
          );
        } else {
          log(`${jobTag} bandwidth tracking disabled for this instance — not recorded`);
        }
      }
    } catch (err) {
      if (published) {
        // Real publish succeeded; only the post-publish bookkeeping failed.
        // Not a SubmissionError with committedButNotPublished — that flag
        // specifically means "safe/needs to be retried," which this isn't.
        logError(
          `${jobTag} published successfully but failed to record bandwidth usage afterward (tracking may now undercount reality): ${err.message}`
        );
        // Fall through to the normal success return below — from the
        // submitter's perspective from here, this is not a failure.
      } else {
        throw new SubmissionError(
          pushedBranch
            ? `Track committed to ${pushBranchName} but ${dryRun ? "the dry-run build" : "publishing"} failed: ${err.message}`
            : `${dryRun ? "Dry run" : "Publishing"} failed before the commit was pushed: ${err.message}`,
          { stage, committedButNotPublished: !dryRun && pushedBranch }
        );
      }
    }

    const commitSha = await git.getHeadSha(cloneDir);
    log(`${jobTag} succeeded in ${elapsed()} (commit ${commitSha.slice(0, 8)}, version ${versionNumber})`);
    return {
      dryRun,
      filename,
      trackName,
      versionNumber,
      tagName,
      commitSha,
      branch: pushBranchName,
      thunderstoreUrl: THUNDERSTORE_URL,
    };
  } catch (err) {
    logError(`${jobTag} FAILED at stage "${stage}" after ${elapsed()}:`, err.message);
    throw err;
  } finally {
    setStage("cleanup");
    await fsp.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(convertedPath, { force: true }).catch(() => {});
    await fsp.rm(uploadPath, { force: true }).catch(() => {});
  }
}
