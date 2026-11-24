// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { api } from '$lib/api/client';
import type { Me, Tenant, User } from '$lib/api/types';
import { confirmDialog } from '$lib/components/ui/ConfirmDialog.svelte';
import { setLanguage } from '$lib/i18n';
import { location, navigate } from '$lib/router';
import { revalidateSession, session, sessionEnded, setMe, signOut } from '$lib/stores/session';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { frames, resetWorkspace } from '$lib/stores/workspace';
import { accentTokens } from '$lib/accent';
import { ACCENT_STORAGE_KEY, applyAccent, setAccentColor, setThemePreference } from '$lib/theme';
import { reloadPage } from '$lib/utils/browser';
import {
  ACME,
  MAIN,
  PERMISSIONS,
  SETTINGS,
  errorResponse,
  makeApp,
  makeMe,
  stubApi,
  stubMatchMedia,
} from './test/fixtures';
import App from './App.svelte';

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

// The whole app, as main.ts mounts it, against a stand-in for the API: what App.svelte
// itself decides. Which page is on screen, when a page starts over, where the user is
// sent when the session ends, what happens to a question that is still open.

const TENANT_HEADER = 'X-Velydock-Tenant';
const both = [
  { tenant: ACME, role: 'tenant_admin' as const },
  { tenant: MAIN, role: 'tenant_admin' as const },
];
/** A system administrator who administers both organizations. */
const root = (active: typeof ACME | null = ACME): Me =>
  makeMe({
    user: { ...makeMe().user, is_system_admin: true },
    active_tenant: active,
    role: 'tenant_admin',
    permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
    memberships: both,
  });
const member = (id: string, username: string, name: string): User => ({
  id,
  username,
  email: `${username}@example.org`,
  first_name: name,
  last_name: 'Beispiel',
  display_name: `${name} Beispiel`,
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
});
const organization = (ref: typeof ACME): Tenant => ({
  ...ref,
  active: true,
  protected: false,
  proxy_path_allowed: true,
  default_nav_position: null,
  nav_position_locked: false,
  member_count: 3,
  app_count: 1,
  created_at: '',
});
const gone = () => errorResponse(401, 'not_authenticated');

/** The API as the server would answer for `server.me`, which a test changes at will. */
function serve(server: { me: Me | null }, extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    'GET /api/v1/me': () => server.me ?? gone(),
    'GET /api/v1/public': () => ({
      instance_name: 'Velydock',
      default_language: 'de',
      default_theme: 'dark',
      version: '0.1.0',
    }),
    'GET /api/v1/workspace/apps': () => [
      makeApp({ id: 'wiki', name: 'Wiki' }),
      makeApp({ id: 'mail', name: 'Mail', url: 'https://mail.example/' }),
    ],
    'GET /api/v1/admin/users': () => {
      const items =
        server.me?.active_tenant?.id === MAIN.id
          ? [member('u-bob', 'bob', 'Bob')]
          : [member('u-mia', 'mia', 'Mia')];
      return { items, total: items.length, page: 1, page_size: 25 };
    },
    'GET /api/v1/admin/groups': () => [],
    'GET /api/v1/system/tenants': () => [organization(ACME), organization(MAIN)],
    ...extra,
  });
}

/** Mount the app at an address, signed in as the user the server describes. */
async function open(path: string, server: { me: Me | null }) {
  if (server.me) setMe(server.me);
  navigate(path, { replace: true });
  const view = render(App);
  await waitFor(() => expect(screen.getByTestId('dock')).toBeInTheDocument());
  return view;
}
const address = () => get(location).path + get(location).search;
const userRow = (username: string) =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(`tr[data-username="${username}"]`);
    if (!found) throw new Error(`no row for ${username} yet`);
    return found;
  });
const notices = () => get(toasts).map((toast) => toast.message);

beforeEach(() => {
  stubMatchMedia();
  resetWorkspace();
  localStorage.clear();
  vi.mocked(reloadPage).mockClear();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
  setThemePreference('system', { persist: false });
  setAccentColor(null);
  applyAccent(null, 'dark');
  navigate('/', { replace: true });
});

describe('when the organization changes', () => {
  it('starts a page of the organization over, for the new one', async () => {
    const server = { me: root(ACME) };
    const { calls } = serve(server);
    await open('/admin/users', server);
    await userRow('mia');
    // An unsaved dialog on the page of Acme.
    await fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Benutzer anlegen' });
    await fireEvent.input(within(dialog).getByLabelText('Vorname'), { target: { value: 'Karl' } });

    server.me = root(MAIN); // switched in another tab
    calls.length = 0;
    await revalidateSession({ force: true });

    // The page is the one of Admin Cave now: its own list, read in its own name …
    await userRow('bob');
    expect(document.querySelector('tr[data-username="mia"]')).toBeNull();
    const lists = calls.filter((call) => call.url.startsWith('/api/v1/admin/users'));
    expect(lists.map((call) => call.headers[TENANT_HEADER])).toEqual([MAIN.id]);
    // … and what was open for Acme is gone with the page it belonged to.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(address()).toBe('/admin/users');
    expect(notices()).toEqual([
      'Die aktive Organisation hat sich geändert, zum Beispiel in einem anderen Fenster. Du arbeitest jetzt in „Admin Cave“.',
    ]);
  });

  it('leaves a page that does not depend on the organization as it is, unsaved input included', async () => {
    const server = { me: root(ACME) };
    const { calls } = serve(server);
    await open('/system/tenants', server);
    await waitFor(() => expect(document.querySelector('tr[data-slug="main"]')).not.toBeNull());
    await fireEvent.click(screen.getAllByRole('button', { name: 'Organisation anlegen' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Organisation anlegen' });
    await fireEvent.input(within(dialog).getByLabelText('Name'), {
      target: { value: 'Stadtwerke Musterstadt' },
    });

    server.me = root(MAIN); // entered in another tab
    calls.length = 0;
    await revalidateSession({ force: true });
    await waitFor(() =>
      expect(screen.getByTestId('tenant-switcher')).toHaveTextContent('Admin Cave'),
    );

    // The system administration is the same in every organization: nothing was read
    // again, and the dialog still holds what was typed.
    expect(screen.getByRole('dialog', { name: 'Organisation anlegen' })).toBe(dialog);
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Stadtwerke Musterstadt');
    expect(calls.map((call) => call.url)).not.toContain('/api/v1/system/tenants');
    // The user is still told that the organization is another one now.
    expect(notices()).toHaveLength(1);
  });

  it('withdraws a question that is still open', async () => {
    const server = { me: root(ACME) };
    serve(server);
    // On a page that stays, so that nothing but the withdrawal can close the question.
    await open('/system/tenants', server);
    const answer = vi.fn();
    void confirmDialog('Konto von Mia Beispiel endgültig löschen?', {
      title: 'Konto löschen',
    }).then(answer);
    const question = await screen.findByRole('dialog', { name: 'Konto löschen' });
    expect(question).toHaveTextContent('Mia Beispiel');

    server.me = root(MAIN);
    await revalidateSession({ force: true });

    // Asked in Acme, it must not be answered "yes" in Admin Cave.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(answer).toHaveBeenCalledWith(false);
  });

  it('keeps an open question through a check that finds the same organization', async () => {
    const server = { me: root(ACME) };
    serve(server);
    await open('/system/tenants', server);
    const answer = vi.fn();
    void confirmDialog('Wirklich?', { title: 'Bitte bestätigen' }).then(answer);
    await screen.findByRole('dialog', { name: 'Bitte bestätigen' });
    server.me = root(ACME); // a new answer, the same organization
    await revalidateSession({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('dialog', { name: 'Bitte bestätigen' })).toBeVisible();
    expect(answer).not.toHaveBeenCalled();
  });

  it('goes to the start page on a switch in the dock, without mounting the old page for the new organization', async () => {
    const server = { me: root(ACME) };
    const { calls } = serve(server, {
      'POST /api/v1/me/active-tenant': () => {
        server.me = root(MAIN);
        return server.me;
      },
    });
    await open('/admin/users', server);
    await userRow('mia');
    calls.length = 0;
    await fireEvent.click(screen.getByTestId('tenant-switcher'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Admin Cave/ }));
    await waitFor(() => expect(address()).toBe('/'));
    await waitFor(() =>
      expect(screen.getByTestId('tenant-switcher')).toHaveTextContent('Admin Cave'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The user list of Acme was not opened once more to ask for the users of Admin Cave.
    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'POST /api/v1/me/active-tenant',
      'GET /api/v1/workspace/apps',
    ]);
    expect(notices()).toEqual([]); // the user's own switch needs no explanation
  });
});

describe('the session', () => {
  it('is watched from the moment the app is mounted until it is gone', async () => {
    const server = { me: root(ACME) };
    serve(server);
    const view = await open('/', server);
    // A page that the browser brings back from its back/forward cache is loaded anew.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    view.unmount();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('leads to the login page, which says that it has expired and remembers the way back', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server, { 'GET /api/v1/admin/audit': gone });
    await open('/admin/users', server);
    await userRow('mia');
    server.me = null;
    await api.get('/api/v1/admin/audit').catch(() => {}); // any request of the user: 401
    await waitFor(() => expect(address()).toBe('/login?expired=1&return_to=%2Fadmin%2Fusers'));
    expect(await screen.findByTestId('login-message')).toHaveTextContent(
      'Deine Sitzung ist abgelaufen oder wurde beendet.',
    );
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('sends somebody who is not signed in to the login page without that message', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server, { 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    // Back to what a fresh page starts with: no user yet, and none on the server.
    setMe(root(ACME));
    await signOut();
    server.me = null;
    navigate('/admin/users', { replace: true });
    render(App);
    await waitFor(() => expect(address()).toBe('/login?return_to=%2Fadmin%2Fusers'));
    await screen.findByTestId('login-button');
    // "Expired" is for a session that was in use on this page.
    expect(screen.queryByTestId('login-message')).toBeNull();
  });
});

describe('a session that ends while an app is open', () => {
  it('keeps the app, says so, and leaves for the login page through the button', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server);
    await open('/app/wiki', server);
    const frame = await screen.findByTestId('app-frame');
    expect(get(frames)).toHaveLength(1);

    server.me = null; // the session reaches the end of its life
    await revalidateSession({ force: true });

    const notice = await screen.findByTestId('session-ended');
    expect(notice).toHaveTextContent('Deine Velydock-Sitzung ist beendet');
    expect(screen.getByTestId('app-frame')).toBe(frame); // the very same frame: not reloaded
    expect(screen.getByTestId('dock')).toBeInTheDocument();
    expect(address()).toBe('/app/wiki');
    expect(get(session).status).toBe('ready');

    await fireEvent.click(within(notice).getByRole('button', { name: 'Neu anmelden' }));
    await waitFor(() => expect(address()).toBe('/login?expired=1&return_to=%2Fapp%2Fwiki'));
    expect(await screen.findByTestId('login-message')).toHaveTextContent(
      'Deine Sitzung ist abgelaufen oder wurde beendet.',
    );
    expect(screen.queryByTestId('app-frame')).toBeNull();
    expect(get(sessionEnded)).toBe(false);
  });

  it('lets the user go from app to app, and leads to the login page from anywhere else', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server);
    await open('/app/wiki', server);
    const frame = await screen.findByTestId('app-frame');
    server.me = null;
    await revalidateSession({ force: true });
    await screen.findByTestId('session-ended');

    // Another app: nothing Velydock has to ask the server for.
    await fireEvent.click(screen.getByRole('link', { name: 'Mail' }));
    await waitFor(() => expect(screen.getAllByTestId('app-frame')).toHaveLength(2));
    expect(address()).toBe('/app/mail');
    expect(screen.getAllByTestId('app-frame')[0]).toBe(frame);
    expect(screen.getByTestId('session-ended')).toBeInTheDocument();

    // A page of Velydock itself: there is no session to show it with.
    await fireEvent.click(screen.getByTestId('dock-admin'));
    await waitFor(() => expect(address()).toMatch(/^\/login\?expired=1&return_to=%2Fadmin/));
    expect(screen.queryByTestId('app-frame')).toBeNull();
    expect(await screen.findByTestId('login-message')).toHaveTextContent(
      'Deine Sitzung ist abgelaufen oder wurde beendet.',
    );
  });

  it('goes straight to the login page, as before, when no app is open', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server);
    await open('/admin/users', server);
    await userRow('mia');
    server.me = null;
    await revalidateSession({ force: true });
    await waitFor(() => expect(address()).toBe('/login?expired=1&return_to=%2Fadmin%2Fusers'));
    expect(screen.queryByTestId('session-ended')).toBeNull();
  });
});

describe('what the tab and the page say about where the user is', () => {
  it('names a page the user may not see, in the tab and in a heading', async () => {
    const server = { me: makeMe() }; // a member: no administration
    serve(server);
    await open('/admin/users', server);
    expect(screen.getByTestId('forbidden-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Kein Zugriff' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Kein Zugriff · Velydock'));
  });

  it('gives an address that leads nowhere a heading of its own', async () => {
    const server = { me: root(ACME) };
    serve(server);
    await open('/nirgendwo', server);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Seite nicht gefunden' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Seite nicht gefunden · Velydock'));
  });

  it('names an app that is not among the apps of the user', async () => {
    const server = { me: root(ACME) };
    serve(server);
    await open('/app/gibt-es-nicht', server);
    await waitFor(() => expect(document.title).toBe('Diese App gibt es hier nicht · Velydock'));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Diese App gibt es hier nicht' }),
    ).toBeInTheDocument();
  });

  it('says in the tab that the server did not answer', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server, {
      'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }),
      'GET /api/v1/me': () => errorResponse(500, 'internal_error'),
    });
    // A fresh page whose first question to the server fails.
    setMe(root(ACME));
    await signOut();
    navigate('/admin/users', { replace: true });
    render(App);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Velydock ist gerade nicht erreichbar',
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.title).toBe('Velydock ist gerade nicht erreichbar · Velydock'),
    );
  });

  it('uses the name of the installation on the login page once the server has told it', async () => {
    const server: { me: Me | null } = { me: root(ACME) };
    serve(server, {
      'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }),
      'GET /api/v1/public': () => ({
        instance_name: 'Stadtwerke Intranet',
        default_language: 'de',
        default_theme: 'dark',
        version: '0.1.0',
      }),
    });
    setMe(root(ACME));
    await signOut();
    server.me = null;
    navigate('/login', { replace: true });
    render(App);
    await screen.findByTestId('login-button');
    await waitFor(() => expect(document.title).toBe('Anmelden · Stadtwerke Intranet'));
  });
});

describe('the navigation of the administration', () => {
  it('brings the entry of the page that is opened into view', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as () => void;
    try {
      const server = { me: root(ACME) };
      serve(server);
      await open('/admin/users', server);
      await userRow('mia');
      const entry = (name: string) =>
        within(screen.getByRole('navigation', { name: 'Verwaltung' })).getByRole('link', { name });
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(entry('Benutzer')));
      scrollIntoView.mockClear();
      // Another page of the same area: the navigation stays as it is and follows the page.
      navigate('/admin/groups');
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(entry('Gruppen')));
      scrollIntoView.mockClear();
      // On a narrow screen this entry is out of sight at the far end of the row.
      navigate('/system/tenants');
      await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(entry('Organisationen')));
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });
});

describe('the keyboard focus', () => {
  it('goes to the new page when what held it went away with the old one', async () => {
    const server = { me: root(ACME) };
    serve(server);
    await open('/admin/users', server);
    const row = await userRow('mia');
    // The menu of a row leads elsewhere: its button goes with the page.
    within(row)
      .getByRole('button', { name: /Aktionen/ })
      .focus();
    navigate('/settings');
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main')));
  });

  it('stays where it is when its holder is still there', async () => {
    const server = { me: root(ACME) };
    serve(server);
    await open('/admin/users', server);
    await userRow('mia');
    const link = within(screen.getByTestId('dock')).getAllByRole('link')[0];
    link.focus();
    navigate('/settings');
    await waitFor(() => expect(address()).toBe('/settings'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(link);
  });
});

// Appearance per organization and per user, in the app as a whole: what the server says
// applies (accent colour, logo, the bar at an open app) is on the page, follows the
// organization, and is gone where nobody is signed in.
describe('the appearance of the organization and the user', () => {
  const ORANGE = '#c2410c';
  const TEAL = '#0f766e';
  const html = document.documentElement;
  /** The user of root(), in an organization with a logo, with these settings. */
  const dressed = (
    tenant: typeof ACME,
    logo: string | null,
    settings: Partial<Me['settings']>,
  ): Me => ({
    ...root(tenant),
    active_tenant: { ...tenant, logo_url: logo },
    settings: { ...SETTINGS, theme: 'dark', ...settings },
  });
  const frameOf = (id: string) => document.querySelector(`iframe[data-app-id="${id}"]`);

  it('shows accent colour, logo and bar as the server names them', async () => {
    const server = {
      me: dressed(ACME, '/api/v1/tenant/logo?v=1', { accent_color: ORANGE, app_bar: 'bottom' }),
    };
    serve(server);
    await open('/app/wiki', server);
    expect(html.dataset.accent).toBe(ORANGE);
    expect(html.style.getPropertyValue('--accent')).toBe(accentTokens(ORANGE, 'dark')['--accent']);
    expect(screen.getByTestId('dock-logo')).toHaveAttribute('alt', 'Acme GmbH');
    expect(await screen.findByTestId('app-bar')).toHaveAttribute('data-position', 'bottom');
  });

  it('changes all of it at once when the organization is switched', async () => {
    const server = {
      me: dressed(ACME, '/api/v1/tenant/logo?v=1', { accent_color: ORANGE, app_bar: 'bottom' }),
    };
    serve(server, {
      'POST /api/v1/me/active-tenant': () =>
        (server.me = dressed(MAIN, null, {
          accent_color: TEAL,
          app_bar: 'hidden',
          theme: 'light',
        })),
    });
    await open('/', server);
    expect(html.dataset.accent).toBe(ORANGE);
    await fireEvent.click(screen.getByTestId('tenant-switcher'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Admin Cave/ }));
    await waitFor(() => expect(html.dataset.accent).toBe(TEAL));
    expect(html.dataset.theme).toBe('light');
    expect(html.style.getPropertyValue('--accent')).toBe(accentTokens(TEAL, 'light')['--accent']);
    expect(screen.queryByTestId('dock-logo')).toBeNull(); // that organization has none
    // Its app bar is hidden: an app has no bar there, and the actions are in the menu.
    navigate('/app/wiki');
    await waitFor(() => expect(frameOf('wiki')).not.toBeNull());
    expect(screen.queryByTestId('app-bar')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Wiki' })).toBeInTheDocument();
  });

  it('reloads the app from the user menu while its bar is hidden', async () => {
    const server = { me: dressed(ACME, null, { app_bar: 'hidden' }) };
    serve(server);
    await open('/app/wiki', server);
    await waitFor(() => expect(frameOf('wiki')).not.toBeNull());
    expect(screen.queryByTestId('app-reload')).toBeNull();
    const before = frameOf('wiki');
    await fireEvent.click(screen.getByTestId('user-menu'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'App neu laden' }));
    await waitFor(() => expect(frameOf('wiki')).not.toBe(before));
    expect(frameOf('wiki')).not.toBeNull();
  });

  it('follows a setting the user changes: the bar appears under the open app without loading it anew', async () => {
    const server = { me: dressed(ACME, null, {}) };
    serve(server, {
      'PATCH /api/v1/me/settings': ({ body }) =>
        (server.me = {
          ...server.me,
          settings: { ...server.me.settings, ...(body as object) },
        } as Me),
    });
    await open('/app/wiki', server);
    await waitFor(() => expect(frameOf('wiki')).not.toBeNull());
    const frame = frameOf('wiki');
    // Nobody chose anything: no bar at all.
    expect(screen.queryByTestId('app-bar')).toBeNull();
    await api.patch('/api/v1/me/settings', { body: { app_bar: 'bottom' } });
    await revalidateSession({ force: true });
    await waitFor(() =>
      expect(screen.getByTestId('app-bar')).toHaveAttribute('data-position', 'bottom'),
    );
    expect(frameOf('wiki')).toBe(frame);
  });

  it('shows nothing of it on the login page, whatever the last page of this browser showed', async () => {
    const server: { me: Me | null } = { me: dressed(ACME, null, { accent_color: ORANGE }) };
    serve(server, { 'POST /api/auth/logout': () => ({ redirect_url: '/login?signed_out=1' }) });
    // A session in this browser, which ends; the next page load starts at the login page.
    setMe(server.me as Me);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).not.toBeNull();
    await signOut();
    server.me = null;
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
    navigate('/login', { replace: true });
    render(App);
    await screen.findByTestId('login-button');
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(html.style.getPropertyValue('--accent')).toBe('');
    expect(screen.queryByTestId('dock-logo')).toBeNull();
  });

  it('takes the accent off the page when the session turns out to be gone', async () => {
    const server: { me: Me | null } = { me: dressed(ACME, null, { accent_color: ORANGE }) };
    serve(server, { 'GET /api/v1/admin/audit': gone });
    await open('/admin/users', server);
    await userRow('mia');
    expect(html.dataset.accent).toBe(ORANGE);
    server.me = null;
    await api.get('/api/v1/admin/audit').catch(() => {});
    await screen.findByTestId('login-button');
    expect(html.hasAttribute('data-accent')).toBe(false);
    expect(html.style.getPropertyValue('--accent')).toBe('');
  });
});
