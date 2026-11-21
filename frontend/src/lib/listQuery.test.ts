// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { pageFromQuery, readListQuery, writeListQuery } from './listQuery';
import { location, navigate } from './router';

const address = () => get(location).path + get(location).search;

describe('the state of a list in the address', () => {
  beforeEach(() => {
    navigate('/admin/users', { replace: true });
  });

  it('is read when the page opens', () => {
    navigate('/admin/users?q=anna&role=member&page=3', { replace: true });
    const params = readListQuery();
    expect(params.get('q')).toBe('anna');
    expect(params.get('role')).toBe('member');
    expect(pageFromQuery(params)).toBe(3);
  });

  it('takes anything that is no page number for the first page', () => {
    for (const bad of ['', 'page=0', 'page=-2', 'page=1.5', 'page=abc', 'page=']) {
      expect(pageFromQuery(new URLSearchParams(bad)), bad).toBe(1);
    }
  });

  it('is written without leaving a trail in the history: Back leaves the list', () => {
    const before = history.length;
    writeListQuery({ q: 'a', page: null });
    writeListQuery({ q: 'an', page: null });
    writeListQuery({ q: 'anna', role: 'member', page: 2 });
    expect(address()).toBe('/admin/users?q=anna&role=member&page=2');
    expect(window.location.search).toBe('?q=anna&role=member&page=2');
    expect(history.length).toBe(before); // not one entry per letter
  });

  it('leaves out what is as the list opens, so the plain address is the plain list', () => {
    writeListQuery({ q: 'anna', role: 'member', page: 2 });
    writeListQuery({ q: null, role: null, page: null });
    expect(address()).toBe('/admin/users');
    writeListQuery({ q: '', page: 4 });
    expect(address()).toBe('/admin/users?page=4');
  });

  it('keeps what else is in the address', () => {
    navigate('/admin/users?from=mail', { replace: true });
    writeListQuery({ q: 'bob' });
    expect(address()).toBe('/admin/users?from=mail&q=bob');
  });
});
