import { test } from "node:test";
import assert from "node:assert/strict";
import { centralMidnightToUtc, parseAddedAt } from "../src/timezone.js";

test("centralMidnightToUtc: August date resolves to CDT (UTC-5)", () => {
  const result = centralMidnightToUtc(2026, 8, 1);
  assert.equal(result.toISOString(), "2026-08-01T05:00:00.000Z");
});

test("centralMidnightToUtc: January date resolves to CST (UTC-6)", () => {
  const result = centralMidnightToUtc(2026, 1, 15);
  assert.equal(result.toISOString(), "2026-01-15T06:00:00.000Z");
});

test("centralMidnightToUtc: correctly straddles the spring-forward DST boundary (clocks jump forward at 2am local on 2026-03-08)", () => {
  // Midnight ON the change day is still CST (UTC-6) — the 2am local jump to
  // CDT hasn't happened yet at 00:00. The offset only actually changes at
  // the NEXT midnight (March 9), so that's the pair that must show a 23h
  // (not 24h) gap, one hour having been skipped overnight.
  const stillCst = centralMidnightToUtc(2026, 3, 8);
  const nowCdt = centralMidnightToUtc(2026, 3, 9);
  assert.equal(stillCst.toISOString(), "2026-03-08T06:00:00.000Z");
  assert.equal(nowCdt.toISOString(), "2026-03-09T05:00:00.000Z");
  assert.equal((nowCdt - stillCst) / (60 * 60 * 1000), 23);
});

test("centralMidnightToUtc: correctly straddles the fall-back DST boundary (clocks fall back at 2am local on 2026-11-01)", () => {
  // Same reasoning in reverse: midnight ON the change day (Nov 1) is still
  // CDT (UTC-5) — the 2am local fall-back to CST hasn't happened yet at
  // 00:00. The offset changes at the NEXT midnight (Nov 2), a 25h (not 24h)
  // gap, one hour having repeated overnight.
  const stillCdt = centralMidnightToUtc(2026, 11, 1);
  const nowCst = centralMidnightToUtc(2026, 11, 2);
  assert.equal(stillCdt.toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(nowCst.toISOString(), "2026-11-02T06:00:00.000Z");
  assert.equal((nowCst - stillCdt) / (60 * 60 * 1000), 25);
});

test("parseAddedAt: a bare date is read as Central midnight, not UTC midnight", () => {
  const result = parseAddedAt("2026-08-16");
  assert.equal(result.toISOString(), "2026-08-16T05:00:00.000Z");
});

test("parseAddedAt: an explicit Z timestamp is respected as-is, not reinterpreted as Central", () => {
  const result = parseAddedAt("2026-08-16T14:30:00Z");
  assert.equal(result.toISOString(), "2026-08-16T14:30:00.000Z");
});

test("parseAddedAt: an explicit offset timestamp is respected as-is", () => {
  const result = parseAddedAt("2026-08-16T09:30:00-05:00");
  assert.equal(result.toISOString(), "2026-08-16T14:30:00.000Z");
});

test("parseAddedAt: null passes through as null (unknown/unfilled entry)", () => {
  assert.equal(parseAddedAt(null), null);
});

test("parseAddedAt: throws clearly on genuinely unparseable input", () => {
  assert.throws(() => parseAddedAt("not a date"), /Could not parse addedAt value/);
});
