// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { measureOverflow } from './overflow';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A list with the sizes a browser would report (jsdom lays nothing out). */
function list(sizes: { content: number; visible: number; parent: number; at: number }) {
  document.body.innerHTML = '<div id="parent"><div id="list"></div></div>';
  const el = document.getElementById('list')!;
  const parent = document.getElementById('parent')!;
  const define = (target: HTMLElement, name: string, value: number) =>
    Object.defineProperty(target, name, { configurable: true, get: () => value });
  define(el, 'scrollWidth', sizes.content);
  define(el, 'clientWidth', sizes.visible);
  define(el, 'scrollLeft', sizes.at);
  define(parent, 'clientWidth', sizes.parent);
  return el;
}

describe('measureOverflow', () => {
  it('finds nothing hidden when everything fits', () => {
    expect(measureOverflow(list({ content: 600, visible: 600, parent: 600, at: 0 }), true)).toEqual(
      { overflowing: false, before: false, after: false },
    );
  });

  it('says towards which end there is more', () => {
    const sizes = { content: 1000, visible: 552, parent: 600 };
    expect(measureOverflow(list({ ...sizes, at: 0 }), true)).toEqual({
      overflowing: true,
      before: false,
      after: true,
    });
    expect(measureOverflow(list({ ...sizes, at: 200 }), true)).toEqual({
      overflowing: true,
      before: true,
      after: true,
    });
    expect(measureOverflow(list({ ...sizes, at: 448 }), true)).toEqual({
      overflowing: true,
      before: true,
      after: false,
    });
  });

  it('asks whether the entries fit of all the room there is, the markers’ included', () => {
    // With the markers shown the list is 48 px narrower than its parent. Entries that fit
    // into the parent must not count as hidden, or the markers would come and go.
    expect(
      measureOverflow(list({ content: 590, visible: 552, parent: 600, at: 0 }), true).overflowing,
    ).toBe(false);
  });
});
