import { test } from "node:test";
import assert from "node:assert/strict";
import { runExclusive } from "../src/queue.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runExclusive serializes two concurrently-started jobs (second waits for first to finish)", async () => {
  const events = [];

  const job1 = runExclusive(async () => {
    events.push("job1-start");
    await delay(30);
    events.push("job1-end");
    return "result1";
  });

  const job2 = runExclusive(async () => {
    events.push("job2-start");
    await delay(5);
    events.push("job2-end");
    return "result2";
  });

  const [r1, r2] = await Promise.all([job1, job2]);

  assert.equal(r1, "result1");
  assert.equal(r2, "result2");
  // job2 must not start until job1 has fully finished, even though job2's
  // own work is much shorter — this is the entire point of the mutex.
  assert.deepEqual(events, ["job1-start", "job1-end", "job2-start", "job2-end"]);
});

test("runExclusive: a failing job does not break the chain for subsequent jobs", async () => {
  const events = [];

  const job1 = runExclusive(async () => {
    events.push("job1-start");
    await delay(10);
    events.push("job1-throw");
    throw new Error("job1 failed");
  });

  const job2 = runExclusive(async () => {
    events.push("job2-start");
    return "job2-succeeded";
  });

  await assert.rejects(job1, /job1 failed/);
  const r2 = await job2;

  assert.equal(r2, "job2-succeeded");
  assert.deepEqual(events, ["job1-start", "job1-throw", "job2-start"]);
});

test("runExclusive: each caller gets their own job's result, not another job's", async () => {
  const jobs = [1, 2, 3, 4, 5].map((n) =>
    runExclusive(async () => {
      await delay(Math.random() * 5);
      return n * 10;
    })
  );
  const results = await Promise.all(jobs);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});
