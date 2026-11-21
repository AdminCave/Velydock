// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

/** What a list that scrolls without a scrollbar hides, and towards which end. */
export interface Overflow {
  /** The entries do not all fit. */
  overflowing: boolean;
  /** There is more before what is visible … */
  before: boolean;
  /** … and after it. */
  after: boolean;
}

export const NO_OVERFLOW: Overflow = { overflowing: false, before: false, after: false };

/**
 * Measure a scrolling list (dock, sub-navigation) whose markers for "more this way" stand
 * beside it, in the same parent. Whether everything fits is asked of all the room the
 * parent has, the markers' included: otherwise entries that fit exactly would stop
 * fitting the moment the markers appear.
 */
export function measureOverflow(list: HTMLElement, horizontal: boolean): Overflow {
  const at = horizontal ? list.scrollLeft : list.scrollTop;
  const visible = horizontal ? list.clientWidth : list.clientHeight;
  const content = horizontal ? list.scrollWidth : list.scrollHeight;
  const parent = list.parentElement;
  const space = Math.max(visible, (horizontal ? parent?.clientWidth : parent?.clientHeight) ?? 0);
  const overflowing = content > space + 1;
  return {
    overflowing,
    before: overflowing && at > 1,
    after: overflowing && at < content - visible - 1,
  };
}

/** Scroll most of what is visible, so the entry at the cut stays in sight. */
export function scrollByPage(list: HTMLElement, horizontal: boolean, direction: -1 | 1): void {
  const distance = direction * 0.8 * (horizontal ? list.clientWidth : list.clientHeight);
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  list.scrollBy?.({
    left: horizontal ? distance : 0,
    top: horizontal ? 0 : distance,
    behavior: calm ? 'auto' : 'smooth',
  });
}
