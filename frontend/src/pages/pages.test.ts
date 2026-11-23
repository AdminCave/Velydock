// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { AdminApp, SystemUser, Tenant, User } from '$lib/api/types';
import AuditLog from '$lib/components/AuditLog.svelte';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { setLanguage } from '$lib/i18n';
import { location, navigate } from '$lib/router';
import { instanceName } from '$lib/stores/instance';
import { me, setMe } from '$lib/stores/session';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { loadApps, resetWorkspace } from '$lib/stores/workspace';
import { setThemePreference, showOwnTheme, themePreference } from '$lib/theme';
import { leaveTo } from '$lib/utils/browser';
import {
  ACME,
  MAIN,
  PERMISSIONS,
  errorResponse,
  makeApp,
  makeMe,
  stubApi,
  SETTINGS,
  OWN_SETTINGS,
} from '../test/fixtures';
import AdminApps from './admin/Apps.svelte';
import AdminGroups from './admin/Groups.svelte';
import AdminUsers from './admin/Users.svelte';
import Dashboard from './Dashboard.svelte';
import Login from './Login.svelte';
import NotFound from './NotFound.svelte';
import Profile from './Profile.svelte';
import Settings from './Settings.svelte';
import SystemSettings from './system/Settings.svelte';
import SystemTenants from './system/Tenants.svelte';
import SystemUsers from './system/Users.svelte';

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
  cancelConfirm();
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
    // With the language of the page, so the identity provider's pages are in it as well.
    expect(leaveTo).toHaveBeenCalledWith(
      '/api/auth/login?return_to=%2Fadmin%2Fusers%3Fpage%3D2&lang=de',
    );
  });

  it('hands the language of the page to the sign-in', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    await screen.findByRole('heading', { level: 1, name: 'Acme Workspace' });
    setLanguage('en', { persist: false });
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2F&lang=en');
  });

  it('puts the name of the installation into the title of the tab once it is known', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    instanceName.set(null);
    render(Login);
    await screen.findByRole('heading', { level: 1, name: 'Acme Workspace' });
    // App.svelte builds the title from this store while nobody is signed in (App.test.ts).
    expect(get(instanceName)).toBe('Acme Workspace');
  });

  it('never sends the browser to a foreign address after sign-in', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login?return_to=https%3A%2F%2Fevil.example%2F', { replace: true });
    render(Login);
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2F&lang=de');
  });

  it.each([
    ['disabled', 'Dein Konto ist deaktiviert.'],
    ['expired', 'abgelaufen'],
    ['second_factor_required', 'zweiter Faktor'],
    ['account_conflict', 'bereits ein anderes Konto'],
    ['account_unsupported', 'länger, als Velydock unterstützt (höchstens 150 Zeichen)'],
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
    // Neutral: an administrator may have ended it (a new role, "Sitzungen beenden").
    expect(message).toHaveTextContent('Deine Sitzung ist abgelaufen oder wurde beendet.');
  });

  it('keeps the way back when signing in again after an expired session', async () => {
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login?expired=1&return_to=%2Fadmin%2Fusers', { replace: true });
    render(Login);
    await fireEvent.click(screen.getByTestId('login-button'));
    expect(leaveTo).toHaveBeenCalledWith('/api/auth/login?return_to=%2Fadmin%2Fusers&lang=de');
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

  it('uses the theme of the installation, not one an organization had set for the last user', async () => {
    // PUBLIC says "light". What applied to the last session of this browser was "dark",
    // fixed by an organization; the user had chosen nothing.
    setThemePreference('dark', { own: null });
    showOwnTheme(); // the session ended
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    await screen.findByRole('heading', { name: 'Acme Workspace' });
    await waitFor(() => expect(get(themePreference)).toBe('light'));
    expect(localStorage.getItem('velydock-theme')).toBeNull(); // a default, not a choice
  });

  it('keeps the theme the user chose for themselves', async () => {
    setThemePreference('light', { own: 'dark' }); // "light" was fixed by the organization
    showOwnTheme();
    stubApi({ 'GET /api/v1/public': () => PUBLIC });
    navigate('/login', { replace: true });
    render(Login);
    await screen.findByRole('heading', { name: 'Acme Workspace' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get(themePreference)).toBe('dark');
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
    expect(screen.getByTestId('setting-theme').dataset.value).toBe('default');
    expect(screen.getByTestId('setting-nav-position').dataset.value).toBe('default');
    expect(screen.getByTestId('setting-language').dataset.value).toBe('de');
    expect(
      within(screen.getByTestId('setting-nav-position'))
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent?.trim()),
    ).toEqual(['Standard', 'Links', 'Rechts', 'Oben', 'Unten']);
  });

  it('stores a change through the API and shows the own choice', async () => {
    setMe(makeMe());
    const { calls } = stubApi({
      'PATCH /api/v1/me/settings': ({ body }) =>
        makeMe({
          settings: {
            ...SETTINGS,
            theme: 'system',
            nav_position: 'bottom',
            language: 'de',
            nav_position_locked: false,
          },
          own_settings: { ...OWN_SETTINGS, theme: null, language: null, ...(body as object) },
        }),
    });
    render(Settings);
    const group = screen.getByTestId('setting-nav-position');
    await fireEvent.click(within(group).getByRole('radio', { name: 'Unten' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ nav_position: 'bottom' });
    await waitFor(() => expect(get(me)?.own_settings.nav_position).toBe('bottom'));
    expect(group.dataset.value).toBe('bottom');
  });

  it('resets the position with null when "Standard" is chosen', async () => {
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
    const { calls } = stubApi({ 'PATCH /api/v1/me/settings': () => makeMe() });
    render(Settings);
    expect(screen.getByTestId('setting-nav-position').dataset.value).toBe('right');
    await fireEvent.click(
      within(screen.getByTestId('setting-nav-position')).getByRole('radio', { name: 'Standard' }),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ nav_position: null });
  });

  it('disables the position and explains why when the organization locked it', () => {
    setMe(
      makeMe({
        settings: {
          ...SETTINGS,
          theme: 'system',
          nav_position: 'top',
          language: 'de',
          nav_position_locked: true,
        },
        own_settings: { ...OWN_SETTINGS, theme: null, nav_position: 'left', language: null },
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
    await waitFor(() => expect(screen.getByTestId('setting-theme').dataset.value).toBe('default'));
    expect(
      within(screen.getByTestId('setting-theme')).getByRole('radio', { name: 'Standard' }),
    ).toBeChecked();
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
    // The page is nothing but this message: it is its heading, and it says whom to ask.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Du gehörst noch zu keiner Organisation' }),
    ).toBeVisible();
    expect(page).toHaveTextContent('Das kann nur die Systemadministration ändern');
    expect(page).not.toHaveTextContent('deaktiviert');
    await fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith('/login?signed_out=1'));
  });

  it('says that the organization is deactivated when that is why there is none', () => {
    const without = { active_tenant: null, role: null, permissions: [], memberships: [] };
    setMe(makeMe({ ...without, inactive_memberships: 1 }));
    const first = render(Dashboard);
    const page = screen.getByTestId('no-tenant-page');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Deine Organisation ist deaktiviert' }),
    ).toBeVisible();
    expect(page).toHaveTextContent(
      'Wieder aktivieren kann eine Organisation nur die Systemadministration',
    );
    expect(page).not.toHaveTextContent('noch keiner Organisation zugeordnet');
    first.unmount();
    setMe(makeMe({ ...without, inactive_memberships: 3 }));
    render(Dashboard);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Deine Organisationen sind deaktiviert' }),
    ).toBeVisible();
  });
});

describe('Profile', () => {
  const RULE = /Nicht erlaubt sind die Zeichen < > & /;
  const save = () => screen.getByRole('button', { name: 'Speichern' });

  it('says at the field which characters a name must not hold, and sends nothing', async () => {
    setMe(makeMe());
    const { calls } = stubApi({});
    render(Profile);
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Anna <3' } });
    await fireEvent.click(save());
    expect(screen.getByText(RULE)).toBeVisible();
    expect(screen.queryByText('Dieses Feld wird gebraucht.')).toBeNull(); // which it is not
    expect(screen.getByLabelText('Vorname')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Nachname')).not.toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
    // The message goes as soon as the field is corrected.
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Anna-Lena' } });
    expect(screen.queryByText(RULE)).toBeNull();
  });

  it('says that a name is missing when it is', async () => {
    setMe(makeMe());
    const { calls } = stubApi({});
    render(Profile);
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: '  ' } });
    await fireEvent.click(save());
    expect(screen.getByText('Dieses Feld wird gebraucht.')).toBeVisible();
    expect(screen.getByLabelText('Nachname')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('puts what the server refuses about a name at that name', async () => {
    setMe(makeMe());
    stubApi({
      'PATCH /api/v1/me/profile': () =>
        errorResponse(422, 'validation', {
          fields: [{ field: 'last_name', message: 'Value error, forbidden character' }],
        }),
    });
    render(Profile);
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'Neu' } });
    await fireEvent.click(save());
    await waitFor(() =>
      expect(screen.getByLabelText('Nachname')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByText('Diese Eingabe wurde nicht angenommen.')).toBeVisible();
    expect(screen.getByLabelText('Vorname')).not.toHaveAttribute('aria-invalid', 'true');
    expect(get(toasts)).toEqual([]); // said once, at the field
  });

  it('has nothing to save when only blanks were changed', async () => {
    const anna = makeMe();
    setMe(anna);
    render(Profile);
    expect(save()).toBeDisabled();
    await fireEvent.input(screen.getByLabelText('Vorname'), {
      target: { value: `  ${anna.user.first_name} ` },
    });
    expect(save()).toBeDisabled();
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Annika' } });
    expect(save()).toBeEnabled();
  });

  it('says why there is no organization when the own one is deactivated', () => {
    const without = { active_tenant: null, role: null, permissions: [], memberships: [] };
    setMe(makeMe({ ...without, inactive_memberships: 1 }));
    const first = render(Profile);
    expect(screen.getByText(/Deine ist deaktiviert/)).toBeVisible();
    first.unmount();
    setMe(makeMe(without));
    render(Profile);
    expect(screen.queryByText(/Deine ist deaktiviert/)).toBeNull();
    expect(screen.getByText(/Dein Konto ist keiner Organisation zugeordnet/)).toBeVisible();
  });

  it('links to the account page of the identity provider as the server names it', () => {
    const anna = makeMe();
    setMe(anna);
    render(Profile);
    // Nothing is added to the address: that page chooses its language itself.
    expect(screen.getByTestId('account-link')).toHaveAttribute('href', anna.account_url);
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

  it('sends nothing for a question that is answered after the organization changed', async () => {
    setMe(anna);
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => list([self, row({})]),
      'GET /api/v1/admin/groups': () => [],
      'DELETE /api/v1/admin/users/u-mia': () => ({ deleted_identity: true }),
    });
    render(ConfirmDialog);
    render(AdminUsers);
    await openMenu('mia');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Konto löschen' }));
    const question = await screen.findByRole('dialog', { name: 'Konto löschen' });
    // The session turns out to be in another organization (switched in another tab). The
    // app replaces the page and withdraws the question then. Here both are left standing
    // to show what holds even so: this page cannot speak for the organization that
    // followed, where the same account may exist with another meaning of "delete".
    setMe(makeMe({ ...anna, active_tenant: MAIN }));
    calls.length = 0;
    await fireEvent.click(within(question).getByRole('button', { name: 'Konto löschen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([]);
    expect(get(toasts)).toEqual([]); // and nobody is told about a request of a page that is gone
  });

  it('says why a membership the identity provider manages cannot be ended here', async () => {
    setMe(anna);
    const guest = row({
      id: 'u-gast',
      username: 'gast',
      display_name: 'Gabi Gast',
      managed: false,
    });
    stubApi({
      'GET /api/v1/admin/users': () => list([self, guest]),
      'GET /api/v1/admin/groups': () => [],
      'DELETE /api/v1/admin/users/u-gast': () => errorResponse(409, 'managed_by_idp'),
    });
    render(ConfirmDialog);
    render(AdminUsers);
    await openMenu('gast');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Aus Organisation entfernen' }));
    const question = await screen.findByRole('dialog', { name: 'Aus Organisation entfernen' });
    await fireEvent.click(
      within(question).getByRole('button', { name: 'Aus Organisation entfernen' }),
    );
    await waitFor(() =>
      expect(get(toasts).map((toast) => `${toast.kind}: ${toast.message}`)).toEqual([
        'error: Die Zugehörigkeit dieses Kontos zur Organisation verwaltet der Anmeldedienst selbst (das Konto kam über einen externen Identitätsanbieter oder eine Einladung der Organisation in Keycloak). Das lässt sich nur dort ändern.',
      ]),
    );
  });

  it('says what is left to do with an account that was deleted at the identity provider', async () => {
    setMe(anna);
    stubApi({
      'GET /api/v1/admin/users': () => list([self, row({})]),
      'GET /api/v1/admin/groups': () => [],
      'POST /api/v1/admin/users/u-mia/reset-password': () => errorResponse(409, 'missing_at_idp'),
    });
    render(ConfirmDialog);
    render(AdminUsers);
    await openMenu('mia');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Passwort zurücksetzen' }));
    const question = await screen.findByRole('dialog');
    await fireEvent.click(within(question).getByRole('button', { name: 'Passwort zurücksetzen' }));
    await waitFor(() =>
      expect(get(toasts).map((toast) => `${toast.kind}: ${toast.message}`)).toEqual([
        'error: Dieses Konto gibt es im Anmeldedienst (Keycloak) nicht mehr – es wurde dort gelöscht. Hier kannst du es nur noch deaktivieren oder löschen.',
      ]),
    );
  });

  describe('and the link for setting the password by e-mail', () => {
    const option = () => screen.getByLabelText(/Link zum Passwort-Setzen per E-Mail senden/);
    const users = {
      'GET /api/v1/admin/users': () => list([self]),
      'GET /api/v1/admin/groups': () => [],
    };
    async function openCreate() {
      await waitFor(() =>
        expect(document.querySelector('tr[data-username="anna"]')).not.toBeNull(),
      );
      await fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen' }));
      return screen.findByRole('dialog', { name: 'Benutzer anlegen' });
    }

    it('is offered when the installation says it can send e-mail', async () => {
      setMe(anna);
      const { calls } = stubApi({
        ...users,
        'GET /api/v1/admin/capabilities': () => ({ email_invitations: true }),
      });
      render(AdminUsers);
      await openCreate();
      await waitFor(() => expect(option()).toBeEnabled());
      // Asked of the organization this page was opened for, like everything else on it.
      const asked = calls.find((call) => call.url.startsWith('/api/v1/admin/capabilities'));
      expect(asked?.headers['X-Velydock-Tenant']).toBe(ACME.id);
    });

    it('is not offered when it cannot, with the reason', async () => {
      setMe(anna);
      stubApi({
        ...users,
        'GET /api/v1/admin/capabilities': () => ({ email_invitations: false }),
      });
      render(AdminUsers);
      const dialog = await openCreate();
      expect(option()).toBeDisabled();
      expect(dialog).toHaveTextContent('Dafür muss der E-Mail-Versand eingerichtet sein');
    });

    it('is not offered, and nobody is bothered, when the question fails', async () => {
      setMe(anna);
      stubApi({
        ...users,
        'GET /api/v1/admin/capabilities': () => errorResponse(503, 'unavailable'),
      });
      render(AdminUsers);
      await openCreate();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(option()).toBeDisabled();
      expect(get(toasts)).toEqual([]);
    });

    it('does not keep the dialog waiting, and leaves what was typed when the answer arrives', async () => {
      setMe(anna);
      let answer: (value: unknown) => void = () => {};
      stubApi({
        ...users,
        'GET /api/v1/admin/capabilities': () => new Promise((resolve) => (answer = resolve)),
      });
      render(AdminUsers);
      await openCreate(); // open although the answer is still out
      expect(option()).toBeDisabled();
      await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'karl' } });
      answer({ email_invitations: true });
      await waitFor(() => expect(option()).toBeEnabled());
      expect(screen.getByLabelText('Benutzername')).toHaveValue('karl');
    });

    it('is not asked about by somebody who cannot create accounts', async () => {
      setMe(makeMe({ role: 'user_manager', permissions: ['workspace:use', 'users:read'] }));
      const { calls } = stubApi(users);
      render(AdminUsers);
      await waitFor(() =>
        expect(document.querySelector('tr[data-username="anna"]')).not.toBeNull(),
      );
      expect(calls.some((call) => call.url.includes('capabilities'))).toBe(false);
    });
  });

  describe('and what the list shows', () => {
    const people = [self, row({}), row({ id: 'u-ben', username: 'ben', display_name: 'Ben Büro' })];
    const serve = () =>
      stubApi({
        'GET /api/v1/admin/users': () => ({ items: people, total: 80, page: 1, page_size: 25 }),
        'GET /api/v1/admin/groups': () => [],
      });
    const requests = (calls: { url: string }[]) =>
      calls.filter((call) => call.url.startsWith('/api/v1/admin/users?')).map((call) => call.url);
    const shown = () => get(location).path + get(location).search;

    it('starts from the address: search, filters and page survive a reload and Back', async () => {
      setMe(anna);
      navigate('/admin/users?q=mi&role=member&status=inactive&page=3', { replace: true });
      const { calls } = serve();
      render(AdminUsers);
      await waitFor(() => expect(requests(calls)).toHaveLength(1));
      const asked = new URL(requests(calls)[0], 'https://dock.example').searchParams;
      expect(asked.get('search')).toBe('mi');
      expect(asked.get('role')).toBe('member');
      expect(asked.get('active')).toBe('false');
      expect(asked.get('page')).toBe('3');
      expect(screen.getByRole('searchbox')).toHaveValue('mi');
      expect(screen.getByTestId('users-filter-role')).toHaveValue('member');
      expect(screen.getByTestId('users-filter-status')).toHaveValue('inactive');
      expect(shown()).toBe('/admin/users?q=mi&role=member&status=inactive&page=3');
    });

    it('takes nonsense in the address for the list as it opens', async () => {
      setMe(anna);
      navigate('/admin/users?role=emperor&status=asleep&page=-4', { replace: true });
      const { calls } = serve();
      render(AdminUsers);
      await waitFor(() => expect(requests(calls)).toHaveLength(1));
      const asked = new URL(requests(calls)[0], 'https://dock.example').searchParams;
      expect(asked.get('page')).toBe('1');
      expect(asked.get('role')).toBeNull();
      expect(shown()).toBe('/admin/users');
    });

    it('writes what is chosen into the address, without an entry in the history for it', async () => {
      setMe(anna);
      navigate('/admin/users', { replace: true });
      serve();
      render(AdminUsers);
      await waitFor(() => expect(document.querySelector('tr[data-username="mia"]')).not.toBeNull());
      const before = history.length;
      await fireEvent.change(screen.getByTestId('users-filter-role'), {
        target: { value: 'user_manager' },
      });
      await waitFor(() => expect(shown()).toBe('/admin/users?role=user_manager'));
      await fireEvent.click(screen.getByRole('button', { name: 'Nächste Seite' }));
      await waitFor(() => expect(shown()).toBe('/admin/users?role=user_manager&page=2'));
      // Typing is one search, not one entry per letter (and not one request per letter).
      const search = screen.getByRole('searchbox');
      for (const typed of ['b', 'be', 'ben']) {
        await fireEvent.input(search, { target: { value: typed } });
      }
      await waitFor(() => expect(shown()).toBe('/admin/users?role=user_manager&q=ben'));
      expect(history.length).toBe(before);
      expect(window.location.search).toBe('?role=user_manager&q=ben');
    });

    it('follows the address when it changes under the open page', async () => {
      setMe(anna);
      navigate('/admin/users?q=mi&page=2', { replace: true });
      const { calls } = serve();
      render(AdminUsers);
      await waitFor(() => expect(requests(calls)).toHaveLength(1));
      // The link to this page in the navigation: the list as it opens.
      navigate('/admin/users');
      await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
      await waitFor(() => expect(requests(calls).at(-1)).toContain('page=1'));
      const last = new URL(requests(calls).at(-1) ?? '', 'https://dock.example').searchParams;
      expect(last.get('search') ?? '').toBe('');
      expect(shown()).toBe('/admin/users');
    });
  });

  it('moves the focus to the next row when the row that had it was deleted', async () => {
    setMe(anna);
    const ben = row({ id: 'u-ben', username: 'ben', display_name: 'Ben Büro' });
    let people = [self, row({}), ben];
    stubApi({
      'GET /api/v1/admin/users': () => list(people),
      'GET /api/v1/admin/groups': () => [],
      'DELETE /api/v1/admin/users/u-mia': () => {
        people = [self, ben];
        return { deleted_identity: true };
      },
    });
    render(ConfirmDialog);
    render(AdminUsers);
    await openMenu('mia');
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Konto löschen' }));
    const question = await screen.findByRole('dialog', { name: 'Konto löschen' });
    await fireEvent.click(within(question).getByRole('button', { name: 'Konto löschen' }));
    await waitFor(() => expect(document.querySelector('tr[data-username="mia"]')).toBeNull());
    // Not on <body>: on the menu of the row that stands where the deleted one stood.
    const next = document.querySelector<HTMLElement>('tr[data-username="ben"]');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(next as HTMLElement).getByTestId('user-actions')),
    );
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
    // A screen reader hears where the app is now: the button keeps its name.
    const said = screen.getByTestId('apps-moved');
    expect(said).toHaveAttribute('role', 'status');
    expect(said).toHaveAttribute('aria-live', 'polite');
    expect(said).toHaveTextContent('Wiki: Position 2 von 3');
    // Still on "Wiki nach unten": pressing again moves the same app again.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Wiki nach unten' })).toHaveFocus(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    await waitFor(() => expect(names()).toEqual(['mail', 'crm', 'wiki']));
    expect(said).toHaveTextContent('Wiki: Position 3 von 3');
    // At the end of the list that button is disabled; the other one of the row takes over.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Wiki nach oben' })).toHaveFocus(),
    );
    expect(screen.getByRole('button', { name: 'Wiki nach unten' })).toBeDisabled();
  });

  // The order request is held back until the test lets it through, one at a time.
  function holdOrderRequests(routes: Parameters<typeof stubApi>[0]) {
    const { calls, mock } = stubApi(routes);
    const waiting: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method === 'PUT') await new Promise<void>((resolve) => waiting.push(resolve));
        return mock(input, init);
      }),
    );
    const puts = () => calls.filter((call) => call.method === 'PUT');
    return {
      puts,
      /** Let the oldest held request through and wait until the page has taken its answer. */
      async answer() {
        await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        const sent = puts().length;
        waiting.shift()?.();
        await waitFor(() => expect(puts()).toHaveLength(sent + 1));
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-testid=apps-table] tbody tr')].map(
      (tr) => tr.dataset.appId,
    );

  it('moves the focus to the next row when the row that had it was deleted', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let apps = [stored('a', 'Alpha'), stored('b', 'Beta'), stored('c', 'Gamma')];
    stubApi({
      'GET /api/v1/admin/apps': () => apps,
      'GET /api/v1/admin/groups': () => [],
      'GET /api/v1/workspace/apps': () => [],
      'DELETE /api/v1/admin/apps/c': () => {
        apps = apps.slice(0, 2);
        return new Response(null, { status: 204 });
      },
    });
    render(ConfirmDialog);
    render(AdminApps);
    const last = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-app-id="c"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(last).getByRole('button', { name: /Aktionen/ }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    const question = await screen.findByRole('dialog', { name: 'App löschen' });
    await fireEvent.click(within(question).getByRole('button', { name: 'App löschen' }));
    await waitFor(() => expect(document.querySelector('tr[data-app-id="c"]')).toBeNull());
    // The last row is gone: the one that is last now.
    const before = document.querySelector<HTMLElement>('tr[data-app-id="b"]') as HTMLElement;
    await waitFor(() =>
      expect(document.activeElement).toBe(within(before).getByRole('button', { name: /Aktionen/ })),
    );
  });

  it('says in the language of the page why an app cannot be embedded', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    stubApi({
      'GET /api/v1/admin/apps': () => [
        { ...stored('a', 'Alpha'), embed_status: 'blocked', embed_detail: 'xfo_deny' },
      ],
      'GET /api/v1/admin/groups': () => [],
    });
    render(AdminApps);
    await waitFor(() => expect(document.querySelector('tr[data-app-id="a"]')).not.toBeNull());
    const hint = document.querySelector('tr[data-app-id="a"] [title*="X-Frame-Options"]');
    expect(hint).toHaveAttribute(
      'title',
      'Die Seite verbietet jedes Einbetten (X-Frame-Options: DENY).',
    );
    expect(document.querySelector('[title="xfo_deny"]')).toBeNull();
  });

  it('leaves the focus where the user has taken it while a move was being stored', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let order = [stored('wiki', 'Wiki'), stored('mail', 'Mail'), stored('crm', 'CRM')];
    const held = holdOrderRequests({
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
    down.focus();
    await fireEvent.click(down);
    await waitFor(() => expect(rows()).toEqual(['mail', 'wiki', 'crm']));
    // On to something else in the table before the server has answered: the row's menu.
    const menu = screen.getByRole('button', { name: 'Aktionen für Wiki' });
    menu.focus();
    await held.answer();
    expect(menu).toHaveFocus();
    // The same for another row's move button.
    const other = screen.getByRole('button', { name: 'CRM nach oben' });
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    other.focus();
    await held.answer();
    expect(other).toHaveFocus();
  });

  it('carries out a press that came while a move was being stored', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let order = [
      stored('wiki', 'Wiki'),
      stored('mail', 'Mail'),
      stored('crm', 'CRM'),
      stored('chat', 'Chat'),
    ];
    const held = holdOrderRequests({
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
    down.focus();
    // Three presses, faster than the server answers the first.
    await fireEvent.click(down);
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    expect(rows()).toEqual(['mail', 'wiki', 'crm', 'chat']); // one move is shown, one remembered
    await held.answer();
    // The remembered press follows by itself …
    await waitFor(() => expect(rows()).toEqual(['mail', 'crm', 'wiki', 'chat']));
    expect(screen.getByTestId('apps-moved')).toHaveTextContent('Wiki: Position 3 von 4');
    await held.answer();
    // … and it was one: two requests, and the focus is still on the app that moved.
    expect(held.puts().map((call) => (call.body as { app_ids: string[] }).app_ids)).toEqual([
      ['mail', 'wiki', 'crm', 'chat'],
      ['mail', 'crm', 'wiki', 'chat'],
    ]);
    expect(rows()).toEqual(['mail', 'crm', 'wiki', 'chat']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Wiki nach unten' })).toHaveFocus(),
    );
  });

  it('forgets the remembered press when the move it waited for failed', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    const order = [stored('wiki', 'Wiki'), stored('mail', 'Mail'), stored('crm', 'CRM')];
    const held = holdOrderRequests({
      'GET /api/v1/admin/apps': () => order,
      'GET /api/v1/admin/groups': () => [],
      'PUT /api/v1/admin/apps/order': () => errorResponse(409, 'order_mismatch'),
    });
    render(AdminApps);
    const down = await screen.findByRole('button', { name: 'Wiki nach unten' });
    await fireEvent.click(down);
    await fireEvent.click(screen.getByRole('button', { name: 'Wiki nach unten' }));
    await held.answer();
    await waitFor(() => expect(rows()).toEqual(['wiki', 'mail', 'crm']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.puts()).toHaveLength(1);
    expect(screen.getByTestId('apps-moved')).toHaveTextContent('Wiki: Position 1 von 3');
  });
});

describe('System administration: settings', () => {
  const stored = {
    instance_name: 'Velydock',
    default_nav_position: 'left',
    default_theme: 'dark',
    default_language: 'de',
    require_admin_2fa: false,
    smtp: {
      host: 'smtp.example.org',
      port: 587,
      from_address: 'velydock@example.org',
      from_name: 'Velydock',
      username: 'velydock',
      password: '',
      encryption: 'starttls',
    },
    smtp_configured: true,
  };

  it('asks for the SMTP password at its field when the connection was changed without it', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    const { calls } = stubApi({
      'GET /api/v1/system/settings': () => stored,
      'PATCH /api/v1/system/settings': () =>
        errorResponse(422, 'smtp_password_required', {
          fields: [{ field: 'smtp.password', message: 'is required again' }],
        }),
    });
    render(SystemSettings);
    const host = await screen.findByLabelText('Server');
    await fireEvent.input(host, { target: { value: 'mail.neu.example' } });
    await fireEvent.click(screen.getByRole('button', { name: 'SMTP speichern' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const password = screen.getByLabelText('Passwort');
    // Said at the field it is about, which is marked and gets the focus.
    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    expect(
      screen.getByText(/Gib das SMTP-Passwort noch einmal ein/, { selector: '.error' }),
    ).toBeVisible();
    await waitFor(() => expect(password).toHaveFocus());
    expect(screen.queryByRole('alert')).toBeNull(); // and not a second time above the form
    expect(host).toHaveValue('mail.neu.example'); // what was typed stays
  });

  describe('and the name of the installation', () => {
    const name = () => screen.getByLabelText('Name der Installation');
    const save = () => screen.getByRole('button', { name: 'Speichern' });
    async function open(routes: Parameters<typeof stubApi>[0] = {}) {
      setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
      const api = stubApi({ 'GET /api/v1/system/settings': () => stored, ...routes });
      render(SystemSettings);
      await screen.findByLabelText('Name der Installation');
      return api;
    }
    const sent = (calls: { method: string }[]) => calls.filter((call) => call.method !== 'GET');

    it.each(['', '   '])('must not be emptied: "%s" is an error at the field', async (value) => {
      const { calls } = await open();
      await fireEvent.input(name(), { target: { value } });
      await fireEvent.click(save());
      expect(screen.getByText('Dieses Feld wird gebraucht.')).toBeVisible();
      expect(name()).toHaveAttribute('aria-invalid', 'true');
      await waitFor(() => expect(name()).toHaveFocus());
      // And not "Es gibt nichts zu speichern.", which was the answer before.
      expect(get(toasts)).toEqual([]);
      expect(sent(calls)).toEqual([]);
    });

    it.each(['<b>Intranet</b>', 'Intranet &lt;b&gt;', 'A &#60; B'])(
      'must not read as markup: "%s" is refused at the field before it is sent',
      async (value) => {
        const { calls } = await open();
        await fireEvent.input(name(), { target: { value } });
        await fireEvent.click(save());
        expect(screen.getByText(/Der Name darf weder < noch > enthalten/)).toBeVisible();
        expect(name()).toHaveAttribute('aria-invalid', 'true');
        expect(sent(calls)).toEqual([]);
        // Corrected: the message goes at once.
        await fireEvent.input(name(), { target: { value: 'Intranet' } });
        expect(screen.queryByText(/Der Name darf weder < noch > enthalten/)).toBeNull();
        // And it is said again when the same mistake is made again.
        await fireEvent.input(name(), { target: { value } });
        await fireEvent.click(save());
        expect(screen.getByText(/Der Name darf weder < noch > enthalten/)).toBeVisible();
      },
    );

    it('may hold a plain ampersand, and is sent as the server stores it', async () => {
      const { calls } = await open({
        'PATCH /api/v1/system/settings': () => ({ ...stored, instance_name: 'Müller & Söhne' }),
        'GET /api/v1/me': () => makeMe(),
      });
      await fireEvent.input(name(), { target: { value: '  Müller  &  Söhne ' } });
      await fireEvent.click(save());
      await waitFor(() => expect(sent(calls)).toHaveLength(1));
      expect(sent(calls)[0]).toMatchObject({ body: { instance_name: 'Müller & Söhne' } });
    });

    it('shows what the server refuses about it at the field, not as a general alert', async () => {
      // The server is the authority: a rule this version of the page does not know.
      await open({
        'PATCH /api/v1/system/settings': () =>
          errorResponse(422, 'validation', {
            fields: [
              {
                field: 'instance_name',
                message:
                  'Value error, must not contain < or > or character references such as &lt;',
              },
            ],
          }),
      });
      await fireEvent.input(name(), { target: { value: 'Neuer Name' } });
      await fireEvent.click(save());
      await waitFor(() => expect(name()).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getByText(/Der Name darf weder < noch > enthalten/)).toBeVisible();
      expect(get(toasts)).toEqual([]);
      expect(name()).toHaveValue('Neuer Name'); // what was typed stays
    });

    it('is no change when only blanks differ: nothing to save', async () => {
      const { calls } = await open();
      await fireEvent.input(name(), { target: { value: ' Velydock  ' } });
      await fireEvent.click(save());
      await waitFor(() =>
        expect(get(toasts).map((toast) => `${toast.kind}: ${toast.message}`)).toEqual([
          'info: Es gibt nichts zu speichern.',
        ]),
      );
      expect(sent(calls)).toEqual([]);
    });
  });

  it('does not announce SMTP settings as saved when nothing about them was changed', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    const { calls } = stubApi({ 'GET /api/v1/system/settings': () => stored });
    render(SystemSettings);
    await screen.findByLabelText('Server');
    await fireEvent.click(screen.getByRole('button', { name: 'SMTP speichern' }));
    await waitFor(() =>
      expect(get(toasts).map((toast) => `${toast.kind}: ${toast.message}`)).toEqual([
        'info: Es gibt nichts zu speichern.',
      ]),
    );
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('saves SMTP settings when only a new password was entered', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    const { calls } = stubApi({
      'GET /api/v1/system/settings': () => stored,
      'PATCH /api/v1/system/settings': () => stored,
    });
    render(SystemSettings);
    await screen.findByLabelText('Server');
    await fireEvent.input(screen.getByLabelText('Passwort'), { target: { value: 'geheim-neu' } });
    await fireEvent.click(screen.getByRole('button', { name: 'SMTP speichern' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
  });

  it('reports any other failure of saving SMTP above the form', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    stubApi({
      'GET /api/v1/system/settings': () => stored,
      'PATCH /api/v1/system/settings': () => errorResponse(503, 'idp_unavailable'),
    });
    render(SystemSettings);
    await fireEvent.input(await screen.findByLabelText('Server'), {
      target: { value: 'mail.neu.example' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'SMTP speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Anmeldedienst');
    expect(screen.getByLabelText('Passwort')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('System administration: organizations', () => {
  const tenant = (ref: { id: string; slug: string; name: string }): Tenant => ({
    ...ref,
    active: true,
    protected: false,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 3,
    app_count: 1,
    created_at: '',
  });

  it('enters an organization and is on its start page before anything renders for it', async () => {
    const root = makeMe({
      user: { ...makeMe().user, is_system_admin: true },
      permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
    });
    setMe(root);
    navigate('/system/tenants', { replace: true });
    const { calls } = stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME), tenant(MAIN)],
      'POST /api/v1/me/active-tenant': () => makeMe({ ...root, active_tenant: MAIN }),
    });
    render(SystemTenants);
    const entry = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-slug="main"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    // Pages render in a microtask after the store changed: this is the address they find.
    const found: string[] = [];
    const unsubscribe = me.subscribe((value) => {
      if (value?.active_tenant?.id === MAIN.id)
        queueMicrotask(() => found.push(get(location).path));
    });
    await fireEvent.click(within(entry).getByRole('button', { name: 'Betreten' }));
    await waitFor(() => expect(found).toHaveLength(1));
    unsubscribe();
    expect(found).toEqual(['/']);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { tenant_id: MAIN.id } });
    await waitFor(() =>
      expect(get(toasts).map((toast) => toast.message)).toEqual(['Du bist jetzt in Admin Cave.']),
    );
  });
});

describe('System administration: organizations that cannot go', () => {
  const tenant = (
    ref: { id: string; slug: string; name: string },
    overrides: Partial<Tenant> = {},
  ): Tenant => ({
    ...ref,
    active: true,
    protected: false,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 3,
    app_count: 1,
    created_at: '',
    ...overrides,
  });
  const root = makeMe({
    user: { ...makeMe().user, is_system_admin: true },
    permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
  });
  const rowOf = (slug: string) =>
    waitFor(() => {
      const found = document.querySelector<HTMLElement>(`tr[data-slug="${slug}"]`);
      if (!found) throw new Error('row not there yet');
      return found;
    });

  it('does not offer to deactivate or delete the organization of a system administrator, and says why', async () => {
    setMe(root);
    stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME, { protected: true }), tenant(MAIN)],
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-actions'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Deaktivieren' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Löschen' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Umbenennen' })).toBeEnabled();
    expect(within(menu).getByTestId('tenant-protected')).toHaveTextContent(
      'Zu dieser Organisation gehört das Konto eines Systemadministrators.',
    );
    await fireEvent.keyDown(menu, { key: 'Escape' });

    // Any other organization can go, and there is nothing to explain.
    await fireEvent.click(within(await rowOf('main')).getByTestId('tenant-actions'));
    const other = await screen.findByRole('menu');
    expect(within(other).getByRole('menuitem', { name: 'Deaktivieren' })).toBeEnabled();
    expect(within(other).getByRole('menuitem', { name: 'Löschen' })).toBeEnabled();
    expect(within(other).queryByTestId('tenant-protected')).toBeNull();
  });

  it('moves the focus to the next row when an organization was deleted', async () => {
    setMe(root);
    const third = { id: 't-zeta', slug: 'zeta', name: 'Zeta AG' };
    let tenants = [tenant(ACME), tenant(MAIN), tenant(third)];
    stubApi({
      'GET /api/v1/system/tenants': () => tenants,
      'GET /api/v1/me': () => root,
      [`POST /api/v1/system/tenants/${MAIN.id}/delete`]: () => {
        tenants = [tenant(ACME), tenant(third)];
        return new Response(null, { status: 204 });
      },
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('main')).getByTestId('tenant-actions'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    const dialog = await screen.findByRole('dialog');
    await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: MAIN.slug } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(document.querySelector('tr[data-slug="main"]')).toBeNull());
    const next = await rowOf('zeta');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(next).getByTestId('tenant-actions')),
    );
  });
});

describe('System administration: all users', () => {
  const root = makeMe({
    user: { ...makeMe().user, is_system_admin: true },
    permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
  });
  const account = (overrides: Partial<SystemUser>): SystemUser => ({
    id: 'u-mia',
    username: 'mia',
    email: 'mia@acme.example',
    display_name: 'Mia Mitglied',
    active: true,
    is_system_admin: false,
    home_tenant: ACME,
    memberships: [{ tenant: ACME, role: 'member' }],
    last_login_at: null,
    ...overrides,
  });
  const me = account({
    id: root.user.id,
    username: 'anna',
    display_name: 'Anna Admin',
    is_system_admin: true,
  });
  const serve = () =>
    stubApi({
      'GET /api/v1/system/users': () => ({
        items: [me, account({})],
        total: 60,
        page: 1,
        page_size: 25,
      }),
      'GET /api/v1/system/tenants': () => [],
    });
  const requests = (calls: { url: string }[]) =>
    calls.filter((call) => call.url.startsWith('/api/v1/system/users?')).map((call) => call.url);
  const shown = () => get(location).path + get(location).search;

  it('keeps search and page in the address', async () => {
    setMe(root);
    navigate('/system/users?q=mia&page=2', { replace: true });
    const { calls } = serve();
    render(SystemUsers);
    await waitFor(() => expect(requests(calls)).toHaveLength(1));
    const asked = new URL(requests(calls)[0], 'https://dock.example').searchParams;
    expect(asked.get('search')).toBe('mia');
    expect(asked.get('page')).toBe('2');
    expect(screen.getByRole('searchbox')).toHaveValue('mia');
    const before = history.length;
    await fireEvent.click(await screen.findByRole('button', { name: 'Nächste Seite' }));
    await waitFor(() => expect(shown()).toBe('/system/users?q=mia&page=3'));
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
    await waitFor(() => expect(shown()).toBe('/system/users'));
    expect(history.length).toBe(before);
  });

  it('says why the own system administrator right cannot be revoked', async () => {
    setMe(root);
    navigate('/system/users', { replace: true });
    serve();
    render(SystemUsers);
    const own = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-username="anna"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(own).getByTestId('system-user-actions'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitem', { name: 'Systemadministrator-Recht entziehen' }),
    ).toBeDisabled();
    expect(within(menu).getByTestId('revoke-self')).toHaveTextContent(
      'Das eigene Systemadministrator-Recht kannst du dir nicht selbst entziehen.',
    );
  });
});

describe('Audit log', () => {
  const entries = {
    items: [
      {
        id: 'a1',
        created_at: '2026-11-20T10:00:00Z',
        actor_name: 'Anna Admin',
        action: 'system.settings',
        target_type: 'settings',
        target_name: '',
        details: { fields: ['require_admin_2fa'], values: { require_admin_2fa: false } },
      },
    ],
    total: 170,
    page: 1,
    page_size: 50,
  };
  const shown = () => get(location).path + get(location).search;

  it('keeps the page in the address, and says which way a setting was changed', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    navigate('/system/audit?page=3', { replace: true });
    const { calls } = stubApi({ 'GET /api/v1/system/audit': () => entries });
    render(AuditLog, { scope: 'system' });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(new URL(calls[0].url, 'https://dock.example').searchParams.get('page')).toBe('3');
    expect(await screen.findByText('Zwei-Faktor für Administratoren: aus')).toBeVisible();
    const before = history.length;
    await fireEvent.click(screen.getByRole('button', { name: 'Vorherige Seite' }));
    await waitFor(() => expect(shown()).toBe('/system/audit?page=2'));
    expect(history.length).toBe(before);
  });

  it('opens on the last page when the address names one beyond the end', async () => {
    setMe(makeMe({ permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'] }));
    navigate('/system/audit?page=99', { replace: true });
    stubApi({ 'GET /api/v1/system/audit': () => entries });
    render(AuditLog, { scope: 'system' });
    await waitFor(() => expect(shown()).toBe('/system/audit?page=4'));
  });
});

describe('Administration: groups', () => {
  const group = (id: string, name: string) => ({
    id,
    name,
    description: '',
    member_count: 2,
    app_count: 1,
    created_at: '',
  });

  it('moves the focus to the next row when the row that had it was deleted', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let groups = [group('g-a', 'Büro'), group('g-b', 'IT'), group('g-c', 'Vertrieb')];
    stubApi({
      'GET /api/v1/admin/groups': () => groups,
      'DELETE /api/v1/admin/groups/g-a': () => {
        groups = groups.slice(1);
        return new Response(null, { status: 204 });
      },
    });
    render(ConfirmDialog);
    render(AdminGroups);
    const first = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-group-id="g-a"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(first).getByTestId('group-actions'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    const question = await screen.findByRole('dialog', { name: 'Gruppe löschen' });
    await fireEvent.click(within(question).getByRole('button', { name: 'Gruppe löschen' }));
    await waitFor(() => expect(document.querySelector('tr[data-group-id="g-a"]')).toBeNull());
    const next = document.querySelector<HTMLElement>('tr[data-group-id="g-b"]') as HTMLElement;
    await waitFor(() =>
      expect(document.activeElement).toBe(within(next).getByTestId('group-actions')),
    );
  });

  it('moves the focus to the page when the last group was deleted', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    let groups = [group('g-a', 'Büro')];
    stubApi({
      'GET /api/v1/admin/groups': () => groups,
      'DELETE /api/v1/admin/groups/g-a': () => {
        groups = [];
        return new Response(null, { status: 204 });
      },
    });
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.appendChild(main);
    render(ConfirmDialog);
    render(AdminGroups, { target: main });
    const only = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-group-id="g-a"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(only).getByTestId('group-actions'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    const question = await screen.findByRole('dialog', { name: 'Gruppe löschen' });
    await fireEvent.click(within(question).getByRole('button', { name: 'Gruppe löschen' }));
    await waitFor(() => expect(document.querySelector('tr[data-group-id="g-a"]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(main));
    main.remove();
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
    // The page is this message and nothing else: it is its heading.
    expect(screen.getByRole('heading', { level: 1, name: 'Kein Zugriff' })).toBeVisible();
  });
});
