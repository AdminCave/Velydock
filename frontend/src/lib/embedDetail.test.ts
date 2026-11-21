// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { translate } from '$lib/i18n';
import { translations } from '$lib/i18n/dictionaries';
import { EMBED_DETAIL_CODES, embedDetail } from './embedDetail';

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);
const en = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('en', key, vars);

describe('what the embedding check found', () => {
  it('has a text in both languages for every code the server sends', () => {
    for (const code of EMBED_DETAIL_CODES) {
      expect(translations.de[`embed.detail.${code}`], code).toBeTruthy();
      expect(translations.en[`embed.detail.${code}`], code).toBeTruthy();
      const sent = translations.de[`embed.detail.${code}`].includes('{value}')
        ? `${code}: beispiel.example`
        : code;
      expect(embedDetail(sent, de), code).not.toContain(code);
      expect(embedDetail(sent, de), code).not.toBe(embedDetail(sent, en));
    }
  });

  it('is said in the language of the page', () => {
    expect(embedDetail('private_address', de)).toBe(
      translations.de['embed.detail.private_address'],
    );
    expect(embedDetail('private_address', en)).toBe(
      translations.en['embed.detail.private_address'],
    );
    expect(embedDetail('private_address', de)).not.toMatch(/private network/);
  });

  it('keeps the value the server adds to a code', () => {
    expect(embedDetail("frame_ancestors_blocks: 'self' https://intranet.example", de)).toContain(
      "'self' https://intranet.example",
    );
    expect(embedDetail('redirect_other_host: login.example.org', de)).toContain(
      'login.example.org',
    );
    expect(embedDetail('unreachable: ConnectTimeout', de)).toContain('ConnectTimeout');
    // The same code without a value reads as a sentence of its own.
    expect(embedDetail('unreachable', de)).toBe(translations.de['embed.detail.unreachable']);
    expect(embedDetail('unreachable', de)).not.toMatch(/[{}]|\(\)|: $/);
  });

  it('shows what it does not know as the server sent it', () => {
    expect(embedDetail('quantum_tunnel', de)).toBe('quantum_tunnel');
    // A code whose text is built around a value, sent without one.
    expect(embedDetail('redirect_other_host', de)).toBe('redirect_other_host');
    expect(embedDetail('quantum_tunnel: 42', de)).toBe('quantum_tunnel: 42');
    expect(embedDetail('host name could not be resolved', de)).toBe(
      'host name could not be resolved',
    );
    expect(embedDetail('', de)).toBe('');
    expect(embedDetail(null, de)).toBe('');
  });
});
