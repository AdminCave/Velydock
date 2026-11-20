// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { setLanguage } from '$lib/i18n';
import { navigate } from '$lib/router';
import { me, setMe } from '$lib/stores/session';
import { loadApps, resetWorkspace } from '$lib/stores/workspace';
import { setThemePreference } from '$lib/theme';
import { leaveTo } from '$lib/utils/browser';
import { errorResponse, makeApp, makeMe, stubApi } from '../test/fixtures';
import Dashboard from './Dashboard.svelte';
import Login from './Login.svelte';
import NotFound from './NotFound.svelte';
import Settings from './Settings.svelte';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn() }));

const PUBLIC = {
  instance_name: 'Acme Workspace',
  default_language: 'en',
  default_theme: 'light',
  version: '1.2.3',
};

beforeEach(() => {
  resetWorkspace();
  localStorage.clear();
  vi.mocked(leaveTo).mockClear();
  navigate('/', { replace: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
  setThemePreference('system', { persist: false });
});

describe('Login', () => {
  it('shows the instance name and one sign-in button', async () => {
    stubApi({ 'GET /api/v1/public': () => ({ ...PUBLIC, default_language: 'de' }) });
    navigate('/login', { replace: true });
    render(Login);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Workspace' })).toBeVisible();
    const button = screen.getByTestId('login-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveTextContent('Anmelden');
    expect(screen.queryByTestId('login-message')).toBeNull();
    expect(screen.getByText('Velydock v1.2.3')).toBeInTheDocument();
  });

  it('starts the sign-in as a full page navigation to the backend', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login?return_to=%2Fadmin%2Fusers%3Fpage%3D2', { replace: true });
    render(Login);
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2Fadmin%2Fusers%3Fpage%3D2');
  });

  it('never sends the browser to a foreign address after sign-in', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login?return_to=https%3A%2F%2Fevil.example%2F', { replace: true });
    render(Login);
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2F');
  });

  it.each([
    ['disabled', 'Dein Konto ist deaktiviert.'],
    ['expired', 'abgelaufen'],
    ['second_factor_required', 'zweiter Faktor'],
    ['something_new', 'Die Anmeldung ist fehlgeschlagen.'],
  ])('explains ?error=%s', async (code, text) => {
    stubApi({ 'GET /api/v1/public': () => ({ ...PUBLIC, default_language: 'de' }) });
    navigate(`/login?error=${code}`, { replace: true });
    render(Login);
    const message = screen.getByTestId('login-message');
    expect(message).toHaveAttribute('role', 'alert');
    expect(message).toHaveTextContent(text);
  });

  it('confirms a sign-out', () => {
    stubApi({ 'GET /api/v1/public': () => ({ ...PUBLIC, default_language: 'de' }) });
    navigate('/login?signed_out=1', { replace: true });
    render(Login);
    const message = screen.getByTestId('login-message');
    expect(message).toHaveAttribute('role', 'status');
    expect(message).toHaveTextContent('Du bist abgemeldet.');
  });

  it('uses the instance defaults in a browser that has no own preference', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    await waitFor(() => expect(screen.getByTestId('login-button')).toHaveTextContent('Sign in'));
    expect(localStorage.getItem('velydock-language')).toBeNull(); // a default, not a choice
  });

  it('keeps the language this browser used before', async () => {
    setLanguage('de');
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    await screen.findByRole('heading', { name: 'Acme Workspace' });
    expect(screen.getByTestId('login-button')).toHaveTextContent('Anmelden');
  });

  it('works when the public information cannot be loaded', async () => {
    stubApi({ 'GET /api/v1/public': () => errorResponse(500, 'error') });
    navigate('/login', { replace: true });
    render(Login);
    expect(screen.getByRole('heading', { level: 1, name: 'Velydock' })).toBeInTheDocument();
    expect(screen.getByTestId('login-button')).toBeEnabled();
  });
});

describe('Settings', () => {
  it('offers theme, navigation position and language with the documented hooks', () => {
    setMe(makeMe());
    render(Settings);
    expect(screen.getByTestId('setting-theme').dataset.value).toBe('system');
    expect(screen.getByTestId('setting-nav-position').dataset.value).toBe('default');
    expect(screen.getByTestId('setting-language').dataset.value).toBe('de');
    expect(
      screen
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent?.trim())
        .slice(3, 8),
    ).toEqual(['Standard', 'Links', 'Rechts', 'Oben', 'Unten']);
  });

  it('stores a change through the API and shows the own choice', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': ({ body }) =>
        makeMe({
          settings: {
            theme: 'system',
            nav_position: 'bottom',
            language: 'de',
            nav_position_locked: false,
          },
          own_settings: { theme: null, language: null, ...(body as object) },
        }),
    });
    render(Settings);
    const group = screen.getByTestId('setting-nav-position');
    await fireEvent.click(screen.getByRole('radio', { name: 'Unten' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ nav_position: 'bottom' });
    await waitFor(() => expect(get(me)?.own_settings.nav_position).toBe('bottom'));
    expect(group.dataset.value).toBe('bottom');
  });

  it('resets the position with null when "Standard" is chosen', async () => {
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
    const { calls } = stubApi({ 'PATCH /api/v1/me/settings': () => makeMe() });
    render(Settings);
    expect(screen.getByTestId('setting-nav-position').dataset.value).toBe('right');
    await fireEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ nav_position: null });
  });

  it('disables the position and explains why when the organization locked it', () => {
    setMe(
      makeMe({
        settings: {
          theme: 'system',
          nav_position: 'top',
          language: 'de',
          nav_position_locked: true,
        },
        own_settings: { theme: null, nav_position: 'left', language: null },
      }),
    );
    render(Settings);
    const group = screen.getByTestId('setting-nav-position');
    // What is in effect is shown, not the suspended own choice.
    expect(group.dataset.value).toBe('top');
    for (const radio of group.querySelectorAll('input')) expect(radio).toBeDisabled();
    expect(screen.getByTestId('setting-nav-locked')).toHaveTextContent(
      'Deine Organisation hat die Position für alle festgelegt: Oben.',
    );
    // Theme and language stay changeable.
    expect(screen.getByRole('radio', { name: 'Dunkel' })).toBeEnabled();
  });

  it('snaps back when the server refuses a change', async () => {
    setMe(makeMe());
    stubApi({ 'PATCH /api/v1/me/settings': () => errorResponse(503, 'idp_unavailable') });
    render(Settings);
    await fireEvent.click(screen.getByRole('radio', { name: 'Dunkel' }));
    await waitFor(() => expect(screen.getByTestId('setting-theme').dataset.value).toBe('system'));
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
  });
});

describe('Dashboard', () => {
  it('shows the apps as tiles', async () => {
    setMe(makeMe());
    stubApi({
      'GET /api/v1/workspace/apps': () => [
        makeApp({ id: 'wiki', name: 'Wiki', description: 'Wissen' }),
        makeApp({ id: 'ext', name: 'Tickets', type: 'external', url: 'https://t.example/' }),
      ],
    });
    await loadApps();
    render(Dashboard);
    const tiles = screen.getAllByTestId('app-tile');
    expect(tiles.map((t) => t.dataset.appId)).toEqual(['wiki', 'ext']);
    expect(tiles[0]).toHaveAttribute('href', '/app/wiki');
    expect(tiles[0]).toHaveTextContent('Wiki');
    expect(tiles[0]).toHaveTextContent('Wissen');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Anna');
  });

  it('has an empty state', async () => {
    setMe(makeMe());
    stubApi({ 'GET /api/v1/workspace/apps': () => [] });
    await loadApps();
    render(Dashboard);
    expect(screen.getByText('Noch keine Apps')).toBeInTheDocument();
    expect(screen.queryByTestId('app-tile')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Apps verwalten' })).toBeNull();
  });

  it('explains a missing organization and offers to sign out', async () => {
    setMe(makeMe({ active_tenant: null, role: null, permissions: [], memberships: [] }));
    stubApi({ 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    render(Dashboard);
    const page = screen.getByTestId('no-tenant-page');
    expect(page).toHaveTextContent('Du gehörst noch zu keiner Organisation');
    await fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1'));
  });
});

describe('NotFound', () => {
  it('is a proper 404 page with a way back', () => {
    render(NotFound);
    expect(screen.getByTestId('not-found-page')).toHaveTextContent('Seite nicht gefunden');
    expect(screen.getByRole('link', { name: 'Zur Startseite' })).toHaveAttribute('href', '/');
  });

  it('says "no access" for a page the user may not open', () => {
    render(NotFound, { forbidden: true });
    expect(screen.getByTestId('forbidden-page')).toHaveTextContent('Kein Zugriff');
  });
});
