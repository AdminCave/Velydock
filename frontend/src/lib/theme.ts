// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import { ACCENT_TOKENS, accentTokens, normalizeAccent, type AccentTokens } from '$lib/accent';
import type { ThemePreference } from '$lib/api/types';
import { systemPrefersLight } from '$lib/stores/media';
import { storageGet, storageRemove, storageSet } from '$lib/utils/storage';

export type ResolvedTheme = 'light' | 'dark';

/** The theme that applies to the signed-in user: what the next page load paints with. */
export const THEME_STORAGE_KEY = 'velydock-theme';
/**
 * The user's own choice of theme, if they made one. The theme that applies can be the
 * organization's (its default, or fixed for everybody); the login page, where nobody is
 * signed in, shows nothing of an organization and uses this one.
 */
export const OWN_THEME_STORAGE_KEY = 'velydock-theme-own';
/**
 * The default theme of the installation, as the login page last learned it. That is public
 * information and no setting of an organization: without an own choice the login page
 * shows it, from the first paint on.
 */
export const PUBLIC_THEME_STORAGE_KEY = 'velydock-theme-public';
/**
 * The accent colour that applies, with the tokens derived from it for both themes, as JSON:
 * public/theme-init.js sets them before the first paint without knowing how they are made.
 */
export const ACCENT_STORAGE_KEY = 'velydock-accent';

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
 * `own` says what the user chose for themselves (null: nothing), where that is known: the
 * theme that applies may be the organization's.
 */
export function setThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean; own?: ThemePreference | null } = {},
): void {
  _preference.set(preference);
  if (options.persist !== false) storageSet(THEME_STORAGE_KEY, preference);
  if (options.own !== undefined) {
    if (isThemePreference(options.own)) storageSet(OWN_THEME_STORAGE_KEY, options.own);
    else storageRemove(OWN_THEME_STORAGE_KEY);
  }
}

/** Whether this browser holds a theme its user chose (and not one an organization set). */
export function hasOwnTheme(): boolean {
  return isThemePreference(storageGet(OWN_THEME_STORAGE_KEY));
}

/**
 * Nobody is signed in (any more): show the theme the user chose for themselves, else the
 * default of the installation as far as it is known, else follow the system. What an
 * organization set for its members does not apply without a session, and it is not what
 * the next page load paints with either.
 */
export function showOwnTheme(): void {
  const own = storageGet(OWN_THEME_STORAGE_KEY);
  if (isThemePreference(own)) {
    _preference.set(own);
    storageSet(THEME_STORAGE_KEY, own);
  } else {
    const installation = storageGet(PUBLIC_THEME_STORAGE_KEY);
    _preference.set(isThemePreference(installation) ? installation : 'system');
    storageRemove(THEME_STORAGE_KEY);
  }
}

/**
 * The login page has learned the default theme of the installation: it applies there
 * unless the user chose a theme themselves, and is remembered for the next visit of the
 * login page (not as a choice of the user).
 */
export function showPublicTheme(theme: ThemePreference): void {
  storageSet(PUBLIC_THEME_STORAGE_KEY, theme);
  if (!hasOwnTheme()) _preference.set(theme);
}

/** Write the resolved theme to <html> and keep the browser chrome colour in step. */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#17181b');
}

// ── Accent colour ────────────────────────────────────────────────────

/** What is stored for the next page load: the colour and its tokens for both themes. */
interface StoredAccent {
  color: string;
  light: AccentTokens;
  dark: AccentTokens;
}

/**
 * The accent the last page of this browser showed, so that this one starts with it instead
 * of flashing the built-in blue until the server has answered. Not on the login page:
 * nobody is signed in there, and nothing of an organization or a user applies.
 */
function initialAccent(): string | null {
  if (typeof window !== 'undefined' && /^\/login\/?$/.test(window.location.pathname)) return null;
  const stored = storageGet(ACCENT_STORAGE_KEY);
  if (!stored) return null;
  try {
    return normalizeAccent((JSON.parse(stored) as Partial<StoredAccent>).color);
  } catch {
    return null;
  }
}

const _accent = writable<string | null>(initialAccent());

/** The accent colour that applies ("#rrggbb"), or null for the built-in one. */
export const accentColor = { subscribe: _accent.subscribe };

/**
 * Set the accent colour that applies; null (or anything that is no colour) goes back to
 * the built-in one. Remembered like the theme, for the first paint of the next page load.
 */
export function setAccentColor(color: string | null | undefined): void {
  const next = normalizeAccent(color);
  if (next) {
    const stored: StoredAccent = {
      color: next,
      light: accentTokens(next, 'light'),
      dark: accentTokens(next, 'dark'),
    };
    storageSet(ACCENT_STORAGE_KEY, JSON.stringify(stored));
  } else {
    storageRemove(ACCENT_STORAGE_KEY);
  }
  if (next !== get(_accent)) _accent.set(next);
}

/**
 * Write the accent to <html>: the tokens derived from it for the theme on screen as custom
 * properties, and the chosen colour itself as `data-accent`. Without a colour both are
 * removed and the tokens of the style sheet apply again.
 */
export function applyAccent(color: string | null, theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!color) {
    for (const token of ACCENT_TOKENS) root.style.removeProperty(token);
    delete root.dataset.accent;
    return;
  }
  for (const [token, value] of Object.entries(accentTokens(color, theme))) {
    root.style.setProperty(token, value);
  }
  root.dataset.accent = color;
}

/**
 * Keep <html> in step with theme and accent: `data-theme` follows preference and system
 * setting, and the accent is derived anew whenever either changes (its tones depend on
 * the theme). Returns the stop function.
 */
export function startThemeSync(): () => void {
  return derived([resolvedTheme, _accent], (state) => state).subscribe(([theme, accent]) => {
    applyTheme(theme);
    applyAccent(accent, theme);
  });
}
