"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNodeNumber,
  sanitizeFavorites,
  normalizeSchedules,
  validateBaseUrl,
  normalizeBaseUrl,
} from "../services/storage.js";

// ---------------------------------------------------------------------------
// normalizeNodeNumber
// ---------------------------------------------------------------------------

test("normalizeNodeNumber accepts 1-7 digit node numbers", () => {
  assert.equal(normalizeNodeNumber("1"), "1");
  assert.equal(normalizeNodeNumber("637050"), "637050");
  assert.equal(normalizeNodeNumber("1234567"), "1234567");
  assert.equal(normalizeNodeNumber("  55763  "), "55763");
});

test("normalizeNodeNumber rejects letters, empty, and 8+ digits", () => {
  assert.throws(() => normalizeNodeNumber("abc"), /1-7 digits/);
  assert.throws(() => normalizeNodeNumber(""), /1-7 digits/);
  assert.throws(() => normalizeNodeNumber("   "), /1-7 digits/);
  assert.throws(() => normalizeNodeNumber("12345678"), /1-7 digits/);
});

// ---------------------------------------------------------------------------
// sanitizeFavorites
// ---------------------------------------------------------------------------

test("sanitizeFavorites dedupes by node, keeping the first occurrence", () => {
  const result = sanitizeFavorites([
    { node: "55763", label: "First" },
    { node: "55763", label: "Second" },
  ]);
  assert.deepEqual(result, [{ node: "55763", label: "First" }]);
});

test("sanitizeFavorites sorts numerically by node", () => {
  const result = sanitizeFavorites([
    { node: "674982", label: "B" },
    { node: "99", label: "A" },
    { node: "55763", label: "C" },
  ]);
  assert.deepEqual(result.map((f) => f.node), ["99", "55763", "674982"]);
});

test("sanitizeFavorites falls back to the node number as the label", () => {
  const result = sanitizeFavorites([{ node: "55763", label: "" }]);
  assert.deepEqual(result, [{ node: "55763", label: "55763" }]);
});

test("sanitizeFavorites drops invalid entries and non-array input", () => {
  assert.deepEqual(sanitizeFavorites(null), []);
  assert.deepEqual(sanitizeFavorites(undefined), []);
  assert.deepEqual(
    sanitizeFavorites([{ node: "abc", label: "Bad" }, { node: "", label: "Empty" }]),
    []
  );
});

// ---------------------------------------------------------------------------
// normalizeSchedules
// ---------------------------------------------------------------------------

test("normalizeSchedules keeps well-formed schedules", () => {
  const schedule = { id: "a1", action: "connect", node: "55763", days: [1, 3], hour: 6, minute: 0 };
  assert.deepEqual(normalizeSchedules([schedule]), [schedule]);
});

test("normalizeSchedules drops malformed entries", () => {
  const good = { id: "a1", action: "connect", node: "55763", days: [1], hour: 6, minute: 0 };
  const noId = { action: "connect", node: "55763", days: [1], hour: 6, minute: 0 };
  const noDays = { id: "a2", action: "connect", node: "55763", days: [], hour: 6, minute: 0 };
  const badHour = { id: "a3", action: "connect", node: "55763", days: [1], hour: "6", minute: 0 };
  const notObject = "not-a-schedule";
  assert.deepEqual(
    normalizeSchedules([good, noId, noDays, badHour, notObject, null]),
    [good]
  );
});

test("normalizeSchedules returns empty array for non-array input", () => {
  assert.deepEqual(normalizeSchedules(null), []);
  assert.deepEqual(normalizeSchedules(undefined), []);
});

// ---------------------------------------------------------------------------
// validateBaseUrl (strict, throwing)
// ---------------------------------------------------------------------------

test("validateBaseUrl strips search, hash, and trailing slashes", () => {
  assert.equal(
    validateBaseUrl("http://192.168.4.32:8073/?foo=bar#frag"),
    "http://192.168.4.32:8073"
  );
  assert.equal(validateBaseUrl("http://192.168.4.32:8073///"), "http://192.168.4.32:8073");
  assert.equal(validateBaseUrl("https://example.com/api/"), "https://example.com/api");
});

test("validateBaseUrl rejects non-http(s) protocols", () => {
  assert.throws(() => validateBaseUrl("ftp://192.168.4.32:8073"), /http:\/\/ or https:\/\//);
});

test("validateBaseUrl rejects garbage and empty input", () => {
  assert.throws(() => validateBaseUrl("not a url"), /valid http/i);
  assert.throws(() => validateBaseUrl(""), /required/i);
  assert.throws(() => validateBaseUrl("   "), /required/i);
});

// ---------------------------------------------------------------------------
// normalizeBaseUrl (loose, non-throwing)
// ---------------------------------------------------------------------------

test("normalizeBaseUrl trims and strips trailing slashes without validating", () => {
  assert.equal(normalizeBaseUrl("http://192.168.4.32:8073/"), "http://192.168.4.32:8073");
  assert.equal(normalizeBaseUrl("  http://192.168.4.32:8073  "), "http://192.168.4.32:8073");
  assert.equal(normalizeBaseUrl(""), "");
  assert.equal(normalizeBaseUrl(undefined), "");
  // Loose path does not validate the URL shape -- garbage passes through.
  assert.equal(normalizeBaseUrl("not a url///"), "not a url");
});
