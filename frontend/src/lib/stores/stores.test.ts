// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { language, setLanguage } from '$lib/i18n';
import { setThemePreference, themePreference } from '$lib/theme';
import { leaveTo } from '$lib/utils/browser';
import { MAIN, errorResponse, makeApp, makeMe, stubApi } from '../../test/fixtures';
import {
  loadSession,
  me,
  permissions,
  session,
  setMe,
  signOut,
  switchTenant,
  updateSettings,
} from './session';
import { activateFrame, frames, loadApps, resetWorkspace, workspace } from './workspace';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn() }));

beforeEach(() => {
  resetWorkspace();
  localStorage.clear();
  vi.mocked(leaveTo).mockClear();
});

afterEach(() => {
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
    stubApi({ 'POST /api/v1/me/active-tenant': () => errorResponse(404, 'not_found') });
    await expect(switchTenant(MAIN.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(get(me)).toEqual(before);
  });

  it('signs out through the address the backend names', async () => {
    stubApi({
      'POST /api/auth/logout': () => ({ redirect_url: 'https://idp.example/logout?x=1' }),
    });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('https://idp.example/logout?x=1');
  });

  it('falls back to the login page when the answer names no address', async () => {
    stubApi({ 'POST /api/auth/logout': () => new Response(null, { status: 204 }) });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1');
  });

  it('still leaves for the login page when the sign-out request fails', async () => {
    stubApi({ 'POST /api/auth/logout': () => errorResponse(401, 'not_authenticated') });
    await signOut();
    expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1');
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
