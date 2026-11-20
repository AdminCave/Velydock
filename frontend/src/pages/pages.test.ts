// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { AdminApp, User } from '$lib/api/types';
import { setLanguage } from '$lib/i18n';
import { navigate } from '$lib/router';
import { me, setMe } from '$lib/stores/session';
import { clearToasts } from '$lib/stores/toasts';
import { loadApps, resetWorkspace } from '$lib/stores/workspace';
import { setThemePreference } from '$lib/theme';
import { leaveTo } from '$lib/utils/browser';
import { ACME, PERMISSIONS, errorResponse, makeApp, makeMe, stubApi } from '../test/fixtures';
import AdminApps from './admin/Apps.svelte';
import AdminUsers from './admin/Users.svelte';
import Dashboard from './Dashboard.svelte';
import Login from './Login.svelte';
import NotFound from './NotFound.svelte';
import Settings from './Settings.svelte';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

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
  clearToasts();
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

  it('says that the session has expired when the app sent the user here for that', () => {
    stubApi({ 'GET /api/v1/public': () => ({ ...PUBLIC, default_language: 'de' }) });
    navigate('/login?expired=1&return_to=%2Fadmin%2Fusers', { replace: true });
    render(Login);
    const message = screen.getByTestId('login-message');
    expect(message).toHaveAttribute('role', 'status');
    expect(message).toHaveTextContent('Deine Sitzung ist abgelaufen.');
  });

  it('keeps the way back when signing in again after an expired session', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login?expired=1&return_to=%2Fadmin%2Fusers', { replace: true });
    render(Login);
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2Fadmin%2Fusers');
  });

  it('offers the button again when the page comes back (Back from the identity provider)', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    const button = screen.getByTestId('login-button');
    await fireEvent.click(button);
    expect(button).toBeDisabled(); // on its way to the identity provider
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute('aria-busy');
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

describe('Administration: users', () => {
  const anna = makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin });
  const row = (overrides: Partial<User>): User => ({
    id: 'u-mia',
    username: 'mia',
    email: 'mia@acme.example',
    first_name: 'Mia',
    last_name: 'Mitglied',
    display_name: 'Mia Mitglied',
    active: true,
    is_system_admin: false,
    role: 'member',
    managed: true,
    home_tenant: ACME,
    groups: [],
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    can_edit_identity: true,
    can_edit_membership: true,
    can_assign_role: true,
    ...overrides,
  });
  const self = row({
    id: anna.user.id,
    username: 'anna',
    first_name: 'Anna',
    last_name: 'Admin',
    display_name: 'Anna Admin',
    role: 'tenant_admin',
    can_assign_role: false,
  });
  const list = (items: User[]) => ({ items, total: items.length, page: 1, page_size: 25 });

  async function openMenu(username: string) {
    const tableRow = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`tr[data-username="${username}"]`);
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(tableRow).getByTestId('user-actions'));
    const menu = await screen.findByRole('menu');
    return within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim());
  }

  it('offers no password reset, session ending or deactivation for the own account', async () => {
    setMe(anna);
    stubApi({
      'GET /api/v1/admin/users': () => list([self, row({})]),
      'GET /api/v1/admin/groups': () => [],
    });
    render(AdminUsers);
    // The API refuses these on the own account (self_action), so they are not offered.
    expect(await openMenu('anna')).toEqual(['Bearbeiten']);
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await openMenu('mia')).toEqual([
      'Bearbeiten',
      'Passwort zurücksetzen',
      'Sitzungen beenden',
      'Deaktivieren',
      'Konto löschen',
    ]);
  });

  it('reads the signed-in user and the apps again after the own account was edited', async () => {
    setMe(anna);
    const renamed = { ...self, last_name: 'Neuname', display_name: 'Anna Neuname' };
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => list([self, row({})]),
      'GET /api/v1/admin/groups': () => [],
      [`PATCH /api/v1/admin/users/${self.id}`]: () => renamed,
      'GET /api/v1/me': () =>
        makeMe({
          ...anna,
          user: { ...anna.user, last_name: 'Neuname', display_name: 'Anna Neuname' },
        }),
      'GET /api/v1/workspace/apps': () => [],
    });
    render(AdminUsers);
    await openMenu('anna');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));
    await fireEvent.input(await screen.findByLabelText('Nachname'), {
      target: { value: 'Neuname' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(get(me)?.user.display_name).toBe('Anna Neuname'));
    const after = calls.slice(calls.findIndex((call) => call.method === 'PATCH') + 1);
    expect(after.map((call) => `${call.method} ${call.url.split('?')[0]}`).sort()).toEqual([
      'GET /api/v1/admin/users',
      'GET /api/v1/me',
      'GET /api/v1/workspace/apps',
    ]);
  });

  it('leaves the signed-in user alone after somebody else was edited', async () => {
    setMe(anna);
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => list([self, row({})]),
      'GET /api/v1/admin/groups': () => [],
      'PATCH /api/v1/admin/users/u-mia': () => row({ first_name: 'Maria' }),
    });
    render(AdminUsers);
    await openMenu('mia');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));
    await fireEvent.input(await screen.findByLabelText('Vorname'), { target: { value: 'Maria' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.map((call) => call.url)).not.toContain('/api/v1/me');
  });
});

describe('Administration: apps', () => {
  const stored = (id: string, name: string): AdminApp => ({
    ...makeApp({ id, name }),
    enabled: true,
    sort_order: 10,
    visible_to_all: true,
    group_ids: [],
    user_ids: [],
    embed_detail: '',
    embed_checked_at: null,
    custom_html: '',
    custom_css: '',
    custom_js: '',
    custom_allow_network: false,
    created_at: '',
    updated_at: '',
  });

  it('keeps the keyboard focus on the app that is being moved', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let order = [stored('wiki', 'Wiki'), stored('mail', 'Mail'), stored('crm', 'CRM')];
    const { calls } = stubApi({
      'GET /api/v1/admin/apps': () => order,
      'GET /api/v1/admin/groups': () => [],
      'GET /api/v1/workspace/apps': () => [],
      'PUT /api/v1/admin/apps/order': ({ body }) => {
        const ids = (body as { app_ids: string[] }).app_ids;
        order = ids.map((id) => order.find((app) => app.id === id) as AdminApp);
        return order;
      },
    });
    render(AdminApps);
    const down = await screen.findByRole('button', { name: 'Wiki nach unten' });
    expect(down).toBeEnabled();
    down.focus();
    await fireEvent.click(down);
    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    const names = () =>
      [...document.querySelectorAll('[data-testid=apps-table] tbody tr')].map(
        (tr) => (tr as HTMLElement).dataset.appId,
      );
    await waitFor(() => expect(names()).toEqual(['mail', 'wiki', 'crm']));
    // Still on "Wiki nach unten": pressing again moves the same app again.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Wiki nach unten' })).toHaveFocus(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    await waitFor(() => expect(names()).toEqual(['mail', 'crm', 'wiki']));
    // At the end of the list that button is disabled; the other one of the row takes over.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Wiki nach oben' })).toHaveFocus(),
    );
    expect(screen.getByRole('button', { name: 'Wiki nach unten' })).toBeDisabled();
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
