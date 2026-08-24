import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  processPublish,
  SubmissionError,
  THUNDERSTORE_URL,
  DRY_RUN_BRANCH,
  DRY_RUN_TAG_PREFIX,
  SOURCE_BRANCH,
  MAX_TRACKS,
  buildOutputZipPath,
} from "../src/publish.js";
import { PENDING_PREFIX } from "../src/storage.js";
import { LOCK_THRESHOLD_BYTES } from "../src/bandwidth.js";

const SAMPLE_README = `# Title\n\n<!-- TRACKLIST:START -->\n1. Keeper Track - Someone\n2. Old Track - Someone Else\n<!-- TRACKLIST:END -->\n`;

const DEFAULT_MANIFEST = {
  tracks: {
    "Keeper Track - Someone.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
    "Old Track - Someone Else.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
    "New Track - Someone Third.ogg": { addedBy: "Rob", addedAt: "2026-08-20T00:00:00.000Z", status: "pending" },
  },
  pendingDeletes: ["Old Track - Someone Else.ogg"],
  publishLog: [],
};

function makeFakeDeps(overrides = {}) {
  const calls = [];
  let currentManifest = overrides.initialManifest || DEFAULT_MANIFEST;
  let applied = false; // whether apply-queue (real deletes/promotes) has happened yet

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
    async deleteTrack(client, bucket, filename) {
      calls.push(["deleteTrack", filename]);
    },
    async promotePendingTrack(client, bucket, filename) {
      calls.push(["promotePendingTrack", filename]);
      applied = true;
    },
    async listTracks() {
      calls.push(["listTracks"]);
      // Once the batch has actually been applied to R2 (real run only),
      // reflect the post-apply state; otherwise the pre-publish live set.
      return applied
        ? ["Keeper Track - Someone", "New Track - Someone Third"]
        : ["Keeper Track - Someone", "Old Track - Someone Else"];
    },
    async downloadAllTracks(client, bucket, destDir) {
      calls.push(["downloadAllTracks", destDir]);
      await fsp.mkdir(destDir, { recursive: true });
      await fsp.writeFile(path.join(destDir, "Keeper Track - Someone.ogg"), "fake ogg bytes");
      if (applied) {
        await fsp.writeFile(path.join(destDir, "New Track - Someone Third.ogg"), "fake ogg bytes");
        return 2;
      }
      await fsp.writeFile(path.join(destDir, "Old Track - Someone Else.ogg"), "fake ogg bytes");
      return 2;
    },
    async downloadTrackTo(client, bucket, filename, destPath) {
      calls.push(["downloadTrackTo", filename, destPath]);
      await fsp.writeFile(destPath, "fake pending ogg bytes");
    },
    ...(overrides.storage || {}),
  };

  const fetchNextVersion = overrides.fetchNextVersion || (async () => {
    calls.push(["fetchNextVersion"]);
    return { versionNumber: "1.0.18", tagName: "v1.0.18" };
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
    async getManifest() {
      calls.push(["manifest.getManifest"]);
      return currentManifest;
    },
    async applyPublishBatch(client, bucket, opts) {
      calls.push(["manifest.applyPublishBatch", opts]);
      return currentManifest;
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

test("processPublish happy path: runs every step in order, deletes then promotes, and returns a summary of the batch", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps();

  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.equal(result.dryRun, false);
  assert.deepEqual(result.added, ["New Track - Someone Third"]);
  assert.deepEqual(result.deleted, ["Old Track - Someone Else"]);
  assert.equal(result.versionNumber, "1.0.18");
  assert.equal(result.thunderstoreUrl, THUNDERSTORE_URL);

  assert.deepEqual(calls.map((c) => c[0]), [
    "bandwidth.getUsage",
    "manifest.getManifest",
    "cloneRepo",
    "deleteTrack",
    "promotePendingTrack",
    "listTracks",
    "addAndCommit",
    "fetchNextVersion",
    "tagCommit",
    "pushBranch",
    "pushTag",
    "downloadAllTracks",
    "buildPackage",
    "listTracks",
    "publishPackage",
    "manifest.applyPublishBatch",
    "bandwidth.recordPublish",
    "getHeadSha",
  ]);

  const applyCall = calls.find((c) => c[0] === "manifest.applyPublishBatch");
  assert.deepEqual(applyCall[1], {
    publishedFilenames: ["New Track - Someone Third.ogg"],
    deletedFilenames: ["Old Track - Someone Else.ogg"],
  });
});

test("regenerates the README to include the promoted add and exclude the deleted track", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-readme-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let committedReadme = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd) {
        committedReadme = await fsp.readFile(path.join(cwd, "README.md"), "utf8");
      },
    },
  });

  await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.match(committedReadme, /Keeper Track - Someone/);
  assert.match(committedReadme, /New Track - Someone Third/);
  assert.doesNotMatch(committedReadme, /Old Track - Someone Else/);
});

test("commit message summarizes both the added and deleted tracks", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-commitmsg-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let commitMessage = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd, files, opts) {
        commitMessage = opts.message;
      },
    },
  });

  await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.match(commitMessage, /\+New Track - Someone Third/);
  assert.match(commitMessage, /-Old Track - Someone Else/);
  assert.match(commitMessage, /published by Rob via contribute-app/);
});

test("refuses to run when the queue is empty, before any clone/apply work", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-empty-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps({
    initialManifest: { tracks: {}, pendingDeletes: [], publishLog: [] },
  });

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.match(err.message, /Nothing to publish/);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("refuses to run when config.branch is not 'main', before touching the manifest at all", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-branch-guard-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps();
  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test" };

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, testBranchConfig, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-target-branch");
      return true;
    }
  );

  assert.deepEqual(calls, []);
});

test("locks out a real publish once this month's bandwidth usage is at the threshold", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-bwlock-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps({
    bandwidth: { async getUsage() { return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES }; } },
  });

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    /Monthly publish limit reached/
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("refuses to run when the projected track count would exceed MAX_TRACKS, before any clone work", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-limit-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const liveTracks = Object.fromEntries(
    Array.from({ length: MAX_TRACKS }, (_, i) => [`Track ${i} - Artist.ogg`, { addedBy: "Rob", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }])
  );
  const { calls, deps } = makeFakeDeps({
    initialManifest: {
      tracks: { ...liveTracks, "New - Track.ogg": { addedBy: "Rob", addedAt: "2026-08-20T00:00:00.000Z", status: "pending" } },
      pendingDeletes: [],
      publishLog: [],
    },
  });

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    /over the 50-track limit/
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("add-only batch never calls deleteTrack", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-addonly-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps({
    initialManifest: {
      tracks: {
        "Keeper Track - Someone.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
        "New - Track.ogg": { addedBy: "Rob", addedAt: "2026-08-20T00:00:00.000Z", status: "pending" },
      },
      pendingDeletes: [],
      publishLog: [],
    },
  });

  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.deepEqual(result.deleted, []);
  assert.ok(!calls.some((c) => c[0] === "deleteTrack"));
  assert.ok(calls.some((c) => c[0] === "promotePendingTrack"));
});

test("delete-only batch never calls promotePendingTrack", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-deleteonly-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps({
    initialManifest: {
      tracks: {
        "Keeper Track - Someone.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
        "Old Track - Someone Else.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
      },
      pendingDeletes: ["Old Track - Someone Else.ogg"],
      publishLog: [],
    },
  });

  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.deepEqual(result.added, []);
  assert.ok(!calls.some((c) => c[0] === "promotePendingTrack"));
  assert.ok(calls.some((c) => c[0] === "deleteTrack"));
});

// --- Dry run ---

test("dry run never touches real R2 (no deleteTrack/promotePendingTrack/manifest writes/bandwidth), and pushes to DRY_RUN_BRANCH", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps();

  const result = await processPublish({ displayName: "Rob", dryRun: true }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.equal(result.dryRun, true);
  assert.equal(result.branch, DRY_RUN_BRANCH);
  assert.equal(result.tagName, `${DRY_RUN_TAG_PREFIX}v1.0.18`);
  assert.ok(!calls.some((c) => c[0] === "deleteTrack"));
  assert.ok(!calls.some((c) => c[0] === "promotePendingTrack"));
  assert.ok(!calls.some((c) => c[0] === "manifest.applyPublishBatch"));
  assert.ok(!calls.some((c) => c[0] === "bandwidth.getUsage"), "dry runs skip the lock check entirely");
  assert.ok(!calls.some((c) => c[0] === "bandwidth.recordPublish"));
  assert.ok(!calls.some((c) => c[0] === "publishPackage"), "dry run stops before the real publish call");

  const pushCall = calls.find((c) => c[0] === "pushBranch");
  assert.deepEqual(pushCall, ["pushBranch", DRY_RUN_BRANCH, { force: true }]);
});

test("dry run's README preview and build both reflect the queue accurately without ever mutating real R2", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-preview-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let previewReadme = null;
  let mixtapeFilesAtBuildTime = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd) {
        previewReadme = await fsp.readFile(path.join(cwd, "README.md"), "utf8");
      },
    },
    buildPackage: async ({ configPath, versionNumber }) => {
      const cloneDir = path.dirname(configPath);
      mixtapeFilesAtBuildTime = await fsp.readdir(path.join(cloneDir, "my mixtape"));
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      await fsp.mkdir(path.dirname(zipPath), { recursive: true });
      await fsp.writeFile(zipPath, "fake zip bytes");
    },
  });

  await processPublish({ displayName: "Rob", dryRun: true }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.match(previewReadme, /New Track - Someone Third/);
  assert.doesNotMatch(previewReadme, /Old Track - Someone Else/);

  assert.ok(mixtapeFilesAtBuildTime.includes("New Track - Someone Third.ogg"), "the pending add's real bytes were downloaded for the preview build");
  assert.ok(!mixtapeFilesAtBuildTime.includes("Old Track - Someone Else.ogg"), "the pending delete's local copy was removed from the preview build");
  assert.ok(mixtapeFilesAtBuildTime.includes("Keeper Track - Someone.ogg"));
});

test("dry run downloads pending adds from PENDING_PREFIX", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-pendingdl-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const downloadPrefixes = [];
  const { deps } = makeFakeDeps({
    storage: {
      async listTracks() {
        return ["Keeper Track - Someone", "Old Track - Someone Else"];
      },
      async downloadAllTracks(client, bucket, destDir) {
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.writeFile(path.join(destDir, "Keeper Track - Someone.ogg"), "x");
        await fsp.writeFile(path.join(destDir, "Old Track - Someone Else.ogg"), "x");
        return 2;
      },
      async downloadTrackTo(client, bucket, filename, destPath, opts) {
        downloadPrefixes.push(opts?.prefix);
        await fsp.writeFile(destPath, "x");
      },
    },
  });

  await processPublish({ displayName: "Rob", dryRun: true }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.deepEqual(downloadPrefixes, [PENDING_PREFIX]);
});

// --- Failure/partial-failure semantics ---

test("committedButNotPublished when the branch push succeeds but the build/publish fails", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-committed-not-published-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { deps } = makeFakeDeps({
    buildPackage: async () => {
      throw new Error("tcli build failed");
    },
  });

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.committedButNotPublished, true);
      assert.match(err.message, /Publish committed to main but publishing failed/);
      return true;
    }
  );
});

test("a real publish that succeeds but fails to update the manifest afterward is still reported as a success", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-manifest-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const errorLines = [];
  const { deps } = makeFakeDeps({
    manifest: {
      async getManifest() { return DEFAULT_MANIFEST; },
      async applyPublishBatch() { throw new Error("R2 write hiccup"); },
    },
    logError: (...args) => errorLines.push(args.join(" ")),
  });

  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.equal(result.dryRun, false);
  assert.ok(result.versionNumber);
  assert.ok(errorLines.some((l) => l.includes('published successfully but failed to record it during stage "record-manifest"')));
});

test("a real publish that succeeds but fails to record bandwidth afterward is still reported as a success", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-bandwidth-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const errorLines = [];
  const { deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() { return { month: "2026-08", bytesUsed: 0 }; },
      async recordPublish() { throw new Error("R2 write hiccup"); },
    },
    logError: (...args) => errorLines.push(args.join(" ")),
  });

  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  assert.equal(result.dryRun, false);
  assert.ok(errorLines.some((l) => l.includes('published successfully but failed to record it during stage "record-bandwidth"')));
});

test("re-checks the track limit immediately before the real publish call, as a final safety net", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-recheck-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { deps } = makeFakeDeps({
    storage: {
      async deleteTrack() {},
      async promotePendingTrack() {},
      async listTracks() {
        // Simulates an out-of-band R2 change pushing the real count over
        // the limit between the early check and this final one.
        return Array.from({ length: MAX_TRACKS + 1 }, (_, i) => `Track ${i}`);
      },
      async downloadAllTracks(client, bucket, destDir) {
        await fsp.mkdir(destDir, { recursive: true });
        return 0;
      },
      async downloadTrackTo() {},
    },
  });

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.match(err.message, /exceeds the 50-track limit right before publish/);
      // This fires after push-branch/push-tag already succeeded.
      assert.equal(err.committedButNotPublished, true);
      return true;
    }
  );
});

test("trackBandwidth: false skips the lock check and recording entirely", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-nobw-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps({
    bandwidth: { async getUsage() { return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES }; } },
  });

  await processPublish({ displayName: "Rob" }, { ...BASE_CONFIG, trackBandwidth: false }, { ...deps, tmpBase: tmpDir });

  assert.ok(!calls.some((c) => c[0] === "bandwidth.getUsage"));
  assert.ok(!calls.some((c) => c[0] === "bandwidth.recordPublish"));
});

// --- Progress hook + cancellation ---

test("onStageChange fires for every real stage transition, in order", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-onstage-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const seenStages = [];
  const { deps } = makeFakeDeps();

  await processPublish({ displayName: "Rob" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
    onStageChange: (name) => seenStages.push(name),
  });

  assert.deepEqual(seenStages, [
    "check-bandwidth-lock",
    "check-pending",
    "check-track-limit",
    "clone",
    "apply-queue",
    "regenerate-readme",
    "commit",
    "compute-version",
    "push-branch",
    "push-tag",
    "download-all-tracks",
    "tcli-build",
    "check-track-limit-pre-publish",
    "tcli-publish",
    "record-manifest",
    "record-bandwidth",
    "cleanup",
  ]);
});

test("logs a batch summary naming the actual added/deleted tracks, not just counts", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-batchlog-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const logLines = [];
  const { deps } = makeFakeDeps({ log: (...args) => logLines.push(args.join(" ")) });

  await processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir });

  const batchLine = logLines.find((l) => l.includes("batch:"));
  assert.ok(batchLine, "expected a log line summarizing the batch");
  assert.match(batchLine, /\+1 add \[New Track - Someone Third\]/);
  assert.match(batchLine, /-1 delete \[Old Track - Someone Else\]/);
});

test("checkCancelled true from the start aborts before any real work, throwing a cancelled SubmissionError", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cancel-early-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { calls, deps } = makeFakeDeps();

  await assert.rejects(
    () => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir, checkCancelled: () => true }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.cancelled, true);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"));
});

test("cancellation is never checked once CANCEL_CUTOFF_STAGE (push-branch) is reached — the pipeline completes normally regardless", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cancel-toolate-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const { deps } = makeFakeDeps();

  let pastCutoff = false;
  const result = await processPublish({ displayName: "Rob" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
    checkCancelled: () => pastCutoff,
    onStageChange: (name) => {
      if (name === "push-branch") pastCutoff = true;
    },
  });

  assert.ok(result.versionNumber);
});

test("cleanup always removes the temp clone directory, even on failure", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cleanup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  let capturedCloneDir = null;
  const { deps } = makeFakeDeps({
    git: {
      async cloneRepo(repoUrl, branch, destDir) {
        capturedCloneDir = destDir;
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.writeFile(path.join(destDir, "README.md"), SAMPLE_README);
        throw new Error("clone-adjacent failure for the test");
      },
    },
  });

  await assert.rejects(() => processPublish({ displayName: "Rob" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }));
  await assert.rejects(() => fsp.access(capturedCloneDir));
});
