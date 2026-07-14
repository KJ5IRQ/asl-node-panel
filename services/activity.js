"use strict";

// ---------------------------------------------------------------------------
// Pure helpers for the Display zone's activity/state computations: keyed-set
// diffing (who newly keyed/unkeyed between two parseActiveLinks() snapshots),
// busy% for Memories, and the standby watch line's "next scheduled event".
// No DOM, no chrome.*, no timers -- all inputs passed in for testability.
// ---------------------------------------------------------------------------

/**
 * Diff two keyed-node sets (as produced by api.js#parseActiveLinks) and
 * report which node numbers newly started or stopped passing audio.
 * @param {Set<string>|Iterable<string>} prevSet
 * @param {Set<string>|Iterable<string>} nextSet
 */
export function diffKeyedSets(prevSet, nextSet) {
  const prev = prevSet instanceof Set ? prevSet : new Set(prevSet || []);
  const next = nextSet instanceof Set ? nextSet : new Set(nextSet || []);
  const newlyKeyed = [];
  const newlyUnkeyed = [];
  for (const node of next) {
    if (!prev.has(node)) newlyKeyed.push(node);
  }
  for (const node of prev) {
    if (!next.has(node)) newlyUnkeyed.push(node);
  }
  return { newlyKeyed, newlyUnkeyed };
}

/**
 * busy% = totaltxtime / apprptuptime, clamped 0-100. Returns null (never a
 * guessed number) when not computable: missing, non-finite, or zero/negative
 * uptime.
 */
export function computeBusyPercent(totalTxTime, appRptUptime) {
  const tx = Number(totalTxTime);
  const up = Number(appRptUptime);
  if (!Number.isFinite(tx) || !Number.isFinite(up) || up <= 0) return null;
  const pct = (tx / up) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Pure computation of the next enabled schedule occurrence, for the standby
 * watch line. `now` is injected (a Date) so this is testable without relying
 * on the real clock.
 * @returns {{schedule: object, target: Date, label: string, dayName: string}|null}
 */
export function computeNextSchedule(schedules, now) {
  const enabled = (Array.isArray(schedules) ? schedules : []).filter((s) => s && s.enabled);
  if (!enabled.length) return null;

  let best = null;
  for (const schedule of enabled) {
    const days = Array.isArray(schedule.days) ? schedule.days : [];
    for (const day of days) {
      const target = nextOccurrence(now, day, schedule.hour, schedule.minute);
      if (!best || target.getTime() < best.target.getTime()) {
        best = { schedule, target };
      }
    }
  }
  if (!best) return null;

  return {
    schedule: best.schedule,
    target: best.target,
    label: describeScheduleAction(best.schedule),
    dayName: DAY_NAMES[best.target.getUTCDay()],
  };
}

function nextOccurrence(now, targetDay, hour, minute) {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hour, minute, 0, 0
  ));
  let dayDelta = targetDay - now.getUTCDay();
  if (dayDelta < 0) dayDelta += 7;
  candidate.setUTCDate(candidate.getUTCDate() + dayDelta);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

export function describeScheduleAction(schedule) {
  if (schedule.action === "disconnect-all") return "Disconnect All";
  if (schedule.action === "disconnect") return `Disconnect ${schedule.node}`;
  return `Connect ${schedule.node}`;
}

/** "next: connect 55553 @ Wed 01:00Z" -- the standby watch line text. */
export function formatNextScheduleLine(next) {
  if (!next) return "";
  const hh = String(next.target.getUTCHours()).padStart(2, "0");
  const mm = String(next.target.getUTCMinutes()).padStart(2, "0");
  return `next: ${next.label.toLowerCase()} @ ${next.dayName} ${hh}:${mm}Z`;
}
