"use strict";

import { getSettings, isConfigured, storageSet, normalizeSchedules } from "./services/storage.js";
import { loadAndApplyTheme, applyTheme, watchThemeChanges } from "./services/theme.js";
import { totState, formatCountdown, formatHold } from "./services/tot.js";
import { computeNextSchedule, formatNextScheduleLine, diffKeyedSets } from "./services/activity.js";
import { createTape } from "./services/tape.js";
import {
  getStatus,
  getConnectedNodes,
  getVariables,
  connectNode,
  disconnectNode,
  disconnectAll,
  sendDtmf,
  getAudit,
  lookupNode,
  copIdentify,
  copTime,
  copStatus,
  copVersion,
  createEventStreamFromSettings,
  parseActiveLinks,
  getVersion,
} from "./services/api.js";

const DEFAULT_REFRESH_INTERVAL_MS = 15000;
const SLOW_POLL_INTERVAL_MS = 30000; // fallback poll when SSE is live
const AUDIT_LINES = 50;
const MAX_SSE_ERRORS = 5; // consecutive errors before giving up on SSE for this session
const TOT_TICK_MS = 250;

const state = {
  settings: null,
  favorites: [],
  connectedNodes: [],
  connectedCount: 0,
  status: null,
  variables: null,
  busy: false,
  refreshTimer: null,
  footerTimer: null,
  collapsedSections: new Set(),
  dtmfMacros: [],
  schedules: [],
  nodeCountWarning: 0,
  screenReaderMode: false,
  // SSE state
  eventStream: null,
  sseConnected: false,
  // Active transmitting links
  activeLinks: new Set(),
  // ── Display zone (v0.9) ──
  // Keyed edges are only meaningful after the first variables load; before
  // that, a true rxkeyed/txkeyed means "already keyed when the panel opened"
  // and must NOT arm timers (timer honesty: never guess an arm time).
  onAirInit: false,
  keyedRx: false,
  keyedTx: false,
  displayState: null,        // "standby" | "inbound" | "outbound" | "tot"
  inboundSince: null,        // epoch ms of observed inbound keyup, or null (unknown)
  tot: {
    armedAtMs: null,         // null while indeterminate (opened mid-keyup)
    timer: null,
    expired: false,
    lastRemain: null,        // for beep threshold-crossing detection
    warnBeeped: false,
  },
  clockTimer: null,
  inboundTimer: null,
  openPopover: null,         // { el, node }
  // ── Traffic tape (Zone 2) ──
  tape: createTape(200),
  tapeFilter: "all",
  tapeInit: false,           // adopt the first keyed set without emitting history
  prevActiveLinks: new Set(),
  remoteKeyedSince: {},       // node -> epoch ms, for keyup hold times
  tapeSeeded: false,          // /audit seeded into the tape exactly once
  tapeSaveTimer: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await loadAndApplyTheme();
  watchThemeChanges();
  chrome.storage.sync.get({ themeSettings: null }, (r) => updateModeToggleIcon(r.themeSettings));
  bindElements();
  bindEvents();
  bindMessages();

  await hydrateTape();
  renderTape();
  await loadInitialState();
  applyCollapsedSections();
  renderDtmfMacros();
  renderDisplay();
  startAutoRefresh();
  startEventStream();
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

async function startEventStream() {
  stopEventStream();

  if (!isReady()) return;

  // Probe /version first -- a wrong API key or an unreachable backend must
  // not send us into a silent, infinite SSE reconnect loop. events_enabled
  // absent means an older backend that may still support SSE; the
  // MAX_SSE_ERRORS cutoff covers that case, so only an explicit false blocks.
  try {
    const version = await getVersion();
    if (version && version.events_enabled === false) {
      setConnectionStatus("Polling (live events disabled on backend)");
      setLiveLamp("polling", "Polling");
      return;
    }
  } catch (error) {
    setConnectionStatus("Polling (backend unreachable)");
    setLiveLamp("offline", "Offline");
    if (isAuthError(error)) setFooter(error.message, "error", 0, { settingsLink: true });
    return;
  }

  try {
    const stream = await createEventStreamFromSettings();
    let sseErrorCount = 0;

    stream.on("connected", () => {
      sseErrorCount = 0;
      state.sseConnected = true;
      setConnectionStatus(`Live ● ${hostOnly(state.settings.baseUrl)}`);
      setLiveLamp("live", "Live");
      // Switch to slow fallback poll -- SSE handles live state
      stopAutoRefresh();
      startSlowPoll();
    });

    stream.on("error", () => {
      state.sseConnected = false;
      sseErrorCount += 1;
      if (sseErrorCount >= MAX_SSE_ERRORS) {
        // Give up on SSE for this session rather than reconnect forever.
        stopEventStream();
        setConnectionStatus("Live events unavailable, polling");
        setLiveLamp("polling", "Polling");
        stopSlowPoll();
        startAutoRefresh();
        return;
      }
      setConnectionStatus(`Reconnecting… ${hostOnly(state.settings.baseUrl)}`);
      setLiveLamp("polling", "Polling");
      // Fall back to normal refresh rate while SSE is down
      stopSlowPoll();
      startAutoRefresh();
    });

    stream.on("node.rxkeyed", (data) => {
      if (!state.variables) state.variables = {};
      state.variables.rxkeyed = Boolean(data.rxkeyed);
      updateOnAirState();
    });

    stream.on("node.txkeyed", (data) => {
      if (!state.variables) state.variables = {};
      state.variables.txkeyed = Boolean(data.txkeyed);
      updateOnAirState();
    });

    stream.on("node.variables.snapshot", (data) => {
      if (data.variables) {
        state.variables = data.variables;
        syncActiveLinks(parseActiveLinks(state.variables?.active_links));
        updateOnAirState();
        renderLinkBar();
      }
    });

    stream.on("link.connected", (data) => {
      const node = data?.node ? String(data.node) : "";
      pushTape({ kind: "link", node, text: `${node || "Node"} connected` });
      refreshNodesAndStatus({ silent: true });
    });

    stream.on("link.disconnected", (data) => {
      const node = data?.node ? String(data.node) : "";
      pushTape({ kind: "drop", node, text: `${node || "Node"} disconnected` });
      refreshNodesAndStatus({ silent: true });
    });

    state.eventStream = stream;
    stream.connect();
  } catch (e) {
    console.error("Failed to start event stream:", e);
  }
}

function stopEventStream() {
  if (state.eventStream) {
    state.eventStream.close();
    state.eventStream = null;
  }
  state.sseConnected = false;
}

// Slow fallback poll -- runs while SSE is live
// Keeps status/audit fresh without hammering the API
let slowPollTimer = null;

function startSlowPoll() {
  stopSlowPoll();
  slowPollTimer = window.setInterval(() => {
    refreshAll({ manual: false, silent: true });
  }, SLOW_POLL_INTERVAL_MS);
}

function stopSlowPoll() {
  if (slowPollTimer) {
    window.clearInterval(slowPollTimer);
    slowPollTimer = null;
  }
}

// Lightweight refresh -- nodes + status only, no full refreshAll
async function refreshNodesAndStatus({ silent = false } = {}) {
  if (!isReady()) return;
  try {
    const [statusResult, nodesResult] = await Promise.allSettled([
      getStatus(),
      getConnectedNodes(),
    ]);

    if (statusResult.status === "fulfilled") {
      state.status = normalizeStatus(statusResult.value);
    }
    if (nodesResult.status === "fulfilled") {
      const normalized = normalizeNodesResponse(nodesResult.value);
      state.connectedNodes = normalized.connectedNodes;
      state.connectedCount = normalized.count;
      renderLinkBar();
    }
    renderBezelAndStats();
    refreshFavoritesStatus();
    updateControlAvailability();
  } catch (e) {
    if (!silent) console.error("refreshNodesAndStatus failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Element binding
// ---------------------------------------------------------------------------

function bindElements() {
  els.connectionStatus = requireElement("connectionStatus");
  els.openSettings = requireElement("openSettings");
  els.toggleMode = requireElement("toggleMode");

  // Bezel
  els.bezelNode = requireElement("bezelNode");
  els.bezelCallsign = requireElement("bezelCallsign");
  els.liveLamp = requireElement("liveLamp");
  els.liveLampText = requireElement("liveLampText");

  // Glass display
  els.glass = requireElement("glass");
  els.glassLamp = requireElement("glassLamp");
  els.glassWord = requireElement("glassWord");
  els.glassMode = requireElement("glassMode");
  els.glassClock = requireElement("glassClock");
  els.clockTime = requireElement("clockTime");
  els.clockWatch = requireElement("clockWatch");
  els.glassInbound = requireElement("glassInbound");
  els.inboundCall = requireElement("inboundCall");
  els.inboundNode = requireElement("inboundNode");
  els.inboundVia = requireElement("inboundVia");
  els.inboundTimer = requireElement("inboundTimer");
  els.glassOutbound = requireElement("glassOutbound");
  els.outboundCall = requireElement("outboundCall");
  els.outboundSub = requireElement("outboundSub");
  els.outboundTotLabel = requireElement("outboundTotLabel");
  els.totRing = requireElement("totRing");
  els.totRingTime = requireElement("totRingTime");
  els.duplexNote = requireElement("duplexNote");

  // Link bar + micro stats
  els.linkBar = requireElement("linkBar");
  els.disconnectAll = requireElement("disconnectAll");
  els.statLinks = requireElement("statLinks");
  els.statKeyups = requireElement("statKeyups");
  els.statTxDay = requireElement("statTxDay");
  els.statUptime = requireElement("statUptime");
  els.nodeCountWarningBadge = requireElement("nodeCountWarningBadge");

  // Traffic tape (Zone 2)
  els.tape = requireElement("tape");
  els.tapeFilters = document.querySelector(".tape-filters");

  // Legacy sections (migrate in later zones)
  els.nodeLookupResult = requireElement("nodeLookupResult");
  els.dtmfMacrosGrid = requireElement("dtmfMacrosGrid");
  els.srAnnouncer = requireElement("srAnnouncer");
  els.srAnnouncerAssertive = requireElement("srAnnouncerAssertive");
  els.copIdentify = requireElement("copIdentify");
  els.copTime = requireElement("copTime");
  els.copStatus = requireElement("copStatus");
  els.copVersion = requireElement("copVersion");

  els.connectForm = requireElement("connectForm");
  els.connectNodeInput = requireElement("connectNodeInput");
  els.connectTransceive = requireElement("connectTransceive");
  els.connectMonitor = requireElement("connectMonitor");

  els.favoritesList = requireElement("favoritesList");
  els.refreshFavorites = requireElement("refreshFavorites");

  els.busyMessage = requireElement("busyMessage");
  els.busyText = requireElement("busyText");

  els.dtmfForm = requireElement("dtmfForm");
  els.dtmfInput = requireElement("dtmfInput");
  els.sendDtmf = requireElement("sendDtmf");

  els.footerMessage = requireElement("footerMessage");
}

function bindEvents() {
  els.openSettings.addEventListener("click", handleOpenSettings);

  // The live lamp doubles as the manual refresh / SSE retry control (the
  // v0.8 Refresh button relocated here).
  els.liveLamp.addEventListener("click", () => refreshAll({ manual: true }));

  els.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleConnectFromInput(false);
  });

  els.connectMonitor.addEventListener("click", () => {
    handleConnectFromInput(true);
  });

  els.refreshFavorites.addEventListener("click", handleRefreshFavorites);
  if (els.tapeFilters) els.tapeFilters.addEventListener("click", handleTapeFilter);

  els.favoritesList.addEventListener("click", handleFavoritesClick);
  els.disconnectAll.addEventListener("click", handleDisconnectAll);
  els.linkBar.addEventListener("click", handleLinkBarClick);

  els.dtmfForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSendDtmf();
  });

  els.copIdentify.addEventListener("click", () => handleCop("identify"));
  els.copTime.addEventListener("click", () => handleCop("time"));
  els.copStatus.addEventListener("click", () => handleCop("status"));
  els.copVersion.addEventListener("click", () => handleCop("version"));

  els.connectNodeInput.addEventListener("input", handleNodeLookupInput);
  els.toggleMode.addEventListener("click", handleToggleMode);

  document.querySelectorAll(".section-toggle").forEach((btn) => {
    btn.addEventListener("click", handleSectionToggle);
  });

  // Popover dismissal: Escape and outside-click
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.openPopover) {
      closePopover({ restoreFocus: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (!state.openPopover) return;
    const { el } = state.openPopover;
    if (el.contains(event.target)) return;
    if (event.target.closest(".chip")) return; // chip clicks manage their own popover
    closePopover({ restoreFocus: false });
  });
}

function bindMessages() {
  if (typeof chrome !== "undefined" && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "A11Y_CHANGED") {
        state.screenReaderMode = Boolean(message.screenReaderMode);
        applyAccessibilityMode();
        if (state.screenReaderMode) announce("Screen reader mode enabled.", "polite");
        return;
      }
      if (message?.type === "THEME_CHANGED") {
        chrome.storage.sync.get({ themeSettings: null }, (result) => {
          applyTheme(result.themeSettings);
          updateModeToggleIcon(result.themeSettings);
        });
        return;
      }
      if (message?.type === "SETTINGS_CHANGED") {
        handleRefreshFavorites();
        loadSettingsIntoState().then(() => {
          renderDtmfMacros();
          renderDisplay();
          applyAccessibilityMode();
        }).catch(console.error);
        return;
      }
      if (message?.type === "SCHEDULE_FIRED") {
        const label = describeScheduleAction(message.schedule);
        pushTape({ kind: "sched", text: message.ok ? `${label} fired ok` : `${label} failed: ${message.error}` });
        if (message.ok) {
          setFooter(`Schedule: ${label} fired.`, "success", 4000);
        } else {
          setFooter(`Schedule failed: ${label} (${message.error})`, "error");
        }
        refreshAll({ manual: false, force: true, silent: true });
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.screenReaderMode !== undefined) {
        state.screenReaderMode = Boolean(changes.screenReaderMode.newValue);
        applyAccessibilityMode();
        if (state.screenReaderMode) announce("Screen reader mode enabled.", "polite");
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------

async function loadInitialState() {
  try {
    await loadSettingsIntoState();
    renderFavorites();
    updateControlAvailability();

    if (!isReady()) {
      clearBezelAndStats();
      renderTape();
      setConnectionStatus("Not configured");
      setLiveLamp("offline", "Offline");
      setFooter("Open settings to add your ASL Agent base URL and API key.", "warning", 0, { settingsLink: true });
      return;
    }

    await refreshAll({ manual: false });
  } catch (error) {
    console.error(error);
    setConnectionStatus("Error");
    setLiveLamp("offline", "Offline");
    setFooter(error.message, "error", 0, { settingsLink: isAuthError(error) });
    updateControlAvailability();
  }
}

async function loadSettingsIntoState() {
  const settings = await getSettings();

  state.settings = settings;
  state.favorites = Array.isArray(settings.favorites) ? settings.favorites : [];
  state.collapsedSections = new Set(
    Array.isArray(settings.collapsedSections) ? settings.collapsedSections : []
  );
  state.dtmfMacros = Array.isArray(settings.dtmfMacros) ? settings.dtmfMacros : [];
  state.schedules = normalizeSchedules(Array.isArray(settings.schedules) ? settings.schedules : []);
  state.nodeCountWarning = Number(settings.nodeCountWarning) || 0;
  state.screenReaderMode = Boolean(settings.screenReaderMode);
  applyAccessibilityMode();
}

// ---------------------------------------------------------------------------
// Refresh logic
// ---------------------------------------------------------------------------

async function handleRefreshFavorites() {
  try {
    await loadSettingsIntoState();
    renderFavorites();
    updateControlAvailability();
    setFooter("Favorites refreshed from settings.", "success", 2000);
  } catch (error) {
    console.error(error);
    setFooter(`Failed to refresh favorites: ${error.message}`, "error");
  }
}

async function refreshAll(options = {}) {
  const { manual = false, force = false, silent = false } = options;

  if (state.busy && !force) return;

  if (!isReady()) {
    clearBezelAndStats();
    renderTape();
    setConnectionStatus("Not configured");
    setLiveLamp("offline", "Offline");
    updateControlAvailability();
    return;
  }

  if (!silent) setConnectionStatus("Refreshing…");

  // A manual refresh is also the user's cue to retry live events if SSE
  // isn't currently connected (e.g. it gave up earlier, or the backend was
  // down and is back now). Fire-and-forget -- it manages its own status text.
  if (manual && !state.sseConnected) {
    startEventStream();
  }

  const [statusResult, nodesResult, variablesResult, auditResult] = await Promise.allSettled([
    getStatus(),
    getConnectedNodes(),
    getVariables(),
    getAudit(AUDIT_LINES)
  ]);

  let hadError = false;
  let authError = false;

  if (statusResult.status === "fulfilled") {
    state.status = normalizeStatus(statusResult.value);
  } else {
    hadError = true;
    if (isAuthError(statusResult.reason)) authError = true;
    console.error(statusResult.reason);
  }

  if (nodesResult.status === "fulfilled") {
    const normalizedNodes = normalizeNodesResponse(nodesResult.value);
    state.connectedNodes = normalizedNodes.connectedNodes;
    state.connectedCount = normalizedNodes.count;
    renderLinkBar();
  } else {
    hadError = true;
    if (isAuthError(nodesResult.reason)) authError = true;
    console.error(nodesResult.reason);
  }

  if (variablesResult.status === "fulfilled") {
    state.variables = variablesResult.value;
    syncActiveLinks(parseActiveLinks(state.variables?.active_links));
    updateOnAirState();
    renderLinkBar();
  } else {
    if (isAuthError(variablesResult.reason)) authError = true;
    console.error(variablesResult.reason);
  }

  // The tape is seeded from /audit once for pre-panel-open history; live
  // events append on top after that. seedFromAudit de-dupes, so a missed
  // first seed just fills in on the next successful poll.
  if (auditResult.status === "fulfilled") {
    if (!state.tapeSeeded) {
      state.tape.seedFromAudit(auditResult.value?.entries);
      state.tapeSeeded = true;
      renderTape();
      scheduleTapeSave();
    }
  } else {
    hadError = true;
    if (isAuthError(auditResult.reason)) authError = true;
    console.error(auditResult.reason);
  }

  renderBezelAndStats();
  refreshFavoritesStatus();

  if (hadError) {
    setConnectionStatus("Refresh error");
    setLiveLamp("offline", "Offline");
    if (!silent) setFooter("One or more ASL Agent requests failed.", "error", 0, { settingsLink: authError });
  } else {
    // Show live indicator if SSE is connected, otherwise just the host
    if (state.sseConnected) {
      setConnectionStatus(`Live ● ${hostOnly(state.settings.baseUrl)}`);
      setLiveLamp("live", "Live");
    } else {
      setConnectionStatus(`Connected to ${hostOnly(state.settings.baseUrl)}`);
      setLiveLamp("polling", "Polling");
    }
    if (manual && !silent) setFooter("Status refreshed.", "success", 2000);
  }

  updateControlAvailability();
}


// ---------------------------------------------------------------------------
// On-air state machine (Display zone)
//
// Direction semantics on the operator's OWN node (verified against app_rpt):
//   rxkeyed = the node's receiver hears a local signal = the OPERATOR is
//             talking OUT to the network  -> OUTBOUND (arms the TOT).
//   txkeyed = the node's transmitter is keyed = remote audio coming IN
//             -> INBOUND (talker resolved from the ALINKS keyed set).
// If both are true (full duplex), OUTBOUND wins the main readout because the
// TOT is safety-relevant; a small "+ inbound" note shows beside it.
// ---------------------------------------------------------------------------

function updateOnAirState() {
  const rx = Boolean(state.variables?.rxkeyed);
  const tx = Boolean(state.variables?.txkeyed);

  if (!state.onAirInit) {
    // First variables load: any already-true keyed state has an unknown
    // start time. Show indeterminate timers; never guess.
    state.onAirInit = true;
    if (rx) armTot(null);
    if (tx) state.inboundSince = null;
    state.keyedRx = rx;
    state.keyedTx = tx;
    renderDisplay();
    return;
  }

  if (rx && !state.keyedRx) { armTot(Date.now()); pushOutStart(); }  // keyup: (re-)arm + log
  if (!rx && state.keyedRx) { finalizeOut(); disarmTot(); }          // unkey: log then clear
  if (tx && !state.keyedTx) state.inboundSince = Date.now();
  if (!tx && state.keyedTx) {
    state.inboundSince = null;
    if (state.settings?.keyupBeep) beep(660, 80);      // courtesy beep on remote unkey
  }

  state.keyedRx = rx;
  state.keyedTx = tx;
  renderDisplay();
}

function computeDisplayState() {
  if (state.keyedRx) return state.tot.expired ? "tot" : "outbound";
  if (state.keyedTx) return "inbound";
  return "standby";
}

const DISPLAY_WORDS = {
  standby:  ["Standby", "Monitoring"],
  inbound:  ["On Air", "Inbound"],
  outbound: ["On Air", "Outbound · You"],
  tot:      ["Time-Out", "Outbound · You"],
};

function renderDisplay() {
  const displayState = computeDisplayState();
  const changed = displayState !== state.displayState;
  state.displayState = displayState;

  els.glass.dataset.state = displayState;
  els.glassWord.textContent = DISPLAY_WORDS[displayState][0];
  els.glassMode.textContent = DISPLAY_WORDS[displayState][1];

  // Raw node-centric state for operators who think in app_rpt terms.
  els.glass.title =
    `node RX keyed: ${state.keyedRx ? "yes" : "no"} · node TX keyed: ${state.keyedTx ? "yes" : "no"}`;

  els.glassClock.hidden = displayState !== "standby";
  els.glassInbound.hidden = displayState !== "inbound";
  els.glassOutbound.hidden = displayState !== "outbound" && displayState !== "tot";
  els.duplexNote.hidden = !(state.keyedRx && state.keyedTx);

  if (displayState === "standby") {
    startClock();
    renderWatchLine();
  } else {
    stopClock();
  }

  if (displayState === "inbound") {
    renderInbound();
    startInboundTimer();
  } else {
    stopInboundTimer();
  }

  if (displayState === "outbound" || displayState === "tot") {
    renderOutbound();
  }

  if (changed) {
    announceDisplayState(displayState);
  }
}

function announceDisplayState(displayState) {
  if (displayState === "tot") {
    announce("Transmit time-out reached. Unkey.", "assertive");
    return;
  }
  if (displayState === "outbound") {
    announce("On air: outbound. Timeout timer armed.", "polite");
    return;
  }
  if (displayState === "inbound") {
    const talker = resolveTalker();
    announce(`On air: inbound${talker ? ` from ${talker.callsign || talker.node}` : ""}.`, "polite");
    return;
  }
  announce("Standby.", "polite");
}

// ── Inbound readout ──────────────────────────────────────────────────────────

function resolveTalker() {
  for (const node of state.activeLinks) {
    const match = state.connectedNodes.find((n) => n.node === node);
    return match || { node, callsign: "", info: "", location: "" };
  }
  return null;
}

function renderInbound() {
  const talker = resolveTalker();
  if (talker) {
    els.inboundCall.textContent = talker.callsign || talker.node;
    els.inboundNode.textContent = talker.callsign ? talker.node : "";
    const via = talker.info || talker.location || "";
    els.inboundVia.textContent = via ? `${via} · inbound` : "inbound";
  } else {
    els.inboundCall.textContent = "REMOTE";
    els.inboundNode.textContent = "";
    els.inboundVia.textContent = "inbound";
  }
  renderInboundTimer();
}

function renderInboundTimer() {
  if (state.inboundSince == null) {
    els.inboundTimer.textContent = "--:--";
    return;
  }
  els.inboundTimer.textContent = formatCountdown((Date.now() - state.inboundSince) / 1000);
}

function startInboundTimer() {
  if (state.inboundTimer) return;
  renderInboundTimer();
  state.inboundTimer = window.setInterval(renderInboundTimer, 1000);
}

function stopInboundTimer() {
  if (state.inboundTimer) {
    window.clearInterval(state.inboundTimer);
    state.inboundTimer = null;
  }
}

// ── Outbound readout + TOT engine ───────────────────────────────────────────

function totSeconds() {
  return Number(state.settings?.totSeconds ?? 180);
}

function armTot(armedAtMs) {
  stopTotTimer();
  state.tot.armedAtMs = armedAtMs;
  state.tot.expired = false;
  state.tot.lastRemain = null;
  state.tot.warnBeeped = false;
  // The 250ms tick only runs while outbound with a known arm time; the
  // indeterminate ring (unknown arm time) and the off state are static.
  if (armedAtMs != null && totSeconds() > 0) {
    state.tot.timer = window.setInterval(totTick, TOT_TICK_MS);
  }
}

function disarmTot() {
  stopTotTimer();
  state.tot.armedAtMs = null;
  state.tot.expired = false;
  state.tot.lastRemain = null;
  state.tot.warnBeeped = false;
}

function stopTotTimer() {
  if (state.tot.timer) {
    window.clearInterval(state.tot.timer);
    state.tot.timer = null;
  }
}

function totTick() {
  const { remain, phase } = totState(state.tot.armedAtMs, Date.now(), totSeconds());
  renderTotRing(remain, phase);

  if (state.settings?.totBeep) {
    const last = state.tot.lastRemain;
    // One beep at 60s remaining.
    if (!state.tot.warnBeeped && remain <= 60 && (last == null || last > 60)) {
      state.tot.warnBeeped = true;
      beep(880, 150);
    }
    // One per second for the last 5.
    if (remain > 0 && remain <= 5 && last != null && Math.ceil(remain) !== Math.ceil(last)) {
      beep(1200, 70);
    }
  }
  state.tot.lastRemain = remain;

  if (phase === "expired" && !state.tot.expired) {
    state.tot.expired = true;
    stopTotTimer(); // CSS carries the alarm pulse; nothing left to count
    pushTape({
      kind: "tot", node: "__local__",
      text: `${state.status?.callsign || "You"} timeout reached · ${formatCountdown(totSeconds())}`
    });
    if (state.settings?.totBeep) {
      beep(1400, 120);
      window.setTimeout(() => beep(1400, 120), 200);
      window.setTimeout(() => beep(1400, 260), 400);
    }
    renderDisplay(); // flips the readout to the TIME-OUT alarm state
  }
}

function renderOutbound() {
  const callsign = state.status?.callsign || "—";
  els.outboundCall.textContent = callsign;
  els.outboundSub.textContent = `You · outbound to ${state.connectedCount} link${state.connectedCount === 1 ? "" : "s"}`;

  const seconds = totSeconds();
  if (seconds <= 0) {
    els.totRing.hidden = true;
    els.outboundTotLabel.textContent = "TOT off";
    return;
  }
  els.totRing.hidden = false;

  const { remain, phase } = totState(state.tot.armedAtMs, Date.now(), seconds);
  renderTotRing(remain, phase);

  if (phase === "indeterminate") {
    els.outboundTotLabel.textContent = "TOT · arm time unknown";
  } else {
    els.outboundTotLabel.textContent = `TOT · re-keys reset to ${formatCountdown(seconds)}`;
  }
}

function renderTotRing(remain, phase) {
  const seconds = totSeconds();
  if (phase === "indeterminate") {
    els.totRing.dataset.phase = "indeterminate";
    els.totRing.style.setProperty("--tot-pct", "1");
    els.totRingTime.textContent = "--:--";
    els.totRing.title = "Panel opened mid-keyup; timer arms on your next keyup";
    return;
  }
  els.totRing.dataset.phase = phase;
  els.totRing.style.setProperty("--tot-pct", String(seconds > 0 ? remain / seconds : 0));
  els.totRingTime.textContent = phase === "expired" ? "TOT" : formatCountdown(remain);
  els.totRing.title = `Timeout timer: ${formatCountdown(remain)} remaining of ${formatCountdown(seconds)}`;
}

// ---------------------------------------------------------------------------
// Traffic tape (Zone 2) -- one chronological event stream. The tape module
// (services/tape.js) holds the data; this layer feeds it, renders it, and
// persists it to session storage so a panel reload mid-net keeps history.
// ---------------------------------------------------------------------------

const TAPE_TAGS = {
  key: "Key", out: "You", link: "Link", drop: "Drop",
  dtmf: "DTMF", cop: "COP", sched: "Sched", sys: "Sys", tot: "TOT",
};

// Diff the keyed set against the previous one, logging remote keyups/unkeys.
// The first call adopts the current set without emitting rows (timer honesty:
// a node already keyed when the panel opens has an unknown hold time).
function syncActiveLinks(nextSet) {
  const next = nextSet instanceof Set ? nextSet : new Set(nextSet || []);

  if (!state.tapeInit) {
    state.tapeInit = true;
    state.prevActiveLinks = next;
    state.activeLinks = next;
    return;
  }

  const { newlyKeyed, newlyUnkeyed } = diffKeyedSets(state.prevActiveLinks, next);
  const now = Date.now();
  let changed = false;

  for (const node of newlyKeyed) {
    state.remoteKeyedSince[node] = now;
    const callsign = talkerCallsign(node);
    state.tape.push({ ts: now, kind: "key", node, callsign, live: true, text: keyRowText(node, callsign) });
    changed = true;
  }
  for (const node of newlyUnkeyed) {
    const since = state.remoteKeyedSince[node];
    const holdMs = since ? now - since : undefined;
    delete state.remoteKeyedSince[node];
    const callsign = talkerCallsign(node);
    const held = holdMs != null ? ` · ${formatHold(holdMs)}` : "";
    state.tape.finalize("key", node, { ts: now, holdMs, text: `${keyRowText(node, callsign, false)}${held}` });
    changed = true;
  }

  state.prevActiveLinks = next;
  state.activeLinks = next;
  if (changed) { renderTape(); scheduleTapeSave(); }
}

function talkerCallsign(node) {
  return state.connectedNodes.find((n) => n.node === node)?.callsign || "";
}

function keyRowText(node, callsign, keyedSuffix = true) {
  const who = callsign ? `${callsign} ${node}` : node;
  return keyedSuffix ? `${who} · keyed` : who;
}

// Operator's own transmission (rxkeyed) start/finish rows.
function pushOutStart() {
  const call = state.status?.callsign || "You";
  state.tape.push({ ts: Date.now(), kind: "out", node: "__local__", callsign: call, live: true, text: `${call} outbound · TOT armed` });
  renderTape();
  scheduleTapeSave();
}

function finalizeOut() {
  const call = state.status?.callsign || "You";
  const holdMs = state.tot.armedAtMs ? Date.now() - state.tot.armedAtMs : undefined;
  const held = holdMs != null ? ` · ${formatHold(holdMs)}` : "";
  const outcome = state.tot.expired ? " · TIMED OUT" : " · TOT ok";
  state.tape.finalize("out", "__local__", { ts: Date.now(), holdMs, text: `${call} outbound${held}${outcome}` });
  renderTape();
  scheduleTapeSave();
}

function pushTape(entry) {
  state.tape.push(entry);
  renderTape();
  scheduleTapeSave();
}

function renderTape() {
  if (!els.tape) return;
  const rows = state.tape.list(state.tapeFilter);
  const scrollTop = els.tape.scrollTop;
  els.tape.replaceChildren();

  if (!rows.length) {
    els.tape.appendChild(createEmptyState("No traffic yet."));
    return;
  }

  for (const entry of rows) {
    const row = document.createElement("div");
    row.className = entry.live ? "t-row live" : "t-row";
    row.dataset.k = entry.kind;

    const time = document.createElement("span");
    time.className = "t-time";
    time.textContent = entry.live ? "now" : tapeTime(entry.ts);

    const tag = document.createElement("span");
    tag.className = "t-tag";
    tag.textContent = TAPE_TAGS[entry.kind] || entry.kind;

    const text = document.createElement("span");
    text.className = "t-text";
    text.textContent = entry.text;

    row.append(time, tag, text);
    els.tape.appendChild(row);
  }
  els.tape.scrollTop = scrollTop;
}

function tapeTime(ts) {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function handleTapeFilter(event) {
  const btn = event.target.closest(".tf");
  if (!btn) return;
  state.tapeFilter = btn.dataset.filter || "all";
  els.tapeFilters.querySelectorAll(".tf").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  renderTape();
}

// Persist the newest entries to session storage (survives a panel reload
// within the browser session, does not roam, does not burn sync quota).
function scheduleTapeSave() {
  if (state.tapeSaveTimer) return;
  state.tapeSaveTimer = window.setTimeout(async () => {
    state.tapeSaveTimer = null;
    // Strip the live flag so a row that was mid-keyup at save time does not
    // reload as a permanently "now" row after a panel reload.
    const snapshot = state.tape.toJSON().map((entry) => ({ ...entry, live: false }));
    try { await chrome.storage.session.set({ tapeEntries: snapshot }); } catch { /* non-critical */ }
  }, 1000);
}

async function hydrateTape() {
  try {
    const result = await chrome.storage.session.get({ tapeEntries: null });
    if (Array.isArray(result.tapeEntries)) state.tape.hydrate(result.tapeEntries);
  } catch { /* non-critical */ }
}

// ── Standby clock + watch line ──────────────────────────────────────────────

function renderClock() {
  const d = new Date();
  els.clockTime.textContent =
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function startClock() {
  if (state.clockTimer) return;
  renderClock();
  state.clockTimer = window.setInterval(renderClock, 1000);
}

function stopClock() {
  if (state.clockTimer) {
    window.clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderWatchLine() {
  const weekday = DAY_NAMES[new Date().getUTCDay()];
  const next = computeNextSchedule(state.schedules, new Date());
  const nextText = formatNextScheduleLine(next);
  els.clockWatch.textContent = nextText
    ? `${weekday} · Net watch · ${nextText}`
    : `${weekday} · Net watch`;
}

// ---------------------------------------------------------------------------
// Bezel + micro stats render
// ---------------------------------------------------------------------------

function renderBezelAndStats() {
  const status = state.status || {};

  els.bezelNode.textContent = status.node ? `ASL ${status.node}` : "ASL —";
  els.bezelCallsign.textContent = status.callsign || "";
  // Full base URL lives in the tooltip only.
  if (state.settings?.baseUrl) {
    els.bezelNode.title = state.settings.baseUrl;
  } else {
    els.bezelNode.removeAttribute("title");
  }

  els.statLinks.textContent = String(state.connectedCount);
  els.statKeyups.textContent = valueOrDash(status.keyups_today);
  els.statTxDay.textContent = valueOrDash(status.tx_time_today);
  els.statUptime.textContent = valueOrDash(status.uptime);
  renderNodeCountWarning();
}

function clearBezelAndStats() {
  els.bezelNode.textContent = "ASL —";
  els.bezelCallsign.textContent = "";
  els.statLinks.textContent = "—";
  els.statKeyups.textContent = "—";
  els.statTxDay.textContent = "—";
  els.statUptime.textContent = "—";
  els.nodeCountWarningBadge.hidden = true;
  renderLinkBar();
}

function renderNodeCountWarning() {
  const threshold = state.nodeCountWarning;
  const count = state.connectedCount;
  const over = threshold > 0 && count >= threshold;
  els.nodeCountWarningBadge.hidden = !over;
  if (over) els.nodeCountWarningBadge.textContent = `⚠ ${count}`;
}

function setLiveLamp(kind, text) {
  els.liveLamp.dataset.kind = kind;
  els.liveLampText.textContent = text;
}

// ---------------------------------------------------------------------------
// Link bar (chips) + popover
// Replaces the v0.8 Connected Nodes list; per-node disconnect lives in the
// chip popover now.
// ---------------------------------------------------------------------------

function renderLinkBar() {
  const nodes = isReady() ? state.connectedNodes : [];

  els.linkBar.replaceChildren();

  if (!nodes.length) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = isReady() ? "No links" : "Not configured";
    els.linkBar.appendChild(empty);
  }

  for (const connectedNode of nodes) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (connectedNode.mode === "R") chip.classList.add("mon");
    if (state.activeLinks.has(connectedNode.node)) chip.classList.add("keyed");
    chip.dataset.node = connectedNode.node;
    chip.setAttribute("aria-haspopup", "dialog");
    chip.setAttribute("aria-label",
      `Node ${connectedNode.node}${connectedNode.callsign ? `, ${connectedNode.callsign}` : ""}` +
      `${connectedNode.mode === "R" ? ", monitor mode" : ""}` +
      `${state.activeLinks.has(connectedNode.node) ? ", keyed" : ""}`);

    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = connectedNode.callsign || connectedNode.node;

    chip.append(dot, label);
    els.linkBar.appendChild(chip);
  }

  // If a popover is open for a node that dropped, close it.
  if (state.openPopover && !nodes.some((n) => n.node === state.openPopover.node)) {
    closePopover({ restoreFocus: false });
  }

  // If the inbound talker readout is showing, its identity may have just
  // been enriched by this refresh.
  if (state.displayState === "inbound") renderInbound();
}

function handleLinkBarClick(event) {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  const node = chip.dataset.node;
  if (state.openPopover?.node === node) {
    closePopover({ restoreFocus: true });
    return;
  }
  openPopover(chip, node);
}

function openPopover(chip, node) {
  closePopover({ restoreFocus: false });

  const connectedNode = state.connectedNodes.find((n) => n.node === node);
  if (!connectedNode) return;

  const popover = document.createElement("div");
  popover.className = "chip-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `Node ${connectedNode.node}`);
  popover.tabIndex = -1;

  const title = document.createElement("div");
  title.className = "chip-popover-title";
  title.textContent = connectedNode.callsign
    ? `${connectedNode.callsign} · ${connectedNode.node}`
    : connectedNode.node;
  popover.appendChild(title);

  const modeLine = document.createElement("div");
  modeLine.className = "chip-popover-line";
  modeLine.textContent = getModeLabel(connectedNode.mode);
  popover.appendChild(modeLine);

  if (connectedNode.info) {
    const infoLine = document.createElement("div");
    infoLine.className = "chip-popover-line";
    infoLine.textContent = connectedNode.info;
    popover.appendChild(infoLine);
  }

  if (connectedNode.location) {
    const locLine = document.createElement("div");
    locLine.className = "chip-popover-line";
    locLine.textContent = connectedNode.location;
    popover.appendChild(locLine);
  }

  const actions = document.createElement("div");
  actions.className = "chip-popover-actions";
  const discBtn = document.createElement("button");
  discBtn.type = "button";
  discBtn.className = "small danger";
  discBtn.textContent = "Disconnect";
  discBtn.setAttribute("aria-label", `Disconnect node ${connectedNode.node}`);
  discBtn.addEventListener("click", () => {
    closePopover({ restoreFocus: false });
    runTimedOperation({
      busyText: `Disconnecting ${node}…`,
      action: async () => { await disconnectNode(node); },
      successMessage: `Disconnect request sent for node ${node}.`
    });
  });
  actions.appendChild(discBtn);
  popover.appendChild(actions);

  document.body.appendChild(popover);

  // Position under the chip, clamped to the viewport.
  const rect = chip.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - popRect.width - 8);
  }
  let top = rect.bottom + 6;
  if (top + popRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - popRect.height - 6);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  state.openPopover = { el: popover, node };
  popover.focus();
}

function closePopover({ restoreFocus }) {
  if (!state.openPopover) return;
  const { el, node } = state.openPopover;
  state.openPopover = null;
  el.remove();
  if (restoreFocus) {
    const chip = els.linkBar.querySelector(`.chip[data-node="${CSS.escape(node)}"]`);
    if (chip) chip.focus();
  }
}

// ---------------------------------------------------------------------------
// Favorites (relocates into the Memories drawer in the Dock zone)
// ---------------------------------------------------------------------------

function renderFavorites() {
  els.favoritesList.replaceChildren();

  if (!state.favorites.length) {
    els.favoritesList.appendChild(createEmptyState("No favorites configured."));
    return;
  }

  for (const favorite of state.favorites) {
    const item = document.createElement("div");
    item.className = "favorite-item";

    const node = document.createElement("div");
    node.className = "node-number";
    node.textContent = favorite.node;

    const label = document.createElement("div");
    label.className = "node-label";
    label.textContent = favorite.label || favorite.node;
    label.title = favorite.label || favorite.node;

    const actions = document.createElement("div");
    actions.className = "favorite-actions";

    const connectT = document.createElement("button");
    connectT.type = "button";
    connectT.textContent = "Connect T";
    connectT.dataset.favoriteNode = favorite.node;
    connectT.dataset.favoriteMode = "transceive";

    const connectR = document.createElement("button");
    connectR.type = "button";
    connectR.className = "secondary";
    connectR.textContent = "Monitor R";
    connectR.dataset.favoriteNode = favorite.node;
    connectR.dataset.favoriteMode = "monitor";

    actions.append(connectT, connectR);
    item.dataset.favoriteNode = favorite.node;
    item.append(node, label, actions);
    els.favoritesList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeStatus(payload) {
  return {
    node: String(payload?.node || ""),
    callsign: String(payload?.callsign || ""),
    keyups_today: String(payload?.keyups_today ?? ""),
    uptime: payload?.uptime?.display || payload?.uptime?.raw || "",
    tx_time_today: payload?.tx_time_today?.display || payload?.tx_time_today?.raw || "",
    tx_time_total: payload?.tx_time_total?.display || payload?.tx_time_total?.raw || ""
  };
}

function normalizeNodesResponse(payload) {
  const rawNodes = Array.isArray(payload?.connected_nodes) ? payload.connected_nodes : [];
  const connectedNodes = rawNodes.map(normalizeConnectedNode).filter(Boolean).sort(compareNodeIdentifiers);
  const apiCount = Number(payload?.count);
  return {
    connectedNodes,
    count: Number.isInteger(apiCount) && apiCount >= 0 ? apiCount : connectedNodes.length
  };
}

function normalizeConnectedNode(value) {
  const node     = String(value?.node || "").trim().toUpperCase();
  const mode     = String(value?.mode || "").trim().toUpperCase();
  const info     = String(value?.info || "").trim();
  const callsign = String(value?.callsign || "").trim();
  const location = String(value?.location || "").trim();
  if (!isValidNodeIdentifier(node)) return null;
  return { node, mode: mode === "R" ? "R" : "T", info, callsign, location };
}

function isValidNodeIdentifier(value) {
  const identifier = String(value || "").trim().toUpperCase();
  if (!identifier) return false;
  const isNumericNode = /^\d+$/.test(identifier);
  const isCallsign = /^[A-Z]{1,3}\d[A-Z0-9]{1,4}$/.test(identifier);
  return isNumericNode || isCallsign;
}

function compareNodeIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a.node);
  const bNumeric = /^\d+$/.test(b.node);
  if (aNumeric && bNumeric) return Number(a.node) - Number(b.node);
  if (aNumeric && !bNumeric) return -1;
  if (!aNumeric && bNumeric) return 1;
  return a.node.localeCompare(b.node);
}

function getModeLabel(mode) {
  return mode === "R" ? "Receive / monitor-only" : "Transceive";
}

function createEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function handleOpenSettings() {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.openOptionsPage === "function") {
    chrome.runtime.openOptionsPage();
    return;
  }
  window.open("options.html", "_blank", "noopener");
}

function handleConnectFromInput(monitorOnly) {
  const node = els.connectNodeInput.value.trim();
  runTimedOperation({
    busyText: monitorOnly ? `Connecting to ${node} in monitor-only mode…` : `Connecting to ${node} in transceive mode…`,
    action: async () => {
      await connectNode(node, { monitorOnly });
      els.connectNodeInput.value = "";
    },
    successMessage: monitorOnly ? `Monitor-only connect request sent for node ${node}.` : `Transceive connect request sent for node ${node}.`
  });
}

function handleFavoritesClick(event) {
  const button = event.target.closest("[data-favorite-node][data-favorite-mode]");
  if (!button) return;
  const node = button.dataset.favoriteNode;
  const monitorOnly = button.dataset.favoriteMode === "monitor";
  runTimedOperation({
    busyText: monitorOnly ? `Connecting favorite ${node} in monitor-only mode…` : `Connecting favorite ${node} in transceive mode…`,
    action: async () => {
      await connectNode(node, { monitorOnly });
    },
    successMessage: monitorOnly ? `Monitor-only connect request sent for favorite ${node}.` : `Transceive connect request sent for favorite ${node}.`
  });
}

function handleDisconnectAll() {
  const confirmed = window.confirm("Disconnect all currently connected nodes?");
  if (!confirmed) return;
  runTimedOperation({
    busyText: "Disconnecting all nodes…",
    action: async () => {
      await disconnectAll();
    },
    successMessage: "Disconnect-all request sent.",
    postDelayMs: 3000
  });
}

function handleSendDtmf() {
  const sequence = els.dtmfInput.value.trim();
  runImmediateOperation({
    busyText: `Sending DTMF ${sequence}…`,
    action: async () => {
      await sendDtmf(sequence, { confirmed: true });
      pushTape({ kind: "dtmf", text: `${sequence} sent` });
      els.dtmfInput.value = "";
    },
    successMessage: `DTMF sequence ${sequence} sent.`
  });
}

async function runTimedOperation({ busyText, action, successMessage, postDelayMs = 0 }) {
  if (state.busy) return;
  if (!isReady()) { setFooter("Configure ASL Agent settings first.", "warning", 0, { settingsLink: true }); return; }
  setBusy(true, busyText);
  try {
    await action();
    if (postDelayMs > 0) await sleep(postDelayMs);
    await refreshAll({ manual: false, force: true, silent: true });
    setFooter(successMessage, "success", 3000);
  } catch (error) {
    console.error(error);
    setFooter(error.message, "error", 0, { settingsLink: isAuthError(error) });
  } finally {
    setBusy(false);
  }
}

async function runImmediateOperation({ busyText, action, successMessage }) {
  if (state.busy) return;
  if (!isReady()) { setFooter("Configure ASL Agent settings first.", "warning", 0, { settingsLink: true }); return; }
  setBusy(true, busyText);
  try {
    await action();
    setFooter(successMessage, "success", 3000);
  } catch (error) {
    console.error(error);
    setFooter(error.message, "error", 0, { settingsLink: isAuthError(error) });
  } finally {
    setBusy(false);
  }
}

async function handleCop(command) {
  const actions = { identify: copIdentify, time: copTime, status: copStatus, version: copVersion };
  const labels  = { identify: "Identify", time: "Time", status: "Status", version: "Version" };
  runImmediateOperation({
    busyText: `Sending COP ${labels[command]}…`,
    action: async () => { await actions[command](); pushTape({ kind: "cop", text: `${labels[command]} sent` }); },
    successMessage: `COP ${labels[command]} sent.`
  });
}

// ---------------------------------------------------------------------------
// Timers / auto-refresh
// ---------------------------------------------------------------------------

function startAutoRefresh() {
  stopAutoRefresh();
  const intervalMs = (state.settings?.refreshInterval || 15) * 1000;
  state.refreshTimer = window.setInterval(() => {
    refreshAll({ manual: false, silent: true });
  }, intervalMs);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// WebAudio beeps (no audio assets); gated by settings at each call site
// ---------------------------------------------------------------------------

let audioCtx = null;

function beep(freq, ms) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = "square";
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* audio unavailable -- never let a beep break the panel */ }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function setBusy(isBusyValue, message = "Working…") {
  state.busy = Boolean(isBusyValue);
  els.busyMessage.hidden = !state.busy;
  els.busyText.textContent = message;
  updateControlAvailability();
}

function updateControlAvailability() {
  const configured = isReady();
  const controls = document.querySelectorAll("button, input");
  for (const control of controls) {
    if (control.id === "openSettings" || control.id === "liveLamp") { control.disabled = false; continue; }
    // Section toggles and the theme toggle stay usable even when unconfigured
    // or busy -- otherwise keyboard users can't even collapse sections before
    // configuring the extension, a keyboard trap.
    if (control.id === "toggleMode" || control.classList.contains("section-toggle")) {
      control.disabled = false;
      continue;
    }
    if (control.id === "refreshFavorites") { control.disabled = state.busy; continue; }
    control.disabled = state.busy || !configured;
  }
}

function setConnectionStatus(message) {
  const prev = els.connectionStatus.textContent;
  els.connectionStatus.textContent = message;
  // The visible connection state is the bezel lamp (see setLiveLamp); this
  // sr-only line carries the detail for screen readers. The full base URL
  // is available on the bezel ident tooltip.
  if (state.screenReaderMode && message && message !== prev) announce(message, "polite");
}

function hostOnly(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

function setFooter(message, type = "", timeoutMs = 0, { settingsLink = false } = {}) {
  window.clearTimeout(state.footerTimer);
  els.footerMessage.replaceChildren(document.createTextNode(message));
  els.footerMessage.className = type;
  if (settingsLink) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small secondary footer-settings-link";
    btn.textContent = "Open Settings";
    btn.addEventListener("click", handleOpenSettings);
    els.footerMessage.appendChild(btn);
  }
  if (state.screenReaderMode && message) {
    announce(message, type === "error" ? "assertive" : "polite");
  }
  if (timeoutMs > 0) {
    state.footerTimer = window.setTimeout(() => {
      els.footerMessage.replaceChildren();
      els.footerMessage.className = "";
    }, timeoutMs);
  }
}

// AslAgentApiError.status is 0 for network/timeout failures, so 401/403 here
// specifically means "the backend rejected our credentials."
function isAuthError(error) {
  return error?.status === 401 || error?.status === 403;
}

function isReady() { return isConfigured(state.settings); }
function valueOrDash(value) { return String(value || "").trim() || "—"; }
function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element;
}

function describeScheduleAction(schedule) {
  if (schedule.action === "disconnect-all") return "Disconnect All";
  if (schedule.action === "disconnect") return `Disconnect ${schedule.node}`;
  return `Connect to ${schedule.node}`;
}

// ---------------------------------------------------------------------------
// Node lookup
// ---------------------------------------------------------------------------

let nodeLookupTimer = null;

function handleNodeLookupInput() {
  const value = els.connectNodeInput.value.trim();
  window.clearTimeout(nodeLookupTimer);
  els.nodeLookupResult.hidden = true;
  els.nodeLookupResult.textContent = "";
  if (!/^\d{4,7}$/.test(value)) return;
  nodeLookupTimer = window.setTimeout(async () => {
    try {
      const result = await lookupNode(value);
      if (result?.callsign) {
        const parts = [result.callsign];
        if (result.location) parts.push(result.location);
        els.nodeLookupResult.textContent = parts.join(" — ");
        els.nodeLookupResult.hidden = false;
      }
    } catch { /* silent */ }
  }, 400);
}

// ---------------------------------------------------------------------------
// Section collapse
// ---------------------------------------------------------------------------

async function handleSectionToggle(event) {
  const btn = event.currentTarget;
  const bodyId = btn.getAttribute("aria-controls");
  const body = document.getElementById(bodyId);
  const sectionKey = btn.id.replace("toggle-", "");
  if (!body) return;
  const nowExpanded = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(nowExpanded));
  body.hidden = !nowExpanded;
  btn.querySelector(".toggle-icon").textContent = nowExpanded ? "▾" : "▸";
  if (nowExpanded) { state.collapsedSections.delete(sectionKey); }
  else { state.collapsedSections.add(sectionKey); }
  try { await storageSet({ collapsedSections: [...state.collapsedSections] }); } catch { /* non-critical */ }
}

function applyCollapsedSections() {
  for (const sectionKey of state.collapsedSections) {
    const btn  = document.getElementById(`toggle-${sectionKey}`);
    const body = document.getElementById(`${sectionKey}-body`);
    if (btn && body) {
      btn.setAttribute("aria-expanded", "false");
      body.hidden = true;
      const icon = btn.querySelector(".toggle-icon");
      if (icon) icon.textContent = "▸";
    }
  }
}

// ---------------------------------------------------------------------------
// DTMF macros
// ---------------------------------------------------------------------------

function renderDtmfMacros() {
  els.dtmfMacrosGrid.replaceChildren();
  if (!state.dtmfMacros.length) { els.dtmfMacrosGrid.hidden = true; return; }
  els.dtmfMacrosGrid.hidden = false;
  for (const macro of state.dtmfMacros) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary macro-btn";
    btn.textContent = macro.label;
    btn.title = macro.sequence;
    btn.dataset.macroSequence = macro.sequence;
    btn.addEventListener("click", () => { els.dtmfInput.value = macro.sequence; handleSendDtmf(); });
    els.dtmfMacrosGrid.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Favorites live status
// ---------------------------------------------------------------------------

const ASL_STATS_BASE = "https://stats.allstarlink.org/api";
const FAVORITES_STATS_INTERVAL_MS = 60000; // poll external API at most once per minute
let favoritesStatusCache = {};
let favoritesStatsLastRun = 0;

async function fetchFavoriteStats(nodeNumber) {
  try {
    const resp = await fetch(`${ASL_STATS_BASE}/stats/${nodeNumber}`, { signal: AbortSignal.timeout(5000) });
    if (resp.status === 429) return "ratelimited";
    if (!resp.ok) return null;
    const payload = await resp.json();
    const data = payload?.stats?.data;
    if (!data) return null;
    return {
      linkedCount: Array.isArray(data.links) ? data.links.length : 0,
      keyed: Boolean(data.keyed)
    };
  } catch { return null; }
}

async function refreshFavoritesStatus() {
  if (!state.favorites.length) return;
  const now = Date.now();
  if (now - favoritesStatsLastRun < FAVORITES_STATS_INTERVAL_MS) return;
  favoritesStatsLastRun = now;
  // Fetch sequentially with a small gap to avoid burst rate limiting
  for (const f of state.favorites) {
    const result = await fetchFavoriteStats(f.node);
    if (result === "ratelimited") {
      // Rate limited -- keep whatever is already cached rather than clobbering it.
    } else if (result) {
      favoritesStatusCache[f.node] = result;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  renderFavoritesStatus();
}

function renderFavoritesStatus() {
  const items = els.favoritesList.querySelectorAll(".favorite-item");
  items.forEach((item) => {
    const node = item.dataset.favoriteNode;
    if (!node) return;
    const stats = favoritesStatusCache[node];
    let badge = item.querySelector(".favorite-status");
    if (!badge) { badge = document.createElement("div"); badge.className = "favorite-status"; item.appendChild(badge); }
    if (stats) {
      badge.textContent = `${stats.linkedCount} linked${stats.keyed ? " · KEYED" : ""}`;
      badge.className = `favorite-status${stats.keyed ? " keyed" : ""}`;
    } else {
      badge.textContent = "--";
      badge.className = "favorite-status";
    }
  });
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

async function handleToggleMode() {
  try {
    const result = await new Promise((resolve) => chrome.storage.sync.get({ themeSettings: null }, resolve));
    const current = result.themeSettings || { preset: "system", mode: "dark", customColors: {} };
    let newSettings;
    if (current.preset === "system") {
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      newSettings = { ...current, preset: "slate", mode: systemDark ? "light" : "dark" };
    } else {
      newSettings = { ...current, mode: current.mode === "dark" ? "light" : "dark" };
    }
    await new Promise((resolve) => chrome.storage.sync.set({ themeSettings: newSettings }, resolve));
    applyTheme(newSettings);
    updateModeToggleIcon(newSettings);
    chrome.runtime.sendMessage({ type: "THEME_CHANGED" }).catch(() => {});
  } catch (error) {
    console.error("Toggle mode failed:", error);
  }
}

function updateModeToggleIcon(themeSettings) {
  if (!els.toggleMode) return;
  const ts = themeSettings || {};
  let isDark;
  if (ts.preset === "system" || !ts.preset) {
    isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    isDark = ts.mode !== "light";
  }
  els.toggleMode.textContent = isDark ? "☀" : "☾";
  els.toggleMode.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  els.toggleMode.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

function applyAccessibilityMode() {
  const enabled = state.screenReaderMode;
  document.documentElement.setAttribute("data-a11y", enabled ? "on" : "off");
  if (els.srAnnouncer) els.srAnnouncer.setAttribute("aria-live", "polite");
  if (els.srAnnouncerAssertive) els.srAnnouncerAssertive.setAttribute("aria-live", "assertive");
}

let announceTimer = null;
function announce(message, priority = "polite") {
  if (!state.screenReaderMode) return;
  const el = priority === "assertive" ? els.srAnnouncerAssertive : els.srAnnouncer;
  if (!el) return;
  el.textContent = "";
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => { el.textContent = message; }, 50);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  stopAutoRefresh();
  stopSlowPoll();
  stopEventStream();
  stopClock();
  stopInboundTimer();
  stopTotTimer();
  window.clearTimeout(state.footerTimer);
}

window.addEventListener("beforeunload", cleanup);
window.addEventListener("pagehide", cleanup);
