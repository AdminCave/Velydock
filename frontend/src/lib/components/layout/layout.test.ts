// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import type { NavPosition } from '$lib/api/types';
import { get } from 'svelte/store';
import { location, navigate, startRouter } from '$lib/router';
import { me, revalidateSession, session, sessionExpired, setMe } from '$lib/stores/session';
import { loadApps, resetWorkspace } from '$lib/stores/workspace';
import {
  ACME,
  MAIN,
  PERMISSIONS,
  errorResponse,
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

  it('keeps the keyboard focus on the switcher while and after the organization is switched', async () => {
    const both = [
      { tenant: ACME, role: 'member' as const },
      { tenant: MAIN, role: 'tenant_admin' as const },
    ];
    let answer: (value: unknown) => void = () => {};
    const { calls } = stubApi({
      'POST /api/v1/me/active-tenant': () => new Promise((resolve) => (answer = resolve)),
    });
    renderDock({ me: makeMe({ memberships: both }) });
    const switcher = screen.getByTestId('tenant-switcher');
    switcher.focus();
    await fireEvent.click(switcher);
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Admin Cave/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    // The switch is under way. A disabled button could not hold the focus the menu gave
    // back to it: the keyboard would be on <body>.
    expect(switcher).toBeEnabled();
    expect(switcher).toHaveFocus();
    // A second choice meanwhile is ignored, not sent on top.
    await fireEvent.click(switcher);
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Admin Cave/ }));
    expect(calls).toHaveLength(1);
    answer(makeMe({ active_tenant: MAIN, memberships: both }));
    await waitFor(() => expect(get(me)?.active_tenant?.id).toBe(MAIN.id));
    expect(switcher).toHaveFocus();
  });

  it('goes to the start page of the new organization before the old page can render for it', async () => {
    const both = [
      { tenant: ACME, role: 'tenant_admin' as const },
      { tenant: MAIN, role: 'tenant_admin' as const },
    ];
    setMe(makeMe({ memberships: both }));
    navigate('/admin/users', { replace: true });
    stubApi({
      'POST /api/v1/me/active-tenant': () => makeMe({ active_tenant: MAIN, memberships: both }),
    });
    renderDock({ me: makeMe({ memberships: both }), path: '/admin/users' });
    // Pages render in a microtask after the store changed: this is the address they find.
    const found: string[] = [];
    const unsubscribe = me.subscribe((value) => {
      if (value?.active_tenant?.id === MAIN.id)
        queueMicrotask(() => found.push(get(location).path));
    });
    await fireEvent.click(screen.getByTestId('tenant-switcher'));
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Admin Cave/ }));
    await waitFor(() => expect(found).toHaveLength(1));
    unsubscribe();
    // "/admin/users" here would mean that the user list of the organization just left is
    // mounted once more, and asks the API in the name of the new one.
    expect(found).toEqual(['/']);
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
    // A click inside an <iframe> never reaches this document; the blur of the window does,
    // and the frame is the active element then.
    document.body.insertAdjacentHTML('beforeend', '<iframe id="app"></iframe>');
    const frame = document.getElementById('app') as HTMLIFrameElement;
    frame.focus();
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    frame.remove();
  });

  it('closes an open menu when the user turns to another window', async () => {
    renderDock();
    await fireEvent.click(screen.getByTestId('user-menu'));
    await screen.findByRole('menu');
    // The focus stays where it was in this document, but the document has none any more.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    hasFocus.mockRestore();
  });

  it('keeps the menu open when the focus is back in it right away', async () => {
    renderDock();
    await fireEvent.click(screen.getByTestId('user-menu'));
    const menu = await screen.findByRole('menu');
    const first = within(menu).getAllByRole('menuitem')[0];
    await waitFor(() => expect(first).toHaveFocus());
    // A hidden app took the focus; the guard (lib/frameFocus.ts) took it back at once.
    document.body.insertAdjacentHTML('beforeend', '<iframe id="app"></iframe>');
    const frame = document.getElementById('app') as HTMLIFrameElement;
    frame.focus();
    window.dispatchEvent(new Event('blur'));
    first.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('menu')).toBeVisible();
    expect(first).toHaveFocus();
    frame.remove();
  });

  it('keeps the full instance name available when the dock has to shorten it', () => {
    const name = 'Stadtwerke Musterstadt Arbeitsplatz';
    renderDock({ me: makeMe({ instance_name: name }), position: 'top', edge: 'top' });
    expect(screen.getByText(name)).toHaveAttribute('title', name);
  });
});

describe('Dock with more apps than fit', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    makeApp({ id: `app-${i}`, name: `Anwendung ${i} mit einem längeren Namen` }),
  );

  // jsdom lays nothing out: give the list the sizes and the position a real one has.
  async function scrolled(
    list: HTMLElement,
    horizontal: boolean,
    sizes: { visible: number; content: number; at: number },
  ) {
    const set = (name: string, value: number) =>
      Object.defineProperty(list, name, { configurable: true, writable: true, value });
    set(horizontal ? 'clientWidth' : 'clientHeight', sizes.visible);
    set(horizontal ? 'scrollWidth' : 'scrollHeight', sizes.content);
    set(horizontal ? 'scrollLeft' : 'scrollTop', sizes.at);
    await fireEvent.scroll(list);
  }
  const markers = () =>
    ['dock-more-before', 'dock-more-after'].filter((id) => screen.queryByTestId(id) !== null);

  it.each(['top', 'bottom', 'left', 'right'] as const)(
    'marks the end of the list that has more beyond it (dock at the %s edge)',
    async (edge) => {
      renderDock({ apps: many, position: edge, edge });
      const horizontal = edge === 'top' || edge === 'bottom';
      const list = screen.getByRole('list', { name: 'Apps' });
      await scrolled(list, horizontal, { visible: 400, content: 400, at: 0 });
      expect(markers()).toEqual([]); // everything fits: nothing to point at
      await scrolled(list, horizontal, { visible: 400, content: 1600, at: 0 });
      expect(markers()).toEqual(['dock-more-after']);
      await scrolled(list, horizontal, { visible: 400, content: 1600, at: 600 });
      expect(markers()).toEqual(['dock-more-before', 'dock-more-after']);
      await scrolled(list, horizontal, { visible: 400, content: 1600, at: 1200 });
      expect(markers()).toEqual(['dock-more-before']);
    },
  );

  it('scrolls most of what is visible on a click on a marker, in the direction of the dock', async () => {
    for (const edge of ['top', 'left'] as const) {
      const view = renderDock({ apps: many, position: edge, edge });
      const horizontal = edge === 'top';
      const list = screen.getByRole('list', { name: 'Apps' });
      const scrollBy = vi.fn();
      list.scrollBy = scrollBy;
      await scrolled(list, horizontal, { visible: 400, content: 1600, at: 600 });
      await fireEvent.click(screen.getByRole('button', { name: 'Weitere Apps zeigen' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Vorherige Apps zeigen' }));
      expect(
        scrollBy.mock.calls.map(([to]) => (horizontal ? [to.left, to.top] : [to.top, to.left])),
      ).toEqual([
        [320, 0],
        [-320, 0],
      ]);
      view.unmount();
    }
  });

  it('keeps the markers out of the Tab order: the keyboard walks the apps themselves', async () => {
    renderDock({ apps: many, position: 'top', edge: 'top' });
    const list = screen.getByRole('list', { name: 'Apps' });
    await scrolled(list, true, { visible: 400, content: 1600, at: 600 });
    for (const id of markers()) expect(screen.getByTestId(id)).toHaveAttribute('tabindex', '-1');
  });

  it('brings an app that gets the keyboard focus completely into view', async () => {
    const scrollIntoView = vi.fn();
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderDock({ apps: many, position: 'top', edge: 'top' });
      await waitFor(() => expect(screen.getAllByTestId('dock-app')).toHaveLength(30));
      scrollIntoView.mockClear();
      const entry = screen.getAllByTestId('dock-app')[17];
      await fireEvent.focusIn(entry);
      expect(scrollIntoView.mock.contexts).toEqual([entry]);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      // An entry that is wider than the list cannot be shown completely: its beginning
      // (the icon, the first words) is what the user gets to see.
      const list = screen.getByRole('list', { name: 'Apps' });
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: 180 });
      Object.defineProperty(entry, 'offsetWidth', { configurable: true, value: 220 });
      await fireEvent.focusIn(entry);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'start' });
    } finally {
      Element.prototype.scrollIntoView = before;
    }
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

  describe('with more entries than fit (tablet, phone)', () => {
    const root = {
      permissions: [...PERMISSIONS.tenantAdmin, 'system:admin'],
      tenantName: 'Acme GmbH',
    };
    const row = () => screen.getByRole('navigation').querySelector<HTMLElement>('.scroller')!;
    // jsdom lays nothing out: give the row the sizes and the position a real one has.
    async function scrolled(sizes: { visible: number; content: number; at: number }) {
      const set = (name: string, value: number) =>
        Object.defineProperty(row(), name, { configurable: true, writable: true, value });
      set('clientWidth', sizes.visible);
      set('scrollWidth', sizes.content);
      set('scrollLeft', sizes.at);
      await fireEvent.scroll(row());
    }
    const markers = () =>
      ['subnav-more-before', 'subnav-more-after'].filter((id) => screen.queryByTestId(id) !== null);
    let scrollIntoView: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView as unknown as () => void;
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    });

    it('brings the entry of the open page into view', async () => {
      render(SubNav, { ...root, path: '/system/settings' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      // Called on the entry of the page that is open, and moved no further than needed.
      const entry = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
      expect(entry).toBe(screen.getByRole('link', { name: 'Systemeinstellungen' }));
      expect(scrollIntoView.mock.calls.at(-1)).toEqual([{ block: 'nearest', inline: 'nearest' }]);
    });

    it('does so again when another page is opened', async () => {
      const view = render(SubNav, { ...root, path: '/admin/users' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      scrollIntoView.mockClear();
      await view.rerender({ path: '/system/audit' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(
        screen.getByRole('link', { name: 'Systemprotokoll' }),
      );
    });

    it('marks the end of the row that has more beyond it', async () => {
      render(SubNav, { ...root, path: '/admin/users' });
      await scrolled({ visible: 600, content: 600, at: 0 });
      expect(markers()).toEqual([]); // everything fits: nothing to point at
      await scrolled({ visible: 552, content: 1000, at: 0 });
      expect(markers()).toEqual(['subnav-more-after']);
      await scrolled({ visible: 552, content: 1000, at: 200 });
      expect(markers()).toEqual(['subnav-more-before', 'subnav-more-after']);
      await scrolled({ visible: 552, content: 1000, at: 448 });
      expect(markers()).toEqual(['subnav-more-before']);
    });

    it('scrolls on a click on a marker, and keeps the markers out of the Tab order', async () => {
      render(SubNav, { ...root, path: '/admin/users' });
      const scrollBy = vi.fn();
      row().scrollBy = scrollBy;
      await scrolled({ visible: 500, content: 1000, at: 200 });
      const after = screen.getByRole('button', { name: 'Weitere Einträge zeigen' });
      const before = screen.getByRole('button', { name: 'Vorherige Einträge zeigen' });
      expect(after).toHaveAttribute('tabindex', '-1');
      expect(before).toHaveAttribute('tabindex', '-1');
      await fireEvent.click(after);
      await fireEvent.click(before);
      expect(scrollBy.mock.calls.map(([to]) => to.left)).toEqual([400, -400]);
    });
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

  it('says so, and keeps the app, when the session has ended under an open app', async () => {
    setMe(makeMe());
    const { view } = await renderShell('left', false);
    await view.rerender({ path: '/app/wiki', activeAppId: 'wiki' });
    await waitFor(() => expect(screen.getByTestId('app-frame')).toBeInTheDocument());
    expect(screen.queryByTestId('session-ended')).toBeNull();
    // The check in the background finds the session gone.
    stubApi({ 'GET /api/v1/me': () => errorResponse(401, 'not_authenticated') });
    await revalidateSession({ force: true });
    const notice = await screen.findByTestId('session-ended');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('Deine Velydock-Sitzung ist beendet');
    expect(notice).toHaveTextContent('Sichere dort jetzt deine Arbeit');
    expect(screen.getByTestId('app-frame')).toBeInTheDocument(); // the app is still there
    // The button leads to the login page, which says that the session has expired.
    await fireEvent.click(within(notice).getByRole('button', { name: 'Neu anmelden' }));
    expect(get(session)).toEqual({ status: 'anonymous', me: null });
    expect(get(sessionExpired)).toBe(true);
  });

  it('shows the app view instead of the page on an app route', async () => {
    const { view } = await renderShell('left', false);
    await view.rerender({ path: '/app/wiki', activeAppId: 'wiki' });
    await waitFor(() => expect(screen.getByTestId('app-frame')).toBeInTheDocument());
    expect(screen.queryByText('page content')).toBeNull();
    expect(screen.getByRole('link', { name: 'Wiki' })).toHaveAttribute('aria-current', 'page');
  });
});
