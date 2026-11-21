// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { errorResponse, makeApp, stubApi } from '../../../test/fixtures';
import AppFrame, { SLOW_AFTER_MS } from './AppFrame.svelte';

const CUSTOM_ID = 'app-custom';
const LAUNCH = `POST /api/v1/workspace/apps/${CUSTOM_ID}/launch`;

const customApp = (overrides = {}) =>
  makeApp({ id: CUSTOM_ID, name: 'Sandbox', type: 'custom', url: null, ...overrides });

function frame(): HTMLIFrameElement {
  return screen.getByTestId('app-frame') as HTMLIFrameElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The frame of a custom app is the security boundary between administrator-written code
// and Velydock: no allow-same-origin, ever, and no feature policy.
describe('custom app frame', () => {
  it('renders exactly the sandbox of the security boundary', async () => {
    stubApi({ [LAUNCH]: () => ({ url: 'http://sandbox.test/c/token-1', expires_in: 300 }) });
    render(AppFrame, { app: customApp(), active: true });
    await waitFor(() => expect(frame()).toBeInTheDocument());

    expect(frame().getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox',
    );
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame().getAttribute('src')).toBe('http://sandbox.test/c/token-1');
    expect(frame().dataset.appType).toBe('custom');
    expect(frame().dataset.appId).toBe(CUSTOM_ID);
    expect(frame().title).toBe('Sandbox');
  });

  it('never contains allow-same-origin and has no allow attribute', async () => {
    stubApi({ [LAUNCH]: () => ({ url: 'http://sandbox.test/c/token-1', expires_in: 300 }) });
    // Even if the API handed out browser features for a custom app, they are not passed on.
    render(AppFrame, {
      app: customApp({ frame_permissions: ['camera', 'microphone', 'fullscreen'] }),
      active: true,
    });
    await waitFor(() => expect(frame()).toBeInTheDocument());

    const flags = (frame().getAttribute('sandbox') ?? '').split(/\s+/);
    expect(flags).not.toContain('allow-same-origin');
    expect(flags.some((flag) => flag.startsWith('allow-top-navigation'))).toBe(false);
    expect(frame().hasAttribute('allow')).toBe(false);
    expect(frame().hasAttribute('allowfullscreen')).toBe(false);
  });

  it('asks for a signed address with the current theme and language', async () => {
    const { calls } = stubApi({
      [LAUNCH]: () => ({ url: 'http://sandbox.test/c/token-1', expires_in: 300 }),
    });
    render(AppFrame, { app: customApp(), active: true });
    await waitFor(() => expect(frame()).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-Velydock-CSRF']).toBe('1');
    expect(calls[0].body).toEqual({ theme: 'dark', language: 'de' });
  });

  it('requests a fresh address whenever the frame is reloaded', async () => {
    let n = 0;
    const { calls } = stubApi({
      [LAUNCH]: () => ({ url: `http://sandbox.test/c/token-${++n}`, expires_in: 300 }),
    });
    const view = render(AppFrame, { app: customApp(), active: true, nonce: 0 });
    await waitFor(() => expect(frame().getAttribute('src')).toBe('http://sandbox.test/c/token-1'));
    await view.rerender({ nonce: 1 });
    await waitFor(() => expect(frame().getAttribute('src')).toBe('http://sandbox.test/c/token-2'));
    expect(calls).toHaveLength(2);
    // The reloaded frame carries the same restrictions.
    expect(frame().getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame().hasAttribute('allow')).toBe(false);
  });

  it('does not reload when the app list is refreshed with the same values', async () => {
    const { calls } = stubApi({
      [LAUNCH]: () => ({ url: 'http://sandbox.test/c/token-1', expires_in: 300 }),
    });
    const view = render(AppFrame, { app: customApp(), active: true });
    await waitFor(() => expect(frame()).toBeInTheDocument());
    const element = frame();
    await view.rerender({ app: customApp() }); // a new object, as after re-reading the list
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(frame()).toBe(element);
  });

  it('shows no frame but an error with a retry when the launch fails', async () => {
    let fail = true;
    stubApi({
      [LAUNCH]: () =>
        fail
          ? errorResponse(404, 'not_found')
          : { url: 'http://sandbox.test/c/ok', expires_in: 300 },
    });
    render(AppFrame, { app: customApp(), active: true });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Die App konnte nicht gestartet werden');
    expect(screen.queryByTestId('app-frame')).toBeNull();
    fail = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(frame().getAttribute('src')).toBe('http://sandbox.test/c/ok'));
  });
});

describe('embedded app frame', () => {
  it('renders the documented attributes', () => {
    stubApi({});
    render(AppFrame, {
      app: makeApp({ frame_permissions: ['camera', 'fullscreen'] }),
      active: true,
    });
    expect(frame().getAttribute('sandbox')).toBe(
      'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox ' +
        'allow-downloads allow-modals allow-top-navigation-by-user-activation',
    );
    expect(frame().getAttribute('allow')).toBe('camera; fullscreen');
    expect(frame().getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame().getAttribute('src')).toBe('https://wiki.example/');
    expect(frame().dataset.appType).toBe('embedded');
  });

  it('omits allow when no browser feature is granted', () => {
    stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    expect(frame().hasAttribute('allow')).toBe(false);
  });

  it('loads the address directly, without asking the launch endpoint', () => {
    const { calls } = stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    expect(calls).toHaveLength(0);
  });

  it('stays mounted but hidden while another app is in front', async () => {
    stubApi({});
    const view = render(AppFrame, { app: makeApp(), active: false });
    const element = frame();
    expect(element.closest('[hidden]')).not.toBeNull();
    await view.rerender({ active: true });
    expect(frame()).toBe(element);
    expect(element.closest('[hidden]')).toBeNull();
  });
});

// All a page learns about a frame of another site is its `load` event. So the frame says
// that it is loading, and after a while that nothing has arrived, without claiming to
// know why.
describe('an app that takes its time', () => {
  it('says that it is loading until the frame has loaded', async () => {
    stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    expect(screen.getByRole('status', { name: 'Lädt …' })).toBeInTheDocument();
    await fireEvent.load(frame());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says after a while that nothing has arrived, and offers the app in a tab of its own', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS - 1);
    expect(screen.queryByTestId('app-slow')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const notice = screen.getByTestId('app-slow');
    expect(notice).toHaveAttribute('role', 'status'); // a notice, not an alarm
    expect(notice).toHaveTextContent('Die App ist noch nicht fertig geladen');
    // It does not claim to know what it cannot know.
    expect(notice).toHaveTextContent('lässt sich das nicht unterscheiden');
    expect(frame()).toBeInTheDocument(); // the frame goes on loading under it
    await fireEvent.click(screen.getByRole('button', { name: 'In neuem Tab öffnen' }));
    expect(open).toHaveBeenCalledWith('https://wiki.example/', '_blank', 'noopener,noreferrer');
  });

  it('takes the notice back as soon as the app has loaded after all', async () => {
    vi.useFakeTimers();
    stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(screen.getByTestId('app-slow')).toBeInTheDocument();
    await fireEvent.load(frame());
    expect(screen.queryByTestId('app-slow')).toBeNull();
  });

  it('can be closed by somebody for whom the app works already, until the next reload', async () => {
    vi.useFakeTimers();
    stubApi({});
    const view = render(AppFrame, { app: makeApp(), active: true, nonce: 0 });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    await fireEvent.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(screen.queryByTestId('app-slow')).toBeNull();
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS * 3);
    expect(screen.queryByTestId('app-slow')).toBeNull(); // and it stays away
    await view.rerender({ nonce: 1 });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(screen.getByTestId('app-slow')).toBeInTheDocument();
  });

  it('never shows it for an app that loads in time', async () => {
    vi.useFakeTimers();
    stubApi({});
    render(AppFrame, { app: makeApp(), active: true });
    await vi.advanceTimersByTimeAsync(2000);
    await fireEvent.load(frame());
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS * 2);
    expect(screen.queryByTestId('app-slow')).toBeNull();
  });

  it('gives a reload its own time', async () => {
    vi.useFakeTimers();
    stubApi({});
    const view = render(AppFrame, { app: makeApp(), active: true, nonce: 0 });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(screen.getByTestId('app-slow')).toBeInTheDocument();
    await view.rerender({ nonce: 1 }); // "App neu laden"
    expect(screen.queryByTestId('app-slow')).toBeNull();
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(screen.getByTestId('app-slow')).toBeInTheDocument();
  });

  it('has no other tab to offer for a custom app, which has no address of its own', async () => {
    vi.useFakeTimers();
    stubApi({ [LAUNCH]: () => ({ url: 'http://sandbox.test/c/token-1', expires_in: 300 }) });
    render(AppFrame, { app: customApp(), active: true });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(screen.getByTestId('app-slow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'In neuem Tab öffnen' })).toBeNull();
  });
});
