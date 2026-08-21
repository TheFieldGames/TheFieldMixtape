import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getJob,
  recordStage,
  completeJob,
  failJob,
  requestCancel,
  isCancelRequested,
  subscribe,
  CANCEL_CUTOFF_STAGE,
} from "../src/jobs.js";

test("createJob returns a fresh id and getJob reflects initial state", () => {
  const id = createJob("add");
  const job = getJob(id);
  assert.equal(job.type, "add");
  assert.equal(job.status, "running");
  assert.equal(job.stage, null);
  assert.equal(job.cancelable, true);
  assert.equal(job.cancelRequested, false);
});

test("createJob stores dryRun metadata up front, defaulting to false", () => {
  assert.equal(getJob(createJob("add")).dryRun, false);
  assert.equal(getJob(createJob("delete", { dryRun: true })).dryRun, true);
});

test("getJob returns null for an unknown id", () => {
  assert.equal(getJob("does-not-exist"), null);
});

test("recordStage appends to the stage history and updates current stage", () => {
  const id = createJob("add");
  recordStage(id, "clone");
  recordStage(id, "convert");
  const job = getJob(id);
  assert.equal(job.stage, "convert");
  assert.deepEqual(job.stages.map((s) => s.stage), ["clone", "convert"]);
});

test("recordStage flips cancelable to false once CANCEL_CUTOFF_STAGE is reached, and stays false after", () => {
  const id = createJob("add");
  recordStage(id, "clone");
  assert.equal(getJob(id).cancelable, true);
  recordStage(id, CANCEL_CUTOFF_STAGE);
  assert.equal(getJob(id).cancelable, false);
  recordStage(id, "push-tag");
  assert.equal(getJob(id).cancelable, false);
});

test("subscribe immediately replays a snapshot of current state, then future events as they happen", () => {
  const id = createJob("add");
  recordStage(id, "clone");
  const events = [];
  subscribe(id, (e) => events.push(e));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[0].stage, "clone");

  recordStage(id, "convert");
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { type: "stage", stage: "convert", cancelable: true });
});

test("subscribe on an unknown job id is a harmless no-op (no throw, unsubscribe is a no-op function)", () => {
  const unsubscribe = subscribe("does-not-exist", () => {
    throw new Error("should never be called");
  });
  assert.doesNotThrow(() => unsubscribe());
});

test("unsubscribe stops further events from reaching that callback", () => {
  const id = createJob("add");
  const events = [];
  const unsubscribe = subscribe(id, (e) => events.push(e));
  unsubscribe();
  recordStage(id, "clone");
  assert.equal(events.length, 1, "only the initial snapshot, nothing after unsubscribing");
});

test("completeJob sets status to succeeded, stores the result, and broadcasts a done event", () => {
  const id = createJob("add");
  const events = [];
  subscribe(id, (e) => events.push(e));

  completeJob(id, { versionNumber: "1.0.14" });

  const job = getJob(id);
  assert.equal(job.status, "succeeded");
  assert.deepEqual(job.result, { versionNumber: "1.0.14" });
  assert.equal(job.cancelable, false);
  assert.deepEqual(events[events.length - 1], { type: "done", status: "succeeded", result: { versionNumber: "1.0.14" } });
});

test("failJob sets status to failed and records the error message + committedButNotPublished flag", () => {
  const id = createJob("delete");
  failJob(id, new Error("tcli build failed"));
  const job = getJob(id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.message, "tcli build failed");
  assert.equal(job.error.committedButNotPublished, false);
});

test("failJob preserves committedButNotPublished from a SubmissionError-shaped error", () => {
  const id = createJob("delete");
  const err = new Error("publish failed");
  err.committedButNotPublished = true;
  failJob(id, err);
  assert.equal(getJob(id).error.committedButNotPublished, true);
});

test("failJob with a cancelled-flagged error sets status to cancelled, not failed", () => {
  const id = createJob("add");
  const err = new Error("cancelled by user");
  err.cancelled = true;
  failJob(id, err);
  assert.equal(getJob(id).status, "cancelled");
});

test("requestCancel sets cancelRequested and reports whether it's still cancelable", () => {
  const id = createJob("add");
  const result = requestCancel(id);
  assert.equal(result.found, true);
  assert.equal(result.cancelable, true);
  assert.equal(isCancelRequested(id), true);
});

test("requestCancel after the cutoff still records the request but reports cancelable: false", () => {
  const id = createJob("add");
  recordStage(id, CANCEL_CUTOFF_STAGE);
  const result = requestCancel(id);
  assert.equal(result.cancelable, false);
  assert.equal(isCancelRequested(id), true, "the request is still honestly recorded, even though it can't take effect");
});

test("requestCancel on an unknown job id reports found: false without throwing", () => {
  assert.deepEqual(requestCancel("does-not-exist"), { found: false, cancelable: false });
});

test("isCancelRequested is false by default and for an unknown job", () => {
  const id = createJob("add");
  assert.equal(isCancelRequested(id), false);
  assert.equal(isCancelRequested("does-not-exist"), false);
});
