// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { focusOnNewErrors, formChanged, refusedFields } from './forms';
import { rovingIndex } from './roving';

describe('formChanged', () => {
  it('is false while every field holds what it started with', () => {
    expect(formChanged([], [])).toBe(false);
    expect(formChanged(['anna', '', true, null], ['anna', '', true, null])).toBe(false);
    expect(formChanged(['x', ['g1', 'g2']], ['x', ['g1', 'g2']])).toBe(false);
  });

  it('notices a changed value, a changed list and a missing starting point', () => {
    expect(formChanged(['anna', ''], ['anna', 'x'])).toBe(true);
    expect(formChanged([false], [true])).toBe(true);
    expect(formChanged(['x', ['g1']], ['x', ['g1', 'g2']])).toBe(true);
    expect(formChanged(['x', ['g1', 'g3']], ['x', ['g1', 'g2']])).toBe(true);
    expect(formChanged(['x', []], ['x', null])).toBe(true);
    expect(formChanged(['x'], [])).toBe(true);
  });

  it('takes a list for a selection: the same entries in another order are no change', () => {
    // Unticking an entry and ticking it again puts it at the end of the list.
    expect(formChanged(['x', ['g2', 'g1']], ['x', ['g1', 'g2']])).toBe(false);
    expect(formChanged([['a', 'b', 'c']], [['c', 'a', 'b']])).toBe(false);
    expect(formChanged([['a', 'b']], [['a', 'b', 'c']])).toBe(true);
    expect(formChanged([['a', 'b', 'd']], [['a', 'b', 'c']])).toBe(true);
    expect(formChanged([[]], [[]])).toBe(false);
  });
});

describe('rovingIndex', () => {
  it('walks left and right through all entries and wraps around', () => {
    expect(rovingIndex('ArrowRight', 0, 5)).toBe(1);
    expect(rovingIndex('ArrowRight', 4, 5)).toBe(0);
    expect(rovingIndex('ArrowLeft', 3, 5)).toBe(2);
    expect(rovingIndex('ArrowLeft', 0, 5)).toBe(4);
  });

  it('changes the row with up and down and stops at the edges of the grid', () => {
    // 10 entries in rows of 4: [0 1 2 3] [4 5 6 7] [8 9]
    expect(rovingIndex('ArrowDown', 1, 10, 4)).toBe(5);
    expect(rovingIndex('ArrowDown', 5, 10, 4)).toBe(9);
    expect(rovingIndex('ArrowDown', 6, 10, 4)).toBe(6); // nothing below
    expect(rovingIndex('ArrowUp', 9, 10, 4)).toBe(5);
    expect(rovingIndex('ArrowUp', 2, 10, 4)).toBe(2); // nothing above
  });

  it('jumps to the first and last entry with Home and End', () => {
    expect(rovingIndex('Home', 7, 10, 4)).toBe(0);
    expect(rovingIndex('End', 2, 10, 4)).toBe(9);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageDown']) {
      expect(rovingIndex(key, 2, 10, 4), key).toBeNull();
    }
  });

  it('copes with nonsense', () => {
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull();
    expect(rovingIndex('ArrowRight', -1, 5)).toBeNull();
    expect(rovingIndex('ArrowRight', 9, 5)).toBeNull();
    expect(rovingIndex('ArrowDown', 0, 5, 0)).toBe(1);
  });
});

describe('refusedFields', () => {
  const refusal = (fields: { field: string; message: string }[]) =>
    new ApiError(422, 'validation', 'validation', { fields });

  it('gives the fields of the form the server refused the text the form has for them', () => {
    const err = refusal([
      { field: 'first_name', message: 'Value error, forbidden character' },
      { field: 'nickname', message: 'unknown here' },
    ]);
    expect(
      refusedFields(err, { first_name: () => 'Vorname: so nicht', last_name: () => 'Nachname' }),
    ).toEqual({ first_name: 'Vorname: so nicht' });
  });

  it('finds nothing in an answer about no field, or in something that is no answer at all', () => {
    expect(refusedFields(refusal([]), { first_name: () => 'x' })).toEqual({});
    expect(
      refusedFields(new ApiError(409, 'conflict', 'conflict', {}), { first_name: () => 'x' }),
    ).toEqual({});
    expect(refusedFields(new Error('offline'), { first_name: () => 'x' })).toEqual({});
  });
});

describe('focusOnNewErrors', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function form(): { first: HTMLInputElement; second: HTMLInputElement } {
    document.body.innerHTML =
      '<form id="f"><input name="a" aria-invalid="true" /><input name="b" aria-invalid="true" /></form>';
    const [first, second] = [...document.querySelectorAll('input')];
    return { first, second };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('moves to the first invalid field when a check has found something', async () => {
    const { first } = form();
    const focus = focusOnNewErrors('f');
    focus({ a: 'fehlt', b: 'fehlt' });
    await settle();
    expect(document.activeElement).toBe(first);
  });

  it('stays out of the way while messages only go away, one field after the other', async () => {
    const { first, second } = form();
    const focus = focusOnNewErrors('f');
    focus({ a: 'fehlt', b: 'fehlt' });
    await settle();
    // The user corrects the second field: its message is taken back while they type.
    second.focus();
    first.setAttribute('aria-invalid', 'true');
    second.removeAttribute('aria-invalid');
    focus({ a: 'fehlt', b: undefined });
    await settle();
    expect(document.activeElement).toBe(second); // and is not pulled to the first one
    focus({});
    await settle();
    expect(document.activeElement).toBe(second);
  });
});
