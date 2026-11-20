// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The same rules the API applies (backend/velydock/schemas.py), checked in the form first
// so the explanation is in the user's language and next to the field.

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$|^[a-z0-9]{2,3}$/;
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
