// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { readable, type Readable } from 'svelte/store';

/** A store that follows a CSS media query live. False where matchMedia is unavailable. */
export function mediaQuery(query: string): Readable<boolean> {
  return readable(false, (set) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    set(list.matches);
    const onChange = (e: MediaQueryListEvent) => set(e.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  });
}

/** Below this width a dock at the left or right edge becomes a bottom bar. */
export const NARROW_QUERY = '(max-width: 720px)';

export const narrowViewport = mediaQuery(NARROW_QUERY);
export const systemPrefersLight = mediaQuery('(prefers-color-scheme: light)');
