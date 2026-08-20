/**
 * In-process promise-chain mutex. Serializes calls to processSubmission()
 * so concurrent track submissions can never interleave their git
 * clone/commit/push/publish steps. Relies on exactly one Node process
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
