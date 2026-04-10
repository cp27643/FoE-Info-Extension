# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start webpack watch (output: build/FoE-Info-DEV/)
npm run build-foe-info  # Production build + zip (output: build/FoE-Info_WEBSTORE/)
npm run format       # Format with Prettier
npm run check        # Check formatting compliance
```

There are no automated tests. Manual testing requires loading the unpacked extension from `build/FoE-Info-DEV/` in Chrome (Developer Mode → Load unpacked).

## Architecture

This is a Chrome/Firefox browser extension (Manifest V3) for the game Forge of Empires. It injects a DevTools panel that intercepts game API responses and displays stats/analytics.

### Entry Points

| Bundle | Source | Purpose |
|--------|--------|---------|
| `devtools` | `src/js/devtools.js` | Creates the DevTools panel |
| `app` | `src/js/index.js` | Main application logic, rendered in `panel.html` |
| `options` | `src/js/options.js` | User settings page |
| `popup` | `src/js/popup.js` | Extension toolbar popup |

### Data Flow

1. The extension intercepts XHR responses from `*.forgeofempires.com/game/*` via the `webRequest` API
2. `index.js` routes incoming game messages to service modules in `src/js/msg/`
3. Each service (e.g. `GreatBuildingsService.js`, `ResourceService.js`) parses the message, updates module-level exported state, and directly manipulates the DOM
4. `src/js/vars/showOptions.js` feature-flags each panel section; options are persisted via `browser.storage.local` (abstracted in `src/js/fn/storage.js`)

### Key Directories

- `src/js/msg/` — Service modules, one per game system (resources, bonuses, guild, battles, etc.). Each exports functions that accept raw game API response objects.
- `src/js/fn/` — Shared utilities: `helper.js` (formatters), `globals.js` (global state + `toolOptions`), `storage.js` (browser storage wrapper), `post.js` (Discord/Google Sheets webhooks), `AddElement.js` (DOM helpers)
- `src/js/vars/` — Feature toggle flags (`showOptions` object)
- `src/i18n/` — Localization strings (jQuery i18n, 8 languages). Keys used via `$.i18n('key')`
- `src/chrome/` — Manifests (`manifest.json` for dev, `manifest_firefox.json`, `manifest_release.json`) and HTML templates

### UI Stack

Bootstrap 5 + jQuery for DOM manipulation. No virtual DOM — services write HTML strings directly into panel `div` elements. SCSS compiled via webpack (`src/css/main.scss` is the root stylesheet). `bignumber.js` handles large game numbers.

### Manifests

Webpack uses `webpack-extension-manifest-plugin` to merge a base manifest with version from `package.json`. The dev config uses `manifest.json`; the webstore build uses `manifest_release.json`.
