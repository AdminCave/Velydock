// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Component } from 'svelte';
import { ADMIN_NAV, SYSTEM_NAV, adminHome, visibleNav } from '$lib/nav';
import type { RouteDef } from '$lib/routing';
import Dashboard from './pages/Dashboard.svelte';
import Login from './pages/Login.svelte';
import Profile from './pages/Profile.svelte';
import Settings from './pages/Settings.svelte';
import AdminApps from './pages/admin/Apps.svelte';
import AdminAudit from './pages/admin/Audit.svelte';
import AdminGroups from './pages/admin/Groups.svelte';
import AdminSettings from './pages/admin/TenantSettings.svelte';
import AdminUsers from './pages/admin/Users.svelte';
import SystemAudit from './pages/system/Audit.svelte';
import SystemSettings from './pages/system/Settings.svelte';
import SystemTenants from './pages/system/Tenants.svelte';
import SystemUsers from './pages/system/Users.svelte';

export type PageComponent = Component<Record<string, never>>;

export const routes: RouteDef<PageComponent>[] = [
  { pattern: '/login', kind: 'public', component: Login, title: 'title.login' },
  { pattern: '/', kind: 'page', component: Dashboard, title: 'title.dashboard' },
  { pattern: '/app/:id', kind: 'app' },
  { pattern: '/profile', kind: 'page', component: Profile, title: 'title.profile' },
  { pattern: '/settings', kind: 'page', component: Settings, title: 'title.settings' },

  // Tenant administration: each page needs its own permission (see ADMIN_NAV) and
  // belongs to the active organization (tenantScoped).
  { pattern: '/admin', kind: 'redirect', redirect: adminHome },
  {
    pattern: '/admin/users',
    kind: 'page',
    component: AdminUsers,
    permission: 'users:read',
    tenantScoped: true,
    title: 'nav.admin.users',
  },
  {
    pattern: '/admin/groups',
    kind: 'page',
    component: AdminGroups,
    permission: 'groups:read',
    tenantScoped: true,
    title: 'nav.admin.groups',
  },
  {
    pattern: '/admin/apps',
    kind: 'page',
    component: AdminApps,
    permission: 'apps:manage',
    tenantScoped: true,
    title: 'nav.admin.apps',
  },
  {
    pattern: '/admin/settings',
    kind: 'page',
    component: AdminSettings,
    permission: 'tenant:settings',
    tenantScoped: true,
    title: 'nav.admin.settings',
  },
  {
    pattern: '/admin/audit',
    kind: 'page',
    component: AdminAudit,
    permission: 'audit:read',
    tenantScoped: true,
    title: 'nav.admin.audit',
  },

  // System administration: system administrators only.
  {
    pattern: '/system',
    kind: 'redirect',
    redirect: (permissions) => visibleNav(SYSTEM_NAV, permissions)[0]?.path ?? null,
  },
  {
    pattern: '/system/tenants',
    kind: 'page',
    component: SystemTenants,
    permission: 'system:admin',
    title: 'nav.system.tenants',
  },
  {
    pattern: '/system/users',
    kind: 'page',
    component: SystemUsers,
    permission: 'system:admin',
    title: 'nav.system.users',
  },
  {
    pattern: '/system/settings',
    kind: 'page',
    component: SystemSettings,
    permission: 'system:admin',
    title: 'nav.system.settings',
  },
  {
    pattern: '/system/audit',
    kind: 'page',
    component: SystemAudit,
    permission: 'system:admin',
    title: 'nav.system.audit',
  },
];

/** Every navigation entry must have a route guarded by the same permission. */
export const NAV_ENTRIES = [...ADMIN_NAV, ...SYSTEM_NAV];
