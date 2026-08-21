// Reference relative durations (seconds) per pipeline stage, used only to
// size the loading bar's segments proportionally — never to predict actual
// total time. Seeded from real measured runs (see MixTapeWebPlan.md):
// a real delete against production took 116.8s, dominated by tcli-publish
// (83.3s) and clone (18.9s); everything else was under a few seconds each.
// convert's weight is add-only (delete has no conversion step) and is a
// conservative estimate — real hardware measured ~1.5s for a short clip,
// this leaves headroom since real tracks/hardware vary more than that.
//
// If a real stage takes longer than its weight implies, the bar simply
// sits at the end of that segment until the stage actually completes —
// it never overshoots past 100% before the job is actually done.

// "check-target-branch" is deliberately absent from both tables below: in
// processSubmission/processDeletion it's only ever setStage()'d immediately
// before throwing (the branch-mismatch guard) — on any successful run,
// real or dry, it never actually fires. Including it here would allocate
// real bar width to a segment that's never "current," silently snapped
// full the instant the next (actually real) stage arrives.

const ADD_STAGE_WEIGHTS = [
  ["check-bandwidth-lock", 0.2],
  ["check-duplicate", 0.2],
  ["check-track-limit", 0.2],
  ["clone", 19],
  ["convert", 5],
  ["check-file-size", 0.1],
  ["upload-to-r2", 1],
  ["regenerate-readme", 0.2],
  ["commit", 0.2],
  ["compute-version", 0.6],
  ["push-branch", 2.4],
  ["push-tag", 1.6],
  ["download-all-tracks", 3.4],
  ["tcli-build", 6],
  ["check-track-limit-pre-publish", 0.2],
  ["tcli-publish", 85],
  ["record-manifest", 0.2],
  ["record-bandwidth", 0.2],
  ["cleanup", 0.1],
];

const DELETE_STAGE_WEIGHTS = [
  ["check-bandwidth-lock", 0.2],
  ["check-exists", 0.1],
  ["clone", 19],
  ["delete-from-r2", 0.5],
  ["regenerate-readme", 0.2],
  ["commit", 0.2],
  ["compute-version", 0.6],
  ["push-branch", 2.4],
  ["push-tag", 1.6],
  ["download-all-tracks", 3.4],
  ["tcli-build", 6],
  ["tcli-publish", 85],
  ["record-manifest", 0.2],
  ["record-bandwidth", 0.2],
  ["cleanup", 0.1],
];

// Stages whose real code path is guarded by `if (!dryRun && ...)` (or
// equivalent) — they simply never fire during a dry run, so allocating
// them bar width would create another silently-instant-snapped phantom
// segment, same problem as check-target-branch above:
// - check-bandwidth-lock / check-track-limit-pre-publish / tcli-publish /
//   record-manifest / record-bandwidth: all real-publish-only.
// - delete-from-r2: a dry-run deletion never touches the real R2 object
//   (see processDeletion's doc comment) — the delete itself only happens
//   for a real run.
const DRY_RUN_ONLY_STAGES = new Set([
  "check-bandwidth-lock",
  "check-track-limit-pre-publish",
  "tcli-publish",
  "record-manifest",
  "record-bandwidth",
  "delete-from-r2",
]);

export const STAGE_WEIGHTS = {
  add: ADD_STAGE_WEIGHTS,
  delete: DELETE_STAGE_WEIGHTS,
};

/**
 * Turns a weight table into segments with percent widths summing to 100
 * (the last segment absorbs any rounding remainder, so the bar always ends
 * exactly at 100% regardless of floating-point drift).
 */
export function computeSegmentWidths(weights) {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return [];
  // `seconds` (the raw reference weight) rides along so the client can
  // animate a segment's own fill over roughly its expected duration,
  // instead of snapping to fully-filled the instant that stage starts.
  const segments = weights.map(([stage, w]) => ({ stage, percent: Math.round((w / total) * 10000) / 100, seconds: w }));
  // The last segment gets whatever's left over (not its own rounded share)
  // so the total is exactly 100 regardless of floating-point drift from the
  // other segments' independent rounding.
  const othersTotal = segments.slice(0, -1).reduce((sum, s) => sum + s.percent, 0);
  segments[segments.length - 1].percent = Math.round((100 - othersTotal) * 100) / 100;
  return segments;
}

/** Segments for a given pipeline type ("add"/"delete"), optionally
 * excluding the real-publish-only stages for a dry run. */
export function segmentsFor(type, { dryRun = false } = {}) {
  const weights = STAGE_WEIGHTS[type];
  if (!weights) throw new Error(`Unknown pipeline type: "${type}"`);
  const filtered = dryRun ? weights.filter(([stage]) => !DRY_RUN_ONLY_STAGES.has(stage)) : weights;
  return computeSegmentWidths(filtered);
}
