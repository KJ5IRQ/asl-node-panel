"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  diffKeyedSets,
  computeBusyPercent,
  computeNextSchedule,
  formatNextScheduleLine,
} from "../services/activity.js";

// ---------------------------------------------------------------------------
// diffKeyedSets
// ---------------------------------------------------------------------------

test("diffKeyedSets reports newly keyed nodes", () => {
  const prev = new Set(["66543"]);
  const next = new Set(["66543", "674982"]);
  assert.deepEqual(diffKeyedSets(prev, next), { newlyKeyed: ["674982"], newlyUnkeyed: [] });
});

test("diffKeyedSets reports newly unkeyed nodes", () => {
  const prev = new Set(["66543", "674982"]);
  const next = new Set(["66543"]);
  assert.deepEqual(diffKeyedSets(prev, next), { newlyKeyed: [], newlyUnkeyed: ["674982"] });
});

test("diffKeyedSets handles simultaneous key and unkey", () => {
  const prev = new Set(["66543"]);
  const next = new Set(["674982"]);
  assert.deepEqual(diffKeyedSets(prev, next), { newlyKeyed: ["674982"], newlyUnkeyed: ["66543"] });
});

test("diffKeyedSets is a no-op for unchanged sets", () => {
  const prev = new Set(["66543"]);
  const next = new Set(["66543"]);
  assert.deepEqual(diffKeyedSets(prev, next), { newlyKeyed: [], newlyUnkeyed: [] });
});

test("diffKeyedSets accepts empty/undefined sets without throwing", () => {
  assert.deepEqual(diffKeyedSets(undefined, new Set(["1"])), { newlyKeyed: ["1"], newlyUnkeyed: [] });
  assert.deepEqual(diffKeyedSets(new Set(["1"]), undefined), { newlyKeyed: [], newlyUnkeyed: ["1"] });
});

// ---------------------------------------------------------------------------
// computeBusyPercent
// ---------------------------------------------------------------------------

test("computeBusyPercent computes tx/uptime as a percent", () => {
  assert.equal(computeBusyPercent(41, 100), 41);
  assert.equal(computeBusyPercent(2, 100), 2);
});

test("computeBusyPercent clamps to 0-100", () => {
  assert.equal(computeBusyPercent(150, 100), 100);
  assert.equal(computeBusyPercent(-10, 100), 0);
});

test("computeBusyPercent returns null when not computable", () => {
  assert.equal(computeBusyPercent(41, 0), null);
  assert.equal(computeBusyPercent(41, -5), null);
  assert.equal(computeBusyPercent(undefined, 100), null);
  assert.equal(computeBusyPercent(41, undefined), null);
  assert.equal(computeBusyPercent(NaN, 100), null);
});

// ---------------------------------------------------------------------------
// computeNextSchedule / formatNextScheduleLine
// ---------------------------------------------------------------------------

test("computeNextSchedule finds the soonest enabled occurrence this week", () => {
  const now = new Date(Date.UTC(2026, 6, 14, 12, 0, 0)); // Tue 2026-07-14 12:00Z
  const schedules = [
    { id: "a", enabled: true, action: "connect", node: "55553", days: [3], hour: 1, minute: 0 }, // Wed 01:00Z
    { id: "b", enabled: true, action: "disconnect-all", days: [4], hour: 23, minute: 0 }, // Thu 23:00Z
  ];
  const next = computeNextSchedule(schedules, now);
  assert.equal(next.schedule.id, "a");
  assert.equal(next.dayName, "Wed");
  assert.equal(next.target.getUTCHours(), 1);
});

test("computeNextSchedule rolls over to next week when today's time already passed", () => {
  const now = new Date(Date.UTC(2026, 6, 14, 12, 0, 0)); // Tue 12:00Z
  const schedules = [
    { id: "a", enabled: true, action: "connect", node: "1", days: [2], hour: 6, minute: 0 }, // Tue 06:00Z -- already passed today
  ];
  const next = computeNextSchedule(schedules, now);
  assert.equal(next.target.getUTCDate(), 21); // next Tuesday
});

test("computeNextSchedule ignores disabled schedules", () => {
  const now = new Date(Date.UTC(2026, 6, 14, 12, 0, 0));
  const schedules = [
    { id: "a", enabled: false, action: "connect", node: "1", days: [3], hour: 1, minute: 0 },
  ];
  assert.equal(computeNextSchedule(schedules, now), null);
});

test("computeNextSchedule returns null for no schedules", () => {
  assert.equal(computeNextSchedule([], new Date()), null);
  assert.equal(computeNextSchedule(null, new Date()), null);
});

test("formatNextScheduleLine matches the standby watch line format", () => {
  const now = new Date(Date.UTC(2026, 6, 14, 12, 0, 0));
  const schedules = [
    { id: "a", enabled: true, action: "connect", node: "55553", days: [3], hour: 1, minute: 0 },
  ];
  const next = computeNextSchedule(schedules, now);
  assert.equal(formatNextScheduleLine(next), "next: connect 55553 @ Wed 01:00Z");
});

test("formatNextScheduleLine returns empty string for null input", () => {
  assert.equal(formatNextScheduleLine(null), "");
});
