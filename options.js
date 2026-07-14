(() => {
  "use strict";

  const STORAGE_KEYS = ["baseUrl", "apiKey", "favorites", "refreshInterval", "collapsedSections", "dtmfMacros", "schedules", "nodeCountWarning", "themeSettings", "screenReaderMode"];

  const DEFAULT_SETTINGS = {
    baseUrl: "",
    apiKey: "",
    favorites: [],
    refreshInterval: 15,
    collapsedSections: [],
    dtmfMacros: [],
    schedules: [],
    nodeCountWarning: 0,
    themeSettings: null,
    screenReaderMode: false
  };

  const state = {
    favorites: [],
    dtmfMacros: [],
    schedules: [],
    themeSettings: { preset: "system", mode: "dark", customColors: {} },
    screenReaderMode: false,
    statusTimer: null,
    customColorSaveTimer: null
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
    els.screenReaderMode = document.getElementById("screenReaderMode");
    els.themePreset = document.getElementById("themePreset");
    els.themeDark = document.getElementById("themeDark");
    els.themeLight = document.getElementById("themeLight");
    els.themeModeGroup = document.getElementById("themeModeGroup");
    els.customColorsSection = document.getElementById("customColorsSection");
    els.colorPickerGrid = document.getElementById("colorPickerGrid");
    els.resetCustomColors = document.getElementById("resetCustomColors");
    els.themePreview = document.getElementById("themePreview");
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
    buildColorPickerGrid();
    if (els.screenReaderMode) els.screenReaderMode.addEventListener("change", handleScreenReaderToggle);
    els.themePreset.addEventListener("change", handleThemeChange);
    els.themeDark.addEventListener("change", handleThemeChange);
    els.themeLight.addEventListener("change", handleThemeChange);
    els.resetCustomColors.addEventListener("click", handleResetCustomColors);

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
      state.themeSettings = settings.themeSettings || { preset: "system", mode: "dark", customColors: {} };
      state.screenReaderMode = Boolean(settings.screenReaderMode);
      if (els.screenReaderMode) {
        els.screenReaderMode.checked = state.screenReaderMode;
        els.screenReaderMode.setAttribute("aria-checked", String(state.screenReaderMode));
      }
      renderMacros();
      renderSchedules();
      loadThemeUI();
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
        nodeCountWarning: validated.nodeCountWarning,
        themeSettings: validated.themeSettings,
        screenReaderMode: validated.screenReaderMode
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

      els.apiKey.type = "password";
      els.toggleApiKey.textContent = "Show API Key";
      els.favoriteNode.value = "";
      els.favoriteLabel.value = "";

      await loadSettings();
      notifyPanelFavoritesChanged();
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
      nodeCountWarning: Math.max(0, Number(els.nodeCountWarning?.value) || 0),
      themeSettings: state.themeSettings,
      screenReaderMode: Boolean(els.screenReaderMode?.checked)
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


  // ── Theme ─────────────────────────────────────────────────────────────────

  // Dynamically import theme module (ES module from options.js which is classic)
  // We use a helper that reads/writes themeSettings directly via chrome.storage
  // and calls applyTheme from the already-loaded theme.js module on the page.

  const THEME_VARS_DEF = [
    { key: "--bg",      label: "Background" },
    { key: "--panel",   label: "Panel Surface" },
    { key: "--text",    label: "Text" },
    { key: "--muted",   label: "Muted Text" },
    { key: "--border",  label: "Border" },
    { key: "--accent",  label: "Accent / Primary" },
    { key: "--amber",   label: "Value / Highlight" },
    { key: "--success", label: "Success" },
    { key: "--warning", label: "Warning" },
    { key: "--danger",  label: "Danger" },
  ];

  function buildColorPickerGrid() {
    if (!els.colorPickerGrid) return;
    els.colorPickerGrid.replaceChildren();
    for (const { key, label } of THEME_VARS_DEF) {
      const row = document.createElement("div");
      row.className = "color-picker-row";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      lbl.htmlFor = `color_${key.slice(2)}`;
      const inp = document.createElement("input");
      inp.type = "color";
      inp.id = `color_${key.slice(2)}`;
      inp.dataset.themeVar = key;
      inp.addEventListener("input", handleCustomColorChange);
      const val = document.createElement("span");
      val.className = "color-hex-value";
      val.id = `hex_${key.slice(2)}`;
      row.append(lbl, inp, val);
      els.colorPickerGrid.appendChild(row);
    }
  }

  function loadThemeUI() {
    const ts = state.themeSettings;
    if (!ts) return;
    if (els.themePreset) els.themePreset.value = ts.preset || "system";
    const mode = ts.mode || "dark";
    if (els.themeDark) els.themeDark.checked = mode === "dark";
    if (els.themeLight) els.themeLight.checked = mode === "light";
    updateThemeModeVisibility();
    updateCustomColorsVisibility();
    updateColorPickerValues();
    applyPreviewTheme();
  }

  function updateThemeModeVisibility() {
    const preset = els.themePreset?.value;
    if (els.themeModeGroup) {
      els.themeModeGroup.hidden = preset === "system";
    }
  }

  function updateCustomColorsVisibility() {
    const preset = els.themePreset?.value;
    if (els.customColorsSection) {
      els.customColorsSection.hidden = preset !== "custom";
    }
  }

  function updateColorPickerValues() {
    const cc = state.themeSettings?.customColors || {};
    for (const { key } of THEME_VARS_DEF) {
      const inp = document.getElementById(`color_${key.slice(2)}`);
      const hexEl = document.getElementById(`hex_${key.slice(2)}`);
      if (inp) {
        const val = cc[key] || getComputedStyle(document.documentElement).getPropertyValue(key).trim();
        if (val && val.startsWith("#")) {
          inp.value = val.slice(0, 7);
          if (hexEl) hexEl.textContent = val.slice(0, 7);
        }
      }
    }
  }

  async function handleThemeChange() {
    const preset = els.themePreset?.value || "system";
    const mode = els.themeLight?.checked ? "light" : "dark";
    state.themeSettings = { ...state.themeSettings, preset, mode };
    updateThemeModeVisibility();
    updateCustomColorsVisibility();
    updateColorPickerValues();
    applyPreviewTheme();
    await storageSet({ themeSettings: state.themeSettings });
    chrome.runtime.sendMessage({ type: "THEME_CHANGED" }).catch(() => {});
  }

  function handleCustomColorChange(event) {
    const key = event.target.dataset.themeVar;
    const val = event.target.value;
    const hexEl = document.getElementById(`hex_${key.slice(2)}`);
    if (hexEl) hexEl.textContent = val;
    state.themeSettings = {
      ...state.themeSettings,
      customColors: { ...(state.themeSettings.customColors || {}), [key]: val }
    };
    // Live preview is instant; persisting to sync storage is debounced so
    // dragging the color picker doesn't blow through the ~120 writes/min quota.
    document.documentElement.style.setProperty(key, val);
    applyPreviewTheme();
    window.clearTimeout(state.customColorSaveTimer);
    state.customColorSaveTimer = window.setTimeout(() => {
      storageSet({ themeSettings: state.themeSettings }).catch(console.error);
      chrome.runtime.sendMessage({ type: "THEME_CHANGED" }).catch(() => {});
    }, 400);
  }

  async function handleResetCustomColors() {
    state.themeSettings = { ...state.themeSettings, customColors: {} };
    updateColorPickerValues();
    applyPreviewTheme();
    await storageSet({ themeSettings: state.themeSettings });
    chrome.runtime.sendMessage({ type: "THEME_CHANGED" }).catch(() => {});
  }

  function applyPreviewTheme() {
    // Apply to the preview div directly
    const preview = els.themePreview;
    if (!preview) return;
    const preset = state.themeSettings?.preset || "system";
    const mode = state.themeSettings?.mode || "dark";
    const cc = state.themeSettings?.customColors || {};

    // Set preview colors inline
    const PRESET_COLORS = {
      sigcorps: { dark: { bg:"#1a1a0f", panel:"#1e1e10", text:"#c8c49a", accent:"#5c6630", amber:"#d4a017" },
                  light: { bg:"#f0ead8", panel:"#e8e0c8", text:"#2a2810", accent:"#4a5228", amber:"#a07010" } },
      navy:     { dark: { bg:"#0a0e1a", panel:"#0f1629", text:"#c8d4e8", accent:"#3b82f6", amber:"#60a5fa" },
                  light: { bg:"#f0f4ff", panel:"#e4eaf8", text:"#0a1030", accent:"#1d4ed8", amber:"#2563eb" } },
      slate:    { dark: { bg:"#0f172a", panel:"#1e293b", text:"#e2e8f0", accent:"#38bdf8", amber:"#38bdf8" },
                  light: { bg:"#f8fafc", panel:"#f1f5f9", text:"#0f172a", accent:"#0284c7", amber:"#0284c7" } },
      highcontrast: { dark: { bg:"#000000", panel:"#0a0a0a", text:"#ffffff", accent:"#00ff88", amber:"#ffdd00" },
                      light: { bg:"#ffffff", panel:"#f0f0f0", text:"#000000", accent:"#0055cc", amber:"#884400" } },
      desert:   { dark: { bg:"#1a1208", panel:"#231a0c", text:"#e8d8b0", accent:"#c87020", amber:"#e09030" },
                  light: { bg:"#fdf6e8", panel:"#f5e8cc", text:"#2a1808", accent:"#904010", amber:"#804000" } },
    };

    let colors;
    if (preset === "custom") {
      colors = { bg: cc["--bg"], panel: cc["--panel"], text: cc["--text"], accent: cc["--accent"], amber: cc["--amber"] };
    } else if (preset === "system") {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      colors = dark
        ? { bg:"#0f172a", panel:"#1e293b", text:"#e2e8f0", accent:"#38bdf8", amber:"#38bdf8" }
        : { bg:"#f8fafc", panel:"#f1f5f9", text:"#0f172a", accent:"#0284c7", amber:"#0284c7" };
    } else {
      colors = PRESET_COLORS[preset]?.[mode] || PRESET_COLORS.slate.dark;
    }

    if (colors.bg) preview.style.background = colors.bg;
    const bar = preview.querySelector(".preview-bar");
    const pnl = preview.querySelector(".preview-panel");
    const txt = preview.querySelector(".preview-text");
    const mut = preview.querySelector(".preview-muted");
    const acc = preview.querySelector(".preview-accent");
    if (bar) bar.style.background = colors.accent || "#38bdf8";
    if (pnl) pnl.style.background = colors.panel || "#1e293b";
    if (txt) txt.style.color = colors.text || "#e2e8f0";
    if (mut) mut.style.color = colors.amber || "#38bdf8";
    if (acc) acc.style.color = colors.accent || "#38bdf8";
  }


  async function handleScreenReaderToggle() {
    const enabled = Boolean(els.screenReaderMode?.checked);
    state.screenReaderMode = enabled;
    if (els.screenReaderMode) {
      els.screenReaderMode.setAttribute("aria-checked", String(enabled));
    }
    await storageSet({ screenReaderMode: enabled });
    chrome.runtime.sendMessage({ type: "FAVORITES_CHANGED" }).catch(() => {});
    chrome.runtime.sendMessage({ type: "A11Y_CHANGED", screenReaderMode: enabled }).catch(() => {});
    setStatus(
      enabled ? "Screen reader mode enabled. Reload the panel to apply." : "Screen reader mode disabled.",
      "success",
      3000
    );
  }

})();