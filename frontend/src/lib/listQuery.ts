// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { get } from 'svelte/store';
import { location, navigate } from '$lib/router';

// Search text, filters and the page number of a list live in the address
// (/admin/users?q=anna&role=member&page=2): a reload keeps them, and so does coming back
// with the browser's Back button.

/** The list state the address carries when a page is opened. */
export function readListQuery(): URLSearchParams {
  return new URLSearchParams(get(location).search);
}

/** A page number from the address: a whole number from 1, else 1. */
export function pageFromQuery(params: URLSearchParams): number {
  const page = Number(params.get('page'));
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * Write the list state into the address. Empty values are left out, so the plain address
 * is the list as it opens. The current history entry is replaced: typing in a search
 * field must not leave one entry per letter behind for Back to walk through.
 */
export function writeListQuery(values: Record<string, string | number | null>): void {
  const current = get(location);
  const params = new URLSearchParams(current.search);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === '') params.delete(name);
    else params.set(name, String(value));
  }
  const search = params.toString();
  const next = current.path + (search ? `?${search}` : '');
  if (next !== current.path + current.search) navigate(next, { replace: true });
}
