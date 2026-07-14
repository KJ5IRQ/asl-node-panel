"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDtmfSequence,
  normalizeMacroNumber,
  normalizeAuditLines,
  parseActiveLinks,
  buildUrl,
} from "../services/api.js";

// ---------------------------------------------------------------------------
// normalizeDtmfSequence
// ---------------------------------------------------------------------------

test("normalizeDtmfSequence accepts valid sequences and uppercases", () => {
  assert.equal(normalizeDtmfSequence("123"), "123");
  assert.equal(normalizeDtmfSequence("*70"), "*70");
  assert.equal(normalizeDtmfSequence("#1"), "#1");
  assert.equal(normalizeDtmfSequence("ABCD"), "ABCD");
  assert.equal(normalizeDtmfSequence("abcd"), "ABCD"); // case folding
  assert.equal(normalizeDtmfSequence("  12*3  "), "12*3"); // trims
});

test("normalizeDtmfSequence rejects empty input", () => {
  assert.throws(() => normalizeDtmfSequence(""), /required/i);
  assert.throws(() => normalizeDtmfSequence("   "), /required/i);
  assert.throws(() => normalizeDtmfSequence(undefined), /required/i);
});

test("normalizeDtmfSequence rejects spaces within the sequence", () => {
  assert.throws(() => normalizeDtmfSequence("12 3"), /0-9, A-D/);
});

test("normalizeDtmfSequence rejects letters E through Z", () => {
  for (const letter of ["E", "F", "M", "Z", "e", "z"]) {
    assert.throws(() => normalizeDtmfSequence(letter), /0-9, A-D/);
  }
});

// ---------------------------------------------------------------------------
// normalizeMacroNumber
// ---------------------------------------------------------------------------

test("normalizeMacroNumber accepts numeric strings", () => {
  assert.equal(normalizeMacroNumber("1"), "1");
  assert.equal(normalizeMacroNumber("42"), "42");
  assert.equal(normalizeMacroNumber("  7  "), "7");
});

test("normalizeMacroNumber rejects non-numeric and empty input", () => {
  assert.throws(() => normalizeMacroNumber(""), /required/i);
  assert.throws(() => normalizeMacroNumber("abc"), /numeric/i);
  assert.throws(() => normalizeMacroNumber("1.5"), /numeric/i);
  assert.throws(() => normalizeMacroNumber("-1"), /numeric/i);
});

// ---------------------------------------------------------------------------
// normalizeAuditLines
// ---------------------------------------------------------------------------

test("normalizeAuditLines caps at 500", () => {
  assert.equal(normalizeAuditLines(500), 500);
  assert.equal(normalizeAuditLines(1000), 500);
  assert.equal(normalizeAuditLines(50), 50);
});

test("normalizeAuditLines rejects zero, negatives, and floats", () => {
  assert.throws(() => normalizeAuditLines(0), /positive integer/i);
  assert.throws(() => normalizeAuditLines(-5), /positive integer/i);
  assert.throws(() => normalizeAuditLines(1.5), /positive integer/i);
  assert.throws(() => normalizeAuditLines("abc"), /positive integer/i);
});

// ---------------------------------------------------------------------------
// parseActiveLinks
// ---------------------------------------------------------------------------

test("parseActiveLinks returns empty set for empty/zero input", () => {
  assert.deepEqual(parseActiveLinks(""), new Set());
  assert.deepEqual(parseActiveLinks("0"), new Set());
  assert.deepEqual(parseActiveLinks(null), new Set());
  assert.deepEqual(parseActiveLinks(undefined), new Set());
});

test("parseActiveLinks extracts nodes flagged K (passing audio)", () => {
  assert.deepEqual(parseActiveLinks("1,674982TK"), new Set(["674982"]));
});

test("parseActiveLinks ignores linked-but-not-keyed entries", () => {
  // 55763T is linked (T) but not passing audio (no K) -- should not appear.
  assert.deepEqual(parseActiveLinks("2,55763T,429332TK"), new Set(["429332"]));
});

test("parseActiveLinks strips a leading T/R/M flag character before the node number", () => {
  assert.deepEqual(parseActiveLinks("1,T674982K"), new Set(["674982"]));
  assert.deepEqual(parseActiveLinks("1,R674982K"), new Set(["674982"]));
  assert.deepEqual(parseActiveLinks("1,M674982K"), new Set(["674982"]));
});

test("parseActiveLinks ignores junk entries instead of throwing", () => {
  assert.deepEqual(parseActiveLinks("1,garbage"), new Set());
  assert.deepEqual(parseActiveLinks("2,,429332TK"), new Set(["429332"]));
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

test("buildUrl joins base and path with exactly one slash", () => {
  assert.equal(buildUrl("http://192.168.4.32:8073", "/status"), "http://192.168.4.32:8073/status");
  assert.equal(buildUrl("http://192.168.4.32:8073", "status"), "http://192.168.4.32:8073/status");
  assert.equal(buildUrl("http://192.168.4.32:8073/", "/status"), "http://192.168.4.32:8073/status");
  assert.equal(buildUrl("http://192.168.4.32:8073///", "/status"), "http://192.168.4.32:8073/status");
});
