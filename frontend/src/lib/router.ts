// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { writable } from 'svelte/store';

// History API router. The server answers every non-API path with index.html, so paths are
// real URLs: /admin/users, /app/<id>. Plain same-origin <a href> elements are intercepted,
// which keeps links real links (middle click, copy address, keyboard).

export interface RouteLocation {
  path: string;
  search: string;
}

export type RouteParams = Record<string, string>;

/** "/admin/users/" and "/admin/users" are the same page; the root stays "/". */
export function normalizePath(path: string): string {
  const clean = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/**
 * Match a path against a pattern with `:name` segments. Returns the decoded parameters,
 * or null when the path does not match. A segment that cannot be decoded matches nothing.
 */
export function matchPath(pattern: string, path: string): RouteParams | null {
  const want = normalizePath(pattern).split('/');
  const have = normalizePath(path).split('/');
  if (want.length !== have.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i];
    if (segment.startsWith(':')) {
      if (have[i] === '') return null;
      try {
        params[segment.slice(1)] = decodeURIComponent(have[i]);
      } catch {
        return null;
      }
    } else if (segment !== have[i]) {
      return null;
    }
  }
  return params;
}

function read(): RouteLocation {
  if (typeof window === 'undefined') return { path: '/', search: '' };
  return { path: normalizePath(window.location.pathname), search: window.location.search };
}

const _location = writable<RouteLocation>(read());

export const location = { subscribe: _location.subscribe };

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  const target = normalizePath(url.pathname) + url.search;
  const current = window.location.pathname + window.location.search;
  if (options.replace) {
    history.replaceState(null, '', target);
  } else if (target !== current) {
    history.pushState(null, '', target);
  }
  _location.set(read());
}

/**
 * Whether a click on a link is a navigation inside the app. Everything else is left to
 * the browser: modified clicks, other targets, downloads, other origins, and /api/ paths
 * (sign-in is a full page navigation to the backend).
 */
export function isInternalLinkClick(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download') || anchor.getAttribute('rel')?.includes('external')) {
    return false;
  }
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  return true;
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a');
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (!isInternalLinkClick(event, anchor)) return;
  event.preventDefault();
  const url = new URL(anchor.href, window.location.href);
  navigate(url.pathname + url.search);
}

function onPopState(): void {
  _location.set(read());
}

/** Start listening for link clicks and history navigation. Returns the stop function. */
export function startRouter(): () => void {
  _location.set(read());
  window.addEventListener('popstate', onPopState);
  document.addEventListener('click', onClick);
  return () => {
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick);
  };
}

/**
 * Only local paths are accepted as a destination after sign-in (no open redirect, no loop
 * back to the login page). Mirrors safe_return_path() of the backend.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20)) return '/';
  const path = value.split(/[?#]/)[0];
  if (path === '/api' || path.startsWith('/api/')) return '/';
  if (path === '/login' || path.startsWith('/login/')) return '/';
  return value.slice(0, 500);
}

/** Address of the login page that remembers where the user was. */
export function loginPath(from: RouteLocation): string {
  const back = safeReturnPath(from.path + from.search);
  return back === '/' ? '/login' : `/login?return_to=${encodeURIComponent(back)}`;
}

/** Backend address that starts the sign-in (a full page navigation, not a fetch). */
export function signInUrl(returnTo: string | null | undefined): string {
  return `/api/auth/login?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`;
}
