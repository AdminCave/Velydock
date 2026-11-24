// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Language } from '$lib/i18n';

const LOCALES: Record<Language, string> = { de: 'de-DE', en: 'en-GB' };

/** Date and time in the user's language, e.g. "20.11.2026, 14:05". Empty for no value. */
export function formatDateTime(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.de, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** The day alone, e.g. "20.11.2026": for a validity, where the minute says nothing. */
export function formatDate(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.de, { dateStyle: 'medium' }).format(date);
}

/** Which greeting fits the hour of the day. */
export function dayPart(date: Date = new Date()): 'morning' | 'day' | 'evening' {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'day';
  return 'evening';
}
