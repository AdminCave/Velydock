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
import { normalizeAccent } from '$lib/accent';
import { isThemePreference, setAccentColor, setThemePreference, showOwnTheme } from '$lib/theme';
import { leaveTo, reloadPage } from '$lib/utils/browser';
import { showToast } from './toasts';
import { frames } from './workspace';

// The signed-in user as the API describes it (GET /api/v1/me). The session itself is a
// cookie the browser keeps; this store only mirrors what the server says about it.

export type SessionStatus = 'loading' | 'anonymous' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  me: Me | null;
}

/** A background check does not ask again sooner than this after the last answer. */
export const REVALIDATE_MIN_INTERVAL_MS = 30_000;
/**
 * How often a visible, focused window tells the server that somebody is still there. Well
 * below the shortest idle timeout the server accepts (five minutes), so that one sign of
 * life that is late or left out does not end the session.
 */
export const KEEPALIVE_INTERVAL_MS = 2 * 60_000;
/** The channel on which the tabs of one browser tell each other about their session. */
export const SESSION_CHANNEL = 'velydock-session';

const _session = writable<SessionState>({ status: 'loading', me: null });
const _expired = writable(false);
const _ended = writable(false);

export const session = { subscribe: _session.subscribe };
/**
 * True once a session that was in use has ended (a request was answered 401). The login
 * page then says so; someone who simply is not signed in yet gets no such message.
 */
export const sessionExpired = { subscribe: _expired.subscribe };
/**
 * True while the page is kept although its session is gone: the background check found
 * that out while apps were open in their frames, and leaving for the login page would
 * throw away what somebody is doing in them. The shell then says so and offers the way to
 * the login page (see endedSessionToLogin()); nothing is asked in the background any more.
 */
export const sessionEnded = { subscribe: _ended.subscribe };
export const me = derived(_session, ($s) => $s.me);
export const permissions = derived(_session, ($s) => $s.me?.permissions ?? []);

// Counts every change of the session, so an answer that was overtaken by something newer
// (a saved setting, a switch of the organization, the end of the session) is dropped.
let version = 0;
// When the server last described the user.
let lastRead = 0;
// From the click on "sign out" until the page is left. It is only taken back when the
// sign-out failed: after a successful one nothing may bring this page back to life.
let signingOut = false;
// The API has refused a request since the user was last read (see the handler below).
let refused = false;
// Tells the other tabs of this browser (see startSessionWatch()).
let channel: BroadcastChannel | null = null;

function put(state: SessionState): void {
  version += 1;
  // Every request names the organization this page shows (see TENANT_HEADER). First, so
  // that whatever reacts to the new session at once already speaks for its organization.
  setActiveTenant(state.me?.active_tenant?.id);
  _session.set(state);
  // Nobody is signed in (any more): what applied to the user in their organization, its
  // theme and its accent colour, goes with the session. The login page shows nothing of
  // it. (An error at start-up says nothing about the session: the page stays as painted.)
  if (!state.me && state.status !== 'error') {
    showOwnTheme();
    setAccentColor(null);
  }
}

/**
 * The effective settings of the user drive theme, accent colour and language of the whole
 * UI. Theme and accent are what applies in the active organization (its default, or what
 * it fixed for everybody, or the user's own choice): they follow a switch of the
 * organization and a lock that is set or lifted with the next answer about the user.
 */
function applySettings(value: Me): void {
  if (isThemePreference(value.settings.theme)) {
    setThemePreference(value.settings.theme, { own: value.own_settings.theme ?? null });
  }
  setAccentColor(value.settings.accent_color);
  if (isLanguage(value.settings.language)) setLanguage(value.settings.language);
}

/** Show a user without any word from the server: a change that is still being saved. */
function show(value: Me): void {
  put({ status: 'ready', me: value });
  applySettings(value);
}

/**
 * Put a signed-in user in place, as a fresh page finds one after signing in: nothing of
 * an earlier session is left. The app itself gets its user from the server (see adopt());
 * this is for tests.
 */
export function setMe(value: Me): void {
  signingOut = false;
  refused = false;
  _expired.set(false);
  _ended.set(false);
  show(value);
}

/**
 * Take an answer of the server as the current user. Whichever request brought it: if the
 * user is in another organization than the page showed until now, that is said, and
 * whether something they asked for was not done because of it. Only a switch the user
 * made here (`own`) needs no explanation.
 */
function adopt(value: Me, options: { own?: boolean } = {}): void {
  const current = get(_session);
  const shown = current.status === 'ready';
  const before = current.me?.active_tenant?.id ?? null;
  const wasRefused = refused;
  lastRead = Date.now();
  // An answer about the user proves a live session.
  _expired.set(false);
  _ended.set(false);
  show(value);
  const now = value.active_tenant;
  // Nothing to announce. A refusal that is still unexplained stays that (`refused`): the
  // handler below says it once it knows that no change will be announced in its place.
  if (!shown || options.own || (now?.id ?? null) === before) return;
  refused = false;
  // The page under the user has just changed. This notice stays as long as an error.
  const key = !now
    ? 'session.tenantGone'
    : wasRefused
      ? 'session.tenantChanged.refused'
      : 'session.tenantChanged';
  showToast(tNow(key, { name: now?.name }), 'info', 8000);
}

/**
 * Wait for an answer that describes the user and take it, unless the session changed
 * while the request was under way (another answer arrived, a setting was changed, the
 * session ended). An answer that was overtaken like this may be older than what is on
 * screen: it is dropped, and the user is read once more so that the page ends up with
 * what the server has now.
 *
 * `then` runs right after the answer was taken, in the same tick: before the page gets
 * to render the new user.
 */
async function take(
  ask: () => Promise<Me>,
  options: { own?: boolean; then?: () => void } = {},
): Promise<void> {
  const started = version;
  const value = await ask();
  if (started !== version) {
    void revalidateSession({ fresh: true });
    return;
  }
  adopt(value, options);
  options.then?.();
}

function setAnonymous(): void {
  _ended.set(false);
  put({ status: 'anonymous', me: null });
}

/**
 * The session is gone (a request was answered 401: expired, ended by an administrator,
 * signed out in another tab). The app then shows the login page.
 *
 * With one exception: the check in the background found it out (`inBackground`) while
 * apps are open in their frames. Somebody may be in the middle of something there, and
 * the login page would take it away under their hands. The page then stays as it is and
 * says what happened (see `sessionEnded`).
 */
function sessionGone(inBackground = false): void {
  if (signingOut) return; // signOut() is on its way to the login page already
  const { status } = get(_session);
  if (status === 'anonymous') return;
  if (inBackground && status === 'ready' && get(frames).length > 0) {
    _ended.set(true);
    return;
  }
  if (status === 'ready') _expired.set(true);
  setAnonymous();
}

setUnauthorizedHandler(() => sessionGone());

/**
 * Leave a page that was kept after its session ended (see `sessionEnded`) for the login
 * page, which says that the session has expired and leads back here after signing in.
 */
export function endedSessionToLogin(): void {
  if (!get(_ended)) return;
  _expired.set(true);
  setAnonymous();
}

// The API refused a request because this page acts on another organization than the
// session (switched in another tab, deactivated, membership removed): read the user again.
// The refused call fails with `tenant_changed`. What the user is told about it comes from
// here and nowhere else (showError() keeps quiet about this code), so it is one notice:
// normally the one adopt() shows when the organization turns out to be another one. If
// that does not happen (the read failed, or found the same organization), the refusal
// itself is reported.
setTenantChangedHandler((named) => {
  // Refused for an organization this page has left since (the user switched with the
  // request under way): the page that asked is gone, and nothing is out of date.
  if (named !== (get(_session).me?.active_tenant?.id ?? null)) return;
  refused = true;
  void revalidateSession({ force: true }).then(() => {
    if (!refused) return;
    refused = false;
    // With the session gone the login page explains what happened.
    if (get(_session).status !== 'ready') return;
    showToast(tNow('error.tenant_changed'), 'error');
  });
});

export async function loadSession(): Promise<void> {
  try {
    // The first answer of a fresh page: there is nothing yet that could have overtaken it.
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
  await take(() => api.get('/api/v1/me'));
}

let rereading: Promise<void> | null = null;
// Somebody needs an answer newer than the check that is under way can give (see `fresh`).
let rereadAgain = false;

/** Whether there is a session to check: none while the page waits for a new sign-in. */
function checkable(): boolean {
  return get(_session).status === 'ready' && !get(_ended);
}

/**
 * Check in the background whether the session still is what this page shows: called when
 * the tab becomes visible or the window gets the focus again, as a sign of life while
 * somebody works in an embedded app, when another tab reports a change and when the API
 * reports another organization. It never throws and never asks twice at the same time;
 * without `force` it also keeps quiet shortly after an answer.
 *
 * `fresh` (which implies `force`) is for a caller who knows that something has just
 * changed: the answer must come from a request sent from now on. A check that is under
 * way was sent before that and may not know about it, so one more follows it.
 */
export function revalidateSession(
  options: { force?: boolean; fresh?: boolean } = {},
): Promise<void> {
  if (!checkable()) return Promise.resolve();
  if (rereading) {
    if (options.fresh) rereadAgain = true;
    return rereading;
  }
  // A clock that was set back must not silence the check: only a real "just now" does.
  const since = Date.now() - lastRead;
  const insists = options.force || options.fresh;
  if (!insists && since >= 0 && since < REVALIDATE_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  rereading = (async () => {
    do {
      rereadAgain = false;
      await reread();
    } while (rereadAgain && checkable());
  })().finally(() => {
    rereading = null;
    rereadAgain = false;
  });
  return rereading;
}

async function reread(): Promise<void> {
  const started = version;
  let value: Me;
  try {
    value = await api.get('/api/v1/me', { background: true });
  } catch (err) {
    // 401: the session is gone. Anything else (offline, a restarting server) is not worth
    // a message for a check nobody asked for.
    if (err instanceof ApiError && err.status === 401) sessionGone(true);
    return;
  }
  // Something newer arrived meanwhile, or the session ended: leave it alone.
  if (started !== version || !checkable()) return;
  adopt(value);
}

/** Tell the other tabs of this browser that the session they share has changed. */
function tellOtherTabs(what: 'organization' | 'signed-out'): void {
  try {
    channel?.postMessage(what);
  } catch {
    /* a closed channel: the other tabs find out with their next check */
  }
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(SESSION_CHANNEL);
  } catch {
    return null; // not available here (e.g. a document without an origin of its own)
  }
}

/**
 * Keep the session current while the page stays open. Returns the stop function.
 *
 * - The tab becomes visible again, or the window gets the focus back (two windows side
 *   by side are both visible all the time): check the session, somebody may have
 *   switched the organization or signed out elsewhere.
 * - Another tab of this browser says that it switched the organization or signed out:
 *   check at once. Where the browser has no BroadcastChannel the other triggers remain,
 *   and in any case the API refuses what a page asks for the wrong organization.
 * - Every two minutes, while the window is visible and focused: the same check, which
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
  const onFocus = () => void revalidateSession();
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) reloadPage();
    else void revalidateSession();
  };
  const onMessage = () => void revalidateSession({ fresh: true });
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      void revalidateSession({ force: true });
    }
  }, KEEPALIVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onPageShow);
  const mine = openChannel();
  mine?.addEventListener('message', onMessage);
  channel = mine;
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onPageShow);
    mine?.removeEventListener('message', onMessage);
    mine?.close();
    if (channel === mine) channel = null;
  };
}

/**
 * Change personal settings. A field sent as null resets it to the default. Concrete
 * values are shown at once and rolled back if the server refuses them.
 */
export async function updateSettings(patch: SettingsUpdate): Promise<void> {
  const before = get(_session).me;
  let optimistic: Me | null = null;
  if (before) {
    optimistic = {
      ...before,
      // The own choices change exactly as sent (null = back to the default) …
      own_settings: { ...before.own_settings, ...patch },
      // … the effective values only where the new value is known without asking the
      // server: a concrete choice for a setting the organization has not fixed. (A choice
      // for a fixed one is stored and applies once the lock is lifted; after a reset the
      // server says what applies instead.)
      settings: {
        ...before.settings,
        ...(patch.theme && !before.settings.theme_locked ? { theme: patch.theme } : {}),
        ...(patch.language ? { language: patch.language } : {}),
        ...(patch.nav_position && !before.settings.nav_position_locked
          ? { nav_position: patch.nav_position }
          : {}),
        ...(normalizeAccent(patch.accent_color) && !before.settings.accent_locked
          ? { accent_color: normalizeAccent(patch.accent_color) }
          : {}),
        ...(patch.app_bar && !before.settings.app_bar_locked ? { app_bar: patch.app_bar } : {}),
      },
    };
    show(optimistic);
  }
  try {
    await take(() => api.patch('/api/v1/me/settings', { body: patch }));
  } catch (err) {
    // Take the change back, unless something newer has replaced it meanwhile: then
    // `before` is older than what is on screen.
    if (before && optimistic && get(_session).me === optimistic) show(before);
    throw err;
  }
}

export async function updateProfile(firstName: string, lastName: string): Promise<void> {
  await take(() =>
    api.patch('/api/v1/me/profile', {
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
 *
 * The other tabs of this browser share the session and are told at once.
 */
export async function switchTenant(tenantId: string, onSwitched?: () => void): Promise<void> {
  await take(() => api.post('/api/v1/me/active-tenant', { body: { tenant_id: tenantId } }), {
    own: true,
    then: onSwitched,
  });
  tellOtherTabs('organization');
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
  // back/forward cache, nothing of the ended session is on it. `signingOut` stays set:
  // a request that was under way is answered 401 now, and that must not turn the splash
  // into the login page while the browser is on its way to the identity provider.
  _ended.set(false);
  put({ status: 'loading', me: null });
  tellOtherTabs('signed-out');
  leaveTo(target);
}
