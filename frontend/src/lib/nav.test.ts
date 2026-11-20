// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV,
  SYSTEM_NAV,
  adminHome,
  dockEdge,
  dockOrientation,
  hasAdminAccess,
  hasPermission,
  isAdminArea,
  isNavPosition,
  menuPlacement,
  visibleNav,
} from './nav';

// The permission sets the backend hands out per role (backend/velydock/policy.py).
const MEMBER = ['workspace:use'];
const USER_MANAGER = [...MEMBER, 'users:read', 'users:write', 'groups:read', 'groups:write'];
const TENANT_ADMIN = [
  ...USER_MANAGER,
  'roles:assign',
  'apps:manage',
  'tenant:settings',
  'audit:read',
];
const SYSTEM_ADMIN = [...TENANT_ADMIN, 'system:admin'];

const paths = (permissions: string[] | null) => [
  ...visibleNav(ADMIN_NAV, permissions).map((e) => e.path),
  ...visibleNav(SYSTEM_NAV, permissions).map((e) => e.path),
];

describe('permission-based navigation', () => {
  it('shows a member no administration at all', () => {
    expect(paths(MEMBER)).toEqual([]);
    expect(hasAdminAccess(MEMBER)).toBe(false);
    expect(adminHome(MEMBER)).toBeNull();
  });

  it('shows a user manager users and groups only', () => {
    expect(paths(USER_MANAGER)).toEqual(['/admin/users', '/admin/groups']);
    expect(adminHome(USER_MANAGER)).toBe('/admin/users');
  });

  it('shows a tenant administrator all tenant pages but no system pages', () => {
    expect(paths(TENANT_ADMIN)).toEqual([
      '/admin/users',
      '/admin/groups',
      '/admin/apps',
      '/admin/settings',
      '/admin/audit',
    ]);
  });

  it('shows a system administrator everything', () => {
    expect(paths(SYSTEM_ADMIN)).toHaveLength(ADMIN_NAV.length + SYSTEM_NAV.length);
  });

  it('leads a system administrator without organization to the system pages', () => {
    expect(paths(['system:admin'])).toEqual(SYSTEM_NAV.map((e) => e.path));
    expect(adminHome(['system:admin'])).toBe('/system/tenants');
  });

  it('picks the first page that is actually allowed', () => {
    expect(adminHome(['audit:read'])).toBe('/admin/audit');
    expect(adminHome(['apps:manage', 'audit:read'])).toBe('/admin/apps');
  });

  it('treats missing permissions as none', () => {
    expect(paths(null)).toEqual([]);
    expect(hasPermission(undefined, 'users:read')).toBe(false);
    expect(hasPermission([], 'users:read')).toBe(false);
    expect(hasPermission(['users:read'], 'users:read')).toBe(true);
  });

  it('recognizes the administration area by path', () => {
    expect(isAdminArea('/admin/users')).toBe(true);
    expect(isAdminArea('/system')).toBe(true);
    expect(isAdminArea('/administrator')).toBe(false);
    expect(isAdminArea('/app/admin')).toBe(false);
    expect(isAdminArea('/')).toBe(false);
  });
});

describe('dock position', () => {
  it('draws the dock at the configured edge on wide screens', () => {
    for (const position of ['left', 'right', 'top', 'bottom'] as const) {
      expect(dockEdge(position, false)).toBe(position);
    }
  });

  it('turns a rail at the side into a bottom bar on narrow screens', () => {
    expect(dockEdge('left', true)).toBe('bottom');
    expect(dockEdge('right', true)).toBe('bottom');
    expect(dockEdge('top', true)).toBe('top');
    expect(dockEdge('bottom', true)).toBe('bottom');
  });

  it('falls back to the left edge for unknown values', () => {
    expect(dockEdge('diagonal', false)).toBe('left');
    expect(dockEdge(undefined, false)).toBe('left');
    expect(dockEdge(null, true)).toBe('bottom');
  });

  it('knows which positions are valid', () => {
    expect(isNavPosition('top')).toBe(true);
    expect(isNavPosition('default')).toBe(false);
    expect(isNavPosition(null)).toBe(false);
  });

  it('derives orientation and menu direction from the edge', () => {
    expect(dockOrientation('left')).toBe('vertical');
    expect(dockOrientation('right')).toBe('vertical');
    expect(dockOrientation('top')).toBe('horizontal');
    expect(dockOrientation('bottom')).toBe('horizontal');
    // Menus open away from the edge the dock sits at.
    expect(menuPlacement('left')).toBe('right-end');
    expect(menuPlacement('right')).toBe('left-end');
    expect(menuPlacement('top')).toBe('bottom-end');
    expect(menuPlacement('bottom')).toBe('top-end');
  });
});
