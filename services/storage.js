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

export function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    if (!hasChromeStorageApi()) {
      reject(new Error("chrome.storage.sync is not available."));
      return;
    }
    chrome.storage.sync.remove(keys, () => {
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
  if (!/^\d{1,7}$/.test(node)) throw new Error("Node number must be 1-7 digits.");
  return node;
}

// Non-throwing companion to normalizeNodeNumber, for form validation.
export function isValidNodeNumber(value) {
  return /^\d{1,7}$/.test(String(value || "").trim());
}

export function sanitizeFavorites(favorites) {
  if (!Array.isArray(favorites)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const favorite of favorites) {
    const node = String(favorite?.node || "").trim();
    const label = String(favorite?.label || "").trim();
    if (!isValidNodeNumber(node) || seen.has(node)) continue;
    seen.add(node);
    sanitized.push({ node, label: label || node });
  }
  return sanitized.sort((a, b) => Number(a.node) - Number(b.node));
}

// Strict base URL validator for the options-page save path. Throws on
// anything that is not a well-formed http(s) URL; strips hash/search/
// trailing slashes. See normalizeBaseUrl() above for the loose read path.
export function validateBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Base URL is required.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL must be a valid http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must start with http:// or https://.");
  }
  url.hash = "";
  url.search = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  const normalizedPath = pathname === "/" ? "" : pathname;
  return `${url.protocol}//${url.host}${normalizedPath}`;
}

export function getOriginPattern(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/*`;
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
