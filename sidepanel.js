"use strict";

import { getSettings, isConfigured, storageSet, normalizeSchedules } from "./services/storage.js";
import { loadAndApplyTheme, applyTheme, watchThemeChanges } from "./services/theme.js";
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
  getCapabilities,
} from "./services/api.js";

const DEFAULT_REFRESH_INTERVAL_MS = 15000;
const SLOW_POLL_INTERVAL_MS = 30000; // fallback poll when SSE is live
const AUDIT_LINES = 50;
const MAX_SSE_ERRORS = 5; // consecutive errors before giving up on SSE for this session

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
  // Node we connected to via the extension this session
  connectedTo: null, // { node, callsign }
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

  await loadInitialState();
  applyCollapsedSections();
  renderDtmfMacros();
  renderScheduleIndicator();
  startScheduleChecker();
  startAutoRefresh();
  startEventStream();
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

async function startEventStream() {
  stopEventStream();

  if (!isReady()) return;

  // Probe capabilities first -- a wrong API key or a pre-v1.4 backend must
  // not send us into a silent, infinite SSE reconnect loop. If this fails,
  // stay on normal polling and never open the EventSource at all.
  try {
    await getCapabilities();
  } catch (error) {
    setConnectionStatus("Polling (live events need backend v1.4+)");
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
        stopSlowPoll();
        startAutoRefresh();
        return;
      }
      setConnectionStatus(`Reconnecting… ${hostOnly(state.settings.baseUrl)}`);
      // Fall back to normal refresh rate while SSE is down
      stopSlowPoll();
      startAutoRefresh();
    });

    stream.on("node.rxkeyed", (data) => {
      if (!state.variables) state.variables = {};
      state.variables.rxkeyed = Boolean(data.rxkeyed);
      renderKeyedIndicators();
    });

    stream.on("node.txkeyed", (data) => {
      if (!state.variables) state.variables = {};
      state.variables.txkeyed = Boolean(data.txkeyed);
      renderKeyedIndicators();
    });

    stream.on("node.variables.snapshot", (data) => {
      if (data.variables) {
        state.variables = data.variables;
        state.activeLinks = parseActiveLinks(state.variables?.active_links);
        renderKeyedIndicators();
        renderConnectedNodes(state.connectedNodes);
      }
    });

    stream.on("link.connected", () => {
      // Refresh node list when a link connects
      refreshNodesAndStatus({ silent: true });
    });

    stream.on("link.disconnected", () => {
      // Refresh node list when a link disconnects
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
      renderConnectedNodes(state.connectedNodes);
    }
    renderStatusHeader();
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

  els.statusNode = requireElement("statusNode");
  els.statusCallsign = requireElement("statusCallsign");
  els.statusKeyups = requireElement("statusKeyups");
  els.statusConnectedCount = requireElement("statusConnectedCount");
  els.statusRxKeyed = requireElement("statusRxKeyed");
  els.statusTxKeyed = requireElement("statusTxKeyed");
  els.nodeLookupResult = requireElement("nodeLookupResult");
  els.statusUptime = requireElement("statusUptime");
  els.statusTxToday = requireElement("statusTxToday");
  els.statusTxTotal = requireElement("statusTxTotal");
  els.activeNodeNumber = requireElement("activeNodeNumber");
  els.activeNodeCallsign = requireElement("activeNodeCallsign");
  els.connectedToNode = requireElement("connectedToNode");
  els.connectedToCallsign = requireElement("connectedToCallsign");
  els.nodeCountWarningBadge = requireElement("nodeCountWarningBadge");
  els.dtmfMacrosGrid = requireElement("dtmfMacrosGrid");
  els.scheduleIndicator = requireElement("scheduleIndicator");
  els.srAnnouncer = requireElement("srAnnouncer");
  els.srAnnouncerAssertive = requireElement("srAnnouncerAssertive");
  els.toggleMode = requireElement("toggleMode");
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

  els.refreshStatus = requireElement("refreshStatus");
  els.disconnectAll = requireElement("disconnectAll");
  els.busyMessage = requireElement("busyMessage");
  els.busyText = requireElement("busyText");
  els.connectedNodesList = requireElement("connectedNodesList");

  els.dtmfForm = requireElement("dtmfForm");
  els.dtmfInput = requireElement("dtmfInput");
  els.sendDtmf = requireElement("sendDtmf");

  els.refreshAudit = requireElement("refreshAudit");
  els.auditLog = requireElement("auditLog");

  els.footerMessage = requireElement("footerMessage");
}

function bindEvents() {
  els.openSettings.addEventListener("click", handleOpenSettings);

  els.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleConnectFromInput(false);
  });

  els.connectMonitor.addEventListener("click", () => {
    handleConnectFromInput(true);
  });

  els.refreshFavorites.addEventListener("click", handleRefreshFavorites);
  els.refreshStatus.addEventListener("click", () => refreshAll({ manual: true }));
  els.refreshAudit.addEventListener("click", () => refreshAudit({ manual: true }));

  els.favoritesList.addEventListener("click", handleFavoritesClick);
  els.disconnectAll.addEventListener("click", handleDisconnectAll);
  els.connectedNodesList.addEventListener("click", handleConnectedNodesClick);

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
          renderScheduleIndicator();
          applyAccessibilityMode();
        }).catch(console.error);
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
    // Restore connected-to from sessionStorage
    try {
      const raw = sessionStorage.getItem("asl_connected_to");
      if (raw) state.connectedTo = JSON.parse(raw);
    } catch { /* non-critical */ }
    renderConnectedTo();
    renderFavorites();
    updateControlAvailability();

    if (!isReady()) {
      clearStatusHeader();
      renderEmptyConnectedNodes("Configure ASL Agent settings first.");
      renderEmptyAudit("Configure ASL Agent settings first.");
      setConnectionStatus("Not configured");
      setFooter("Open settings to add your ASL Agent base URL and API key.", "warning", 0, { settingsLink: true });
      return;
    }

    await refreshAll({ manual: false });
  } catch (error) {
    console.error(error);
    setConnectionStatus("Error");
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
    clearStatusHeader();
    renderEmptyConnectedNodes("Configure ASL Agent settings first.");
    renderEmptyAudit("Configure ASL Agent settings first.");
    setConnectionStatus("Not configured");
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
    // Validate connectedTo is still in the list; clear if it dropped
    if (state.connectedTo) {
      const still = state.connectedNodes.some((n) => n.node === state.connectedTo.node);
      if (!still) {
        state.connectedTo = null;
        sessionStorage.removeItem("asl_connected_to");
        renderConnectedTo();
      }
    }
    renderConnectedNodes(state.connectedNodes);
  } else {
    hadError = true;
    if (isAuthError(nodesResult.reason)) authError = true;
    console.error(nodesResult.reason);
    renderEmptyConnectedNodes(`Failed to load connected nodes: ${nodesResult.reason.message}`);
  }

  if (variablesResult.status === "fulfilled") {
    state.variables = variablesResult.value;
    state.activeLinks = parseActiveLinks(state.variables?.active_links);
  } else {
    if (isAuthError(variablesResult.reason)) authError = true;
    console.error(variablesResult.reason);
  }

  if (auditResult.status === "fulfilled") {
    renderAudit(auditResult.value);
  } else {
    hadError = true;
    if (isAuthError(auditResult.reason)) authError = true;
    console.error(auditResult.reason);
    renderEmptyAudit(`Failed to load audit log: ${auditResult.reason.message}`);
  }

  renderStatusHeader();
  refreshFavoritesStatus();

  if (hadError) {
    setConnectionStatus("Refresh error");
    if (!silent) setFooter("One or more ASL Agent requests failed.", "error", 0, { settingsLink: authError });
  } else {
    // Show live indicator if SSE is connected, otherwise just the host
    if (state.sseConnected) {
      setConnectionStatus(`Live ● ${hostOnly(state.settings.baseUrl)}`);
    } else {
      setConnectionStatus(`Connected to ${hostOnly(state.settings.baseUrl)}`);
    }
    if (manual && !silent) setFooter("Status refreshed.", "success", 2000);
  }

  updateControlAvailability();
}

async function refreshAudit(options = {}) {
  const { manual = false, force = false, silent = false } = options;

  if (state.busy && !force) return;
  if (!isReady()) { renderEmptyAudit("Configure ASL Agent settings first."); return; }

  try {
    const audit = await getAudit(AUDIT_LINES);
    renderAudit(audit);
    if (manual && !silent) setFooter("Audit log refreshed.", "success", 2000);
  } catch (error) {
    console.error(error);
    renderEmptyAudit(`Failed to load audit log: ${error.message}`);
    if (!silent) setFooter(error.message, "error", 0, { settingsLink: isAuthError(error) });
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderStatusHeader() {
  const status = state.status || {};

  els.statusNode.textContent = valueOrDash(status.node);
  els.statusCallsign.textContent = valueOrDash(status.callsign);
  els.statusKeyups.textContent = valueOrDash(status.keyups_today);
  els.statusConnectedCount.textContent = String(state.connectedCount);
  els.statusUptime.textContent = valueOrDash(status.uptime);
  els.statusTxToday.textContent = valueOrDash(status.tx_time_today);
  els.statusTxTotal.textContent = valueOrDash(status.tx_time_total);
  renderKeyedIndicators();
  renderNodeCountWarning();
}

function renderNodeCountWarning() {
  const threshold = state.nodeCountWarning;
  const count = state.connectedCount;
  const over = threshold > 0 && count >= threshold;
  els.nodeCountWarningBadge.hidden = !over;
  if (over) els.nodeCountWarningBadge.textContent = `⚠ ${count} NODES`;
}

function renderKeyedIndicators() {
  // RX -- signal present on node input (someone is transmitting TO the node)
  const rxKeyed = Boolean(state.variables?.rxkeyed);
  els.statusRxKeyed.textContent = "RX";
  els.statusRxKeyed.className = rxKeyed ? "keyed-badge rx active" : "keyed-badge rx";
  els.statusRxKeyed.setAttribute("aria-label", rxKeyed ? "RX active, receiving" : "RX idle");

  // TX -- node transmitter is active (node is transmitting OUT)
  const txKeyed = Boolean(state.variables?.txkeyed);
  els.statusTxKeyed.textContent = "TX";
  els.statusTxKeyed.className = txKeyed ? "keyed-badge tx active" : "keyed-badge tx";
  els.statusTxKeyed.setAttribute("aria-label", txKeyed ? "TX active, transmitting" : "TX idle");
}

function clearStatusHeader() {
  els.statusNode.textContent = "—";
  els.statusCallsign.textContent = "—";
  els.statusKeyups.textContent = "—";
  els.statusConnectedCount.textContent = "—";
  els.statusRxKeyed.textContent = "RX";
  els.statusRxKeyed.className = "keyed-badge rx";
  els.statusRxKeyed.setAttribute("aria-label", "RX idle");
  els.statusTxKeyed.textContent = "TX";
  els.statusTxKeyed.className = "keyed-badge tx";
  els.statusTxKeyed.setAttribute("aria-label", "TX idle");
  els.statusUptime.textContent = "—";
  els.statusTxToday.textContent = "—";
  els.statusTxTotal.textContent = "—";
  els.activeNodeNumber.textContent = "—";
  els.activeNodeCallsign.textContent = "";
  els.activeNodeCallsign.hidden = true;
  els.nodeCountWarningBadge.hidden = true;
}

function renderActiveNode() {
  const activeNode = state.connectedNodes.find((n) => state.activeLinks.has(n.node));
  els.activeNodeNumber.textContent = activeNode?.node || "—";
  els.activeNodeCallsign.textContent = activeNode?.callsign || "";
  els.activeNodeCallsign.hidden = !activeNode?.callsign;
}

function renderConnectedTo() {
  const ct = state.connectedTo;
  els.connectedToNode.textContent = ct?.node || "—";
  els.connectedToCallsign.textContent = ct?.callsign || "";
  els.connectedToCallsign.hidden = !ct?.callsign;
}

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

function renderConnectedNodes(nodes) {
  els.connectedNodesList.replaceChildren();

  if (!nodes.length) {
    els.connectedNodesList.appendChild(createEmptyState("No connected nodes."));
    return;
  }

  for (const connectedNode of nodes) {
    const item = document.createElement("div");
    item.className = "connected-node-item";

    const nodeWrap = document.createElement("div");
    nodeWrap.className = "node-identity";

    const node = document.createElement("div");
    node.className = "node-number";
    node.textContent = connectedNode.node;

    if (connectedNode.callsign) {
      const callsign = document.createElement("div");
      callsign.className = "node-callsign";
      callsign.textContent = connectedNode.callsign;
      if (connectedNode.location) callsign.title = connectedNode.location;
      nodeWrap.append(node, callsign);
    } else {
      nodeWrap.appendChild(node);
    }

    const mode = document.createElement("span");
    mode.className = `mode-badge ${connectedNode.mode.toLowerCase()}`;
    mode.textContent = connectedNode.mode;
    mode.title = getModeLabel(connectedNode.mode);

    // When the backend sends no info string, leave this column empty -- the
    // mode badge (plus its title/aria-label) already carries the T/R mode,
    // so falling back to getModeLabel() here just restated the badge.
    const info = document.createElement("div");
    info.className = "node-info";
    info.textContent = connectedNode.info || "";
    info.title = connectedNode.info || "";

    if (state.activeLinks.has(connectedNode.node)) {
      item.classList.add("transmitting");
    }

    const discBtn = document.createElement("button");
    discBtn.type = "button";
    discBtn.className = "small danger";
    discBtn.textContent = "Disc";
    discBtn.title = `Disconnect node ${connectedNode.node}`;
    discBtn.setAttribute("aria-label", `Disconnect node ${connectedNode.node}`);
    discBtn.dataset.disconnectNode = connectedNode.node;

    item.append(nodeWrap, mode, info, discBtn);
    els.connectedNodesList.appendChild(item);
  }

  renderActiveNode();
}

function handleConnectedNodesClick(event) {
  const button = event.target.closest("[data-disconnect-node]");
  if (!button) return;
  const node = button.dataset.disconnectNode;
  runTimedOperation({
    busyText: `Disconnecting ${node}…`,
    action: async () => { await disconnectNode(node); },
    successMessage: `Disconnect request sent for node ${node}.`
  });
}

function renderEmptyConnectedNodes(message) {
  els.connectedNodesList.replaceChildren(createEmptyState(message));
}

function renderAudit(audit) {
  const entries = Array.isArray(audit?.entries) ? audit.entries : [];

  els.auditLog.replaceChildren();

  if (!entries.length) {
    els.auditLog.appendChild(createEmptyState("No audit entries."));
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "audit-entry";
    // Handle both structured (v1.4+) and raw string (legacy) entries
    if (entry && typeof entry === "object" && entry.timestamp) {
      const d = new Date(entry.timestamp);
      const time = Number.isNaN(d.getTime())
        ? entry.timestamp
        : d.toISOString().slice(0, 19).replace("T", " ") + " Z";
      const cmd  = entry.command || "";
      const det  = entry.details ? ` — ${entry.details}` : "";
      row.textContent = `${time}  ${cmd}${det}`;
    } else {
      row.textContent = String(entry);
    }
    els.auditLog.appendChild(row);
  }
}

function renderEmptyAudit(message) {
  els.auditLog.replaceChildren(createEmptyState(message));
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
      // Resolve callsign from lookup result or API
      let callsign = "";
      if (!els.nodeLookupResult.hidden && els.nodeLookupResult.textContent) {
        callsign = els.nodeLookupResult.textContent.split("—")[0].trim();
      } else {
        try { const r = await lookupNode(node); callsign = r?.callsign || ""; } catch { /* silent */ }
      }
      state.connectedTo = { node, callsign };
      try { sessionStorage.setItem("asl_connected_to", JSON.stringify(state.connectedTo)); } catch { /* non-critical */ }
      renderConnectedTo();
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
      let callsign = "";
      try { const r = await lookupNode(node); callsign = r?.callsign || ""; } catch { /* silent */ }
      state.connectedTo = { node, callsign };
      try { sessionStorage.setItem("asl_connected_to", JSON.stringify(state.connectedTo)); } catch { /* non-critical */ }
      renderConnectedTo();
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
      state.connectedTo = null;
      sessionStorage.removeItem("asl_connected_to");
      renderConnectedTo();
    },
    successMessage: "Disconnect-all request sent.",
    postDelayMs: 3000
  });
}

function handleSendDtmf() {
  const sequence = els.dtmfInput.value.trim();
  runImmediateOperation({
    busyText: `Sending DTMF ${sequence}…`,
    action: async () => { await sendDtmf(sequence, { confirmed: true }); els.dtmfInput.value = ""; },
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
    await refreshAudit({ manual: false, force: true, silent: true });
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
    action: () => actions[command](),
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
    if (control.id === "openSettings") { control.disabled = false; continue; }
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
  // The status line shows host:port only (see hostOnly()) to avoid wrapping
  // in a 400px panel; the full base URL is still available on hover/focus.
  if (state.settings?.baseUrl) {
    els.connectionStatus.title = state.settings.baseUrl;
  } else {
    els.connectionStatus.removeAttribute("title");
  }
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
let favoritesStatsTimer = null;
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
// Schedule checker
// ---------------------------------------------------------------------------

let scheduleCheckerTimer = null;

function startScheduleChecker() {
  stopScheduleChecker();
  scheduleCheckerTimer = window.setInterval(checkSchedules, 30000);
  checkSchedules();
}

function stopScheduleChecker() {
  if (scheduleCheckerTimer) { window.clearInterval(scheduleCheckerTimer); scheduleCheckerTimer = null; }
}

function checkSchedules() {
  if (!state.schedules.length) return;
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  for (const schedule of state.schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.days.includes(utcDay)) continue;
    if (schedule.hour !== utcHour) continue;
    if (Math.abs(schedule.minute - utcMinute) > 1) continue;
    const key = `sched_last_${schedule.id}`;
    const lastFired = Number(sessionStorage.getItem(key) || 0);
    const nowMs = Date.now();
    if (nowMs - lastFired < 90000) continue;
    sessionStorage.setItem(key, String(nowMs));
    executeSchedule(schedule);
  }
}

async function executeSchedule(schedule) {
  if (!isReady()) return;
  try {
    if (schedule.action === "disconnect-all") {
      await disconnectAll();
      setFooter(`Schedule: Disconnect All fired.`, "success", 4000);
    } else if (schedule.action === "disconnect") {
      if (!schedule.node) {
        setFooter("Schedule failed: disconnect schedule has no node.", "error");
        return;
      }
      await disconnectNode(schedule.node);
      setFooter(`Schedule: Disconnected ${schedule.node}.`, "success", 4000);
    } else {
      const monitorOnly = schedule.mode === "monitor";
      await connectNode(schedule.node, { monitorOnly });
      setFooter(`Schedule: Connected to ${schedule.node}.`, "success", 4000);
    }
    await sleep(3000);
    await refreshAll({ manual: false, force: true, silent: true });
  } catch (error) {
    console.error("Schedule execution failed:", error);
    setFooter(`Schedule failed: ${error.message}`, "error");
  }
}

function renderScheduleIndicator() {
  if (!state.schedules.length) { els.scheduleIndicator.hidden = true; return; }
  const enabled = state.schedules.filter((s) => s.enabled);
  if (!enabled.length) { els.scheduleIndicator.hidden = true; return; }
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const next = enabled.map((s) => {
    const day = DAY_NAMES[s.days[0]] || "?";
    const time = `${String(s.hour).padStart(2,"0")}:${String(s.minute).padStart(2,"0")}`;
    return `${s.action === "disconnect-all" ? "Disc All" : `${s.action} ${s.node}`} @ ${day} ${time}`;
  }).slice(0, 2).join(" | ");
  els.scheduleIndicator.textContent = `⏱ ${next}`;
  els.scheduleIndicator.hidden = false;
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
  stopScheduleChecker();
  window.clearTimeout(state.footerTimer);
}

window.addEventListener("beforeunload", cleanup);
window.addEventListener("pagehide", cleanup);
