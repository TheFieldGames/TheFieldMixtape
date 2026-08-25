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
  constructor(message, { stage, cancelled = false } = {}) {
    super(message);
    this.name = "SubmissionError";
    this.stage = stage;
    this.cancelled = cancelled;
  }
}

// Cancellation is only ever checked (and only ever takes effect) for stages
// BEFORE this one. Matches jobs.js's own CANCEL_CUTOFF_STAGE. tcli-publish
// is the one genuinely irreversible step in the whole pipeline (Thunderstore
// versions are immutable once accepted) — everything before it (clone,
// README regen, local commit/tag, download, build) only ever touches a
// temp local clone and R2's read-only listing, never anything permanent, so
// cancelling up through there is always safe. Everything after it (R2
// promotion/deletion, git push, manifest update) must never be cancelled
// either — once Thunderstore has genuinely received the upload, killing the
// bookkeeping that follows would leave it live while local state stays
// stale, which is exactly the "looks like it didn't happen when it did"
// problem this whole ordering exists to prevent (see MixTapeWebPlan.md's
// "publish tcli-publish first" redesign).
export const CANCEL_CUTOFF_STAGE = "tcli-publish";

function trackNameFromFilename(filename) {
  return filename.endsWith(".ogg") ? filename.slice(0, -".ogg".length) : filename;
}

/**
 * Core orchestration for publishing everything currently queued in the
 * manifest. This is the only function that ever actually touches
 * git/Thunderstore for real — queueing an add or a delete (routes/index.js,
 * routes/tracks.js) only ever mutates R2's pending prefix and the manifest,
 * never git or tcli, so it's fast and has no publish-pipeline guards of its
 * own to worry about.
 *
 * Reads the pending set fresh from the manifest at the start (not passed in
 * by the caller) so it always reflects whatever's actually queued at the
 * moment Publish is clicked, not a possibly-stale snapshot.
 *
 * ORDERING (redesigned 2026-08-25 — see MixTapeWebPlan.md for the incident
 * this replaces): everything up through tcli-build is now identical for a
 * dry run and a real publish, and touches nothing permanent — clone,
 * README regeneration, and the local git commit/tag all operate on either
 * a temp local clone (never pushed) or an in-memory projection of the
 * resulting track list (real R2 is only ever *read*, via listTracks(), not
 * mutated). Pending adds are downloaded straight from R2's pending prefix
 * for the build, exactly like a dry run always did — real R2 is never
 * touched before this point for either path.
 *
 * A dry run stops right there: it still pushes its own disposable,
 * force-pushed branch/tag (so a real diff is inspectable) but never calls
 * tcli publish and never touches real R2 or the manifest.
 *
 * A real publish's actual point of no return is tcli-publish itself —
 * Thunderstore versions are immutable once accepted, and it's a single
 * network call we don't control the internals of. Everything that used to
 * happen *before* the old pipeline's publish step (R2 promotion/deletion,
 * git push) now happens *after* tcli-publish succeeds instead. This means
 * a failed tcli-publish leaves genuinely nothing changed — no orphaned R2
 * state, no stale README on a real branch, no manifest drift, nothing to
 * clean up before retrying. The old "committed but not published"
 * partial-failure category is gone; what replaces it is much narrower and
 * much safer: if something fails *after* tcli-publish already succeeded
 * (promoting R2, pushing git, updating the manifest), Thunderstore already
 * has the update regardless — only this app's own bookkeeping might lag
 * behind reality, never the other way around.
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

    // Everything from here through tcli-publish is wrapped: nothing in this
    // section touches anything permanent (real R2 is only ever read, never
    // mutated; the commit/tag below live only in this temp local clone
    // until an explicit push later — except a dry run's own disposable
    // push, which is safe regardless), so any failure here should read as
    // a clean, nothing-happened failure, not the old "committed but not
    // published" framing. A SubmissionError thrown by one of the checks
    // below (already a clear, specific message) passes through unwrapped;
    // anything else (a raw error from git/tcli/R2) gets wrapped with stage
    // context, same as the rest of this app's error handling expects.
    let addedNames, deletedNames, versionNumber, tagName, configPath, zipPath, zipStat;
    try {
      // Nothing from here through tcli-build touches anything permanent,
      // for either path — real R2 is only ever read (listTracks()), never
      // mutated. The resulting track list is always computed in-memory
      // rather than read back from a real mutation — exactly what a dry
      // run always did; both paths share it now.
      setStage("regenerate-readme");
      const realTrackNames = await storage.listTracks(r2Client, r2Bucket);
      const trackNames = [
        ...realTrackNames.filter((name) => !pendingDeleteFilenames.includes(`${name}.ogg`)),
        ...pendingAddFilenames.map(trackNameFromFilename),
      ];
      const readmePath = path.join(cloneDir, "README.md");
      const readmeText = await fsp.readFile(readmePath, "utf8");
      await fsp.writeFile(readmePath, regenerateReadme(readmeText, trackNames));

      setStage("commit");
      addedNames = pendingAddFilenames.map(trackNameFromFilename);
      deletedNames = pendingDeleteFilenames.map(trackNameFromFilename);
      const summaryParts = [];
      if (addedNames.length > 0) summaryParts.push(`+${addedNames.join(", ")}`);
      if (deletedNames.length > 0) summaryParts.push(`-${deletedNames.join(", ")}`);
      const summary = summaryParts.join("; ");
      const commitMessage = dryRun
        ? `[DRY RUN] Publish: ${summary} (published by ${displayName} via contribute-app)`
        : `Publish: ${summary} (published by ${displayName} via contribute-app)`;
      await git.addAndCommit(cloneDir, ["README.md"], { authorName: displayName, message: commitMessage });

      setStage("compute-version");
      const { versionNumber: v, tagName: realTagName } = await fetchNextVersion(repoUrl);
      versionNumber = v;
      tagName = dryRun ? `${DRY_RUN_TAG_PREFIX}${realTagName}` : realTagName;
      log(`${jobTag} computed next version: ${versionNumber} (tag: ${tagName})`);
      await git.tagCommit(cloneDir, tagName);

      // Pending adds are downloaded straight from the pending prefix, and
      // pending deletes' local copies removed, for both paths — real R2
      // hasn't been touched yet either way, so this is the only way to get
      // an accurate build regardless of dryRun.
      setStage("download-all-tracks");
      const mixtapeDir = path.join(cloneDir, "my mixtape");
      // The freshly cloned "my mixtape/" still carries legacy .ogg files
      // committed to git from before the R2 migration (see CLAUDE.md) —
      // vestigial, but never actually removed from the repo. tcli's
      // build.copy (thunderstore.toml) copies this directory verbatim into
      // the package, so leaving them here would silently resurrect every
      // legacy/deleted track into the build regardless of what R2 actually
      // says is live: R2 is the only place a real deletion happens, and
      // this directory is the one place that never found out. Clearing
      // every .ogg here first means the directory ends up holding exactly
      // what the two steps below put into it — R2's real, current listing
      // plus this batch's pending adds — nothing left over from git.
      const preexisting = await fsp.readdir(mixtapeDir).catch(() => []);
      await Promise.all(
        preexisting.filter((name) => name.endsWith(".ogg")).map((name) => fsp.rm(path.join(mixtapeDir, name)))
      );
      const downloadedCount = await storage.downloadAllTracks(r2Client, r2Bucket, mixtapeDir);
      log(`${jobTag} downloaded ${downloadedCount} tracks from R2 for the build`);
      for (const filename of pendingAddFilenames) {
        await storage.downloadTrackTo(r2Client, r2Bucket, filename, path.join(mixtapeDir, filename), {
          prefix: PENDING_PREFIX,
        });
      }
      for (const filename of pendingDeleteFilenames) {
        await fsp.rm(path.join(mixtapeDir, filename), { force: true });
      }

      configPath = path.join(cloneDir, thunderstoreTomlRelPath);
      setStage("tcli-build");
      await buildPackage({ configPath, versionNumber, tcliPath });
      zipPath = buildOutputZipPath(cloneDir, versionNumber);
      zipStat = await fsp.stat(zipPath);
      log(`${jobTag} built package: ${(zipStat.size / 1024 / 1024).toFixed(1)}MB`);

      if (dryRun) {
        // A dry run's own definition of "done" is a successful build —
        // still pushes its own disposable, force-pushed branch/tag so a
        // real diff is inspectable, but never touches real R2,
        // tcli-publish, or the manifest. Nothing below this block runs for
        // a dry run.
        setStage("push-branch");
        await git.pushBranch(cloneDir, pushBranchName, { force: forcePush });
        setStage("push-tag");
        await git.pushTag(cloneDir, tagName, { force: forcePush });
      } else {
        // Real publish only, from here on. Nothing permanent has happened
        // yet — re-check against a *fresh* real R2 listing (not the one
        // read minutes ago, before clone/build) as a final guard against
        // out-of-band changes since the early check, same intent the
        // original double-check always had.
        setStage("check-track-limit-pre-publish");
        const freshLiveNames = await storage.listTracks(r2Client, r2Bucket);
        const finalTrackCount =
          freshLiveNames.filter((name) => !pendingDeleteFilenames.includes(`${name}.ogg`)).length + pendingAddFilenames.length;
        if (finalTrackCount > MAX_TRACKS) {
          throw new SubmissionError(
            `Track count (${finalTrackCount}) exceeds the ${MAX_TRACKS}-track limit right before publish — refusing to publish. This shouldn't happen under normal use; check for out-of-band changes to the R2 bucket.`,
            { stage }
          );
        }

        // The actual point of no return — see CANCEL_CUTOFF_STAGE and the
        // function doc comment. If this throws, nothing above has left any
        // trace: no R2 mutation, no git push. Retrying is just running the
        // whole pipeline again from a clean slate.
        setStage("tcli-publish");
        await publishPackage({ configPath, filePath: zipPath, tcliPath });
        log(`${jobTag} published to Thunderstore successfully — everything from here is bookkeeping`);
      }
    } catch (err) {
      if (err instanceof SubmissionError) throw err;
      throw new SubmissionError(
        `${dryRun ? "Dry run" : "Publish"} failed before reaching Thunderstore: ${err.message}`,
        { stage }
      );
    }

    if (dryRun) {
      const commitSha = await git.getHeadSha(cloneDir);
      log(`${jobTag} succeeded in ${elapsed()} (commit ${commitSha.slice(0, 8)}, version ${versionNumber})`);
      return {
        dryRun: true,
        added: addedNames,
        deleted: deletedNames,
        versionNumber,
        tagName,
        commitSha,
        branch: pushBranchName,
        thunderstoreUrl: THUNDERSTORE_URL,
      };
    }

    // Thunderstore has the update now, unconditionally. Nothing below can
    // ever change whether the publish itself succeeded — a failure here
    // means only this app's own records (R2, git, manifest) might lag
    // behind reality, logged loudly but never thrown, so it can never look
    // like the publish itself failed when it didn't.
    let bookkeepingError = null;
    try {
      setStage("apply-queue");
      for (const filename of pendingDeleteFilenames) {
        await storage.deleteTrack(r2Client, r2Bucket, filename);
      }
      for (const filename of pendingAddFilenames) {
        await storage.promotePendingTrack(r2Client, r2Bucket, filename);
      }

      setStage("push-branch");
      await git.pushBranch(cloneDir, pushBranchName, { force: forcePush });

      setStage("push-tag");
      await git.pushTag(cloneDir, tagName, { force: forcePush });

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
    } catch (err) {
      logError(
        `${jobTag} published successfully but failed during bookkeeping stage "${stage}" — Thunderstore itself is unaffected, but R2/git/the manifest may now be inconsistent and need a maintainer's attention: ${err.message}`
      );
      bookkeepingError = err.message;
    }

    const commitSha = await git.getHeadSha(cloneDir);
    log(`${jobTag} succeeded in ${elapsed()} (commit ${commitSha.slice(0, 8)}, version ${versionNumber})`);
    return {
      dryRun: false,
      added: addedNames,
      deleted: deletedNames,
      versionNumber,
      tagName,
      commitSha,
      branch: pushBranchName,
      thunderstoreUrl: THUNDERSTORE_URL,
      bookkeepingError,
    };
  } catch (err) {
    logError(`${jobTag} FAILED at stage "${stage}" after ${elapsed()}:`, err.message);
    throw err;
  } finally {
    setStage("cleanup");
    await fsp.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
