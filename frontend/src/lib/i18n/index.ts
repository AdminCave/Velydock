// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import { storageGet, storageSet } from '$lib/utils/storage';
import { translations, type Language } from './dictionaries';

export type { Language } from './dictionaries';
export type TVars = Record<string, string | number | null | undefined>;
export type Translate = (key: string, vars?: TVars) => string;

export const LANGUAGE_STORAGE_KEY = 'velydock-language';
export const DEFAULT_LANGUAGE: Language = 'de';

export function isLanguage(value: unknown): value is Language {
  return value === 'de' || value === 'en';
}

// Before anyone is signed in the language is the one last used in this browser; the login
// page replaces it by the instance default when nothing is stored (see pages/Login.svelte).
function initial(): Language {
  const stored = storageGet(LANGUAGE_STORAGE_KEY);
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

const _language = writable<Language>(initial());

_language.subscribe((lang) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
});

export const language = { subscribe: _language.subscribe };

/** Switch the UI language. `persist: false` applies a default without remembering it. */
export function setLanguage(lang: Language, options: { persist?: boolean } = {}): void {
  _language.set(lang);
  if (options.persist !== false) storageSet(LANGUAGE_STORAGE_KEY, lang);
}

export function hasStoredLanguage(): boolean {
  return isLanguage(storageGet(LANGUAGE_STORAGE_KEY));
}

/**
 * Look a key up. German is the reference language: an unknown language and a key missing
 * in the active language both fall back to German, and a key known nowhere is returned
 * as it is, so a gap shows up as a readable key rather than an empty label.
 */
export function translate(lang: Language, key: string, vars?: TVars): string {
  const dict = translations[lang] ?? translations[DEFAULT_LANGUAGE];
  let text = dict[key] ?? translations[DEFAULT_LANGUAGE][key] ?? key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (_, token: string) => {
      const value = vars[token];
      return value === undefined || value === null ? '' : String(value);
    });
  }
  return text;
}

export function hasMessage(key: string): boolean {
  return key in translations[DEFAULT_LANGUAGE];
}

export const t = derived(
  _language,
  ($lang): Translate =>
    (key, vars) =>
      translate($lang, key, vars),
);

/** One-shot translation outside of components (toasts, document title). */
export function tNow(key: string, vars?: TVars): string {
  return translate(get(_language), key, vars);
}
