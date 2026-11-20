// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { formChanged } from './forms';
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
    expect(formChanged(['x', ['g2', 'g1']], ['x', ['g1', 'g2']])).toBe(true);
    expect(formChanged(['x', []], ['x', null])).toBe(true);
    expect(formChanged(['x'], [])).toBe(true);
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
