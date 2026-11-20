// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  isInternalLinkClick,
  location,
  loginPath,
  matchPath,
  navigate,
  normalizePath,
  safeReturnPath,
  signInUrl,
  startRouter,
} from './router';

describe('normalizePath', () => {
  it('drops trailing and doubled slashes but keeps the root', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/admin/users/')).toBe('/admin/users');
    expect(normalizePath('//admin///users//')).toBe('/admin/users');
  });
});

describe('matchPath', () => {
  it('matches static paths exactly', () => {
    expect(matchPath('/admin/users', '/admin/users')).toEqual({});
    expect(matchPath('/admin/users', '/admin/users/')).toEqual({});
    expect(matchPath('/admin/users', '/admin')).toBeNull();
    expect(matchPath('/admin/users', '/admin/users/1')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/', '/x')).toBeNull();
  });

  it('extracts and decodes parameters', () => {
    expect(matchPath('/app/:id', '/app/42')).toEqual({ id: '42' });
    expect(matchPath('/app/:id', '/app/a%20b')).toEqual({ id: 'a b' });
  });

  it('does not match a missing or undecodable parameter', () => {
    expect(matchPath('/app/:id', '/app')).toBeNull();
    expect(matchPath('/app/:id', '/app/')).toBeNull();
    expect(matchPath('/app/:id', '/app/%E0%A4%A')).toBeNull();
  });

  it('is case-sensitive and does not match prefixes', () => {
    expect(matchPath('/profile', '/Profile')).toBeNull();
    expect(matchPath('/app/:id', '/apps/1')).toBeNull();
  });
});

describe('safeReturnPath', () => {
  it('accepts local paths including query strings', () => {
    expect(safeReturnPath('/admin/users?page=2')).toBe('/admin/users?page=2');
    expect(safeReturnPath('/app/123')).toBe('/app/123');
  });

  it('rejects everything that could leave the app or loop', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'admin',
      '//evil.example',
      'https://evil.example/',
      '/\\evil.example',
      '/api/auth/login',
      '/api',
      '/login',
      '/login?return_to=/x',
      '/a\nb',
    ]) {
      expect(safeReturnPath(bad)).toBe('/');
    }
  });

  it('caps the length', () => {
    expect(safeReturnPath('/' + 'a'.repeat(900))).toHaveLength(500);
  });
});

describe('loginPath and signInUrl', () => {
  it('remembers where the user was', () => {
    expect(loginPath({ path: '/admin/users', search: '?page=2' })).toBe(
      '/login?return_to=%2Fadmin%2Fusers%3Fpage%3D2',
    );
  });

  it('needs no parameter for the start page', () => {
    expect(loginPath({ path: '/', search: '' })).toBe('/login');
  });

  it('can say that a session has expired, and still remembers the page', () => {
    expect(loginPath({ path: '/', search: '' }, { expired: true })).toBe('/login?expired=1');
    expect(loginPath({ path: '/admin/users', search: '?page=2' }, { expired: true })).toBe(
      '/login?expired=1&return_to=%2Fadmin%2Fusers%3Fpage%3D2',
    );
    expect(loginPath({ path: '/app/1', search: '' }, { expired: false })).toBe(
      '/login?return_to=%2Fapp%2F1',
    );
  });

  it('builds the backend sign-in address with a safe return path', () => {
    expect(signInUrl('/app/1')).toBe('/api/auth/login?return_to=%2Fapp%2F1');
    expect(signInUrl('https://evil.example')).toBe('/api/auth/login?return_to=%2F');
    expect(signInUrl(null)).toBe('/api/auth/login?return_to=%2F');
  });
});

describe('navigation', () => {
  let stop: () => void;

  beforeEach(() => {
    history.replaceState(null, '', '/');
    stop = startRouter();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = '';
  });

  it('navigate() pushes a history entry and updates the location store', () => {
    const before = history.length;
    navigate('/admin/users?search=a');
    expect(window.location.pathname).toBe('/admin/users');
    expect(get(location)).toEqual({ path: '/admin/users', search: '?search=a' });
    expect(history.length).toBe(before + 1);
  });

  it('navigate({ replace }) does not add a history entry', () => {
    const before = history.length;
    navigate('/profile', { replace: true });
    expect(get(location).path).toBe('/profile');
    expect(history.length).toBe(before);
  });

  it('normalizes a trailing slash', () => {
    navigate('/settings/');
    expect(get(location).path).toBe('/settings');
  });

  it('follows the back button', () => {
    navigate('/profile');
    navigate('/settings');
    history.replaceState(null, '', '/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(get(location).path).toBe('/profile');
  });

  function link(attrs: Record<string, string>): HTMLAnchorElement {
    const a = document.createElement('a');
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    a.textContent = 'x';
    document.body.appendChild(a);
    return a;
  }

  function click(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(event);
    return event;
  }

  it('intercepts plain clicks on internal links', () => {
    const event = click(link({ href: '/admin/groups' }));
    expect(event.defaultPrevented).toBe(true);
    expect(get(location).path).toBe('/admin/groups');
  });

  it('leaves the browser alone for everything else', () => {
    const cases: [Record<string, string>, MouseEventInit][] = [
      [{ href: '/api/auth/login?return_to=/' }, {}],
      [{ href: 'https://example.org/' }, {}],
      [{ href: '/profile', target: '_blank' }, {}],
      [{ href: '/file.pdf', download: '' }, {}],
      [{ href: '#main' }, {}],
      [{ href: '/profile' }, { ctrlKey: true }],
      [{ href: '/profile' }, { metaKey: true }],
      [{ href: '/profile' }, { shiftKey: true }],
      [{ href: '/profile' }, { button: 1 }],
    ];
    for (const [attrs, init] of cases) {
      const a = link(attrs);
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      expect(isInternalLinkClick(event, a), JSON.stringify([attrs, init])).toBe(false);
    }
    expect(get(location).path).toBe('/');
  });
});
