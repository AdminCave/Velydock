// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { vi } from 'vitest';
import type { Me, WorkspaceApp } from '$lib/api/types';

// Test data in the shape the API returns it, and a fetch stand-in.

export const ACME = { id: 't-acme', slug: 'acme', name: 'Acme GmbH' };
export const MAIN = { id: 't-main', slug: 'main', name: 'Admin Cave' };

export const PERMISSIONS = {
  member: ['workspace:use'],
  userManager: ['groups:read', 'groups:write', 'users:read', 'users:write', 'workspace:use'],
  tenantAdmin: [
    'apps:manage',
    'audit:read',
    'groups:read',
    'groups:write',
    'roles:assign',
    'tenant:settings',
    'users:read',
    'users:write',
    'workspace:use',
  ],
};

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    user: {
      id: 'u-anna',
      username: 'anna',
      email: 'anna@acme.example',
      first_name: 'Anna',
      last_name: 'Admin',
      display_name: 'Anna Admin',
      is_system_admin: false,
    },
    active_tenant: ACME,
    role: 'member',
    permissions: PERMISSIONS.member,
    memberships: [{ tenant: ACME, role: 'member' }],
    settings: { theme: 'system', nav_position: 'left', language: 'de', nav_position_locked: false },
    own_settings: { theme: null, nav_position: null, language: null },
    instance_name: 'Velydock',
    account_url: 'https://idp.example/account',
    version: '0.1.0',
    ...overrides,
  };
}

export function makeApp(overrides: Partial<WorkspaceApp> = {}): WorkspaceApp {
  return {
    id: 'app-1',
    name: 'Wiki',
    description: '',
    type: 'embedded',
    url: 'https://wiki.example/',
    icon_name: 'book-open',
    icon_url: null,
    frame_permissions: [],
    embed_status: 'ok',
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(status: number, code: string, details = {}): Response {
  return jsonResponse({ error: { code, message: code, details } }, status);
}

type Handler = (request: { url: string; method: string; body: unknown }) => Response | unknown;

/**
 * Replace fetch by a table of handlers keyed "METHOD /path" (the query is ignored for the
 * lookup). A handler returns a Response, or any other value to be sent as JSON. Unknown
 * requests answer 404, so a test notices a call it did not expect.
 */
export function stubApi(routes: Record<string, Handler>) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler = routes[`${method} ${url.split('?')[0]}`];
    if (!handler) return errorResponse(404, 'not_found');
    const result = handler({ url, method, body });
    return result instanceof Response ? result : jsonResponse(result);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

/** A controllable window.matchMedia. `set(query fragment, matches)` flips a query live. */
export function stubMatchMedia(initial: Record<string, boolean> = {}) {
  const state = { ...initial };
  const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
  const matches = (query: string) =>
    Object.entries(state).some(([fragment, on]) => on && query.includes(fragment));
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return matches(query);
      },
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)?.add(fn);
      },
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.get(query)?.delete(fn);
      },
    })),
  );
  return {
    set(fragment: string, on: boolean) {
      state[fragment] = on;
      for (const [query, fns] of listeners) {
        if (query.includes(fragment)) {
          for (const fn of fns) fn({ matches: matches(query) } as MediaQueryListEvent);
        }
      }
    },
  };
}
