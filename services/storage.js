"use strict";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const STORAGE_DEFAULTS = {
  baseUrl: "",
  apiKey: "",
  favorites: [],
  refreshInterval: 15,
  collapsedSections: [],
  dtmfMacros: [],
  schedules: [],
  nodeCountWarning: 0,
  themeSettings: null,
  screenReaderMode: false,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getSettings() {
  return new Promise((resolve, reject) => {
    if (!hasChromeStorageApi()) {
      reject(new Error("chrome.storage.sync is not available."));
      return;
    }
    chrome.storage.sync.get(STORAGE_DEFAULTS, (items) => {
      const error = chrome.runtime.lastError;
      if (error) { reject(new Error(error.message)); return; }
      resolve(normalizeSettings(items));
    });
  });
}

export function storageSet(values) {
  return new Promise((resolve, reject) => {
    if (!hasChromeStorageApi()) {
      reject(new Error("chrome.storage.sync is not available."));
      return;
    }
    chrome.storage.sync.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) { reject(new Error(error.message)); return; }
      resolve();
    });
  });
}

export function isConfigured(settings) {
  return Boolean(settings?.baseUrl && settings?.apiKey);
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeSettings(raw) {
  return {
    baseUrl:          normalizeBaseUrl(raw?.baseUrl),
    apiKey:           normalizeApiKey(raw?.apiKey),
    favorites:        Array.isArray(raw?.favorites) ? raw.favorites : [],
    refreshInterval:  Number(raw?.refreshInterval) || 15,
    collapsedSections: Array.isArray(raw?.collapsedSections) ? raw.collapsedSections : [],
    dtmfMacros:       Array.isArray(raw?.dtmfMacros) ? raw.dtmfMacros : [],
    schedules:        Array.isArray(raw?.schedules) ? raw.schedules : [],
    nodeCountWarning: Number(raw?.nodeCountWarning) || 0,
    themeSettings:    raw?.themeSettings ?? null,
    screenReaderMode: Boolean(raw?.screenReaderMode),
  };
}

export function normalizeSchedules(schedules) {
  if (!Array.isArray(schedules)) return [];
  return schedules.filter(s =>
    s && typeof s === "object" &&
    s.id && s.action &&
    Array.isArray(s.days) && s.days.length > 0 &&
    Number.isInteger(s.hour) && Number.isInteger(s.minute)
  );
}

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

export function normalizeApiKey(value) {
  return String(value || "").trim();
}

export function normalizeNodeNumber(value) {
  const node = String(value || "").trim();
  if (!node) throw new Error("Node number is required.");
  return node;
}

// ---------------------------------------------------------------------------
// Active connection -- sessionStorage backed, validated on restore
// ---------------------------------------------------------------------------

const ACTIVE_CONNECTION_KEY = "asl_active_connection";

export function saveActiveConnection(node, callsign) {
  try {
    sessionStorage.setItem(ACTIVE_CONNECTION_KEY, JSON.stringify({ node: String(node), callsign: String(callsign || "") }));
  } catch { /* non-critical */ }
}

export function clearActiveConnection() {
  try { sessionStorage.removeItem(ACTIVE_CONNECTION_KEY); } catch { /* non-critical */ }
}

export function loadActiveConnection() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_CONNECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.node) return { node: String(parsed.node), callsign: String(parsed.callsign || "") };
  } catch { /* non-critical */ }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasChromeStorageApi() {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.sync);
}
