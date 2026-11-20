// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { clearToasts, showError, showToast } from '$lib/stores/toasts';
import { ApiError } from '$lib/api/client';
import { initials } from './Avatar.svelte';
import ConfirmDialog, { cancelConfirm, confirmDialog } from './ConfirmDialog.svelte';
import { placeMenu } from './Menu.svelte';
import Modal from './Modal.svelte';
import { filterOptions } from './MultiPicker.svelte';
import { pageCount } from './Pagination.svelte';
import Segmented from './Segmented.svelte';
import Toast from './Toast.svelte';

afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
});

describe('placeMenu', () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 300 };

  it('opens to the right of a left dock, aligned to the bottom of the trigger', () => {
    const trigger = { top: 700, left: 10, width: 60, height: 60 };
    expect(placeMenu('right-end', trigger, menu, viewport)).toEqual({ top: 460, left: 78 });
  });

  it('opens to the left of a right dock', () => {
    const trigger = { top: 700, left: 930, width: 60, height: 60 };
    expect(placeMenu('left-end', trigger, menu, viewport)).toEqual({ top: 460, left: 722 });
  });

  it('opens below a top dock and above a bottom dock', () => {
    expect(
      placeMenu('bottom-end', { top: 10, left: 900, width: 40, height: 40 }, menu, viewport),
    ).toEqual({ top: 58, left: 740 });
    expect(
      placeMenu('top-end', { top: 750, left: 900, width: 40, height: 40 }, menu, viewport),
    ).toEqual({ top: 442, left: 740 });
  });

  it('flips to the other side when there is no room', () => {
    // A row menu near the bottom of the page opens upwards.
    expect(
      placeMenu('bottom-end', { top: 700, left: 900, width: 34, height: 34 }, menu, viewport).top,
    ).toBe(392);
  });

  it('always stays inside the viewport', () => {
    const small = { width: 320, height: 500 };
    for (const placement of [
      'right-end',
      'left-end',
      'bottom-end',
      'top-end',
      'bottom-start',
    ] as const) {
      const at = placeMenu(placement, { top: 440, left: 280, width: 40, height: 40 }, menu, small);
      expect(at.left, placement).toBeGreaterThanOrEqual(8);
      expect(at.left + menu.width, placement).toBeLessThanOrEqual(small.width - 8);
      expect(at.top, placement).toBeGreaterThanOrEqual(8);
      expect(at.top + menu.height, placement).toBeLessThanOrEqual(small.height - 8);
    }
  });
});

describe('small helpers', () => {
  it('pageCount', () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(36, 25)).toBe(2);
    expect(pageCount(10, 0)).toBe(10);
  });

  it('initials', () => {
    expect(initials('Anna Admin')).toBe('AA');
    expect(initials('root')).toBe('R');
    expect(initials('  Karl  Heinz   Müller ')).toBe('KM');
    expect(initials('')).toBe('?');
  });

  it('filterOptions searches label and detail, ignoring case', () => {
    const options = [
      { id: '1', label: 'Anna Admin', detail: 'anna' },
      { id: '2', label: 'Uwe Verwalter', detail: 'uwe' },
      { id: '3', label: 'Büro' },
    ];
    expect(filterOptions(options, '').map((o) => o.id)).toEqual(['1', '2', '3']);
    expect(filterOptions(options, 'ANN').map((o) => o.id)).toEqual(['1']);
    expect(filterOptions(options, 'uwe').map((o) => o.id)).toEqual(['2']);
    expect(filterOptions(options, ' büro ').map((o) => o.id)).toEqual(['3']);
    expect(filterOptions(options, 'zzz')).toEqual([]);
  });
});

describe('Toast', () => {
  it('renders each message as role="status" with the test hook', async () => {
    render(Toast);
    showToast('Gespeichert.');
    showToast('Kaputt.', 'error');
    const toasts = await screen.findAllByTestId('toast');
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toHaveAttribute('role', 'status');
    expect(toasts[0]).toHaveTextContent('Gespeichert.');
    expect(toasts[1].dataset.kind).toBe('error');
  });

  it('disappears on its own and on dismissal', async () => {
    vi.useFakeTimers();
    render(Toast);
    showToast('kurz');
    showToast('weg');
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' })[1]);
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('shows the translated text for an API error', async () => {
    render(Toast);
    showError(new ApiError(409, 'email_taken', 'This e-mail address is already in use.', {}));
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'Diese E-Mail-Adresse wird bereits verwendet.',
    );
  });

  it('stays quiet about a cancelled request', () => {
    render(Toast);
    showError(new DOMException('aborted', 'AbortError'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('Modal', () => {
  const body = createRawSnippet(() => ({
    render: () => '<div><input aria-label="first" /><button type="button">last</button></div>',
  }));

  it('is a named, modal dialog', () => {
    render(Modal, { open: true, title: 'Benutzer anlegen', children: body });
    const dialog = screen.getByRole('dialog', { name: 'Benutzer anlegen' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('moves the focus into the dialog and closes on Escape', async () => {
    const onClose = vi.fn();
    render(Modal, { open: true, title: 'Dialog', onClose, children: body });
    await waitFor(() => expect(screen.getByLabelText('first')).toHaveFocus());
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', async () => {
    render(Modal, { open: true, title: 'Dialog', children: body });
    const close = screen.getByRole('button', { name: 'Schließen' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    await fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus(); // wraps to the first control of the dialog
    await fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('shows a failure above the footer as an alert', () => {
    render(Modal, {
      open: true,
      title: 'Dialog',
      error: 'Das hat nicht geklappt.',
      children: body,
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Das hat nicht geklappt.');
  });

  it('renders nothing while closed', () => {
    render(Modal, { open: false, title: 'Dialog', children: body });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  it('resolves true on confirm and false on cancel or Escape', async () => {
    render(ConfirmDialog);
    let answer = confirmDialog('Wirklich?', { title: 'Löschen', confirmLabel: 'Ja, löschen' });
    const dialog = await screen.findByRole('dialog', { name: 'Löschen' });
    expect(dialog).toHaveTextContent('Wirklich?');
    await fireEvent.click(screen.getByRole('button', { name: 'Ja, löschen' }));
    await expect(answer).resolves.toBe(true);

    answer = confirmDialog('Noch einmal?');
    await screen.findByRole('dialog');
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await expect(answer).resolves.toBe(false);

    answer = confirmDialog('Und jetzt?');
    await screen.findByRole('dialog');
    await fireEvent.keyDown(document, { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
  });

  it('cancels an open question when asked to (the session ended)', async () => {
    render(ConfirmDialog);
    const answer = confirmDialog('Offen');
    await screen.findByRole('dialog');
    cancelConfirm();
    await expect(answer).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Segmented', () => {
  const options = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Hell' },
    { value: 'dark', label: 'Dunkel' },
  ];

  it('is a radio group that reports its value', async () => {
    const onChange = vi.fn();
    render(Segmented, {
      value: 'system',
      options,
      label: 'Design',
      testid: 'setting-theme',
      onChange,
    });
    const group = screen.getByRole('radiogroup', { name: 'Design' });
    expect(group).toBe(screen.getByTestId('setting-theme'));
    expect(group.dataset.value).toBe('system');
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await fireEvent.click(screen.getByRole('radio', { name: 'Dunkel' }));
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(group.dataset.value).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dunkel' })).toBeChecked();
  });

  it('can be disabled as a whole', () => {
    render(Segmented, { value: 'light', options, label: 'Design', disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
