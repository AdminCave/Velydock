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
// hiding, nor a permissions policy prevents this. What works is to notice it and to take
// the focus back; a frame that does it again and again is unloaded - and one that takes it
// from another app is unloaded at once, because that cannot be noticed in time (see below).
//
// Measured with real typing in real windows: Firefox does not let a frame that is not
// rendered take the focus at all. Chromium and WebKit do. Taken from Velydock itself, the
// focus is back before a key arrives (0 keys in every run). Taken from the app on screen,
// one key reached the hidden app in 8 of 12 runs in Chromium while three takes were allowed.
//
// The rule: an app frame may hold the focus only while it is the one on screen and no
// dialog of Velydock is open over it.

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
/** A frame that takes the focus this often … */
export const STEAL_LIMIT = 3;
/** … within this time does not do it by accident. */
export const STEAL_WINDOW_MS = 60_000;

export interface FrameFocusGuardOptions {
  /**
   * A frame is to be unloaded: it took the focus STEAL_LIMIT times within STEAL_WINDOW_MS
   * from Velydock itself, or once from the app on screen.
   */
  onRepeated: (frame: HTMLIFrameElement) => void;
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

/** Whether an app frame may hold the keyboard focus right now. */
export function mayHoldFocus(frame: HTMLIFrameElement): boolean {
  // Hidden frames sit in an element with the `hidden` attribute: the slot of a frame that
  // is not the active one, or the whole stage while a page of Velydock is on screen.
  return frame.isConnected && frame.closest('[hidden]') === null && openDialog() === null;
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
    options.onRepeated(frame);
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
    // A frame that is not on screen (or lies under a dialog) has the focus. If it had it
    // from when it was on screen, the user went elsewhere without the focus following
    // (the browser's Back, say): that is nothing the frame did.
    const took = holder !== active;
    // Taken from the app on screen, where the user is typing: no event announced it, so
    // keys may already have arrived in the wrong app, and each further take would be
    // another chance. There is no second one: the frame goes at once.
    const fromAnotherApp = took && holder !== null;
    holder = null;
    if (fromAnotherApp) {
      steals.delete(active.dataset.appId ?? '');
      options.onRepeated(active);
    }
    giveBack(active);
    if (took && !fromAnotherApp) count(active);
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
