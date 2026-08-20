import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_KEY,
  MONTHLY_CAP_BYTES,
  LOCK_THRESHOLD_BYTES,
  currentMonthKey,
  getUsage,
  recordPublish,
  isLocked,
  remainingBytes,
  estimatePublishesRemaining,
} from "../src/bandwidth.js";

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

test("constants: LOCK_THRESHOLD_BYTES is a safety margin below MONTHLY_CAP_BYTES, in decimal GB", () => {
  assert.equal(MONTHLY_CAP_BYTES, 5_000_000_000);
  assert.equal(LOCK_THRESHOLD_BYTES, 4_500_000_000);
  assert.ok(LOCK_THRESHOLD_BYTES < MONTHLY_CAP_BYTES);
});

test("currentMonthKey formats as zero-padded YYYY-MM in UTC", () => {
  assert.equal(currentMonthKey(new Date("2026-08-19T22:00:00Z")), "2026-08");
  assert.equal(currentMonthKey(new Date("2026-01-05T00:00:00Z")), "2026-01");
  assert.equal(currentMonthKey(new Date("2026-12-31T23:59:59Z")), "2026-12");
});

test("getUsage returns zero usage for a brand new month with no stored record (404)", async () => {
  const fakeClient = { async send() { throw notFoundError(); } };
  const usage = await getUsage(fakeClient, "bucket", { now: new Date("2026-08-19T00:00:00Z") });
  assert.deepEqual(usage, { month: "2026-08", bytesUsed: 0 });
});

test("getUsage returns the stored value when it matches the current month", async () => {
  const fakeClient = {
    async send() {
      return { Body: asyncIterableFromString(JSON.stringify({ month: "2026-08", bytesUsed: 1_200_000_000 })) };
    },
  };
  const usage = await getUsage(fakeClient, "bucket", { now: new Date("2026-08-19T00:00:00Z") });
  assert.deepEqual(usage, { month: "2026-08", bytesUsed: 1_200_000_000 });
});

test("getUsage treats a stale (previous-month) stored record as a fresh zero, without writing anything", async () => {
  let putCalled = false;
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "PutObjectCommand") putCalled = true;
      return { Body: asyncIterableFromString(JSON.stringify({ month: "2026-07", bytesUsed: 4_800_000_000 })) };
    },
  };
  const usage = await getUsage(fakeClient, "bucket", { now: new Date("2026-08-01T00:05:00Z") });
  assert.deepEqual(usage, { month: "2026-08", bytesUsed: 0 });
  assert.equal(putCalled, false, "getUsage must be read-only");
});

test("getUsage re-throws unexpected (non-404) errors instead of silently treating them as zero", async () => {
  const fakeClient = {
    async send() {
      const err = new Error("permission denied");
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    },
  };
  await assert.rejects(getUsage(fakeClient, "bucket"), /permission denied/);
});

test("recordPublish adds to the existing month's total and persists it", async () => {
  let putBody = null;
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: asyncIterableFromString(JSON.stringify({ month: "2026-08", bytesUsed: 1_000_000_000 })) };
      }
      if (command.constructor.name === "PutObjectCommand") {
        putBody = command.input;
        return {};
      }
      throw new Error("unexpected command");
    },
  };

  const result = await recordPublish(fakeClient, "bucket", 212_000_000, { now: new Date("2026-08-19T00:00:00Z") });

  assert.deepEqual(result, { month: "2026-08", bytesUsed: 1_212_000_000 });
  assert.equal(putBody.Bucket, "bucket");
  assert.equal(putBody.Key, USAGE_KEY);
  assert.deepEqual(JSON.parse(putBody.Body), { month: "2026-08", bytesUsed: 1_212_000_000 });
  assert.equal(putBody.ContentType, "application/json");
});

test("recordPublish resets to just this publish's bytes when the prior record was from a previous month", async () => {
  const fakeClient = {
    async send(command) {
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: asyncIterableFromString(JSON.stringify({ month: "2026-07", bytesUsed: 4_900_000_000 })) };
      }
      return {};
    },
  };

  const result = await recordPublish(fakeClient, "bucket", 200_000_000, { now: new Date("2026-08-01T00:00:00Z") });
  assert.deepEqual(result, { month: "2026-08", bytesUsed: 200_000_000 });
});

test("isLocked is false below the threshold, true at and above it", () => {
  assert.equal(isLocked({ bytesUsed: LOCK_THRESHOLD_BYTES - 1 }), false);
  assert.equal(isLocked({ bytesUsed: LOCK_THRESHOLD_BYTES }), true);
  assert.equal(isLocked({ bytesUsed: LOCK_THRESHOLD_BYTES + 1 }), true);
});

test("remainingBytes never goes negative even if usage somehow exceeds the threshold", () => {
  assert.equal(remainingBytes({ bytesUsed: 0 }), LOCK_THRESHOLD_BYTES);
  assert.equal(remainingBytes({ bytesUsed: LOCK_THRESHOLD_BYTES }), 0);
  assert.equal(remainingBytes({ bytesUsed: LOCK_THRESHOLD_BYTES + 1_000_000_000 }), 0);
});

test("estimatePublishesRemaining divides remaining headroom by the given per-publish size", () => {
  const usage = { bytesUsed: LOCK_THRESHOLD_BYTES - 1_000_000_000 }; // 1GB of headroom left
  assert.equal(estimatePublishesRemaining(usage, 200_000_000), 5);
  assert.equal(estimatePublishesRemaining(usage, 300_000_000), 3);
});

test("estimatePublishesRemaining returns null (not a crash) for a zero/unknown per-publish size", () => {
  assert.equal(estimatePublishesRemaining({ bytesUsed: 0 }, 0), null);
  assert.equal(estimatePublishesRemaining({ bytesUsed: 0 }, undefined), null);
});

test("estimatePublishesRemaining returns 0 (not negative) once already locked", () => {
  assert.equal(estimatePublishesRemaining({ bytesUsed: LOCK_THRESHOLD_BYTES }, 200_000_000), 0);
});
