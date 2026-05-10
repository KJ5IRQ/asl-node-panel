# ASL Node Panel

A Chrome side panel extension for monitoring and controlling your AllStarLink node via [ASL3-API](https://github.com/KJ5IRQ/asl3-api). Connects to a FastAPI-based REST middleware running on your ASL3 Raspberry Pi.

**Current version:** v0.6.1  
**Backend required:** ASL3-API v1.3.0+ running on your Pi

---

## Features

### Node Status
- Live node number, callsign, keyups today, connected node count, and uptime
- TX time today and TX time total
- Real-time KEYED indicator (pulses amber when `rxkeyed` is true)
- Node count warning threshold -- alerts when connected count exceeds a configurable limit

### Connect & Control
- Connect to any node by number in Transceive or Monitor-only mode
- Node lookup: type a node number and see callsign + location before connecting
- Disconnect All with confirmation dialog
- Favorites list with one-tap Connect T / Monitor R buttons
- Favorites show live status (linked count, keyed state) from the ASL stats API
- DTMF macro buttons: configure up to 6 one-tap sequences in settings
- Raw DTMF input field for arbitrary sequences

### COP Controls
- Identify, Time, Status, Version -- one-tap buttons that send COP commands to your node

### Schedules
- Auto-connect or auto-disconnect on a weekly schedule (day + UTC time)
- Toggle individual schedules on/off without deleting them
- Next scheduled event shown as a persistent indicator in the panel

### Connected Nodes
- Live list of connected nodes with mode badge (T/R) and callsign when available
- Callsign and location populated from enriched `/nodes?enrich=true` endpoint

### Audit Log
- Last 50 audit entries from the node, auto-refreshed

### Themes
- **System Default** -- follows OS `prefers-color-scheme` automatically via CSS `light-dark()`
- **Signal Corps** -- olive/khaki WW2 Signal Corps aesthetic
- **Dark Navy** -- deep blue, high saturation accents
- **Slate** -- neutral dark/light, clean and modern
- **High Contrast** -- maximum contrast for low-vision users
- **Desert Sand** -- warm tan tones
- **Custom** -- 10 key color pickers for full control (Background, Panel Surface, Text, Muted, Border, Accent, Value/Highlight, Success, Warning, Danger)
- All themes have dark and light variants; toggle in the panel header (☀/☾) or via settings
- Theme applies to both the panel and settings page

### Accessibility
- **Screen Reader Mode** (in Settings > Accessibility)
- When enabled: ARIA live regions announce status changes, errors, and connection events to NVDA, JAWS, VoiceOver, or ChromeVox automatically
- All summary cards have `aria-labelledby` associations
- Both forms have `aria-label` descriptions
- `role="main"` landmark and `role="switch"` on the accessibility toggle
- Enhanced focus rings (3px accent color) and enlarged touch targets when enabled
- Assertive announcements for errors, polite announcements for status changes

### Settings
- Base URL and API key for your ASL3-API instance
- Auto-refresh interval: 5 / 15 / 30 / 60 seconds
- Refresh interval persists and takes effect immediately on next panel load

---

## Requirements

- Chrome 116+
- [ASL3-API](https://github.com/KJ5IRQ/asl3-api) v1.3.0+ running on your ASL3 Pi
- Your Pi's local IP and the API key from your ASL3-API config

---

## Installation

1. Clone or download this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder
5. Click the extension icon or open the Chrome side panel
6. Click the gear icon (⚙) to open Settings
7. Enter your Pi's base URL (e.g. `http://192.168.4.32:8073`) and API key
8. Click **Save Settings**

---

## File Structure

```
asl-node-panel/
  manifest.json         -- Extension manifest (v3), version 0.6.1
  background.js         -- Service worker, side panel registration
  sidepanel.html        -- Panel UI
  sidepanel.js          -- Panel logic, state management, accessibility engine
  sidepanel.css         -- Panel styles, all themes via CSS variables + light-dark()
  options.html          -- Settings page UI
  options.js            -- Settings logic
  options.css           -- Settings page styles
  services/
    api.js              -- ASL3-API client (all endpoints)
    storage.js          -- chrome.storage.sync schema and normalizers
    theme.js            -- Theme engine (applyTheme, loadAndApplyTheme, watchThemeChanges)
```

---

## API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /status` | Node status, uptime, tx time, keyups |
| `GET /variables` | rxkeyed, txkeyed, num_links |
| `GET /nodes?enrich=true` | Connected nodes with callsign/location |
| `GET /audit` | Audit log entries |
| `GET /lookup/{node}` | Node number lookup by callsign/info |
| `GET /version` | API version info |
| `POST /cop/identify` | Play node ID |
| `POST /cop/time` | Say current time |
| `POST /cop/status` | Say system status |
| `POST /cop/version` | Say app_rpt version |
| `POST /connect/{node}` | Connect to a node |
| `POST /disconnect-all` | Disconnect all connected nodes |
| `POST /dtmf` | Send a DTMF sequence |

---

## Version History

| Version | Summary |
|---------|---------|
| v0.1.0 | Initial release -- basic status, connect, favorites, audit |
| v0.2.0 | Fixed normalizeStatus bugs, added /variables polling, keyed indicator, enriched nodes, COP methods, node lookup, renamed to ASL Node Panel |
| v0.3.0 | Collapsible sections, DTMF macros UI, node lookup in connect form, auto-refresh interval setting |
| v0.4.0 | Scheduled auto-connect/disconnect, favorites live status scanning, node stats display (uptime/TX), node count warning |
| v0.5.0 | Full theme system: 6 presets, dark/light variants, custom color pickers, System Default via CSS light-dark(), settings page themed |
| v0.5.1 | CSS architecture rewrite: light-dark() throughout, data-theme attributes, proper light mode |
| v0.5.2 | Light/dark toggle button (☀/☾) in panel header |
| v0.6.0 | Accessibility: Screen Reader Mode, ARIA live regions, aria-labelledby on summary cards, enhanced focus rings |
| v0.6.1 | Fix screen reader mode not applying to panel; added chrome.storage.onChanged watcher and A11Y_CHANGED message |

---

## Development Notes

- The extension uses ES modules (`type="module"` on script tags in HTML)
- `options.js` is a classic IIFE script for compatibility; it cannot import ES modules directly
- Theme is applied via an inline `<script type="module">` in `options.html` that imports `theme.js`
- All settings are stored in `chrome.storage.sync` -- persists across Chrome profiles
- The `services/theme.js` module is shared between the panel and settings page
- Screen reader mode uses `chrome.storage.onChanged` for reliable cross-context communication

---

## License

MIT
