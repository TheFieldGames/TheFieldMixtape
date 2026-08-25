import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { queueTrackAdd, queueTrackDelete, cancelQueuedDeletion } from "../src/queueActions.js";
import { SubmissionError, MAX_TRACKS, MAX_TRACK_FILE_SIZE_BYTES } from "../src/publish.js";
import { PENDING_PREFIX, TRACK_PREFIX } from "../src/storage.js";

const BASE_CONFIG = { r2Client: {}, r2Bucket: "thefieldmixtape-audio" };

function makeFakeDeps(overrides = {}) {
  const calls = [];

  const storage = {
    async trackExists(client, bucket, filename, opts) {
      calls.push(["trackExists", filename, opts?.prefix]);
      return false;
    },
    async uploadTrack(client, bucket, filename, filePath, opts) {
      calls.push(["uploadTrack", filename, opts?.prefix]);
    },
    async deleteTrack(client, bucket, filename, opts) {
      calls.push(["deleteTrack", filename, opts?.prefix]);
    },
    ...(overrides.storage || {}),
  };

  const convert = overrides.convert || (async (inputPath, outputPath) => {
    calls.push(["convert", inputPath, outputPath]);
    await fsp.writeFile(outputPath, "fake ogg bytes");
  });

  const manifest = {
    async getManifest() {
      calls.push(["manifest.getManifest"]);
      return { tracks: {}, pendingDeletes: [], publishLog: [] };
    },
    async queueTrackAdded(client, bucket, filename, addedBy) {
      calls.push(["manifest.queueTrackAdded", filename, addedBy]);
    },
    async queueTrackDeletion(client, bucket, filename) {
      calls.push(["manifest.queueTrackDeletion", filename]);
    },
    async cancelPendingDeletion(client, bucket, filename) {
      calls.push(["manifest.cancelPendingDeletion", filename]);
    },
    async removeTrack(client, bucket, filename) {
      calls.push(["manifest.removeTrack", filename]);
    },
    ...(overrides.manifest || {}),
  };

  const log = overrides.log || (() => {});

  return { calls, deps: { storage, convert, manifest, log } };
}

async function makeUploadFile(tmpDir) {
  const uploadPath = path.join(tmpDir, "upload.mp3");
  await fsp.writeFile(uploadPath, "fake mp3 bytes");
  return uploadPath;
}

test("queueTrackAdd converts, uploads under PENDING_PREFIX, and records a pending manifest entry", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps();

  const result = await queueTrackAdd(
    { uploadPath, title: "New Track", artist: "Someone", displayName: "Alex" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.filename, "New Track - Someone.ogg");
  assert.equal(result.trackName, "New Track - Someone");

  const uploadCall = calls.find((c) => c[0] === "uploadTrack");
  assert.equal(uploadCall[1], "New Track - Someone.ogg");
  assert.equal(uploadCall[2], PENDING_PREFIX);

  const manifestCall = calls.find((c) => c[0] === "manifest.queueTrackAdded");
  assert.deepEqual(manifestCall, ["manifest.queueTrackAdded", "New Track - Someone.ogg", "Alex"]);
});

test("queueTrackAdd rejects a track that's already live", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-dup-live-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    storage: { async trackExists(client, bucket, filename, opts) { return !opts?.prefix; } },
  });

  await assert.rejects(
    () => queueTrackAdd({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.match(err.message, /already exists/);
      return true;
    }
  );
});

test("queueTrackAdd rejects a track that's already queued (pending)", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-dup-pending-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    storage: { async trackExists(client, bucket, filename, opts) { return opts?.prefix === PENDING_PREFIX; } },
  });

  await assert.rejects(
    () => queueTrackAdd({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    /already queued/
  );
});

test("queueTrackAdd rejects when projected live+pending count would exceed MAX_TRACKS", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-limit-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const fullTracks = Object.fromEntries(
    Array.from({ length: MAX_TRACKS }, (_, i) => [`T${i}.ogg`, { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }])
  );
  const { deps } = makeFakeDeps({ manifest: { async getManifest() { return { tracks: fullTracks, pendingDeletes: [], publishLog: [] }; } } });

  await assert.rejects(
    () => queueTrackAdd({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    /over the 50-track limit/
  );
});

test("queueTrackAdd allows queueing an add once a queued deletion frees up the room, even while already at MAX_TRACKS", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-limit-freed-by-delete-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const fullTracks = Object.fromEntries(
    Array.from({ length: MAX_TRACKS }, (_, i) => [`T${i}.ogg`, { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }])
  );
  const { deps } = makeFakeDeps({
    manifest: { async getManifest() { return { tracks: fullTracks, pendingDeletes: ["T0.ogg"], publishLog: [] }; } },
  });

  const result = await queueTrackAdd(
    { uploadPath, title: "New Track", artist: "Someone", displayName: "Alex" },
    BASE_CONFIG,
    { ...deps, tmpBase: tmpDir }
  );

  assert.equal(result.filename, "New Track - Someone.ogg");
});

test("queueTrackAdd still rejects when a queued deletion doesn't free up enough room", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-limit-not-enough-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  // MAX_TRACKS live tracks, no deletions queued at all -- still full.
  const fullTracks = Object.fromEntries(
    Array.from({ length: MAX_TRACKS }, (_, i) => [`T${i}.ogg`, { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }])
  );
  const { deps } = makeFakeDeps({
    manifest: { async getManifest() { return { tracks: fullTracks, pendingDeletes: [], publishLog: [] }; } },
  });

  await assert.rejects(
    () => queueTrackAdd({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    new RegExp(`would put the mixtape at ${MAX_TRACKS + 1} tracks`)
  );
});

test("queueTrackAdd rejects a converted file over the size limit, and never uploads it", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-size-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { calls, deps } = makeFakeDeps({
    convert: async (inputPath, outputPath) => {
      await fsp.writeFile(outputPath, Buffer.alloc(MAX_TRACK_FILE_SIZE_BYTES + 1));
    },
  });

  await assert.rejects(
    () => queueTrackAdd({ uploadPath, title: "Big Track", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir }),
    (err) => {
      assert.ok(err instanceof SubmissionError);
      assert.match(err.message, /"Big Track - A" converted to/);
      return true;
    }
  );
  assert.ok(!calls.some((c) => c[0] === "uploadTrack"));
});

test("queueTrackAdd cleans up the temp upload and converted files even on failure", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-test-cleanup-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const uploadPath = await makeUploadFile(tmpDir);
  const { deps } = makeFakeDeps({
    storage: { async trackExists() { return true; } },
  });

  await assert.rejects(() =>
    queueTrackAdd({ uploadPath, title: "T", artist: "A", displayName: "Alex" }, BASE_CONFIG, { ...deps, tmpBase: tmpDir })
  );

  await assert.rejects(() => fsp.access(uploadPath));
});

test("queueTrackDelete on a still-pending track cancels it outright (removes the pending R2 object and manifest entry)", async (t) => {
  const { calls, deps } = makeFakeDeps({
    manifest: {
      async getManifest() {
        return { tracks: { "New - Track.ogg": { addedBy: "Alex", addedAt: "2026-08-20T00:00:00.000Z", status: "pending" } }, pendingDeletes: [], publishLog: [] };
      },
      async removeTrack(client, bucket, filename) {
        calls.push(["manifest.removeTrack", filename]);
      },
    },
  });

  const result = await queueTrackDelete({ filename: "New - Track.ogg", displayName: "Rob" }, BASE_CONFIG, deps);

  assert.equal(result.action, "cancelled-pending-add");
  // Deletes from BOTH the pending prefix and the real prefix, unconditionally
  // — not just the pending one. An earlier failed Publish attempt may have
  // already promoted this exact track to the real prefix before dying at a
  // later stage (tcli-publish can fail independent of anything this app
  // controls), leaving the manifest still saying "pending." A delete against
  // a key that doesn't exist doesn't error (S3/R2 delete is idempotent), so
  // deleting from both locations is always safe and guarantees a cancel can
  // never orphan an already-promoted live copy with no manifest record.
  const deleteCalls = calls.filter((c) => c[0] === "deleteTrack");
  assert.equal(deleteCalls.length, 2);
  assert.ok(deleteCalls.some((c) => c[1] === "New - Track.ogg" && c[2] === PENDING_PREFIX));
  assert.ok(deleteCalls.some((c) => c[1] === "New - Track.ogg" && c[2] === TRACK_PREFIX));
  assert.ok(calls.some((c) => c[0] === "manifest.removeTrack"));
  assert.ok(!calls.some((c) => c[0] === "manifest.queueTrackDeletion"));
});

test("queueTrackDelete on a live track queues it for deletion instead of touching R2 immediately", async (t) => {
  const { calls, deps } = makeFakeDeps({
    manifest: {
      async getManifest() {
        return { tracks: { "Old - Track.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" } }, pendingDeletes: [], publishLog: [] };
      },
      async queueTrackDeletion(client, bucket, filename) {
        calls.push(["manifest.queueTrackDeletion", filename]);
      },
    },
  });

  const result = await queueTrackDelete({ filename: "Old - Track.ogg", displayName: "Rob" }, BASE_CONFIG, deps);

  assert.equal(result.action, "queued-deletion");
  assert.ok(!calls.some((c) => c[0] === "deleteTrack"), "the real R2 object isn't touched until an actual Publish");
  assert.deepEqual(calls.find((c) => c[0] === "manifest.queueTrackDeletion"), ["manifest.queueTrackDeletion", "Old - Track.ogg"]);
});

test("queueTrackDelete throws for a filename with no manifest entry at all", async (t) => {
  const { deps } = makeFakeDeps({
    manifest: { async getManifest() { return { tracks: {}, pendingDeletes: [], publishLog: [] }; } },
  });

  await assert.rejects(
    () => queueTrackDelete({ filename: "Nonexistent.ogg", displayName: "Rob" }, BASE_CONFIG, deps),
    /No track named/
  );
});

test("cancelQueuedDeletion clears the pendingDeletes flag via manifest.cancelPendingDeletion", async () => {
  const { calls, deps } = makeFakeDeps();
  const result = await cancelQueuedDeletion({ filename: "Old - Track.ogg", displayName: "Rob" }, BASE_CONFIG, deps);
  assert.equal(result.filename, "Old - Track.ogg");
  assert.deepEqual(calls, [["manifest.cancelPendingDeletion", "Old - Track.ogg"]]);
});
