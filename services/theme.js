"use strict";

// ── 10 key color variables exposed to theming ────────────────────────────────
export const THEME_VARS = [
  { key: "--bg",       label: "Background" },
  { key: "--panel",    label: "Panel Surface" },
  { key: "--text",     label: "Text" },
  { key: "--muted",    label: "Muted Text" },
  { key: "--border",   label: "Border" },
  { key: "--accent",   label: "Accent / Primary" },
  { key: "--amber",    label: "Value / Highlight" },
  { key: "--success",  label: "Success" },
  { key: "--warning",  label: "Warning" },
  { key: "--danger",   label: "Danger" },
];

// ── Preset theme definitions ─────────────────────────────────────────────────
// Each preset has a dark and light variant.
// custom: null means no preset -- user-defined colors apply.
export const THEMES = {
  system: { label: "System Default", dark: null, light: null },

  sigcorps: {
    label: "Signal Corps",
    dark: {
      "--bg":      "#1a1a0f",
      "--panel":   "#1e1e10",
      "--text":    "#c8c49a",
      "--muted":   "#7a7660",
      "--border":  "#3a3820",
      "--accent":  "#5c6630",
      "--amber":   "#d4a017",
      "--success": "#6a8c3a",
      "--warning": "#c8820a",
      "--danger":  "#8c3a2a",
    },
    light: {
      "--bg":      "#f0ead8",
      "--panel":   "#e8e0c8",
      "--text":    "#2a2810",
      "--muted":   "#6a6040",
      "--border":  "#b0a870",
      "--accent":  "#4a5228",
      "--amber":   "#a07010",
      "--success": "#3a6010",
      "--warning": "#904800",
      "--danger":  "#6a1a10",
    },
  },

  navy: {
    label: "Dark Navy",
    dark: {
      "--bg":      "#0a0e1a",
      "--panel":   "#0f1629",
      "--text":    "#c8d4e8",
      "--muted":   "#6070a0",
      "--border":  "#1e2a4a",
      "--accent":  "#3b82f6",
      "--amber":   "#60a5fa",
      "--success": "#22c55e",
      "--warning": "#f59e0b",
      "--danger":  "#ef4444",
    },
    light: {
      "--bg":      "#f0f4ff",
      "--panel":   "#e4eaf8",
      "--text":    "#0a1030",
      "--muted":   "#4060a0",
      "--border":  "#b0c0e0",
      "--accent":  "#1d4ed8",
      "--amber":   "#2563eb",
      "--success": "#15803d",
      "--warning": "#b45309",
      "--danger":  "#b91c1c",
    },
  },

  slate: {
    label: "Slate",
    dark: {
      "--bg":      "#0f172a",
      "--panel":   "#1e293b",
      "--text":    "#e2e8f0",
      "--muted":   "#64748b",
      "--border":  "#334155",
      "--accent":  "#38bdf8",
      "--amber":   "#38bdf8",
      "--success": "#34d399",
      "--warning": "#fbbf24",
      "--danger":  "#f87171",
    },
    light: {
      "--bg":      "#f8fafc",
      "--panel":   "#f1f5f9",
      "--text":    "#0f172a",
      "--muted":   "#64748b",
      "--border":  "#cbd5e1",
      "--accent":  "#0284c7",
      "--amber":   "#0284c7",
      "--success": "#059669",
      "--warning": "#d97706",
      "--danger":  "#dc2626",
    },
  },

  highcontrast: {
    label: "High Contrast",
    dark: {
      "--bg":      "#000000",
      "--panel":   "#0a0a0a",
      "--text":    "#ffffff",
      "--muted":   "#aaaaaa",
      "--border":  "#444444",
      "--accent":  "#00ff88",
      "--amber":   "#ffdd00",
      "--success": "#00ee66",
      "--warning": "#ffaa00",
      "--danger":  "#ff3333",
    },
    light: {
      "--bg":      "#ffffff",
      "--panel":   "#f0f0f0",
      "--text":    "#000000",
      "--muted":   "#333333",
      "--border":  "#888888",
      "--accent":  "#0055cc",
      "--amber":   "#884400",
      "--success": "#006600",
      "--warning": "#886600",
      "--danger":  "#cc0000",
    },
  },

  desert: {
    label: "Desert Sand",
    dark: {
      "--bg":      "#1a1208",
      "--panel":   "#231a0c",
      "--text":    "#e8d8b0",
      "--muted":   "#907850",
      "--border":  "#4a3820",
      "--accent":  "#c87020",
      "--amber":   "#e09030",
      "--success": "#608030",
      "--warning": "#c06010",
      "--danger":  "#903030",
    },
    light: {
      "--bg":      "#fdf6e8",
      "--panel":   "#f5e8cc",
      "--text":    "#2a1808",
      "--muted":   "#806040",
      "--border":  "#c0a060",
      "--accent":  "#904010",
      "--amber":   "#804000",
      "--success": "#406010",
      "--warning": "#805000",
      "--danger":  "#801818",
    },
  },

  custom: { label: "Custom", dark: null, light: null },
};

// ── Derived variables computed from the 10 key vars ──────────────────────────
// These fill in the minor variants so everything stays consistent.
function computeDerived(root) {
  const get = (k) => root.getPropertyValue(k).trim();

  const setAlpha = (hex, alpha) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const bg     = get("--bg");
  const panel  = get("--panel");
  const border = get("--border");
  const accent = get("--accent");
  const danger = get("--danger");

  // Only compute if we have valid hex colors
  if (!bg.startsWith("#") || bg.length < 7) return;

  try {
    root.style.setProperty("--panel-soft",   blendHex(panel, bg, 0.5));
    root.style.setProperty("--panel-strong", blendHex(panel, accent, 0.08));
    root.style.setProperty("--panel-inset",  blendHex(bg, "#000000", 0.3));
    root.style.setProperty("--border-soft",  setAlpha(border, 0.22));
    root.style.setProperty("--accent-hover", blendHex(accent, "#ffffff", 0.12));
    root.style.setProperty("--danger-border",setAlpha(danger, 0.45));
    root.style.setProperty("--danger-hover", setAlpha(danger, 0.14));
  } catch { /* skip if color parsing fails */ }
}

function blendHex(hex1, hex2, t) {
  const parse = (h) => [
    parseInt(h.slice(1,3),16),
    parseInt(h.slice(3,5),16),
    parseInt(h.slice(5,7),16),
  ];
  try {
    const [r1,g1,b1] = parse(hex1);
    const [r2,g2,b2] = parse(hex2);
    const r = Math.round(r1 + (r2-r1)*t);
    const g = Math.round(g1 + (g2-g1)*t);
    const b = Math.round(b1 + (b2-b1)*t);
    return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
  } catch { return hex1; }
}

// ── Apply theme to document ──────────────────────────────────────────────────
export function applyTheme(themeSettings) {
  const root = document.documentElement;
  const { preset = "system", mode = "dark", customColors = {} } = themeSettings || {};

  // Determine color-scheme
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolvedMode = preset === "system"
    ? (systemDark ? "dark" : "light")
    : mode;

  root.setAttribute("data-color-scheme", resolvedMode);
  document.documentElement.style.colorScheme = resolvedMode;

  if (preset === "system") {
    // Clear all custom properties -- let CSS :root and media queries handle it
    THEME_VARS.forEach(({ key }) => root.style.removeProperty(key));
    clearDerivedVars(root);
    return;
  }

  if (preset === "custom") {
    THEME_VARS.forEach(({ key }) => {
      const val = customColors[key];
      if (val) root.style.setProperty(key, val);
    });
    computeDerived(root);
    return;
  }

  const themeDef = THEMES[preset];
  if (!themeDef) return;

  const colors = themeDef[resolvedMode] || themeDef.dark;
  if (!colors) return;

  THEME_VARS.forEach(({ key }) => {
    if (colors[key]) root.style.setProperty(key, colors[key]);
  });
  computeDerived(root);
}

function clearDerivedVars(root) {
  [
    "--panel-soft", "--panel-strong", "--panel-inset",
    "--border-soft", "--accent-hover", "--danger-border", "--danger-hover"
  ].forEach((k) => root.style.removeProperty(k));
}

// ── Load theme from storage and apply ────────────────────────────────────────
export async function loadAndApplyTheme() {
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.sync.get({ themeSettings: null }, resolve);
    });
    applyTheme(result.themeSettings);
  } catch {
    // Fail silently -- system default will show
  }
}

// ── Listen for storage changes and re-apply ───────────────────────────────────
export function watchThemeChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.themeSettings) {
      applyTheme(changes.themeSettings.newValue);
    }
  });
}
