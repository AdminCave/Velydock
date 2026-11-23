// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Keeps the keyboard focus out of app frames that must not have it.
//
// An app that was opened once stays mounted while something else is on screen (see
// frames.ts), and its code keeps running. Nothing stops that code from focusing its own
// window. The browser then sends every key to the hidden app, and the field the user
// clicked - in Velydock, or in the app that is on screen - stays empty: a hidden app can
// read a password that is typed somewhere else. Neither `inert`, nor another way of
// hiding, nor a permissions policy prevents this. What works is to notice it, to take the
// focus back - and to unload a frame that is not on screen the first time it does it.
//
// Why at once: noticing comes after the fact. Between the moment a frame takes the focus
// and the next thing this page gets to do, a key can arrive in the frame, and nothing can
// be done about that key. Each further take would be another such moment. Measured:
// Firefox does not let a frame that is not rendered take the focus at all; Chromium and
// WebKit do. While frames were only unloaded the third time, a key reached a hidden app in
// 8 of 12 runs with real typing when it took the focus from the app on screen (Chromium),
// and in one run of the browser suite on a busy machine when it took it from a page of
// Velydock (WebKit) - where earlier runs on a quiet machine had shown none.
//
// The rule: an app frame may hold the focus only while it is the one on screen and no
// dialog of Velydock is open over it. A frame that takes it while it is not on screen is
// unloaded; the app on screen that takes it out of a dialog gets it taken back, and is
// unloaded if it keeps doing so.

/** The frames this is about (AppFrame.svelte). */
export const APP_FRAME = 'iframe[data-testid="app-frame"]';
/**
 * How often the focus is looked at while the app on screen has it. The window's `blur`
 * announces a frame that takes the focus from Velydock itself. Nothing announces a frame
 * that takes it from another frame, so that is found by looking, and what is typed until
 * then arrives in the wrong frame: hence this often.
 */
export const WATCH_INTERVAL_MS = 10;
/** How often otherwise: a safety net, should the browser not announce a change. */
export const IDLE_INTERVAL_MS = 250;
/** The app on screen, taking the focus out of a dialog of Velydock this often … */
export const STEAL_LIMIT = 3;
/** … within this time, does not do it by accident. */
export const STEAL_WINDOW_MS = 60_000;

export interface FrameFocusGuardOptions {
  /**
   * A frame is to be unloaded: it took the focus while it was not on screen, or - as the
   * app on screen - STEAL_LIMIT times within STEAL_WINDOW_MS out of a dialog of Velydock.
   * The focus is back where the user was when this is called.
   */
  onUnload: (frame: HTMLIFrameElement) => void;
  /** The clock (for tests). */
  now?: () => number;
}

function isAppFrame(element: unknown): element is HTMLIFrameElement {
  return element instanceof HTMLIFrameElement && element.matches(APP_FRAME);
}

/** The dialog of Velydock that is open on top of everything, if any (Modal.svelte). */
function openDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

/**
 * Give the keyboard focus to an app frame. Always through its window, never with
 * `focus()` on the `<iframe>`: that would make the element itself the document's focused
 * element, and from then on `document.activeElement` keeps naming it even when another
 * frame has taken the focus since. The page could no longer see that happen.
 */
export function focusFrame(frame: HTMLIFrameElement): void {
  frame.contentWindow?.focus();
}

/**
 * Whether an app frame is the one on screen. The others sit in an element with the
 * `hidden` attribute: the slot of a frame that is not the active one, or the whole stage
 * while a page of Velydock is on screen.
 */
export function onScreen(frame: HTMLIFrameElement): boolean {
  return frame.isConnected && frame.closest('[hidden]') === null;
}

/** Whether an app frame may hold the keyboard focus right now. */
export function mayHoldFocus(frame: HTMLIFrameElement): boolean {
  return onScreen(frame) && openDialog() === null;
}

/**
 * Watch the focus for as long as app frames exist. Returns the stop function.
 *
 * Whenever a frame that may not hold the focus has it, the focus goes back to where the
 * user was: the element of Velydock that had it last, the dialog that is open, or the
 * app on screen. (Inside the app on screen the page cannot restore the field the user
 * was in, only the app itself: there the user clicks again.)
 *
 * The focus is never moved from inside the event that reports the change. The browser
 * is in the middle of handing the focus to the frame then: focus() would change what
 * this document calls its active element and leave the keyboard with the frame. It is
 * moved right after the event.
 *
 * And a frame is only unloaded after the focus is back. Removed while it holds the
 * focus, it takes the focus of the whole page with it: Chromium and WebKit then ignore
 * focus() for the moment, and everything the user types next is lost.
 */
export function startFrameFocusGuard(options: FrameFocusGuardOptions): () => void {
  const now = options.now ?? Date.now;
  // Where the user was last: an element of Velydock, or the app frame on screen.
  let place: HTMLElement | null =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  // The frame that holds the focus with every right at the moment.
  let holder: HTMLIFrameElement | null = null;
  const steals = new Map<string, number[]>();

  function giveBack(from: HTMLIFrameElement): void {
    const dialog = openDialog();
    const wanted = dialog
      ? [place && dialog.contains(place) ? place : null, dialog]
      : [place, document.getElementById('main')];
    for (const target of wanted) {
      if (!target || target === from || !target.isConnected) continue;
      if (isAppFrame(target)) {
        // Back to the app on screen (the field inside it only the app can restore).
        if (!mayHoldFocus(target)) continue;
        focusFrame(target);
        return;
      }
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    // Nowhere to put it: out of the frame it goes all the same.
    from.blur();
  }

  function count(frame: HTMLIFrameElement): void {
    const id = frame.dataset.appId ?? '';
    const at = now();
    const recent = (steals.get(id) ?? []).filter((earlier) => at - earlier < STEAL_WINDOW_MS);
    recent.push(at);
    if (recent.length < STEAL_LIMIT) {
      steals.set(id, recent);
      return;
    }
    steals.delete(id);
    options.onUnload(frame);
  }

  function check(): void {
    const active = document.activeElement;
    if (!isAppFrame(active)) {
      holder = null;
      return;
    }
    if (mayHoldFocus(active)) {
      holder = active;
      place = active;
      return;
    }
    // A frame that may not hold the focus has it. If it had it from when it was the app
    // on screen, the user went elsewhere without the focus following (the browser's Back,
    // say): that is nothing the frame did.
    const took = holder !== active;
    holder = null;
    // First back to where the user was: this is what ends the frame's hold on the keyboard.
    giveBack(active);
    if (!took) return;
    if (onScreen(active)) {
      // The app the user is looking at, under a dialog of Velydock. It may have a reason;
      // it goes if it does not stop.
      count(active);
    } else {
      // Not on screen: no reason, and no second chance (see the top of this file).
      steals.delete(active.dataset.appId ?? '');
      options.onUnload(active);
    }
  }

  // Looking is done from a task of its own (see above), at once after an event and
  // otherwise on a timer, which runs fast while a frame holds the focus.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function look(): void {
    clearTimeout(timer);
    if (stopped) return;
    check();
    timer = setTimeout(look, holder ? WATCH_INTERVAL_MS : IDLE_INTERVAL_MS);
  }
  function lookSoon(): void {
    clearTimeout(timer);
    timer = setTimeout(look, 0);
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && !isAppFrame(target)) {
      // The focus is in Velydock itself: this is where the user is.
      place = target;
      holder = null;
    } else {
      lookSoon();
    }
  };

  // Capturing, so that this is the first to act on a `blur`: whoever else decides
  // something from it a moment later (an open menu, whether to close) finds the focus
  // where it belongs.
  window.addEventListener('blur', lookSoon, true);
  document.addEventListener('focusin', onFocusIn, true);
  lookSoon();
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('blur', lookSoon, true);
    document.removeEventListener('focusin', onFocusIn, true);
  };
}
