// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import type { NavPosition } from '$lib/api/types';
import { startRouter } from '$lib/router';
import { loadApps, resetWorkspace } from '$lib/stores/workspace';
import {
  ACME,
  MAIN,
  PERMISSIONS,
  makeApp,
  makeMe,
  stubApi,
  stubMatchMedia,
} from '../../../test/fixtures';
import Dock from './Dock.svelte';
import Shell from './Shell.svelte';
import SubNav from './SubNav.svelte';

const apps = [
  makeApp({ id: 'wiki', name: 'Wiki' }),
  makeApp({ id: 'tickets', name: 'Tickets', type: 'external', url: 'https://tickets.example/' }),
];

beforeEach(() => {
  resetWorkspace();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDock(overrides: Record<string, unknown> = {}) {
  return render(Dock, {
    me: makeMe(),
    apps,
    position: 'left' as NavPosition,
    edge: 'left' as NavPosition,
    path: '/',
    activeAppId: null,
    ...overrides,
  });
}

describe('Dock', () => {
  it('exposes its position for tests and styles', () => {
    renderDock({ position: 'top', edge: 'top' });
    const dock = screen.getByTestId('dock');
    expect(dock.tagName).toBe('NAV');
    expect(dock.dataset.nav).toBe('top');
    expect(dock.dataset.edge).toBe('top');
    expect(dock.dataset.orientation).toBe('horizontal');
  });

  it.each(['left', 'right', 'top', 'bottom'] as const)('supports the %s edge', (position) => {
    renderDock({ position, edge: position });
    expect(screen.getByTestId('dock').dataset.nav).toBe(position);
  });

  it('lists the apps as links with the app name as accessible name', () => {
    renderDock();
    const entries = screen.getAllByTestId('dock-app');
    expect(entries.map((e) => e.dataset.appId)).toEqual(['wiki', 'tickets']);
    expect(screen.getByRole('link', { name: 'Wiki' })).toBe(entries[0]);
    expect(screen.getByRole('link', { name: 'Tickets' })).toBe(entries[1]);
    expect(entries[0].getAttribute('href')).toBe('/app/wiki');
  });

  it('marks the active entry with aria-current="page"', () => {
    renderDock({ path: '/app/wiki', activeAppId: 'wiki' });
    expect(screen.getByRole('link', { name: 'Wiki' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Tickets' })).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('dock-home')).not.toHaveAttribute('aria-current');
  });

  it('marks home as current on the dashboard', () => {
    renderDock({ path: '/' });
    expect(screen.getByTestId('dock-home')).toHaveAttribute('aria-current', 'page');
  });

  it('opens an external app in a new tab on click', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const stopRouter = startRouter(); // the links navigate inside the app
    renderDock();
    await fireEvent.click(screen.getByRole('link', { name: 'Tickets' }));
    expect(open).toHaveBeenCalledWith('https://tickets.example/', '_blank', 'noopener,noreferrer');
    // The link still leads to the app view, which offers to open the app again.
    expect(window.location.pathname).toBe('/app/tickets');
    await fireEvent.click(screen.getByRole('link', { name: 'Wiki' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/app/wiki');
    stopRouter();
    history.replaceState(null, '', '/');
  });

  it('hides the administration entry from members', () => {
    renderDock({ me: makeMe({ permissions: PERMISSIONS.member }) });
    expect(screen.queryByTestId('dock-admin')).toBeNull();
  });

  it('shows the administration entry with any admin permission', () => {
    renderDock({ me: makeMe({ permissions: PERMISSIONS.userManager }) });
    expect(screen.getByTestId('dock-admin')).toHaveAttribute('href', '/admin/users');
    cleanup();
    renderDock({ me: makeMe({ permissions: ['workspace:use', 'audit:read'] }) });
    expect(screen.getByTestId('dock-admin')).toHaveAttribute('href', '/admin/audit');
    cleanup();
    renderDock({ me: makeMe({ permissions: ['system:admin'], active_tenant: null }) });
    expect(screen.getByTestId('dock-admin')).toHaveAttribute('href', '/system/tenants');
  });

  it('marks the administration entry as current inside the admin area', () => {
    renderDock({ me: makeMe({ permissions: PERMISSIONS.tenantAdmin }), path: '/admin/apps' });
    expect(screen.getByTestId('dock-admin')).toHaveAttribute('aria-current', 'page');
  });

  it('offers the organization switcher only with more than one organization', () => {
    renderDock();
    expect(screen.queryByTestId('tenant-switcher')).toBeNull();
    cleanup();
    renderDock({
      me: makeMe({
        memberships: [
          { tenant: ACME, role: 'member' },
          { tenant: MAIN, role: null },
        ],
      }),
    });
    expect(screen.getByTestId('tenant-switcher')).toBeInTheDocument();
  });

  it('switches the organization from the menu', async () => {
    const other = makeMe({ active_tenant: MAIN, role: 'tenant_admin' });
    const { calls } = stubApi({ 'POST /api/v1/me/active-tenant': () => other });
    renderDock({
      me: makeMe({
        memberships: [
          { tenant: ACME, role: 'member' },
          { tenant: MAIN, role: 'tenant_admin' },
        ],
      }),
    });
    await fireEvent.click(screen.getByTestId('tenant-switcher'));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Acme GmbH Mitglied',
      'Admin Cave Administration',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    await fireEvent.click(items[1]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', body: { tenant_id: MAIN.id } });
  });

  it('has a user menu with profile, settings and sign-out', async () => {
    renderDock();
    const trigger = screen.getByTestId('user-menu');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Profil' })).toHaveAttribute(
      'href',
      '/profile',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Einstellungen' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Abmelden' })).toBeInTheDocument();
    await fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('closes an open menu when the window loses the focus, as on a click into an app frame', async () => {
    renderDock();
    const trigger = screen.getByTestId('user-menu');
    await fireEvent.click(trigger);
    await screen.findByRole('menu');
    // A click inside an <iframe> never reaches this document; the blur of the window does.
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the full instance name available when the dock has to shorten it', () => {
    const name = 'Stadtwerke Musterstadt Arbeitsplatz';
    renderDock({ me: makeMe({ instance_name: name }), position: 'top', edge: 'top' });
    expect(screen.getByText(name)).toHaveAttribute('title', name);
  });
});

describe('SubNav', () => {
  const labels = () => screen.getAllByRole('link').map((a) => a.textContent?.trim());

  it('shows a user manager only users and groups', () => {
    render(SubNav, {
      path: '/admin/users',
      permissions: PERMISSIONS.userManager,
      tenantName: 'Acme GmbH',
    });
    expect(labels()).toEqual(['Benutzer', 'Gruppen']);
    expect(screen.getByRole('link', { name: 'Benutzer' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Gruppen' })).not.toHaveAttribute('aria-current');
  });

  it('shows a tenant administrator all tenant pages and no system pages', () => {
    render(SubNav, {
      path: '/admin/apps',
      permissions: PERMISSIONS.tenantAdmin,
      tenantName: 'Acme GmbH',
    });
    expect(labels()).toEqual(['Benutzer', 'Gruppen', 'Apps', 'Einstellungen', 'Protokoll']);
  });

  it('adds the system pages for a system administrator', () => {
    render(SubNav, {
      path: '/system/tenants',
      permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
      tenantName: 'Acme GmbH',
    });
    expect(labels()).toEqual([
      'Benutzer',
      'Gruppen',
      'Apps',
      'Einstellungen',
      'Protokoll',
      'Organisationen',
      'Alle Benutzer',
      'Systemeinstellungen',
      'Systemprotokoll',
    ]);
    expect(screen.getByRole('link', { name: 'Organisationen' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers no tenant pages without an active organization', () => {
    render(SubNav, { path: '/system/tenants', permissions: ['system:admin'], tenantName: null });
    expect(labels()).toEqual([
      'Organisationen',
      'Alle Benutzer',
      'Systemeinstellungen',
      'Systemprotokoll',
    ]);
  });
});

describe('Shell', () => {
  const children = createRawSnippet(() => ({ render: () => '<p>page content</p>' }));

  async function renderShell(position: NavPosition, narrow: boolean) {
    const media = stubMatchMedia({ 'max-width': narrow });
    stubApi({ 'GET /api/v1/workspace/apps': () => apps });
    await loadApps();
    const view = render(Shell, {
      me: makeMe({ settings: { ...makeMe().settings, nav_position: position } }),
      path: '/',
      activeAppId: null,
      children,
    });
    return { view, media };
  }

  it.each(['left', 'right', 'top', 'bottom'] as const)(
    'puts the dock at the %s edge on wide screens',
    async (position) => {
      await renderShell(position, false);
      const dock = screen.getByTestId('dock');
      expect(dock.dataset.nav).toBe(position);
      expect(dock.dataset.edge).toBe(position);
      expect(dock.closest('.shell')).toHaveAttribute('data-edge', position);
    },
  );

  it('turns a side dock into a bottom bar on narrow screens, keeping the setting', async () => {
    await renderShell('left', true);
    const dock = screen.getByTestId('dock');
    expect(dock.dataset.nav).toBe('left');
    expect(dock.dataset.edge).toBe('bottom');
    expect(dock.dataset.orientation).toBe('horizontal');
  });

  it('follows the viewport and the setting without a reload', async () => {
    const { view, media } = await renderShell('right', false);
    const dock = screen.getByTestId('dock');
    expect(dock.dataset.edge).toBe('right');
    media.set('max-width', true);
    await waitFor(() => expect(dock.dataset.edge).toBe('bottom'));
    media.set('max-width', false);
    await waitFor(() => expect(dock.dataset.edge).toBe('right'));
    await view.rerender({
      me: makeMe({ settings: { ...makeMe().settings, nav_position: 'top' } }),
    });
    await waitFor(() => expect(screen.getByTestId('dock').dataset.nav).toBe('top'));
    expect(screen.getByTestId('dock').dataset.edge).toBe('top');
  });

  it('renders the page next to the dock and the dock entries of the loaded apps', async () => {
    await renderShell('left', false);
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.getAllByTestId('dock-app')).toHaveLength(2);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('shows the app view instead of the page on an app route', async () => {
    const { view } = await renderShell('left', false);
    await view.rerender({ path: '/app/wiki', activeAppId: 'wiki' });
    await waitFor(() => expect(screen.getByTestId('app-frame')).toBeInTheDocument());
    expect(screen.queryByText('page content')).toBeNull();
    expect(screen.getByRole('link', { name: 'Wiki' })).toHaveAttribute('aria-current', 'page');
  });
});
