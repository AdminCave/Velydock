// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, slugProblem, suggestSlug } from './slug';

describe('suggestSlug', () => {
  it('lowercases and joins words with dashes', () => {
    expect(suggestSlug('Acme GmbH')).toBe('acme-gmbh');
    expect(suggestSlug('  Admin   Cave  ')).toBe('admin-cave');
  });

  it('transliterates umlauts and strips accents', () => {
    expect(suggestSlug('Müller & Söhne GmbH')).toBe('mueller-soehne-gmbh');
    expect(suggestSlug('Straße Größe Ärzte')).toBe('strasse-groesse-aerzte');
    expect(suggestSlug('Café Señor')).toBe('cafe-senor');
  });

  it('keeps digits and drops everything else', () => {
    expect(suggestSlug('Team 42 (Nord)')).toBe('team-42-nord');
    expect(suggestSlug('a_b.c/d')).toBe('a-b-c-d');
  });

  it('never starts or ends with a dash', () => {
    expect(suggestSlug('--Hallo--')).toBe('hallo');
    expect(suggestSlug('!!!')).toBe('');
  });

  it('is cut to 40 characters without a trailing dash', () => {
    const slug = suggestSlug('a'.repeat(39) + ' b c d');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(suggestSlug('x'.repeat(80))).toHaveLength(40);
  });

  it('produces what the API accepts for ordinary names', () => {
    for (const name of ['Acme GmbH', 'Müller & Söhne', 'Schule am See 3', 'IT']) {
      expect(slugProblem(suggestSlug(name)), name).toBeNull();
    }
  });
});

describe('slugProblem', () => {
  it('accepts valid short names', () => {
    for (const slug of ['ab', 'acme', 'a1', 'team-42', 'a'.repeat(40)]) {
      expect(slugProblem(slug), slug).toBeNull();
    }
  });

  it('rejects wrong formats', () => {
    for (const slug of [
      '',
      'a',
      'Acme',
      '-acme',
      'acme-',
      'ac me',
      'äcme',
      'a_b',
      'a'.repeat(41),
    ]) {
      expect(slugProblem(slug), slug).toBe('format');
    }
  });

  it('rejects reserved names', () => {
    for (const slug of RESERVED_SLUGS) expect(slugProblem(slug), slug).toBe('reserved');
  });
});
