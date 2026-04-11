/*
 * ________________________________________________________________
 * Copyright (C) 2022 FoE-Info - All Rights Reserved
 * this source-code uses a copy-left license
 *
 * you are welcome to contribute changes here:
 * https://github.com/FoE-Info/FoE-Info-Extension
 *
 * AGPL license and info:
 * https://github.com/FoE-Info/FoE-Info-Extension/master/LICENSE.md
 * or else visit https://www.gnu.org/licenses/#AGPL
 * ________________________________________________________________
 */

/*
 * Kit Tracker — Upgrade Kit Inventory Organizer
 *
 * Intercepts InventoryService.getItems and parses all upgrade/selection
 * kits (fragments + assembled). Groups them by building set, detects
 * upgrade tiers (base → silver → golden → platinum), and displays
 * chain completeness so you can see what you have and what's missing.
 */

import { kitTrackerDiv } from '../index.js';
import * as element from '../fn/AddElement';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastInventoryData = null;

// ---------------------------------------------------------------------------
// Tier-prefix flavor words that the game prepends to building names
// at higher tiers. Stripped during grouping so "Mystic Celtic Farmstead"
// and "Celtic Farmstead" merge into one building set.
// ---------------------------------------------------------------------------

const FLAVOR_PREFIXES = new Set([
  'Enchanted',
  'Mystic',
  'Sacred',
  'Fabled',
  'Forgotten',
  'Grand',
  'Majestic',
  'Ascended',
  'Serene',
  'Celestial',
  'Urban',
  'Noble',
  'Ancient',
  'Royal',
  'Exalted',
  'Divine',
  'Sublime',
  'Legendary',
  'Mythic',
  'Radiant',
  'Eternal',
  'Glorious',
  'Illustrious',
  'Magnificent',
  'Resplendent',
]);

// Tier ordering for display
const TIER_ORDER = ['base', 'silver', 'golden', 'platinum'];
const TIER_LABELS = {
  base: 'Base',
  silver: 'Silver',
  golden: 'Golden',
  platinum: 'Platinum',
};
const TIER_COLORS = {
  base: '#6c757d',
  silver: '#adb5bd',
  golden: '#ffc107',
  platinum: '#0dcaf0',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseKitItem(item) {
  const name = item.name || '';
  const isFragment = name.startsWith('Fragment of ');
  const kitName = isFragment ? name.replace('Fragment of ', '') : name;

  let tier = 'base';
  let kitType = 'unknown';

  if (kitName.includes('Golden Upgrade Kit')) {
    tier = 'golden';
    kitType = 'upgrade';
  } else if (kitName.includes('Golden Selection Kit')) {
    tier = 'golden';
    kitType = 'selection';
  } else if (kitName.includes('Silver Upgrade Kit')) {
    tier = 'silver';
    kitType = 'upgrade';
  } else if (kitName.includes('Silver Selection Kit')) {
    tier = 'silver';
    kitType = 'selection';
  } else if (kitName.includes('Platinum Upgrade Kit')) {
    tier = 'platinum';
    kitType = 'upgrade';
  } else if (kitName.includes('Platinum Selection Kit')) {
    tier = 'platinum';
    kitType = 'selection';
  } else if (kitName.includes('Selection Kit')) {
    tier = 'base';
    kitType = 'selection';
  } else if (kitName.includes('Upgrade Kit')) {
    tier = 'base';
    kitType = 'upgrade';
  } else if (kitName.includes('Shrink Kit')) {
    tier = 'base';
    kitType = 'shrink';
  } else {
    return null; // Not a building kit (Self-Aid, Mass Self-Aid, etc.)
  }

  // Extract building name by stripping tier+kit suffix
  const suffixes = [
    'Golden Upgrade Kit',
    'Golden Selection Kit',
    'Silver Upgrade Kit',
    'Silver Selection Kit',
    'Platinum Upgrade Kit',
    'Platinum Selection Kit',
    'Selection Kit',
    'Upgrade Kit',
    'Shrink Kit',
  ];
  let rawBuilding = kitName;
  for (const s of suffixes) {
    if (rawBuilding.endsWith(s)) {
      rawBuilding = rawBuilding.slice(0, -s.length).trim();
      break;
    }
  }

  // Strip flavor prefix to get canonical building name
  const building = stripFlavorPrefix(rawBuilding);

  return {
    originalName: name,
    rawBuilding,
    building,
    tier,
    kitType,
    isFragment,
    count: item.inStock || 1,
  };
}

function stripFlavorPrefix(name) {
  const words = name.split(' ');
  if (words.length > 1 && FLAVOR_PREFIXES.has(words[0])) {
    return words.slice(1).join(' ');
  }
  return name;
}

// ---------------------------------------------------------------------------
// Grouping — merge building names that share a common base
// ---------------------------------------------------------------------------

function groupKitsByBuilding(parsedItems) {
  const groups = {};

  for (const item of parsedItems) {
    if (!groups[item.building]) {
      groups[item.building] = { tiers: {}, kitTypes: new Set() };
    }
    const group = groups[item.building];
    if (!group.tiers[item.tier]) {
      group.tiers[item.tier] = [];
    }
    group.tiers[item.tier].push(item);
    group.kitTypes.add(item.kitType);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderKitTracker() {
  if (!lastInventoryData) {
    kitTrackerDiv.innerHTML = `
      <div class="alert alert-secondary alert-dismissible show" role="alert">
        ${element.close()}
        <p><strong>Kit Tracker</strong></p>
        <p class="mb-0 small">Waiting for inventory data — open your inventory in the game.</p>
      </div>`;
    return;
  }

  // Parse all kit items
  const parsed = [];
  for (const item of lastInventoryData) {
    const name = (item.name || '').toLowerCase();
    if (
      !name.includes('kit') &&
      !name.includes('upgrade') &&
      !name.includes('selection')
    )
      continue;
    const result = parseKitItem(item);
    if (result) parsed.push(result);
  }

  const groups = groupKitsByBuilding(parsed);
  const sortedBuildings = Object.keys(groups).sort();

  // Count stats
  const totalSets = sortedBuildings.length;
  const totalKits = parsed.length;
  const assembled = parsed.filter((p) => !p.isFragment).length;
  const fragments = parsed.filter((p) => p.isFragment).length;

  let html = `
    <div class="alert alert-primary alert-dismissible show" role="alert">
      ${element.close()}
      <p><strong>Kit Tracker</strong> — <small>${totalSets} building sets, ${assembled} assembled kits, ${fragments} fragment stacks</small></p>`;

  if (sortedBuildings.length === 0) {
    html += `<p class="mb-0">No upgrade/selection kits found in inventory.</p>`;
  } else {
    html += `<table class="table table-sm table-borderless mb-0">
      <thead><tr>
        <th>Building</th>
        <th>Type</th>
        <th class="text-center">Base</th>
        <th class="text-center">Silver</th>
        <th class="text-center">Golden</th>
        <th class="text-center">Platinum</th>
      </tr></thead><tbody>`;

    for (const building of sortedBuildings) {
      const group = groups[building];
      const types = [...group.kitTypes].join('/');

      html += `<tr><td class="fw-bold">${building}</td>`;
      html += `<td class="small text-muted">${types}</td>`;

      for (const tier of TIER_ORDER) {
        const items = group.tiers[tier] || [];
        if (items.length === 0) {
          html += `<td class="text-center text-muted">—</td>`;
        } else {
          const parts = items.map((item) => {
            if (item.isFragment) {
              return `<span class="text-warning" title="${item.originalName}">${item.count}🧩</span>`;
            }
            return `<span class="text-success fw-bold" title="${item.originalName}">${item.count}x ✅</span>`;
          });
          html += `<td class="text-center">${parts.join('<br>')}</td>`;
        }
      }

      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>`;
  kitTrackerDiv.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function onInventoryReceived(inventoryData) {
  if (!Array.isArray(inventoryData)) return;
  lastInventoryData = inventoryData;
  renderKitTracker();
}

export function initKitTrackerUI() {
  kitTrackerDiv.innerHTML = `
    <div class="alert alert-secondary alert-dismissible show" role="alert">
      ${element.close()}
      <p><strong>Kit Tracker</strong></p>
      <p class="mb-0 small">Waiting for inventory data — open your inventory in the game.</p>
    </div>`;
}
