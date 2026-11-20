// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import { ApiError, api, setUnauthorizedHandler } from '$lib/api/client';
import type { Me, SettingsUpdate } from '$lib/api/types';
import { isLanguage, setLanguage } from '$lib/i18n';
import { isThemePreference, setThemePreference } from '$lib/theme';
import { leaveTo } from '$lib/utils/browser';

// The signed-in user as the API describes it (GET /api/v1/me). The session itself is a
// cookie the browser keeps; this store only mirrors what the server says about it.

export type SessionStatus = 'loading' | 'anonymous' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  me: Me | null;
}

const _session = writable<SessionState>({ status: 'loading', me: null });

export const session = { subscribe: _session.subscribe };
export const me = derived(_session, ($s) => $s.me);
export const permissions = derived(_session, ($s) => $s.me?.permissions ?? []);

/** The effective settings of the user drive theme and language of the whole UI. */
function applySettings(value: Me): void {
  if (isThemePreference(value.settings.theme)) setThemePreference(value.settings.theme);
  if (isLanguage(value.settings.language)) setLanguage(value.settings.language);
}

export function setMe(value: Me): void {
  _session.set({ status: 'ready', me: value });
  applySettings(value);
}

function setAnonymous(): void {
  _session.set({ status: 'anonymous', me: null });
}

// Any request answered with 401 means the session is gone (expired, ended by an
// administrator, signed out in another tab). The app then shows the login page.
setUnauthorizedHandler(() => {
  if (get(_session).status !== 'anonymous') setAnonymous();
});

export async function loadSession(): Promise<void> {
  try {
    setMe(await api.get('/api/v1/me'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setAnonymous();
    } else {
      _session.set({ status: 'error', me: null });
    }
  }
}

/** Re-read the user after something changed that affects permissions or settings. */
export async function refreshMe(): Promise<void> {
  setMe(await api.get('/api/v1/me'));
}

/**
 * Change personal settings. A field sent as null resets it to the default. Concrete
 * values are shown at once and rolled back if the server refuses them.
 */
export async function updateSettings(patch: SettingsUpdate): Promise<void> {
  const before = get(_session).me;
  if (before) {
    const optimistic: Me = {
      ...before,
      // The own choices change exactly as sent (null = back to the default) …
      own_settings: { ...before.own_settings, ...patch },
      // … the effective values only where the new value is known without asking the server.
      settings: {
        ...before.settings,
        ...(patch.theme ? { theme: patch.theme } : {}),
        ...(patch.language ? { language: patch.language } : {}),
        ...(patch.nav_position && !before.settings.nav_position_locked
          ? { nav_position: patch.nav_position }
          : {}),
      },
    };
    setMe(optimistic);
  }
  try {
    setMe(await api.patch('/api/v1/me/settings', { body: patch }));
  } catch (err) {
    if (before && get(_session).status === 'ready') setMe(before);
    throw err;
  }
}

export async function updateProfile(firstName: string, lastName: string): Promise<void> {
  setMe(
    await api.patch('/api/v1/me/profile', {
      body: { first_name: firstName, last_name: lastName },
    }),
  );
}

/**
 * Enter another organization. The answer describes the user in the new context; every
 * request after it acts on the new organization.
 */
export async function switchTenant(tenantId: string): Promise<void> {
  setMe(await api.post('/api/v1/me/active-tenant', { body: { tenant_id: tenantId } }));
}

/**
 * End the session. The backend answers with the address that also ends the session at
 * the identity provider; the browser has to go there (it comes back to /login?signed_out=1).
 */
export async function signOut(): Promise<void> {
  let target = '/login?signed_out=1';
  try {
    const { redirect_url } = await api.post('/api/auth/logout');
    if (redirect_url) target = redirect_url;
  } catch {
    /* already signed out or unreachable: the login page is the right place either way */
  }
  leaveTo(target);
}
