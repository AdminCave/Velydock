// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { duplicateKeys, translations } from './dictionaries';
import {
  LANGUAGE_STORAGE_KEY,
  hasMessage,
  hasStoredLanguage,
  language,
  setLanguage,
  t,
  tNow,
  translate,
  type Language,
} from './index';

afterEach(() => {
  localStorage.clear();
  setLanguage('de', { persist: false });
});

describe('translate', () => {
  it('looks a key up in the requested language', () => {
    expect(translate('de', 'action.save')).toBe('Speichern');
    expect(translate('en', 'action.save')).toBe('Save');
  });

  it('interpolates {vars}', () => {
    expect(translate('de', 'pagination.range', { from: 1, to: 25, total: 36 })).toBe('1–25 von 36');
    expect(translate('en', 'users.edit.title', { name: 'Anna' })).toBe('Edit Anna');
  });

  it('renders null, undefined and absent vars as empty, never as a placeholder', () => {
    for (const vars of [{ name: null }, { name: undefined }, { other: 'x' }]) {
      const text = translate('de', 'users.edit.title', vars);
      expect(text).not.toContain('{name}');
      expect(text).not.toMatch(/null|undefined/);
    }
  });

  it('falls back to German for a key missing in the active language', () => {
    const key = 'test.only.de';
    translations.de[key] = 'Nur Deutsch';
    try {
      expect(translate('en', key)).toBe('Nur Deutsch');
    } finally {
      delete translations.de[key];
    }
  });

  it('falls back to German for an unknown language', () => {
    expect(translate('fr' as Language, 'action.save')).toBe('Speichern');
  });

  it('returns the key itself when nothing is known', () => {
    expect(translate('de', 'does.not.exist')).toBe('does.not.exist');
    expect(translate('en', 'does.not.exist', { a: 1 })).toBe('does.not.exist');
    expect(hasMessage('does.not.exist')).toBe(false);
    expect(hasMessage('action.save')).toBe(true);
  });
});

describe('language store', () => {
  it('starts in German and switches at run time', () => {
    expect(get(language)).toBe('de');
    expect(get(t)('nav.signOut')).toBe('Abmelden');
    setLanguage('en');
    expect(get(t)('nav.signOut')).toBe('Sign out');
    expect(tNow('nav.signOut')).toBe('Sign out');
    expect(document.documentElement.lang).toBe('en');
  });

  it('remembers the language unless asked not to', () => {
    setLanguage('en', { persist: false });
    expect(hasStoredLanguage()).toBe(false);
    setLanguage('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(hasStoredLanguage()).toBe(true);
  });
});

describe('dictionaries', () => {
  const de = Object.keys(translations.de).sort();
  const en = Object.keys(translations.en).sort();

  it('have the same keys in both languages', () => {
    expect(en).toEqual(de);
  });

  it('define every key once', () => {
    expect(duplicateKeys()).toEqual([]);
  });

  it('have no empty texts', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const [key, text] of Object.entries(translations[lang])) {
        expect(text.trim(), `${lang}:${key}`).not.toBe('');
      }
    }
  });

  it('use the same placeholders in both languages', () => {
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of de) {
      expect(vars(translations.en[key]), key).toEqual(vars(translations.de[key]));
    }
  });

  it('address the user informally in German', () => {
    // Formal address shows as a capitalized pronoun in the middle of a sentence ("können
    // Sie", "mit Ihrem"); "Sie" at the start of a sentence is just "they".
    for (const [key, text] of Object.entries(translations.de)) {
      expect(text, key).not.toMatch(/[a-zäöüß,] (Sie|Ihre?[mnrs]?|Ihnen)\b/);
    }
  });

  // Every key the source code uses literally must exist, and every key must be used.
  const sources = import.meta.glob(['/src/**/*.svelte', '/src/**/*.ts', '!/src/**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const code = Object.entries(sources)
    .filter(([file]) => !file.includes('/i18n/messages/'))
    .map(([, text]) => text)
    .join('\n');

  it('know every key the code uses literally', () => {
    const used = new Set<string>();
    for (const match of code.matchAll(/(?:\$t|tNow|\bt|translate)\(\s*'([\w.:-]+)'/g)) {
      used.add(match[1]);
    }
    for (const match of code.matchAll(/(?:label|title): '((?:nav|title)\.[\w.]+)'/g)) {
      used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(200);
    const missing = [...used].filter((key) => !hasMessage(key));
    expect(missing).toEqual([]);
  });

  it('contain no dead keys', () => {
    // Keys that are built at run time: `error.${code}`, `role.${role}`, …
    const dynamic = [
      'error.',
      'login.error.',
      'role.',
      'field.',
      'nav.position.',
      'app.type.',
      'apps.type.',
      'apps.permission.',
      'apps.recheck.',
      'audit.action.',
      'settings.theme.',
      'dashboard.greeting.',
    ];
    const dead = de.filter(
      (key) => !dynamic.some((prefix) => key.startsWith(prefix)) && !code.includes(`'${key}'`),
    );
    expect(dead).toEqual([]);
  });
});
