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
import MultiPicker, { filterOptions } from './MultiPicker.svelte';
import { pageCount } from './Pagination.svelte';
import SearchField from './SearchField.svelte';
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

  it('leaves an ended session to the login page, which explains it', () => {
    render(Toast);
    showError(new ApiError(401, 'not_authenticated', 'Sign-in required.', {}));
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

  // What a browser sends for a press and release of the mouse button: mousedown where
  // the button went down, then click on the common ancestor of press and release.
  const backdrop = () => screen.getByRole('dialog').parentElement as HTMLElement;
  async function press(down: Element, clickOn: Element) {
    await fireEvent.mouseDown(down);
    await fireEvent.click(clickOn);
  }

  it('closes on a click beside the dialog', async () => {
    const onClose = vi.fn();
    render(Modal, { open: true, title: 'Dialog', onClose, children: body });
    await press(backdrop(), backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the mouse button went down inside and was released beside it', async () => {
    const onClose = vi.fn();
    render(Modal, { open: true, title: 'Dialog', onClose, children: body });
    // Selecting text in a field and overshooting: the click lands on the backdrop.
    await press(screen.getByLabelText('first'), backdrop());
    expect(onClose).not.toHaveBeenCalled();
    // A click inside is none on the backdrop either.
    await press(screen.getByLabelText('first'), screen.getByLabelText('first'));
    expect(onClose).not.toHaveBeenCalled();
    // And the earlier press does not count for a later click.
    await fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes through its own buttons only when it is not dismissible', async () => {
    const onClose = vi.fn();
    render(Modal, { open: true, title: 'Einmalig', dismissible: false, onClose, children: body });
    expect(screen.queryByRole('button', { name: 'Schließen' })).toBeNull();
    await fireEvent.keyDown(document, { key: 'Escape' });
    await press(backdrop(), backdrop());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Einmalig' })).toBeVisible();
  });

  describe('with unsaved input', () => {
    it('ignores a click beside it and keeps the focus where it is', async () => {
      const onClose = vi.fn();
      render(Modal, { open: true, title: 'Formular', dirty: true, onClose, children: body });
      await press(backdrop(), backdrop());
      expect(onClose).not.toHaveBeenCalled();
      // The press is cancelled, so the browser does not move the focus to the page behind;
      // a press inside the dialog is left to the browser.
      expect(await fireEvent.mouseDown(backdrop())).toBe(false);
      expect(await fireEvent.mouseDown(screen.getByLabelText('first'))).toBe(true);
    });

    it('asks on Escape and keeps the input unless told to discard it', async () => {
      const onClose = vi.fn();
      render(ConfirmDialog);
      render(Modal, { open: true, title: 'Formular', dirty: true, onClose, children: body });
      await fireEvent.keyDown(document, { key: 'Escape' });
      const question = await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
      expect(question).toHaveTextContent('noch nicht gespeichert');
      expect(onClose).not.toHaveBeenCalled();
      // Escape again answers the question with "no": the form stays.
      await fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Eingaben verwerfen?' })).toBeNull(),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Formular' })).toBeVisible();

      await fireEvent.keyDown(document, { key: 'Escape' });
      await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
      await fireEvent.click(screen.getByRole('button', { name: 'Weiter bearbeiten' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Eingaben verwerfen?' })).toBeNull(),
      );
      expect(onClose).not.toHaveBeenCalled();

      await fireEvent.keyDown(document, { key: 'Escape' });
      await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
      await fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('closes at once through the X', async () => {
      const onClose = vi.fn();
      render(Modal, { open: true, title: 'Formular', dirty: true, onClose, children: body });
      await fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('withdraws its question when the dialog goes away meanwhile', async () => {
      render(ConfirmDialog);
      const view = render(Modal, { open: true, title: 'Formular', dirty: true, children: body });
      await fireEvent.keyDown(document, { key: 'Escape' });
      await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
      await view.rerender({ open: false }); // e.g. saved in the meantime
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});

describe('MultiPicker', () => {
  const options = [
    { id: '1', label: 'Anna Admin', detail: 'anna', locked: true },
    { id: '2', label: 'Mia Mitglied', detail: 'mia' },
    { id: '3', label: 'Clara Chefin', detail: 'clara', locked: true },
  ];

  it('shows a locked entry as it is and does not let it be toggled', async () => {
    const onChange = vi.fn();
    render(MultiPicker, {
      options,
      selected: ['1', '2'],
      label: 'Mitglieder',
      lockedHint: 'Mehr Rechte als du',
      onChange,
    });
    const anna = screen.getByRole('checkbox', { name: /Anna Admin/ });
    const clara = screen.getByRole('checkbox', { name: /Clara Chefin/ });
    expect(anna).toBeChecked();
    expect(anna).toBeDisabled();
    expect(clara).not.toBeChecked();
    expect(clara).toBeDisabled();
    expect(anna.closest('label')).toHaveAttribute('title', 'Mehr Rechte als du');
    // The chip of a locked entry cannot be removed either; the others can.
    expect(screen.queryByRole('button', { name: 'Anna Admin entfernen' })).toBeNull();
    const mia = screen.getByRole('checkbox', { name: /Mia Mitglied/ });
    expect(mia).toBeEnabled();
    expect(mia.closest('label')).not.toHaveAttribute('title');
    await fireEvent.click(screen.getByRole('button', { name: 'Mia Mitglied entfernen' }));
    expect(onChange).toHaveBeenCalledWith(['1']);
  });

  it('lets every entry be toggled when none is locked', async () => {
    const onChange = vi.fn();
    render(MultiPicker, {
      options: options.map(({ id, label }) => ({ id, label })),
      selected: [],
      label: 'Mitglieder',
      onChange,
    });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Clara Chefin' }));
    expect(onChange).toHaveBeenCalledWith(['3']);
  });
});

describe('SearchField', () => {
  it('empties a filled field on Escape and keeps the key to itself', async () => {
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    try {
      render(SearchField, { value: 'anna', label: 'Suche' });
      const input = screen.getByRole('searchbox', { name: 'Suche' }) as HTMLInputElement;
      await fireEvent.keyDown(input, { key: 'Escape' });
      expect(input.value).toBe('');
      // A dialog listens on the document: it must not see this Escape …
      expect(outside).not.toHaveBeenCalled();
      // … but the next one, with nothing left to clear, is its own.
      await fireEvent.keyDown(input, { key: 'Escape' });
      expect(outside).toHaveBeenCalledTimes(1);
      await fireEvent.keyDown(input, { key: 'a' });
      expect(outside).toHaveBeenCalledTimes(2);
    } finally {
      document.removeEventListener('keydown', outside);
    }
  });

  it('does not close the dialog around it while it has something to clear', async () => {
    const onClose = vi.fn();
    const withSearch = createRawSnippet(() => ({
      render: () => '<div data-testid="slot"></div>',
    }));
    render(Modal, { open: true, title: 'Dialog', onClose, children: withSearch });
    render(SearchField, {
      target: screen.getByTestId('slot'),
      props: { value: 'anna', label: 'Suche' },
    });
    const input = screen.getByRole('searchbox', { name: 'Suche' }) as HTMLInputElement;
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
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
