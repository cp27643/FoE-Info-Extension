# Copilot Instructions

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Webpack watch → build/FoE-Info-DEV/
npm run build-foe-info   # Production build + zip → build/FoE-Info_WEBSTORE/
npm run format           # Format with Prettier
npm run check            # Check formatting compliance
```

There are no automated tests. Manual testing requires loading the unpacked extension from `build/FoE-Info-DEV/` in Chrome (Developer Mode → Load unpacked), then opening DevTools on a Forge of Empires game tab.

## Architecture

Chrome/Firefox browser extension (Manifest V3) for Forge of Empires. It injects a DevTools panel that intercepts game API responses and displays stats/analytics.

### Entry Points (webpack bundles)

- `src/js/index.js` — Main app logic, rendered inside `panel.html`. This is the largest file (~110 KB); it creates all DOM containers, sets up the network listener, and routes every intercepted game message.
- `src/js/devtools.js` — Creates the DevTools panel.
- `src/js/options.js` — User settings page.
- `src/js/popup.js` — Extension toolbar popup.

### Data Flow

1. `browser.devtools.network.onRequestFinished` intercepts XHR responses matching `*.forgeofempires.com/game/*` or `*.innogamescdn.com/start/metadata*`.
2. `index.js` (`handleRequestFinished`) parses the JSON body and routes each message by `requestClass` (e.g. `"ResourceService"`, `"GreatBuildingsService"`) to handler functions in `src/js/msg/`.
3. Service modules parse `msg.responseData`, update module-level exported state, and directly write HTML into DOM containers exported from `index.js`.
4. Feature flags in `src/js/vars/showOptions.js` gate each panel section; options persist via `browser.storage.local`.

### Key Directories

- `src/js/msg/` — One service module per game system. Each exports functions that accept raw game API response objects and render results into the panel.
- `src/js/fn/` — Shared utilities:
  - `helper.js` — Formatters (era names, GB names, resource short names)
  - `globals.js` — Global state (`toolOptions`) with per-section size setters
  - `storage.js` — Thin wrapper around `browser.storage.local` (exports `set`, `get`, `remove`)
  - `post.js` — Discord/Google Sheets webhook posting
  - `AddElement.js` — DOM helper functions for collapse icons, copy/post buttons, close buttons
  - `requestIdTracker.js` — Sends signed game API requests from the page context via `chrome.devtools.inspectedWindow.eval()`
  - `collapse.js` — Collapse state toggles for each panel section
- `src/js/vars/` — Feature toggle flags (`showOptions` object)
- `src/i18n/` — Localization JSON files (jQuery i18n). Keys used via `$.i18n('key')`.
- `src/chrome/` — Manifests and HTML templates. `manifest.json` for dev, `manifest_release.json` for webstore, `manifest_firefox.json` for Firefox.

### Manifests

Webpack uses `webpack-extension-manifest-plugin` to merge a base manifest with version from `package.json`. The dev config references `manifest.json`; the webstore build references `manifest_release.json`. Version is injected automatically — don't hardcode it in manifests.

## Conventions

### Formatting

Prettier enforces all style. Config is in `.prettierrc`:

- Single quotes, trailing commas, 2-space indent, `experimentalTernaries` enabled.
- Run `npm run check` to verify, `npm run format` to fix.
- `src/js/fn/constants.js` is excluded from formatting (see `.prettierignore`).

### Module Pattern

- Service modules (`src/js/msg/`) export named functions and mutable state variables (e.g. `export var Resources = []`). State is updated by mutating these module-level vars directly.
- Services import DOM container elements (like `donationDIV`, `goodsDIV`) from `index.js` and write HTML strings into them via `.innerHTML`.
- Feature flags are checked inline before rendering (e.g. `if (showOptions.showGoods) { ... }`).

### UI Rendering

- No virtual DOM. Services build HTML strings with template literals and assign to `.innerHTML` on div containers.
- Bootstrap 5 alert components are the standard panel section wrapper: `<div class="alert alert-success alert-dismissible show collapsed">`.
- Each section follows a pattern: collapse icon + label + copy/post buttons + collapsible content div.
- `AddElement.js` provides `icon()`, `copy()`, `post()`, `close()` helpers for consistent section headers.

### Global State

- `toolOptions` in `globals.js` stores UI sizing preferences, persisted to `browser.storage.local`.
- `showOptions` in `vars/showOptions.js` stores feature toggles as boolean flags.
- Game state (player info, resources, goods, etc.) lives as exported vars in `index.js` and service modules.

### Webpack Globals

Webpack `DefinePlugin` provides:

- `EXT_NAME` — Package name string (`"FoE-Info-DEV"` or `"FoE-Info"`)
- `DEV` — Boolean, true in dev builds
- `WEBSTORE` — Boolean, true in production builds only

Webpack `ProvidePlugin` makes `$`, `jQuery`, and `browser` available globally without imports.

### Dark Mode

DevTools theme is detected via `browser.devtools.panels.themeName`. When `"dark"`, CSS classes `bg-dark` and `text-light` are applied to the body and content containers.

### Localization

jQuery i18n (`@wikimedia/jquery.i18n`). Strings defined in `src/i18n/*.json`. Use `data-i18n="key"` attributes in HTML or `$.i18n('key')` in JS. Add new keys to `en.json` first, then other locale files.

### Active Game Requests (NeighborGBService)

`requestIdTracker.js` can send outgoing game API requests by eval'ing XHR scripts in the inspected page. It auto-discovers the game's version secret (for MD5 request signing) from the ForgeHX Haxe class registry. Scanner requests use requestIds starting at 1,000,000 to avoid collisions with the game client's own counter.

### Copyright Header

Source files include a standard copyright block referencing AGPL license. Preserve it when creating new `.js` files.
