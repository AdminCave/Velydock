// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Short names ("slug") of organizations: 2-40 characters, lowercase letters, digits and
// dashes, starting and ending with a letter or digit. Mirrors backend/velydock/schemas.py.

export const SLUG_MAX_LENGTH = 40;
export const RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  'system',
  'master',
  'velydock',
  'www',
];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const TRANSLITERATION: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'o',
  œ: 'oe',
};

/** Suggest a short name for an organization name, e.g. "Müller & Söhne GmbH" → "mueller-soehne-gmbh". */
export function suggestSlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[äöüßæøœ]/g, (ch) => TRANSLITERATION[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

export type SlugProblem = 'format' | 'reserved';

/** Why a short name would be rejected, or null if it is fine. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < 2 || !SLUG_RE.test(slug)) return 'format';
  if (RESERVED_SLUGS.includes(slug)) return 'reserved';
  return null;
}
