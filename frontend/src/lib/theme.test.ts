// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import themeInit from '../../public/theme-init.js?raw';
import { ACCENT_TOKENS, accentTokens } from './accent';
import { navigate } from './router';
import {
  ACCENT_STORAGE_KEY,
  OWN_THEME_STORAGE_KEY,
  PUBLIC_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  accentColor,
  applyAccent,
  applyTheme,
  hasOwnTheme,
  resolveTheme,
  resolvedTheme,
  setAccentColor,
  setThemePreference,
  showOwnTheme,
  showPublicTheme,
  startThemeSync,
  themePreference,
} from './theme';

const root = document.documentElement;
/** The accent tokens that are set on <html> right now. */
const tokensOnPage = () =>
  Object.fromEntries(
    ACCENT_TOKENS.map((token) => [token, root.style.getPropertyValue(token)]).filter(
      ([, value]) => value !== '',
    ),
  );

describe('resolveTheme', () => {
  it('uses an explicit preference whatever the system says', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('follows the system for "system"', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });

  it('treats missing or unknown values as "system", with dark as the default', () => {
    expect(resolveTheme(null, false)).toBe('dark');
    expect(resolveTheme(undefined, true)).toBe('light');
    expect(resolveTheme('sepia' as never, false)).toBe('dark');
  });
});

/** A controllable stand-in for window.matchMedia('(prefers-color-scheme: light)'). */
function stubSystemTheme(initialLight: boolean) {
  let light = initialLight;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return query.includes('prefers-color-scheme: light') ? light : false;
      },
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
        listeners.delete(fn),
    })),
  );
  return (next: boolean) => {
    light = next;
    for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
  };
}

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setThemePreference('system', { persist: false });
  });

  it('writes the resolved theme to <html data-theme>', () => {
    const stop = startThemeSync();
    setThemePreference('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    setThemePreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });

  it('follows the system preference live while set to "system"', () => {
    const setSystemLight = stubSystemTheme(false);
    const stop = startThemeSync();
    setThemePreference('system');
    expect(get(resolvedTheme)).toBe('dark');
    setSystemLight(true);
    expect(get(resolvedTheme)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    setSystemLight(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    // An explicit choice is not moved by the system.
    setThemePreference('dark');
    setSystemLight(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });

  it('remembers the preference for the next page load unless asked not to', () => {
    setThemePreference('light', { persist: false });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(get(themePreference)).toBe('light');
    setThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('keeps apart what applies and what the user chose for themselves', () => {
    // The organization fixed "light"; the user's own choice is "dark".
    setThemePreference('light', { own: 'dark' });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBe('dark');
    expect(hasOwnTheme()).toBe(true);
    // No own choice: the theme that applies is the organization's or the installation's.
    setThemePreference('light', { own: null });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(hasOwnTheme()).toBe(false);
    // Said nothing about it (a default applied by the login page): what is known stays.
    setThemePreference('dark', { own: 'dark' });
    setThemePreference('light', { persist: false });
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBe('dark');
  });

  it('shows the own theme, and forgets the one of the organization, once nobody is signed in', () => {
    stubSystemTheme(false); // before the sync starts: it reads the system once it listens
    const stop = startThemeSync();
    setThemePreference('light', { own: 'dark' });
    expect(root.dataset.theme).toBe('light');
    showOwnTheme();
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    setThemePreference('light', { own: null });
    showOwnTheme();
    expect(get(themePreference)).toBe('system'); // nothing else is known
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    stop();
  });

  it('shows the default of the installation where nobody is signed in and nothing was chosen', () => {
    stubSystemTheme(false);
    const stop = startThemeSync();
    // The login page learns it (public information) …
    showPublicTheme('light');
    expect(root.dataset.theme).toBe('light');
    expect(localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull(); // no choice of the user
    expect(hasOwnTheme()).toBe(false);
    // … a session in an organization that fixed "dark" comes and goes …
    setThemePreference('dark', { own: null });
    expect(root.dataset.theme).toBe('dark');
    showOwnTheme();
    // … and the login page is what it was, without asking the server first.
    expect(root.dataset.theme).toBe('light');
    // An own choice goes before it, here and when the login page learns the default anew.
    setThemePreference('dark', { own: 'dark' });
    showOwnTheme();
    showPublicTheme('light');
    expect(root.dataset.theme).toBe('dark');
    stop();
  });

  it('keeps the browser chrome colour in step', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    applyTheme('light');
    expect(meta.content).toBe('#ffffff');
    applyTheme('dark');
    expect(meta.content).toBe('#17181b');
    meta.remove();
  });
});

describe('accent colour on the page', () => {
  beforeEach(() => {
    localStorage.clear();
    setAccentColor(null);
    setThemePreference('dark', { persist: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccentColor(null);
    applyAccent(null, 'dark');
    setThemePreference('system', { persist: false });
    localStorage.clear();
  });

  it('writes the tokens derived for the theme on screen to <html>, and says which colour applies', () => {
    const stop = startThemeSync();
    expect(root.dataset.accent).toBeUndefined();
    expect(tokensOnPage()).toEqual({});
    setAccentColor('#C2410C');
    expect(get(accentColor)).toBe('#c2410c');
    // The colour that was chosen, for tests and styles; the tokens are what is shown.
    expect(root.dataset.accent).toBe('#c2410c');
    expect(tokensOnPage()).toEqual(accentTokens('#c2410c', 'dark'));
    stop();
  });

  it('derives the tokens anew when the theme changes, also when the system changes it', () => {
    const setSystemLight = stubSystemTheme(false);
    const stop = startThemeSync();
    setThemePreference('system', { persist: false });
    setAccentColor('#facc15');
    expect(tokensOnPage()).toEqual(accentTokens('#facc15', 'dark'));
    setSystemLight(true);
    expect(root.dataset.theme).toBe('light');
    expect(tokensOnPage()).toEqual(accentTokens('#facc15', 'light'));
    expect(tokensOnPage()['--accent']).not.toBe('#facc15'); // yellow on white: made readable
    setThemePreference('dark', { persist: false });
    expect(tokensOnPage()).toEqual(accentTokens('#facc15', 'dark'));
    expect(root.dataset.accent).toBe('#facc15');
    stop();
  });

  it('removes every override when no colour applies, so the built-in accent is back', () => {
    const stop = startThemeSync();
    setAccentColor('#0f766e');
    expect(Object.keys(tokensOnPage())).toHaveLength(ACCENT_TOKENS.length);
    setAccentColor(null);
    expect(tokensOnPage()).toEqual({});
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(root.getAttribute('style') ?? '').not.toContain('--accent');
    stop();
  });

  it('takes anything that is no colour for "none"', () => {
    const stop = startThemeSync();
    setAccentColor('#0f766e');
    for (const nothing of ['red', '#fff', '', undefined]) {
      setAccentColor('#0f766e');
      setAccentColor(nothing);
      expect(get(accentColor), String(nothing)).toBeNull();
      expect(root.hasAttribute('data-accent')).toBe(false);
    }
    stop();
  });

  it('starts with the accent the last page showed, but not on the login page', async () => {
    // What the store holds before the server has answered is read when the module loads.
    const stored = JSON.stringify({
      color: '#c2410c',
      light: accentTokens('#c2410c', 'light'),
      dark: accentTokens('#c2410c', 'dark'),
    });
    const fresh = async () => {
      vi.resetModules();
      localStorage.setItem(ACCENT_STORAGE_KEY, stored);
      return get((await import('./theme')).accentColor);
    };
    navigate('/admin/users', { replace: true });
    expect(await fresh()).toBe('#c2410c');
    // Nobody is signed in on the login page: nothing of a user or an organization applies.
    navigate('/login?expired=1', { replace: true });
    expect(await fresh()).toBeNull();
    navigate('/', { replace: true });
    localStorage.setItem(ACCENT_STORAGE_KEY, 'garbage');
    vi.resetModules();
    expect(get((await import('./theme')).accentColor)).toBeNull();
    localStorage.clear();
  });

  it('remembers the colour with its tokens for the next page load, and forgets it with the colour', () => {
    setAccentColor('#c2410c');
    expect(JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) ?? 'null')).toEqual({
      color: '#c2410c',
      light: accentTokens('#c2410c', 'light'),
      dark: accentTokens('#c2410c', 'dark'),
    });
    setAccentColor(null);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });
});

// public/theme-init.js runs before the app, as a plain script. It must apply the same rule
// as resolveTheme() or the page flashes in the wrong theme.
describe('theme-init.js (before first paint)', () => {
  afterEach(() => {
    navigate('/', { replace: true });
    applyAccent(null, 'dark');
    localStorage.clear();
  });

  function run(stored: string | null, systemLight: boolean): string | undefined {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
    stubSystemTheme(systemLight);
    new Function(themeInit)();
    vi.unstubAllGlobals();
    return document.documentElement.dataset.theme;
  }

  it('agrees with resolveTheme for every combination', () => {
    for (const stored of ['light', 'dark', 'system', null, 'garbage']) {
      for (const systemLight of [true, false]) {
        const expected = resolveTheme(
          stored === 'light' || stored === 'dark' || stored === 'system' ? stored : null,
          systemLight,
        );
        expect(run(stored, systemLight), `${stored}/${systemLight}`).toBe(expected);
      }
    }
  });

  it('applies the stored language to <html lang>', () => {
    localStorage.setItem('velydock-language', 'en');
    new Function(themeInit)();
    expect(document.documentElement.lang).toBe('en');
    localStorage.clear();
    document.documentElement.lang = 'de';
  });

  it('paints with the accent the app stored, in the tones of the theme it resolves', () => {
    for (const [stored, systemLight, theme] of [
      ['light', false, 'light'],
      ['dark', true, 'dark'],
      ['system', true, 'light'],
    ] as const) {
      localStorage.clear();
      applyAccent(null, 'dark');
      // What the app leaves behind (setAccentColor) is what the script reads.
      setAccentColor('#facc15');
      localStorage.setItem(THEME_STORAGE_KEY, stored);
      stubSystemTheme(systemLight);
      applyAccent(null, 'dark');
      new Function(themeInit)();
      vi.unstubAllGlobals();
      expect(root.dataset.theme).toBe(theme);
      expect(root.dataset.accent, stored).toBe('#facc15');
      expect(tokensOnPage(), stored).toEqual(accentTokens('#facc15', theme));
    }
    setAccentColor(null);
  });

  it('sets nothing without a stored accent', () => {
    new Function(themeInit)();
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(tokensOnPage()).toEqual({});
  });

  it('sets nothing from an entry that is not what the app stores', () => {
    const good = {
      color: '#c2410c',
      light: accentTokens('#c2410c', 'light'),
      dark: accentTokens('#c2410c', 'dark'),
    };
    const bad = [
      'not json',
      '"#c2410c"',
      JSON.stringify({ ...good, color: 'red' }),
      JSON.stringify({ ...good, color: '#c2410c"><script>' }),
      JSON.stringify({ color: '#c2410c' }),
      JSON.stringify({
        ...good,
        dark: { ...good.dark, '--accent': 'url(https://evil.example/x)' },
      }),
      JSON.stringify({ ...good, dark: { ...good.dark, '--ring': 'red; background: url(x)' } }),
      JSON.stringify({ ...good, dark: { '--accent': '#c2410c' } }),
    ];
    for (const entry of bad) {
      localStorage.clear();
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      localStorage.setItem(ACCENT_STORAGE_KEY, entry);
      expect(() => new Function(themeInit)(), entry).not.toThrow();
      expect(root.hasAttribute('data-accent'), entry).toBe(false);
      expect(tokensOnPage(), entry).toEqual({});
      expect(root.dataset.theme).toBe('dark'); // the theme is applied all the same
    }
  });

  it('applies nothing of an organization on the login page: no accent, and only the own theme', () => {
    stubSystemTheme(false);
    setAccentColor('#c2410c');
    localStorage.setItem(THEME_STORAGE_KEY, 'light'); // what applied in the organization
    navigate('/login?expired=1', { replace: true });
    applyAccent(null, 'dark');
    new Function(themeInit)();
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(tokensOnPage()).toEqual({});
    expect(root.dataset.theme).toBe('dark'); // no own choice: the system's
    // The default of the installation, as the login page learned it the last time …
    localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, 'light');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('light');
    // … and before it the choice of the user.
    localStorage.setItem(OWN_THEME_STORAGE_KEY, 'dark');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('dark');
    expect(root.hasAttribute('data-accent')).toBe(false);
    localStorage.setItem(OWN_THEME_STORAGE_KEY, 'light');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('light');
    // Any other page is painted as the last one was.
    navigate('/settings', { replace: true });
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.accent).toBe('#c2410c');
    setAccentColor(null);
    vi.unstubAllGlobals();
  });

  it('survives blocked storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => new Function(themeInit)()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
    getItem.mockRestore();
  });
});
