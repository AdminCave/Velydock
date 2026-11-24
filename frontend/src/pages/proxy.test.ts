// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { AdminApp, ProxyTemplate, Publication, Tenant } from '$lib/api/types';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { setLanguage } from '$lib/i18n';
import { SYSTEM_NAV } from '$lib/nav';
import { navigate } from '$lib/router';
import { resolveRoute } from '$lib/routing';
import { setMe } from '$lib/stores/session';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { resetWorkspace } from '$lib/stores/workspace';
import { routes } from '../routes';
import {
  ACME,
  MAIN,
  PERMISSIONS,
  errorResponse,
  jsonResponse,
  makeApp,
  makeMe,
  stubApi,
} from '../test/fixtures';
import AdminApps from './admin/Apps.svelte';
import ProxyTemplates from './system/ProxyTemplates.svelte';
import SystemTenants from './system/Tenants.svelte';

// Publishing through the proxy on the pages: the marks in the app list, the releases on
// the organizations page, and the page of the templates.

vi.mock('$lib/utils/browser', () => ({ leaveTo: vi.fn(), reloadPage: vi.fn() }));

beforeEach(() => {
  resetWorkspace();
  localStorage.clear();
  navigate('/', { replace: true });
});

afterEach(() => {
  cancelConfirm();
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  setLanguage('de', { persist: false });
});

const root = makeMe({
  user: { ...makeMe().user, is_system_admin: true },
  role: 'tenant_admin',
  permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
});

const publication = (overrides: Partial<Publication> = {}): Publication => ({
  name: 'wiki',
  mode: 'path',
  target_url: 'http://10.20.0.7:8080',
  access: 'protected',
  template: 'builtin:standard',
  options: {},
  public_url: 'https://apps.example.com/wiki/',
  problem: null,
  ...overrides,
});

describe('Administration: apps published through the proxy', () => {
  const stored = (id: string, name: string, overrides: Partial<AdminApp> = {}): AdminApp => ({
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
    ...overrides,
  });
  const published = (id: string, name: string, overrides: Partial<Publication> = {}) => {
    const entry = publication({ name: id, ...overrides });
    return stored(id, name, { url: entry.public_url, publication: entry });
  };

  async function list(apps: AdminApp[]) {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    stubApi({
      'GET /api/v1/admin/apps': () => apps,
      'GET /api/v1/admin/groups': () => [],
      'GET /api/v1/workspace/apps': () => [],
    });
    render(AdminApps);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid=apps-table] tbody tr')).toHaveLength(
        apps.length,
      ),
    );
  }
  const row = (id: string) => document.querySelector<HTMLElement>(`tr[data-app-id="${id}"]`)!;

  it('says that an app is published, how, and under which address', async () => {
    await list([
      stored('mail', 'Mail'),
      published('wiki', 'Wiki'),
      published('shop', 'Shop', {
        access: 'public',
        mode: 'subdomain',
        public_url: 'https://shop.apps.example.com/',
      }),
    ]);
    const wiki = within(row('wiki')).getByTestId('app-published');
    expect(wiki).toHaveAttribute('data-url', 'https://apps.example.com/wiki/');
    expect(wiki).toHaveTextContent('Veröffentlicht · geschützt');
    // The hook holds what the row says about the app: its name and the address itself.
    expect(wiki).toHaveTextContent('Wiki');
    expect(wiki).toHaveTextContent('https://apps.example.com/wiki/');
    expect(wiki.querySelector('[title]')).toHaveAttribute(
      'title',
      'Über den Proxy veröffentlicht unter https://apps.example.com/wiki/, weitergeleitet an http://10.20.0.7:8080',
    );
    const shop = within(row('shop')).getByTestId('app-published');
    expect(shop).toHaveAttribute('data-url', 'https://shop.apps.example.com/');
    expect(shop).toHaveTextContent('Veröffentlicht · öffentlich');
    // An app with an address of its own carries no such mark.
    expect(within(row('mail')).queryByTestId('app-published')).toBeNull();
    expect(screen.queryByTestId('app-publication-problem')).toBeNull();
  });

  it('warns when the proxy does not serve a publication: what is wrong, and who can fix it', async () => {
    await list([
      published('a', 'A', { problem: 'target_not_allowed' }),
      published('b', 'B', { problem: 'template_missing' }),
      published('c', 'C', { problem: 'mode_not_allowed' }),
      published('d', 'D', { problem: 'proxy_disabled', public_url: '' }),
      published('e', 'E', { problem: 'something_new' }),
      published('f', 'F'),
    ]);
    const problem = (id: string) => within(row(id)).getByTestId('app-publication-problem');
    expect(problem('a')).toHaveAttribute('data-problem', 'target_not_allowed');
    expect(problem('a')).toHaveTextContent(
      'Nicht erreichbar: Die interne Adresse ist für deine Organisation nicht mehr freigegeben. Freigeben kann sie der Systemadministrator.',
    );
    expect(problem('b')).toHaveAttribute('data-problem', 'template_missing');
    expect(problem('b')).toHaveTextContent(
      'Nicht erreichbar: Die Vorlage dieser Veröffentlichung gibt es nicht mehr. Wähl im App-Dialog eine andere.',
    );
    expect(problem('c')).toHaveAttribute('data-problem', 'mode_not_allowed');
    expect(problem('c')).toHaveTextContent(
      'Pfad-Adressen sind für deine Organisation abgeschaltet. Stell die App im App-Dialog auf eine Subdomain um',
    );
    expect(problem('d')).toHaveAttribute('data-problem', 'proxy_disabled');
    expect(problem('d')).toHaveTextContent(
      'Veröffentlichen ist auf dieser Installation nicht eingerichtet.',
    );
    // A reason this version does not know is shown by its code rather than hidden.
    expect(problem('e')).toHaveAttribute('data-problem', 'something_new');
    expect(problem('e')).toHaveTextContent('Nicht erreichbar (something_new).');
    expect(within(row('f')).queryByTestId('app-publication-problem')).toBeNull();
    expect(screen.getAllByTestId('app-publication-problem')).toHaveLength(5);
  });

  it('says it in the language of the page', async () => {
    await list([published('a', 'A', { problem: 'target_not_allowed' })]);
    setLanguage('en', { persist: false });
    await waitFor(() =>
      expect(within(row('a')).getByTestId('app-published')).not.toHaveTextContent('Veröffentlicht'),
    );
    expect(within(row('a')).getByTestId('app-published')).toHaveTextContent(
      'Published · protected',
    );
    expect(within(row('a')).getByTestId('app-publication-problem')).toHaveTextContent(
      'Not reachable: the internal address is no longer released for your organization.',
    );
  });

  it('does not offer to check whether a published app can be embedded: the answer would be the sign-in', async () => {
    await list([published('wiki', 'Wiki'), stored('mail', 'Mail')]);
    // Nor does the list claim to know: no "Einbettbar" for what was never checked.
    expect(row('mail')).toHaveTextContent('Einbettbar');
    expect(row('wiki')).not.toHaveTextContent('Einbettbar');
    await fireEvent.click(within(row('wiki')).getByTestId('app-actions'));
    let menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /prüfen/ })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Bearbeiten' })).toBeInTheDocument();
    await fireEvent.keyDown(menu, { key: 'Escape' });
    await fireEvent.click(within(row('mail')).getByTestId('app-actions'));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /prüfen/ })).toBeInTheDocument();
  });
});

describe('Administration: own middlewares of a published app', () => {
  const app: AdminApp = {
    ...makeApp({ id: 'wiki', name: 'Wiki', url: 'https://apps.example.com/wiki/' }),
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
    publication: publication({
      options: { custom_middlewares: { '10-buero': { ipAllowList: { sourceRange: [] } } } },
    }),
  };

  async function openDialog() {
    stubApi({
      'GET /api/v1/admin/apps': () => [app],
      'GET /api/v1/admin/groups': () => [],
      'GET /api/v1/admin/users': () => ({ items: [], total: 0, page: 1, page_size: 100 }),
      'GET /api/v1/workspace/apps': () => [],
      'GET /api/v1/admin/proxy': () => ({ enabled: true, targets: ['10.20.0.0/16'] }),
    });
    render(AdminApps);
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-app-id="wiki"]');
      if (!found) throw new Error('row not there yet');
      return found;
    });
    await fireEvent.click(within(row).getByTestId('app-actions'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Bearbeiten' }));
    return screen.findByRole('dialog', { name: 'Wiki bearbeiten' });
  }

  it('are a field for the account of a system administrator', async () => {
    setMe(root);
    const dialog = await openDialog();
    const field = await within(dialog).findByTestId('app-publish-middlewares');
    expect(JSON.parse((field as HTMLTextAreaElement).value)).toEqual({
      '10-buero': { ipAllowList: { sourceRange: [] } },
    });
    expect(within(dialog).queryByTestId('app-publish-custom')).toBeNull();
  });

  it('are a notice for everybody else, whatever else they may do in the organization', async () => {
    setMe(makeMe({ role: 'tenant_admin', permissions: PERMISSIONS.tenantAdmin }));
    const dialog = await openDialog();
    expect(await within(dialog).findByTestId('app-publish-custom')).toHaveTextContent('10-buero');
    expect(within(dialog).queryByTestId('app-publish-middlewares')).toBeNull();
  });
});

describe('System administration: proxy releases of an organization', () => {
  const tenant = (
    ref: { id: string; slug: string; name: string },
    overrides: Partial<Tenant> = {},
  ): Tenant => ({
    ...ref,
    active: true,
    protected: false,
    proxy_path_allowed: true,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 3,
    app_count: 1,
    created_at: '',
    ...overrides,
  });
  const rowOf = (slug: string) =>
    waitFor(() => {
      const found = document.querySelector<HTMLElement>(`tr[data-slug="${slug}"]`);
      if (!found) throw new Error('row not there yet');
      return found;
    });

  it('are opened from the row of the organization they are for', async () => {
    setMe(root);
    const { calls } = stubApi({
      'GET /api/v1/system/tenants': () => [
        tenant(ACME),
        tenant(MAIN, { proxy_path_allowed: false }),
      ],
      'GET /api/v1/system/proxy': () => ({ enabled: true }),
      [`GET /api/v1/system/tenants/${MAIN.id}/proxy-targets`]: () => [
        { id: 'r1', value: '10.20.0.0/16', note: 'Büronetz' },
      ],
    });
    render(SystemTenants);
    const button = within(await rowOf('main')).getByTestId('tenant-proxy');
    expect(button).toHaveAccessibleName('Proxy-Freigaben für Admin Cave');
    expect(within(await rowOf('acme')).getByTestId('tenant-proxy')).toHaveAccessibleName(
      'Proxy-Freigaben für Acme GmbH',
    );
    expect(screen.queryByTestId('proxy-target-value')).toBeNull();
    await fireEvent.click(button);
    expect(
      await screen.findByRole('dialog', { name: 'Proxy-Freigaben für Admin Cave' }),
    ).toBeVisible();
    expect(await screen.findByTestId('proxy-target')).toHaveAttribute('data-value', '10.20.0.0/16');
    // The switch shows what is stored for this organization.
    expect(screen.getByTestId('proxy-path-allowed')).toHaveAttribute('aria-checked', 'false');
    expect(calls.map((call) => call.url)).toContain(
      `/api/v1/system/tenants/${MAIN.id}/proxy-targets`,
    );
  });

  it('are among the actions of an organization as well, in words', async () => {
    setMe(root);
    stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME)],
      'GET /api/v1/system/proxy': () => ({ enabled: true }),
      [`GET /api/v1/system/tenants/${ACME.id}/proxy-targets`]: () => [],
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-actions'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['Umbenennen', 'Proxy-Freigaben', 'Deaktivieren', 'Löschen']);
    await fireEvent.click(within(menu).getByTestId('tenant-proxy-item'));
    expect(
      await screen.findByRole('dialog', { name: 'Proxy-Freigaben für Acme GmbH' }),
    ).toBeVisible();
  });

  it('shows the list of organizations with the new state after path addresses were changed', async () => {
    setMe(root);
    let allowed = false;
    const { calls } = stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME, { proxy_path_allowed: allowed })],
      'GET /api/v1/system/proxy': () => ({ enabled: true }),
      [`GET /api/v1/system/tenants/${ACME.id}/proxy-targets`]: () => [],
      [`PATCH /api/v1/system/tenants/${ACME.id}`]: ({ body }) => {
        allowed = (body as { proxy_path_allowed: boolean }).proxy_path_allowed;
        return tenant(ACME, { proxy_path_allowed: allowed });
      },
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-proxy'));
    await fireEvent.click(await screen.findByTestId('proxy-path-allowed'));
    const lists = () => calls.filter((call) => call.url === '/api/v1/system/tenants').length;
    await waitFor(() => expect(lists()).toBe(2));
    // Closed and opened again, the dialog starts from what is stored now.
    await fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(screen.queryByTestId('proxy-path-allowed')).toBeNull());
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-proxy'));
    expect(await screen.findByTestId('proxy-path-allowed')).toHaveAttribute('aria-checked', 'true');
  });

  it('say that publishing is not set up where the installation has no apps host', async () => {
    setMe(root);
    const { calls } = stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME)],
      'GET /api/v1/system/proxy': () => ({ enabled: false }),
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-proxy'));
    expect(await screen.findByTestId('proxy-disabled')).toHaveTextContent(
      'Veröffentlichen ist nicht eingerichtet',
    );
    expect(screen.queryByTestId('proxy-target-value')).toBeNull();
    expect(calls.some((call) => call.url.includes('proxy-targets'))).toBe(false);
  });

  it('know whether publishing is set up without an organization being entered', async () => {
    setMe(makeMe({ ...root, active_tenant: null }));
    const { calls } = stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME)],
      'GET /api/v1/system/proxy': () => ({ enabled: false }),
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-proxy'));
    expect(await screen.findByTestId('proxy-disabled')).toBeInTheDocument();
    // The question goes to the system, not to the organization of the session.
    expect(calls.map((call) => call.url)).toContain('/api/v1/system/proxy');
    expect(calls.map((call) => call.url)).not.toContain('/api/v1/admin/proxy');
  });

  it('are offered when the question could not be asked at all', async () => {
    setMe(root);
    stubApi({
      'GET /api/v1/system/tenants': () => [tenant(ACME)],
      'GET /api/v1/system/proxy': () => errorResponse(500, 'internal'),
      [`GET /api/v1/system/tenants/${ACME.id}/proxy-targets`]: () => [],
    });
    render(SystemTenants);
    await fireEvent.click(within(await rowOf('acme')).getByTestId('tenant-proxy'));
    expect(await screen.findByTestId('proxy-target-value')).toBeInTheDocument();
    expect(screen.queryByTestId('proxy-disabled')).toBeNull();
    // Nothing is said about the question that failed: the server has the last word.
    expect(get(toasts)).toEqual([]);
  });
});

describe('System administration: proxy templates', () => {
  const template = (
    id: string,
    name: string,
    options: Record<string, unknown> = {},
    description = '',
  ): ProxyTemplate => ({ id, name, description, options, builtin: id.startsWith('builtin:') });
  const BUILTIN = [
    template('builtin:standard', 'Standard (server)', {}, 'Forwards requests as they are.'),
    template('builtin:embeddable', 'Embeddable (server)', { allow_embedding: true }),
    template('builtin:self-signed', 'Self-signed (server)', { verify_upstream_tls: false }),
  ];
  const office = template(
    't-office',
    'Büro-Netz',
    {
      rate_limit: { average: 50, burst: 100 },
      custom_middlewares: { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } },
    },
    'Nur aus dem Büro erreichbar.',
  );
  const cellar = template('t-cellar', 'Keller', { strip_prefix: false });

  function page(routes: Parameters<typeof stubApi>[0] = {}) {
    setMe(root);
    navigate('/system/proxy-templates', { replace: true });
    let own = [office, cellar];
    const api = stubApi({
      'GET /api/v1/system/proxy-templates': () => [...BUILTIN, ...own],
      'GET /api/v1/system/proxy': () => ({ enabled: true, defaults: {} }),
      'DELETE /api/v1/system/proxy-templates/t-office': () => {
        own = own.filter((entry) => entry.id !== 't-office');
        return new Response(null, { status: 204 });
      },
      'POST /api/v1/system/proxy-templates': ({ body }) => {
        const created = { id: 't-new', builtin: false, ...(body as object) } as ProxyTemplate;
        own = [...own, created];
        return created;
      },
      ...routes,
    });
    render(ConfirmDialog);
    render(ProxyTemplates);
    return api;
  }
  const rows = () => screen.queryAllByTestId('proxy-template');
  const rowOf = async (id: string) => {
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    return rows().find((entry) => entry.getAttribute('data-id') === id)!;
  };

  it('has its place in the system pages, for system administrators only', () => {
    expect(SYSTEM_NAV.map((entry) => entry.path)).toEqual([
      '/system/tenants',
      '/system/users',
      '/system/proxy-templates',
      '/system/certificates',
      '/system/settings',
      '/system/audit',
    ]);
    const found = resolveRoute(routes, '/system/proxy-templates', ['system:admin']);
    expect(found).toMatchObject({ kind: 'page', route: { component: ProxyTemplates } });
    expect(resolveRoute(routes, '/system/proxy-templates', PERMISSIONS.tenantAdmin).kind).toBe(
      'forbidden',
    );
  });

  it('lists built-in templates and own ones, each with what it sets', async () => {
    page();
    expect(await screen.findByRole('heading', { level: 1, name: 'Proxy-Vorlagen' })).toBeVisible();
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(rows().map((entry) => entry.getAttribute('data-id'))).toEqual([
      'builtin:standard',
      'builtin:embeddable',
      'builtin:self-signed',
      't-office',
      't-cellar',
    ]);
    // Built-in ones are named by this interface, in the language of the page.
    const standard = await rowOf('builtin:standard');
    expect(standard).toHaveTextContent('Standard');
    expect(standard).not.toHaveTextContent('(server)');
    expect(standard).toHaveTextContent('Leitet Anfragen unverändert weiter.');
    expect(standard).toHaveTextContent('mitgeliefert');
    expect(standard).toHaveTextContent('nichts – der Standard');
    expect(await rowOf('builtin:embeddable')).toHaveTextContent('In Velydock einbettbar');
    expect(await rowOf('builtin:embeddable')).toHaveTextContent('Einbettung erlauben: an');
    expect(await rowOf('builtin:self-signed')).toHaveTextContent(
      'Zertifikat des Ziels nicht prüfen: an',
    );
    // Own ones as the system administrator wrote them.
    const own = await rowOf('t-office');
    expect(own).toHaveTextContent('Büro-Netz');
    expect(own).toHaveTextContent('Nur aus dem Büro erreichbar.');
    expect(own).toHaveTextContent('eigene');
    expect(own).toHaveTextContent('Anfragen begrenzen: 50 pro Sekunde');
    expect(own).toHaveTextContent('Eigene Traefik-Middlewares: 10-buero');
  });

  it('leaves built-in templates as they are: nothing to edit or delete there', async () => {
    page();
    const builtin = await rowOf('builtin:embeddable');
    expect(within(builtin).queryByRole('button')).toBeNull();
    const own = await rowOf('t-office');
    expect(within(own).getByTestId('proxy-template-delete')).toHaveAccessibleName(
      'Vorlage Büro-Netz löschen',
    );
    expect(within(own).getByTestId('proxy-template-edit')).toHaveAccessibleName(
      'Vorlage Büro-Netz bearbeiten',
    );
    expect(screen.getAllByTestId('proxy-template-delete')).toHaveLength(2);
    expect(screen.getByText(/Mitgelieferte Vorlagen lassen sich nicht ändern/)).toBeInTheDocument();
  });

  it('creates a template and shows it in the list', async () => {
    const { calls } = page();
    await waitFor(() => expect(rows()).toHaveLength(5));
    await fireEvent.click(screen.getByTestId('proxy-template-new'));
    const dialog = await screen.findByRole('dialog', { name: 'Vorlage anlegen' });
    await fireEvent.input(within(dialog).getByTestId('proxy-template-name'), {
      target: { value: 'Lager' },
    });
    await fireEvent.click(within(dialog).getByTestId('proxy-template-save'));
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([
      { name: 'Lager', description: '', options: {} },
    ]);
    expect(get(toasts).map((toast) => toast.message)).toEqual(['Vorlage „Lager“ angelegt.']);
    expect(screen.queryByRole('dialog', { name: 'Vorlage anlegen' })).toBeNull();
  });

  it('opens an own template for editing', async () => {
    page();
    await fireEvent.click(within(await rowOf('t-office')).getByTestId('proxy-template-edit'));
    const dialog = await screen.findByRole('dialog', { name: 'Vorlage Büro-Netz bearbeiten' });
    expect(within(dialog).getByTestId('proxy-template-name')).toHaveValue('Büro-Netz');
    expect(within(dialog).getByTestId('proxy-template-option-rate_limit')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('deletes an own template after asking, and keeps the focus in the list', async () => {
    const { calls } = page();
    const button = within(await rowOf('t-office')).getByTestId('proxy-template-delete');
    button.focus();
    await fireEvent.click(button);
    const question = await screen.findByRole('dialog', { name: 'Vorlage löschen' });
    expect(question).toHaveTextContent('Vorlage „Büro-Netz“ löschen?');
    expect(question).toHaveTextContent(
      'Das geht nur, solange keine veröffentlichte App sie verwendet.',
    );
    await fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Vorlage löschen' })).toBeNull(),
    );
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    await fireEvent.click(button);
    await fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Vorlage löschen' })).getByRole('button', {
        name: 'Vorlage löschen',
      }),
    );
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([
      '/api/v1/system/proxy-templates/t-office',
    ]);
    expect(get(toasts).map((toast) => toast.message)).toEqual(['Vorlage „Büro-Netz“ gelöscht.']);
    // The row that took its place.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rows().find((entry) => entry.getAttribute('data-id') === 't-cellar')!).getAllByRole(
          'button',
        )[0],
      ),
    );
  });

  it('says which rule applies when a template is still in use, and by which publications', async () => {
    page({
      // The names come as a list; the message is for developers and is not read.
      'DELETE /api/v1/system/proxy-templates/t-office': () =>
        jsonResponse(
          {
            error: {
              code: 'template_in_use',
              message: 'This template is still used by published apps: something, else.',
              details: { publications: ['wiki', 'nas-buero'] },
            },
          },
          409,
        ),
    });
    await fireEvent.click(within(await rowOf('t-office')).getByTestId('proxy-template-delete'));
    await fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Vorlage löschen' })).getByRole('button', {
        name: 'Vorlage löschen',
      }),
    );
    const notice = await screen.findByTestId('proxy-template-in-use');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('Vorlage „Büro-Netz“ wird noch verwendet');
    expect(notice).toHaveTextContent(
      'Eine Vorlage in Verwendung lässt sich nicht löschen: Stell die Apps erst auf eine andere um.',
    );
    expect(notice).toHaveTextContent('Verwendet von: wiki, nas-buero.');
    // It stays on the page to be read, and is no toast that goes away.
    expect(get(toasts)).toEqual([]);
    expect(rows()).toHaveLength(5);
    // The next thing done with the templates takes it away.
    await fireEvent.click(screen.getByTestId('proxy-template-new'));
    expect(screen.queryByTestId('proxy-template-in-use')).toBeNull();
  });

  it('says that five publications may stand for more, and nothing where none are listed', async () => {
    let publications: unknown = ['a1', 'a2', 'a3', 'a4', 'a5'];
    page({
      'DELETE /api/v1/system/proxy-templates/t-office': () =>
        jsonResponse(
          {
            error: { code: 'template_in_use', message: 'in use: x, y.', details: { publications } },
          },
          409,
        ),
    });
    const remove = async () => {
      await fireEvent.click(within(await rowOf('t-office')).getByTestId('proxy-template-delete'));
      await fireEvent.click(
        within(await screen.findByRole('dialog', { name: 'Vorlage löschen' })).getByRole('button', {
          name: 'Vorlage löschen',
        }),
      );
      return screen.findByTestId('proxy-template-in-use');
    };
    expect(await remove()).toHaveTextContent('Verwendet von: a1, a2, a3, a4, a5, ….');
    // An answer without the list (an older server): the rule is said all the same.
    publications = undefined;
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Vorlage löschen' })).toBeNull(),
    );
    const notice = await remove();
    await waitFor(() => expect(notice).not.toHaveTextContent('Verwendet von'));
    expect(notice).toHaveTextContent('Eine Vorlage in Verwendung lässt sich nicht löschen');
  });

  it('asks the system, not the organization of the session, what the installation offers', async () => {
    const { calls } = page();
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(calls.map((call) => call.url)).toContain('/api/v1/system/proxy');
    expect(calls.map((call) => call.url)).not.toContain('/api/v1/admin/proxy');
  });

  it('takes the defaults of the installation for what a template deviates from', async () => {
    page({
      'GET /api/v1/system/proxy': () => ({
        enabled: true,
        defaults: { pass_host_header: false, strip_prefix: true },
      }),
    });
    await waitFor(() => expect(rows()).toHaveLength(5));
    await fireEvent.click(screen.getByTestId('proxy-template-new'));
    const dialog = await screen.findByRole('dialog', { name: 'Vorlage anlegen' });
    const option = within(dialog)
      .getByTestId('proxy-template-option-pass_host_header')
      .closest('.option') as HTMLElement;
    expect(option).toHaveTextContent('Standard: aus');
    expect(within(dialog).getByTestId('proxy-template-option-pass_host_header')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('says that publishing is not set up where it is not, and still shows the templates', async () => {
    page({ 'GET /api/v1/system/proxy': () => ({ enabled: false }) });
    expect(await screen.findByTestId('proxy-disabled')).toHaveTextContent(
      'Veröffentlichen ist nicht eingerichtet',
    );
    await waitFor(() => expect(rows()).toHaveLength(5));
  });

  it('says nothing of the kind where publishing is set up or cannot be asked about', async () => {
    page();
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(screen.queryByTestId('proxy-disabled')).toBeNull();
    cleanup();
    page({ 'GET /api/v1/system/proxy': () => errorResponse(500, 'internal') });
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(screen.queryByTestId('proxy-disabled')).toBeNull();
    expect(get(toasts)).toEqual([]);
    // The page works with the defaults this version knows.
    await fireEvent.click(screen.getByTestId('proxy-template-new'));
    const dialog = await screen.findByRole('dialog', { name: 'Vorlage anlegen' });
    expect(
      within(dialog).getByTestId('proxy-template-option-strip_prefix').closest('.option'),
    ).toHaveTextContent('Standard: an');
  });
});
