"use strict";

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

export const THEMES = {
  system:       { label: "System Default" },
  sigcorps:     { label: "Signal Corps" },
  navy:         { label: "Dark Navy" },
  slate:        { label: "Slate" },
  highcontrast: { label: "High Contrast" },
  desert:       { label: "Desert Sand" },
  custom:       { label: "Custom" },
};

// ── Core apply function ───────────────────────────────────────────────────────
export function applyTheme(themeSettings) {
  const { preset = "system", mode = "dark", customColors = {} } = themeSettings || {};
  const root = document.documentElement;

  // Clear all custom inline vars first (from previous custom theme)
  THEME_VARS.forEach(({ key }) => root.style.removeProperty(key));

  if (preset === "system") {
    // Pure OS control -- just declare support for both schemes
    root.removeAttribute("data-theme");
    root.removeAttribute("data-mode");
    root.style.colorScheme = "light dark";
    return;
  }

  if (preset === "custom") {
    // Write custom colors as inline vars, no data-theme
    root.removeAttribute("data-theme");
    root.removeAttribute("data-mode");
    // Determine color-scheme from mode
    root.style.colorScheme = mode;
    THEME_VARS.forEach(({ key }) => {
      if (customColors[key]) root.style.setProperty(key, customColors[key]);
    });
    return;
  }

  // Preset: set data attributes, CSS selectors handle the rest
  root.setAttribute("data-theme", preset);
  root.setAttribute("data-mode", mode);
  root.style.colorScheme = mode;
}

// ── Load from storage and apply ───────────────────────────────────────────────
export async function loadAndApplyTheme() {
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.sync.get({ themeSettings: null }, resolve);
    });
    applyTheme(result.themeSettings);
  } catch {
    // Fail silently -- system default shows
  }
}

// ── Watch storage for live changes ────────────────────────────────────────────
export function watchThemeChanges() {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.themeSettings) {
      applyTheme(changes.themeSettings.newValue);
    }
  });
}
