// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { NavPosition, Permission } from '$lib/api/types';

// What a user sees in the navigation follows from the permissions the API reports. The
// same tables guard the routes (routes.ts), so menu and router can never disagree. The
// API enforces every permission again; hiding an entry is convenience, not security.

export interface NavEntry {
  path: string;
  /** i18n key of the label */
  label: string;
  permission: Permission;
}

export const ADMIN_NAV: readonly NavEntry[] = [
  { path: '/admin/users', label: 'nav.admin.users', permission: 'users:read' },
  { path: '/admin/groups', label: 'nav.admin.groups', permission: 'groups:read' },
  { path: '/admin/apps', label: 'nav.admin.apps', permission: 'apps:manage' },
  { path: '/admin/settings', label: 'nav.admin.settings', permission: 'tenant:settings' },
  { path: '/admin/audit', label: 'nav.admin.audit', permission: 'audit:read' },
];

export const SYSTEM_NAV: readonly NavEntry[] = [
  { path: '/system/tenants', label: 'nav.system.tenants', permission: 'system:admin' },
  { path: '/system/users', label: 'nav.system.users', permission: 'system:admin' },
  {
    path: '/system/proxy-templates',
    label: 'nav.system.proxyTemplates',
    permission: 'system:admin',
  },
  { path: '/system/certificates', label: 'nav.system.certificates', permission: 'system:admin' },
  { path: '/system/settings', label: 'nav.system.settings', permission: 'system:admin' },
  { path: '/system/audit', label: 'nav.system.audit', permission: 'system:admin' },
];

export function hasPermission(
  permissions: readonly string[] | null | undefined,
  permission: Permission,
): boolean {
  return !!permissions && permissions.includes(permission);
}

export function visibleNav(
  entries: readonly NavEntry[],
  permissions: readonly string[] | null | undefined,
): NavEntry[] {
  return entries.filter((entry) => hasPermission(permissions, entry.permission));
}

/** The first administration page this user may open, or null without any admin permission. */
export function adminHome(permissions: readonly string[] | null | undefined): string | null {
  const first = [...visibleNav(ADMIN_NAV, permissions), ...visibleNav(SYSTEM_NAV, permissions)][0];
  return first ? first.path : null;
}

export function hasAdminAccess(permissions: readonly string[] | null | undefined): boolean {
  return adminHome(permissions) !== null;
}

export function isAdminArea(path: string): boolean {
  return /^\/(admin|system)(\/|$)/.test(path);
}

// ── Dock position ────────────────────────────────────────────────────

export type DockOrientation = 'vertical' | 'horizontal';
export type MenuPlacement = 'right-end' | 'left-end' | 'bottom-end' | 'top-end';

export function isNavPosition(value: unknown): value is NavPosition {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

/**
 * The edge the dock is drawn at. The configured position applies as it is, except on
 * narrow screens: a rail at the left or right would take too much of the width there, so
 * it becomes a bar at the bottom. Unknown values fall back to the left edge.
 */
export function dockEdge(position: unknown, narrow: boolean): NavPosition {
  const edge = isNavPosition(position) ? position : 'left';
  if (narrow && (edge === 'left' || edge === 'right')) return 'bottom';
  return edge;
}

export function dockOrientation(edge: NavPosition): DockOrientation {
  return edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal';
}

/** Menus of the dock open away from the edge the dock sits at. */
export function menuPlacement(edge: NavPosition): MenuPlacement {
  switch (edge) {
    case 'left':
      return 'right-end';
    case 'right':
      return 'left-end';
    case 'top':
      return 'bottom-end';
    case 'bottom':
      return 'top-end';
  }
}
