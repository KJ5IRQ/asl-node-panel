"use strict";

import { getSettings, normalizeSchedules, isConfigured } from "./services/storage.js";
import { AslAgentClient } from "./services/api.js";

const SCHEDULE_ALARM_NAME = "schedule-check";
const SCHEDULE_DEDUPE_WINDOW_MS = 90000; // same window sidepanel.js used to enforce
const SCHEDULE_DEDUPE_STORAGE_KEY = "scheduleLastFired";

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnActionClick();
  createScheduleAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick();
  createScheduleAlarm();
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openSidePanel(tab);
  } catch (error) {
    console.error("Failed to open ASL Agent side panel:", error);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SCHEDULE_ALARM_NAME) return;
  checkSchedules().catch((error) => console.error("Schedule check failed:", error));
});

function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) {
    return;
  }

  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  }).catch((error) => {
    console.error("Failed to enable side panel action behavior:", error);
  });
}

async function openSidePanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open) {
    throw new Error("chrome.sidePanel.open is not available.");
  }

  if (tab && Number.isInteger(tab.windowId)) {
    await chrome.sidePanel.open({
      windowId: tab.windowId
    });
    return;
  }

  const window = await chrome.windows.getCurrent();

  await chrome.sidePanel.open({
    windowId: window.id
  });
}

// ---------------------------------------------------------------------------
// Schedules -- run here instead of the side panel so they fire even while
// the panel is closed. Chrome itself still has to be running.
// ---------------------------------------------------------------------------

function createScheduleAlarm() {
  chrome.alarms.create(SCHEDULE_ALARM_NAME, { periodInMinutes: 1 });
}

async function checkSchedules() {
  const settings = await getSettings();
  if (!isConfigured(settings)) return;

  const schedules = normalizeSchedules(settings.schedules).filter((s) => s.enabled);
  if (!schedules.length) return;

  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  const dedupeStore = await chrome.storage.session.get({ [SCHEDULE_DEDUPE_STORAGE_KEY]: {} });
  const lastFired = dedupeStore[SCHEDULE_DEDUPE_STORAGE_KEY] || {};
  const nowMs = Date.now();
  let dedupeChanged = false;

  for (const schedule of schedules) {
    if (!schedule.days.includes(utcDay)) continue;
    if (schedule.hour !== utcHour) continue;
    if (Math.abs(schedule.minute - utcMinute) > 1) continue;

    const lastFiredMs = Number(lastFired[schedule.id] || 0);
    if (nowMs - lastFiredMs < SCHEDULE_DEDUPE_WINDOW_MS) continue;

    lastFired[schedule.id] = nowMs;
    dedupeChanged = true;

    await executeSchedule(schedule, settings);
  }

  if (dedupeChanged) {
    await chrome.storage.session.set({ [SCHEDULE_DEDUPE_STORAGE_KEY]: lastFired });
  }
}

async function executeSchedule(schedule, settings) {
  const client = new AslAgentClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
  let ok = true;
  let error = null;

  try {
    if (schedule.action === "disconnect-all") {
      await client.disconnectAll();
    } else if (schedule.action === "disconnect") {
      if (!schedule.node) throw new Error("Disconnect schedule has no node.");
      await client.disconnectNode(schedule.node);
    } else {
      await client.connectNode(schedule.node, { monitorOnly: schedule.mode === "monitor" });
    }
  } catch (e) {
    ok = false;
    error = e.message;
    console.error(`Schedule ${schedule.id} failed:`, e);
  }

  // Best-effort -- the side panel may not be open to receive this.
  try {
    await chrome.runtime.sendMessage({ type: "SCHEDULE_FIRED", schedule, ok, error });
  } catch {
    // No listener -- ignore.
  }
}
