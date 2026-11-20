// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where a key leads inside a group that is a single Tab stop ("roving tabindex"), laid
 * out as a grid with `columns` entries per row. Left and Right walk through all entries
 * and wrap around, Up and Down change the row and stop at the edges, Home and End jump to
 * the first and last entry. Returns the new index, or null for a key that does not move.
 */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  columns: number = 1,
): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  const last = count - 1;
  const step = Math.max(1, Math.floor(columns));
  switch (key) {
    case 'ArrowRight':
      return index === last ? 0 : index + 1;
    case 'ArrowLeft':
      return index === 0 ? last : index - 1;
    case 'ArrowDown':
      return index + step <= last ? index + step : index;
    case 'ArrowUp':
      return index - step >= 0 ? index - step : index;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
