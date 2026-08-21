import { test } from "node:test";
import assert from "node:assert/strict";
import { MANIFEST_KEY, LEGACY_ADDED_BY, getManifest, recordTrackAdded, removeTrack, backfillLegacyTracks, applyManualCorrections } from "../src/manifest.js";

function asyncIterableFromString(str) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(str, "utf8");
    },
  };
}

function notFoundError() {
  const err = new Error("not found");
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

function fakeClientReturning(obj) {
  return { async send() { return { Body: asyncIterableFromString(JSON.stringify(obj)) }; } };
}

test("getManifest returns a fresh empty manifest when nothing is stored yet (404), without writing anything", async () => {
  let putCalled = false;
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "PutObjectCommand") putCalled = true;
      throw notFoundError();
    },
  };
  const manifest = await getManifest(fakeClient, "bucket");
  assert.deepEqual(manifest, { tracks: {}, pendingDeletes: [], publishLog: [] });
  assert.equal(putCalled, false, "getManifest must be read-only");
});

test("getManifest re-throws unexpected (non-404) errors instead of silently treating them as empty", async () => {
  const fakeClient = {
    async send() {
      const err = new Error("permission denied");
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    },
  };
  await assert.rejects(getManifest(fakeClient, "bucket"), /permission denied/);
});

test("getManifest returns the stored value, tolerating an older record missing newer fields", async () => {
  const fakeClient = fakeClientReturning({ tracks: { "Song - Artist.ogg": { addedBy: "Alex" } } });
  const manifest = await getManifest(fakeClient, "bucket");
  assert.deepEqual(manifest, {
    tracks: { "Song - Artist.ogg": { addedBy: "Alex" } },
    pendingDeletes: [],
    publishLog: [],
  });
});

test("recordTrackAdded writes a new track entry under MANIFEST_KEY, preserving existing entries", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        calls.push(["get", command.input.Key]);
        return { Body: asyncIterableFromString(JSON.stringify({ tracks: { "Old - Track.ogg": { addedBy: "Sam", addedAt: "2026-08-01T00:00:00.000Z", status: "live" } }, pendingDeletes: [], publishLog: [] })) };
      }
      calls.push(["put", command.input.Key, command.input.Body]);
      return {};
    },
  };

  const now = new Date("2026-08-20T04:17:00.000Z");
  const updated = await recordTrackAdded(fakeClient, "bucket", "New - Track.ogg", "Rob", { now });

  assert.equal(updated.tracks["Old - Track.ogg"].addedBy, "Sam", "existing entries survive the read-modify-write");
  assert.deepEqual(updated.tracks["New - Track.ogg"], { addedBy: "Rob", addedAt: now.toISOString(), status: "live" });

  const putCall = calls.find((c) => c[0] === "put");
  assert.equal(putCall[1], MANIFEST_KEY);
  assert.deepEqual(JSON.parse(putCall[2]), updated);
});

test("backfillLegacyTracks adds LEGACY_ADDED_BY entries only for tracks missing from the manifest", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: asyncIterableFromString(
            JSON.stringify({
              tracks: { "Already Known - Artist.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" } },
              pendingDeletes: [],
              publishLog: [],
            })
          ),
        };
      }
      calls.push(["put", JSON.parse(command.input.Body)]);
      return {};
    },
  };

  const updated = await backfillLegacyTracks(fakeClient, "bucket", ["Already Known - Artist", "Legacy One - Someone", "Legacy Two - Someone Else"]);

  assert.deepEqual(updated.tracks["Already Known - Artist.ogg"], { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }, "pre-existing entry is untouched");
  assert.deepEqual(updated.tracks["Legacy One - Someone.ogg"], { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" });
  assert.deepEqual(updated.tracks["Legacy Two - Someone Else.ogg"], { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" });
  assert.equal(calls.length, 1, "writes exactly once for the whole batch");
});

test("backfillLegacyTracks is a no-op (no write) when every track already has a manifest entry", async () => {
  let putCalled = false;
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "PutObjectCommand") {
        putCalled = true;
        return {};
      }
      return {
        Body: asyncIterableFromString(
          JSON.stringify({ tracks: { "Known - Artist.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" } }, pendingDeletes: [], publishLog: [] })
        ),
      };
    },
  };

  const updated = await backfillLegacyTracks(fakeClient, "bucket", ["Known - Artist"]);

  assert.equal(putCalled, false);
  assert.deepEqual(updated.tracks["Known - Artist.ogg"], { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" });
});

test("backfillLegacyTracks starts from an empty manifest when nothing is stored yet", async () => {
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") throw notFoundError();
      return {};
    },
  };
  const updated = await backfillLegacyTracks(fakeClient, "bucket", ["Only Track - Artist"]);
  assert.deepEqual(updated.tracks["Only Track - Artist.ogg"], { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" });
  assert.deepEqual(updated.pendingDeletes, []);
  assert.deepEqual(updated.publishLog, []);
});

test("applyManualCorrections overwrites addedBy/addedAt for the given filenames in a single write, preserving status and untouched entries", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: asyncIterableFromString(
            JSON.stringify({
              tracks: {
                "Song A - Artist.ogg": { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" },
                "Song B - Artist.ogg": { addedBy: LEGACY_ADDED_BY, addedAt: null, status: "live" },
                "Untouched - Artist.ogg": { addedBy: "Sam", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
              },
              pendingDeletes: [],
              publishLog: [],
            })
          ),
        };
      }
      calls.push(["put", JSON.parse(command.input.Body)]);
      return {};
    },
  };

  const updated = await applyManualCorrections(fakeClient, "bucket", [
    { filename: "Song A - Artist.ogg", addedBy: "Dan", addedAt: "2026-08-16T05:00:00.000Z" },
    { filename: "Song B - Artist.ogg", addedBy: "Rob", addedAt: "2026-08-20T05:00:00.000Z" },
  ]);

  assert.deepEqual(updated.tracks["Song A - Artist.ogg"], { addedBy: "Dan", addedAt: "2026-08-16T05:00:00.000Z", status: "live" });
  assert.deepEqual(updated.tracks["Song B - Artist.ogg"], { addedBy: "Rob", addedAt: "2026-08-20T05:00:00.000Z", status: "live" });
  assert.deepEqual(updated.tracks["Untouched - Artist.ogg"], { addedBy: "Sam", addedAt: "2026-08-01T00:00:00.000Z", status: "live" }, "entries not in the correction batch are left alone");
  assert.equal(calls.length, 1, "writes exactly once for the whole batch");
});

test("applyManualCorrections creates an entry outright for a filename the manifest has never seen", async () => {
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") throw notFoundError();
      return {};
    },
  };

  const updated = await applyManualCorrections(fakeClient, "bucket", [
    { filename: "Brand New - Artist.ogg", addedBy: "Dan", addedAt: "2026-08-16T05:00:00.000Z" },
  ]);

  assert.deepEqual(updated.tracks["Brand New - Artist.ogg"], { addedBy: "Dan", addedAt: "2026-08-16T05:00:00.000Z", status: "live" });
});

test("applyManualCorrections accepts a Date for addedAt and stores its ISO string", async () => {
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") throw notFoundError();
      return {};
    },
  };

  const when = new Date("2026-08-16T05:00:00.000Z");
  const updated = await applyManualCorrections(fakeClient, "bucket", [
    { filename: "Song - Artist.ogg", addedBy: "Dan", addedAt: when },
  ]);

  assert.equal(updated.tracks["Song - Artist.ogg"].addedAt, when.toISOString());
});

test("removeTrack drops the given filename's entry, preserving every other entry, in a single write", async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: asyncIterableFromString(
            JSON.stringify({
              tracks: {
                "Keep - Artist.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" },
                "Remove - Artist.ogg": { addedBy: "Sam", addedAt: "2026-08-02T00:00:00.000Z", status: "live" },
              },
              pendingDeletes: [],
              publishLog: [],
            })
          ),
        };
      }
      calls.push(["put", JSON.parse(command.input.Body)]);
      return {};
    },
  };

  const updated = await removeTrack(fakeClient, "bucket", "Remove - Artist.ogg");

  assert.ok(!("Remove - Artist.ogg" in updated.tracks));
  assert.deepEqual(updated.tracks["Keep - Artist.ogg"], { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" });
  assert.equal(calls.length, 1);
});

test("removeTrack is a no-op (no write) when the filename has no manifest entry to begin with", async () => {
  let putCalled = false;
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "PutObjectCommand") {
        putCalled = true;
        return {};
      }
      return {
        Body: asyncIterableFromString(
          JSON.stringify({ tracks: { "Other - Artist.ogg": { addedBy: "Alex", addedAt: "2026-08-01T00:00:00.000Z", status: "live" } }, pendingDeletes: [], publishLog: [] })
        ),
      };
    },
  };

  const updated = await removeTrack(fakeClient, "bucket", "Nonexistent - Artist.ogg");

  assert.equal(putCalled, false);
  assert.ok("Other - Artist.ogg" in updated.tracks);
});
