(() => {
  "use strict";

  const STORAGE_KEYS = ["baseUrl", "apiKey", "favorites", "refreshInterval", "collapsedSections", "dtmfMacros", "schedules", "nodeCountWarning"];

  const DEFAULT_SETTINGS = {
    baseUrl: "",
    apiKey: "",
    favorites: [],
    refreshInterval: 15,
    collapsedSections: [],
    dtmfMacros: [],
    schedules: [],
    nodeCountWarning: 0
  };

  const state = {
    favorites: [],
    dtmfMacros: [],
    schedules: [],
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

    els.refreshInterval = document.getElementById("refreshInterval");
    els.nodeCountWarning = document.getElementById("nodeCountWarning");
    els.macroLabel = document.getElementById("macroLabel");
    els.macroSequence = document.getElementById("macroSequence");
    els.addMacro = document.getElementById("addMacro");
    els.macrosList = document.getElementById("macrosList");
    els.scheduleNode = document.getElementById("scheduleNode");
    els.scheduleAction = document.getElementById("scheduleAction");
    els.scheduleMode = document.getElementById("scheduleMode");
    els.scheduleHour = document.getElementById("scheduleHour");
    els.scheduleMinute = document.getElementById("scheduleMinute");
    els.dayPicker = document.getElementById("dayPicker");
    els.addSchedule = document.getElementById("addSchedule");
    els.schedulesList = document.getElementById("schedulesList");
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
    els.addMacro.addEventListener("click", handleAddMacro);
    els.macrosList.addEventListener("click", handleMacrosListClick);
    els.addSchedule.addEventListener("click", handleAddSchedule);
    els.schedulesList.addEventListener("click", handleSchedulesListClick);
    populateTimeSelects();

    els.favoriteNode.addEventListener("keydown", handleFavoriteEnterKey);
    els.favoriteLabel.addEventListener("keydown", handleFavoriteEnterKey);
  }

  async function loadSettings() {
    try {
      const settings = await storageGet(DEFAULT_SETTINGS);

      els.baseUrl.value = settings.baseUrl || "";
      els.apiKey.value = settings.apiKey || "";
      if (els.refreshInterval) {
        els.refreshInterval.value = String(settings.refreshInterval || 15);
      }
      if (els.nodeCountWarning) {
        els.nodeCountWarning.value = String(settings.nodeCountWarning || 0);
      }
      state.dtmfMacros = Array.isArray(settings.dtmfMacros) ? settings.dtmfMacros : [];
      state.schedules = Array.isArray(settings.schedules) ? settings.schedules : [];
      renderMacros();
      renderSchedules();
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
        favorites: validated.favorites,
        refreshInterval: validated.refreshInterval,
        dtmfMacros: validated.dtmfMacros,
        schedules: validated.schedules,
        nodeCountWarning: validated.nodeCountWarning
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

  async function handleAddFavorite() {
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
    } else {
      state.favorites.push(favorite);
    }

    state.favorites.sort((a, b) => Number(a.node) - Number(b.node));

    els.favoriteNode.value = "";
    els.favoriteLabel.value = "";
    els.favoriteNode.focus();

    renderFavorites();

    try {
      await storageSet({ favorites: sanitizeFavorites(state.favorites) });
      notifyPanelFavoritesChanged();
      setStatus("Favorite saved.", "success", 2000);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to save favorite: ${error.message}`, "error");
    }
  }

  async function handleFavoritesListClick(event) {
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

    try {
      await storageSet({ favorites: sanitizeFavorites(state.favorites) });
      notifyPanelFavoritesChanged();
      setStatus("Favorite removed.", "success", 2000);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to remove favorite: ${error.message}`, "error");
    }
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

    const refreshInterval = els.refreshInterval
      ? Number(els.refreshInterval.value)
      : 15;

    return {
      baseUrl,
      apiKey,
      favorites,
      refreshInterval: [5, 15, 30, 60].includes(refreshInterval) ? refreshInterval : 15,
      dtmfMacros: state.dtmfMacros,
      schedules: state.schedules,
      nodeCountWarning: Math.max(0, Number(els.nodeCountWarning?.value) || 0)
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
  function notifyPanelFavoritesChanged() {
    if (typeof chrome !== "undefined" && chrome.runtime) {
      chrome.runtime.sendMessage({ type: "FAVORITES_CHANGED" }).catch(() => {
        // Panel may not be open -- ignore.
      });
    }
  }


  function populateTimeSelects() {
    if (!els.scheduleHour || !els.scheduleMinute) return;
    for (let h = 0; h < 24; h++) {
      const o = document.createElement("option");
      o.value = String(h);
      o.textContent = String(h).padStart(2, "0");
      els.scheduleHour.appendChild(o);
    }
    for (let m = 0; m < 60; m += 5) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = String(m).padStart(2, "0");
      els.scheduleMinute.appendChild(o);
    }
  }

  async function handleAddMacro() {
    const label = els.macroLabel.value.trim();
    const sequence = els.macroSequence.value.trim();
    if (!label || !sequence) {
      setStatus("Label and sequence are required.", "error");
      return;
    }
    if (state.dtmfMacros.length >= 6) {
      setStatus("Maximum 6 macros.", "error");
      return;
    }
    state.dtmfMacros.push({ label, sequence });
    els.macroLabel.value = "";
    els.macroSequence.value = "";
    renderMacros();
    await storageSet({ dtmfMacros: state.dtmfMacros });
    notifyPanelFavoritesChanged();
    setStatus("Macro saved.", "success", 2000);
  }

  async function handleMacrosListClick(event) {
    const btn = event.target.closest("[data-remove-macro]");
    if (!btn) return;
    const idx = Number(btn.dataset.removeMacro);
    if (!Number.isInteger(idx) || idx < 0 || idx >= state.dtmfMacros.length) return;
    state.dtmfMacros.splice(idx, 1);
    renderMacros();
    await storageSet({ dtmfMacros: state.dtmfMacros });
    notifyPanelFavoritesChanged();
    setStatus("Macro removed.", "success", 2000);
  }

  function renderMacros() {
    if (!els.macrosList) return;
    els.macrosList.replaceChildren();
    if (!state.dtmfMacros.length) {
      const e = document.createElement("div");
      e.className = "empty-state";
      e.textContent = "No macros saved yet.";
      els.macrosList.appendChild(e);
      return;
    }
    state.dtmfMacros.forEach((m, i) => {
      const item = document.createElement("div");
      item.className = "item-row";
      const label = document.createElement("span");
      label.className = "item-label";
      label.textContent = m.label;
      const seq = document.createElement("span");
      seq.className = "item-value";
      seq.textContent = m.sequence;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "Remove";
      rm.dataset.removeMacro = String(i);
      item.append(label, seq, rm);
      els.macrosList.appendChild(item);
    });
  }

  async function handleAddSchedule() {
    const node = els.scheduleNode.value.trim();
    const action = els.scheduleAction.value;
    if (action !== "disconnect-all" && !node) {
      setStatus("Node number required.", "error");
      return;
    }
    const days = Array.from(
      els.dayPicker.querySelectorAll("input[type=checkbox]:checked")
    ).map((cb) => Number(cb.value));
    if (!days.length) {
      setStatus("Select at least one day.", "error");
      return;
    }
    const schedule = {
      id: Math.random().toString(36).slice(2),
      node,
      action,
      mode: els.scheduleMode.value,
      days,
      hour: Number(els.scheduleHour.value),
      minute: Number(els.scheduleMinute.value),
      enabled: true
    };
    state.schedules.push(schedule);
    renderSchedules();
    await storageSet({ schedules: state.schedules });
    notifyPanelFavoritesChanged();
    setStatus("Schedule saved.", "success", 2000);
  }

  async function handleSchedulesListClick(event) {
    const rm = event.target.closest("[data-remove-schedule]");
    if (rm) {
      const id = rm.dataset.removeSchedule;
      state.schedules = state.schedules.filter((s) => s.id !== id);
      renderSchedules();
      await storageSet({ schedules: state.schedules });
      notifyPanelFavoritesChanged();
      setStatus("Schedule removed.", "success", 2000);
      return;
    }
    const toggle = event.target.closest("[data-toggle-schedule]");
    if (toggle) {
      const id = toggle.dataset.toggleSchedule;
      const s = state.schedules.find((s) => s.id === id);
      if (s) {
        s.enabled = !s.enabled;
        renderSchedules();
        await storageSet({ schedules: state.schedules });
        notifyPanelFavoritesChanged();
      }
    }
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderSchedules() {
    if (!els.schedulesList) return;
    els.schedulesList.replaceChildren();
    if (!state.schedules.length) {
      const e = document.createElement("div");
      e.className = "empty-state";
      e.textContent = "No schedules saved yet.";
      els.schedulesList.appendChild(e);
      return;
    }
    state.schedules.forEach((s) => {
      const item = document.createElement("div");
      item.className = `item-row${s.enabled ? "" : " disabled"}`;
      const info = document.createElement("span");
      info.className = "item-label";
      const dayStr = s.days.map((d) => DAY_NAMES[d]).join(", ");
      const timeStr = `${String(s.hour).padStart(2,"0")}:${String(s.minute).padStart(2,"0")} UTC`;
      const actionStr = s.action === "disconnect-all" ? "Disconnect All" : `${s.action} ${s.node}`;
      info.textContent = `${actionStr} — ${dayStr} @ ${timeStr}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "secondary";
      toggle.textContent = s.enabled ? "ON" : "OFF";
      toggle.dataset.toggleSchedule = s.id;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "Remove";
      rm.dataset.removeSchedule = s.id;
      item.append(info, toggle, rm);
      els.schedulesList.appendChild(item);
    });
  }

})();