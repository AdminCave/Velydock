// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { dayPart, formatDateTime } from './datetime';
import {
  hasForbiddenNameCharacter,
  instanceNameProblem,
  isHttpUrl,
  isValidEmail,
  isValidUsername,
  normalizeName,
  personNameProblem,
} from './validate';

describe('isValidUsername', () => {
  it('follows the rules of the API', () => {
    for (const ok of ['abc', 'a1b', 'anna', 'user01', 'a.b', 'a-b_c', 'x'.repeat(64)]) {
      expect(isValidUsername(ok), ok).toBe(true);
    }
    // At least three characters: the identity provider refuses shorter names.
    for (const bad of ['', 'a', 'ab', '.ab', 'ab.', 'a b', 'ä12', 'a@b', 'x'.repeat(65)]) {
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

describe('names of people', () => {
  it('are compared and sent as the server stores them: one blank between words, none around', () => {
    expect(normalizeName('  Anna   Maria \t Beispiel ')).toBe('Anna Maria Beispiel');
    expect(normalizeName('Anna')).toBe('Anna');
    expect(normalizeName('   ')).toBe('');
  });

  it('may hold letters of any script, hyphens, apostrophes, dots and commas', () => {
    for (const ok of ['Anna-Lena', "O'Brien", 'Jr., Max', 'Zoë Åström', '李小龙', 'José María']) {
      expect(hasForbiddenNameCharacter(ok), ok).toBe(false);
      expect(personNameProblem(ok), ok).toBeNull();
    }
  });

  it('must not hold the characters the identity provider refuses', () => {
    for (const character of '<>&"$%!#?§;*~/\\|^=[]{}()') {
      expect(hasForbiddenNameCharacter(`An${character}na`), character).toBe(true);
    }
    expect(hasForbiddenNameCharacter('An\u0007na')).toBe(true);
    expect(hasForbiddenNameCharacter('An\nna')).toBe(true);
    expect(personNameProblem('Anna <b>')).toBe('validation.personName');
  });

  it('must not be empty, which is said as that and not as a matter of characters', () => {
    expect(personNameProblem('')).toBe('validation.required');
    expect(personNameProblem('   ')).toBe('validation.required');
  });
});

describe('the name of the installation', () => {
  it('may be any text, an ampersand included', () => {
    for (const ok of ['Velydock', 'Müller & Söhne', 'AT&T', 'Stadtwerke – Intranet 🚀', 'a; b']) {
      expect(instanceNameProblem(ok), ok).toBeNull();
    }
  });

  it('must not be empty', () => {
    expect(instanceNameProblem('')).toBe('validation.required');
    expect(instanceNameProblem('  \t ')).toBe('validation.required');
  });

  it('must not read as markup: no angle brackets, no character references', () => {
    for (const bad of [
      '<b>Intranet</b>',
      'a < b',
      'a > b',
      'Intranet &lt;b&gt;',
      'A &amp; B',
      'A &#60; B',
      'A &#x3C; B',
      'A &#X3c; B',
    ]) {
      expect(instanceNameProblem(bad), bad).toBe('systemSettings.instanceName.markup');
    }
  });
});
