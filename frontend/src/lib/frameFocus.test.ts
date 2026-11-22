// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDLE_INTERVAL_MS,
  STEAL_LIMIT,
  STEAL_WINDOW_MS,
  WATCH_INTERVAL_MS,
  focusFrame,
  mayHoldFocus,
  startFrameFocusGuard,
} from './frameFocus';

// jsdom has no frames with a life of their own. What a frame does when it takes the
// keyboard focus is played here the way the Velydock document sees it in a browser: the
// <iframe> becomes document.activeElement, and (only if the focus was in the Velydock
// document before) the window gets a `blur`.

let stop: () => void = () => {};
let onRepeated: ReturnType<typeof vi.fn<(frame: HTMLIFrameElement) => void>>;
let field: HTMLInputElement;
let hidden: HTMLIFrameElement; // an app that was opened earlier, kept alive off screen
let shown: HTMLIFrameElement; // the app on screen
let toShown: ReturnType<typeof vi.fn>;

const active = () => document.activeElement;
/** A frame takes the focus from the Velydock document: the window loses it. */
function takesFromPage(frame: HTMLIFrameElement) {
  frame.focus();
  window.dispatchEvent(new Event('blur'));
}
/** A frame takes the focus from another frame: nothing tells the page. */
function takesFromFrame(frame: HTMLIFrameElement) {
  frame.focus();
}
/** The user clicks into the app on screen. */
function userClicksInto(frame: HTMLIFrameElement) {
  frame.focus();
  window.dispatchEvent(new Event('blur'));
  vi.advanceTimersByTime(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
  document.body.innerHTML = `
    <main id="main" tabindex="-1">
      <input id="field" />
      <section class="stage">
        <div class="slot" hidden>
          <iframe data-testid="app-frame" data-app-id="links" title="Linkliste"></iframe>
        </div>
        <div class="slot">
          <iframe data-testid="app-frame" data-app-id="mail" title="Webmail"></iframe>
        </div>
      </section>
    </main>`;
  field = document.getElementById('field') as HTMLInputElement;
  [hidden, shown] = [...document.querySelectorAll<HTMLIFrameElement>('iframe')];
  // Focusing a frame through its window puts the focus into it.
  toShown = vi.fn(() => shown.focus());
  Object.defineProperty(shown, 'contentWindow', { value: { focus: toShown } });
  onRepeated = vi.fn<(frame: HTMLIFrameElement) => void>();
  field.focus();
  stop = startFrameFocusGuard({ onRepeated });
  vi.advanceTimersByTime(0);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('mayHoldFocus', () => {
  it('allows the frame on screen, and no frame while a dialog is open', () => {
    expect(mayHoldFocus(shown)).toBe(true);
    expect(mayHoldFocus(hidden)).toBe(false);
    // The whole stage is hidden while a page of Velydock is on screen.
    (document.querySelector('.stage') as HTMLElement).hidden = true;
    expect(mayHoldFocus(shown)).toBe(false);
    (document.querySelector('.stage') as HTMLElement).hidden = false;
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"></div>');
    expect(mayHoldFocus(shown)).toBe(false);
  });
});

describe('the focus guard', () => {
  it('takes the focus back from a hidden frame and returns it to where the user was', () => {
    takesFromPage(hidden);
    // Not from inside the event: the browser is still handing the focus to the frame
    // then, and focus() would only change what this document calls its active element.
    expect(active()).toBe(hidden);
    vi.advanceTimersByTime(0);
    expect(active()).toBe(field);
    expect(onRepeated).not.toHaveBeenCalled();
  });

  it('returns it to the element the user moved on to', () => {
    document.getElementById('main')?.insertAdjacentHTML('afterbegin', '<button id="b">x</button>');
    const button = document.getElementById('b') as HTMLButtonElement;
    button.focus();
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    expect(active()).toBe(button);
  });

  it('puts it on the page when the element the user was on is gone', () => {
    takesFromPage(hidden);
    field.remove();
    vi.advanceTimersByTime(0);
    expect(active()).toBe(document.getElementById('main'));
  });

  it('leaves the app on screen its focus, however long the user works in it', () => {
    userClicksInto(shown);
    // Two minutes of looking every few milliseconds (more would only make the test slow).
    vi.advanceTimersByTime(2 * 60_000);
    expect(active()).toBe(shown);
    expect(toShown).not.toHaveBeenCalled();
    expect(onRepeated).not.toHaveBeenCalled();
  });

  it('finds a hidden frame that took the focus from the app on screen, which no event reports', () => {
    userClicksInto(shown);
    takesFromFrame(hidden);
    // Found by looking, and soon: what is typed until then arrives in the hidden app.
    vi.advanceTimersByTime(WATCH_INTERVAL_MS);
    expect(WATCH_INTERVAL_MS).toBeLessThanOrEqual(10);
    // Back to the app on screen, through its window (see focusFrame()).
    expect(toShown).toHaveBeenCalledTimes(1);
    expect(active()).toBe(shown);
  });

  it('has a frame unloaded the first time it takes the focus from the app on screen', () => {
    // Nothing announces this take, so a key may already have gone the wrong way (one did in
    // 8 of 12 runs with real typing while three takes were allowed). No second chance.
    userClicksInto(shown);
    takesFromFrame(hidden);
    expect(onRepeated).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WATCH_INTERVAL_MS);
    expect(onRepeated).toHaveBeenCalledTimes(1);
    expect(onRepeated).toHaveBeenCalledWith(hidden);
    expect(active()).toBe(shown);
    // The app on screen is not blamed for anything, and keeps its focus.
    vi.advanceTimersByTime(5000);
    expect(onRepeated).toHaveBeenCalledTimes(1);
  });

  it('still looks now and then while no frame holds the focus, should an event be missed', () => {
    hidden.focus(); // no blur reaches the page
    vi.advanceTimersByTime(IDLE_INTERVAL_MS);
    expect(active()).toBe(field);
  });

  it('gives the focus to a frame through its window, never to the <iframe> element', () => {
    // An <iframe> focused as an element stays document.activeElement when another frame
    // takes the focus afterwards: the page would be blind to it.
    const asElement = vi.spyOn(shown, 'focus');
    focusFrame(shown);
    expect(toShown).toHaveBeenCalledTimes(1);
    toShown.mockClear();
    asElement.mockClear();
    userClicksInto(shown);
    asElement.mockClear();
    takesFromFrame(hidden);
    vi.advanceTimersByTime(WATCH_INTERVAL_MS);
    expect(toShown).toHaveBeenCalledTimes(1);
    // toShown itself stands for the browser here and calls shown.focus() once.
    expect(asElement).toHaveBeenCalledTimes(1);
  });

  it(`has a frame unloaded that takes the focus ${STEAL_LIMIT} times within a minute`, () => {
    expect(STEAL_LIMIT).toBe(3);
    for (let n = 1; n < STEAL_LIMIT; n++) {
      takesFromPage(hidden);
      vi.advanceTimersByTime(150);
      expect(active()).toBe(field);
    }
    expect(onRepeated).not.toHaveBeenCalled();
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    expect(active()).toBe(field); // taken back this time as well
    expect(onRepeated).toHaveBeenCalledTimes(1);
    expect(onRepeated).toHaveBeenCalledWith(hidden);
    // A fresh start after that: the app may be opened again.
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    expect(onRepeated).toHaveBeenCalledTimes(1);
  });

  it('does not hold an occasional grab of the focus against a frame for ever', () => {
    expect(STEAL_WINDOW_MS).toBe(60_000);
    for (let n = 0; n < 2 * STEAL_LIMIT; n++) {
      takesFromPage(hidden);
      vi.advanceTimersByTime(STEAL_WINDOW_MS / (STEAL_LIMIT - 1) + 1000);
      expect(active()).toBe(field);
    }
    expect(onRepeated).not.toHaveBeenCalled();
  });

  it('counts each frame for itself', () => {
    const slot = shown.closest('.slot') as HTMLElement;
    slot.hidden = true; // both apps are off screen now
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    takesFromPage(shown);
    vi.advanceTimersByTime(0);
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    takesFromPage(shown);
    vi.advanceTimersByTime(0);
    expect(onRepeated).not.toHaveBeenCalled();
    takesFromPage(shown);
    vi.advanceTimersByTime(0);
    expect(onRepeated.mock.calls.map(([frame]) => frame.title)).toEqual(['Webmail']);
  });

  it('does not let the app on screen pull the focus out of a dialog', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="dialog" aria-modal="true" tabindex="-1"><button id="no">Abbrechen</button><button id="yes">Löschen</button></div>',
    );
    const no = document.getElementById('no') as HTMLButtonElement;
    no.focus();
    for (let n = 1; n <= STEAL_LIMIT; n++) {
      takesFromPage(shown);
      vi.advanceTimersByTime(0);
      // Enter must reach the button of the dialog, not the app under it.
      expect(active()).toBe(no);
    }
    expect(onRepeated).toHaveBeenCalledWith(shown);
  });

  it('returns the focus into the dialog even if the user was not on one of its controls', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="d" role="dialog" aria-modal="true" tabindex="-1"><p>Wirklich?</p></div>',
    );
    takesFromPage(hidden);
    vi.advanceTimersByTime(0);
    expect(active()).toBe(document.getElementById('d'));
  });

  it('holds nothing against a frame that had the focus when it went off screen', () => {
    userClicksInto(shown);
    // The user leaves the app without the focus following (the browser's Back).
    (document.querySelector('.stage') as HTMLElement).hidden = true;
    vi.advanceTimersByTime(WATCH_INTERVAL_MS);
    expect(active()).toBe(document.getElementById('main')); // out of the hidden app
    // That was no grab. From now on the frame is counted like any other.
    for (let n = 1; n < STEAL_LIMIT; n++) {
      takesFromPage(shown);
      vi.advanceTimersByTime(0);
    }
    expect(onRepeated).not.toHaveBeenCalled();
    takesFromPage(shown);
    vi.advanceTimersByTime(0);
    expect(onRepeated).toHaveBeenCalledTimes(1);
  });

  it('leaves other frames alone: only app frames are its business', () => {
    document.body.insertAdjacentHTML('beforeend', '<div hidden><iframe id="x"></iframe></div>');
    const other = document.getElementById('x') as HTMLIFrameElement;
    other.focus();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(IDLE_INTERVAL_MS);
    expect(active()).toBe(other);
  });

  it('stops', () => {
    stop();
    expect(vi.getTimerCount()).toBe(0);
    takesFromPage(hidden);
    vi.advanceTimersByTime(10_000);
    expect(active()).toBe(hidden);
    expect(vi.getTimerCount()).toBe(0);
  });
});
