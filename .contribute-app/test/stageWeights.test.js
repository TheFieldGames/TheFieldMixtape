import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_WEIGHTS, computeSegmentWidths, segmentsFor } from "../src/stageWeights.js";

test("computeSegmentWidths sums to ~100 despite per-segment rounding", () => {
  const segments = computeSegmentWidths([["a", 1], ["b", 1], ["c", 1]]);
  const total = segments.reduce((sum, s) => sum + s.percent, 0);
  assert.ok(Math.abs(total - 100) < 0.01);
});

test("computeSegmentWidths gives each segment a share proportional to its weight", () => {
  const segments = computeSegmentWidths([["small", 1], ["big", 9]]);
  assert.equal(segments[0].percent, 10);
  assert.equal(segments[1].percent, 90);
});

test("computeSegmentWidths carries the raw weight along as `seconds`, for client-side fill-duration animation", () => {
  const segments = computeSegmentWidths([["a", 4], ["b", 12]]);
  assert.equal(segments[0].seconds, 4);
  assert.equal(segments[1].seconds, 12);
});

test("computeSegmentWidths returns an empty array for an empty table", () => {
  assert.deepEqual(computeSegmentWidths([]), []);
});

test("segmentsFor('publish') covers every real stage name processPublish logs, in order", () => {
  const segments = segmentsFor("publish");
  const stages = segments.map((s) => s.stage);
  assert.deepEqual(stages, STAGE_WEIGHTS.publish.map(([name]) => name));
  assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.percent, 0) - 100) < 0.01);
});

test("segmentsFor with dryRun: true excludes every real-publish-only stage (they never run in a dry run)", () => {
  const segments = segmentsFor("publish", { dryRun: true });
  const stages = segments.map((s) => s.stage);
  assert.ok(!stages.includes("tcli-publish"));
  assert.ok(!stages.includes("record-manifest"));
  assert.ok(!stages.includes("record-bandwidth"));
  assert.ok(!stages.includes("check-track-limit-pre-publish"));
  assert.ok(!stages.includes("check-bandwidth-lock"), "check-bandwidth-lock is guarded by !dryRun in the real code — never fires on a dry run");
  assert.ok(!stages.includes("apply-queue"), "apply-queue (real R2 delete/promote) never runs for a dry run");
  assert.ok(stages.includes("clone"));
  assert.ok(stages.includes("check-pending"));
  assert.ok(stages.includes("tcli-build"), "tcli-build still runs for a dry run");
  assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.percent, 0) - 100) < 0.01);
});

test("the table doesn't include check-target-branch — it's only ever set right before throwing, never on a successful run (real or dry)", () => {
  assert.ok(!STAGE_WEIGHTS.publish.some(([name]) => name === "check-target-branch"));
});

test("segmentsFor throws on an unknown pipeline type", () => {
  assert.throws(() => segmentsFor("bogus"), /Unknown pipeline type/);
});

test("tcli-publish dominates the real (non-dry-run) bar, matching the real measured ~85s of ~117s total", () => {
  const segments = segmentsFor("publish");
  const publish = segments.find((s) => s.stage === "tcli-publish");
  assert.ok(publish.percent > 60, `expected tcli-publish to dominate the bar, got ${publish.percent}%`);
});
