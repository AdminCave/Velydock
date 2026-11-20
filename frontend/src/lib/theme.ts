// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import type { ThemePreference } from '$lib/api/types';
import { systemPrefersLight } from '$lib/stores/media';
import { storageGet, storageSet } from '$lib/utils/storage';

export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'velydock-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * The theme actually shown. "system" follows the operating system; anything unknown counts
 * as "system". Dark is the design system's default, so only an explicit light preference
 * (own or the system's) leaves it. public/theme-init.js applies the same rule before the
 * first paint.
 */
export function resolveTheme(
  preference: ThemePreference | null | undefined,
  prefersLight: boolean,
): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersLight ? 'light' : 'dark';
}

function initial(): ThemePreference {
  const stored = storageGet(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

const _preference = writable<ThemePreference>(initial());

export const themePreference = { subscribe: _preference.subscribe };

export const resolvedTheme = derived([_preference, systemPrefersLight], ([$pref, $light]) =>
  resolveTheme($pref, $light),
);

/**
 * Set the theme preference. It is remembered in this browser so the next page load can
 * apply it before the first paint; `persist: false` applies a default without storing it.
 */
export function setThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean } = {},
): void {
  _preference.set(preference);
  if (options.persist !== false) storageSet(THEME_STORAGE_KEY, preference);
}

export function hasStoredTheme(): boolean {
  return isThemePreference(storageGet(THEME_STORAGE_KEY));
}

/** Write the resolved theme to <html> and keep the browser chrome colour in step. */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#17181b');
}

/** Keep <html data-theme> in step with preference and system setting. Returns the stop function. */
export function startThemeSync(): () => void {
  return resolvedTheme.subscribe(applyTheme);
}
