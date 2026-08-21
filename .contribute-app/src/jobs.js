import crypto from "node:crypto";

// In-memory only — matches the rest of the app's single-instance assumption
// (same one runExclusive already relies on). A job's whole lifecycle is
// minutes long, and nothing here needs to survive a restart.
const jobs = new Map();

// How long a finished job (succeeded/failed/cancelled) stays in memory
// after completion, so a client that's slow to fetch the result page (or a
// reconnecting EventSource) still finds it. Cleaned up after that so the
// map doesn't grow unbounded over the service's uptime.
export const RETENTION_MS = 5 * 60 * 1000;

// Cancellation is only meaningful, and only checked, before this point in a
// pipeline — see processSubmission/processDeletion's own critical-section
// boundary (the same point their committedButNotPublished handling begins).
// Requesting cancel after this point is accepted but has no effect; the
// job's `cancelable` flag flips to false so the UI can say so honestly.
export const CANCEL_CUTOFF_STAGE = "push-branch";

function emptyJob(id, type, dryRun) {
  return {
    id,
    type, // "add" | "delete"
    dryRun,
    status: "running", // "running" | "succeeded" | "failed" | "cancelled"
    stage: null,
    stages: [], // [{ stage, at }], in order, one per real setStage() transition
    cancelRequested: false,
    cancelable: true,
    result: null,
    error: null,
    subscribers: new Set(),
    createdAt: Date.now(),
  };
}

// `dryRun` is stored up front (not read off the eventual result) so it's
// still known for rendering a failed/cancelled job's outcome — a job that
// never reaches success has no `result` to read it from otherwise.
export function createJob(type, { dryRun = false } = {}) {
  const id = crypto.randomUUID();
  jobs.set(id, emptyJob(id, type, dryRun));
  return id;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

function broadcast(job, event) {
  for (const send of job.subscribers) send(event);
}

/** Records a real stage transition and notifies every current subscriber.
 * Flips `cancelable` off once the pipeline reaches CANCEL_CUTOFF_STAGE — a
 * cancel request received after that point is kept (for the UI to reflect
 * "requested, but too late") but never actually stops anything. */
export function recordStage(id, stage) {
  const job = getJob(id);
  if (!job) return;
  job.stage = stage;
  job.stages.push({ stage, at: Date.now() });
  if (stage === CANCEL_CUTOFF_STAGE) job.cancelable = false;
  broadcast(job, { type: "stage", stage, cancelable: job.cancelable });
}

export function completeJob(id, result) {
  const job = getJob(id);
  if (!job) return;
  job.status = "succeeded";
  job.result = result;
  job.cancelable = false;
  broadcast(job, { type: "done", status: job.status, result });
  scheduleCleanup(id);
}

export function failJob(id, error) {
  const job = getJob(id);
  if (!job) return;
  job.status = error?.cancelled ? "cancelled" : "failed";
  job.error = { message: error.message, committedButNotPublished: error.committedButNotPublished || false };
  job.cancelable = false;
  broadcast(job, { type: "done", status: job.status, error: job.error });
  scheduleCleanup(id);
}

function scheduleCleanup(id) {
  setTimeout(() => jobs.delete(id), RETENTION_MS).unref();
}

/** Requests cancellation. Always records the request (so isCancelRequested
 * reflects intent even after the cutoff), returns whether it can actually
 * still take effect. */
export function requestCancel(id) {
  const job = getJob(id);
  if (!job) return { found: false, cancelable: false };
  job.cancelRequested = true;
  broadcast(job, { type: "cancel-requested", cancelable: job.cancelable });
  return { found: true, cancelable: job.cancelable };
}

export function isCancelRequested(id) {
  return getJob(id)?.cancelRequested === true;
}

/** Subscribes an SSE connection (or any callback) to a job's future events.
 * Immediately replays the job's current state as a synthetic first event so
 * a client connecting mid-job (or after a brief reconnect) isn't left
 * guessing. Returns an unsubscribe function. */
export function subscribe(id, send) {
  const job = getJob(id);
  if (!job) return () => {};
  job.subscribers.add(send);
  send({ type: "snapshot", status: job.status, stage: job.stage, cancelable: job.cancelable, result: job.result, error: job.error });
  return () => job.subscribers.delete(send);
}
