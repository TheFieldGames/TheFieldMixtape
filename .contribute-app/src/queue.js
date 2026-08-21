/**
 * In-process promise-chain mutex. Serializes every operation that reads or
 * writes the manifest/R2 pending state or does real git/tcli work
 * (queueTrackAdd, queueTrackDelete, cancelQueuedDeletion, processPublish)
 * so none of them can ever interleave. Relies on exactly one Node process
 * running (see plan: Render free/Starter plans run one instance by
 * default, no horizontal auto-scaling) — this lock is process-local
 * memory, not distributed.
 */
let tail = Promise.resolve();

export function runExclusive(fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}
