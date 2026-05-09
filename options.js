(() => {
  "use strict";

  const STORAGE_KEYS = ["baseUrl", "apiKey", "favorites"];

  const DEFAULT_SETTINGS = {
    baseUrl: "",
    apiKey: "",
    favorites: []
  };

  const state = {
    favorites: [],
    statusTimer: null
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindElements();
    bindEvents();
    await loadSettings();
  }

  function bindElements() {
    els.baseUrl = document.getElementById("baseUrl");
    els.apiKey = document.getElementById("apiKey");
    els.toggleApiKey = document.getElementById("toggleApiKey");

    els.favoriteNode = document.getElementById("favoriteNode");
    els.favoriteLabel = document.getElementById("favoriteLabel");
    els.addFavorite = document.getElementById("addFavorite");
    els.favoritesList = document.getElementById("favoritesList");

    els.saveSettings = document.getElementById("saveSettings");
    els.resetSettings = document.getElementById("resetSettings");
    els.statusMessage = document.getElementById("statusMessage");
  }

  function bindEvents() {
    els.toggleApiKey.addEventListener("click", handleToggleApiKey);
    els.addFavorite.addEventListener("click", handleAddFavorite);
    els.saveSettings.addEventListener("click", handleSaveSettings);
    els.resetSettings.addEventListener("click", handleResetSettings);
    els.favoritesList.addEventListener("click", handleFavoritesListClick);

    els.favoriteNode.addEventListener("keydown", handleFavoriteEnterKey);
    els.favoriteLabel.addEventListener("keydown", handleFavoriteEnterKey);
  }

  async function loadSettings() {
    try {
      const settings = await storageGet(DEFAULT_SETTINGS);

      els.baseUrl.value = settings.baseUrl || "";
      els.apiKey.value = settings.apiKey || "";
      state.favorites = sanitizeFavorites(settings.favorites);

      renderFavorites();
      setStatus("Settings loaded.", "success", 1200);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to load settings: ${error.message}`, "error");
    }
  }

  async function handleSaveSettings() {
    try {
      const validated = validateSettings();

      const hasPermission = await ensureHostPermission(validated.baseUrl);

      if (!hasPermission) {
        setStatus(
          "Chrome host permission was not granted. Settings were not saved.",
          "error"
        );
        return;
      }

      await storageSet({
        baseUrl: validated.baseUrl,
        apiKey: validated.apiKey,
        favorites: validated.favorites
      });

      setStatus("Settings saved.", "success", 2000);
    } catch (error) {
      console.error(error);
      setStatus(error.message, "error");
    }
  }

  async function handleResetSettings() {
    const confirmed = window.confirm(
      "Reset ASL Agent settings and remove all favorite nodes?"
    );

    if (!confirmed) {
      return;
    }

    try {
      await storageRemove(STORAGE_KEYS);

      els.baseUrl.value = "";
      els.apiKey.value = "";
      els.apiKey.type = "password";
      els.toggleApiKey.textContent = "Show API Key";

      els.favoriteNode.value = "";
      els.favoriteLabel.value = "";
      state.favorites = [];

      renderFavorites();
      setStatus("Settings reset.", "success", 2000);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to reset settings: ${error.message}`, "error");
    }
  }

  function handleToggleApiKey() {
    const showing = els.apiKey.type === "text";

    els.apiKey.type = showing ? "password" : "text";
    els.toggleApiKey.textContent = showing ? "Show API Key" : "Hide API Key";
  }

  function handleFavoriteEnterKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddFavorite();
    }
  }

  function handleAddFavorite() {
    const node = els.favoriteNode.value.trim();
    const label = els.favoriteLabel.value.trim();

    if (!isValidNodeNumber(node)) {
      setStatus("Favorite node must be numeric.", "error");
      return;
    }

    const existingIndex = state.favorites.findIndex(
      (favorite) => favorite.node === node
    );

    const favorite = {
      node,
      label: label || node
    };

    if (existingIndex >= 0) {
      state.favorites[existingIndex] = favorite;
      setStatus("Favorite updated. Click Save Settings to persist.", "warning");
    } else {
      state.favorites.push(favorite);
      setStatus("Favorite added. Click Save Settings to persist.", "warning");
    }

    state.favorites.sort((a, b) => Number(a.node) - Number(b.node));

    els.favoriteNode.value = "";
    els.favoriteLabel.value = "";
    els.favoriteNode.focus();

    renderFavorites();
  }

  function handleFavoritesListClick(event) {
    const removeButton = event.target.closest("[data-remove-index]");

    if (!removeButton) {
      return;
    }

    const index = Number(removeButton.dataset.removeIndex);

    if (!Number.isInteger(index) || index < 0 || index >= state.favorites.length) {
      return;
    }

    state.favorites.splice(index, 1);
    renderFavorites();

    setStatus("Favorite removed. Click Save Settings to persist.", "warning");
  }

  function validateSettings() {
    const baseUrl = normalizeBaseUrl(els.baseUrl.value);
    const apiKey = els.apiKey.value.trim();
    const favorites = sanitizeFavorites(state.favorites);

    if (!baseUrl) {
      throw new Error("Base URL is required.");
    }

    if (!apiKey) {
      throw new Error("API key is required.");
    }

    return {
      baseUrl,
      apiKey,
      favorites
    };
  }

  function normalizeBaseUrl(value) {
    const raw = value.trim();

    if (!raw) {
      return "";
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

  function getOriginPattern(baseUrl) {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}/*`;
  }

  async function ensureHostPermission(baseUrl) {
    const originPattern = getOriginPattern(baseUrl);

    if (!hasChromePermissionsApi()) {
      return true;
    }

    const alreadyGranted = await permissionsContains({
      origins: [originPattern]
    });

    if (alreadyGranted) {
      return true;
    }

    return permissionsRequest({
      origins: [originPattern]
    });
  }

  function sanitizeFavorites(favorites) {
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

    return sanitized.sort((a, b) => Number(a.node) - Number(b.node));
  }

  function isValidNodeNumber(value) {
    return /^\d+$/.test(value);
  }

  function renderFavorites() {
    els.favoritesList.replaceChildren();

    if (state.favorites.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No favorite nodes saved yet.";
      els.favoritesList.appendChild(empty);
      return;
    }

    state.favorites.forEach((favorite, index) => {
      const item = document.createElement("div");
      item.className = "favorite-item";

      const node = document.createElement("div");
      node.className = "favorite-node";
      node.textContent = favorite.node;

      const label = document.createElement("div");
      label.className = "favorite-label";
      label.textContent = favorite.label;

      const remove = document.createElement("button");
      remove.className = "danger";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.dataset.removeIndex = String(index);

      item.append(node, label, remove);
      els.favoritesList.appendChild(item);
    });
  }

  function setStatus(message, type = "", timeoutMs = 0) {
    window.clearTimeout(state.statusTimer);

    els.statusMessage.textContent = message;
    els.statusMessage.className = type ? `status ${type}` : "status";

    if (timeoutMs > 0) {
      state.statusTimer = window.setTimeout(() => {
        els.statusMessage.textContent = "";
        els.statusMessage.className = "status";
      }, timeoutMs);
    }
  }

  function storageGet(defaults) {
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

  function storageSet(values) {
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

  function permissionsContains(permissionRequest) {
    return new Promise((resolve, reject) => {
      chrome.permissions.contains(permissionRequest, (result) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(Boolean(result));
      });
    });
  }

  function permissionsRequest(permissionRequest) {
    return new Promise((resolve, reject) => {
      chrome.permissions.request(permissionRequest, (granted) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(Boolean(granted));
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

  function hasChromePermissionsApi() {
    return (
      typeof chrome !== "undefined" &&
      Boolean(chrome.permissions) &&
      Boolean(chrome.permissions.request) &&
      Boolean(chrome.permissions.contains)
    );
  }
})();