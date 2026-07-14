"use strict";

// ---------------------------------------------------------------------------
// The Traffic Tape data model -- one chronological event stream replacing
// the audit section, the connected-list-as-history, and the previously
// proposed separate last-heard log. Pure and testable: no DOM, no chrome.*.
//
// Entry shape: { ts: epochMs, kind: "key"|"out"|"link"|"drop"|"dtmf"|"cop"|
//                "sched"|"sys"|"tot", text: string, node?: string,
//                callsign?: string, holdMs?: number, live?: boolean }
// ---------------------------------------------------------------------------

const KEYUP_KINDS = new Set(["key", "out"]);
const LINK_KINDS = new Set(["link", "drop"]);
const CMD_KINDS = new Set(["dtmf", "cop", "sched", "sys"]);

export function createTape(cap = 200) {
  let entries = [];

  function normalize(entry) {
    return {
      ts: Number(entry.ts) || Date.now(),
      kind: String(entry.kind || "sys"),
      text: String(entry.text || ""),
      node: entry.node != null ? String(entry.node) : undefined,
      callsign: entry.callsign != null ? String(entry.callsign) : undefined,
      holdMs: entry.holdMs != null ? Number(entry.holdMs) : undefined,
      live: Boolean(entry.live),
    };
  }

  /**
   * Push a new entry at the top (newest first). For a "live" keyup (kind
   * "key" or "out"), if the top-most entry is already a live row for the
   * same kind+node, no duplicate is created -- the existing continuous-keyup
   * row is returned instead so the caller can update it in place.
   */
  function push(entry) {
    const e = normalize(entry);
    if (e.live && entries.length) {
      const top = entries[0];
      if (top.live && top.kind === e.kind && top.node === e.node) {
        return top;
      }
    }
    entries.unshift(e);
    if (entries.length > cap) entries.length = cap;
    return e;
  }

  /**
   * Finalize the most recent live entry for kind+node (unkey): merges patch
   * fields (holdMs, text, ts) and clears the live flag. Returns the updated
   * entry, or null if no matching live row was found.
   */
  function finalize(kind, node, patch = {}) {
    const row = entries.find((e) => e.kind === kind && e.node === String(node) && e.live);
    if (!row) return null;
    Object.assign(row, patch, { live: false });
    return row;
  }

  /**
   * Filter list: "all" | "keyups" (key+out) | "links" (link+drop) |
   * "cmds" (dtmf+cop+sched+sys) | an exact kind string.
   */
  function list(filter) {
    if (!filter || filter === "all") return entries.slice();
    if (filter === "keyups") return entries.filter((e) => KEYUP_KINDS.has(e.kind));
    if (filter === "links") return entries.filter((e) => LINK_KINDS.has(e.kind));
    if (filter === "cmds") return entries.filter((e) => CMD_KINDS.has(e.kind));
    return entries.filter((e) => e.kind === filter);
  }

  function clear() {
    entries = [];
  }

  function toJSON() {
    return entries.map((e) => ({ ...e }));
  }

  function hydrate(json) {
    entries = Array.isArray(json) ? json.slice(0, cap).map(normalize) : [];
  }

  /**
   * Seed the tape with pre-panel-open history from /audit, mapped to
   * cmd-style rows. De-dupes against anything already present (by
   * timestamp+text) so a re-seed or overlap with live events is a no-op.
   * Seeded rows are merged in and the whole tape is re-sorted newest-first,
   * then capped.
   */
  function seedFromAudit(auditEntries) {
    const rows = (Array.isArray(auditEntries) ? auditEntries : [])
      .map(auditEntryToRow)
      .filter(Boolean);
    for (const row of rows) {
      const dup = entries.some((e) => e.ts === row.ts && e.text === row.text);
      if (!dup) entries.push(row);
    }
    entries.sort((a, b) => b.ts - a.ts);
    if (entries.length > cap) entries.length = cap;
  }

  return { push, finalize, list, clear, toJSON, hydrate, seedFromAudit };
}

function auditEntryToRow(entry) {
  if (entry && typeof entry === "object" && entry.timestamp) {
    const d = new Date(entry.timestamp);
    const ts = Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
    const cmd = entry.command || "";
    const det = entry.details ? ` — ${entry.details}` : "";
    return normalizeRow({ ts, kind: "sys", text: `${cmd}${det}`.trim() });
  }
  if (entry) {
    return normalizeRow({ ts: Date.now(), kind: "sys", text: String(entry) });
  }
  return null;
}

function normalizeRow(entry) {
  return {
    ts: Number(entry.ts) || Date.now(),
    kind: String(entry.kind || "sys"),
    text: String(entry.text || ""),
    node: entry.node != null ? String(entry.node) : undefined,
    callsign: entry.callsign != null ? String(entry.callsign) : undefined,
    holdMs: entry.holdMs != null ? Number(entry.holdMs) : undefined,
    live: Boolean(entry.live),
  };
}
