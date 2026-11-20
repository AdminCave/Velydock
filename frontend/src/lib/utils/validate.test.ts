// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { dayPart, formatDateTime } from './datetime';
import { isHttpUrl, isValidEmail, isValidUsername } from './validate';

describe('isValidUsername', () => {
  it('follows the rules of the API', () => {
    for (const ok of ['ab', 'abc', 'anna', 'user01', 'a.b', 'a-b_c', 'x'.repeat(64)]) {
      expect(isValidUsername(ok), ok).toBe(true);
    }
    for (const bad of ['', 'a', '.ab', 'ab.', 'a b', 'ä12', 'a@b', 'x'.repeat(65)]) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });

  it('ignores case and surrounding spaces like the API does', () => {
    expect(isValidUsername(' Anna ')).toBe(true);
  });
});

describe('isValidEmail', () => {
  it('accepts addresses and rejects everything else', () => {
    expect(isValidEmail('anna@acme.example')).toBe(true);
    expect(isValidEmail(' Anna@Acme.Example ')).toBe(true);
    for (const bad of ['', 'anna', 'anna@', 'anna@acme', '@acme.example', 'a b@acme.example']) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https addresses only', () => {
    expect(isHttpUrl('https://example.org/')).toBe(true);
    expect(isHttpUrl(' http://intranet.local:8080/path?x=1 ')).toBe(true);
    for (const bad of ['', 'example.org', 'ftp://example.org', 'javascript:alert(1)', 'https://']) {
      expect(isHttpUrl(bad), bad).toBe(false);
    }
  });
});

describe('date helpers', () => {
  it('formats in the language of the user and tolerates missing values', () => {
    const iso = '2026-11-20T13:05:00Z';
    expect(formatDateTime(iso, 'de')).toMatch(/20\.11\.2026/);
    expect(formatDateTime(iso, 'en')).toMatch(/20 Nov 2026/);
    expect(formatDateTime(null, 'de')).toBe('');
    expect(formatDateTime('not a date', 'de')).toBe('');
  });

  it('picks the greeting by the hour', () => {
    expect(dayPart(new Date(2026, 0, 1, 7))).toBe('morning');
    expect(dayPart(new Date(2026, 0, 1, 13))).toBe('day');
    expect(dayPart(new Date(2026, 0, 1, 20))).toBe('evening');
    expect(dayPart(new Date(2026, 0, 1, 2))).toBe('evening');
  });
});
