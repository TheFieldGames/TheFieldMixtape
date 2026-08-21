import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  processSubmission,
  SubmissionError,
  THUNDERSTORE_URL,
  DRY_RUN_BRANCH,
  DRY_RUN_TAG_PREFIX,
  SOURCE_BRANCH,
  MAX_TRACKS,
  MAX_TRACK_FILE_SIZE_BYTES,
  buildOutputZipPath,
} from "../src/publish.js";
import { TRACK_PREFIX, DRY_RUN_PREFIX } from "../src/storage.js";
import { LOCK_THRESHOLD_BYTES } from "../src/bandwidth.js";

const SAMPLE_README = `# Title\n\n<!-- TRACKLIST:START -->\n1. Existing Track - Someone\n<!-- TRACKLIST:END -->\n`;

function makeFakeDeps(overrides = {}) {
  const calls = [];

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
      calls.push(["pushBranch", cwd, branch, opts]);
    },
    async pushTag(cwd, tagName, opts) {
      calls.push(["pushTag", cwd, tagName, opts]);
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
      return false;
    },
    async uploadTrack(client, bucket, filename, filePath, opts) {
      calls.push(["uploadTrack", filename, filePath, opts]);
    },
    async listTracks() {
      calls.push(["listTracks"]);
      return ["Existing Track - Someone", "New Track - Someone Else"];
    },
    async downloadAllTracks(client, bucket, destDir) {
      calls.push(["downloadAllTracks", destDir]);
      // Real downloadAllTracks() creates destDir even with nothing to
      // download — matched here since the dry-run path copies a file into
      // it immediately afterward and needs it to exist.
      await fsp.mkdir(destDir, { recursive: true });
      return 2;
    },
    ...(overrides.storage || {}),
  };

  const convert = overrides.convert || (async (inputPath, outputPath) => {
    calls.push(["convert", inputPath, outputPath]);
    // Real convertToOgg() always leaves a real file behind on success —
    // matched here since the dry-run path copies this file elsewhere.
    await fsp.writeFile(outputPath, "fake ogg bytes");
  });

  const fetchNextVersion = overrides.fetchNextVersion || (async () => {
    calls.push(["fetchNextVersion"]);
    return { versionNumber: "1.0.12", tagName: "v1.0.12" };
  });

  const publishPackage = overrides.publishPackage || (async (opts) => {
    calls.push(["publishPackage", opts]);
  });

  // Real buildPackage() always leaves a real zip on disk at the
  // deterministic path — matched here since processSubmission stats that
  // exact path right after calling this.
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
    async recordTrackAdded(client, bucket, filename, addedBy) {
      calls.push(["manifest.recordTrackAdded", filename, addedBy]);
      return { tracks: { [filename]: { addedBy, addedAt: "2026-08-20T00:00:00.000Z", status: "live" } }, pendingDeletes: [], publishLog: [] };
    },
    ...(overrides.manifest || {}),
  };

  // Silent by default so `npm test` output stays clean — tests that
  // specifically want to verify logging behavior pass their own log/logError.
  const log = overrides.log || (() => {});
  const logError = overrides.logError || (() => {});

  return {
    calls,
    deps: { git, storage, convert, fetchNextVersion, publishPackage, buildPackage, bandwidth, manifest, log, logError },
  };
}

async function makeUploadFile(tmpDir) {
  const uploadPath = path.join(tmpDir, "upload.mp3");
  await fsp.writeFile(uploadPath, "fake mp3 bytes");
  return uploadPath;
}

const BASE_CONFIG = {
  repoUrl: "https://x-access-token:tok@github.com/TheFieldGames/TheFieldMixtape.git",
  branch: "main",
  r2Client: {},
  r2Bucket: "thefieldmixtape-audio",
  tcliPath: "tcli",
};

test("processSubmission happy path: runs every step in the exact plan-specified order and returns success info", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  const result = await processSubmission(
    { uploadPath, title: "New Track", artist: "Someone Else", displayName: "Alex" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.filename, "New Track - Someone Else.ogg");
  assert.equal(result.trackName, "New Track - Someone Else");
  assert.equal(result.versionNumber, "1.0.12");
  assert.equal(result.tagName, "v1.0.12");
  assert.equal(result.commitSha, "deadbeef");
  assert.equal(result.thunderstoreUrl, THUNDERSTORE_URL);

  assert.deepEqual(calls.map((c) => c[0]), [
    "bandwidth.getUsage",
    "trackExists",
    "listTracks",
    "cloneRepo",
    "convert",
    "uploadTrack",
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
    "manifest.recordTrackAdded",
    "bandwidth.recordPublish",
    "getHeadSha",
  ]);
});

test("processSubmission aborts on duplicate filename before touching git/convert/anything else", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);

  // A dedicated call log for this test: the override below is the ONLY
  // storage/git function that should ever run, so it's the only one that
  // needs to record into it (unlike makeFakeDeps' own internal `calls`,
  // which an override replaces entirely rather than wrapping).
  const calls = [];
  const { deps } = makeFakeDeps({
    storage: {
      async trackExists() {
        calls.push("trackExists");
        return true;
      },
    },
  });

  await assert.rejects(
    processSubmission(
      { uploadPath, title: "Dup", artist: "Track", displayName: "Alex" },
      BASE_CONFIG,
      { ...deps, tmpBase: tmpDir }
    ),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-duplicate");
      assert.equal(err.committedButNotPublished, false);
      assert.match(err.message, /already exists/);
      return true;
    }
  );

  assert.deepEqual(calls, ["trackExists"]);
});

test("processSubmission: failure AFTER the branch push marks committedButNotPublished true (the documented partial-failure mode)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-fail-late-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    publishPackage: async () => {
      throw new Error("Thunderstore API 500");
    },
  });

  await assert.rejects(
    processSubmission(
      { uploadPath, title: "T", artist: "A", displayName: "Alex" },
      BASE_CONFIG,
      { ...deps, tmpBase: tmpDir }
    ),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.committedButNotPublished, true);
      assert.match(err.message, /committed to main but publishing failed/);
      assert.match(err.message, /Thunderstore API 500/);
      return true;
    }
  );
});

test("processSubmission: failure BEFORE/AT the branch push marks committedButNotPublished false", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-fail-early-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    git: {
      async pushBranch() {
        throw new Error("network unreachable");
      },
    },
  });

  await assert.rejects(
    processSubmission(
      { uploadPath, title: "T", artist: "A", displayName: "Alex" },
      BASE_CONFIG,
      { ...deps, tmpBase: tmpDir }
    ),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.committedButNotPublished, false);
      assert.match(err.message, /Publishing failed before the commit was pushed/);
      assert.match(err.message, /network unreachable/);
      return true;
    }
  );
});

test("processSubmission always cleans up the temp clone dir, converted file, and uploaded file — even on failure", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cleanup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    publishPackage: async () => {
      throw new Error("boom");
    },
  });

  await assert.rejects(
    processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    })
  );

  const remaining = await fsp.readdir(tmpDir);
  assert.deepEqual(remaining, []);
});

test("processSubmission cleans up on the happy path too (no leftover temp files after success)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cleanup-ok-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  const remaining = await fsp.readdir(tmpDir);
  assert.deepEqual(remaining, []);
});

test("processSubmission builds the commit message with track name and submitter attribution", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-msg-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let commitOpts = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd, files, opts) {
        commitOpts = opts;
      },
    },
  });

  await processSubmission(
    { uploadPath, title: "Some Song", artist: "Some Artist", displayName: "Jamie" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(commitOpts.authorName, "Jamie");
  assert.equal(commitOpts.message, "Add track: Some Song - Some Artist (submitted by Jamie via contribute-app)");
});

test("processSubmission only stages README.md for commit, never the .ogg file (audio goes to R2, not git)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-stage-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let stagedFiles = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd, files) {
        stagedFiles = files;
      },
    },
  });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.deepEqual(stagedFiles, ["README.md"]);
});

test("processSubmission downloads the full R2 library into <clone>/my mixtape before publishing", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dl-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let downloadDestDir = null;
  const { deps } = makeFakeDeps({
    storage: {
      async downloadAllTracks(client, bucket, destDir) {
        downloadDestDir = destDir;
        return 1;
      },
    },
  });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.ok(downloadDestDir.endsWith(path.join("my mixtape")));
});

// --- Dry run ---

test("dry run: uploads under the DRY_RUN_PREFIX, never the real track namespace", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-r2-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let uploadOpts = null;
  const { deps } = makeFakeDeps({
    storage: {
      async uploadTrack(client, bucket, filename, filePath, opts) {
        uploadOpts = opts;
      },
    },
  });

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.deepEqual(uploadOpts, { prefix: DRY_RUN_PREFIX });
});

test("dry run: pushes to DRY_RUN_BRANCH with force, never config.branch ('main')", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-branch-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const pushCalls = [];
  const { deps } = makeFakeDeps({
    git: {
      async pushBranch(cwd, branch, opts) {
        pushCalls.push(["pushBranch", branch, opts]);
      },
      async pushTag(cwd, tagName, opts) {
        pushCalls.push(["pushTag", tagName, opts]);
      },
    },
  });

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.deepEqual(pushCalls[0], ["pushBranch", DRY_RUN_BRANCH, { force: true }]);
  assert.notEqual(pushCalls[0][1], "main");
  assert.equal(pushCalls[1][0], "pushTag");
  assert.equal(pushCalls[1][2].force, true);
});

test("dry run: tags with the DRY_RUN_TAG_PREFIX, keeping it outside the real vX.Y.Z sequence version.js parses", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-tag-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.tagName, `${DRY_RUN_TAG_PREFIX}v1.0.12`);
  // versionNumber still reports the real "would publish as" number, computed
  // the same way as a real submission — only the pushed tag is renamed.
  assert.equal(result.versionNumber, "1.0.12");
});

test("dry run: calls tcli build, never tcli publish", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-build-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  const stepNames = calls.map((c) => c[0]);
  assert.ok(stepNames.includes("buildPackage"));
  assert.ok(!stepNames.includes("publishPackage"));
});

test("dry run: commit message is prefixed with [DRY RUN]", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-msg-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let commitOpts = null;
  const { deps } = makeFakeDeps({
    git: {
      async addAndCommit(cwd, files, opts) {
        commitOpts = opts;
      },
    },
  });

  await processSubmission(
    { uploadPath, title: "Some Song", artist: "Some Artist", displayName: "Jamie", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(commitOpts.message, "[DRY RUN] Add track: Some Song - Some Artist (submitted by Jamie via contribute-app)");
});

test("dry run: README preview includes the new track even though it's not in the real R2 listing yet", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-readme-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let writtenReadme = null;
  const { deps } = makeFakeDeps({
    git: {
      async cloneRepo(repoUrl, branch, destDir) {
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.writeFile(path.join(destDir, "README.md"), SAMPLE_README);
      },
      async addAndCommit(cwd) {
        writtenReadme = await fsp.readFile(path.join(cwd, "README.md"), "utf8");
      },
    },
  });

  await processSubmission(
    { uploadPath, title: "Brand New", artist: "Track", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  // makeFakeDeps' default listTracks() returns the existing 2 real tracks;
  // the dry-run track must appear too even though no fake ever "uploaded"
  // it under the real prefix.
  assert.match(writtenReadme, /Brand New - Track/);
});

test("dry run: the converted file actually lands in <clone>/my mixtape/<filename> before tcli build runs (checked from inside buildPackage, before cleanup wipes the clone dir)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-copy2-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let sawTrackFile = false;
  const { deps } = makeFakeDeps({
    buildPackage: async ({ configPath, versionNumber }) => {
      const cloneDir = path.dirname(configPath);
      const mixtapeDir = path.join(cloneDir, "my mixtape");
      const files = await fsp.readdir(mixtapeDir);
      sawTrackFile = files.includes("Copy Me - Please.ogg");
      // Real buildPackage() always leaves a zip behind — matched here too.
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      await fsp.mkdir(path.dirname(zipPath), { recursive: true });
      await fsp.writeFile(zipPath, "fake zip bytes");
    },
  });

  await processSubmission(
    { uploadPath, title: "Copy Me", artist: "Please", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(sawTrackFile, true);
});

test("dry run: result marks dryRun true and reports the isolated branch name", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-result-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.branch, DRY_RUN_BRANCH);
});

test("dry run failure never reports committedButNotPublished (that's a real-submission-only concept)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    buildPackage: async () => {
      throw new Error("Icon not found");
    },
  });

  await assert.rejects(
    processSubmission(
      { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
      BASE_CONFIG,
      { ...deps, tmpBase: tmpDir }
    ),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.committedButNotPublished, false);
      assert.match(err.message, /dry-run build failed/);
      assert.match(err.message, /Icon not found/);
      return true;
    }
  );
});

test("real submissions: real prefix, real branch, no force-push, both buildPackage and publishPackage called (build-then-publish-with-file, not skipped)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-real-unaffected-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex" }, // dryRun omitted entirely
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, false);
  assert.equal(result.branch, "main");
  assert.equal(result.tagName, "v1.0.12");

  const uploadCall = calls.find((c) => c[0] === "uploadTrack");
  assert.deepEqual(uploadCall[3], { prefix: TRACK_PREFIX });

  const pushBranchCall = calls.find((c) => c[0] === "pushBranch");
  assert.equal(pushBranchCall[2], "main");
  assert.deepEqual(pushBranchCall[3], { force: false });

  // Real submissions now build first too (needed for exact bandwidth
  // measurement — see the "record-bandwidth" tests below), then publish
  // with --file rather than letting tcli rebuild internally.
  assert.ok(calls.some((c) => c[0] === "buildPackage"));
  assert.ok(calls.some((c) => c[0] === "publishPackage"));
  const publishCall = calls.find((c) => c[0] === "publishPackage");
  assert.ok(publishCall[1].filePath, "publishPackage should be called with a filePath, not a versionNumber");
  assert.ok(calls.some((c) => c[0] === "bandwidth.recordPublish"));
});

// --- Regression: real bug hit during manual testing ---
// `git clone --branch <name>` requires that branch to already exist on the
// remote. config.branch is sometimes a disposable, not-yet-created test
// branch (e.g. GIT_TARGET_BRANCH=contribute-app-test for local dev, per the
// plan's own verification guidance) — cloning from it directly failed with
// "Remote branch ... not found" on first use. Fix: always clone from
// SOURCE_BRANCH ("main"), independent of where the result gets pushed.
//
// Exercised via a dry run: a *real* submission with a non-main config.branch
// is now refused outright before it ever clones (see the target-branch guard
// tests below), so the only submission this scenario can still legitimately
// happen through is a dry run.
test("clone always uses SOURCE_BRANCH ('main'), never config.branch — even when config.branch doesn't exist yet on the remote", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-clone-source-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let clonedBranch = null;
  const { deps } = makeFakeDeps({
    git: {
      async cloneRepo(repoUrl, branch, destDir) {
        clonedBranch = branch;
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.writeFile(path.join(destDir, "README.md"), SAMPLE_README);
      },
    },
  });

  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test-does-not-exist-yet" };

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    testBranchConfig,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(clonedBranch, SOURCE_BRANCH);
  assert.equal(clonedBranch, "main");
});

test("dry run pushing while config.branch is a non-main test branch still force-pushes to DRY_RUN_BRANCH, since clone always starts fresh from main", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-testbranch-force-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const pushCalls = [];
  const { deps } = makeFakeDeps({
    git: {
      async pushBranch(cwd, branch, opts) {
        pushCalls.push(["pushBranch", branch, opts]);
      },
      async pushTag(cwd, tagName, opts) {
        pushCalls.push(["pushTag", tagName, opts]);
      },
    },
  });

  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test" };

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    testBranchConfig,
    { ...deps, tmpBase: tmpDir }
  );

  assert.deepEqual(pushCalls[0], ["pushBranch", DRY_RUN_BRANCH, { force: true }]);
  assert.equal(pushCalls[1][2].force, true);
});

// --- Guard: a real (non-dry-run) publish is refused unless config.branch
// is SOURCE_BRANCH ('main'). GIT_TARGET_BRANCH only ever controlled where a
// commit/tag landed, never whether tcli publish ran — an instance left
// pointed at a disposable test branch could previously publish for real
// while its commit silently landed off of main. This is exactly what
// happened with "F.O.M.O. - Your Neighbors" (see MixTapeWebPlan.md's
// "Incident: real publish landed on the wrong git branch"). ---

test("real submission refuses to run when config.branch is not 'main', before any clone/convert/publish work happens", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-branch-guard-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test" };

  await assert.rejects(
    () =>
      processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, testBranchConfig, {
        ...deps,
        tmpBase: tmpDir,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-target-branch");
      assert.equal(err.committedButNotPublished, false);
      assert.match(err.message, /contribute-app-test/);
      assert.match(err.message, /main/);
      return true;
    }
  );

  assert.deepEqual(calls, [], "no clone, convert, upload, or publish work should have started");
});

test("dry run still runs normally even when config.branch is not 'main' — the guard only applies to real publishes", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-branch-guard-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  const testBranchConfig = { ...BASE_CONFIG, branch: "contribute-app-test" };

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    testBranchConfig,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.branch, DRY_RUN_BRANCH);
});

test("real production submission (config.branch === 'main') still never force-pushes", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-prod-noforce-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const pushCalls = [];
  const { deps } = makeFakeDeps({
    git: {
      async pushBranch(cwd, branch, opts) {
        pushCalls.push(opts);
      },
      async pushTag(cwd, tagName, opts) {
        pushCalls.push(opts);
      },
    },
  });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.deepEqual(pushCalls, [{ force: false }, { force: false }]);
});

// --- Logging ---

test("logs a line for every stage transition, in order, so a real run's progress is visible in the terminal", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-log-stages-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const logLines = [];
  const { deps } = makeFakeDeps({ log: (...args) => logLines.push(args.join(" ")) });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  const stageLines = logLines.filter((l) => l.includes("..."));
  const stagesSeenInOrder = [
    "check-duplicate",
    "clone",
    "convert",
    "upload-to-r2",
    "regenerate-readme",
    "commit",
    "compute-version",
    "push-branch",
    "push-tag",
    "download-all-tracks",
    "tcli-publish",
    "cleanup",
  ];
  let lastIndex = -1;
  for (const wantStage of stagesSeenInOrder) {
    const idx = stageLines.findIndex((l) => l.includes(`${wantStage}...`));
    assert.ok(idx !== -1, `expected a log line for stage "${wantStage}"`);
    assert.ok(idx > lastIndex, `stage "${wantStage}" logged out of order`);
    lastIndex = idx;
  }

  assert.ok(logLines.some((l) => l.includes("started:") && l.includes("Alex")));
  assert.ok(logLines.some((l) => l.includes("succeeded in")));
});

test("logs FAILED with the failing stage and elapsed time when a step throws, via logError", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-log-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const errorLines = [];
  const { deps } = makeFakeDeps({
    logError: (...args) => errorLines.push(args.join(" ")),
    publishPackage: async () => {
      throw new Error("Thunderstore API 500");
    },
  });

  await assert.rejects(
    processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    })
  );

  assert.ok(errorLines.some((l) => l.includes("FAILED") && l.includes("tcli-publish")));
});

test("dry run's started log clearly marks it as [DRY RUN]", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-log-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const logLines = [];
  const { deps } = makeFakeDeps({ log: (...args) => logLines.push(args.join(" ")) });

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.ok(logLines.some((l) => l.includes("started:") && l.includes("[DRY RUN]")));
});

// --- Track count limit ---

test(`rejects at the ${MAX_TRACKS}-track limit, before clone/convert ever run`, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-maxtracks-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const fullLibrary = Array.from({ length: MAX_TRACKS }, (_, i) => `Track ${i} - Someone`);
  const { calls, deps } = makeFakeDeps({ storage: { async listTracks() { return fullLibrary; } } });

  await assert.rejects(
    processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-track-limit");
      assert.match(err.message, new RegExp(`${MAX_TRACKS}-track limit`));
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"), "should never clone once already at the limit");
  assert.ok(!calls.some((c) => c[0] === "convert"), "should never convert once already at the limit");
});

test(`allows a submission one under the ${MAX_TRACKS}-track limit`, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-maxtracks-ok-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const almostFullLibrary = Array.from({ length: MAX_TRACKS - 1 }, (_, i) => `Track ${i} - Someone`);
  const { deps } = makeFakeDeps({ storage: { async listTracks() { return almostFullLibrary; } } });

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.equal(result.dryRun, false);
});

// --- Per-file size limit ---

test(`rejects a converted file over ${MAX_TRACK_FILE_SIZE_BYTES} bytes, before it's ever uploaded to R2, and names which track was too big`, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-maxsize-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const oversizedBuffer = Buffer.alloc(MAX_TRACK_FILE_SIZE_BYTES + 1024);
  const { calls, deps } = makeFakeDeps({
    convert: async (inputPath, outputPath) => {
      calls.push(["convert", inputPath, outputPath]);
      await fsp.writeFile(outputPath, oversizedBuffer);
    },
  });

  await assert.rejects(
    processSubmission(
      { uploadPath, title: "Way Too Big", artist: "Someone", displayName: "Alex" },
      BASE_CONFIG,
      { ...deps, tmpBase: tmpDir }
    ),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-file-size");
      assert.match(err.message, /over the 8000KB limit/);
      // The specific track name must be identifiable in the error, not
      // just "some file was too big" — matters even more once multiple
      // tracks can be queued/added in one batch (planned future extension).
      assert.match(err.message, /"Way Too Big - Someone"/);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "uploadTrack"), "should never upload an oversized file to R2");
});

test("allows a converted file exactly at the size limit", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-maxsize-ok-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const exactSizeBuffer = Buffer.alloc(MAX_TRACK_FILE_SIZE_BYTES);
  const { deps } = makeFakeDeps({
    convert: async (inputPath, outputPath) => {
      await fsp.writeFile(outputPath, exactSizeBuffer);
    },
  });

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.equal(result.dryRun, false);
});

// --- Bandwidth lock ---

test("locks out a real submission once this month's usage is at the threshold, before any clone/convert/upload work", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-locked-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() {
        calls.push(["bandwidth.getUsage"]);
        return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES };
      },
    },
  });

  await assert.rejects(
    processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-bandwidth-lock");
      assert.match(err.message, /Monthly publish limit reached/);
      return true;
    }
  );

  assert.deepEqual(calls.map((c) => c[0]), ["bandwidth.getUsage"]);
});

test("does NOT lock a dry run, even when this month's usage is already at/over the threshold", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-not-locked-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() {
        return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES + 1_000_000_000 };
      },
    },
  });

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, true);
});

test("allows a real submission just under the threshold", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-not-locked-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() {
        return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES - 1 };
      },
    },
  });

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.equal(result.dryRun, false);
});

test("records the exact built zip's byte size against this month's usage after a successful real publish", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-record-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const zipContent = Buffer.alloc(555_000);
  let recordedBytes = null;
  const { deps } = makeFakeDeps({
    buildPackage: async ({ configPath, versionNumber }) => {
      const cloneDir = path.dirname(configPath);
      const zipPath = buildOutputZipPath(cloneDir, versionNumber);
      await fsp.mkdir(path.dirname(zipPath), { recursive: true });
      await fsp.writeFile(zipPath, zipContent);
    },
    bandwidth: {
      async getUsage() {
        return { month: "2026-08", bytesUsed: 0 };
      },
      async recordPublish(client, bucket, bytesAdded) {
        recordedBytes = bytesAdded;
        return { month: "2026-08", bytesUsed: bytesAdded };
      },
    },
  });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.equal(recordedBytes, zipContent.length);
});

test("dry run never records bandwidth usage (it never actually publishes)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-norecord-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.ok(!calls.some((c) => c[0] === "bandwidth.recordPublish"));
  assert.ok(!calls.some((c) => c[0] === "bandwidth.getUsage"), "dry runs skip the lock check entirely");
});

test("a real publish that succeeds but fails to record bandwidth afterward is still reported as a success, not committedButNotPublished", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-record-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const errorLines = [];
  const { deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() {
        return { month: "2026-08", bytesUsed: 0 };
      },
      async recordPublish() {
        throw new Error("R2 write hiccup");
      },
    },
    logError: (...args) => errorLines.push(args.join(" ")),
  });

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  // Publish genuinely succeeded — must be reported as such, never as a
  // failure a well-meaning maintainer might "fix" by republishing (which
  // would be a real, unwanted second publish).
  assert.equal(result.dryRun, false);
  assert.ok(result.versionNumber);
  assert.ok(errorLines.some((l) => l.includes("published successfully but failed to record it during stage \"record-bandwidth\"")));
});

// --- Manifest recording ---

test("records the submitter and filename in the manifest after a successful real publish", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-manifest-record-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await processSubmission({ uploadPath, title: "New Track", artist: "Someone Else", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.deepEqual(
    calls.find((c) => c[0] === "manifest.recordTrackAdded"),
    ["manifest.recordTrackAdded", "New Track - Someone Else.ogg", "Alex"]
  );
});

test("dry run never records anything in the manifest (it never actually publishes)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-dryrun-manifest-norecord-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.ok(!calls.some((c) => c[0] === "manifest.recordTrackAdded"));
});

test("a real publish that succeeds but fails to record the manifest afterward is still reported as a success, not committedButNotPublished", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-manifest-record-fail-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const errorLines = [];
  const { deps } = makeFakeDeps({
    manifest: {
      async recordTrackAdded() {
        throw new Error("R2 write hiccup");
      },
    },
    logError: (...args) => errorLines.push(args.join(" ")),
  });

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  // Same reasoning as the bandwidth-recording-failure case above: the
  // publish itself genuinely succeeded and is irreversible, so a bookkeeping
  // failure afterward must never surface as "not published" — that could
  // prompt a well-meaning retry that causes a second, real publish.
  assert.equal(result.dryRun, false);
  assert.ok(result.versionNumber);
  assert.ok(errorLines.some((l) => l.includes("published successfully but failed to record it during stage \"record-manifest\"")));
});

// --- Pre-publish track limit re-check ---

test(`re-checks the ${MAX_TRACKS}-track limit immediately before the real publish call, as a final safety net`, async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-preflight-recheck-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  let listTracksCallCount = 0;
  const overFullLibrary = Array.from({ length: MAX_TRACKS + 1 }, (_, i) => `Track ${i} - Someone`);
  const { deps } = makeFakeDeps({
    storage: {
      async listTracks() {
        listTracksCallCount++;
        // First two calls (early check, README regen) see room; the
        // pre-publish re-check (3rd call) sees a library that somehow grew
        // past the limit in the meantime (e.g. out-of-band R2 change).
        if (listTracksCallCount <= 2) return ["Existing Track - Someone"];
        return overFullLibrary;
      },
    },
  });

  await assert.rejects(
    processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
      ...deps,
      tmpBase: tmpDir,
    }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.stage, "check-track-limit-pre-publish");
      // Past push-branch by this point, so this is the
      // "committed but not published" partial-failure mode.
      assert.equal(err.committedButNotPublished, true);
      assert.match(err.message, new RegExp(`exceeds the ${MAX_TRACKS}-track limit`));
      return true;
    }
  );
});

test("pre-publish re-check passes silently when the count is still within the limit", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-preflight-recheck-ok-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.equal(result.dryRun, false);
});

// --- trackBandwidth: false (local-instance opt-out) ---
// Render's bandwidth cap only meters traffic leaving Render's own servers —
// a real publish run from a non-Render instance can't consume any of it,
// so config.trackBandwidth: false skips both the lock check and the
// recording step entirely, regardless of how much "usage" the shared
// counter says is already used.

test("trackBandwidth: false skips the lock check entirely, even when the shared counter says we're already over the threshold", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-notrack-lock-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps({
    bandwidth: {
      async getUsage() {
        calls.push(["bandwidth.getUsage"]);
        return { month: "2026-08", bytesUsed: LOCK_THRESHOLD_BYTES + 1_000_000_000 };
      },
    },
  });

  const result = await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex" },
    { ...BASE_CONFIG, trackBandwidth: false },
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.dryRun, false);
  assert.ok(!calls.some((c) => c[0] === "bandwidth.getUsage"), "should never even check usage when tracking is off");
});

test("trackBandwidth: false skips recording after a successful publish", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-notrack-record-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex" },
    { ...BASE_CONFIG, trackBandwidth: false },
    { ...deps, tmpBase: tmpDir }
  );

  assert.ok(!calls.some((c) => c[0] === "bandwidth.recordPublish"));
  // The publish itself still happens for real — only tracking is skipped.
  assert.ok(calls.some((c) => c[0] === "publishPackage"));
});

test("trackBandwidth defaults to true when config omits it (matches config.js's safe default)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-notrack-default-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();
  const configWithoutFlag = { ...BASE_CONFIG };
  delete configWithoutFlag.trackBandwidth;

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, configWithoutFlag, {
    ...deps,
    tmpBase: tmpDir,
  });

  assert.ok(calls.some((c) => c[0] === "bandwidth.getUsage"));
  assert.ok(calls.some((c) => c[0] === "bandwidth.recordPublish"));
});

// --- Progress hook + cancellation (for the loading-bar/modal feature) ---

test("onStageChange fires for every real stage transition, in order, matching what's logged", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-onstage-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const seenStages = [];
  const { deps } = makeFakeDeps({ log: () => {} });

  await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
    onStageChange: (name) => seenStages.push(name),
  });

  assert.deepEqual(seenStages, [
    "check-bandwidth-lock",
    "check-duplicate",
    "check-track-limit",
    "clone",
    "convert",
    "check-file-size",
    "upload-to-r2",
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

test("checkCancelled true from the start aborts before any real work, throwing a cancelled SubmissionError", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cancel-early-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  await assert.rejects(
    () =>
      processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
        checkCancelled: () => true,
      }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.equal(err.cancelled, true);
      assert.equal(err.committedButNotPublished, false);
      return true;
    }
  );

  assert.ok(!calls.some((c) => c[0] === "cloneRepo"), "cancellation before the first stage should stop everything downstream");
});

test("cancellation is never checked once CANCEL_CUTOFF_STAGE (push-branch) is reached — the pipeline completes normally regardless", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cancel-toolate-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  let pastCutoff = false;
  const result = await processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
    ...deps,
    tmpBase: tmpDir,
    checkCancelled: () => pastCutoff,
    onStageChange: (name) => {
      if (name === "push-branch") pastCutoff = true;
    },
  });

  assert.ok(result.versionNumber, "the job ran to completion despite checkCancelled becoming true partway through");
});

test("dry run's onStageChange never includes tcli-publish or the real-publish-only stages", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-onstage-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const seenStages = [];
  const { deps } = makeFakeDeps();

  await processSubmission(
    { uploadPath, title: "T", artist: "A", displayName: "Alex", dryRun: true },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir, onStageChange: (name) => seenStages.push(name) }
  );

  assert.ok(!seenStages.includes("tcli-publish"));
  assert.ok(!seenStages.includes("record-manifest"));
  assert.ok(!seenStages.includes("record-bandwidth"));
  assert.ok(seenStages.includes("tcli-build"));
});

test("cleanup is never itself subject to cancellation, even when checkCancelled is always true (must not mask the real error or skip cleanup)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-test-cancel-cleanup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps();

  await assert.rejects(
    () =>
      processSubmission({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, {
        ...deps,
        tmpBase: tmpDir,
        checkCancelled: () => true,
      }),
    (err) => {
      // Must surface as the original cancellation, not some secondary error
      // from setStage("cleanup") itself throwing inside the finally block.
      assert.equal(err.cancelled, true);
      return true;
    }
  );

  // The upload file must still have been cleaned up despite the early
  // cancellation — proves the finally block's cleanup actually ran.
  await assert.rejects(() => fsp.access(uploadPath));
});
