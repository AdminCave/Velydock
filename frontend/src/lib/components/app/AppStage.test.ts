// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { STEAL_LIMIT } from '$lib/frameFocus';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { frames, loadApps, resetWorkspace } from '$lib/stores/workspace';
import { makeApp, stubApi } from '../../../test/fixtures';
import AppStage from './AppStage.svelte';

const apps = [
  makeApp({ id: 'wiki', name: 'Wiki', frame_permissions: ['camera'] }),
  makeApp({
    id: 'cloud',
    name: 'Nextcloud',
    url: 'https://cloud.example/',
    embed_status: 'blocked',
  }),
  makeApp({ id: 'tickets', name: 'Tickets', type: 'external', url: 'https://tickets.example/' }),
  makeApp({ id: 'sandbox', name: 'Sandbox', type: 'custom', url: null }),
  ...['a', 'b', 'c', 'd', 'e'].map((id) =>
    makeApp({ id, name: `App ${id}`, url: `https://${id}.example/` }),
  ),
];

let open: ReturnType<typeof vi.fn>;

async function setup(appId: string | null) {
  stubApi({
    'GET /api/v1/workspace/apps': () => apps,
    'POST /api/v1/workspace/apps/sandbox/launch': () => ({
      url: 'http://sandbox.test/c/t',
      expires_in: 300,
    }),
  });
  await loadApps();
  return render(AppStage, { appId });
}

const mounted = () =>
  [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="app-frame"]')].map(
    (f) => f.dataset.appId,
  );
const visible = () =>
  [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="app-frame"]')]
    .filter((f) => f.closest('[hidden]') === null)
    .map((f) => f.dataset.appId);

beforeEach(() => {
  resetWorkspace();
  open = vi.fn();
  vi.stubGlobal('open', open);
});

afterEach(() => {
  cleanup();
  clearToasts();
  document.getElementById('elsewhere')?.remove();
  vi.unstubAllGlobals();
});

describe('AppStage', () => {
  it('shows an embedded app in a frame with reload and open-in-new-tab', async () => {
    await setup('wiki');
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    expect(screen.getByRole('heading', { level: 1, name: 'Wiki' })).toBeInTheDocument();
    expect(screen.getByTestId('app-reload')).toHaveTextContent('Neu laden');
    await fireEvent.click(screen.getByTestId('app-open-external'));
    expect(open).toHaveBeenCalledWith('https://wiki.example/', '_blank', 'noopener,noreferrer');
  });

  it('renders no frame for an app that blocks embedding, but a notice', async () => {
    await setup('cloud');
    const notice = await screen.findByTestId('app-blocked-notice');
    expect(notice).toHaveTextContent('Diese App lässt sich nicht einbetten');
    expect(mounted()).toEqual([]);
    expect(screen.queryByTestId('app-reload')).toBeNull();
    // Exactly one way to open it elsewhere.
    expect(screen.getAllByTestId('app-open-external')).toHaveLength(1);
    await fireEvent.click(screen.getByTestId('app-open-external'));
    expect(open).toHaveBeenCalledWith('https://cloud.example/', '_blank', 'noopener,noreferrer');
  });

  it('shows a short page for an external app instead of a frame', async () => {
    await setup('tickets');
    await screen.findByText('Tickets läuft in einem eigenen Tab');
    expect(mounted()).toEqual([]);
    await fireEvent.click(screen.getByTestId('app-open-external'));
    expect(open).toHaveBeenCalledWith('https://tickets.example/', '_blank', 'noopener,noreferrer');
  });

  it('offers no "open in new tab" for a custom app', async () => {
    await setup('sandbox');
    await waitFor(() => expect(visible()).toEqual(['sandbox']));
    expect(screen.getByTestId('app-reload')).toBeInTheDocument();
    expect(screen.queryByTestId('app-open-external')).toBeNull();
  });

  it('keeps opened frames mounted and hidden when switching apps', async () => {
    const view = await setup('wiki');
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    const wiki = document.querySelector('iframe[data-app-id="wiki"]');

    await view.rerender({ appId: 'a' });
    await waitFor(() => expect(visible()).toEqual(['a']));
    expect(mounted()).toEqual(['wiki', 'a']);

    // Leaving the app view (dashboard, settings) hides everything but unmounts nothing.
    await view.rerender({ appId: null });
    expect(visible()).toEqual([]);
    expect(mounted()).toEqual(['wiki', 'a']);

    await view.rerender({ appId: 'wiki' });
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    // The very same element: its page was not reloaded.
    expect(document.querySelector('iframe[data-app-id="wiki"]')).toBe(wiki);
  });

  it('keeps at most five frames and drops the least recently used', async () => {
    const view = await setup('wiki');
    for (const id of ['a', 'b', 'c', 'd']) {
      await view.rerender({ appId: id });
      await waitFor(() => expect(visible()).toEqual([id]));
    }
    expect(mounted()).toEqual(['wiki', 'a', 'b', 'c', 'd']);

    await view.rerender({ appId: 'wiki' }); // use the oldest again
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    await view.rerender({ appId: 'e' }); // sixth app: "a" is now the least recently used
    await waitFor(() => expect(visible()).toEqual(['e']));
    expect(mounted()).toEqual(['wiki', 'b', 'c', 'd', 'e']);
    expect(get(frames)).toHaveLength(5);
  });

  it('reloads only the frame in front', async () => {
    const view = await setup('wiki');
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    await view.rerender({ appId: 'a' });
    await waitFor(() => expect(visible()).toEqual(['a']));
    const wiki = document.querySelector('iframe[data-app-id="wiki"]');
    const a = document.querySelector('iframe[data-app-id="a"]');
    await fireEvent.click(screen.getByTestId('app-reload'));
    await waitFor(() => expect(document.querySelector('iframe[data-app-id="a"]')).not.toBe(a));
    expect(document.querySelector('iframe[data-app-id="wiki"]')).toBe(wiki);
  });

  it('says so when the app does not exist or is not shared with the user', async () => {
    await setup('missing');
    expect(await screen.findByText('Diese App gibt es hier nicht')).toBeInTheDocument();
    expect(mounted()).toEqual([]);
  });
});

describe('an app that takes the keyboard focus although it is not its turn', () => {
  const frameOf = (appId: string) =>
    document.querySelector<HTMLIFrameElement>(
      `iframe[data-app-id="${appId}"]`,
    ) as HTMLIFrameElement;
  // What the page sees when a frame focuses itself: the element that had the focus loses
  // it, the <iframe> is document.activeElement, the window gets a `blur`. A browser lets a
  // frame do that whether it is on screen or not, which is the problem. jsdom does not: it
  // knows that an <iframe> that is not rendered cannot be focused and takes the focus away
  // again with its next rendering update. So the frame is the active element by decree
  // here, until the page focuses something else. Then a moment for the guard, which acts
  // right after the event.
  async function takesFocus(frame: HTMLIFrameElement) {
    (document.activeElement as HTMLElement | null)?.blur();
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    const release = () => active.mockRestore();
    document.addEventListener('focusin', release, { capture: true, once: true });
    window.dispatchEvent(new Event('blur'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    document.removeEventListener('focusin', release, true);
    active.mockRestore();
  }
  // Somewhere else the user is typing: a field of Velydock, or a dialog.
  function elsewhere(html: string): HTMLElement {
    document.body.insertAdjacentHTML('beforeend', `<div id="elsewhere">${html}</div>`);
    const control = document.querySelector<HTMLElement>('#elsewhere [data-here]') as HTMLElement;
    control.focus();
    return control;
  }

  it('gets the focus taken back while hidden, and is unloaded when it does not stop', async () => {
    const view = await setup('wiki');
    await view.rerender({ appId: 'a' }); // the user goes on to another app; Wiki stays alive
    await waitFor(() => expect(visible()).toEqual(['a']));
    const field = elsewhere('<input data-here />');
    const wiki = frameOf('wiki');
    for (let n = 1; n < STEAL_LIMIT; n++) {
      await takesFocus(wiki);
      expect(document.activeElement).toBe(field); // what is typed arrives where it was meant
    }
    expect(mounted()).toEqual(['wiki', 'a']);
    expect(get(toasts)).toEqual([]);
    await takesFocus(wiki);
    // No accident any more: the app is closed, and the user is told which one and why.
    await waitFor(() => expect(mounted()).toEqual(['a']));
    expect(document.activeElement).toBe(field);
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      '„Wiki“ wurde geschlossen: Die App hat die Tastatureingabe an sich gezogen, während du woanders getippt hast. Öffne sie neu, wenn du sie brauchst.',
    ]);
    // Opening it again loads it fresh.
    await view.rerender({ appId: 'wiki' });
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    expect(frameOf('wiki')).not.toBe(wiki);
  });

  it('keeps well-behaved apps alive untouched, and the app on screen its focus', async () => {
    const view = await setup('wiki');
    await view.rerender({ appId: 'a' });
    await waitFor(() => expect(visible()).toEqual(['a']));
    const [wiki, a] = [frameOf('wiki'), frameOf('a')];
    a.focus(); // the user clicks into the app on screen
    window.dispatchEvent(new Event('blur'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.activeElement).toBe(a);
    expect(mounted()).toEqual(['wiki', 'a']);
    expect(frameOf('wiki')).toBe(wiki);
    expect(get(toasts)).toEqual([]);
  });

  it('cannot pull the focus out of a dialog even as the app on screen, and says so when it was closed for it', async () => {
    await setup('wiki');
    const no = elsewhere(
      '<div role="dialog" aria-modal="true" tabindex="-1"><button data-here>Abbrechen</button></div>',
    );
    const wiki = frameOf('wiki');
    for (let n = 1; n <= STEAL_LIMIT; n++) {
      await takesFocus(wiki);
      expect(document.activeElement).toBe(no);
    }
    await waitFor(() => expect(mounted()).toEqual([]));
    // Where the app was, the page says what happened and offers it again.
    expect(screen.getByText('Diese App wurde geschlossen')).toBeVisible();
    expect(get(toasts)).toHaveLength(1);
    document.getElementById('elsewhere')?.remove();
    await fireEvent.click(screen.getByRole('button', { name: 'App neu laden' }));
    await waitFor(() => expect(visible()).toEqual(['wiki']));
    expect(screen.queryByText('Diese App wurde geschlossen')).toBeNull();
  });
});
