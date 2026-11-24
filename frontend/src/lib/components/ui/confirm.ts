// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { get, writable } from 'svelte/store';

// The one yes/no question that can be open at a time. It lives here and not in
// ConfirmDialog.svelte so that Modal.svelte can ask one too (before discarding unsaved
// input) without the two components importing each other.

export interface ConfirmOptions {
  title?: string;
  /** Plain-language consequences, shown below the question. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `data-testid` of the confirming button, where a browser test has to find this one. */
  confirmTestid?: string;
  /** "danger" for anything that deletes or locks out; "neutral" otherwise. */
  tone?: 'danger' | 'neutral';
}

export interface ConfirmRequest extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

const _pending = writable<ConfirmRequest | null>(null);

/** The open question, for the dialog that shows it. */
export const pendingConfirm = { subscribe: _pending.subscribe };

/** Ask a yes/no question in a dialog. Resolves false when dismissed. */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  // Resolve a still-open question as cancelled before replacing it; its awaiter would
  // otherwise hang forever.
  const previous = get(_pending);
  if (previous) previous.resolve(false);
  return new Promise((resolve) => {
    _pending.set({ ...options, message, resolve });
  });
}

/** Answer the open question and close its dialog. */
export function settleConfirm(ok: boolean): void {
  const current = get(_pending);
  if (current) current.resolve(ok);
  _pending.set(null);
}

/** Cancel an open question, e.g. when the session ends. */
export function cancelConfirm(): void {
  settleConfirm(false);
}
