// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import themeInit from '../../public/theme-init.js?raw';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  hasStoredTheme,
  resolveTheme,
  resolvedTheme,
  setThemePreference,
  startThemeSync,
  themePreference,
} from './theme';

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
    expect(hasStoredTheme()).toBe(false);
    expect(get(themePreference)).toBe('light');
    setThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(hasStoredTheme()).toBe(true);
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

// public/theme-init.js runs before the app, as a plain script. It must apply the same rule
// as resolveTheme() or the page flashes in the wrong theme.
describe('theme-init.js (before first paint)', () => {
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

  it('survives blocked storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => new Function(themeInit)()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
    getItem.mockRestore();
  });
});
