// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, translate } from '$lib/i18n';
import { translations } from '$lib/i18n/dictionaries';
import { ApiError } from './client';
import { KNOWN_ERROR_CODES, errorMessage, fieldErrors } from './errors';

afterEach(() => setLanguage('de', { persist: false }));

// The codes the backend uses (see the API contract).
const BACKEND_CODES = [
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
  'email_failed',
  'smtp_not_configured',
  'smtp_password_required',
  'managed_by_idp',
  'missing_at_idp',
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
  'logo_invalid',
  'logo_too_large',
  'order_mismatch',
  'not_embedded',
  'try_again',
  'unavailable',
  'too_large',
  'rate_limited',
  'idp_unavailable',
  'idp_error',
];

const LOGIN_CODES = [
  'expired',
  'cancelled',
  'state',
  'invalid',
  'account_conflict',
  'account_unsupported',
  'disabled',
  'second_factor_required',
  'idp_unavailable',
];

describe('error texts', () => {
  it('exist for every error code of the API, in both languages', () => {
    for (const code of BACKEND_CODES) {
      expect(KNOWN_ERROR_CODES, code).toContain(code);
      expect(translations.de[`error.${code}`], code).toBeTruthy();
      expect(translations.en[`error.${code}`], code).toBeTruthy();
    }
  });

  it('exist for every sign-in failure reason, in both languages', () => {
    for (const code of LOGIN_CODES) {
      expect(translations.de[`login.error.${code}`], code).toBeTruthy();
      expect(translations.en[`login.error.${code}`], code).toBeTruthy();
    }
  });
});

describe('errorMessage', () => {
  const error = (code: string, details = {}) =>
    new ApiError(400, code, 'English server text', details);

  it('translates the code instead of showing the server text', () => {
    expect(errorMessage(error('username_taken'))).toBe('Dieser Benutzername ist bereits vergeben.');
    setLanguage('en', { persist: false });
    expect(errorMessage(error('username_taken'))).toBe('This username is already in use.');
  });

  it('falls back to a generic message for unknown codes and foreign errors', () => {
    const generic = translate('de', 'error.generic');
    expect(errorMessage(error('brand_new_code'))).toBe(generic);
    expect(errorMessage(new Error('boom'))).toBe(generic);
    expect(errorMessage('boom')).toBe(generic);
    expect(errorMessage(null)).toBe(generic);
  });

  it('names the fields of a validation error', () => {
    const text = errorMessage(
      error('validation', {
        fields: [
          { field: 'username', message: 'x' },
          { field: 'username', message: 'y' },
          { field: 'unknown_field', message: 'z' },
        ],
      }),
    );
    expect(text).toBe('Bitte prüf deine Eingaben. (Benutzername, unknown_field)');
  });

  it('uses the translate function it is given', () => {
    expect(errorMessage(error('forbidden'), (key) => `[${key}]`)).toBe('[error.forbidden]');
  });
});

describe('fieldErrors', () => {
  it('maps field names to the first message each', () => {
    const err = new ApiError(422, 'validation', 'x', {
      fields: [
        { field: 'email', message: 'first' },
        { field: 'email', message: 'second' },
        { field: 'name', message: 'bad' },
      ],
    });
    expect(fieldErrors(err)).toEqual({ email: 'first', name: 'bad' });
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});
