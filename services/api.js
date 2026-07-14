"use strict";

import {
  getSettings,
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeNodeNumber
} from "./storage.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_AUDIT_LINES = 50;

export class AslAgentApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AslAgentApiError";
    this.status = details.status || 0;
    this.statusText = details.statusText || "";
    this.url = details.url || "";
    this.response = details.response;
  }
}

// ---------------------------------------------------------------------------
// SSE Event Stream client
// ---------------------------------------------------------------------------

export class AslEventStream {
  /**
   * Persistent SSE connection to GET /events?api_key=KEY.
   *
   * Usage:
   *   const stream = new AslEventStream({ baseUrl, apiKey });
   *   stream.on("node.txkeyed",  data => { ... });
   *   stream.on("node.rxkeyed",  data => { ... });
   *   stream.on("link.connected",    data => { ... });
   *   stream.on("link.disconnected", data => { ... });
   *   stream.on("node.variables.snapshot", data => { ... });
   *   stream.on("connected",  () => { ... });   // stream opened
   *   stream.on("error",      () => { ... });   // stream error / retry
   *   stream.connect();
   *   stream.close();   // call on panel unload
   */
  constructor({ baseUrl, apiKey }) {
    this._baseUrl = normalizeBaseUrl(baseUrl);
    this._apiKey  = normalizeApiKey(apiKey);
    this._source  = null;
    this._handlers = {};
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;
    this._closed = false;
  }

  on(eventType, handler) {
    if (!this._handlers[eventType]) {
      this._handlers[eventType] = [];
    }
    this._handlers[eventType].push(handler);
    return this;
  }

  _emit(eventType, data) {
    const handlers = this._handlers[eventType] || [];
    for (const h of handlers) {
      try { h(data); } catch (e) { console.error("AslEventStream handler error:", e); }
    }
  }

  connect() {
    if (this._closed) return;
    this._clearReconnectTimer();
    this._openSource();
  }

  close() {
    this._closed = true;
    this._clearReconnectTimer();
    if (this._source) {
      this._source.close();
      this._source = null;
    }
  }

  get connected() {
    return this._source?.readyState === EventSource.OPEN;
  }

  _openSource() {
    if (this._source) {
      this._source.close();
      this._source = null;
    }

    const url = `${this._baseUrl}/events?api_key=${encodeURIComponent(this._apiKey)}`;

    try {
      const source = new EventSource(url);
      this._source = source;

      source.onopen = () => {
        this._reconnectDelay = 2000; // reset backoff on success
        this._emit("connected");
      };

      source.onerror = () => {
        this._emit("error");
        source.close();
        this._source = null;
        if (!this._closed) {
          this._scheduleReconnect();
        }
      };

      // Named event listeners for each event type we care about
      const eventTypes = [
        "node.rxkeyed",
        "node.txkeyed",
        "node.variables.snapshot",
        "link.connected",
        "link.disconnected",
        "health.ami",
      ];

      for (const type of eventTypes) {
        source.addEventListener(type, (e) => {
          try {
            const data = JSON.parse(e.data);
            this._emit(type, data);
          } catch {
            // Malformed event -- ignore
          }
        });
      }
    } catch (e) {
      console.error("AslEventStream: failed to open EventSource:", e);
      this._emit("error");
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();
    this._reconnectTimer = globalThis.setTimeout(() => {
      if (!this._closed) {
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
        this._openSource();
      }
    }, this._reconnectDelay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      globalThis.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

export async function createEventStreamFromSettings() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.apiKey) {
    throw new Error("ASL Agent base URL and API key must be configured first.");
  }
  return new AslEventStream({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
  });
}

// ---------------------------------------------------------------------------
// REST client (uses globalThis timers so it also works inside the
// background service worker, which has no `window`)
// ---------------------------------------------------------------------------

export class AslAgentClient {
  constructor({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = normalizeApiKey(apiKey);
    this.timeoutMs = timeoutMs;
  }

  async getStatus() { return this.request("/status"); }
  async getConnectedNodes() { return this.request("/nodes?enrich=true"); }
  async getVariables() { return this.request("/variables"); }
  async getVersion() { return this.request("/version"); }
  async getAudit(lines = DEFAULT_AUDIT_LINES) {
    return this.request(`/audit?lines=${encodeURIComponent(normalizeAuditLines(lines))}`);
  }
  async lookupNode(node) {
    return this.request(`/lookup/${encodeURIComponent(normalizeNodeNumber(node))}`);
  }
  async connectNode(node, { monitorOnly = false } = {}) {
    return this.request("/connect", {
      method: "POST",
      body: { node: normalizeNodeNumber(node), monitor_only: Boolean(monitorOnly) }
    });
  }
  async disconnectNode(node) {
    return this.request("/disconnect", { method: "POST", body: { node: normalizeNodeNumber(node) } });
  }
  async disconnectAll() { return this.request("/disconnect-all", { method: "POST" }); }
  async sendDtmf(sequence, { confirmed = true } = {}) {
    const normalizedSequence = normalizeDtmfSequence(sequence);
    if (confirmed !== true) throw new Error("DTMF requests must include confirmed: true.");
    return this.request("/dtmf", { method: "POST", body: { sequence: normalizedSequence, confirmed: true } });
  }
  async runMacro(macroNumber) {
    return this.request("/macro", { method: "POST", body: { macro_number: normalizeMacroNumber(macroNumber) } });
  }
  async copIdentify() { return this.request("/cop/identify", { method: "POST" }); }
  async copTime()     { return this.request("/cop/time",     { method: "POST" }); }
  async copStatus()   { return this.request("/cop/status",   { method: "POST" }); }
  async copVersion()  { return this.request("/cop/version",  { method: "POST" }); }

  async request(path, options = {}) {
    const method = options.method || "GET";
    const url = buildUrl(this.baseUrl, path);
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = { "x-api-key": this.apiKey, "Accept": "application/json" };
    const fetchOptions = { method, headers, cache: "no-store", credentials: "omit", signal: controller.signal };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      const payload  = await parseResponsePayload(response);
      if (!response.ok) {
        throw new AslAgentApiError(getErrorMessage(payload, response), {
          status: response.status, statusText: response.statusText, url, response: payload
        });
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new AslAgentApiError("ASL Agent request timed out.", { url });
      if (error instanceof AslAgentApiError) throw error;
      throw new AslAgentApiError(`ASL Agent request failed: ${error.message}`, { url });
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience exports (unchanged API surface)
// ---------------------------------------------------------------------------

export async function createClientFromSettings() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.apiKey) {
    throw new Error("ASL Agent base URL and API key must be configured first.");
  }
  return new AslAgentClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
}

export async function getStatus()               { return (await createClientFromSettings()).getStatus(); }
export async function getConnectedNodes()        { return (await createClientFromSettings()).getConnectedNodes(); }
export async function connectNode(n, o = {})     { return (await createClientFromSettings()).connectNode(n, o); }
export async function disconnectNode(n)          { return (await createClientFromSettings()).disconnectNode(n); }
export async function disconnectAll()            { return (await createClientFromSettings()).disconnectAll(); }
export async function sendDtmf(s, o = {})        { return (await createClientFromSettings()).sendDtmf(s, o); }
export async function runMacro(n)                { return (await createClientFromSettings()).runMacro(n); }
export async function getAudit(l = DEFAULT_AUDIT_LINES) { return (await createClientFromSettings()).getAudit(l); }
export async function getVariables()             { return (await createClientFromSettings()).getVariables(); }
export async function lookupNode(n)              { return (await createClientFromSettings()).lookupNode(n); }
export async function getVersion()               { return (await createClientFromSettings()).getVersion(); }
export async function copIdentify()              { return (await createClientFromSettings()).copIdentify(); }
export async function copTime()                  { return (await createClientFromSettings()).copTime(); }
export async function copStatus()                { return (await createClientFromSettings()).copStatus(); }
export async function copVersion()               { return (await createClientFromSettings()).copVersion(); }

// ---------------------------------------------------------------------------
// Validators (unchanged)
// ---------------------------------------------------------------------------

export function normalizeDtmfSequence(value) {
  const sequence = String(value || "").trim();
  if (!sequence) throw new Error("DTMF sequence is required.");
  if (!/^[0-9A-Da-d#*]+$/.test(sequence)) throw new Error("DTMF sequence may only contain 0-9, A-D, *, and #.");
  return sequence.toUpperCase();
}

export function normalizeMacroNumber(value) {
  const macroNumber = String(value || "").trim();
  if (!macroNumber) throw new Error("Macro number is required.");
  if (!/^\d+$/.test(macroNumber)) throw new Error("Macro number must be numeric.");
  return macroNumber;
}

/**
 * Parse RPT_ALINKS into a Set of node numbers currently passing audio (K flag).
 * Format: "count,{node}{flags}[,...]"  e.g. "1,674982TK"
 */
export function parseActiveLinks(alinksStr) {
  const active = new Set();
  if (!alinksStr) return active;
  const raw = String(alinksStr).trim();
  if (!raw || raw === "0") return active;
  const parts = raw.split(",");
  for (let i = 1; i < parts.length; i++) {
    let entry = String(parts[i] || "").trim().toUpperCase();
    if (!entry) continue;
    entry = entry.replace(/^[TRM]/, "");
    const match = entry.match(/^(\d+)([A-Z]*)$/);
    if (!match) continue;
    if (match[2].includes("K")) active.add(match[1]);
  }
  return active;
}

export function normalizeAuditLines(value) {
  const lines = Number(value);
  if (!Number.isInteger(lines) || lines < 1) throw new Error("Audit line count must be a positive integer.");
  return Math.min(lines, 500);
}

export function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

async function parseResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function getErrorMessage(payload, response) {
  if (payload && typeof payload === "object") {
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
  }
  return `ASL Agent returned ${response.status} ${response.statusText}.`;
}
