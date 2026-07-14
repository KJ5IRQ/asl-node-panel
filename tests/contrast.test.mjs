"use strict";

// Enforcement mechanism for the Phase 3.7 contrast floor: parses the live
// theme palettes straight out of themes.css (no hand-copied color tables to
// drift out of sync) and asserts WCAG AA contrast for text-on-surface pairs
// that are otherwise easy to eyeball wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themesCssPath = path.join(__dirname, "..", "themes.css");
const themesCss = readFileSync(themesCssPath, "utf8");

// ---------------------------------------------------------------------------
// WCAG contrast math
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const int = parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// themes.css parsing
// ---------------------------------------------------------------------------

const VARS_OF_INTEREST = ["muted", "faint", "panel", "panel-inset"];

function parseDeclarations(blockBody) {
  const vars = {};
  const re = /--([a-zA-Z-]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(blockBody))) {
    const name = m[1];
    if (VARS_OF_INTEREST.includes(name)) {
      vars[name] = m[2].trim();
    }
  }
  return vars;
}

// The bare `:root { ... }` block (system default palette), matched only when
// nothing but whitespace sits between "root" and "{" -- this excludes every
// `:root[data-theme=...]` block, which has an attribute selector there instead.
function parseSystemDefaultVariants() {
  const match = themesCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "expected a bare :root {} block in themes.css");
  const body = match[1];
  const variants = { "system-light": {}, "system-dark": {} };
  const re = /--([a-zA-Z-]+):\s*light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (!VARS_OF_INTEREST.includes(name)) continue;
    variants["system-light"][name] = m[2].trim();
    variants["system-dark"][name] = m[3].trim();
  }
  return variants;
}

function parsePresetVariants() {
  const variants = {};
  const re = /:root\[data-theme="([a-z]+)"\]\[data-mode="(dark|light)"\]\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(themesCss))) {
    const [, theme, mode, body] = m;
    variants[`${theme}-${mode}`] = parseDeclarations(body);
  }
  return variants;
}

const allVariants = { ...parseSystemDefaultVariants(), ...parsePresetVariants() };

// High Contrast is verified passing AAA already and is intentionally left
// untouched by the Phase 3.7 palette pass -- still assert it here as a
// regression guard, just don't expect to have edited its values.
const variantNames = Object.keys(allVariants).sort();

test("themes.css parsing found all expected palette variants", () => {
  const expected = [
    "system-light", "system-dark",
    "instrument-dark", "instrument-light",
    "sigcorps-dark", "sigcorps-light",
    "navy-dark", "navy-light",
    "slate-dark", "slate-light",
    "highcontrast-dark", "highcontrast-light",
    "desert-dark", "desert-light",
  ].sort();
  assert.deepEqual(variantNames, expected);
});

for (const name of variantNames) {
  test(`${name}: --muted meets WCAG AA (>= 4.5:1) against --panel and --panel-inset`, () => {
    const v = allVariants[name];
    for (const surfaceKey of ["panel", "panel-inset"]) {
      const ratio = contrastRatio(v.muted, v[surfaceKey]);
      assert.ok(
        ratio >= 4.5,
        `${name}: --muted (${v.muted}) vs --${surfaceKey} (${v[surfaceKey]}) = ${ratio.toFixed(2)}:1, need >= 4.5:1`
      );
    }
  });

  test(`${name}: --faint meets WCAG AA (>= 4.5:1) against --panel-inset`, () => {
    const v = allVariants[name];
    const ratio = contrastRatio(v.faint, v["panel-inset"]);
    assert.ok(
      ratio >= 4.5,
      `${name}: --faint (${v.faint}) vs --panel-inset (${v["panel-inset"]}) = ${ratio.toFixed(2)}:1, need >= 4.5:1`
    );
  });
}
