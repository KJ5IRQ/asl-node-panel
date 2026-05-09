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

export class AslAgentClient {
  constructor({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = normalizeApiKey(apiKey);
    this.timeoutMs = timeoutMs;
  }

  async getStatus() {
    return this.request("/status");
  }

  async getConnectedNodes() {
    return this.request("/nodes");
  }

  async connectNode(node, { monitorOnly = false } = {}) {
    return this.request("/connect", {
      method: "POST",
      body: {
        node: normalizeNodeNumber(node),
        monitor_only: Boolean(monitorOnly)
      }
    });
  }

  async disconnectNode(node) {
    return this.request("/disconnect", {
      method: "POST",
      body: {
        node: normalizeNodeNumber(node)
      }
    });
  }

  async disconnectAll() {
    return this.request("/disconnect-all", {
      method: "POST"
    });
  }

  async sendDtmf(sequence, { confirmed = true } = {}) {
    const normalizedSequence = normalizeDtmfSequence(sequence);

    if (confirmed !== true) {
      throw new Error("DTMF requests must include confirmed: true.");
    }

    return this.request("/dtmf", {
      method: "POST",
      body: {
        sequence: normalizedSequence,
        confirmed: true
      }
    });
  }

  async runMacro(macroNumber) {
    return this.request("/macro", {
      method: "POST",
      body: {
        macro_number: normalizeMacroNumber(macroNumber)
      }
    });
  }

  async getAudit(lines = DEFAULT_AUDIT_LINES) {
    const normalizedLines = normalizeAuditLines(lines);
    return this.request(`/audit?lines=${encodeURIComponent(normalizedLines)}`);
  }

  async request(path, options = {}) {
    const method = options.method || "GET";
    const url = buildUrl(this.baseUrl, path);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const headers = {
      "x-api-key": this.apiKey,
      "Accept": "application/json"
    };

    const fetchOptions = {
      method,
      headers,
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      const payload = await parseResponsePayload(response);

      if (!response.ok) {
        throw new AslAgentApiError(
          getErrorMessage(payload, response),
          {
            status: response.status,
            statusText: response.statusText,
            url,
            response: payload
          }
        );
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new AslAgentApiError("ASL Agent request timed out.", {
          url
        });
      }

      if (error instanceof AslAgentApiError) {
        throw error;
      }

      throw new AslAgentApiError(
        `ASL Agent request failed: ${error.message}`,
        {
          url
        }
      );
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function createClientFromSettings() {
  const settings = await getSettings();

  if (!settings.baseUrl || !settings.apiKey) {
    throw new Error("ASL Agent base URL and API key must be configured first.");
  }

  return new AslAgentClient({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey
  });
}

export async function getStatus() {
  const client = await createClientFromSettings();
  return client.getStatus();
}

export async function getConnectedNodes() {
  const client = await createClientFromSettings();
  return client.getConnectedNodes();
}

export async function connectNode(node, options = {}) {
  const client = await createClientFromSettings();
  return client.connectNode(node, options);
}

export async function disconnectNode(node) {
  const client = await createClientFromSettings();
  return client.disconnectNode(node);
}

export async function disconnectAll() {
  const client = await createClientFromSettings();
  return client.disconnectAll();
}

export async function sendDtmf(sequence, options = {}) {
  const client = await createClientFromSettings();
  return client.sendDtmf(sequence, options);
}

export async function runMacro(macroNumber) {
  const client = await createClientFromSettings();
  return client.runMacro(macroNumber);
}

export async function getAudit(lines = DEFAULT_AUDIT_LINES) {
  const client = await createClientFromSettings();
  return client.getAudit(lines);
}

export function normalizeDtmfSequence(value) {
  const sequence = String(value || "").trim();

  if (!sequence) {
    throw new Error("DTMF sequence is required.");
  }

  if (!/^[0-9A-Da-d#*]+$/.test(sequence)) {
    throw new Error("DTMF sequence may only contain 0-9, A-D, *, and #.");
  }

  return sequence.toUpperCase();
}

export function normalizeMacroNumber(value) {
  const macroNumber = String(value || "").trim();

  if (!macroNumber) {
    throw new Error("Macro number is required.");
  }

  if (!/^\d+$/.test(macroNumber)) {
    throw new Error("Macro number must be numeric.");
  }

  return macroNumber;
}

export function normalizeAuditLines(value) {
  const lines = Number(value);

  if (!Number.isInteger(lines) || lines < 1) {
    throw new Error("Audit line count must be a positive integer.");
  }

  return Math.min(lines, 500);
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = String(path || "").startsWith("/")
    ? path
    : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

async function parseResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text
    };
  }
}

function getErrorMessage(payload, response) {
  if (payload && typeof payload === "object") {
    if (typeof payload.detail === "string") {
      return payload.detail;
    }

    if (typeof payload.message === "string") {
      return payload.message;
    }

    if (typeof payload.error === "string") {
      return payload.error;
    }
  }

  return `ASL Agent returned ${response.status} ${response.statusText}.`;
}