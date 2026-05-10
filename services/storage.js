"use strict";

export const STORAGE_KEYS = Object.freeze({
  BASE_URL: "baseUrl",
  API_KEY: "apiKey",
  FAVORITES: "favorites",
  REFRESH_INTERVAL: "refreshInterval",
  COLLAPSED_SECTIONS: "collapsedSections"
});

export const DEFAULT_SETTINGS = Object.freeze({
  [STORAGE_KEYS.BASE_URL]: "",
  [STORAGE_KEYS.API_KEY]: "",
  [STORAGE_KEYS.FAVORITES]: [],
  [STORAGE_KEYS.REFRESH_INTERVAL]: 15,
  [STORAGE_KEYS.COLLAPSED_SECTIONS]: []
});

export async function getSettings() {
  const settings = await storageGet(DEFAULT_SETTINGS);

  return {
    baseUrl: normalizeStoredBaseUrl(settings.baseUrl),
    apiKey: normalizeStoredApiKey(settings.apiKey),
    favorites: sanitizeFavorites(settings.favorites),
    refreshInterval: normalizeRefreshInterval(settings.refreshInterval),
    collapsedSections: normalizeCollapsedSections(settings.collapsedSections)
  };
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);

  await storageSet({
    [STORAGE_KEYS.BASE_URL]: normalized.baseUrl,
    [STORAGE_KEYS.API_KEY]: normalized.apiKey,
    [STORAGE_KEYS.FAVORITES]: normalized.favorites,
    [STORAGE_KEYS.REFRESH_INTERVAL]: normalized.refreshInterval,
    [STORAGE_KEYS.COLLAPSED_SECTIONS]: normalized.collapsedSections
  });

  return normalized;
}

export async function updateSettings(patch) {
  const current = await getSettings();

  return saveSettings({
    ...current,
    ...patch
  });
}

export async function resetSettings() {
  await storageRemove(Object.values(STORAGE_KEYS));

  return {
    baseUrl: "",
    apiKey: "",
    favorites: []
  };
}

export async function getBaseUrl() {
  const { baseUrl } = await getSettings();
  return baseUrl;
}

export async function getApiKey() {
  const { apiKey } = await getSettings();
  return apiKey;
}

export async function getFavorites() {
  const { favorites } = await getSettings();
  return favorites;
}

export async function saveFavorites(favorites) {
  const sanitized = sanitizeFavorites(favorites);

  await storageSet({
    [STORAGE_KEYS.FAVORITES]: sanitized
  });

  return sanitized;
}

export async function addFavorite(node, label = "") {
  const favorites = await getFavorites();
  const sanitizedNode = normalizeNodeNumber(node);
  const sanitizedLabel = normalizeFavoriteLabel(label) || sanitizedNode;

  const existingIndex = favorites.findIndex(
    (favorite) => favorite.node === sanitizedNode
  );

  const favorite = {
    node: sanitizedNode,
    label: sanitizedLabel
  };

  if (existingIndex >= 0) {
    favorites[existingIndex] = favorite;
  } else {
    favorites.push(favorite);
  }

  return saveFavorites(favorites);
}

export async function removeFavorite(node) {
  const sanitizedNode = normalizeNodeNumber(node);
  const favorites = await getFavorites();

  const updatedFavorites = favorites.filter(
    (favorite) => favorite.node !== sanitizedNode
  );

  return saveFavorites(updatedFavorites);
}

export function normalizeSettings(settings = {}) {
  return {
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    apiKey: normalizeApiKey(settings.apiKey),
    favorites: sanitizeFavorites(settings.favorites),
    refreshInterval: normalizeRefreshInterval(settings.refreshInterval),
    collapsedSections: normalizeCollapsedSections(settings.collapsedSections)
  };
}

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    throw new Error("Base URL is required.");
  }

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

export function normalizeApiKey(value) {
  const apiKey = String(value || "").trim();

  if (!apiKey) {
    throw new Error("API key is required.");
  }

  return apiKey;
}

export function sanitizeFavorites(favorites) {
  if (!Array.isArray(favorites)) {
    return [];
  }

  const seen = new Set();
  const sanitized = [];

  for (const favorite of favorites) {
    const node = String(favorite?.node || "").trim();
    const label = String(favorite?.label || "").trim();

    if (!isValidNodeNumber(node) || seen.has(node)) {
      continue;
    }

    seen.add(node);

    sanitized.push({
      node,
      label: label || node
    });
  }

  return sortFavorites(sanitized);
}

export function normalizeNodeNumber(value) {
  const node = String(value || "").trim();

  if (!isValidNodeNumber(node)) {
    throw new Error("Node number must be numeric.");
  }

  return node;
}

export function normalizeFavoriteLabel(value) {
  return String(value || "").trim();
}

export function isValidNodeNumber(value) {
  return /^\d+$/.test(String(value || "").trim());
}

export function isConfigured(settings) {
  return Boolean(
    settings &&
    settings.baseUrl &&
    settings.apiKey
  );
}

export function getOriginPattern(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const url = new URL(normalizedBaseUrl);

  return `${url.protocol}//${url.host}/*`;
}

function normalizeStoredBaseUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    return normalizeBaseUrl(raw);
  } catch {
    return "";
  }
}

function normalizeStoredApiKey(value) {
  return String(value || "").trim();
}

function sortFavorites(favorites) {
  return [...favorites].sort((a, b) => Number(a.node) - Number(b.node));
}

export function storageGet(defaults) {
  return new Promise((resolve, reject) => {
    if (!hasChromeStorageApi()) {
      reject(new Error("chrome.storage.sync is not available."));
      return;
    }

    chrome.storage.sync.get(defaults, (items) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(items);
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

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    if (!hasChromeStorageApi()) {
      reject(new Error("chrome.storage.sync is not available."));
      return;
    }

    chrome.storage.sync.remove(keys, () => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function hasChromeStorageApi() {
  return (
    typeof chrome !== "undefined" &&
    Boolean(chrome.storage) &&
    Boolean(chrome.storage.sync)
  );
}

export function normalizeRefreshInterval(value) {
  const valid = [5, 15, 30, 60];
  const parsed = Number(value);
  return valid.includes(parsed) ? parsed : 15;
}

export function normalizeCollapsedSections(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((s) => typeof s === "string");
}
