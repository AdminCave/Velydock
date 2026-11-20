// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { hasMessage, tNow, type Translate } from '$lib/i18n';
import { ApiError } from './client';

/** Error codes of the API that have their own translated text (`error.<code>`). */
export const KNOWN_ERROR_CODES = [
  'not_authenticated',
  'forbidden',
  'not_found',
  'validation',
  'csrf',
  'no_tenant',
  'tenant_changed',
  'username_taken',
  'email_taken',
  'group_name_taken',
  'tenant_slug_taken',
  'tenant_name_taken',
  'tenant_exists',
  'already_member',
  'unknown_group',
  'unknown_user',
  'email_required',
  'smtp_not_configured',
  'self_action',
  'last_system_admin',
  'tenant_protected',
  'confirmation_mismatch',
  'url_required',
  'url_invalid',
  'url_needs_https',
  'content_required',
  'icon_invalid',
  'icon_too_large',
  'order_mismatch',
  'not_embedded',
  'try_again',
  'too_large',
  'rate_limited',
  'idp_unavailable',
  'idp_error',
  'network',
] as const;

/**
 * The text to show for a failed request: the translation of the API's error code, or a
 * generic message for anything unknown. Server messages are English and never shown as
 * the main text; for validation errors the affected fields are appended.
 */
export function errorMessage(err: unknown, translate: Translate = tNow): string {
  if (!(err instanceof ApiError)) return translate('error.generic');
  const key = `error.${err.code}`;
  const base = hasMessage(key) ? translate(key) : translate('error.generic');
  if (err.code === 'validation' && err.fields.length > 0) {
    const names = err.fields.map((f) => fieldLabel(f.field, translate));
    return `${base} (${[...new Set(names)].join(', ')})`;
  }
  return base;
}

function fieldLabel(field: string, translate: Translate): string {
  const key = `field.${field}`;
  return hasMessage(key) ? translate(key) : field;
}

/** Field name → server message, for marking individual form controls. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const f of err.fields) out[f.field] ??= f.message;
  return out;
}
