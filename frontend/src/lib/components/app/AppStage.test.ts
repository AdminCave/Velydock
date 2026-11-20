// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
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
