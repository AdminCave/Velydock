// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { api } from '$lib/api/client';
import { errorMessage } from '$lib/api/errors';
import { language, setLanguage } from '$lib/i18n';
import { setThemePreference, themePreference } from '$lib/theme';
import { leaveTo, reloadPage } from '$lib/utils/browser';
import { ACME, MAIN, errorResponse, makeApp, makeMe, stubApi } from '../../test/fixtures';
import {
  KEEPALIVE_INTERVAL_MS,
  REVALIDATE_MIN_INTERVAL_MS,
  loadSession,
  me,
  permissions,
  refreshMe,
  revalidateSession,
  session,
  sessionExpired,
  setMe,
  signOut,
  startSessionWatch,
  switchTenant,
  updateSettings,
} from './session';
import { clearToasts, toasts } from './toasts';
import { activateFrame, frames, loadApps, resetWorkspace, workspace } from './workspace';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

const TENANT_HEADER = 'X-Velydock-Tenant';

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
});

describe('session', () => {
  it('becomes ready with the signed-in user and applies their settings', async () => {
    stubApi({
      'GET /api/v1/me': () =>
        makeMe({
          permissions: ['workspace:use', 'users:read'],
          settings: {
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
              theme: 'dark',
              nav_position: 'right',
              language: 'de',
              nav_position_locked: false,
            },
            own_settings: { theme: 'dark', nav_position: 'right', language: null },
          }),
        ),
        { status: 200 },
      ),
    );
    await saving;
    expect(get(me)?.own_settings).toEqual({ theme: 'dark', nav_position: 'right', language: null });
  });

  it('sends null to reset a setting and waits for the server to say what applies', async () => {
    setMe(
      makeMe({
        settings: {
          theme: 'system',
          nav_position: 'right',
          language: 'de',
          nav_position_locked: false,
        },
        own_settings: { theme: null, nav_position: 'right', language: null },
      }),
    );
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': () =>
        makeMe({
          settings: {
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

  it('says nothing when the user turns out to be in the same organization', async () => {
    const same = makeMe();
    setMe(same);
    stubApi({
      'GET /api/v1/admin/groups': () => errorResponse(409, 'tenant_changed'),
      'GET /api/v1/me': () => same,
    });
    await api.get('/api/v1/admin/groups').catch(() => {});
    await revalidateSession(); // joins the read that is under way
    expect(get(me)).toEqual(same);
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

  it('loads the page anew when it comes back from the back/forward cache', () => {
    stop = startSessionWatch();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(reloadPage).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('gives a sign of life every five minutes while the window is visible and focused', async () => {
    expect(KEEPALIVE_INTERVAL_MS).toBe(5 * 60_000);
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
    const { calls } = stubApi({ 'GET /api/v1/me': () => makeMe() });
    startSessionWatch()();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(calls).toHaveLength(0);
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

describe('workspace', () => {
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
