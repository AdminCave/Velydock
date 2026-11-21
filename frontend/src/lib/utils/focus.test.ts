// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { restoreFocus, rowIndex, rowMenuAt } from './focus';

afterEach(() => {
  document.body.innerHTML = '';
});

function table(ids: string[]): HTMLTableElement {
  document.body.innerHTML = `<main id="main" tabindex="-1"><table><tbody>${ids
    .map(
      (id) =>
        `<tr data-id="${id}"><td><button aria-haspopup="menu" data-for="${id}">…</button></td></tr>`,
    )
    .join('')}</tbody></table></main>`;
  return document.querySelector('table')!;
}
const button = (id: string) => document.querySelector<HTMLElement>(`[data-for="${id}"]`)!;

describe('restoreFocus', () => {
  it('gives the focus to the first candidate when it has fallen to the page as a whole', async () => {
    const list = table(['a', 'b', 'c']);
    const at = rowIndex(list, 'data-id', 'b');
    button('b').focus();
    list.querySelector('[data-id="b"]')!.remove(); // the row is deleted
    expect(document.activeElement).toBe(document.body);
    await restoreFocus(() => [rowMenuAt(list, at), document.getElementById('main')]);
    // The row that stands where the deleted one stood.
    expect(document.activeElement).toBe(button('c'));
  });

  it('takes the last row when the last one was deleted', async () => {
    const list = table(['a', 'b', 'c']);
    const at = rowIndex(list, 'data-id', 'c');
    list.querySelector('[data-id="c"]')!.remove();
    await restoreFocus(() => [rowMenuAt(list, at), document.getElementById('main')]);
    expect(document.activeElement).toBe(button('b'));
  });

  it('falls back to the next candidate when there is no row left', async () => {
    const list = table(['a']);
    const at = rowIndex(list, 'data-id', 'a');
    list.querySelector('[data-id="a"]')!.remove();
    await restoreFocus(() => [rowMenuAt(list, at), document.getElementById('main')]);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('skips what is gone or disabled', async () => {
    table(['a', 'b']);
    const gone = button('a');
    gone.closest('tr')!.remove();
    button('b').setAttribute('disabled', '');
    await restoreFocus(() => [gone, button('b'), null, document.getElementById('main')]);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('leaves the focus alone while it is on something that is still there', async () => {
    table(['a', 'b']);
    button('a').focus();
    await restoreFocus(() => [button('b')]);
    expect(document.activeElement).toBe(button('a'));
  });
});

describe('rows of a table', () => {
  it('are found by an attribute, and not found is -1', () => {
    const list = table(['a', 'b']);
    expect(rowIndex(list, 'data-id', 'b')).toBe(1);
    expect(rowIndex(list, 'data-id', 'x')).toBe(-1);
    expect(rowIndex(null, 'data-id', 'a')).toBe(-1);
    expect(rowMenuAt(list, -1)).toBeNull();
    expect(rowMenuAt(null, 0)).toBeNull();
  });
});
