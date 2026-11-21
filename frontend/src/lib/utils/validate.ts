// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The same rules the API applies (backend/velydock/schemas.py), checked in the form first
// so the explanation is in the user's language and next to the field.

// 3–64 characters: the identity provider refuses shorter names.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,}$/;

export function isValidUsername(value: string): boolean {
  return USERNAME_RE.test(value.trim().toLowerCase());
}

export function isValidEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

// Characters the identity provider refuses in first and last names (its "person name"
// rule keeps markup out of e-mails and pages); control characters as well.
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const PERSON_NAME_FORBIDDEN = /[<>&"$%!#?§;*~/\\|^=[\]{}()\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** Whether a first or last name contains a character that is not allowed in it. */
export function hasForbiddenNameCharacter(value: string): boolean {
  return PERSON_NAME_FORBIDDEN.test(value);
}

/**
 * A name as the server stores it: runs of blanks, tabs and line breaks are one blank, and
 * none at the edges. Forms compare with this to tell whether something was changed.
 */
export function normalizeName(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

/**
 * What is wrong with a first or last name, as the i18n key of the message, or null. The
 * same rule the API applies; checked on the name as the server would store it.
 */
export function personNameProblem(
  value: string,
): 'validation.required' | 'validation.personName' | null {
  const name = normalizeName(value);
  if (!name) return 'validation.required';
  return hasForbiddenNameCharacter(name) ? 'validation.personName' : null;
}

// "&lt;", "&#60;", "&#x3c;", "&amp;": a character reference. A plain "&" is none.
const CHARACTER_REFERENCE = /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/**
 * What is wrong with a name for the installation, as the i18n key of the message, or null.
 * The identity provider prints this name on its sign-in pages and in its e-mails through
 * an HTML filter, which would turn markup in it into real links or images. The API
 * refuses such names; this is the same rule, so the form can say it before sending.
 */
export function instanceNameProblem(
  value: string,
): 'validation.required' | 'systemSettings.instanceName.markup' | null {
  const name = normalizeName(value);
  if (!name) return 'validation.required';
  if (/[<>]/.test(name) || CHARACTER_REFERENCE.test(name)) {
    return 'systemSettings.instanceName.markup';
  }
  return null;
}
