// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Permission } from '$lib/api/types';
import { hasPermission } from '$lib/nav';
import { matchPath, type RouteParams } from '$lib/router';

// Route resolution without any component knowledge, so it can be tested as plain logic.
// The table itself (patterns → page components) is src/routes.ts.

export interface RouteDef<C = unknown> {
  pattern: string;
  /**
   * public:   reachable without a session (the login page)
   * page:     a page inside the shell
   * app:      the app view; rendered by the persistent AppStage, not by a page component
   * redirect: forwards to another path, depending on what the user may see
   */
  kind: 'public' | 'page' | 'app' | 'redirect';
  component?: C;
  /** Permission the user needs to open the page. */
  permission?: Permission;
  /** i18n key for the document title. */
  title?: string;
  /** Target of a redirect; null means the user may not go anywhere from here. */
  redirect?: (permissions: readonly string[]) => string | null;
}

export type Resolved<C = unknown> =
  | { kind: 'public'; route: RouteDef<C>; params: RouteParams }
  | { kind: 'page'; route: RouteDef<C>; params: RouteParams }
  | { kind: 'app'; route: RouteDef<C>; params: RouteParams }
  | { kind: 'redirect'; to: string }
  | { kind: 'forbidden' }
  | { kind: 'not-found' };

/**
 * Find the route for a path. The first matching pattern wins. A page the user lacks the
 * permission for resolves to "forbidden" and is never mounted; an unknown path resolves
 * to "not-found".
 */
export function resolveRoute<C>(
  routes: readonly RouteDef<C>[],
  path: string,
  permissions: readonly string[],
): Resolved<C> {
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (!params) continue;
    if (route.kind === 'redirect') {
      const to = route.redirect?.(permissions) ?? null;
      return to ? { kind: 'redirect', to } : { kind: 'forbidden' };
    }
    if (route.permission && !hasPermission(permissions, route.permission)) {
      return { kind: 'forbidden' };
    }
    return { kind: route.kind, route, params };
  }
  return { kind: 'not-found' };
}
