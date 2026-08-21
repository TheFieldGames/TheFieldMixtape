import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  processDeletion,
  SubmissionError,
  THUNDERSTORE_URL,
  DRY_RUN_BRANCH,
  DRY_RUN_TAG_PREFIX,
  SOURCE_BRANCH,
  buildOutputZipPath,
} from "../src/publish.js";
import { LOCK_THRESHOLD_BYTES } from "../src/bandwidth.js";

const SAMPLE_README = `# Title\n\n<!-- TRACKLIST:START -->\n1. Keeper Track - Someone\n2. Track To Delete - Someone Else\n<!-- TRACKLIST:END -->\n`;

function makeFakeDeleteDeps(overrides = {}) {
  const calls = [];
  let deleted = false;

  const git = {
    async cloneRepo(repoUrl, branch, destDir) {
      calls.push(["cloneRepo", repoUrl, branch, destDir]);
      await fsp.mkdir(destDir, { recursive: true });
      await fsp.writeFile(path.join(destDir, "README.md"), SAMPLE_README);
    },
    async addAndCommit(cwd, files, opts) {
      calls.push(["addAndCommit", cwd, files, opts]);
    },
    async tagCommit(cwd, tagName) {
      calls.push(["tagCommit", cwd, tagName]);
    },
    async pushBranch(cwd, branch, opts) {
      calls.push(["pushBranch", branch, opts]);
    },
    async pushTag(cwd, tagName, opts) {
      calls.push(["pushTag", tagName, opts]);
    },
    async getHeadSha() {
      calls.push(["getHeadSha"]);
      return "deadbeef";
    },
    ...(overrides.git || {}),
  };

  const storage = {
    async trackExists() {
      calls.push(["trackExists"]);
      return true;
    },
    async deleteTrack(client, bucket, filename) {
      calls.push(["deleteTrack", filename]);
      deleted = true;
    },
    async listTracks() {
      calls.push(["listTracks"]);
      return deleted ? ["Keeper Track - Someone"] : ["Keeper Track - Someone", "Track To Delete - Someone Else"];
    },
    async downloadAllTracks(client, bucket, destDir) {
      calls.push(["downloadAllTracks", destDir]);
      await fsp.mkdir(destDir, { recursive: true });
      // Simulates R2's real state: the file is gone once deleteTrack ran
      // (real, non-dry-run deletion); still present otherwise (dry run).
      if (!deleted) {
        await fsp.writeFile(path.join(destDir, "Track To Delete - Someone Else.ogg"), "fake ogg bytes");
      }
      await fsp.writeFile(path.join(destDir, "Keeper Track - Someone.ogg"), "fake ogg bytes");
      return deleted ? 1 : 2;
    },
    ...(overrides.storage || {}),
  };

  const fetchNextVersion = overrides.fetchNextVersion || (async () => {
    calls.push(["fetchNextVersion"]);
    return { versionNumber: "1.0.13", tagName: "v1.0.13" };
  });

  const publishPackage = overrides.publishPackage || (async (opts) => {
    calls.push(["publishPackage", opts]);
  });

  const buildPackage = overrides.buildPackage || (async ({ configPath, versionNumber }) => {
    calls.push(["buildPackage", { configPath, versionNumber }]);
    const cloneDir = path.dirname(configPath);
    const zipPath = buildOutputZipPath(cloneDir, versionNumber);
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    await fsp.writeFile(zipPath, "fake zip bytes");
  });

  const bandwidth = {
    async getUsage() {
      calls.push(["bandwidth.getUsage"]);
      return { month: "2026-08", bytesUsed: 0 };
    },
    async recordPublish(client, bucket, bytesAdded) {
      calls.push(["bandwidth.recordPublish", bytesAdded]);
      return { month: "2026-08", bytesUsed: bytesAdded };
    },
    isLocked(usage) {
      return usage.bytesUsed >= LOCK_THRESHOLD_BYTES;
    },
    LOCK_THRESHOLD_BYTES,
    ...(overrides.bandwidth || {}),
  };

  const manifest = {
    async removeTrack(client, bucket, filename) {
      calls.push(["manifest.removeTrack", filename]);
      return { tracks: {}, pendingDeletes: [], publishLog: [] };
    },
    ...(overrides.manifest || {}),
  };

  const log = overrides.log || (() => {});
  const logError = overrides.logError || (() => {});

  return {
    calls,
    deps: { git, storage, fetchNextVersion, publishPackage, buildPackage, bandwidth, manifest, log, logError },
  };
}

const BASE_CONFIG = {
  repoUrl: "https://x-access-token:tok@github.com/TheFieldGames/TheFieldMixtape.git",
  branch: "main",
  r2Client: {},
  r2Bucket: "thefieldmixtape-audio",
  tcliPath: "tcli",
};

test("processDeletion happy path: runs every step in order, deletes early, and returns success info", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps();

  const result = await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, false);
  assert.equal(result.filename, "Track To Delete - Someone Else.ogg");
  assert.equal(result.trackName, "Track To Delete - Someone Else");
  assert.equal(result.versionNumber, "1.0.13");
  assert.equal(result.thunderstoreUrl, THUNDERSTORE_URL);

  assert.deepEqual(calls.map((c) => c[0]), [
    "bandwidth.getUsage",
    "trackExists",
    "cloneRepo",
    "deleteTrack",
    "listTracks",
    "addAndCommit",
    "fetchNextVersion",
    "tagCommit",
    "pushBranch",
    "pushTag",
    "downloadAllTracks",
    "buildPackage",
    "publishPackage",
    "manifest.removeTrack",
    "bandwidth.recordPublish",
    "getHeadSha",
  ]);
});

test("processDeletion regenerates the README without the deleted track", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-readme-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let committedFiles = null;
  const { deps } = makeFakeDeleteDeps({
    git: {
      async addAndCommit(cwd, files) {
        committedFiles = files;
        const readme = await fsp.readFile(path.join(cwd, "README.md"), "utf8");
        assert.match(readme, /Keeper Track - Someone/);
        assert.doesNotMatch(readme, /Track To Delete/);
      },
    },
  });

  await processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.deepEqual(committedFiles, ["README.md"]);
});

test("processDeletion refuses to run for real when the track doesn't exist, before any clone work", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-notfound-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps({ storage: { async trackExists() { return false; } } });

  await assert.rejects(
    () =>
      processDeletion({ filename: "Nonexistent - Track.ogg", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.match(err.message, /No track named/);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("processDeletion refuses to run for real when config.branch is not 'main', before any clone/delete work", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-branch-guard-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps();
  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test" };

  await assert.rejects(
    () =>
      processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, testBranchConfig, {
        ...deps,
        tmpBase: tmpDir,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-target-branch");
      return true;
    }
  );

  assert.deepEqual(calls, [], "no trackExists check, clone, or delete work should have started");
});

test("processDeletion locks out a real deletion once this month's bandwidth usage is at the threshold", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-bwlock-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps({
    bandwidth: { async getUsage() { return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES }; } },
  });

  await assert.rejects(
    () =>
      processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
      }),
    /Monthly publish limit reached/
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("dry run: never deletes from R2, never touches the manifest or bandwidth, pushes to DRY_RUN_BRANCH with force", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps();

  const result = await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.branch, DRY_RUN_BRANCH);
  assert.equal(result.tagName, `${DRY_RUN_TAG_PREFIX}v1.0.13`);
  assert.ok(!calls.some((c) => c[0] === "deleteTrack"), "dry run must never delete the real R2 object");
  assert.ok(!calls.some((c) => c[0] === "manifest.removeTrack"));
  assert.ok(!calls.some((c) => c[0] === "bandwidth.recordPublish"));
  assert.ok(!calls.some((c) => c[0] === "bandwidth.getUsage"), "dry runs skip the lock check entirely");
  assert.ok(!calls.some((c) => c[0] === "publishPackage"), "dry run stops before the real publish call");

  const pushCall = calls.find((c) => c[0] === "pushBranch");
  assert.deepEqual(pushCall, ["pushBranch", DRY_RUN_BRANCH, { force: true }]);
});

test("dry run's README preview excludes the track even though it was never actually deleted from R2", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-dryrun-readme-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let previewReadme = null;
  const { deps } = makeFakeDeleteDeps({
    git: {
      async addAndCommit(cwd) {
        previewReadme = await fsp.readFile(path.join(cwd, "README.md"), "utf8");
      },
    },
  });

  await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.match(previewReadme, /Keeper Track - Someone/);
  assert.doesNotMatch(previewReadme, /Track To Delete/);
});

test("dry run removes the locally-downloaded copy of the track before building, so the preview package doesn't include it", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-dryrun-buildfiles-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let mixtapeDirAtBuildTime = null;
  const { deps } = makeFakeDeleteDeps({
    buildPackage: async ({ configPath, versionNumber }) => {
      const cloneDir = path.dirname(configPath);
      mixtapeDirAtBuildTime = await fsp.readdir(path.join(cloneDir, "my mixtape"));
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      await fsp.mkdir(path.dirname(zipPath), { recursive: true });
      await fsp.writeFile(zipPath, "fake zip bytes");
    },
  });

  await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.ok(!mixtapeDirAtBuildTime.includes("Track To Delete - Someone Else.ogg"));
  assert.ok(mixtapeDirAtBuildTime.includes("Keeper Track - Someone.ogg"));
});

test("a real deletion that succeeds but fails to update the manifest afterward is still reported as a success, not committedButNotPublished", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-manifest-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const errorLines = [];
  const { deps } = makeFakeDeleteDeps({
    manifest: { async removeTrack() { throw new Error("R2 write hiccup"); } },
    logError: (...args) => errorLines.push(args.join(" ")),
  });

  const result = await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, false);
  assert.ok(result.versionNumber);
  assert.ok(errorLines.some((l) => l.includes("published successfully but failed to record it during stage \"record-manifest\"")));
});

test("a real deletion where the branch push succeeds but the build/publish fails is reported as committedButNotPublished", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-committed-not-published-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { deps } = makeFakeDeleteDeps({
    buildPackage: async () => {
      throw new Error("tcli build failed");
    },
  });

  await assert.rejects(
    () =>
      processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.committedButNotPublished, true);
      assert.match(err.message, /Removal committed to main but publishing failed/);
      return true;
    }
  );
});

test("cleanup always removes the temp clone directory, even on failure", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-cleanup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let capturedCloneDir = null;
  const { deps } = makeFakeDeleteDeps({
    git: {
      async cloneRepo(repoUrl, branch, destDir) {
        capturedCloneDir = destDir;
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.writeFile(path.join(destDir, "README.md"), SAMPLE_README);
        throw new Error("clone-adjacent failure for the test");
      },
    },
  });

  await assert.rejects(() =>
    processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    })
  );

  await assert.rejects(() => fsp.access(capturedCloneDir));
});

// --- Progress hook + cancellation (for the loading-bar/modal feature) ---

test("onStageChange fires for every real stage transition, in order, matching what's logged", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-onstage-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const seenStages = [];
  const { deps } = makeFakeDeleteDeps();

  await processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
    onStageChange: (name) => seenStages.push(name),
  });

  assert.deepEqual(seenStages, [
    "check-bandwidth-lock",
    "check-exists",
    "clone",
    "delete-from-r2",
    "regenerate-readme",
    "commit",
    "compute-version",
    "push-branch",
    "push-tag",
    "download-all-tracks",
    "tcli-build",
    "tcli-publish",
    "record-manifest",
    "record-bandwidth",
    "cleanup",
  ]);
});

test("checkCancelled true from the start aborts before any real work, throwing a cancelled SubmissionError", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-cancel-early-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeleteDeps();

  await assert.rejects(
    () =>
      processDeletion({ filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
        checkCancelled: () => true,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.cancelled, true);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
  assert.ok(!calls.some((c) => c[0] === "deleteTrack"), "must never delete the real R2 object if cancelled before that stage");
});

test("cancellation is never checked once CANCEL_CUTOFF_STAGE (push-branch) is reached — the pipeline completes normally regardless", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "delete-test-cancel-toolate-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { deps } = makeFakeDeleteDeps();

  let pastCutoff = false;
  const result = await processDeletion(
    { filename: "Track To Delete - Someone Else.ogg", displayName: "Alex" },
    BASE_CONFIG,
    {
      ...deps,
      tmpBase: tmpDir,
      checkCancelled: () => pastCutoff,
      onStageChange: (name) => {
        if (name === "push-branch") pastCutoff = true;
      },
    }
  );

  assert.ok(result.versionNumber, "the job ran to completion despite checkCancelled becoming true partway through");
});
