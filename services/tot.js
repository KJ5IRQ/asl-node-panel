"use strict";

// ---------------------------------------------------------------------------
// TOT (timeout timer) -- pure state function.
//
// The operator's node has no timeout timer of its own; most repeaters and
// linked systems time out around three minutes, so the panel runs a local
// countdown that arms on every keyup (rxkeyed going true -- the OPERATOR
// talking OUT) and re-arms on every re-key. This module is deliberately free
// of timers/DOM/chrome.* so it can be driven by a 250ms interval in
// sidepanel.js and unit tested with fake clocks.
// ---------------------------------------------------------------------------

/**
 * @param {number|null} armedAtMs epoch ms when the current keyup started, or
 *   null if unknown (e.g. panel opened mid-keyup -- never guess an arm time).
 * @param {number} nowMs current epoch ms.
 * @param {number} totSeconds configured duration; 0 means the feature is off.
 * @returns {{ remain: number, phase: "off"|"indeterminate"|"normal"|"warn"|"crit"|"expired" }}
 *   remain is seconds remaining (never negative).
 */
export function totState(armedAtMs, nowMs, totSeconds) {
  const duration = Number(totSeconds) || 0;

  if (duration <= 0) return { remain: 0, phase: "off" };
  if (armedAtMs == null) return { remain: duration, phase: "indeterminate" };

  // Clock-skew safety: nowMs earlier than armedAtMs must not go negative.
  const elapsedMs = Math.max(0, Number(nowMs) - Number(armedAtMs));
  const remain = Math.max(0, duration - elapsedMs / 1000);

  let phase;
  if (remain <= 0) phase = "expired";
  else if (remain <= 30) phase = "crit";
  else if (remain <= 60) phase = "warn";
  else phase = "normal";

  return { remain, phase };
}

/** Format seconds remaining as m:ss (floor to whole seconds, never negative). */
export function formatCountdown(remainSeconds) {
  const s = Math.max(0, Math.ceil(Number(remainSeconds) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

/** Format a hold duration (ms) the same way, for tape rows ("1m41", "8s"). */
export function formatHold(holdMs) {
  const totalSeconds = Math.max(0, Math.round((Number(holdMs) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, "0")}`;
}
