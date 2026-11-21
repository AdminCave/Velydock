// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { hasMessage } from '$lib/i18n';
import { adminHome } from '$lib/nav';
import { resolveRoute, type RouteDef } from './routing';
import { NAV_ENTRIES, routes } from '../routes';

const table: RouteDef<string>[] = [
  { pattern: '/login', kind: 'public', component: 'Login' },
  { pattern: '/', kind: 'page', component: 'Dashboard' },
  { pattern: '/app/:id', kind: 'app' },
  { pattern: '/admin', kind: 'redirect', redirect: adminHome },
  { pattern: '/admin/users', kind: 'page', component: 'Users', permission: 'users:read' },
  { pattern: '/system/tenants', kind: 'page', component: 'Tenants', permission: 'system:admin' },
];

describe('resolveRoute', () => {
  it('finds pages and passes parameters', () => {
    expect(resolveRoute(table, '/', [])).toMatchObject({
      kind: 'page',
      route: { component: 'Dashboard' },
    });
    expect(resolveRoute(table, '/app/abc', [])).toMatchObject({
      kind: 'app',
      params: { id: 'abc' },
    });
    expect(resolveRoute(table, '/login', [])).toMatchObject({ kind: 'public' });
  });

  it('answers not-found for unknown paths', () => {
    expect(resolveRoute(table, '/nope', ['system:admin'])).toEqual({ kind: 'not-found' });
    expect(resolveRoute(table, '/admin/users/extra', ['users:read'])).toEqual({
      kind: 'not-found',
    });
  });

  it('never resolves a guarded page without its permission', () => {
    expect(resolveRoute(table, '/admin/users', [])).toEqual({ kind: 'forbidden' });
    expect(resolveRoute(table, '/admin/users', ['workspace:use', 'groups:read'])).toEqual({
      kind: 'forbidden',
    });
    expect(resolveRoute(table, '/admin/users', ['users:read'])).toMatchObject({ kind: 'page' });
    expect(resolveRoute(table, '/system/tenants', ['users:read'])).toEqual({ kind: 'forbidden' });
  });

  it('redirects /admin to the first page the user may see', () => {
    expect(resolveRoute(table, '/admin', ['users:read'])).toEqual({
      kind: 'redirect',
      to: '/admin/users',
    });
    expect(resolveRoute(table, '/admin', ['system:admin'])).toEqual({
      kind: 'redirect',
      to: '/system/tenants',
    });
    expect(resolveRoute(table, '/admin', ['workspace:use'])).toEqual({ kind: 'forbidden' });
  });
});

describe('route table', () => {
  it('guards every navigation entry with the permission the menu checks', () => {
    for (const entry of NAV_ENTRIES) {
      const route = routes.find((r) => r.pattern === entry.path);
      expect(route, entry.path).toBeDefined();
      expect(route?.permission, entry.path).toBe(entry.permission);
      expect(route?.component, entry.path).toBeDefined();
    }
  });

  it('requires a permission for every /admin and /system page', () => {
    for (const route of routes) {
      if (route.kind === 'page' && /^\/(admin|system)\//.test(route.pattern)) {
        expect(route.permission, route.pattern).toBeTruthy();
      }
    }
  });

  it('marks the pages of the active organization, and only those', () => {
    // A permission inside an organization means a page of that organization. Such a page
    // starts over when the organization changes and speaks to the API through
    // tenantApi(); the lint rule for that covers src/pages/admin, hence the path check.
    for (const route of routes) {
      const ofOrganization =
        route.kind === 'page' &&
        route.permission !== undefined &&
        route.permission !== 'system:admin';
      expect(route.tenantScoped ?? false, route.pattern).toBe(ofOrganization);
      expect(route.pattern.startsWith('/admin/'), route.pattern).toBe(ofOrganization);
    }
    expect(routes.filter((r) => r.tenantScoped).map((r) => r.pattern)).toEqual([
      '/admin/users',
      '/admin/groups',
      '/admin/apps',
      '/admin/settings',
      '/admin/audit',
    ]);
  });

  it('keeps only the login page public', () => {
    expect(routes.filter((r) => r.kind === 'public').map((r) => r.pattern)).toEqual(['/login']);
  });

  it('has a translated title for every page', () => {
    for (const route of routes) {
      if (route.kind === 'page' || route.kind === 'public') {
        expect(route.title && hasMessage(route.title), route.pattern).toBe(true);
      }
    }
  });

  it('resolves the documented paths', () => {
    const all = [
      'workspace:use',
      'users:read',
      'groups:read',
      'apps:manage',
      'tenant:settings',
      'audit:read',
      'system:admin',
    ];
    for (const path of [
      '/',
      '/profile',
      '/settings',
      '/admin/users',
      '/admin/groups',
      '/admin/apps',
      '/admin/settings',
      '/admin/audit',
      '/system/tenants',
      '/system/users',
      '/system/settings',
      '/system/audit',
    ]) {
      expect(resolveRoute(routes, path, all).kind, path).toBe('page');
    }
    expect(resolveRoute(routes, '/app/1', all).kind).toBe('app');
    expect(resolveRoute(routes, '/unknown', all).kind).toBe('not-found');
  });
});
