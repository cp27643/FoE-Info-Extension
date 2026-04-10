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

    th.addEventListener('click', () => {
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
