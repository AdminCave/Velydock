// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { api } from '$lib/api/client';
import { errorMessage } from '$lib/api/errors';
import { language, setLanguage } from '$lib/i18n';
import { accentTokens } from '$lib/accent';
import {
  ACCENT_STORAGE_KEY,
  OWN_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  accentColor,
  applyAccent,
  setAccentColor,
  setThemePreference,
  startThemeSync,
  themePreference,
} from '$lib/theme';
import { leaveTo, reloadPage } from '$lib/utils/browser';
import {
  ACME,
  MAIN,
  errorResponse,
  makeApp,
  makeMe,
  stubApi,
  SETTINGS,
  OWN_SETTINGS,
} from '../../test/fixtures';
import {
  KEEPALIVE_INTERVAL_MS,
  REVALIDATE_MIN_INTERVAL_MS,
  SESSION_CHANNEL,
  endedSessionToLogin,
  loadSession,
  me,
  permissions,
  refreshMe,
  revalidateSession,
  session,
  sessionEnded,
  sessionExpired,
  setMe,
  signOut,
  startSessionWatch,
  switchTenant,
  updateProfile,
  updateSettings,
} from './session';
import { clearToasts, showError, toasts } from './toasts';
import {
  activateFrame,
  dropFrame,
  frameReloads,
  frames,
  loadApps,
  reloadFrame,
  resetWorkspace,
  workspace,
} from './workspace';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

const TENANT_HEADER = 'X-Velydock-Tenant';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A BroadcastChannel that stays in this test: what was posted, and a way to receive. */
class FakeChannel {
  static open: FakeChannel[] = [];
  static posted: unknown[] = [];
  private listeners = new Set<(event: MessageEvent) => void>();
  closed = false;
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown) {
    if (this.closed) throw new Error('channel is closed');
    FakeChannel.posted.push(data);
  }
  addEventListener(_: string, listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_: string, listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  close() {
    this.closed = true;
    FakeChannel.open = FakeChannel.open.filter((channel) => channel !== this);
  }
  /** What a message of another tab looks like in this one. */
  receive(data: unknown) {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

beforeEach(() => {
  resetWorkspace();
  localStorage.clear();
  clearToasts();
  vi.mocked(leaveTo).mockClear();
  vi.mocked(reloadPage).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
  setThemePreference('system', { persist: false });
  setAccentColor(null);
  applyAccent(null, 'dark');
});

describe('session', () => {
  it('becomes ready with the signed-in user and applies their settings', async () => {
    stubApi({
      'GET /api/v1/me': () =>
        makeMe({
          permissions: ['workspace:use', 'users:read'],
          settings: {
            ...SETTINGS,
            theme: 'light',
            nav_position: 'top',
            language: 'en',
            nav_position_locked: false,
          },
        }),
    });
    await loadSession();
    expect(get(session).status).toBe('ready');
    expect(get(me)?.user.username).toBe('anna');
    expect(get(permissions)).toEqual(['workspace:use', 'users:read']);
    expect(get(themePreference)).toBe('light');
    expect(get(language)).toBe('en');
    // Remembered for the next page load, before the API has answered.
    expect(localStorage.getItem('velydock-theme')).toBe('light');
    expect(localStorage.getItem('velydock-language')).toBe('en');
  });

  it('becomes anonymous on 401', async () => {
    stubApi({ 'GET /api/v1/me': () => errorResponse(401, 'not_authenticated') });
    await loadSession();
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(permissions)).toEqual([]);
  });

  it('reports an unreachable API as an error, not as "signed out"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await loadSession();
    expect(get(session).status).toBe('error');
  });

  it('drops the session when any later request answers 401', async () => {
    setMe(makeMe());
    stubApi({ 'GET /api/v1/workspace/apps': () => errorResponse(401, 'not_authenticated') });
    await loadApps().catch(() => {});
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    // A session that was in use has ended: the login page will say so.
    expect(get(sessionExpired)).toBe(true);
  });

  it('does not call a first load without a session "expired"', async () => {
    setMe(makeMe());
    stubApi({
      'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }),
      'GET /api/v1/me': () => errorResponse(401, 'not_authenticated'),
    });
    await signOut(); // back to "loading", as on a fresh page
    expect(get(session).status).toBe('loading');
    await loadSession();
    expect(get(session).status).toBe('anonymous');
    expect(get(sessionExpired)).toBe(false);
  });

  it('applies a settings change at once and keeps the server answer', async () => {
    setMe(makeMe());
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const saving = updateSettings({ nav_position: 'right', theme: 'dark' });
    // Before the server has answered:
    expect(get(me)?.settings.nav_position).toBe('right');
    expect(get(me)?.own_settings.nav_position).toBe('right');
    expect(get(themePreference)).toBe('dark');
    release(
      new Response(
        JSON.stringify(
          makeMe({
            settings: {
              ...SETTINGS,
              theme: 'dark',
              nav_position: 'right',
              language: 'de',
              nav_position_locked: false,
            },
            own_settings: { ...OWN_SETTINGS, theme: 'dark', nav_position: 'right', language: null },
          }),
        ),
        { status: 200 },
      ),
    );
    await saving;
    expect(get(me)?.own_settings).toEqual({
      ...OWN_SETTINGS,
      theme: 'dark',
      nav_position: 'right',
    });
  });

  it('sends null to reset a setting and waits for the server to say what applies', async () => {
    setMe(
      makeMe({
        settings: {
          ...SETTINGS,
          theme: 'system',
          nav_position: 'right',
          language: 'de',
          nav_position_locked: false,
        },
        own_settings: { ...OWN_SETTINGS, theme: null, nav_position: 'right', language: null },
      }),
    );
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () =>
        makeMe({
          settings: {
            ...SETTINGS,
            theme: 'system',
            nav_position: 'top',
            language: 'de',
            nav_position_locked: false,
          },
        }),
    });
    await updateSettings({ nav_position: null });
    expect(calls[0].body).toEqual({ nav_position: null });
    expect(calls[0].headers['X-Velydock-CSRF']).toBe('1');
    expect(get(me)?.settings.nav_position).toBe('top');
    expect(get(me)?.own_settings.nav_position).toBeNull();
  });

  it('rolls a refused settings change back', async () => {
    const before = makeMe();
    setMe(before);
    stubApi({ 'PATCH /api/v1/me/settings': () => errorResponse(422, 'validation') });
    await expect(updateSettings({ theme: 'dark', language: 'en' })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(get(me)).toEqual(before);
    expect(get(themePreference)).toBe('system');
    expect(get(language)).toBe('de');
  });

  it('does not move a locked navigation position optimistically', async () => {
    setMe(
      makeMe({
        settings: {
          ...SETTINGS,
          theme: 'system',
          nav_position: 'top',
          language: 'de',
          nav_position_locked: true,
        },
      }),
    );
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const saving = updateSettings({ nav_position: 'left' });
    expect(get(me)?.settings.nav_position).toBe('top');
    release(new Response(JSON.stringify(get(me)), { status: 200 }));
    await saving;
  });

  it('switches the organization with one request and takes its answer as the new user', async () => {
    setMe(makeMe());
    const switched = makeMe({ active_tenant: MAIN, role: 'tenant_admin' });
    const { calls } = stubApi({ 'POST /api/v1/me/active-tenant': () => switched });
    await switchTenant(MAIN.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { tenant_id: MAIN.id } });
    expect(calls[0].headers['X-Velydock-CSRF']).toBe('1');
    expect(get(me)).toEqual(switched);
  });

  it('stays in the current organization when the switch is refused', async () => {
    const before = makeMe();
    setMe(before);
    const onSwitched = vi.fn();
    stubApi({ 'POST /api/v1/me/active-tenant': () => errorResponse(404, 'not_found') });
    await expect(switchTenant(MAIN.id, onSwitched)).rejects.toMatchObject({ code: 'not_found' });
    expect(get(me)).toEqual(before);
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('lets the caller navigate in the same tick as the new organization arrives', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }) });
    const seen: unknown[] = [];
    await switchTenant(MAIN.id, () => seen.push(get(me)?.active_tenant?.id));
    expect(seen).toEqual([MAIN.id]);
  });

  it('runs that callback before anything else gets to react to the new organization', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }) });
    // The page renders in a microtask after the store changed. A callback that only ran
    // once switchTenant() has returned would come after that: too late to navigate.
    const order: string[] = [];
    const unsubscribe = me.subscribe((value) => {
      if (value?.active_tenant?.id === MAIN.id) queueMicrotask(() => order.push('rendered'));
    });
    await switchTenant(MAIN.id, () => order.push('navigated'));
    unsubscribe();
    expect(order).toEqual(['navigated', 'rendered']);
  });

  it('signs out through the address the backend names', async () => {
    setMe(makeMe());
    stubApi({
      'POST /api/auth/logout': () => ({ redirect_url: 'https://idp.example/logout?x=1' }),
    });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('https://idp.example/logout?x=1');
    // The splash, not the signed-in page, is what the browser may keep in its
    // back/forward cache.
    expect(get(session)).toEqual({ status: 'loading', me: null });
  });

  it('falls back to the login page when the answer names no address', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/auth/logout': () => new Response(null, { status: 204 }) });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1');
  });

  it('still leaves for the login page when the session is already gone', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/auth/logout': () => errorResponse(401, 'not_authenticated') });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1');
    // Signing out is no "your session has expired".
    expect(get(sessionExpired)).toBe(false);
    expect(get(toasts)).toEqual([]);
  });

  it.each([
    ['the server fails', () => errorResponse(500, 'error')],
    ['the request is refused', () => errorResponse(403, 'csrf')],
  ])('stays signed in and says so when %s', async (_, answer) => {
    const before = makeMe();
    setMe(before);
    stubApi({ 'POST /api/auth/logout': answer });
    await signOut();
    expect(leaveTo).not.toHaveBeenCalled();
    expect(get(session)).toEqual({ status: 'ready', me: before });
    expect(get(toasts).map((toast) => [toast.kind, toast.message])).toEqual([
      [
        'error',
        'Die Abmeldung hat nicht geklappt, du bist weiterhin angemeldet. Bitte versuch es noch einmal.',
      ],
    ]);
  });

  it('stays signed in when the server cannot be reached, and can try again', async () => {
    setMe(makeMe());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await signOut();
    expect(leaveTo).not.toHaveBeenCalled();
    expect(get(session).status).toBe('ready');
    stubApi({ 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1');
  });

  it('sends one sign-out, however often it is asked for', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }),
    });
    await Promise.all([signOut(), signOut()]); // a double click
    expect(calls).toHaveLength(1);
    expect(leaveTo).toHaveBeenCalledTimes(1);
    await signOut(); // and it stays that way once the page is on its way out
    expect(calls).toHaveLength(1);
    expect(leaveTo).toHaveBeenCalledTimes(1);
  });

  it('stays on its way out when a request that was under way is answered 401 afterwards', async () => {
    setMe(makeMe());
    stubApi({
      'POST /api/auth/logout': () => ({ redirect_url: 'https://idp.example/logout' }),
      'GET /api/v1/admin/groups': () => errorResponse(401, 'not_authenticated'),
      'GET /api/v1/me': () => errorResponse(401, 'not_authenticated'),
    });
    await signOut();
    // The answers that come now: the session is gone on the server.
    await api.get('/api/v1/admin/groups').catch(() => {});
    await api.get('/api/v1/me', { background: true }).catch(() => {});
    // Still the splash. "anonymous" would put the login page with its button on screen
    // while the browser is on its way to the identity provider, and a click there would
    // stop it from getting there.
    expect(get(session)).toEqual({ status: 'loading', me: null });
    expect(get(sessionExpired)).toBe(false);
  });

  it('is a clean start for the user a later sign-in brings', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    await signOut();
    const next = makeMe({ active_tenant: MAIN });
    stubApi({
      'GET /api/v1/me': () => next,
      'GET /api/v1/admin/groups': () => errorResponse(401, 'not_authenticated'),
    });
    await loadSession();
    expect(get(session)).toEqual({ status: 'ready', me: next });
    expect(get(toasts)).toEqual([]); // the first user a page finds is no "changed organization"
  });
});

describe('answers that arrive out of order', () => {
  it('drops an older answer about the user and asks again, so the page ends up with what holds now', async () => {
    setMe(makeMe()); // Acme
    const inMain = makeMe({ active_tenant: MAIN });
    let release: (response: Response) => void = () => {};
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        sent.push(`${init.method} ${url}`);
        if (url === '/api/v1/me' && sent.filter((s) => s === 'GET /api/v1/me').length === 1) {
          return new Promise<Response>((resolve) => (release = resolve));
        }
        return Promise.resolve(ok(inMain));
      }),
    );
    const reading = refreshMe(); // e.g. after an organization was renamed
    await switchTenant(MAIN.id); // the user enters Admin Cave; the server has answered
    expect(get(me)).toEqual(inMain);
    release(ok(makeMe())); // the answer to the earlier read: still Acme
    await reading;
    expect(get(me)).toEqual(inMain);
    // One more read, because the dropped answer might have been the newer one.
    await vi.waitFor(() =>
      expect(sent).toEqual(['GET /api/v1/me', 'POST /api/v1/me/active-tenant', 'GET /api/v1/me']),
    );
    await revalidateSession();
    expect(get(me)).toEqual(inMain);
    expect(get(toasts)).toEqual([]);
  });

  it('does not take a failed settings change back over something newer', async () => {
    setMe(makeMe()); // Acme
    const inMain = makeMe({ active_tenant: MAIN });
    let answerPatch: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/v1/me/settings'
          ? new Promise<Response>((resolve) => (answerPatch = resolve))
          : Promise.resolve(ok(inMain)),
      ),
    );
    const saving = updateSettings({ theme: 'light' }).catch((err: unknown) => err);
    expect(get(me)?.settings.theme).toBe('light'); // shown at once
    await revalidateSession({ force: true }); // meanwhile the session moved to Admin Cave
    expect(get(me)).toEqual(inMain);
    answerPatch(new Response('Bad Gateway', { status: 502 }));
    expect(await saving).toMatchObject({ status: 502 });
    // Rolling back would put the user of before the change in place: still in Acme.
    expect(get(me)).toEqual(inMain);
  });

  it('drops the answer to a switch that the end of the session overtook', async () => {
    setMe(makeMe());
    let answerSwitch: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/v1/me/active-tenant'
          ? new Promise<Response>((resolve) => (answerSwitch = resolve))
          : Promise.resolve(errorResponse(401, 'not_authenticated')),
      ),
    );
    const onSwitched = vi.fn();
    const switching = switchTenant(MAIN.id, onSwitched);
    await api.get('/api/v1/admin/groups').catch(() => {}); // 401: the session has ended
    answerSwitch(ok(makeMe({ active_tenant: MAIN })));
    await switching;
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(onSwitched).not.toHaveBeenCalled();
  });
});

describe('the organization a page acts on', () => {
  it('is named in every request and left out while there is none', async () => {
    setMe(makeMe());
    const { calls } = stubApi({ 'GET /api/v1/workspace/apps': () => [] });
    await loadApps();
    expect(calls[0].headers[TENANT_HEADER]).toBe(ACME.id);
    setMe(makeMe({ active_tenant: null, role: null, permissions: [] }));
    await loadApps();
    expect(TENANT_HEADER in calls[1].headers).toBe(false);
  });

  it('is in place before anything gets to react to the new session', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }),
      'GET /api/v1/admin/groups': () => [],
    });
    // Somebody who asks the API the moment the new organization shows up in the store.
    const asked: Promise<unknown>[] = [];
    const unsubscribe = me.subscribe((value) => {
      if (value?.active_tenant?.id === MAIN.id) asked.push(api.get('/api/v1/admin/groups'));
    });
    await switchTenant(MAIN.id);
    unsubscribe();
    await Promise.all(asked);
    expect(calls.map((call) => [call.url, call.headers[TENANT_HEADER]])).toEqual([
      ['/api/v1/me/active-tenant', ACME.id],
      ['/api/v1/admin/groups', MAIN.id],
    ]);
  });

  it('follows a switch, and is forgotten with the session', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }),
      'GET /api/v1/workspace/apps': () => [],
      'GET /api/v1/admin/groups': () => errorResponse(401, 'not_authenticated'),
      'GET /api/v1/public': () => ({}),
    });
    await switchTenant(MAIN.id);
    expect(calls[0].headers[TENANT_HEADER]).toBe(ACME.id); // the switch itself: still the old one
    await loadApps();
    expect(calls[1].headers[TENANT_HEADER]).toBe(MAIN.id);
    await api.get('/api/v1/admin/groups').catch(() => {}); // 401: the session is gone
    await api.get('/api/v1/public');
    expect(TENANT_HEADER in calls[3].headers).toBe(false);
  });

  it('reads the user once when requests are refused with tenant_changed, and says what happened', async () => {
    setMe(makeMe());
    const other = makeMe({ active_tenant: MAIN, role: 'tenant_admin' });
    const { calls } = stubApi({
      'GET /api/v1/admin/groups': () => errorResponse(409, 'tenant_changed'),
      'GET /api/v1/admin/apps': () => errorResponse(409, 'tenant_changed'),
      'GET /api/v1/me': () => other,
    });
    const results = await Promise.allSettled([
      api.get('/api/v1/admin/groups'),
      api.get('/api/v1/admin/apps'),
    ]);
    // The refused calls fail, with a text that says why.
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const reason = (results[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toMatchObject({ status: 409, code: 'tenant_changed' });
    expect(errorMessage(reason)).toContain('Die aktive Organisation hat sich inzwischen geändert');

    await vi.waitFor(() => expect(get(me)).toEqual(other));
    expect(calls.filter((call) => call.url === '/api/v1/me')).toHaveLength(1);
    // One notice for the one event, whoever shows the errors of the two requests
    // (showError() says nothing about this code): not a second one in other words.
    for (const result of results) showError((result as PromiseRejectedResult).reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const notices = get(toasts);
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('info');
    expect(notices[0].message).toContain('Admin Cave');
    expect(notices[0].message).toContain('nicht ausgeführt');
  });

  it('announces a change it finds on its own without talking about a refused request', async () => {
    setMe(makeMe());
    stubApi({ 'GET /api/v1/me': () => makeMe({ active_tenant: MAIN }) });
    await revalidateSession({ force: true });
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      'Die aktive Organisation hat sich geändert, zum Beispiel in einem anderen Fenster. Du arbeitest jetzt in „Admin Cave“.',
    ]);
  });

  it('still says that the request was not carried out when the user turns out to be in the same organization', async () => {
    const same = makeMe();
    setMe(same);
    stubApi({
      'GET /api/v1/admin/groups': () => errorResponse(409, 'tenant_changed'),
      'GET /api/v1/me': () => same,
    });
    const failure = await api.get('/api/v1/admin/groups').catch((err: unknown) => err);
    showError(failure); // the page that asked: silent about this code
    await revalidateSession(); // joins the read that is under way
    expect(get(me)).toEqual(same);
    // Nothing changed that could be announced, but the request did fail: said once.
    await vi.waitFor(() =>
      expect(get(toasts).map((toast) => `${toast.kind}: ${toast.message}`)).toEqual([
        'error: Die aktive Organisation hat sich inzwischen geändert. Es wurde nichts ausgeführt – prüf die Ansicht und versuch es noch einmal.',
      ]),
    );
  });

  it('says it when the question who the user is now fails as well', async () => {
    setMe(makeMe());
    stubApi({
      'GET /api/v1/admin/groups': () => errorResponse(409, 'tenant_changed'),
      'GET /api/v1/me': () => errorResponse(503, 'unavailable'),
    });
    await api.get('/api/v1/admin/groups').catch(() => {});
    await vi.waitFor(() => expect(get(toasts)).toHaveLength(1));
    expect(get(toasts)[0]).toMatchObject({ kind: 'error' });
    expect(get(toasts)[0].message).toContain(
      'Die aktive Organisation hat sich inzwischen geändert',
    );
  });

  it('ignores a refusal that arrives for an organization the page has left since', async () => {
    setMe(makeMe());
    let answer: (value: unknown) => void = () => {};
    const { calls } = stubApi({
      'GET /api/v1/admin/groups': () => new Promise((resolve) => (answer = resolve)),
      'GET /api/v1/me': () => makeMe({ active_tenant: MAIN }),
    });
    const asked = api.get('/api/v1/admin/groups').catch((err: unknown) => err);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].headers[TENANT_HEADER]).toBe(ACME.id);
    // The user switches (here: the store learns of it) while the request is under way.
    setMe(makeMe({ active_tenant: MAIN }));
    answer(errorResponse(409, 'tenant_changed'));
    expect(await asked).toMatchObject({ status: 409, code: 'tenant_changed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The page that asked is gone and nothing is out of date: no question, no notice.
    expect(calls.filter((call) => call.url === '/api/v1/me')).toEqual([]);
    expect(get(toasts)).toEqual([]);
  });

  it('announces it whichever answer about the user brings the other organization', async () => {
    setMe(makeMe());
    stubApi({
      'PATCH /api/v1/me/settings': () => makeMe({ active_tenant: MAIN }),
      'GET /api/v1/me': () => makeMe(),
      'PATCH /api/v1/me/profile': () => makeMe({ active_tenant: MAIN }),
    });
    const notices = () => get(toasts).map((toast) => `${toast.kind}: ${toast.message}`);
    const changedTo = (name: string) =>
      `info: Die aktive Organisation hat sich geändert, zum Beispiel in einem anderen Fenster. Du arbeitest jetzt in „${name}“.`;
    await updateSettings({ theme: 'light' }); // a settings change in a tab that is out of date
    expect(notices()).toEqual([changedTo('Admin Cave')]);
    clearToasts();
    await refreshMe();
    expect(notices()).toEqual([changedTo('Acme GmbH')]);
    clearToasts();
    await updateProfile('Anna', 'Admin');
    expect(notices()).toEqual([changedTo('Admin Cave')]);
  });

  it('does not explain a switch the user has just made here', async () => {
    setMe(makeMe());
    stubApi({ 'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }) });
    await switchTenant(MAIN.id);
    expect(get(me)?.active_tenant).toEqual(MAIN);
    expect(get(toasts)).toEqual([]);
  });

  it('says so when the organization is gone and no other takes its place', async () => {
    setMe(makeMe());
    stubApi({
      'GET /api/v1/me': () =>
        makeMe({ active_tenant: null, role: null, permissions: [], memberships: [] }),
    });
    await revalidateSession({ force: true });
    expect(get(me)?.active_tenant).toBeNull();
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      'Die Organisation, in der du gearbeitet hast, steht dir nicht mehr zur Verfügung.',
    ]);
  });
});

describe('checking the session in the background', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
  });

  it('asks at most once per interval unless forced, and never twice at the same time', async () => {
    setMe(makeMe());
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    await refreshMe(); // an answer of the server: from here the interval counts
    expect(calls).toHaveLength(1);
    await revalidateSession();
    expect(calls).toHaveLength(1);
    await revalidateSession({ force: true });
    expect(calls).toHaveLength(2);
    vi.setSystemTime(Date.now() + REVALIDATE_MIN_INTERVAL_MS + 1);
    await Promise.all([
      revalidateSession(),
      revalidateSession(),
      revalidateSession({ force: true }),
    ]);
    expect(calls).toHaveLength(3);
  });

  it('is not silenced by a clock that was set back', async () => {
    setMe(makeMe());
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    await refreshMe();
    expect(calls).toHaveLength(1);
    // The last answer now lies an hour in the future: "just now" it is not.
    vi.setSystemTime(Date.now() - 60 * 60_000);
    await revalidateSession();
    expect(calls).toHaveLength(2);
  });

  it('asks once more after a check that was sent before the news arrived', async () => {
    setMe(makeMe());
    const release: ((response: Response) => void)[] = [];
    const mock = vi.fn(() => new Promise<Response>((resolve) => release.push(resolve)));
    vi.stubGlobal('fetch', mock);
    const checking = revalidateSession({ force: true });
    // Another tab reports a switch: the check under way may have been answered before it.
    void revalidateSession({ fresh: true });
    void revalidateSession({ force: true }); // insisting alone joins the check, as before
    expect(mock).toHaveBeenCalledTimes(1);
    release[0](ok(makeMe())); // the old state
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    release[1](ok(makeMe({ active_tenant: MAIN })));
    await checking;
    expect(get(me)?.active_tenant).toEqual(MAIN);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a session', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'GET /api/v1/workspace/apps': () => errorResponse(401, 'not_authenticated'),
    });
    await loadApps().catch(() => {});
    calls.length = 0;
    await revalidateSession({ force: true });
    expect(calls).toHaveLength(0);
  });

  it('keeps quiet when the server cannot be reached', async () => {
    const before = makeMe();
    setMe(before);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(revalidateSession({ force: true })).resolves.toBeUndefined();
    expect(get(session)).toEqual({ status: 'ready', me: before });
    expect(get(toasts)).toEqual([]);
  });

  it('ends the session when the check is answered 401', async () => {
    setMe(makeMe());
    stubApi({ 'GET /api/v1/me': () => errorResponse(401, 'not_authenticated') });
    await revalidateSession({ force: true });
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(sessionExpired)).toBe(true);
    expect(get(sessionEnded)).toBe(false); // no app is open: nothing to keep the page for
    expect(get(toasts)).toEqual([]);
  });

  it('picks up what changed on the server', async () => {
    setMe(makeMe());
    stubApi({
      'GET /api/v1/me': () => makeMe({ role: 'tenant_admin', permissions: ['apps:manage'] }),
    });
    await revalidateSession({ force: true });
    expect(get(permissions)).toEqual(['apps:manage']);
    expect(get(toasts)).toEqual([]); // same organization: nothing to announce
  });

  it('drops an answer that was overtaken by something newer', async () => {
    setMe(makeMe());
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const checking = revalidateSession({ force: true });
    const newer = makeMe({ settings: { ...makeMe().settings, nav_position: 'bottom' } });
    setMe(newer); // e.g. a setting saved while the check was under way
    release(new Response(JSON.stringify(makeMe()), { status: 200 }));
    await checking;
    expect(get(me)).toEqual(newer);
  });
});

describe('startSessionWatch', () => {
  let stop: () => void = () => {};
  let visibility: DocumentVisibilityState = 'visible';
  let focused = true;

  beforeEach(() => {
    vi.useFakeTimers();
    // Well after the last answer of the server in the tests above.
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    visibility = 'visible';
    focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    FakeChannel.open = [];
    FakeChannel.posted = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    setMe(makeMe());
  });

  afterEach(() => stop());

  it('checks the session when the tab becomes visible again, not when it is hidden', async () => {
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    stop = startSessionWatch();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/me']);
    // Flipping between tabs does not hammer the API.
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it('checks the session when the window gets the focus back', async () => {
    // Two windows side by side are both visible all the time: no visibilitychange.
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    stop = startSessionWatch();
    vi.setSystemTime(Date.now() + REVALIDATE_MIN_INTERVAL_MS + 1); // the last answer is old
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/me']);
    // Clicking back and forth between windows does not hammer the API either.
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it('tells the other tabs when the organization was switched and before leaving on sign-out', async () => {
    stubApi({
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }),
      'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }),
    });
    stop = startSessionWatch();
    expect(FakeChannel.open.map((channel) => channel.name)).toEqual([SESSION_CHANNEL]);
    await switchTenant(MAIN.id);
    expect(FakeChannel.posted).toEqual(['organization']);
    vi.mocked(leaveTo).mockImplementation(() => {
      // By the time the browser leaves, the others have been told.
      expect(FakeChannel.posted).toEqual(['organization', 'signed-out']);
    });
    await signOut();
    expect(leaveTo).toHaveBeenCalledTimes(1);
    vi.mocked(leaveTo).mockReset();
  });

  it('tells nobody about a switch or a sign-out that did not happen', async () => {
    stubApi({
      'POST /api/v1/me/active-tenant': () => errorResponse(404, 'not_found'),
      'POST /api/auth/logout': () => errorResponse(500, 'error'),
    });
    stop = startSessionWatch();
    await switchTenant(MAIN.id).catch(() => {});
    await signOut();
    expect(FakeChannel.posted).toEqual([]);
  });

  it('checks at once when another tab reports a change, however recent the last answer', async () => {
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe({ active_tenant: MAIN }) });
    stop = startSessionWatch();
    await refreshMe(); // an answer just now: the other triggers would keep quiet
    clearToasts();
    calls.length = 0;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    FakeChannel.open[0].receive('organization');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/me']);
    FakeChannel.open[0].receive('signed-out');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it('works in a browser without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { calls } = stubApi({
      'GET /api/v1/me': () => makeMe(),
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }),
    });
    stop = startSessionWatch();
    await switchTenant(MAIN.id);
    expect(get(me)?.active_tenant).toEqual(MAIN);
    vi.setSystemTime(Date.now() + REVALIDATE_MIN_INTERVAL_MS + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/me/active-tenant', '/api/v1/me']);
  });

  it('loads the page anew when it comes back from the back/forward cache', () => {
    stop = startSessionWatch();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(reloadPage).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('gives a sign of life every two minutes while the window is visible and focused', async () => {
    // The server ends a session after five idle minutes at the earliest: two signs of
    // life fit into that, so one that is late or left out does no harm.
    expect(KEEPALIVE_INTERVAL_MS).toBe(2 * 60_000);
    expect(2 * KEEPALIVE_INTERVAL_MS).toBeLessThan(5 * 60_000);
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    stop = startSessionWatch();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS - 1000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * KEEPALIVE_INTERVAL_MS);
    expect(calls).toHaveLength(3);
  });

  it('gives none for a window that is in the background or hidden', async () => {
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    stop = startSessionWatch();
    focused = false;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    visibility = 'hidden';
    focused = true;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(calls).toHaveLength(0);
  });

  it('stops', async () => {
    const { calls } = stubApi({
      'GET /api/v1/me': () => makeMe(),
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN }),
    });
    const stopNow = startSessionWatch();
    const channel = FakeChannel.open[0];
    stopNow();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    channel.receive('organization');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(calls).toHaveLength(0);
    expect(reloadPage).not.toHaveBeenCalled();
    // The channel is closed, and nothing is posted on it any more.
    expect(channel.closed).toBe(true);
    await switchTenant(MAIN.id);
    expect(FakeChannel.posted).toEqual([]);
  });
});

describe('a session that ends while somebody works in an app', () => {
  // An app is open in its frame.
  async function openApp() {
    stubApi({ 'GET /api/v1/workspace/apps': () => [makeApp({ id: 'wiki' })] });
    await loadApps();
    activateFrame('wiki');
    expect(get(frames)).toHaveLength(1);
  }
  const gone = () => errorResponse(401, 'not_authenticated');

  it('keeps the page and the frames when the check in the background finds it out, and says so', async () => {
    const before = makeMe();
    setMe(before);
    await openApp();
    const { calls } = stubApi({ 'GET /api/v1/me': gone });
    await revalidateSession({ force: true });
    expect(get(session)).toEqual({ status: 'ready', me: before });
    expect(get(frames)).toHaveLength(1);
    expect(get(sessionEnded)).toBe(true);
    expect(get(sessionExpired)).toBe(false);
    // Nothing is asked in the background while the page waits for a new sign-in.
    calls.length = 0;
    await revalidateSession();
    await revalidateSession({ force: true });
    await revalidateSession({ fresh: true });
    expect(calls).toHaveLength(0);
  });

  it('goes to the login page with the first request the user makes', async () => {
    setMe(makeMe());
    await openApp();
    stubApi({ 'GET /api/v1/me': gone, 'GET /api/v1/admin/groups': gone });
    await revalidateSession({ force: true });
    expect(get(sessionEnded)).toBe(true);
    await api.get('/api/v1/admin/groups').catch(() => {});
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(sessionExpired)).toBe(true);
    expect(get(sessionEnded)).toBe(false);
  });

  it('goes to the login page through the button of the notice', async () => {
    setMe(makeMe());
    endedSessionToLogin(); // nothing to leave: the session is alive
    expect(get(session).status).toBe('ready');
    await openApp();
    stubApi({ 'GET /api/v1/me': gone });
    await revalidateSession({ force: true });
    endedSessionToLogin();
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(sessionExpired)).toBe(true); // the login page says why
    expect(get(sessionEnded)).toBe(false);
  });

  it('ends at once, as before, when a request of the user is answered 401', async () => {
    setMe(makeMe());
    await openApp();
    stubApi({ 'GET /api/v1/admin/groups': gone });
    await api.get('/api/v1/admin/groups').catch(() => {});
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(sessionEnded)).toBe(false);
  });

  it('leaves nothing behind for the session that follows', async () => {
    setMe(makeMe());
    await openApp();
    stubApi({ 'GET /api/v1/me': gone });
    await revalidateSession({ force: true });
    expect(get(sessionEnded)).toBe(true);
    // The server describes the user again (signed in again in another tab, say).
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    await refreshMe();
    expect(get(sessionEnded)).toBe(false);
    await revalidateSession({ force: true }); // and the background checks are back
    expect(calls).toHaveLength(2);
    // A fresh sign-in starts clean as well.
    stubApi({ 'GET /api/v1/me': gone });
    await revalidateSession({ force: true });
    expect(get(sessionEnded)).toBe(true);
    setMe(makeMe());
    expect(get(sessionEnded)).toBe(false);
  });
});

// Accent colour and theme are what applies to the user in the active organization. They
// come with every answer about the user and go with the session.
describe('appearance that follows the session', () => {
  const ORANGE = '#c2410c';
  const TEAL = '#0f766e';
  const root = document.documentElement;
  const withSettings = (
    settings: Partial<ReturnType<typeof makeMe>['settings']>,
    own: Partial<ReturnType<typeof makeMe>['own_settings']> = {},
    rest: Partial<ReturnType<typeof makeMe>> = {},
  ) =>
    makeMe({
      settings: { ...SETTINGS, ...settings },
      own_settings: { ...OWN_SETTINGS, ...own },
      ...rest,
    });
  const gone = () => errorResponse(401, 'not_authenticated');
  let stop: () => void;
  beforeEach(() => {
    stop = startThemeSync();
  });
  afterEach(() => stop());

  it('applies the accent colour the server names, and remembers it for the next page load', async () => {
    stubApi({ 'GET /api/v1/me': () => withSettings({ accent_color: ORANGE, theme: 'dark' }) });
    await loadSession();
    expect(get(accentColor)).toBe(ORANGE);
    expect(root.dataset.accent).toBe(ORANGE);
    expect(root.style.getPropertyValue('--accent')).toBe(accentTokens(ORANGE, 'dark')['--accent']);
    expect(JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) ?? 'null').color).toBe(ORANGE);
  });

  it('has the built-in accent for somebody without a colour', async () => {
    setAccentColor(TEAL); // what the last page of this browser showed
    stubApi({ 'GET /api/v1/me': () => makeMe() });
    await loadSession();
    expect(get(accentColor)).toBeNull();
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it('follows a switch of the organization at once: its accent, its theme', async () => {
    setMe(withSettings({ accent_color: ORANGE, theme: 'dark' }));
    expect(root.dataset.accent).toBe(ORANGE);
    stubApi({
      'POST /api/v1/me/active-tenant': () =>
        withSettings({ accent_color: TEAL, theme: 'light' }, {}, { active_tenant: MAIN }),
    });
    await switchTenant(MAIN.id);
    expect(root.dataset.accent).toBe(TEAL);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--accent')).toBe(accentTokens(TEAL, 'light')['--accent']);
    // And into one that set nothing: the built-in accent again.
    stubApi({ 'POST /api/v1/me/active-tenant': () => makeMe() });
    await switchTenant(ACME.id);
    expect(root.hasAttribute('data-accent')).toBe(false);
  });

  it('follows the next answer about the user when a lock is set or lifted meanwhile', async () => {
    // Own choice teal; the organization has fixed orange.
    setMe(withSettings({ accent_color: ORANGE, accent_locked: true }, { accent_color: TEAL }));
    expect(root.dataset.accent).toBe(ORANGE);
    stubApi({
      'GET /api/v1/me': () => withSettings({ accent_color: TEAL }, { accent_color: TEAL }),
    });
    await revalidateSession({ force: true });
    expect(root.dataset.accent).toBe(TEAL);
  });

  it('shows a chosen colour and bar at once, before the server has answered', async () => {
    setMe(makeMe());
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const saving = updateSettings({ accent_color: '#C2410C', app_bar: 'hidden' });
    expect(get(me)?.settings.accent_color).toBe(ORANGE);
    expect(get(me)?.settings.app_bar).toBe('hidden');
    expect(root.dataset.accent).toBe(ORANGE);
    release(
      ok(
        withSettings(
          { accent_color: ORANGE, app_bar: 'hidden' },
          { accent_color: ORANGE, app_bar: 'hidden' },
        ),
      ),
    );
    await saving;
    expect(root.dataset.accent).toBe(ORANGE);
  });

  it('does not show a choice for a setting the organization has fixed: it is stored, not applied', async () => {
    const locked = withSettings({
      theme: 'light',
      theme_locked: true,
      accent_color: ORANGE,
      accent_locked: true,
      app_bar: 'bottom',
      app_bar_locked: true,
    });
    setMe(locked);
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const saving = updateSettings({ theme: 'dark', accent_color: TEAL, app_bar: 'hidden' });
    expect(get(me)?.settings).toEqual(locked.settings);
    expect(get(me)?.own_settings).toMatchObject({
      theme: 'dark',
      accent_color: TEAL,
      app_bar: 'hidden',
    });
    expect(root.dataset.accent).toBe(ORANGE);
    expect(root.dataset.theme).toBe('light');
    release(ok(locked));
    await saving;
  });

  it('waits for the server to say what applies after a reset', async () => {
    setMe(
      withSettings(
        { accent_color: TEAL, app_bar: 'hidden' },
        { accent_color: TEAL, app_bar: 'hidden' },
      ),
    );
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const saving = updateSettings({ accent_color: null, app_bar: null });
    expect(get(me)?.settings.accent_color).toBe(TEAL); // not guessed
    expect(get(me)?.settings.app_bar).toBe('hidden');
    release(ok(withSettings({ accent_color: ORANGE, app_bar: 'bottom' })));
    await saving;
    expect(root.dataset.accent).toBe(ORANGE); // the organization's default
    expect(get(me)?.settings.app_bar).toBe('bottom');
  });

  it('takes the accent away with the session: the login page shows nothing of it', async () => {
    setMe(withSettings({ accent_color: ORANGE }));
    expect(root.dataset.accent).toBe(ORANGE);
    stubApi({ 'GET /api/v1/admin/groups': gone });
    await api.get('/api/v1/admin/groups').catch(() => {});
    expect(get(session).status).toBe('anonymous');
    expect(get(accentColor)).toBeNull();
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it('takes it away on signing out, before the page is left', async () => {
    setMe(withSettings({ accent_color: ORANGE }));
    stubApi({ 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    await signOut();
    expect(root.hasAttribute('data-accent')).toBe(false);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it('keeps it while the page is kept after its session ended under an open app', async () => {
    setMe(withSettings({ accent_color: ORANGE, app_bar: 'hidden' }));
    stubApi({ 'GET /api/v1/workspace/apps': () => [makeApp({ id: 'wiki' })] });
    await loadApps();
    activateFrame('wiki');
    stubApi({ 'GET /api/v1/me': gone });
    await revalidateSession({ force: true });
    expect(get(sessionEnded)).toBe(true);
    // The page is still the user's: colour and bar stay as they were.
    expect(root.dataset.accent).toBe(ORANGE);
    expect(get(me)?.settings.app_bar).toBe('hidden');
    endedSessionToLogin();
    expect(root.hasAttribute('data-accent')).toBe(false);
  });

  it('remembers the theme that applies and, apart from it, the one the user chose', async () => {
    // The organization fixed "light"; the user's own choice is "dark".
    stubApi({
      'GET /api/v1/me': () =>
        withSettings({ theme: 'light', theme_locked: true }, { theme: 'dark' }),
    });
    await loadSession();
    expect(root.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBe('dark');
    // Without the session, nothing of the organization applies: the own choice does.
    stubApi({ 'GET /api/v1/admin/groups': gone });
    await api.get('/api/v1/admin/groups').catch(() => {});
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('falls back to the system (and the login page to the installation) for somebody who chose no theme', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    // "light" is the default of the organization here; the user chose nothing.
    stubApi({ 'GET /api/v1/me': () => withSettings({ theme: 'light' }) });
    await loadSession();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(OWN_THEME_STORAGE_KEY)).toBeNull();
    stubApi({ 'GET /api/v1/admin/groups': gone });
    await api.get('/api/v1/admin/groups').catch(() => {});
    expect(get(themePreference)).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('leaves the page as it was painted when the first question to the server fails', async () => {
    setAccentColor(ORANGE);
    setThemePreference('light');
    stubApi({ 'GET /api/v1/me': () => errorResponse(500, 'internal_error') });
    await loadSession();
    expect(get(session).status).toBe('error');
    // Nothing is known about the session: a reload may well find the user signed in.
    expect(root.dataset.accent).toBe(ORANGE);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('workspace', () => {
  it('counts how often an app was asked to load anew, and mounts its frame again if it was unloaded', async () => {
    stubApi({
      'GET /api/v1/workspace/apps': () => [
        makeApp({ id: 'wiki' }),
        makeApp({ id: 'ext', type: 'external' }),
      ],
    });
    await loadApps();
    expect(get(frameReloads)).toEqual({});
    activateFrame('wiki');
    reloadFrame('wiki');
    reloadFrame('wiki');
    expect(get(frameReloads)).toEqual({ wiki: 2 });
    dropFrame('wiki');
    reloadFrame('wiki');
    expect(get(frames).map((f) => f.appId)).toEqual(['wiki']);
    // An app without a frame gets none this way either.
    reloadFrame('ext');
    expect(get(frames).map((f) => f.appId)).toEqual(['wiki']);
    // Another organization starts from nothing.
    resetWorkspace();
    expect(get(frameReloads)).toEqual({});
  });

  const apps = [
    makeApp({ id: 'wiki' }),
    makeApp({ id: 'blocked', embed_status: 'blocked' }),
    makeApp({ id: 'ext', type: 'external' }),
    makeApp({ id: 'custom', type: 'custom', url: null }),
  ];

  it('loads the apps of the active organization', async () => {
    stubApi({ 'GET /api/v1/workspace/apps': () => apps });
    expect(get(workspace).status).toBe('idle');
    await loadApps();
    expect(get(workspace)).toEqual({ status: 'ready', apps });
  });

  it('only keeps frames for apps that are shown in a frame', async () => {
    stubApi({ 'GET /api/v1/workspace/apps': () => apps });
    await loadApps();
    for (const id of ['wiki', 'blocked', 'ext', 'custom', 'unknown']) activateFrame(id);
    expect(get(frames).map((f) => f.appId)).toEqual(['wiki', 'custom']);
  });

  it('drops the frame of an app that disappeared or changed its type', async () => {
    let list = apps;
    stubApi({ 'GET /api/v1/workspace/apps': () => list });
    await loadApps();
    activateFrame('wiki');
    activateFrame('custom');
    list = [makeApp({ id: 'wiki', type: 'external' }), apps[3]];
    await loadApps();
    expect(get(frames).map((f) => f.appId)).toEqual(['custom']);
  });

  it('forgets apps and frames when the organization changes', async () => {
    stubApi({ 'GET /api/v1/workspace/apps': () => apps });
    await loadApps();
    activateFrame('wiki');
    resetWorkspace('loading');
    expect(get(workspace)).toEqual({ status: 'loading', apps: [] });
    expect(get(frames)).toEqual([]);
  });

  it('ignores the answer of a load that was overtaken by a reset', async () => {
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const loading = loadApps();
    resetWorkspace('ready'); // e.g. switched to another organization meanwhile
    release(new Response(JSON.stringify(apps), { status: 200 }));
    await loading;
    expect(get(workspace)).toEqual({ status: 'ready', apps: [] });
  });

  it('keeps what is on screen when a refresh fails, and reports a failed first load', async () => {
    stubApi({ 'GET /api/v1/workspace/apps': () => errorResponse(500, 'error') });
    await expect(loadApps()).rejects.toBeTruthy();
    expect(get(workspace).status).toBe('error');

    let fail = false;
    stubApi({
      'GET /api/v1/workspace/apps': () => (fail ? errorResponse(500, 'error') : apps),
    });
    await loadApps();
    fail = true;
    await expect(loadApps()).rejects.toBeTruthy();
    expect(get(workspace)).toEqual({ status: 'ready', apps });
  });
});
