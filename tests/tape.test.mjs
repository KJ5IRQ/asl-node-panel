"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { createTape } from "../services/tape.js";

// ---------------------------------------------------------------------------
// push / dedupe of continuous keyups
// ---------------------------------------------------------------------------

test("push adds a new entry at the top", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "link", text: "674982 connected" });
  tape.push({ ts: 2, kind: "drop", text: "429332 disconnected" });
  const list = tape.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "drop"); // newest first
});

test("push dedupes a continuous keyup: same live kind+node does not duplicate", () => {
  const tape = createTape();
  const first = tape.push({ ts: 1, kind: "key", node: "66543", text: "VE3FBX keyed", live: true });
  const second = tape.push({ ts: 2, kind: "key", node: "66543", text: "VE3FBX keyed", live: true });
  assert.equal(tape.list().length, 1);
  assert.equal(first, second); // same row returned, not a new one
});

test("push does NOT dedupe a new keyup from a different node", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "key", node: "66543", live: true, text: "a" });
  tape.push({ ts: 2, kind: "key", node: "674982", live: true, text: "b" });
  assert.equal(tape.list().length, 2);
});

test("push does NOT dedupe once the prior row is no longer live", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "key", node: "66543", live: true, text: "a" });
  tape.finalize("key", "66543", { holdMs: 8000, text: "done" });
  tape.push({ ts: 2, kind: "key", node: "66543", live: true, text: "re-keyed" });
  assert.equal(tape.list().length, 2);
});

// ---------------------------------------------------------------------------
// holdMs update on unkey
// ---------------------------------------------------------------------------

test("finalize updates holdMs and text on the live row, clears live flag", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "key", node: "66543", live: true, text: "VE3FBX 66543 · keyed" });
  const row = tape.finalize("key", "66543", { holdMs: 41000, text: "VE3FBX 66543 · 41s" });
  assert.equal(row.holdMs, 41000);
  assert.equal(row.text, "VE3FBX 66543 · 41s");
  assert.equal(row.live, false);
});

test("finalize returns null when no matching live row exists", () => {
  const tape = createTape();
  assert.equal(tape.finalize("key", "99999", { holdMs: 1000 }), null);
});

test("finalize on the operator's own outbound transmission records TOT outcome", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "out", node: "637050", live: true, text: "KJ5IRQ outbound · TOT armed" });
  const row = tape.finalize("out", "637050", { holdMs: 101000, text: "KJ5IRQ outbound · 1m41 · TOT ok" });
  assert.equal(row.text, "KJ5IRQ outbound · 1m41 · TOT ok");
});

// ---------------------------------------------------------------------------
// cap at 200 (and arbitrary cap)
// ---------------------------------------------------------------------------

test("push caps stored rows at the configured cap", () => {
  const tape = createTape(5);
  for (let i = 0; i < 10; i++) {
    tape.push({ ts: i, kind: "sys", text: `entry ${i}` });
  }
  assert.equal(tape.list().length, 5);
  // Newest rows survive.
  assert.equal(tape.list()[0].text, "entry 9");
});

test("default cap is 200", () => {
  const tape = createTape();
  for (let i = 0; i < 250; i++) {
    tape.push({ ts: i, kind: "sys", text: `e${i}` });
  }
  assert.equal(tape.list().length, 200);
});

// ---------------------------------------------------------------------------
// filter(list) by kind
// ---------------------------------------------------------------------------

test("list filters by group: keyups, links, cmds", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "key", text: "a" });
  tape.push({ ts: 2, kind: "out", text: "b" });
  tape.push({ ts: 3, kind: "link", text: "c" });
  tape.push({ ts: 4, kind: "drop", text: "d" });
  tape.push({ ts: 5, kind: "dtmf", text: "e" });
  tape.push({ ts: 6, kind: "cop", text: "f" });
  tape.push({ ts: 7, kind: "sched", text: "g" });
  tape.push({ ts: 8, kind: "sys", text: "h" });

  assert.equal(tape.list("all").length, 8);
  assert.deepEqual(tape.list("keyups").map((e) => e.kind).sort(), ["key", "out"]);
  assert.deepEqual(tape.list("links").map((e) => e.kind).sort(), ["drop", "link"]);
  assert.deepEqual(tape.list("cmds").map((e) => e.kind).sort(), ["cop", "dtmf", "sched", "sys"]);
});

test("list filters by an exact kind string too", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "tot", text: "timeout" });
  tape.push({ ts: 2, kind: "key", text: "a" });
  assert.equal(tape.list("tot").length, 1);
});

test("list() with no filter returns everything", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "sys", text: "a" });
  assert.equal(tape.list().length, 1);
});

// ---------------------------------------------------------------------------
// toJSON / hydrate round-trip
// ---------------------------------------------------------------------------

test("toJSON/hydrate round-trips entries exactly", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "key", node: "66543", callsign: "VE3FBX", text: "a", holdMs: 8000 });
  tape.push({ ts: 2, kind: "link", text: "b" });
  const json = tape.toJSON();

  const restored = createTape();
  restored.hydrate(json);
  assert.deepEqual(restored.toJSON(), json);
});

test("hydrate replaces existing entries and respects cap", () => {
  const tape = createTape(2);
  tape.push({ ts: 1, kind: "sys", text: "old" });
  tape.hydrate([
    { ts: 3, kind: "sys", text: "new-1" },
    { ts: 2, kind: "sys", text: "new-2" },
    { ts: 1, kind: "sys", text: "new-3" },
  ]);
  assert.equal(tape.list().length, 2);
  assert.equal(tape.list()[0].text, "new-1");
});

test("hydrate with non-array input clears the tape", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "sys", text: "a" });
  tape.hydrate(null);
  assert.equal(tape.list().length, 0);
});

test("clear empties the tape", () => {
  const tape = createTape();
  tape.push({ ts: 1, kind: "sys", text: "a" });
  tape.clear();
  assert.equal(tape.list().length, 0);
});

// ---------------------------------------------------------------------------
// audit seeding de-dup
// ---------------------------------------------------------------------------

test("seedFromAudit maps structured audit entries into sys rows", () => {
  const tape = createTape();
  tape.seedFromAudit([
    { timestamp: "2026-07-14T14:00:01Z", command: "connect", details: "66543 T" },
  ]);
  const list = tape.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "sys");
  assert.match(list[0].text, /connect/);
  assert.match(list[0].text, /66543 T/);
});

test("seedFromAudit maps legacy raw-string audit entries too", () => {
  const tape = createTape();
  tape.seedFromAudit(["2026-07-14 14:00:01 connect 66543"]);
  assert.equal(tape.list().length, 1);
});

test("seedFromAudit de-dupes against entries already present by timestamp+text", () => {
  const tape = createTape();
  const ts = new Date("2026-07-14T14:00:01Z").getTime();
  tape.push({ ts, kind: "sys", text: "connect — 66543 T" });
  tape.seedFromAudit([{ timestamp: "2026-07-14T14:00:01Z", command: "connect", details: "66543 T" }]);
  assert.equal(tape.list().length, 1); // no duplicate
});

test("seedFromAudit re-sorts merged entries newest-first and respects cap", () => {
  const tape = createTape(2);
  tape.push({ ts: 5000, kind: "sys", text: "live" });
  tape.seedFromAudit([
    { timestamp: new Date(9000).toISOString(), command: "newer", details: "" },
    { timestamp: new Date(1000).toISOString(), command: "older", details: "" },
  ]);
  const list = tape.list();
  assert.equal(list.length, 2);
  assert.match(list[0].text, /newer/);
});

test("seedFromAudit ignores empty/non-array input", () => {
  const tape = createTape();
  tape.seedFromAudit(null);
  tape.seedFromAudit(undefined);
  assert.equal(tape.list().length, 0);
});
