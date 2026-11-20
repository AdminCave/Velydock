// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { derived, get, writable } from 'svelte/store';
import {
  ApiError,
  api,
  setActiveTenant,
  setTenantChangedHandler,
  setUnauthorizedHandler,
} from '$lib/api/client';
import type { Me, SettingsUpdate } from '$lib/api/types';
import { isLanguage, setLanguage, tNow } from '$lib/i18n';
import { isThemePreference, setThemePreference } from '$lib/theme';
import { leaveTo, reloadPage } from '$lib/utils/browser';
import { showToast } from './toasts';

// The signed-in user as the API describes it (GET /api/v1/me). The session itself is a
// cookie the browser keeps; this store only mirrors what the server says about it.

export type SessionStatus = 'loading' | 'anonymous' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  me: Me | null;
}

/** A background check does not ask again sooner than this after the last answer. */
export const REVALIDATE_MIN_INTERVAL_MS = 30_000;
/** How often a visible, focused window tells the server that somebody is still there. */
export const KEEPALIVE_INTERVAL_MS = 5 * 60_000;

const _session = writable<SessionState>({ status: 'loading', me: null });
const _expired = writable(false);

export const session = { subscribe: _session.subscribe };
/**
 * True once a session that was in use has ended (a request was answered 401). The login
 * page then says so; someone who simply is not signed in yet gets no such message.
 */
export const sessionExpired = { subscribe: _expired.subscribe };
export const me = derived(_session, ($s) => $s.me);
export const permissions = derived(_session, ($s) => $s.me?.permissions ?? []);

// Counts every change of the session, so the answer of a background check that was
// overtaken by something newer (a saved setting, a switch of the organization) is dropped.
let version = 0;
// When the server last described the user.
let lastRead = 0;
let signingOut = false;
// The API has refused a request since the user was last read (see the handler below).
let refused = false;

function put(state: SessionState): void {
  version += 1;
  _session.set(state);
  // Every request names the organization this page shows (see TENANT_HEADER).
  setActiveTenant(state.me?.active_tenant?.id);
}

/** The effective settings of the user drive theme and language of the whole UI. */
function applySettings(value: Me): void {
  if (isThemePreference(value.settings.theme)) setThemePreference(value.settings.theme);
  if (isLanguage(value.settings.language)) setLanguage(value.settings.language);
}

export function setMe(value: Me): void {
  put({ status: 'ready', me: value });
  _expired.set(false);
  applySettings(value);
}

/** Take an answer of the server as the current user. */
function adopt(value: Me): void {
  lastRead = Date.now();
  setMe(value);
}

function setAnonymous(): void {
  put({ status: 'anonymous', me: null });
}

// Any request answered with 401 means the session is gone (expired, ended by an
// administrator, signed out in another tab). The app then shows the login page.
setUnauthorizedHandler(() => {
  if (signingOut) return; // signOut() is on its way to the login page already
  const { status } = get(_session);
  if (status === 'anonymous') return;
  if (status === 'ready') _expired.set(true);
  setAnonymous();
});

// The API refused a request because this page acts on another organization than the
// session (switched in another tab, deactivated, membership removed): read the user again.
// The refused call fails with `tenant_changed`; whoever made it reports that.
setTenantChangedHandler(() => {
  refused = true;
  void revalidateSession({ force: true });
});

export async function loadSession(): Promise<void> {
  try {
    adopt(await api.get('/api/v1/me'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setAnonymous();
    } else {
      put({ status: 'error', me: null });
    }
  }
}

/** Re-read the user after something changed that affects permissions or settings. */
export async function refreshMe(): Promise<void> {
  adopt(await api.get('/api/v1/me'));
}

let rereading: Promise<void> | null = null;

/**
 * Check in the background whether the session still is what this page shows: called when
 * the tab becomes visible again, as a sign of life while somebody works in an embedded
 * app, and when the API reports another organization. It never throws and never asks
 * twice at the same time; without `force` it also keeps quiet shortly after an answer.
 */
export function revalidateSession(options: { force?: boolean } = {}): Promise<void> {
  if (get(_session).status !== 'ready') return Promise.resolve();
  if (rereading) return rereading;
  // A clock that was set back must not silence the check: only a real "just now" does.
  const since = Date.now() - lastRead;
  if (!options.force && since >= 0 && since < REVALIDATE_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  rereading = reread().finally(() => {
    rereading = null;
  });
  return rereading;
}

async function reread(): Promise<void> {
  const started = version;
  const before = get(_session).me?.active_tenant?.id ?? null;
  let value: Me;
  try {
    value = await api.get('/api/v1/me');
  } catch {
    // A 401 has ended the session through the handler above. Anything else (offline, a
    // restarting server) is not worth a message for a check nobody asked for.
    return;
  }
  const wasRefused = refused;
  refused = false;
  // Something newer arrived meanwhile, or the session ended: leave it alone.
  if (started !== version || get(_session).status !== 'ready') return;
  adopt(value);
  const now = value.active_tenant;
  if ((now?.id ?? null) !== before) {
    // The page under the user has just changed: say why, and whether something they
    // asked for was not done because of it. This notice stays as long as an error.
    const key = !now
      ? 'session.tenantGone'
      : wasRefused
        ? 'session.tenantChanged.refused'
        : 'session.tenantChanged';
    showToast(tNow(key, { name: now?.name }), 'info', 8000);
  }
}

/**
 * Keep the session current while the page stays open. Returns the stop function.
 *
 * - The tab becomes visible again: check the session (somebody may have switched the
 *   organization or signed out in another tab).
 * - Every few minutes, while the window is visible and focused: the same check, which
 *   also counts as activity. Working inside an embedded app sends no request to
 *   Velydock; without this the session would run into its idle timeout meanwhile.
 * - The page comes back from the browser's back/forward cache: load it anew. The cached
 *   page is exactly what was on screen when it was left, possibly of a session that has
 *   ended since (Back after signing out).
 */
export function startSessionWatch(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void revalidateSession();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) reloadPage();
    else void revalidateSession();
  };
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      void revalidateSession({ force: true });
    }
  }, KEEPALIVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
  };
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
    adopt(await api.patch('/api/v1/me/settings', { body: patch }));
  } catch (err) {
    if (before && get(_session).status === 'ready') setMe(before);
    throw err;
  }
}

export async function updateProfile(firstName: string, lastName: string): Promise<void> {
  adopt(
    await api.patch('/api/v1/me/profile', {
      body: { first_name: firstName, last_name: lastName },
    }),
  );
}

/**
 * Enter another organization. The answer describes the user in the new context; every
 * request after it acts on the new organization.
 *
 * `onSwitched` runs in the same tick as the new user arrives. Navigating there (and not
 * after awaiting this function) keeps the page of the old organization from being
 * mounted once more for the new one.
 */
export async function switchTenant(tenantId: string, onSwitched?: () => void): Promise<void> {
  adopt(await api.post('/api/v1/me/active-tenant', { body: { tenant_id: tenantId } }));
  onSwitched?.();
}

/**
 * End the session. The backend answers with the address that also ends the session at
 * the identity provider; the browser has to go there (it comes back to /login?signed_out=1).
 *
 * A session that is already gone (401) leads to the login page as well. Any other failure
 * means nobody was signed out: that is said, and the page stays.
 */
export async function signOut(): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  let target = '/login?signed_out=1';
  try {
    const answer = await api.post('/api/auth/logout');
    if (answer?.redirect_url) target = answer.redirect_url;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      signingOut = false;
      showToast(tNow('session.signOutFailed'), 'error');
      return;
    }
  }
  // Show the splash before leaving: should the browser bring this page back from its
  // back/forward cache, nothing of the ended session is on it.
  put({ status: 'loading', me: null });
  signingOut = false;
  leaveTo(target);
}
