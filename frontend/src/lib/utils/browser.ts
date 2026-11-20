// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Leave the app for another address: a full page navigation, as sign-in and sign-out
 * need it (both pass through the backend and the identity provider).
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
