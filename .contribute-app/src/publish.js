import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { regenerateReadme } from "./readme.js";
import { PENDING_PREFIX } from "./storage.js";
import * as storageDefault from "./storage.js";
import * as gitDefault from "./git.js";
import { fetchNextVersion as fetchNextVersionDefault } from "./version.js";
import { publishPackage as publishPackageDefault, buildPackage as buildPackageDefault } from "./tcli.js";
import { log as logDefault, logError as logErrorDefault } from "./logger.js";
import * as bandwidthDefault from "./bandwidth.js";
import * as manifestDefault from "./manifest.js";

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
// (before any clone/apply work, so a rejection is cheap) and again
// immediately before the real publish call, as a final safety net against
// the (currently narrow, e.g. manual out-of-band R2 changes) possibility
// that the count changed between the first check and now.
//
// Lowered from 70 to 50 on 2026-08-24 as a partial mitigation for tcli
// OOM-crashing on Render's 512MB container while uploading the built
// package (see MixTapeWebPlan.md) — a smaller cap keeps the package
// smaller on average, but this alone doesn't reliably fix the crash (a
// 58-track/249MB package still OOM'd); the real fix is more memory
// headroom or moving the upload off Render entirely.
export const MAX_TRACKS = 50;

// Hard cap on a single converted .ogg file's size — checked at queue time
// (routes/index.js), right after conversion, before it's ever uploaded to
// R2's pending prefix. 1024-based KB (KiB), matching standard OS file-size
// conventions.
export const MAX_TRACK_FILE_SIZE_KB = 8000;
export const MAX_TRACK_FILE_SIZE_BYTES = MAX_TRACK_FILE_SIZE_KB * 1024;

export class SubmissionError extends Error {
  constructor(message, { stage, committedButNotPublished = false, cancelled = false } = {}) {
    super(message);
    this.name = "SubmissionError";
    this.stage = stage;
    this.committedButNotPublished = committedButNotPublished;
    this.cancelled = cancelled;
  }
}

// Cancellation is only ever checked (and only ever takes effect) for stages
// BEFORE this one. Matches jobs.js's own CANCEL_CUTOFF_STAGE and, more
// importantly, matches the point where processPublish's own inner try block
// begins treating a failure as committedButNotPublished rather than a clean
// abort — once git has actually been pushed, "cancel" stops being a safe,
// well-defined action (see MixTapeWebPlan.md's loading-bar design
// discussion for the full reasoning: a real tcli-publish is a single
// irreversible network call, and killing it mid-flight risks reporting
// "cancelled" while Thunderstore actually went live — worse than an honest
// failure).
export const CANCEL_CUTOFF_STAGE = "push-branch";

function trackNameFromFilename(filename) {
  return filename.endsWith(".ogg") ? filename.slice(0, -".ogg".length) : filename;
}

/**
 * Core orchestration for publishing everything currently queued in the
 * manifest: clone -> apply the batch to R2 (promote pending adds, delete
 * pending deletes) -> regenerate README from the resulting real listing ->
 * commit -> compute+tag version -> push branch -> push tag -> download full
 * library from R2 -> tcli publish -> flip the manifest's pending entries to
 * live / drop the deleted ones. This is the only function that ever
 * actually touches git/Thunderstore for real — queueing an add or a delete
 * (routes/index.js, routes/tracks.js) only ever mutates R2's pending prefix
 * and the manifest, never git or tcli, so it's fast and has no publish-
 * pipeline guards of its own to worry about.
 *
 * Reads the pending set fresh from the manifest at the start (not passed in
 * by the caller) so it always reflects whatever's actually queued at the
 * moment Publish is clicked, not a possibly-stale snapshot.
 *
 * Real application of the batch to R2 happens early (right after clone,
 * before the branch/tag/build/publish critical section) — same position
 * processSubmission's R2 upload and processDeletion's R2 delete used to
 * occupy — so a later failure lands in the same recoverable "committed but
 * not published" partial-failure category (see MixTapeWebPlan.md's
 * "Auto-Deploy killed the first real submission" incident for the
 * precedent). Because Thunderstore versions are immutable already-built
 * zips, applying the batch to R2 never retroactively breaks an
 * already-published version — it only affects the *next* build.
 *
 * A dry run never mutates real R2 at all: the resulting track list is
 * computed in-memory instead, and pending adds' real bytes are downloaded
 * from the pending prefix (not promoted) purely to build an accurate local
 * preview package.
 */
export async function processPublish(input, config, deps = {}) {
  const {
    storage = storageDefault,
    git = gitDefault,
    fetchNextVersion = fetchNextVersionDefault,
    publishPackage = publishPackageDefault,
    buildPackage = buildPackageDefault,
    bandwidth = bandwidthDefault,
    manifest = manifestDefault,
    tmpBase = os.tmpdir(),
    log = logDefault,
    logError = logErrorDefault,
    checkCancelled = () => false,
    onStageChange = () => {},
  } = deps;

  const { displayName, dryRun = false } = input;
  const {
    repoUrl,
    branch,
    r2Client,
    r2Bucket,
    tcliPath,
    thunderstoreTomlRelPath = "thunderstore.toml",
    trackBandwidth = true,
  } = config;

  const jobId = crypto.randomUUID();
  const jobTag = `[publish ${jobId.slice(0, 8)}]`;
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  const cloneDir = path.join(tmpBase, `contribute-publish-clone-${jobId}`);

  const pushBranchName = dryRun ? DRY_RUN_BRANCH : branch;
  const forcePush = pushBranchName !== SOURCE_BRANCH;

  let stage = "start";
  let cancellable = true;
  const setStage = (name) => {
    if (name !== "cleanup" && cancellable && checkCancelled()) {
      throw new SubmissionError(`Cancelled by user during stage "${stage}", before "${name}" started.`, {
        stage,
        cancelled: true,
      });
    }
    stage = name;
    log(`${jobTag} ${name}... (+${elapsed()})`);
    onStageChange(name);
    if (name === CANCEL_CUTOFF_STAGE) cancellable = false;
  };

  log(`${jobTag} started: requested by ${displayName}${dryRun ? " [DRY RUN]" : ""} -> target branch "${pushBranchName}"`);

  try {
    // Same reasoning as the equivalent guard in the retired
    // processSubmission/processDeletion — see MixTapeWebPlan.md's
    // "Incident: real publish landed on the wrong git branch" for the
    // full incident this closes.
    if (!dryRun && branch !== SOURCE_BRANCH) {
      setStage("check-target-branch");
      throw new SubmissionError(
        `Refusing to publish for real: this instance is configured to push to "${branch}", not "${SOURCE_BRANCH}". Real publishes are only allowed when targeting ${SOURCE_BRANCH}. Use a dry run to keep testing, or fix this instance's GIT_TARGET_BRANCH.`,
        { stage: "check-target-branch" }
      );
    }

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

    setStage("check-pending");
    const manifestBeforePublish = await manifest.getManifest(r2Client, r2Bucket);
    const pendingAddFilenames = Object.entries(manifestBeforePublish.tracks)
      .filter(([, entry]) => entry.status === "pending")
      .map(([filename]) => filename);
    const pendingDeleteFilenames = [...manifestBeforePublish.pendingDeletes];
    if (pendingAddFilenames.length === 0 && pendingDeleteFilenames.length === 0) {
      throw new SubmissionError("Nothing to publish — the queue is empty.", { stage });
    }
    // The commit message carries this same summary, but that's only ever
    // visible by digging into git afterward — logging it here means
    // Render's own logs say what a given publish actually did.
    log(
      `${jobTag} batch: +${pendingAddFilenames.length} add${pendingAddFilenames.length === 1 ? "" : "s"} [${pendingAddFilenames.map(trackNameFromFilename).join(", ")}], -${pendingDeleteFilenames.length} delete${pendingDeleteFilenames.length === 1 ? "" : "s"} [${pendingDeleteFilenames.map(trackNameFromFilename).join(", ")}]`
    );

    // Cheap, approximate early check against the manifest's own bookkeeping
    // (no extra R2 listing needed) — the authoritative real-listing
    // re-check happens right before tcli-publish, same double-check pattern
    // MAX_TRACKS has always used.
    setStage("check-track-limit");
    const currentLiveCount = Object.values(manifestBeforePublish.tracks).filter((e) => e.status === "live").length;
    const projectedCount = currentLiveCount - pendingDeleteFilenames.length + pendingAddFilenames.length;
    if (projectedCount > MAX_TRACKS) {
      throw new SubmissionError(
        `Publishing this batch would put the mixtape at ${projectedCount} tracks, over the ${MAX_TRACKS}-track limit. Remove something from the queue first.`,
        { stage }
      );
    }

    setStage("clone");
    await git.cloneRepo(repoUrl, SOURCE_BRANCH, cloneDir);

    // Real application of the batch happens here, before the critical
    // section below — see the function doc comment for why this
    // positioning is safe. A dry run never calls these at all.
    if (!dryRun) {
      setStage("apply-queue");
      for (const filename of pendingDeleteFilenames) {
        await storage.deleteTrack(r2Client, r2Bucket, filename);
      }
      for (const filename of pendingAddFilenames) {
        await storage.promotePendingTrack(r2Client, r2Bucket, filename);
      }
    }

    setStage("regenerate-readme");
    const realTrackNames = await storage.listTracks(r2Client, r2Bucket);
    // Real: R2 was just mutated above, so listTracks() already reflects the
    // final state exactly. Dry run: R2 was never touched, so the resulting
    // list is computed here in-memory instead — a preview only.
    const trackNames = dryRun
      ? [
          ...realTrackNames.filter((name) => !pendingDeleteFilenames.includes(`${name}.ogg`)),
          ...pendingAddFilenames.map(trackNameFromFilename),
        ]
      : realTrackNames;
    const readmePath = path.join(cloneDir, "README.md");
    const readmeText = await fsp.readFile(readmePath, "utf8");
    await fsp.writeFile(readmePath, regenerateReadme(readmeText, trackNames));

    setStage("commit");
    const addedNames = pendingAddFilenames.map(trackNameFromFilename);
    const deletedNames = pendingDeleteFilenames.map(trackNameFromFilename);
    const summaryParts = [];
    if (addedNames.length > 0) summaryParts.push(`+${addedNames.join(", ")}`);
    if (deletedNames.length > 0) summaryParts.push(`-${deletedNames.join(", ")}`);
    const summary = summaryParts.join("; ");
    const commitMessage = dryRun
      ? `[DRY RUN] Publish: ${summary} (published by ${displayName} via contribute-app)`
      : `Publish: ${summary} (published by ${displayName} via contribute-app)`;
    await git.addAndCommit(cloneDir, ["README.md"], { authorName: displayName, message: commitMessage });

    setStage("compute-version");
    const { versionNumber, tagName: realTagName } = await fetchNextVersion(repoUrl);
    const tagName = dryRun ? `${DRY_RUN_TAG_PREFIX}${realTagName}` : realTagName;
    log(`${jobTag} computed next version: ${versionNumber} (tag: ${tagName})`);
    await git.tagCommit(cloneDir, tagName);

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
      log(`${jobTag} downloaded ${downloadedCount} tracks from R2 for the build`);
      if (dryRun) {
        // Pending adds live under the pending prefix, invisible to
        // downloadAllTracks() (scoped to the real prefix) — pull each
        // one's real bytes down directly so the preview package is
        // accurate. Pending deletes are still present (dry run never
        // deleted them for real) — remove the local copies.
        for (const filename of pendingAddFilenames) {
          await storage.downloadTrackTo(r2Client, r2Bucket, filename, path.join(mixtapeDir, filename), {
            prefix: PENDING_PREFIX,
          });
        }
        for (const filename of pendingDeleteFilenames) {
          await fsp.rm(path.join(mixtapeDir, filename), { force: true });
        }
      }

      const configPath = path.join(cloneDir, thunderstoreTomlRelPath);
      setStage("tcli-build");
      await buildPackage({ configPath, versionNumber, tcliPath });
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      const zipStat = await fsp.stat(zipPath);
      log(`${jobTag} built package: ${(zipStat.size / 1024 / 1024).toFixed(1)}MB`);

      if (!dryRun) {
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

        setStage("record-manifest");
        await manifest.applyPublishBatch(r2Client, r2Bucket, {
          publishedFilenames: pendingAddFilenames,
          deletedFilenames: pendingDeleteFilenames,
        });

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
        logError(
          `${jobTag} published successfully but failed to record it during stage "${stage}" (bookkeeping may now be incomplete): ${err.message}`
        );
      } else {
        throw new SubmissionError(
          pushedBranch
            ? `Publish committed to ${pushBranchName} but ${dryRun ? "the dry-run build" : "publishing"} failed: ${err.message}`
            : `${dryRun ? "Dry run" : "Publishing"} failed before the commit was pushed: ${err.message}`,
          { stage, committedButNotPublished: !dryRun && pushedBranch }
        );
      }
    }

    const commitSha = await git.getHeadSha(cloneDir);
    log(`${jobTag} succeeded in ${elapsed()} (commit ${commitSha.slice(0, 8)}, version ${versionNumber})`);
    return {
      dryRun,
      added: addedNames,
      deleted: deletedNames,
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
  }
}
