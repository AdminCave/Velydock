// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { writable } from 'svelte/store';
import { errorMessage } from '$lib/api/errors';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

const _toasts = writable<ToastMessage[]>([]);
let nextId = 1;

export const toasts = { subscribe: _toasts.subscribe };

export function showToast(message: string, kind: ToastKind = 'success', durationMs?: number): void {
  const id = nextId++;
  // Errors stay longer: they usually need to be read twice.
  const duration = durationMs ?? (kind === 'error' ? 8000 : 4000);
  _toasts.update((list) => [...list, { id, kind, message }]);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
}

/** Error toast with the translated text for the API's error code. */
export function showError(err: unknown): void {
  // A cancelled request is not an error worth reporting.
  if (err instanceof DOMException && err.name === 'AbortError') return;
  showToast(errorMessage(err), 'error');
}

export function dismissToast(id: number): void {
  _toasts.update((list) => list.filter((toast) => toast.id !== id));
}

export function clearToasts(): void {
  _toasts.set([]);
}
