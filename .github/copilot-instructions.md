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

- `src/js/msg/` — One service module per game system. Each exports functions that accept raw game API response objects and render results into the panel. Key modules:
  - `NeighborGBService.js` — Hood GB scanner, wave-based parallel transport (`postChunkedBatchRequest`), snipe profit calculation (`calculateProfitableSpots`), Excel export (`exportSpotsToExcel`)
  - `FriendsGBService.js` — Friends GB scanner (imports shared transport + export from NeighborGBService)
  - `GuildGBService.js` — Guild GB 1.9 scanner (break-even calculator with near-completion snipe detection, own Excel export)
  - `ScanAllService.js` — Unified "Scan All" scanner (runs hood/friends/guild sequentially, normalizes results into one table with progress bar)
  - `GBGMonitorService.js` — GBG passive WebSocket monitor
  - `KitTrackerService.js` — Inventory upgrade kit tracker (parses kits by building set and tier)
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

### Active Game Requests (Scanner Transport Layer)

`requestIdTracker.js` can send outgoing game API requests by eval'ing XHR scripts in the inspected page. It auto-discovers the game's version secret (for MD5 request signing) from the ForgeHX Haxe class registry. Scanner requests use requestIds starting at 1,000,000 to avoid collisions with the game client's own counter.

**Transport functions** (in `requestIdTracker.js`):

- `sendJsonRequestAtomic()` — Single signed request via eval + polling.
- `sendBatchRequestAtomic()` — Single batch (up to 5 same-method requests per XHR).
- `sendParallelBatchesAtomic()` — Fires ALL XHRs in one eval call and polls all callback keys in one eval per tick. Dramatically reduces eval round-trips.

**Wave-based parallel scanning** (in `NeighborGBService.js`):

- `postChunkedBatchRequest()` splits requests into chunks of `BATCH_CHUNK_SIZE=5`, groups chunks into waves of `MAX_WAVE_SIZE=20`, fires each wave in parallel via `sendParallelBatchesAtomic()`, and waits `WAVE_GAP_MS=500` between waves to avoid 503 rate limiting.
- 503 errors are automatically retried after a 1s delay.
- Used by both the Hood GB Scanner and Friends GB Scanner.

### Excel Export

All GB scanners (hood, friends, guild, scan all) support exporting results to `.xlsx` using the `exceljs` npm package. `exportSpotsToExcel()` in `NeighborGBService.js` creates a formatted workbook with colored headers, conditional cell formatting (green/red for affordability), auto-filter, and frozen header row. The Friends scanner imports and reuses this function. Guild and Scan All have their own export functions with source-specific columns. Important: use `row.eachCell()` for scoped fills — row-level `.fill` bleeds to all columns.

### Kit Tracker

`KitTrackerService.js` intercepts `InventoryService.getItems` and parses all upgrade/selection kit items from the player's inventory. It groups kits by building name (stripping tier suffixes like "Golden Upgrade Kit" and flavor prefixes like "Mystic", "Enchanted", etc.) and displays a collapsible table showing which tiers (base/silver/golden/platinum) the player has assembled kits or fragments for.

### Scanner Architecture

All three GB scanners (hood, friends, guild) follow a common refactored pattern:

1. **Data function** — Each scanner exports a `scanXxxData(onProgress)` function that returns `{ profitable, total }` without rendering. The `onProgress` callback receives status message strings for progress updates.
2. **Render function** — A separate `showXxxResults()` function takes the profitable spots array and renders the HTML table with collapse, sorting, and Excel export.
3. **Button handler** — A thin wrapper that calls the data function then the render function.
4. **Scan All integration** — `ScanAllService.js` calls the data functions directly, normalizes the different spot formats into unified rows, and renders a combined table.

### Scan All (ScanAllService.js)

Runs hood → friends → guild scans sequentially, merging results into one sortable table with color-coded source badges (Hood=yellow, Friends=blue, Guild=green).

- **Progress bar**: Bootstrap animated striped progress bar with step labels. Uses a lightweight `showProgress()` function that only updates a dedicated progress container — does NOT rebuild the entire DOM on each step.
- **Normalization**: `normalizeSnipeSpots()` and `normalize19Spots()` convert scanner-specific spot objects into unified rows with common fields: source, number, playerName, building, progress, rank, holder, cost, reward, profit, roi, medals, bps.
- **Deduplication**: Keeps best profit per player+building per source.
- **Rendering**: Results panel is appended after the button (not innerHTML replacement) to preserve button state. Results always render expanded.

### Guild GB 1.9 Scanner (GuildGBService.js)

Calculates break-even FP contributions for participating in a 1.9 thread:

- **Thread price**: `Math.round(baseReward * 1.9)` — uses `Math.round` to match game reward rounding.
- **FP needed**: `threadPrice - currentFP` in that rank position.
- **Safety check**: Thread price must >= lock cost (`max(ceil((maxBelowFP + remaining) / 2), currentFP + 1)`) — positions only shown if safe to take.
- **Near-completion snipe**: When `remainingFP < fpNeeded` (building almost done), falls back to lock-cost mode. The effective cost becomes the lock cost instead of the 1.9 price, since you only need to secure the rank before the building levels. These are often the most profitable opportunities (e.g., 2 FP for a 162 FP reward).
- **Profit**: `Math.round(baseReward * userArcMultiplier) - effectiveCost`. At 90% Arc, profit is zero for normal 1.9 fills; above 90% profit is positive.
- **Guild members list**: `guildMembers` exported from `OtherPlayerService.js`, filtered by `is_guild_member`.

### Collapsible Panels

Every panel section uses a standard collapse pattern:

1. Add a `collapseXxx` exported var (default state) in `src/js/fn/collapse.js`.
2. Add a `fCollapseXxx()` toggle function that flips the var and calls `element.updateIcon()`.
3. Add a `case 'collapseXxx'` in the `set()` switch in `collapse.js`.
4. In the service module's render function, use:
   - `<p id="xxxLabel" href="#xxxText" data-bs-toggle="collapse">` with `element.icon('xxxicon', 'xxxText', collapse.collapseXxx)` for the header.
   - `<div id="xxxText" class="collapse ${collapse.collapseXxx == false ? 'show' : ''}">` for the content.
   - Attach `collapse.fCollapseXxx` as a click listener on the label element.

### Copyright Header

Source files include a standard copyright block referencing AGPL license. Preserve it when creating new `.js` files.
