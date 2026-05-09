"use strict";

import { getSettings, isConfigured } from "./services/storage.js";
import {
  getStatus,
  getConnectedNodes,
  getVariables,
  connectNode,
  disconnectAll,
  sendDtmf,
  getAudit
} from "./services/api.js";

const AUTO_REFRESH_INTERVAL_MS = 15000;
const AUDIT_LINES = 50;

const state = {
  settings: null,
  favorites: [],
  connectedNodes: [],
  connectedCount: 0,
  status: null,
  variables: null,
  busy: false,
  refreshTimer: null,
  footerTimer: null
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();

  await loadInitialState();
  startAutoRefresh();
}

function bindElements() {
  els.connectionStatus = requireElement("connectionStatus");
  els.openSettings = requireElement("openSettings");

  els.statusNode = requireElement("statusNode");
  els.statusCallsign = requireElement("statusCallsign");
  els.statusKeyups = requireElement("statusKeyups");
  els.statusConnectedCount = requireElement("statusConnectedCount");
  els.statusRxKeyed = requireElement("statusRxKeyed");

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

  els.dtmfForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSendDtmf();
  });
}

async function loadInitialState() {
  try {
    await loadSettingsIntoState();
    renderFavorites();
    updateControlAvailability();

    if (!isReady()) {
      clearStatusHeader();
      renderEmptyConnectedNodes("Configure ASL Agent settings first.");
      renderEmptyAudit("Configure ASL Agent settings first.");
      setConnectionStatus("Not configured");
      setFooter("Open settings to add your ASL Agent base URL and API key.", "warning");
      return;
    }

    await refreshAll({ manual: false });
  } catch (error) {
    console.error(error);
    setConnectionStatus("Error");
    setFooter(error.message, "error");
    updateControlAvailability();
  }
}

async function loadSettingsIntoState() {
  const settings = await getSettings();

  state.settings = settings;
  state.favorites = Array.isArray(settings.favorites) ? settings.favorites : [];
}

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

function handleOpenSettings() {
  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.openOptionsPage === "function"
  ) {
    chrome.runtime.openOptionsPage();
    return;
  }

  window.open("options.html", "_blank", "noopener");
}

function handleConnectFromInput(monitorOnly) {
  const node = els.connectNodeInput.value.trim();

  runTimedOperation({
    busyText: monitorOnly
      ? `Connecting to ${node} in monitor-only mode…`
      : `Connecting to ${node} in transceive mode…`,
    action: async () => {
      await connectNode(node, { monitorOnly });
      els.connectNodeInput.value = "";
    },
    successMessage: monitorOnly
      ? `Monitor-only connect request sent for node ${node}.`
      : `Transceive connect request sent for node ${node}.`
  });
}

function handleFavoritesClick(event) {
  const button = event.target.closest("[data-favorite-node][data-favorite-mode]");

  if (!button) {
    return;
  }

  const node = button.dataset.favoriteNode;
  const mode = button.dataset.favoriteMode;
  const monitorOnly = mode === "monitor";

  runTimedOperation({
    busyText: monitorOnly
      ? `Connecting favorite ${node} in monitor-only mode…`
      : `Connecting favorite ${node} in transceive mode…`,
    action: () => connectNode(node, { monitorOnly }),
    successMessage: monitorOnly
      ? `Monitor-only connect request sent for favorite ${node}.`
      : `Transceive connect request sent for favorite ${node}.`
  });
}

function handleDisconnectAll() {
  const confirmed = window.confirm(
    "Disconnect all currently connected nodes?"
  );

  if (!confirmed) {
    return;
  }

  runTimedOperation({
    busyText: "Disconnecting all nodes…",
    action: () => disconnectAll(),
    successMessage: "Disconnect-all request sent."
  });
}

function handleSendDtmf() {
  const sequence = els.dtmfInput.value.trim();

  runImmediateOperation({
    busyText: `Sending DTMF ${sequence}…`,
    action: async () => {
      await sendDtmf(sequence, { confirmed: true });
      els.dtmfInput.value = "";
    },
    successMessage: `DTMF sequence ${sequence} sent.`
  });
}

async function runTimedOperation({ busyText, action, successMessage }) {
  if (state.busy) {
    return;
  }

  if (!isReady()) {
    setFooter("Configure ASL Agent settings first.", "warning");
    return;
  }

  setBusy(true, busyText);

  try {
    await action();
    await refreshAll({ manual: false, force: true, silent: true });
    setFooter(successMessage, "success", 3000);
  } catch (error) {
    console.error(error);
    setFooter(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function runImmediateOperation({ busyText, action, successMessage }) {
  if (state.busy) {
    return;
  }

  if (!isReady()) {
    setFooter("Configure ASL Agent settings first.", "warning");
    return;
  }

  setBusy(true, busyText);

  try {
    await action();
    await refreshAudit({ manual: false, force: true, silent: true });
    setFooter(successMessage, "success", 3000);
  } catch (error) {
    console.error(error);
    setFooter(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function refreshAll(options = {}) {
  const {
    manual = false,
    force = false,
    silent = false
  } = options;

  if (state.busy && !force) {
    return;
  }

  if (!isReady()) {
    clearStatusHeader();
    renderEmptyConnectedNodes("Configure ASL Agent settings first.");
    renderEmptyAudit("Configure ASL Agent settings first.");
    setConnectionStatus("Not configured");
    updateControlAvailability();
    return;
  }

  if (!silent) {
    setConnectionStatus("Refreshing…");
  }

  const [statusResult, nodesResult, variablesResult, auditResult] = await Promise.allSettled([
    getStatus(),
    getConnectedNodes(),
    getVariables(),
    getAudit(AUDIT_LINES)
  ]);

  let hadError = false;

  if (statusResult.status === "fulfilled") {
    state.status = normalizeStatus(statusResult.value);
  } else {
    hadError = true;
    console.error(statusResult.reason);
  }

  if (nodesResult.status === "fulfilled") {
    const normalizedNodes = normalizeNodesResponse(nodesResult.value);
    state.connectedNodes = normalizedNodes.connectedNodes;
    state.connectedCount = normalizedNodes.count;
    renderConnectedNodes(state.connectedNodes);
  } else {
    hadError = true;
    console.error(nodesResult.reason);
    renderEmptyConnectedNodes(`Failed to load connected nodes: ${nodesResult.reason.message}`);
  }

  if (variablesResult.status === "fulfilled") {
    state.variables = variablesResult.value;
  } else {
    console.error(variablesResult.reason);
  }

  if (auditResult.status === "fulfilled") {
    renderAudit(auditResult.value);
  } else {
    hadError = true;
    console.error(auditResult.reason);
    renderEmptyAudit(`Failed to load audit log: ${auditResult.reason.message}`);
  }

  renderStatusHeader();

  if (hadError) {
    setConnectionStatus("Refresh error");
    if (!silent) {
      setFooter("One or more ASL Agent requests failed.", "error");
    }
  } else {
    setConnectionStatus(`Connected to ${state.settings.baseUrl}`);
    if (manual && !silent) {
      setFooter("Status refreshed.", "success", 2000);
    }
  }

  updateControlAvailability();
}

async function refreshAudit(options = {}) {
  const {
    manual = false,
    force = false,
    silent = false
  } = options;

  if (state.busy && !force) {
    return;
  }

  if (!isReady()) {
    renderEmptyAudit("Configure ASL Agent settings first.");
    return;
  }

  try {
    const audit = await getAudit(AUDIT_LINES);
    renderAudit(audit);

    if (manual && !silent) {
      setFooter("Audit log refreshed.", "success", 2000);
    }
  } catch (error) {
    console.error(error);
    renderEmptyAudit(`Failed to load audit log: ${error.message}`);

    if (!silent) {
      setFooter(error.message, "error");
    }
  }
}

function renderStatusHeader() {
  const status = state.status || {};

  els.statusNode.textContent = valueOrDash(status.node);
  els.statusCallsign.textContent = valueOrDash(status.callsign);
  els.statusKeyups.textContent = valueOrDash(status.keyups_today);
  els.statusConnectedCount.textContent = String(state.connectedCount);
  renderKeyedIndicator();
}

function renderKeyedIndicator() {
  const rxKeyed = Boolean(state.variables?.rxkeyed);
  els.statusRxKeyed.textContent = rxKeyed ? "KEYED" : "";
  els.statusRxKeyed.className = rxKeyed ? "keyed-badge active" : "keyed-badge";
}

function clearStatusHeader() {
  els.statusNode.textContent = "—";
  els.statusCallsign.textContent = "—";
  els.statusKeyups.textContent = "—";
  els.statusConnectedCount.textContent = "—";
  els.statusRxKeyed.textContent = "";
  els.statusRxKeyed.className = "keyed-badge";
}

function renderFavorites() {
  els.favoritesList.replaceChildren();

  if (!state.favorites.length) {
    const empty = createEmptyState("No favorites configured.");
    els.favoritesList.appendChild(empty);
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
    item.append(node, label, actions);
    els.favoritesList.appendChild(item);
  }
}

function renderConnectedNodes(nodes) {
  els.connectedNodesList.replaceChildren();

  if (!nodes.length) {
    els.connectedNodesList.appendChild(
      createEmptyState("No connected nodes.")
    );
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
      if (connectedNode.location) {
        callsign.title = connectedNode.location;
      }
      nodeWrap.append(node, callsign);
    } else {
      nodeWrap.appendChild(node);
    }

    const mode = document.createElement("span");
    mode.className = `mode-badge ${connectedNode.mode.toLowerCase()}`;
    mode.textContent = connectedNode.mode;
    mode.title = getModeLabel(connectedNode.mode);

    const info = document.createElement("div");
    info.className = "node-info";
    info.textContent = connectedNode.info || getModeLabel(connectedNode.mode);
    info.title = connectedNode.info || getModeLabel(connectedNode.mode);

    item.append(nodeWrap, mode, info);
    els.connectedNodesList.appendChild(item);
  }
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
    row.textContent = String(entry);
    els.auditLog.appendChild(row);
  }
}

function renderEmptyAudit(message) {
  els.auditLog.replaceChildren(createEmptyState(message));
}

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
  const rawNodes = Array.isArray(payload?.connected_nodes)
    ? payload.connected_nodes
    : [];

  const connectedNodes = rawNodes
    .map(normalizeConnectedNode)
    .filter(Boolean)
    .sort(compareNodeIdentifiers);

  const apiCount = Number(payload?.count);

  return {
    connectedNodes,
    count: Number.isInteger(apiCount) && apiCount >= 0
      ? apiCount
      : connectedNodes.length
  };
}

function normalizeConnectedNode(value) {
  const node = String(value?.node || "").trim().toUpperCase();
  const mode = String(value?.mode || "").trim().toUpperCase();
  const info = String(value?.info || "").trim();
  const callsign = String(value?.callsign || "").trim();
  const location = String(value?.location || "").trim();

  if (!isValidNodeIdentifier(node)) {
    return null;
  }

  return {
    node,
    mode: mode === "R" ? "R" : "T",
    info,
    callsign,
    location
  };
}

function isValidNodeIdentifier(value) {
  const identifier = String(value || "").trim().toUpperCase();

  if (!identifier) {
    return false;
  }

  const isNumericNode = /^\d+$/.test(identifier);

  // Practical amateur radio callsign pattern.
  // Allows examples like KM5Y, KC8FQV, W1AW, N0CALL, VE3ABC, and G4XYZ.
  const isCallsign = /^[A-Z]{1,3}\d[A-Z0-9]{1,4}$/.test(identifier);

  return isNumericNode || isCallsign;
}

function compareNodeIdentifiers(a, b) {
  const aNode = a.node;
  const bNode = b.node;

  const aNumeric = /^\d+$/.test(aNode);
  const bNumeric = /^\d+$/.test(bNode);

  if (aNumeric && bNumeric) {
    return Number(aNode) - Number(bNode);
  }

  if (aNumeric && !bNumeric) {
    return -1;
  }

  if (!aNumeric && bNumeric) {
    return 1;
  }

  return aNode.localeCompare(bNode);
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
    if (control.id === "openSettings") {
      control.disabled = false;
      continue;
    }

    if (control.id === "refreshFavorites") {
      control.disabled = state.busy;
      continue;
    }

    control.disabled = state.busy || !configured;
  }
}

function setConnectionStatus(message) {
  els.connectionStatus.textContent = message;
}

function setFooter(message, type = "", timeoutMs = 0) {
  window.clearTimeout(state.footerTimer);

  els.footerMessage.textContent = message;
  els.footerMessage.className = type;

  if (timeoutMs > 0) {
    state.footerTimer = window.setTimeout(() => {
      els.footerMessage.textContent = "";
      els.footerMessage.className = "";
    }, timeoutMs);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();

  state.refreshTimer = window.setInterval(() => {
    refreshAll({
      manual: false,
      silent: true
    });
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function isReady() {
  return isConfigured(state.settings);
}

function valueOrDash(value) {
  const normalized = String(value || "").trim();
  return normalized || "—";
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function requireElement(id) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element;
}

window.addEventListener("beforeunload", () => {
  stopAutoRefresh();
  window.clearTimeout(state.footerTimer);
});