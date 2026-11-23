// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { hasMessage, type Translate } from '$lib/i18n';
import {
  CUSTOM_MIDDLEWARES,
  OPTION_KEYS,
  builtinKey,
  isRateLimit,
  type ProxyTemplate,
} from '$lib/proxy';

// Proxy templates and their settings in words.

/**
 * The name or description of a template. Built-in ones are named here, by their id, in
 * the language of the page; own ones as the system administrator wrote them.
 */
export function templateText(
  template: Pick<ProxyTemplate, 'id' | 'name' | 'description'>,
  part: 'name' | 'text',
  t: Translate,
): string {
  const builtin = builtinKey(template.id);
  const key = `proxy.builtin.${builtin ?? ''}.${part}`;
  if (builtin && hasMessage(key)) return t(key);
  return part === 'name' ? template.name : template.description;
}

/** What a template (or a publication) sets, one short phrase per setting. */
export function optionSummary(options: Record<string, unknown>, t: Translate): string[] {
  const parts: string[] = [];
  for (const key of OPTION_KEYS) {
    if (!(key in options)) continue;
    const value = options[key];
    const label = t(`proxy.option.${key}`);
    if (key === 'rate_limit') {
      parts.push(
        `${label}: ${isRateLimit(value) ? t('proxy.value.rate', { average: value.average }) : t('proxy.value.off')}`,
      );
    } else if (key === 'request_headers' || key === 'response_headers') {
      const names = value && typeof value === 'object' ? Object.keys(value) : [];
      parts.push(`${label}: ${names.length > 0 ? names.join(', ') : t('proxy.value.none')}`);
    } else {
      // "Do not verify the certificate" is on when the option that verifies is off.
      const on = key === 'verify_upstream_tls' ? value === false : value === true;
      parts.push(`${label}: ${t(on ? 'proxy.value.on' : 'proxy.value.off')}`);
    }
  }
  const custom = options[CUSTOM_MIDDLEWARES];
  if (custom && typeof custom === 'object' && Object.keys(custom).length > 0) {
    parts.push(`${t('proxyTemplates.custom.label')}: ${Object.keys(custom).sort().join(', ')}`);
  }
  return parts;
}
