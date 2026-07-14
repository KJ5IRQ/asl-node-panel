# Changelog

All notable changes to ASL Node Panel are documented here. Each release also
lists its known limitations; that is now standard practice for every entry,
not just this one.

## v0.9.0 "Faceplate"

A ground-up redesign of the side panel from a stack of scrolling sections into
a radio front panel: a fixed display up top, one scrolling traffic tape in the
middle, and a dock of controls at the bottom. The services layer from v0.8
(REST client, SSE, storage, service-worker schedules) is unchanged; this is a
new presentation layer plus the timeout timer.

### Added
- **Automatic timeout timer (TOT).** When you key up (your node's receiver
  hears you, i.e. your audio is going out to the network), the panel arms a
  countdown ring and re-arms it on every re-key, with no interaction. Amber
  above one minute, warning under a minute, critical under thirty seconds, and
  a TIME-OUT alarm plus a tape entry at zero. Duration is configurable
  (3:00 / 2:30 / 2:00 / off) with optional warning beeps, off by default.
- **Direction-correct on-air readout.** The display distinguishes OUTBOUND
  (you talking out, `rxkeyed`) from INBOUND (a remote station, `txkeyed`),
  because "whose transmitter?" is exactly the ambiguity that trips people up.
  Inbound shows the talker's callsign and a count-up timer; the raw app_rpt
  node state stays in a tooltip.
- **Traffic tape.** One chronological event stream replacing the old Connected
  Nodes list and Audit Log: remote keyups with hold times, your own outbound
  transmissions with their TOT outcome, link connects and drops, DTMF, COP, and
  schedule fires, with All / Keyups / Links / Cmds filters. Seeded from
  `/audit` for pre-open history and persisted to session storage so a panel
  reload mid-net keeps the log.
- **Standby shack clock.** When the node is idle the display shows a ticking
  UTC clock, the node ident, and the next scheduled event.
- **Connected nodes as link chips** in the display, lit when that station
  keys; per-node disconnect lives in a chip popover.
- **The Dock.** Connect, Keypad, Memories, and COP each open a drawer. The
  keypad is the full 16-key DTMF layout with your macros as one-tap chips.
  Memories (favorites) show a busy meter and link count from the stats API and
  a status lamp. Connect has an AllScan-style "disconnect current links first"
  option.
- **Instrument theme**, a radio-faceplate skin (amber phosphor on a near-black
  olive bezel), selectable alongside the existing six presets.

### Known limitations
- The dock sits in normal flow below the tape rather than being rigidly pinned
  to the viewport bottom; the display (the critical readout) is sticky-pinned
  at the top. A fully fixed three-pane layout is a later refinement.
- The tape re-renders on each event (preserving scroll position) rather than
  reconciling rows individually; fine for the 200-row cap.
- The TOT triggers on the node's `rxkeyed` transition as reported by the
  backend; if the panel is opened mid-keyup the arm time is unknown and the
  ring shows `--:--` until the next keyup rather than guessing.
- Requires manual QA in Chrome (load unpacked) before release: this build was
  assembled and unit-tested but not yet exercised against a live node in the
  browser.

## v0.8.0

Correctness and accessibility audit pass, plus several UX additions. This
release touches nearly every file in the extension; the summary below is
grouped by theme rather than by commit.

### Fixed
- Scheduled per-node **Disconnect** was calling Disconnect All instead of
  disconnecting just that node (the worst bug in the audit).
- Favorites live status has never actually worked: it read fields
  (`linked_count`, `connectedNodes`, `keyed`, `rxkeyed`) that do not exist
  on the stats.allstarlink.org response. Fixed to read the real shape
  (`stats.data.links`, `stats.data.keyed`).
- Node number validation was silently dropped in an earlier rewrite;
  restored (1-7 digits).
- Options page **Reset** left macros, schedules, theme, and screen reader
  state rendered on screen even after clearing storage.
- Dragging a custom theme color picker could fire dozens of
  `chrome.storage.sync` writes per second against the ~120 writes/min
  quota; the live preview stays instant, the storage write is now
  debounced.
- `minimum_chrome_version` said 116 but the default theme depends on
  `light-dark()`, which needs Chrome 123. Corrected.
- Dead and duplicated CSS: a `#connectionStatus.live::before` rule that no
  code ever triggers, and two competing `.keyed-badge` definitions;
  consolidated into one theme-variable-driven block.
- Audit log timestamps were parsed with string surgery that only handled
  a `+00:00` offset; now parsed as a real `Date` with a raw-string
  fallback.
- Side panels do not reliably fire `beforeunload`; cleanup now also runs
  on `pagehide`.
- A stats API rate limit (429) was rendered identically to "offline";
  now recognized separately and the last-known value is kept on screen
  instead of being blanked.
- The options page never actually re-themed: its inline `<style>` pinned
  a static dark palette and options.css had no preset rules to select
  from, so changing the theme preset only ever repainted a small preview
  box. The settings page itself is now the preview.
- Six `aria-labelledby` references pointed at IDs that do not exist;
  repointed at the real section toggle button IDs. The COP section's
  `aria-label` said "Courtesy-operation-position"; corrected to
  "Control operator (COP) commands".
- `--muted`/`--faint` failed WCAG AA (>= 4.5:1) against their surfaces in
  every preset except High Contrast; raised minimally, enforced by a new
  contrast test.
- `updateControlAvailability()` disabled every control (including section
  toggles and the theme toggle) while unconfigured or busy, trapping
  keyboard users before they could even collapse a section. Both are now
  exempt, matching the existing Settings button exemption.

### Added
- **Test Connection** button on the options page: checks the base
  URL/API key currently typed into the form (not saved settings) against
  `/status` and `/version`, and saves nothing.
- **Per-node Disconnect** button on each row in Connected Nodes.
- **Actionable errors**: `setFooter()` can append an Open Settings button;
  used when the extension is unconfigured and on any 401/403 API error.
- **SSE gating**: probes `GET /version` before opening the event stream
  and honors its `events_enabled` field, so a wrong API key, an
  unreachable backend, or a backend with events disabled degrades straight
  to polling instead of looping silently; gives up on SSE after 5
  consecutive stream errors; a manual refresh retries the live connection.
- **Bundled fonts**: Share Tech Mono and Oswald (latin subset, woff2) now
  ship in `fonts/` and load via `@font-face` in `themes.css`. Zero
  requests to fonts.googleapis.com or fonts.gstatic.com.
- **Schedules now run in the background service worker** via
  `chrome.alarms`, so they fire even while the side panel is closed.
- Screen Reader Mode now actually applies to the options page, not just
  the panel.
- A `tests/` directory (plain `node:test`, zero dependencies) covering
  the validators in `services/api.js` and `services/storage.js`, plus a
  contrast checker that parses `themes.css` directly and enforces the
  WCAG floor above.

### Changed
- `options.js` converted from a classic IIFE script to an ES module;
  duplicated storage/validation helpers deleted in favor of the single
  copy in `services/storage.js`.
- All theme palettes and `[data-a11y="on"]` rules extracted from
  `sidepanel.css` into a shared `themes.css`, loaded first by both pages.
- Connected-node rows no longer restate the mode badge as a redundant
  "Transceive"/"Receive" label when the backend sends no `info` string.
- The header status line now shows host:port instead of the full base
  URL (which was wrapping in a 400px panel); the full URL is still
  available as a tooltip.
- `FAVORITES_CHANGED` renamed to `SETTINGS_CHANGED` (it always meant
  "settings changed," not just favorites).

### Known limitations
- Schedules require Chrome itself to be running; they cannot fire while
  Chrome is fully closed, only while the panel is closed but Chrome is
  open.
- Live events (SSE) require backend ASL3-API v1.4+; older backends fall
  back to polling automatically.
- The `/events` API key travels as a URL query parameter, an `EventSource`
  limitation (it does not support custom headers). The key will appear in
  the Pi's HTTP access logs.
- No extension icon set is included. Adding an `icons` key to
  `manifest.json` without real, valid PNGs at 16/32/48/128px breaks
  loading unpacked, so none was added. Real icon files are a TODO for a
  future release.

---

## v0.7.1
Fix RX/TX badge always-visible behavior and label mapping.

## v0.7.0
Wire SSE stream, live RX/TX keyed badges, structured audit entries.

## v0.1.0 - v0.6.2
See the Version History table in README.md.

---

## Manual QA checklist (for the owner)

1. Load unpacked at `chrome://extensions`, confirm no errors on the
   extension card, open the panel and options with DevTools console clean.
2. Options: Test Connection with a correct and with a wrong API key; save;
   confirm theme preset changes restyle the whole settings page, not just
   a preview box; confirm Screen Reader Mode enlarges controls on BOTH
   pages; confirm Reset clears the macro/schedule lists immediately.
3. Panel: connect and disconnect a favorite; try the per-node Disc button;
   schedule a connect 2 minutes out, close the panel, and verify it fires
   anyway by checking the node itself (the footer result only shows up if
   the panel happens to be open when it fires).
4. Kill the Pi API, verify status degrades to an actionable error with the
   Open Settings link, then restore it and verify SSE recovers on a
   manual refresh.
5. Put the PC in airplane mode: panel fonts should still render correctly
   (bundled woff2, no network dependency).
