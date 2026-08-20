import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TRACK_PREFIX,
  DRY_RUN_PREFIX,
  keyForFilename,
  trackNameFromKey,
  listTrackKeys,
  listTracks,
  trackExists,
  uploadTrack,
  downloadAllTracks,
  getTotalTrackBytes,
} from "../src/storage.js";

function asyncIterableFromBuffer(buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

test("keyForFilename / trackNameFromKey round-trip through the my mixtape/ prefix", () => {
  const key = keyForFilename("Nightcall - Kavinsky.ogg");
  assert.equal(key, "my mixtape/Nightcall - Kavinsky.ogg");
  assert.equal(trackNameFromKey(key), "Nightcall - Kavinsky");
});

test("keyForFilename accepts an explicit prefix override for dry runs", () => {
  assert.equal(keyForFilename("Song - Artist.ogg", DRY_RUN_PREFIX), "dry-run/Song - Artist.ogg");
});

test("trackNameFromKey returns null for dry-run-prefixed keys (not part of the real track prefix)", () => {
  assert.equal(trackNameFromKey(`${DRY_RUN_PREFIX}Song - Artist.ogg`), null);
});

test("trackNameFromKey returns null for the stray mixtape.json object (not a .ogg under the prefix)", () => {
  assert.equal(trackNameFromKey("my mixtape/mixtape.json"), null);
});

test("trackNameFromKey returns null for keys outside the track prefix", () => {
  assert.equal(trackNameFromKey("icon.png"), null);
  assert.equal(trackNameFromKey("README.md"), null);
});

test("listTrackKeys follows pagination (ContinuationToken) across multiple pages", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.input);
      if (!command.input.ContinuationToken) {
        return {
          Contents: [
            { Key: `${TRACK_PREFIX}A.ogg` },
            { Key: `${TRACK_PREFIX}B.ogg` },
          ],
          IsTruncated: true,
          NextContinuationToken: "page2",
        };
      }
      return {
        Contents: [{ Key: `${TRACK_PREFIX}C.ogg` }],
        IsTruncated: false,
      };
    },
  };

  const keys = await listTrackKeys(fakeClient, "test-bucket");
  assert.deepEqual(keys, [`${TRACK_PREFIX}A.ogg`, `${TRACK_PREFIX}B.ogg`, `${TRACK_PREFIX}C.ogg`]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].Bucket, "test-bucket");
  assert.equal(calls[0].Prefix, TRACK_PREFIX);
  assert.equal(calls[1].ContinuationToken, "page2");
});

test("listTrackKeys filters out non-.ogg objects (e.g. the stray mixtape.json)", async () => {
  const fakeClient = {
    async send() {
      return {
        Contents: [
          { Key: `${TRACK_PREFIX}Track.ogg` },
          { Key: `${TRACK_PREFIX}mixtape.json` },
        ],
        IsTruncated: false,
      };
    },
  };
  const keys = await listTrackKeys(fakeClient, "test-bucket");
  assert.deepEqual(keys, [`${TRACK_PREFIX}Track.ogg`]);
});

test("listTracks strips the prefix/extension to plain track names for README generation", async () => {
  const fakeClient = {
    async send() {
      return {
        Contents: [
          { Key: `${TRACK_PREFIX}Nightcall - Kavinsky.ogg` },
          { Key: `${TRACK_PREFIX}USA.ogg` },
        ],
        IsTruncated: false,
      };
    },
  };
  const tracks = await listTracks(fakeClient, "test-bucket");
  assert.deepEqual(tracks, ["Nightcall - Kavinsky", "USA"]);
});

test("trackExists returns true when HeadObjectCommand succeeds", async () => {
  const fakeClient = { async send() { return {}; } };
  assert.equal(await trackExists(fakeClient, "test-bucket", "Exists.ogg"), true);
});

test("trackExists returns false on a 404-shaped error", async () => {
  const fakeClient = {
    async send() {
      const err = new Error("not found");
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    },
  };
  assert.equal(await trackExists(fakeClient, "test-bucket", "Missing.ogg"), false);
});

test("trackExists re-throws unexpected (non-404) errors instead of swallowing them", async () => {
  const fakeClient = {
    async send() {
      const err = new Error("permission denied");
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    },
  };
  await assert.rejects(trackExists(fakeClient, "test-bucket", "Whatever.ogg"), /permission denied/);
});

test("uploadTrack sends the file's real bytes under the my mixtape/ prefixed key", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const filePath = path.join(tmpDir, "source.ogg");
  await fsp.writeFile(filePath, Buffer.from("fake ogg bytes"));

  let sentCommand = null;
  const fakeClient = {
    async send(command) {
      sentCommand = command;
      return {};
    },
  };

  await uploadTrack(fakeClient, "test-bucket", "New Track - Someone.ogg", filePath);

  assert.equal(sentCommand.input.Bucket, "test-bucket");
  assert.equal(sentCommand.input.Key, "my mixtape/New Track - Someone.ogg");
  assert.equal(sentCommand.input.ContentType, "audio/ogg");
  assert.equal(Buffer.from(sentCommand.input.Body).toString(), "fake ogg bytes");
});

test("uploadTrack respects a dry-run prefix override, keeping it out of the real track namespace", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-test-dryrun-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const filePath = path.join(tmpDir, "source.ogg");
  await fsp.writeFile(filePath, Buffer.from("dry run bytes"));

  let sentCommand = null;
  const fakeClient = {
    async send(command) {
      sentCommand = command;
      return {};
    },
  };

  await uploadTrack(fakeClient, "test-bucket", "Test Track - Someone.ogg", filePath, { prefix: DRY_RUN_PREFIX });

  assert.equal(sentCommand.input.Key, "dry-run/Test Track - Someone.ogg");
});

test("downloadAllTracks writes every listed key's content to destDir under its basename, in parallel", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-test-dl-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));

  const bucketContents = {
    [`${TRACK_PREFIX}One.ogg`]: Buffer.from("content-one"),
    [`${TRACK_PREFIX}Two.ogg`]: Buffer.from("content-two"),
  };

  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: Object.keys(bucketContents).map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      if (command.constructor.name === "GetObjectCommand") {
        const buf = bucketContents[command.input.Key];
        assert.ok(buf, `unexpected key requested: ${command.input.Key}`);
        return { Body: asyncIterableFromBuffer(buf) };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };

  const count = await downloadAllTracks(fakeClient, "test-bucket", tmpDir);
  assert.equal(count, 2);

  assert.equal(fs.readFileSync(path.join(tmpDir, "One.ogg"), "utf8"), "content-one");
  assert.equal(fs.readFileSync(path.join(tmpDir, "Two.ogg"), "utf8"), "content-two");
});

test("downloadAllTracks creates destDir if it doesn't already exist", async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-test-mkdir-"));
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const destDir = path.join(tmpDir, "nested", "my mixtape");

  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [], IsTruncated: false };
      }
      throw new Error("should not be called with an empty bucket");
    },
  };

  const count = await downloadAllTracks(fakeClient, "test-bucket", destDir);
  assert.equal(count, 0);
  assert.ok(fs.existsSync(destDir));
});

test("getTotalTrackBytes sums real object sizes from R2's listing (no extra HeadObject calls needed)", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.constructor.name);
      return {
        Contents: [
          { Key: `${TRACK_PREFIX}A.ogg`, Size: 3_000_000 },
          { Key: `${TRACK_PREFIX}B.ogg`, Size: 4_500_000 },
          { Key: `${TRACK_PREFIX}mixtape.json`, Size: 50 }, // non-.ogg, must be excluded
        ],
        IsTruncated: false,
      };
    },
  };

  const total = await getTotalTrackBytes(fakeClient, "test-bucket");
  assert.equal(total, 7_500_000);
  assert.deepEqual(calls, ["ListObjectsV2Command"]);
});

test("getTotalTrackBytes sums across pagination and treats a missing Size as 0", async () => {
  const fakeClient = {
    async send(command) {
      if (!command.input.ContinuationToken) {
        return {
          Contents: [{ Key: `${TRACK_PREFIX}A.ogg`, Size: 1000 }],
          IsTruncated: true,
          NextContinuationToken: "page2",
        };
      }
      return {
        Contents: [{ Key: `${TRACK_PREFIX}B.ogg` }], // no Size field at all
        IsTruncated: false,
      };
    },
  };

  const total = await getTotalTrackBytes(fakeClient, "test-bucket");
  assert.equal(total, 1000);
});

test("getTotalTrackBytes returns 0 for an empty library", async () => {
  const fakeClient = { async send() { return { Contents: [], IsTruncated: false }; } };
  assert.equal(await getTotalTrackBytes(fakeClient, "test-bucket"), 0);
});
