// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { tick } from 'svelte';

/**
 * Put the keyboard focus somewhere sensible after the element that had it has gone (the
 * row that was deleted, a button that is no longer shown). A browser then leaves the
 * focus on `<body>`: the next Tab starts at the top of the page, and a screen reader
 * loses its place.
 *
 * Call it once the new state is in place. It waits for the page to render and does
 * nothing while the focus is on something that is still there. `candidates` are tried in
 * order.
 */
export async function restoreFocus(
  candidates: () => (HTMLElement | null | undefined)[],
): Promise<void> {
  await tick();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
  for (const candidate of candidates()) {
    if (!candidate || !candidate.isConnected || candidate.matches(':disabled')) continue;
    candidate.focus();
    if (document.activeElement === candidate) return;
  }
}

/** Where a row stands in its table (by a `data-*` attribute of the `<tr>`), or -1. */
export function rowIndex(table: Element | null, attribute: string, value: string): number {
  if (!table) return -1;
  return [...table.querySelectorAll('tbody tr')].findIndex(
    (row) => row.getAttribute(attribute) === value,
  );
}

/**
 * After a row was removed: the menu button of the row that stands in its place now, or of
 * the last row if it was the last one.
 */
export function rowMenuAt(table: Element | null, index: number): HTMLElement | null {
  if (!table || index < 0) return null;
  const rows = [...table.querySelectorAll('tbody tr')];
  const row = rows[Math.min(index, rows.length - 1)];
  return row?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null;
}
