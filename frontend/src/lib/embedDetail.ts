// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { hasMessage, type Translate } from '$lib/i18n';

/** The codes the embed check answers with (backend: services/embedcheck.py). */
export const EMBED_DETAIL_CODES = [
  'no_restriction',
  'xfo_deny',
  'xfo_sameorigin',
  'xfo_conflict',
  'xfo_allow_from_ignored',
  'frame_ancestors_allows',
  'frame_ancestors_blocks',
  'private_address',
  'unresolved',
  'unreachable',
  'redirect_other_host',
  'too_many_redirects',
  'busy',
  'timeout',
  'invalid_address',
  'not_http',
  'credentials',
] as const;

/**
 * What the embed check found, in the user's language. The API sends a code, optionally
 * followed by ": " and a value (a host, the sources of a header). The value is put into
 * the text where the text has a place for it and appended otherwise. A code this version
 * does not know is shown as it came: better than nothing.
 */
export function embedDetail(detail: string | null | undefined, t: Translate): string {
  if (!detail) return '';
  const cut = detail.indexOf(': ');
  const code = cut < 0 ? detail : detail.slice(0, cut);
  const value = cut < 0 ? '' : detail.slice(cut + 2).trim();
  const key = `embed.detail.${code}`;
  if (!/^[a-z_]+$/.test(code) || !hasMessage(key)) return detail;
  const text = t(key, { value });
  if (!value) {
    // A text that is built around a value makes no sentence without one.
    return text === t(key, { value: '…' }) ? text : detail;
  }
  return text.includes(value) ? text : `${text} (${value})`;
}
