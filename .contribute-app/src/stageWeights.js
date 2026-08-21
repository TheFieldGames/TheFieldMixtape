// Reference relative durations (seconds) per pipeline stage, used only to
// size the loading bar's segments proportionally — never to predict actual
// total time. Seeded from real measured runs (see MixTapeWebPlan.md): a
// real publish against production took 116.8s, dominated by tcli-publish
// (83.3s) and clone (18.9s); everything else was under a few seconds each.
//
// If a real stage takes longer than its weight implies, the bar simply
// sits at the end of that segment until the stage actually completes —
// it never overshoots past 100% before the job is actually done.
//
// "check-target-branch" is deliberately absent: in processPublish it's only
// ever setStage()'d immediately before throwing (the branch-mismatch
// guard) — on any successful run, real or dry, it never actually fires.
// Including it here would allocate real bar width to a segment that's
// never "current," silently snapped full the instant the next (actually
// real) stage arrives.
//
// "apply-queue" (deleting queued-for-removal tracks and promoting queued
// adds from the pending R2 prefix) has no real measurement yet — this is a
// conservative placeholder pending a real batch to measure against, scaled
// roughly for a handful of items at a time (this app's realistic batch
// size for a two-person friend group).
const PUBLISH_STAGE_WEIGHTS = [
  ["check-bandwidth-lock", 0.2],
  ["check-pending", 0.1],
  ["check-track-limit", 0.2],
  ["clone", 19],
  ["apply-queue", 2],
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

// Stages whose real code path is guarded by `if (!dryRun && ...)` (or
// equivalent) in processPublish — they simply never fire during a dry run,
// so allocating them bar width would create another silently-instant-
// snapped phantom segment, same problem as check-target-branch above.
const DRY_RUN_ONLY_STAGES = new Set([
  "check-bandwidth-lock",
  "apply-queue",
  "check-track-limit-pre-publish",
  "tcli-publish",
  "record-manifest",
  "record-bandwidth",
]);

export const STAGE_WEIGHTS = {
  publish: PUBLISH_STAGE_WEIGHTS,
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

/** Segments for a given pipeline type (currently only "publish"),
 * optionally excluding the real-publish-only stages for a dry run. */
export function segmentsFor(type, { dryRun = false } = {}) {
  const weights = STAGE_WEIGHTS[type];
  if (!weights) throw new Error(`Unknown pipeline type: "${type}"`);
  const filtered = dryRun ? weights.filter(([stage]) => !DRY_RUN_ONLY_STAGES.has(stage)) : weights;
  return computeSegmentWidths(filtered);
}
