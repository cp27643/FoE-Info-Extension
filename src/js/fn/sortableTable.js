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

// Makes an HTML <table> sortable by clicking column headers.
// Click once for ascending, again for descending. An arrow indicator
// shows the current sort direction.
export function makeSortable(table) {
  const headers = table.querySelectorAll('thead th');
  let currentCol = -1;
  let asc = true;

  headers.forEach((th, colIndex) => {
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.title = 'Click to sort';

    th.addEventListener('click', (e) => {
      // Don't sort when clicking the filter input
      if (e.target.tagName === 'INPUT') return;

      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr'));

      if (currentCol === colIndex) {
        asc = !asc;
      } else {
        currentCol = colIndex;
        asc = true;
      }

      rows.sort((a, b) => {
        const aText = (a.cells[colIndex]?.textContent ?? '').trim();
        const bText = (b.cells[colIndex]?.textContent ?? '').trim();
        const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''));
        const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''));

        let cmp;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          cmp = aNum - bNum;
        } else {
          cmp = aText.localeCompare(bText);
        }
        return asc ? cmp : -cmp;
      });

      for (const row of rows) {
        tbody.appendChild(row);
      }

      // Update arrow indicators
      headers.forEach((h, i) => {
        const existing = h.querySelector('.sort-arrow');
        if (existing) existing.remove();
        if (i === colIndex) {
          const arrow = document.createElement('span');
          arrow.className = 'sort-arrow';
          arrow.textContent = asc ? ' ▲' : ' ▼';
          h.appendChild(arrow);
        }
      });
    });
  });
}

// Adds a small text filter input below each column header.
// Typing filters rows to only show those matching ALL column filters.
export function makeFilterable(table) {
  const thead = table.querySelector('thead');
  if (!thead) return;

  // Add a filter row below the header row
  let filterRow = thead.querySelector('.filter-row');
  if (filterRow) return; // already set up
  filterRow = document.createElement('tr');
  filterRow.className = 'filter-row';

  const headers = thead.querySelectorAll('th');
  const inputs = [];

  headers.forEach((_, colIndex) => {
    const td = document.createElement('th');
    td.style.padding = '2px';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '🔍';
    input.style.cssText =
      'width:100%;font-size:11px;padding:1px 4px;box-sizing:border-box;';
    input.addEventListener('input', () => applyFilters());
    inputs.push(input);
    td.appendChild(input);
    filterRow.appendChild(td);
  });

  thead.appendChild(filterRow);

  function applyFilters() {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    for (const row of rows) {
      let visible = true;
      for (let c = 0; c < inputs.length; c++) {
        const filter = inputs[c].value.toLowerCase().trim();
        if (!filter) continue;
        const cellText = (row.cells[c]?.textContent ?? '').toLowerCase();
        if (!cellText.includes(filter)) {
          visible = false;
          break;
        }
      }
      row.style.display = visible ? '' : 'none';
    }
  }
}
