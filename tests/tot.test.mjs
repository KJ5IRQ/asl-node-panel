"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { totState, formatCountdown, formatHold } from "../services/tot.js";

// ---------------------------------------------------------------------------
// totState
// ---------------------------------------------------------------------------

test("totState: totSeconds 0 disables the feature -- phase always off", () => {
  assert.equal(totState(1000, 1000, 0).phase, "off");
  assert.equal(totState(null, 1000, 0).phase, "off");
  assert.equal(totState(0, 999999, 0).phase, "off");
  assert.equal(totState(1000, 1000, 0).remain, 0);
});

test("totState: unknown arm time (null) yields the indeterminate state", () => {
  const s = totState(null, Date.now(), 180);
  assert.equal(s.phase, "indeterminate");
  assert.equal(s.remain, 180);
});

test("totState: fresh arm at full duration is normal", () => {
  const s = totState(1000, 1000, 180);
  assert.equal(s.phase, "normal");
  assert.equal(s.remain, 180);
});

test("totState: phase boundary exactly at 60s remaining is warn", () => {
  const armedAtMs = 0;
  const nowMs = (180 - 60) * 1000; // 120s elapsed, 60s remain
  const s = totState(armedAtMs, nowMs, 180);
  assert.equal(s.remain, 60);
  assert.equal(s.phase, "warn");
});

test("totState: just above 60s remaining is normal", () => {
  const nowMs = (180 - 61) * 1000; // 61s remain
  const s = totState(0, nowMs, 180);
  assert.equal(s.phase, "normal");
});

test("totState: phase boundary exactly at 30s remaining is crit", () => {
  const nowMs = (180 - 30) * 1000; // 30s remain
  const s = totState(0, nowMs, 180);
  assert.equal(s.remain, 30);
  assert.equal(s.phase, "crit");
});

test("totState: just above 30s remaining is warn", () => {
  const nowMs = (180 - 31) * 1000; // 31s remain
  const s = totState(0, nowMs, 180);
  assert.equal(s.phase, "warn");
});

test("totState: phase boundary exactly at 0s remaining is expired", () => {
  const nowMs = 180 * 1000; // 0s remain
  const s = totState(0, nowMs, 180);
  assert.equal(s.remain, 0);
  assert.equal(s.phase, "expired");
});

test("totState: elapsed beyond duration stays expired, remain floors at 0", () => {
  const nowMs = 999 * 1000;
  const s = totState(0, nowMs, 180);
  assert.equal(s.remain, 0);
  assert.equal(s.phase, "expired");
});

test("totState: re-arm resets to full duration", () => {
  // Simulate: armed at t=0, run to near-expiry, then re-arm (new armedAtMs).
  const nearExpiry = totState(0, 170 * 1000, 180);
  assert.equal(nearExpiry.phase, "crit");
  const rearmed = totState(170 * 1000, 170 * 1000, 180); // re-key at the same instant
  assert.equal(rearmed.remain, 180);
  assert.equal(rearmed.phase, "normal");
});

test("totState: clock skew (nowMs earlier than armedAtMs) must not go negative", () => {
  const s = totState(10000, 5000, 180); // now is 5s "before" armedAtMs
  assert.equal(s.remain, 180);
  assert.equal(s.phase, "normal");
});

test("totState: works across the 120/150/180 configurable durations", () => {
  assert.equal(totState(0, 60 * 1000, 120).phase, "warn"); // 60 remain of 120
  assert.equal(totState(0, 90 * 1000, 150).phase, "warn"); // 60 remain of 150
  assert.equal(totState(0, 0, 120).remain, 120);
});

// ---------------------------------------------------------------------------
// formatCountdown / formatHold
// ---------------------------------------------------------------------------

test("formatCountdown formats m:ss and never goes negative", () => {
  assert.equal(formatCountdown(180), "3:00");
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatCountdown(5), "0:05");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5), "0:00");
});

test("formatHold formats seconds under a minute as Ns, longer as MmSSs", () => {
  assert.equal(formatHold(8000), "8s");
  assert.equal(formatHold(41000), "41s");
  assert.equal(formatHold(64000), "1m04");
  assert.equal(formatHold(101000), "1m41");
  assert.equal(formatHold(120000), "2m");
});
